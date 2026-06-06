# Scaling & Performance Operations

KernelCMS is built to run identically whether you self-host one container or operate KernelCMS Cloud's multi-tenant fleet. Because the operation core (`@kernel/server`) is stateless and every infrastructure concern is a swappable adapter, scaling is mostly a matter of provisioning capacity correctly and putting the right cache in front of the right surface. This document covers the four levers that matter under load — horizontal scaling, database scaling with read replicas, the caching tiers, and how to load test before you ship. It assumes you've already read [Deployment Topologies](./00-deployment-models-self-host-vs-cloud.md) and [Observability](./05-observability-logging-metrics-tracing.md).

## Horizontal Scaling

The KernelCMS server process is stateless by design. There is no in-process session store, no sticky-session requirement, and no node-local mutable state that survives a request. Sessions live in `@kernel/auth`'s configured store (Redis or the database), uploads go to `@kernel/storage`, and the job queue lives in the queue adapter. That means you scale the API host the boring way: run N identical replicas behind a load balancer and let any request land on any node.

This is a deliberate departure from Strapi, whose default single-process model and admin build artifacts make horizontal scaling a manual exercise (shared upload volume, externalized sessions, sticky uploads). KernelCMS treats "more than one node" as the baseline, not the exception. Payload is similarly stateless on Express/Next; the difference is that KernelCMS runs on TanStack Start server functions, so the same RPC core scales whether you deploy to Node, Bun, or an edge runtime.

```
            ┌──────────────┐
  clients → │ Load Balancer│ (L7, sticky=off, health=/healthz)
            └──────┬───────┘
        ┌──────────┼──────────┐
        ▼          ▼          ▼
   ┌────────┐ ┌────────┐ ┌────────┐
   │ node 1 │ │ node 2 │ │ node 3 │   @kernel/server replicas (stateless)
   └───┬────┘ └───┬────┘ └───┬────┘
       └──────────┼──────────┘
        ┌─────────┴──────────┬───────────┐
        ▼                    ▼           ▼
   Postgres (primary)   Redis cache   Object storage
   + read replicas      + sessions    (@kernel/storage)
```

Configure the runtime concurrency and health surface in `kernel.config.ts`. Performance budgets are first-class — the server refuses to start if a budget is set below the measured floor, so you find capacity mistakes at boot, not at 2am.

```ts
import { defineConfig } from '@kernel/core'

export default defineConfig({
  server: {
    // Per-replica request concurrency. Tune to CPU cores × headroom.
    concurrency: 256,
    health: { liveness: '/healthz', readiness: '/readyz' },
    // Readiness fails fast if the DB pool or queue is unreachable,
    // so the load balancer drains the node instead of 500ing.
    drainTimeoutMs: 15_000,
    budgets: {
      // Enforced and measured — see Load Testing below.
      p99LatencyMs: 400,
      maxRssMb: 768,
    },
  },
})
```

### Autoscaling signals

Scale on the signals that actually correlate with KernelCMS load: request concurrency and event-loop lag, not raw CPU. A node saturating its DB pool will show high latency at low CPU, and CPU-based autoscaling will under-provision. On Kubernetes, drive the HPA from a custom metric exported by `@kernel/server`'s `/metrics` endpoint.

| Signal | Source | Scale-out trigger | Why |
|---|---|---|---|
| In-flight requests / replica | `kernel_inflight_requests` | > 70% of `concurrency` | Direct saturation measure |
| Event-loop lag p99 | `kernel_eventloop_lag_ms` | > 50ms | JS single-thread starvation |
| DB pool wait time | `kernel_db_pool_wait_ms` | > 20ms sustained | DB is the bottleneck, not the node |
| Queue depth | `kernel_queue_depth` | per-job SLA | Background work backing up |

The admin app deserves separate scaling. It's a TanStack Start SSR app that does little CPU work per request once TanStack Query has warmed its caches client-side. Run it as its own deployment so a traffic spike on the public REST/GraphQL API never starves editors in the panel.

## Database Scaling & Read Replicas

The database is the first thing that falls over, and it's where KernelCMS gives you the most explicit control. Drizzle is the default ORM for SQL (Postgres default, SQLite/libSQL, MySQL), with MongoDB for document workflows. Every backend implements the one Adapter contract, and the adapter is replica-aware: it routes reads and writes to different connections based on the operation.

The routing rule is simple and predictable. Mutating operations (`create`, `update`, `delete`, anything that produces a version row) always hit the primary. Read operations (`find`, `findByID`, GraphQL queries, REST `GET`) hit a replica unless the request opts into read-your-writes consistency.

```ts
import { postgresAdapter } from '@kernel/db-postgres'

export default defineConfig({
  db: postgresAdapter({
    primary: { url: process.env.DATABASE_URL },
    replicas: [
      { url: process.env.DATABASE_REPLICA_1_URL },
      { url: process.env.DATABASE_REPLICA_2_URL },
    ],
    pool: { max: 20, idleTimeoutMs: 30_000 },
    // Operations within this window after a write are pinned to the
    // primary for the same session, so editors never see stale reads.
    readYourWrites: { windowMs: 2_000 },
  }),
})
```

You can override routing per operation through the Local API when you know a read must be fresh — for example, re-fetching a document immediately after publish to render live preview:

```ts
const doc = await payload.findByID({
  collection: 'posts',
  id,
  // Force the primary for this read; bypasses replica lag.
  consistency: 'strong',
})
```

This is a sharper tool than what Payload and Strapi expose today. Payload routes everything through a single Drizzle/Mongoose connection; read-replica routing is left to you at the infrastructure layer (e.g., a proxy that can't distinguish read-your-writes cases). Sanity sidesteps the problem entirely with its hosted Content Lake, but you give up control of the storage engine. KernelCMS lets you keep Postgres and still get replica fan-out with correctness guarantees baked into the adapter.

### Connection pooling and the replica lag trap

Replicas multiply your connection count. With three replicas and a `max: 20` pool, each replica node sees up to `20 × N_app_replicas` connections — that math kills Postgres fast. Put PgBouncer (transaction pooling) in front of every database node and size the app pool to the PgBouncer pool, not the raw server `max_connections`.

```
app replicas ──▶ PgBouncer (transaction mode) ──▶ Postgres primary
            └──▶ PgBouncer ──▶ replica 1 / replica 2
```

Two operational rules:

- **Monitor replica lag and eject lagging replicas.** The adapter polls `kernel_db_replica_lag_ms`; a replica past `replicaLagEjectMs` is removed from the read pool until it recovers. A 30-second-stale replica serving the admin list view produces support tickets, not errors.
- **Generate migrations from schema diffs, run them on the primary, never on replicas.** Migrations are derived from config-as-code; see Migrations. The replica replays the WAL.

For MongoDB, the same `consistency` field maps to read preference (`primary` vs `secondaryPreferred`) and read concern, so the application code is identical across adapters.

## Caching Tiers

KernelCMS layers four caches, each with a clear owner and invalidation story. The principle: cache aggressively at the edges, invalidate precisely from the write path. Every mutation in the operation core emits an invalidation event, so caches are evicted by document and collection, never by blunt TTL alone.

```
┌─────────────────────────────────────────────────────────┐
│ 1. CDN / edge        public REST + GraphQL GET responses │  ← KernelCMS Cloud global CDN
├─────────────────────────────────────────────────────────┤
│ 2. @kernel/cache     server-side query result cache      │  ← Redis adapter, tag-based eviction
├─────────────────────────────────────────────────────────┤
│ 3. TanStack Query    admin + client SDK cache            │  ← staleTime/invalidation per query key
├─────────────────────────────────────────────────────────┤
│ 4. DB / Drizzle      prepared-statement + plan cache     │  ← primary/replica
└─────────────────────────────────────────────────────────┘
```

The server-side cache is a swappable adapter like everything else. Configure it with tag-based eviction so a single document update evicts exactly the cached queries that referenced it.

```ts
import { redisCache } from '@kernel/cache'

export default defineConfig({
  cache: redisCache({
    url: process.env.REDIS_URL,
    // Each cached query is tagged with collection + doc IDs it touched.
    // A write to posts:42 evicts every tag containing it — no TTL guessing.
    strategy: 'tag-based',
    defaultTtlMs: 60_000,
  }),
  collections: [
    {
      slug: 'posts',
      cache: { surfaces: ['rest', 'graphql'], ttlMs: 300_000 },
    },
  ],
})
```

On the client and admin, caching is TanStack Query, not an ad-hoc layer. `@kernel/client` ships query keys derived from the same `where`/`sort`/`depth` query language used everywhere, so cache invalidation after a mutation is a precise `queryClient.invalidateQueries({ queryKey })` rather than a global refetch.

The edge tier matters most for read-heavy public sites. KernelCMS Cloud fronts the auto-generated REST and GraphQL `GET` surfaces with a global CDN and propagates invalidation events to purge by tag on publish — the same mental model Sanity offers with its CDN, but over your own content config and exposed on self-host via standard `Cache-Control` plus a purge webhook. Draft and access-controlled reads are never cached at the edge; the access-control layer runs server-side per request, so personalized responses bypass tiers 1 and 2 entirely.

| Tier | TTL | Invalidation | Caches drafts/private? |
|---|---|---|---|
| CDN / edge | minutes–hours | tag purge on publish | No |
| `@kernel/cache` | seconds–minutes | tag-based on every write | No (per-user keyed) |
| TanStack Query | `staleTime` | mutation invalidation | Yes (client memory) |
| DB plan cache | connection | automatic | n/a |

## Load Testing

Capacity claims are worthless without measurement, which is why `server.budgets` are enforced. The load-testing workflow has three stages, run in CI against an ephemeral environment that mirrors production adapters (real Postgres + replicas + Redis, not SQLite).

1. **Baseline** — single replica, ramp concurrency until p99 crosses the budget. This finds the per-node ceiling and validates `concurrency`.
2. **Scale** — fix per-node load at 70% of the ceiling, add replicas, confirm throughput scales near-linearly. Sub-linear scaling means a shared bottleneck (usually the DB pool or a missing replica).
3. **Soak** — sustained moderate load for 30+ minutes to catch leaks against `maxRssMb` and replica-lag growth.

Use realistic mixed traffic: list views (TanStack Table queries with `where`/`sort`/pagination), deep `findByID` with `depth`, GraphQL with relationship traversal, and a write fraction that exercises versioning and cache invalidation. A 100%-read test will lie to you, because it never tests the invalidation fan-out that dominates write-heavy editorial workloads.

```ts
// loadtest/scenarios.ts — k6 driving the auto-generated REST surface
import { check } from 'k6'
import http from 'k6/http'

export const options = {
  scenarios: {
    reads: { executor: 'ramping-vus', exec: 'listAndRead', stages: [
      { duration: '2m', target: 200 }, { duration: '5m', target: 200 },
    ]},
    writes: { executor: 'constant-vus', exec: 'publish', vus: 10, duration: '7m' },
  },
  thresholds: { 'http_req_duration{scenario:reads}': ['p(99)<400'] },
}
```

Wire the thresholds to the same numbers in `server.budgets`. A regression that pushes p99 past 400ms fails the pipeline, not a production alert. Export results to the observability stack so you can compare runs across releases; see [Observability](./05-observability-logging-metrics-tracing.md) for the dashboards.

## Open Questions

- **Cross-region write routing.** For KernelCMS Cloud's multi-region tenants, do writes always route to a single primary region (simple, higher write latency for distant editors), or do we adopt logical replication with conflict-free per-collection ownership? Leaning toward single-primary per tenant for v1.
- **Edge cache key cardinality.** Tag-based purge at the CDN is clean for collection-level invalidation but can explode key cardinality for high-`depth` GraphQL queries. Whether to cap cacheable `depth` at the edge or fall back to tier-2 only is undecided.
- **Replica routing for aggregations.** Count/aggregate queries on a lagging replica can disagree with the list they accompany. Whether to pin aggregations to the primary by default is still open.
