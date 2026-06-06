# Webhooks

Webhooks are KernelCMS's outbound integration primitive: when a document changes, the server fires a signed HTTP request at an endpoint you control. They are the bridge between content events and the rest of your stack — rebuild triggers for static sites, cache purges, search reindexing, Slack notifications, downstream sync. KernelCMS treats webhooks as a first-class adapter concern with at-least-once delivery, HMAC signing, exponential-backoff retries, and a delivery log you can inspect and replay. This document specifies the trigger model, the payload contract, the delivery guarantees, and the consumer patterns we expect you to build against.

## Where webhooks fit

Webhooks subscribe to the same operation lifecycle that powers hooks and [access control](../06-auth-security/01-authorization-and-access-control.md). The difference is the boundary: a hook runs in-process inside the operation; a webhook is dispatched after the operation commits, out-of-band, to a remote consumer. A webhook never blocks the write that triggered it.

```
  create/update/delete            after commit              queue            consumer
  ──────────────────►  operation ───────────────► webhook ──────────► HTTP POST ──────►
  (REST / GraphQL /                 core           dispatcher    (@kernel/queue)   your endpoint
   RPC / Local API)                                                                 │
                                                                                    ▼
                                                                          200 → mark delivered
                                                                          5xx/timeout → retry
```

Because dispatch hangs off the operation core — not off a specific transport — a document created through the GraphQL mutation API, the typed RPC layer, the Local API in a seed script, or the admin panel all fire identical webhooks. There is no per-transport gap. Compare Strapi, where webhooks are wired to the entity-service lifecycle and bypassed entirely by raw `db.query` calls; KernelCMS routes every mutation through the operation core, so the only way to skip a webhook is to skip the operation.

## Event triggers

Webhooks are declared in `kernel.config.ts` and bound to collections, globals, and event types. The event taxonomy mirrors the document lifecycle:

| Event                  | Fires when                                  |
| ---------------------- | ------------------------------------------- |
| `document.created`     | A new document is created (any status)      |
| `document.updated`     | An existing document is updated             |
| `document.deleted`     | A document is hard-deleted                  |
| `document.published`   | A draft transitions to published            |
| `document.unpublished` | A published document reverts to draft       |
| `document.restored`    | A previous version is restored from history |
| `global.updated`       | A global singleton is saved                 |

Drafts and publish are distinct events on purpose. Sanity collapses everything into dataset mutations and leaves you to diff `_rev`s; Payload exposes `afterChange` with an `operation` discriminator but no native publish-vs-save distinction. KernelCMS separates `document.updated` (autosave/draft write) from `document.published` (the editorial gate) so a static-site rebuild can listen only for publishes and ignore the noise of autosave.

```ts
// kernel.config.ts
import { defineConfig } from '@kernel/core'

export default defineConfig({
  webhooks: [
    {
      name: 'rebuild-marketing-site',
      url: process.env.DEPLOY_HOOK_URL!,
      events: ['document.published', 'document.unpublished'],
      collections: ['pages', 'posts'],
      // Only fire for the production locale's published content.
      filter: ({ doc, event }) => event !== 'document.updated' && doc._status === 'published',
      secret: process.env.WEBHOOK_SIGNING_SECRET!,
    },
    {
      name: 'algolia-reindex',
      url: 'https://ingest.internal.example.com/kernel/algolia',
      events: ['document.published', 'document.deleted'],
      collections: ['posts'],
      // Trim the payload to what the indexer needs — keeps requests small and secrets out.
      transform: ({ doc }) => ({
        objectID: doc.id,
        title: doc.title,
        slug: doc.slug,
        excerpt: doc.excerpt,
        tags: doc.tags,
      }),
      headers: { 'X-Index': 'posts_prod' },
    },
  ],
})
```

### Targeting and filtering

- `collections` / `globals` scope the subscription. Omit both to subscribe to all content types.
- `events` is required and explicit — there is no implicit "all events" wildcard. You opt in.
- `filter` runs synchronously after the operation, receives `{ doc, previousDoc, event, req }`, and returns a boolean. A `false` result suppresses dispatch silently and is recorded as `filtered` in the delivery log.
- `transform` reshapes the body. It runs once per event and its output replaces `payload.doc`. Use it to drop fields a consumer should never see (PII, internal flags) and to keep payloads under the size budget.

Field-level access control is **not** applied to webhook payloads — webhooks run as a system principal, so they see the full document. Treat the signing secret as the authorization boundary and use `transform` to enforce least-privilege on the body.

## Payload and signing

Every delivery is a `POST` with a JSON body and a stable envelope. The envelope is versioned (`apiVersion`) so we can evolve the schema without breaking consumers.

```ts
interface WebhookPayload<T = Record<string, unknown>> {
  id: string // unique delivery id (idempotency key)
  apiVersion: '2026-01-01'
  event: WebhookEvent // 'document.published', etc.
  createdAt: string // ISO 8601, when the event fired
  collection?: string // present for collection events
  global?: string // present for global events
  doc: T // current document (or transform output)
  previousDoc?: T // prior state for updates/deletes
  meta: {
    userId: string | null // actor who triggered it, null for system
    locale?: string
    triggeredBy: 'rest' | 'graphql' | 'rpc' | 'local' | 'admin'
  }
}
```

### Signing

Bodies are signed with HMAC-SHA256 over the **raw request body** using the per-webhook `secret`. The signature ships in headers alongside a timestamp, so consumers can reject stale or replayed requests.

| Header             | Value                                                   |
| ------------------ | ------------------------------------------------------- |
| `Kernel-Signature` | `v1=<hex hmac-sha256 of "<timestamp>.<body>">`          |
| `Kernel-Timestamp` | Unix seconds when the request was signed                |
| `Kernel-Event`     | The event name (cheap routing without parsing the body) |
| `Kernel-Delivery`  | The delivery `id`, also present in the body             |
| `Kernel-Webhook`   | The configured webhook `name`                           |

The signed string is `${timestamp}.${rawBody}` — binding the timestamp into the HMAC is what makes replay protection meaningful. This is the same construction Stripe uses, and we copy it deliberately so existing verification code ports over. Verify on the consumer with a constant-time compare:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto'

export function verifyKernelSignature(
  rawBody: string,
  header: string,
  timestamp: string,
  secret: string,
  toleranceSeconds = 300,
): boolean {
  const age = Math.abs(Date.now() / 1000 - Number(timestamp))
  if (Number.isNaN(age) || age > toleranceSeconds) return false

  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')
  const received = header.replace(/^v1=/, '')

  const a = Buffer.from(expected, 'hex')
  const b = Buffer.from(received, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}
```

KernelCMS supports **secret rotation** without downtime: set `secrets: [newSecret, oldSecret]` and every delivery is signed with the first entry while the dispatcher will accept either on inbound replay verification. Rotate the new secret in, deploy consumers, then drop the old one. Strapi's webhook headers are static and unsigned by default — you bolt on auth via a custom header — which is a meaningful security gap KernelCMS closes out of the box.

## Retries and delivery guarantees

KernelCMS guarantees **at-least-once** delivery. The dispatcher enqueues a job on the configured `@kernel/queue` adapter inside the same transaction boundary as the write's post-commit phase, so a committed change cannot silently fail to enqueue. The worker then attempts delivery and retries on failure with exponential backoff and jitter.

A delivery is **successful** on a `2xx` response received within the timeout. Everything else is a failure:

| Outcome                    | Treated as | Action                                           |
| -------------------------- | ---------- | ------------------------------------------------ |
| `2xx`                      | success    | mark `delivered`                                 |
| `3xx`                      | failure    | retry (we do not follow redirects)               |
| `408`, `429`, `5xx`        | retryable  | retry with backoff; honor `Retry-After` on `429` |
| Other `4xx`                | permanent  | mark `failed`, no retry (consumer rejected it)   |
| Timeout / connection error | retryable  | retry with backoff                               |

Default backoff schedule (configurable per webhook via `retry`):

```
attempt 1 → immediate
attempt 2 → ~30s
attempt 3 → ~2m
attempt 4 → ~10m
attempt 5 → ~1h
attempt 6 → ~6h
exhausted → dead-letter
```

```ts
{
  name: 'rebuild-marketing-site',
  url: process.env.DEPLOY_HOOK_URL!,
  events: ['document.published'],
  retry: {
    maxAttempts: 6,
    backoff: 'exponential',   // 'exponential' | 'fixed' | 'linear'
    baseDelayMs: 30_000,
    jitter: true,
    timeoutMs: 10_000,
  },
}
```

### Ordering and idempotency

We do **not** guarantee ordering. A retried `document.updated` can arrive after a newer `document.published` for the same document. Consumers must be idempotent and resolve conflicts by comparing `createdAt` (the event clock) or the document's own version, not by trusting arrival order. The `id` field is your idempotency key — store processed ids and drop duplicates. This is the same contract Sanity's listener API forces on you, and the same discipline; we just make it explicit in the envelope rather than leaving you to derive it from `_rev`.

### Dead-letter and replay

When `maxAttempts` is exhausted, the delivery moves to a dead-letter state and is retained in the delivery log (default 30 days). You can inspect and replay from the admin panel under **Settings → Webhooks → Deliveries**, or programmatically:

```ts
import { getPayloadClient } from '@kernel/client'

const kernel = await getPayloadClient()

// Re-send every dead-lettered delivery for one webhook.
const failed = await kernel.webhooks.deliveries.list({
  webhook: 'algolia-reindex',
  status: 'failed',
})
for (const d of failed.docs) {
  await kernel.webhooks.deliveries.replay(d.id)
}
```

Replays carry the original `id`, so an idempotent consumer that already processed the event safely no-ops.

## Consumer patterns

A correct consumer does four things in order: **verify, deduplicate, acknowledge fast, process async.**

```
POST /webhooks/kernel
   │
   ├─ verify signature + timestamp ──► 401 on mismatch (no retry needed; it's not us)
   ├─ seen this delivery id before? ──► 200 immediately (idempotent skip)
   ├─ enqueue work ──────────────────► 200 immediately
   └─ background worker does the heavy lifting (reindex, rebuild, notify)
```

The cardinal rule: **acknowledge with `2xx` as fast as you can, then do the work out of band.** If you reindex synchronously inside the request handler and it takes 12 seconds, you blow the `timeoutMs`, KernelCMS retries, and you process the same event twice. Return `200`, enqueue, move on.

```ts
// A TanStack Start server route consuming KernelCMS webhooks.
import { createServerFileRoute } from '@tanstack/start'

export const ServerRoute = createServerFileRoute('/api/webhooks/kernel').methods({
  POST: async ({ request }) => {
    const raw = await request.text()
    const ok = verifyKernelSignature(
      raw,
      request.headers.get('Kernel-Signature') ?? '',
      request.headers.get('Kernel-Timestamp') ?? '',
      process.env.WEBHOOK_SIGNING_SECRET!,
    )
    if (!ok) return new Response('invalid signature', { status: 401 })

    const payload = JSON.parse(raw) as WebhookPayload
    if (await alreadyProcessed(payload.id)) {
      return new Response('ok', { status: 200 }) // idempotent replay
    }

    await jobQueue.add('process-kernel-event', payload) // enqueue, don't block
    return new Response('ok', { status: 200 })
  },
})
```

### Common integrations

- **Static-site rebuild.** Subscribe to `document.published` / `document.unpublished` only. Debounce on the consumer side — a bulk publish of 40 pages should trigger one build, not 40.
- **Search reindex.** Subscribe to `published` and `deleted`, use `transform` to send only indexed fields. Pair with the search adapter if you'd rather reindex in-process and skip webhooks entirely.
- **Downstream sync / CDC.** Subscribe to all events, key on `id` for idempotency, reconcile with `previousDoc` to compute diffs.
- **Notifications.** Fan out `document.published` to Slack/email. Keep these on a separate webhook with a short `maxAttempts` — a missed Slack ping is not worth six hours of retries.

### Local development

Point a webhook at a tunnel (`ngrok`, `cloudflared`) and use the **Replay** button to re-fire a captured delivery without re-editing content. The delivery log shows the exact signed headers and body for every attempt, including response status and latency, so you can debug signature mismatches without guessing.

## Open questions

- **Per-webhook concurrency caps.** Should we expose a max-in-flight setting per webhook to protect slow consumers, or rely entirely on the queue adapter's concurrency config?
- **Batched delivery.** A bulk publish currently fans out one request per document. We're weighing an opt-in `batch: true` mode that coalesces events into a single array payload within a short window — better for rebuild hooks, worse for strict per-event idempotency.
- **Outbound IP allowlisting / static egress.** For KernelCMS Cloud, consumers behind a firewall want a stable egress IP range to allowlist. Self-host has no such guarantee; we need to decide whether Cloud publishes a documented CIDR block.
- **Signature payload for `transform`.** The HMAC currently covers the post-transform body. Confirm this is the desired contract versus signing the canonical untransformed document.
