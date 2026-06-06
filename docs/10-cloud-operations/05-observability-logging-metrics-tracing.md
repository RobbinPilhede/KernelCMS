# Observability: Logging, Metrics & Tracing

KernelCMS treats observability as a first-class subsystem, not an afterthought bolted on with a logging library. The core, server, and adapters emit structured logs, RED/USE metrics, and OpenTelemetry spans through a single instrumentation layer that you configure in `kernel.config.ts`. Because every infrastructure concern is a swappable adapter — database, storage, queue, cache — each one reports its own health and latency through the same contract, so a slow `@kernel/db-postgres` query and a slow `@kernel/storage` upload land in the same trace. This document specifies what KernelCMS emits, how you wire it to a backend (OTLP collector, Prometheus, Loki, Grafana, or KernelCMS Cloud's managed stack), and how to build dashboards and alerts that catch problems before your editors notice.

## Why this matters versus Payload, Sanity, and Strapi

Payload and Strapi both lean on Pino for request logging and stop there: you get JSON lines, but no built-in metrics, no trace propagation across the ORM boundary, and no standard way to correlate a slow REST call with the query that caused it. Sanity is a hosted black box — you see their status page, not your own spans. KernelCMS ships an `observability` adapter contract so the same instrumentation works whether you self-host with Grafana or run on KernelCMS Cloud. The wedge: a single trace context flows from the TanStack Start server function, through the Local API operation core, into the Drizzle query, and out to `@kernel/storage`, with field-level access-control checks recorded as span events.

## Structured logging

All KernelCMS logs are structured JSON, never interpolated strings. The logger is exposed on every operation context as `ctx.logger` and at the top level via `@kernel/server`. It is a thin, typed wrapper over Pino with a fixed field schema so log shippers (Loki, Datadog, CloudWatch) can index without guesswork.

```ts
// kernel.config.ts
import { defineConfig } from '@kernel/core'
import { pinoLogger } from '@kernel/server/logging'

export default defineConfig({
  observability: {
    logger: pinoLogger({
      level: process.env.LOG_LEVEL ?? 'info',
      // redact secrets and PII before serialization — never log raw payloads
      redact: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.token'],
      // pretty in dev, NDJSON in prod
      transport: process.env.NODE_ENV === 'development' ? 'pretty' : 'ndjson',
    }),
  },
})
```

Every log line carries a canonical envelope so queries are uniform across services:

| Field | Type | Meaning |
| --- | --- | --- |
| `time` | ISO-8601 | Event timestamp |
| `level` | string | `trace`–`fatal` |
| `traceId` / `spanId` | hex | Correlates the line to its OpenTelemetry span |
| `requestId` | string | Per-request UUID, also returned in the `x-kernel-request-id` response header |
| `collection` / `global` | string | Content type under operation, when applicable |
| `operation` | enum | `find`, `findByID`, `create`, `update`, `delete`, `count` |
| `userId` / `role` | string | Authenticated principal (never the credential) |
| `tenantId` | string | Set on KernelCMS Cloud and multi-tenant self-host |
| `durationMs` | number | Operation latency |

Use child loggers to bind context once. Inside a hook or access function, `ctx.logger` is already bound to the request, operation, and collection:

```ts
// collections/posts.ts
import { defineCollection } from '@kernel/core'

export const Posts = defineCollection({
  slug: 'posts',
  hooks: {
    beforeChange: [
      async ({ data, ctx }) => {
        if (data.status === 'published' && !data.publishedAt) {
          ctx.logger.warn({ field: 'publishedAt' }, 'published without explicit date; defaulting to now')
          data.publishedAt = new Date()
        }
        return data
      },
    ],
  },
})
```

Two rules the core enforces. First, payload bodies are never logged at `info` — only at `trace`, and only after redaction, so a `create` on a `users` collection cannot leak a password hash into Loki. Second, errors are logged with the typed error class name and code (`ValidationError`, `AccessDeniedError`, `AdapterError`), not a stringified stack at `info` level, so alerting can route by `err.code` rather than regex-matching messages.

## Metrics: RED and USE

KernelCMS exposes two metric families. **RED** (Rate, Errors, Duration) describes the request surface — REST, GraphQL, and RPC. **USE** (Utilization, Saturation, Errors) describes the resources behind it — database pool, cache, queue, storage. The split maps cleanly onto the adapter architecture: RED comes from the API layer, USE comes from each adapter's `metrics()` contract.

Metrics are served on a separate, internal-only port in Prometheus exposition format, or pushed via OTLP.

```ts
// kernel.config.ts
import { prometheusMetrics } from '@kernel/server/metrics'

export default defineConfig({
  observability: {
    metrics: prometheusMetrics({
      port: 9464,                  // scrape target, bind to the internal interface only
      path: '/metrics',
      defaultLabels: { service: 'kernel-api', env: process.env.DEPLOY_ENV ?? 'dev' },
      // histogram buckets tuned for CMS read/write latencies (ms)
      durationBuckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500],
    }),
  },
})
```

### RED — the request surface

Emitted per API surface and labeled by `surface` (`rest|graphql|rpc`), `collection`, `operation`, and `status`.

| Metric | Type | Labels | Purpose |
| --- | --- | --- | --- |
| `kernel_requests_total` | counter | surface, collection, operation, status | Rate, and error ratio via `status="error"` |
| `kernel_request_duration_ms` | histogram | surface, collection, operation | Latency p50/p95/p99 |
| `kernel_request_inflight` | gauge | surface | Concurrency / backpressure signal |

`status` is bucketed to `ok | client_error | server_error` so a `4xx` from a validation failure does not page you the way a `5xx` adapter fault should. The error ratio you alert on is `server_error / total`.

### USE — the resources

Every adapter implements `metrics(): AdapterMetrics`, which the server scrapes and re-exports with an `adapter` label. This is the part Payload and Strapi simply do not have — a uniform resource view across whichever database, cache, and storage you chose.

| Metric | Type | Adapter | Signal |
| --- | --- | --- | --- |
| `kernel_db_pool_in_use` / `_size` | gauge | `@kernel/db-*` | Utilization & saturation of the connection pool |
| `kernel_db_query_duration_ms` | histogram | `@kernel/db-*` | Slow-query detection |
| `kernel_cache_hits_total` / `_misses_total` | counter | cache adapter | Hit ratio |
| `kernel_queue_depth` | gauge | queue adapter | Saturation; backlog of jobs |
| `kernel_storage_op_duration_ms` | histogram | `@kernel/storage` | Upload/serve latency |
| `kernel_storage_errors_total` | counter | `@kernel/storage` | Resource errors |

```text
RED (API layer)                    USE (adapters)
┌─────────────────────┐            ┌──────────────────────────┐
│ rest / graphql / rpc│  request   │ db-postgres  pool, query │
│  rate · errors · dur│──────────▶ │ cache        hit/miss    │
└─────────────────────┘   spans    │ queue        depth       │
          │                        │ storage      op latency  │
          └── trace context ──────▶│ (each emits metrics())   │
                                   └──────────────────────────┘
```

## OpenTelemetry tracing

Tracing is the spine that ties logs and metrics together. KernelCMS uses OpenTelemetry natively: the server starts a tracer, TanStack Start server functions open a root span per RPC call, and the operation core opens child spans for access control, validation, hooks, and the adapter call. Context propagates via W3C `traceparent`, so a trace begun in the admin app (TanStack Query fetch) continues through the server function and into Postgres.

```ts
// kernel.config.ts
import { otelTracing } from '@kernel/server/tracing'

export default defineConfig({
  observability: {
    tracing: otelTracing({
      exporter: { kind: 'otlp', endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT },
      serviceName: 'kernel-api',
      // tail-sample errors and slow traces at 100%, head-sample the rest
      sampler: { kind: 'parentbased_traceidratio', ratio: 0.1 },
      // record access-control decisions as span events for audit + debugging
      recordAccessEvents: true,
    }),
  },
})
```

A representative span tree for `POST /api/posts`:

```text
rpc.posts.create                         (root, surface=rpc)
├─ access.collection.create              event: allow role=editor
├─ validate.fields                       12 fields, 1 async validator
├─ hook.beforeChange                     2 hooks
├─ db.insert posts                       drizzle, 18ms  ← db-postgres
│  └─ db.insert posts_locales            i18n write
├─ hook.afterChange                      cache invalidation
└─ storage.put uploads/cover.webp        9ms            ← storage adapter
```

Each span carries the same `requestId`, `userId`, and `tenantId` attributes as the logs, so clicking a slow trace in Grafana Tempo and jumping to the correlated Loki lines is one query. The `recordAccessEvents` flag turns every operation/document/field access decision into a span event — invaluable when an editor reports "I can't see this field" and you need to know which access function denied it without reproducing locally.

On KernelCMS Cloud the OTLP endpoint is pre-wired to the managed collector; self-hosters point it at any OTel-compatible backend (Tempo, Jaeger, Honeycomb, Datadog). See Deployment for collector sidecar topology.

## Dashboards and alerts

Ship the defaults, then customize. KernelCMS publishes a Grafana dashboard JSON and a Prometheus alert-rules file under `@kernel/server/observability/grafana` so a fresh install has a working "golden signals" board on day one rather than a blank canvas.

### Dashboard rows

| Row | Panels | Source |
| --- | --- | --- |
| Request health | rate, error ratio, p95/p99 latency per surface | RED |
| Slowest operations | top-N by `collection`/`operation` | RED histogram |
| Database | pool utilization, query p99, slow-query count | USE / db adapter |
| Cache & queue | hit ratio, queue depth trend | USE |
| Storage | op latency, error rate | USE / storage |
| Traces | exemplar links from latency panels into Tempo | tracing |

### Alert rules

Alert on symptoms (RED), diagnose with causes (USE + traces). Page on user-facing pain; ticket on creeping saturation.

```yaml
# alerts.yml — shipped defaults, tune thresholds per workload
groups:
  - name: kernel-red
    rules:
      - alert: KernelHighErrorRate
        expr: |
          sum(rate(kernel_requests_total{status="server_error"}[5m]))
            / sum(rate(kernel_requests_total[5m])) > 0.02
        for: 5m
        labels: { severity: page }
        annotations:
          summary: ">2% server errors on {{ $labels.surface }}"

      - alert: KernelLatencyP99
        expr: |
          histogram_quantile(0.99,
            sum by (le) (rate(kernel_request_duration_ms_bucket[5m]))) > 1000
        for: 10m
        labels: { severity: page }

  - name: kernel-use
    rules:
      - alert: KernelDbPoolSaturated
        expr: kernel_db_pool_in_use / kernel_db_pool_size > 0.9
        for: 10m
        labels: { severity: ticket }
        annotations:
          summary: "Postgres pool >90% utilized — raise pool size or shed load"

      - alert: KernelQueueBacklog
        expr: kernel_queue_depth > 5000
        for: 15m
        labels: { severity: ticket }
```

Two opinions baked into the defaults. Error-rate alerts use `server_error` only, so a spike of `4xx` validation failures from a misbehaving integration never wakes anyone — that belongs on a dashboard, not a pager. And latency alerts fire on p99, not the average, because in a CMS the average is dominated by cheap `findByID` cache hits and hides the editor whose `update` on a 200-block document is timing out.

For incident workflow once an alert fires, see Incident Response.

## Open questions

- **Log retention defaults.** Cloud will impose a tiered retention policy; the self-host default is undecided between "log to stdout and let the operator own retention" versus shipping an opinionated Loki Compose stack.
- **Cardinality guardrails.** Labeling RED metrics by `collection` is safe for tens of collections but risks cardinality blow-up for installs with hundreds. We may need an allowlist or automatic `collection="other"` bucketing above a configurable limit.
- **Trace sampling on Cloud.** Whether tenants can override the head-sampling ratio per project, or whether Cloud enforces a global tail-sampling policy for cost control, is still open.
- **Field-level span events at scale.** `recordAccessEvents` is excellent for debugging but multiplies span volume on documents with many fields; it may need to default off in production with a per-request debug header to enable.
