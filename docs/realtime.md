# Real-time change feed

KernelCMS can emit a change event for every content write onto a durable,
access-filtered feed. One source backs two shapes: a **pull feed** you poll with a
cursor (CDC), and a **live push stream** over Server-Sent Events (reactive UIs). The
same events are also delivered **in-process** for server code, workflows, and live
re-indexing.

It is **off by default**. Nothing emits, nothing is retained, and the endpoints 404
until you opt in.

## Push vs. pull — one feed, two shapes

- **Pull (CDC).** A durable outbox of recent changes. You ask "what changed since
  cursor *N*?", process the batch, and remember the returned cursor. Survives
  restarts and disconnects, because the outbox is the source of truth — ideal for a
  CDC pipeline, a downstream sync, or a worker that may be offline for a while.
- **Push (SSE).** A long-lived `text/event-stream` connection that emits each change
  as it happens. Lowest latency, no polling — ideal for a UI that should update live.
  On reconnect it resumes from the last event id, so a brief drop doesn't lose events
  within retention.

Both carry the *same* `ChangeEvent`, and both run through the *same* access filter.
Pick pull when you want durability and batch control; pick push when you want
immediacy.

## Enable it

```ts
export default defineConfig({
  realtime: {
    enabled: true,   // default false — the whole feature is opt-in
    retain: 50000,   // max change rows kept in the outbox (default 10000, clamped)
  },
  collections: [/* … */],
})
```

`retain` bounds the `_changes` outbox: once it is full, the oldest rows are dropped
(a clamped maximum applies, so you can't ask for an unbounded outbox). Size it for
your slowest consumer's expected lag — a puller that asks for a `since` older than the
oldest retained row simply starts from the earliest row still kept.

## The event shape

Every change — over any surface — is the same metadata record:

```ts
type ChangeEvent = {
  seq: number          // monotonic sequence (per node); also the SSE event id
  at: string           // ISO timestamp of the change
  collection: string   // which collection changed
  documentId: string   // which document
  event: 'create' | 'update' | 'delete' | 'publish' | 'unpublish'
  principalType: 'user' | 'agent'  // who caused it
}
```

There is **no document body** on the event — only metadata describing *that* a
document changed. To act on the new content, re-fetch it through the normal
access-checked API (`kernel.findByID(...)` / `GET /api/<collection>/<id>`). This is
deliberate; see [the security property](#the-security-property).

## The pull feed (cursor polling)

`kernel.changes(...)` returns a batch plus the cursor to resume from:

```ts
let cursor = 0 // or a value you persisted from a previous run

for (;;) {
  const { changes, cursor: next } = await kernel.changes({
    since: cursor,         // exclusive: returns events with seq > since
    collection: 'posts',   // optional: filter to one collection
    limit: 100,            // optional: batch size
    req,                   // the request principal — access is enforced
  })
  for (const e of changes) await handle(e)
  cursor = next            // persist this; poll again with since: cursor
}
```

Persist `cursor` between runs and a restarted consumer picks up exactly where it left
off. Over HTTP the same feed is a single authenticated GET:

```bash
curl "http://localhost:3000/api/changes?since=0&collection=posts&limit=100"
```

```json
{
  "changes": [
    { "seq": 41, "at": "2026-06-13T10:00:01Z", "collection": "posts",
      "documentId": "p_07", "event": "create", "principalType": "user" }
  ],
  "cursor": 41
}
```

Auth is required on the REST endpoint — there is no anonymous change feed.

## The live SSE stream

`GET /api/changes/stream` upgrades to `text/event-stream` and emits one frame per
change as it happens, plus `: ping` comment lines as heartbeats to keep the
connection (and any intermediary proxy) alive:

```
id: 41
data: {"seq":41,"at":"2026-06-13T10:00:01Z","collection":"posts","documentId":"p_07","event":"create","principalType":"user"}

: ping
```

The browser `EventSource` API consumes it directly:

```ts
const es = new EventSource('/api/changes/stream?collection=posts', {
  withCredentials: true, // send the session cookie — the stream requires auth
})

es.onmessage = (msg) => {
  const e = JSON.parse(msg.data) // a ChangeEvent (metadata only)
  if (e.event !== 'delete') refetch(e.collection, e.documentId)
}
```

### Resuming with `Last-Event-ID`

Because each frame carries `id: <seq>`, the stream is resumable. `EventSource`
reconnects automatically and sends the last id it saw as the `Last-Event-ID` request
header; the server replays the changes after that `seq` (within retention) before
continuing live, so a brief network drop doesn't lose events. A non-browser client can
set the header itself:

```bash
curl -N -H "Last-Event-ID: 41" "http://localhost:3000/api/changes/stream?collection=posts"
```

## In-process subscribe

For server code that lives in the same process — a workflow step, a live search
re-indexer, a cache invalidator — subscribe directly. No HTTP, no serialization:

```ts
const unsubscribe = kernel.subscribe((e) => {
  if (e.collection === 'posts') reindex(e.documentId)
})

// when you're done (shutdown, teardown):
unsubscribe()
```

`kernel.subscribe(fn)` returns an **unsubscribe function** — call it to stop
receiving events. The callback gets the same access-filtered `ChangeEvent`.

## The security property

This is the part that makes the feed safe to expose. Two guarantees, both enforced by
the engine:

1. **Metadata only.** An event never carries the document body — only that a document
   in a collection changed, and how. A subscriber learns *that* something changed, not
   *what* it now says. To read content, the client re-fetches through the normal
   access-checked read path, which strips fields the caller may not see.
2. **Access-filtered per subscriber, fail-closed.** Before an event reaches a
   subscriber, KernelCMS checks that subscriber's read access for that document. If
   they cannot read it, the event is **dropped entirely** — they are never even told
   it changed. The filter fails closed: when access can't be confirmed, the event is
   withheld, not leaked.

> For a `delete` (the document is already gone) and for row-scoped reads where access
> depends on the row's data, the filter can't re-check the specific document, so it
> requires a **fully-public read rule** on the collection before it will deliver the
> event. Anything narrower fails closed and the event is dropped — a subscriber never
> learns that a document they couldn't read was deleted.

Both HTTP endpoints require authentication, retention and concurrent-connection counts
are bounded, and a failure to write to the feed **never** breaks the content write —
the change is committed first; the outbox is best-effort on top.

## Honest notes

- **Publish currently reads as `update`.** The feed is driven by `afterChange`, whose
  arguments don't carry the document's prior `_status`. So while the `event` type
  includes `'publish'` / `'unpublish'`, a publish today surfaces as `update`. Treat
  `update` as "content moved" and re-fetch to read the current `_status`.
- **`seq` is per-node.** The sequence counter is local to a single node, which gives
  correct ordering for a single-node deployment. A multi-node deployment needs a
  shared sequence source for a global order — until then, run the feed from one node.

## Where it fits

Real-time pairs with the rest of the engine:

- **[Agentic workflows](agentic-workflows.md)** — react to a change (an agent that
  acts when a `brief` is created, a moderation pass on every new `comment`).
- **Search** — keep a full-text or vector index live by re-indexing on each event.
- **CDC** — stream content changes into a downstream system that stays in sync without
  a polling job that re-scans everything.

Everything stays on the **same access-checked engine** — the feed is a view into it,
never a side channel around it.
