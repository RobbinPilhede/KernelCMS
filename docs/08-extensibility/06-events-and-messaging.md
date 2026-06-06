# Events & Messaging

KernelCMS emits a structured event for every meaningful state change — a document created, a version published, a user authenticated, a migration applied. Those events flow through an in-process event bus that powers hooks, plugins, search reindexing, cache invalidation, and live preview. The same events can be projected onto an external broker (NATS or Kafka) so other services in your architecture react without polling the REST or GraphQL APIs. This document specifies the event catalog, how subscribers register and run, how external brokers integrate via the `@kernel/plugin-sdk`, and the ordering and delivery guarantees you can rely on.

Where Payload exposes lifecycle *hooks* (`beforeChange`, `afterDelete`) bound to a single collection, Sanity emits *listener* documents over a mutation websocket, and Strapi ships a lightweight in-process `strapi.eventHub` plus webhooks — KernelCMS treats events as a first-class, typed, brokerable substrate. Hooks are sugar over the bus; the bus is the contract.

## Architecture

```
  operation core (@kernel/server)
        │  emit(event)
        ▼
   ┌──────────────┐    in-process, ordered per aggregate
   │  Event Bus   │───► subscribers (hooks, plugins, search, cache)
   │ (@kernel/    │
   │   core)      │───► outbox table (same DB txn)
   └──────────────┘          │
                             ▼  relay (at-least-once)
                      ┌──────────────┐
                      │ Broker Adapter│──► NATS JetStream
                      │(@kernel/plugin│──► Kafka
                      │     -sdk)     │──► (custom)
                      └──────────────┘
```

Every event is produced inside the operation that caused it. Mutating operations write domain rows **and** an outbox row in the same database transaction, so an event cannot be lost if the process dies after commit but before delivery. In-process subscribers run synchronously within the operation (so they can veto or mutate); external delivery is asynchronous via a relay that drains the outbox. This is the transactional-outbox pattern, and it is the reason KernelCMS can promise at-least-once external delivery without a distributed transaction.

## The Event Catalog

Events use a stable, dotted, namespaced name: `<domain>.<entity>.<action>`. Names are versioned implicitly by their typed payload; breaking payload changes ship a new suffix (`.v2`) rather than silently mutating the shape. The catalog is generated from your `kernel.config.ts` so collection- and global-scoped events are fully typed per slug.

| Event | Fires when | Cancelable | Payload highlights |
|-------|-----------|:----------:|--------------------|
| `document.created` | A collection doc is inserted | before only | `collection`, `doc`, `req`, `draft` |
| `document.updated` | A doc changes | before only | `collection`, `doc`, `previousDoc`, `changedFields` |
| `document.deleted` | A doc is removed | before only | `collection`, `id`, `doc` |
| `document.published` | A draft transitions to published | before only | `collection`, `doc`, `versionId` |
| `document.unpublished` | A published doc reverts to draft | before only | `collection`, `id`, `versionId` |
| `version.created` | Autosave or manual snapshot | no | `collection`, `versionId`, `autosave` |
| `version.restored` | A prior version is promoted | before only | `collection`, `fromVersionId` |
| `global.updated` | A singleton changes | before only | `slug`, `doc`, `previousDoc` |
| `upload.completed` | A media file finishes storage | no | `collection`, `file`, `sizes` |
| `auth.logged-in` | Successful login | no | `userId`, `strategy`, `ip` |
| `auth.locked` | Account lock threshold hit | no | `userId`, `reason` |
| `migration.applied` | A schema migration runs | no | `name`, `direction`, `durationMs` |

Cancelable events run in a `before` phase where a subscriber can throw to abort the operation or return a mutated payload. Non-cancelable events (`*.completed`, `auth.*`, `migration.*`) fire after the fact and cannot alter the outcome — listeners are observers only. This split is deliberate: it keeps the hot path predictable and prevents a logging plugin from accidentally rolling back a publish.

### Typed payloads

The bus is fully generic over your config. The `req` object carries the authenticated user, the request-scoped transaction, and locale — so a subscriber sees exactly what the operation saw, including access-control context.

```ts
import type { KernelEvent } from '@kernel/core'
import type { Post } from './kernel.types' // generated from config

// Discriminated by event name; payload is inferred.
type PublishedEvent = KernelEvent<'document.published', { collection: 'posts' }>

function onPublish(e: PublishedEvent) {
  const post: Post = e.payload.doc        // typed to the posts collection
  const versionId = e.payload.versionId   // string
  const user = e.req.user                 // typed auth user or null
}
```

## Subscribers

A subscriber is a typed listener registered against one or more event names. There are three ways to register, in increasing order of scope: collection/global hooks (config-local), plugin subscribers (cross-cutting), and the imperative `events.on()` API (for app code and tests).

### Hooks as sugar

Field- and collection-level hooks in `kernel.config.ts` compile to bus subscribers scoped to that slug. This keeps the Payload-style ergonomics developers expect while routing everything through one mechanism.

```ts
import { defineCollection } from '@kernel/core'

export const posts = defineCollection({
  slug: 'posts',
  hooks: {
    // Cancelable: runs in the `before` phase, may mutate or throw.
    beforeChange: [({ data, req }) => ({ ...data, editedBy: req.user?.id })],
    // Observer: runs after commit, cannot alter the result.
    afterPublish: [({ doc, req }) => req.payload.events.emit('search.reindex', { doc })],
  },
})
```

### Explicit subscribers

For cross-collection logic, register on the bus directly. Subscribers declare a `priority` (lower runs first) and an optional `filter` so the bus never wakes a listener for irrelevant slugs.

```ts
import { definePlugin } from '@kernel/plugin-sdk'

export const auditLog = definePlugin({
  name: 'audit-log',
  setup(kernel) {
    kernel.events.on(
      ['document.created', 'document.updated', 'document.deleted'],
      async (e) => {
        await kernel.db.insert('audit', {
          actor: e.req.user?.id ?? 'system',
          event: e.name,
          collection: e.payload.collection,
          at: e.timestamp,
        })
      },
      { priority: 100, filter: (e) => e.payload.collection !== 'audit' },
    )
  },
})
```

Subscriber rules:

- **Sync vs async.** Cancelable `before` subscribers are awaited inline and can throw to abort. Observer subscribers run after commit; their failures are logged and retried (for external relays) but never roll back the operation.
- **Idempotency.** Every event carries a stable `id` (ULID). Observers that touch external systems should dedupe on it, because at-least-once means you will occasionally see the same event twice.
- **Isolation.** A throwing observer does not block other observers. The bus collects errors and surfaces them through the monitoring hook (see Monitoring & Observability).

## External Brokers (NATS, Kafka)

In-process subscribers are great for the admin and the API host, but a real system has neighbors: a recommendation service, an email worker, a cache fronting another product. KernelCMS bridges to those over a broker adapter. Configure the relay in `kernel.config.ts`; the broker package is just another swappable adapter, exactly like database or storage (see Adapters Overview).

```ts
import { defineConfig } from '@kernel/core'
import { natsBroker } from '@kernel/plugin-sdk/brokers'

export default defineConfig({
  messaging: {
    broker: natsBroker({
      servers: process.env.NATS_URL!,         // never hardcode
      stream: 'kernel',                        // JetStream stream
      subjectPrefix: 'kernel.cms',             // -> kernel.cms.document.published
      // Project only what downstreams need; keep PII out of the wire.
      publish: ['document.published', 'document.unpublished', 'upload.completed'],
      transform: (e) => ({ id: e.id, name: e.name, collection: e.payload.collection, doc: e.payload.doc }),
    }),
    delivery: 'at-least-once',
    outbox: { table: 'kernel_outbox', batchSize: 256, pollMs: 200 },
  },
})
```

### NATS (JetStream)

NATS is the default broker for self-hosters: lightweight, single binary, with JetStream giving durable streams and consumer acks. KernelCMS maps each event name to a subject under `subjectPrefix`. Downstreams create durable consumers and ack per message; the relay treats a JetStream ack as confirmation and advances the outbox cursor.

### Kafka

For organizations already on Kafka, the adapter publishes to a topic per domain (`kernel.document`, `kernel.auth`) and uses the aggregate id (e.g. document id) as the **partition key**. That key choice is what buys you per-document ordering downstream — all events for one document land on the same partition and are consumed in order.

```ts
import { kafkaBroker } from '@kernel/plugin-sdk/brokers'

kafkaBroker({
  brokers: process.env.KAFKA_BROKERS!.split(','),
  topicFor: (e) => `kernel.${e.name.split('.')[0]}`,
  partitionKey: (e) => e.payload.id ?? e.payload.collection,
  acks: 'all', // wait for in-sync replicas
})
```

This is a clear win over Strapi, whose webhooks are fire-and-forget HTTP POSTs with no ordering, no durability, and no replay. It also beats Sanity's listener websocket, which is excellent for live UIs but is not a durable, partitioned message log you can wire into a Kafka-based data platform. KernelCMS gives you both: a websocket-style live channel for the admin (powered by TanStack DB) *and* a broker projection for backend integration.

## Ordering and Delivery

Guarantees are scoped to the **aggregate** — a single document, global, or user. Across aggregates there is no global order, and you should not design as if there were.

| Property | In-process bus | NATS / Kafka relay |
|----------|----------------|--------------------|
| Delivery | exactly-once (same process) | at-least-once |
| Ordering | per-aggregate, FIFO | per-aggregate (partition/subject keyed) |
| Durability | none (memory) | durable (outbox + broker) |
| Replay | no | yes (broker retention / outbox cursor) |

```
 doc A:  created ──► updated ──► published      (one partition, strict order)
 doc B:  created ──► published                  (different partition)
         A and B may interleave globally; each is internally ordered.
```

The outbox guarantees an event is recorded atomically with the data change. A background relay polls the outbox in commit order, publishes to the broker, and advances a per-partition cursor only after the broker acks. If the relay crashes mid-batch, it resumes from the last acked cursor and may re-publish the in-flight tail — hence at-least-once, and hence the `id` for dedupe. We deliberately do not promise exactly-once over the wire: it requires distributed coordination that would couple KernelCMS to the broker's transactional features and break the "choose everything" tenet.

For consumers that genuinely need exactly-once *effects*, the pattern is: consume at-least-once, key your side effect on `event.id`, and make the write idempotent. The catalog's stable ids and per-aggregate ordering make that straightforward.

## Open questions

- **Schema registry.** Should KernelCMS ship a generated Avro/JSON-Schema export for broker payloads so Kafka consumers get compile-time contracts, or leave that to the integrator?
- **Backpressure policy.** When the outbox grows faster than the relay drains (broker outage), do we pause non-cancelable emission, shed observer load, or only alert? Current lean is alert-and-buffer with a configurable high-water mark.
- **Per-field event granularity.** A `field.changed` event is attractive for fine-grained live preview but risks flooding the bus; it may stay opt-in per collection.
- **Ordering across globals and their referencing documents.** Cross-aggregate causal ordering (e.g. a global nav change that invalidates many docs) is currently the consumer's problem; a lightweight causal token is under consideration.
