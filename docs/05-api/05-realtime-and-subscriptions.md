# Realtime & Subscriptions

KernelCMS treats realtime as a first-class surface, not a bolt-on. Every write that flows through the operation core — `create`, `update`, `delete`, publish, autosave — emits a typed change event. Those events drive live list views, document collaboration, live preview, and any client subscribed over the wire. The realtime layer is delivered through the same `@kernel/server` request host (TanStack Start server functions), shares the `where`/`sort`/`depth` query language with REST, GraphQL, and RPC, and respects the exact same access control. Payload has no native subscription surface (you poll or wire your own websockets); Strapi ships a websocket layer mostly tied to its admin; only Sanity ships a true global mutation listener. KernelCMS gives you Sanity-grade live queries with a self-hostable, adapter-swappable backend.

## Architecture overview

A change originates in the operation core, is published to a pub/sub backend (the realtime adapter), and fans out to connected clients through a transport. Access control is re-evaluated per subscriber at fan-out time, so a subscription never leaks a document the recipient cannot read.

```
 write op ──▶ operation core ──▶ change event ──▶ realtime adapter (pub/sub)
                                                         │
                          ┌──────────────────────────────┼──────────────────────────────┐
                          ▼                               ▼                               ▼
                   SSE connection                  WebSocket conn                 WebSocket conn
                   (TanStack Query                 (collab + presence)            (TanStack DB sync)
                    live subscription)
                          │                               │                               │
                   re-run access control + where-match per subscriber, then deliver delta
```

The realtime adapter is swappable like every other infrastructure concern. In a single-node deploy it is an in-process `EventEmitter`. Across a cluster it is Redis, NATS, or Postgres `LISTEN/NOTIFY`. The contract is small:

```ts
// @kernel/core
export interface RealtimeAdapter {
  publish(channel: string, event: ChangeEvent): Promise<void>
  subscribe(channel: string, onEvent: (e: ChangeEvent) => void): Unsubscribe
  // optional ephemeral state for presence; absent => presence disabled
  presence?: PresenceBackend
}

export interface ChangeEvent {
  op: 'create' | 'update' | 'delete'
  collection: string
  id: string
  // 'published' lets clients distinguish draft saves from publishes
  status: 'draft' | 'published'
  version: number
  // full doc included only when the publisher policy allows; else id-only
  doc?: Record<string, unknown> | null
  ts: number
}
```

## Transport: SSE and WebSocket

KernelCMS ships two transports and picks deliberately rather than forcing one. The selection is per-use-case, not per-deploy.

| Transport | Direction       | Use case                                           | Reconnect                     | Cost                                              |
| --------- | --------------- | -------------------------------------------------- | ----------------------------- | ------------------------------------------------- |
| SSE       | server → client | Live queries, list views, live preview, dashboards | Native `Last-Event-ID` resume | Cheap, HTTP/2-friendly, proxy-friendly            |
| WebSocket | bidirectional   | Presence, collaborative editing, cursor/awareness  | Manual resume token           | Heavier, sticky sessions or shared pub/sub needed |

The rule: **if the client only consumes, use SSE; if the client also publishes ephemeral state (cursors, locks, typing), use WebSocket.** Most read-side realtime — the bulk of CMS traffic — is one-directional, so SSE is the default and degrades gracefully through corporate proxies and serverless edges where long-lived WebSockets are painful. This is a sharper split than Strapi, which routes everything through Socket.IO.

SSE is exposed as a streaming server function:

```ts
// GET /api/realtime/subscribe?collection=posts&where=...
// implemented as a TanStack Start server function returning a ReadableStream
export const subscribe = createServerFn({ method: 'GET' })
  .validator(subscribeQuery) // collection, where, depth, status
  .handler(async ({ data, context }) => {
    const stream = kernel.realtime.stream(data, { user: context.user })
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    })
  })
```

Each SSE message carries the event id (used as `Last-Event-ID` on resume) and a JSON payload. On reconnect the server replays missed events from a short bounded buffer keyed by id; if the buffer has rolled over, it sends a `resync` directive and the client refetches the query baseline through TanStack Query. WebSocket frames use the same `ChangeEvent` envelope plus a `kind` discriminator (`change` | `presence` | `awareness` | `ack`) so a single socket multiplexes data and collaboration.

## The subscription model

A subscription is a **live query**: the same `where`/`sort`/`depth` shape used everywhere else, plus a stream of deltas. You subscribe to a query, not to a raw channel — KernelCMS maps the query onto the right pub/sub channels and applies `where`-matching and access control per event so the client only sees rows that belong in its result set.

```ts
import { kernelClient } from '@kernel/client'

const sub = kernelClient.collections.posts.subscribe(
  { where: { status: { equals: 'published' }, author: { equals: userId } }, sort: '-publishedAt', depth: 1 },
  {
    onUpsert: (post) => store.upsert(post),
    onRemove: (id) => store.remove(id),
    onResync: () => queryClient.invalidateQueries(['posts']),
  },
)
// later
sub.unsubscribe()
```

In the admin, this is wired through TanStack Query so list and document views stay live without bespoke state. A `useLiveQuery` hook subscribes on mount, applies deltas to the cache, and unsubscribes on unmount:

```ts
// @kernel/admin
function useLiveQuery<T>(collection: string, query: Query) {
  const qc = useQueryClient()
  const result = useQuery({ queryKey: [collection, query], queryFn: () => kernelClient.find(collection, query) })
  useEffect(() => {
    const sub = kernelClient.subscribe(collection, query, {
      onUpsert: (doc) => qc.setQueryData([collection, query], applyUpsert(doc)),
      onRemove: (id) => qc.setQueryData([collection, query], applyRemove(id)),
      onResync: () => qc.invalidateQueries({ queryKey: [collection, query] }),
    })
    return () => sub.unsubscribe()
  }, [collection, JSON.stringify(query)])
  return result
}
```

For offline and live frontends, the same delta stream feeds **TanStack DB** reactive collections. A TanStack DB collection declares a sync source backed by the SSE subscription; reads are local and instant, writes are optimistic, and server deltas reconcile the collection. This is the path that lets a marketing site or a custom dashboard stay live with zero hand-rolled cache plumbing.

Configuration lives in `kernel.config.ts`, where realtime is opt-in per collection and globally tunable:

```ts
// kernel.config.ts
import { defineConfig } from '@kernel/core'
import { redisRealtime } from '@kernel/server/realtime'

export default defineConfig({
  realtime: {
    adapter: redisRealtime({ url: process.env.REDIS_URL }),
    transports: ['sse', 'ws'],
    // event payload policy: 'full' streams docs, 'id' streams ids (client refetches)
    payload: 'id',
    resumeBufferSize: 500,
    heartbeatMs: 15_000,
  },
  collections: [
    {
      slug: 'posts',
      realtime: { enabled: true, presence: true, collaboration: true },
      fields: [
        /* ... */
      ],
    },
    { slug: 'audit-logs', realtime: { enabled: false } }, // never streamed
  ],
})
```

Access control is the non-negotiable part. Every event is filtered through the collection's `read` access function and field-level access for the subscribing user **at fan-out time**, not at subscribe time — a permission change mid-stream is honored immediately. If a field is hidden from a user, it is stripped from the streamed `doc` exactly as it would be on a REST read. See [Access Control](../06-auth-security/01-authorization-and-access-control.md) and the Query Language for the shared semantics.

## Presence and collaboration hooks

Presence answers "who else is here" and collaboration answers "what are they doing." Both ride the WebSocket transport and use the optional `PresenceBackend`. KernelCMS does not embed a full OT/CRDT engine in core — it provides the awareness channel and document locking, and exposes hooks so a Yjs or Automerge integration can plug in for character-level co-editing. This is the same pragmatic line Sanity draws (presence + patches, pluggable conflict resolution) and is deliberately more than Payload, which has no presence concept at all.

```ts
// @kernel/admin
const { peers, self, setAwareness } = usePresence({ collection: 'posts', id: postId })
// peers: { userId, name, color, cursor, fieldPath, lastSeen }[]
setAwareness({ fieldPath: 'title', cursor: { anchor: 4, head: 9 } })
```

Three collaboration primitives ship in core:

- **Awareness** — ephemeral, lossy cursor/selection/field-focus broadcast. Never persisted; dropped on disconnect with a grace TTL.
- **Soft locks** — advisory per-document or per-field locks surfaced in the UI ("Saga is editing the body"). A lock is a presence record with a `lock` flag and a heartbeat; it auto-releases when the heartbeat lapses.
- **Patch broadcast** — TanStack Form field patches are broadcast so peers see live changes; merge strategy (last-write-wins vs CRDT) is configurable via the `collaboration.merge` hook.

```ts
// kernel.config.ts (per collection)
realtime: {
  collaboration: {
    merge: 'lww',                 // or a custom CRDT adapter
    lock: { scope: 'field', ttlMs: 30_000 },
    awareness: { graceMs: 5_000 },
  },
}
```

Autosave and version history integrate directly: each autosave emits a `draft` change event, so collaborators see version bumps live, and the [Versions & Drafts](../02-data-modeling/10-versioning-drafts-and-autosave.md) timeline updates without a refetch.

## Scaling realtime

Realtime fan-out is the part that breaks under load, so the design is explicit about it.

**Horizontal fan-out.** With more than one node, you need a shared pub/sub or every client only sees writes from the node it's connected to. The `RealtimeAdapter` abstracts this: `redisRealtime` (Redis pub/sub), `natsRealtime` (NATS/JetStream for at-least-once with replay), and `pgRealtime` (Postgres `LISTEN/NOTIFY`, zero new infra for small SQL deploys). Pick based on scale, not dogma.

```
            ┌── node A ──┐     ┌── node B ──┐     ┌── node C ──┐
clients ────┤  SSE/WS    │     │  SSE/WS    │     │  SSE/WS    │
            └─────┬──────┘     └─────┬──────┘     └─────┬──────┘
                  └──────────────────┼──────────────────┘
                              shared pub/sub (Redis / NATS / PG)
```

**Connection placement.** SSE needs no sticky sessions — any node can serve any subscriber because fan-out is global. WebSockets carry per-socket presence state, so route them with a consistent hash on `documentId` (presence for one doc lands on one node) or replicate awareness through the same pub/sub bus. The hash approach keeps awareness chatter local and is the default in KernelCMS Cloud.

**Backpressure and limits.** Each subscriber has a bounded outbound queue; slow consumers are coalesced (multiple updates to the same `id` collapse to the latest) and, past a watermark, dropped to a `resync` directive rather than blowing memory. Per-connection and per-user subscription caps, plus message-rate limits, are enforced at the host and reuse the same rate-limit config as the REST/RPC surfaces.

| Concern             | Mechanism                         | Default           |
| ------------------- | --------------------------------- | ----------------- |
| Slow consumer       | Per-id coalescing + bounded queue | 1k events / conn  |
| Queue overflow      | Emit `resync`, drop buffer        | watermark 80%     |
| Connection cap      | Per-user / per-IP limit           | 50 / user         |
| Liveness            | Heartbeat ping/comment            | 15s               |
| Cross-node delivery | Shared pub/sub adapter            | required > 1 node |

**Cloud vs self-host.** Self-hosting realtime is fully supported — pick `pgRealtime` for one Postgres-backed box, graduate to Redis or NATS as you scale, and front WebSockets with a sticky or hashed load balancer. KernelCMS Cloud runs a managed multi-region fan-out tier with global edge SSE termination and replicated presence, so live preview and collaboration work across regions without you operating the bus. Because the adapter contract is identical in both, a subscription written against self-host behaves identically on Cloud — no lock-in, per the project's portability tenet.

## Open questions

- **CRDT in core vs plugin.** Whether to ship a default Yjs binding in `@kernel/admin` or keep all character-level merge logic behind the `collaboration.merge` hook and a separate `@kernel/plugin-*` package.
- **GraphQL subscriptions.** Whether to expose a spec-compliant `graphql-ws` subscription surface in `@kernel/graphql` in addition to the native live-query API, or treat GraphQL as read/write-only and steer realtime through RPC.
- **Exactly-once semantics.** SSE + `Last-Event-ID` gives at-least-once with client-side dedupe by event id; whether any workflow needs stronger guarantees (and therefore JetStream-only deploys) is unresolved.
- **Presence durability.** Whether soft locks should survive a brief node restart via the pub/sub bus, or always be treated as ephemeral and rebuilt from reconnecting clients.
