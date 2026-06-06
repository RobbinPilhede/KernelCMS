# Jobs, Queues & Scheduling

KernelCMS treats background work as a first-class part of the content model, not a bolt-on. Jobs are defined in `kernel.config.ts` alongside collections and globals, share the same type inference and access-control machinery as the rest of the system, and run through a swappable queue adapter — in-memory for dev, Postgres or Redis for production, or your own. Scheduling is config-as-code: cron expressions live next to the handler they trigger. This document specifies how jobs are defined, how the queue adapter contract works, the retry and backoff model, and how scheduled tasks are wired.

## Why jobs belong in the CMS

Headless CMS work is full of operations that must not block a request: regenerating image derivatives after an upload, rebuilding a search index, sending publish notifications, syncing to a downstream system, expiring scheduled content. Each competitor solves this differently and incompletely.

- **Payload** ships a Jobs Queue with tasks, workflows, and a `payload.jobs.queue()` API, but you run workers yourself and the queue is effectively the database — there is no first-class adapter to swap in Redis or SQS.
- **Strapi** has no native queue. The ecosystem reaches for Bull/BullMQ plugins, and lifecycle hooks run inline, so a slow `afterUpdate` blocks the write.
- **Sanity** offers scheduled publishing and webhooks, but arbitrary background compute lives in separate Sanity Functions / GROQ webhooks — it is not a general job runner you own.

KernelCMS unifies these into one model: typed job definitions, a `queue` adapter that follows the same Adapter contract as [`@kernel/db`](../03-persistence/00-persistence-overview-and-adapter-contract.md) and [`@kernel/storage`](../07-media-files/01-storage-adapters.md), and cron declared in config. Jobs run through the same operation core as the [Local API](../05-api/03-typed-rpc-and-local-api.md), so a handler gets the fully typed `payload`/`kernel` instance and respects [access control](../06-auth-security/01-authorization-and-access-control.md) and [hooks](./02-hooks-and-lifecycle.md).

## Job definition

A job is a named handler with a typed input schema, a queue assignment, and retry policy. Define jobs in the `jobs` block of `kernel.config.ts`. The `@kernel/core` `defineJob` helper infers the input type from the schema and threads it through to the handler.

```ts
// kernel.config.ts
import { defineConfig, defineJob } from '@kernel/core'
import { z } from 'zod'

export const generateThumbnails = defineJob({
  slug: 'generate-thumbnails',
  queue: 'media',                 // logical queue name, mapped by the adapter
  input: z.object({
    uploadId: z.string(),
    sizes: z.array(z.enum(['thumb', 'card', 'hero'])).default(['thumb']),
  }),
  retries: { attempts: 5, backoff: { type: 'exponential', delay: 2_000 } },
  timeout: 60_000,                // ms; handler is aborted past this
  async handler({ input, kernel, signal, attempt, log }) {
    const upload = await kernel.findByID({ collection: 'media', id: input.uploadId })
    for (const size of input.sizes) {
      if (signal.aborted) return  // cooperate with timeout/shutdown
      await renderDerivative(upload, size)
      log.info('derivative.done', { size, attempt })
    }
  },
})

export default defineConfig({
  jobs: {
    tasks: [generateThumbnails],
    queue: postgresQueue({ /* … */ }),  // default adapter for all queues
  },
})
```

Key properties of a job definition:

| Field | Meaning |
| --- | --- |
| `slug` | Stable identifier; used in logs, the admin UI, and `kernel.jobs.enqueue`. |
| `queue` | Logical queue name. The adapter maps it to a real queue/topic/table partition. |
| `input` | Zod (or any Standard Schema) shape. Payloads are validated on enqueue **and** on dequeue. |
| `retries` | Attempt count and backoff strategy (see below). |
| `timeout` | Per-attempt wall-clock budget. On expiry the `signal` aborts and the attempt fails. |
| `handler` | Receives `{ input, kernel, signal, attempt, log, job }`. Idempotency is the handler's responsibility. |

Enqueue from anywhere with full inference — the `input` argument is typed from the job's schema, so a typo or wrong shape is a compile error:

```ts
// inside a hook, server function, or another job
await kernel.jobs.enqueue(generateThumbnails, {
  input: { uploadId: doc.id, sizes: ['thumb', 'hero'] },
  delay: 5_000,           // optional: schedule for the future
  priority: 10,           // higher runs first within a queue
  dedupeKey: doc.id,      // collapse duplicate enqueues
})
```

`dedupeKey` is what Payload and the BullMQ-on-Strapi setups make you build by hand. If a job with the same `dedupeKey` is already pending on the same queue, the enqueue is a no-op — critical for hook-driven work where one document save can fire many times.

### Jobs vs. hooks

Hooks (`afterChange`, `afterDelete`) run inline in the request. Jobs run out of band. The rule: if the work can fail independently of the write, or takes more than a few milliseconds, enqueue a job from the hook instead of doing it inline. This is the opposite of Strapi's default, where lifecycle logic runs in-process and slow side effects degrade write latency.

```ts
// collections/media.ts
hooks: {
  afterChange: [({ doc, operation, kernel }) => {
    if (operation === 'create') {
      kernel.jobs.enqueue(generateThumbnails, { input: { uploadId: doc.id } })
    }
  }],
}
```

## Queue adapters

Every queue backend implements one `QueueAdapter` contract from `@kernel/core`. This mirrors the database and storage adapter pattern — nothing about a job handler knows or cares which backend is behind it.

```ts
interface QueueAdapter {
  name: string
  enqueue(job: EnqueueRequest): Promise<JobRecord>
  // Long-poll/claim the next runnable job for the given queues, respecting
  // visibility timeouts. Returns null when nothing is available.
  reserve(queues: string[], opts: ReserveOptions): Promise<ClaimedJob | null>
  complete(id: string): Promise<void>
  fail(id: string, error: SerializedError, retryAt: Date | null): Promise<void>
  // Move due scheduled jobs into the runnable set; idempotent.
  promoteScheduled(now: Date): Promise<number>
  stats(queue?: string): Promise<QueueStats>
}
```

```
producer ──enqueue──▶ [ queue adapter ]
                          │  pending / scheduled / active / failed / done
                          ▼
   worker pool ──reserve──▶ claim (visibility timeout) ──run handler──▶ complete
                          ▲                                   │
                          └──────────── fail(retryAt) ◀───────┘
```

Officially supported adapters:

| Adapter | Package | Backing store | Best for |
| --- | --- | --- | --- |
| `inMemoryQueue` | `@kernel/core` | process memory | dev, tests, single-process edge |
| `postgresQueue` | `@kernel/db-postgres` | `SELECT … FOR UPDATE SKIP LOCKED` | self-host, "one less service" |
| `redisQueue` | `@kernel/queue-redis` | Redis streams | high throughput, low latency |
| `sqsQueue` | `@kernel/queue-sqs` | Amazon SQS + DynamoDB | serverless/edge fan-out |
| Cloud-managed | `@kernel/cloud` | managed | KernelCMS Cloud tenants |

The Postgres adapter is the default and the differentiator. Like Payload it can run jobs on your existing database — no Redis required — but unlike Payload it uses `FOR UPDATE SKIP LOCKED` for contention-free multi-worker claims, exposes a real adapter seam so you can graduate to Redis or SQS without touching a single job handler, and persists scheduled and failed jobs in queryable tables surfaced in the admin panel.

Workers are started from the same binary as the server:

```bash
kernel work --queues media,default --concurrency 8
# or run inline with the API host for small deployments:
kernel serve --with-workers
```

On KernelCMS Cloud, workers are provisioned and autoscaled by queue depth; the same `defineJob` config runs unchanged. This is the portability tenet — self-host and Cloud share one job model, so you can move between them without rewriting workers.

## Retries and backoff

Failure is the normal case for background work — a downstream API rate-limits you, an image is briefly unreadable, a deploy restarts a worker mid-job. The retry policy is declared per job and enforced by the runner, not left to the handler.

Two strategies ship in `@kernel/core`:

```ts
type Backoff =
  | { type: 'fixed'; delay: number }
  | { type: 'exponential'; delay: number; max?: number; jitter?: boolean }
```

`exponential` computes `delay * 2 ** (attempt - 1)`, capped at `max`, with full jitter on by default to avoid thundering-herd retries. Attempt 1 is the initial run; `attempts: 5` means up to four retries.

```
attempt 1 ─fail─▶ wait 2s ─▶ attempt 2 ─fail─▶ wait ~4s ─▶ attempt 3
   ─fail─▶ wait ~8s ─▶ attempt 4 ─fail─▶ wait ~16s ─▶ attempt 5 ─fail─▶ dead-letter
```

When attempts are exhausted the job moves to a dead-letter state, stays in the table, and is visible in the admin Jobs view where an operator can inspect the serialized error and replay it. A job can also signal control flow explicitly:

```ts
import { RetryError, FailError } from '@kernel/core'

async handler({ input, attempt }) {
  const res = await fetch(endpoint)
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after') ?? 30) * 1000
    throw new RetryError('rate limited', { retryAfter })  // override backoff
  }
  if (res.status === 422) {
    throw new FailError('permanent validation failure')   // no retry, dead-letter now
  }
}
```

`RetryError` overrides the computed backoff for that attempt; `FailError` skips remaining attempts because the input is bad and retrying cannot help. This distinction — transient vs. permanent — is what generic queue plugins on Strapi leave you to encode by hand.

**Idempotency is non-negotiable.** Because a job can run more than once (retry, or a worker that crashed after doing work but before acking), handlers must be safe to re-run. Use the `dedupeKey`, natural keys, or conditional writes. The runner provides `job.id` and `attempt` so you can make handlers idempotent against an external system's idempotency key.

## Scheduled tasks

Cron is declared in config, next to the job it triggers. There is no separate scheduler service and no UI-only cron that drifts from source control.

```ts
// kernel.config.ts
export default defineConfig({
  jobs: {
    tasks: [publishScheduled, pruneVersions],
    queue: postgresQueue({ /* … */ }),
    schedules: [
      { job: publishScheduled, cron: '* * * * *', queue: 'default' },        // every minute
      { job: pruneVersions,    cron: '0 3 * * *', tz: 'UTC' },               // 03:00 daily
      { job: rebuildSitemap,   cron: '@hourly',   dedupeKey: 'sitemap' },
    ],
  },
})
```

A single elected leader (advisory lock in Postgres, or the Cloud scheduler) calls `promoteScheduled(now)` each tick, which enqueues due jobs exactly once across the cluster. This avoids the classic multi-instance bug where every replica fires the same cron — a real footgun when self-hosting Strapi behind several pods. Schedules carry a `dedupeKey` so an overrun (a slow run still in flight when the next tick arrives) collapses instead of stacking.

Scheduled content publishing is the canonical use case and ships as a built-in job: documents with a future `publishAt` are flipped to published by the per-minute `publishScheduled` task, matching Sanity's scheduled publishing — but here it is the same general scheduler you use for everything else, fully owned and self-hostable.

## Observability and admin

Every job record carries `status`, `attempt`, `queue`, timestamps, `dedupeKey`, and the last serialized error. The admin Jobs view (built on [TanStack Table](../04-admin-ui/05-collection-list-views.md) with virtualization) lists pending, active, completed, and dead-lettered jobs with filtering by queue and slug, and offers replay/cancel actions gated by access control. Structured logs (`log.info`/`log.error` inside handlers) flow to the configured logger and, on Cloud, into per-tenant observability.

## Open questions

- **Workflows / multi-step jobs.** Payload models chained tasks as "workflows" with restartable steps. Do we ship a first-class `defineWorkflow` with checkpointing, or keep jobs single-step and let handlers enqueue successors?
- **Cron leader election off Postgres.** The advisory-lock approach is clean for SQL backends. For Redis/SQS-only deployments we need a documented election story (Redlock vs. an external coordinator) — undecided.
- **Per-tenant fair scheduling on Cloud.** How do we prevent one noisy tenant's queue depth from starving others — weighted fair queuing per tenant, or hard per-tenant worker quotas?
- **Exactly-once vs. at-least-once guarantees.** The current contract is at-least-once with idempotent handlers. Is there demand for an opt-in exactly-once mode on adapters that can support it (e.g., transactional Postgres), and is the complexity worth it?
