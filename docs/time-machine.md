# Content time-machine

Every collection with `versions` enabled already keeps a snapshot of each write.
The time-machine turns that history into a queryable surface: read a document (or a
whole list) as it existed at any past instant, walk its complete change timeline,
diff any two points field-by-field, and revert to an earlier state in one call.
Think *git for content* — built on the version history KernelCMS already has, with
no extra storage and no second access path.

Everything here requires `versions` on the collection:

```ts
{ slug: 'posts', versions: true }                 // history only
{ slug: 'posts', versions: { drafts: true } }     // + draft/publish lifecycle
```

A point-in-time read or restore on a collection **without** `versions` raises a
`BadRequestError` — there is no history to reconstruct from.

## Point-in-time reads (`asOf`)

Pass `asOf` (an ISO-8601 timestamp) to `findByID` or `find` and the engine
reconstructs the document(s) from history: it takes the latest snapshot whose
`createdAt` is `<= asOf` and returns that content. Omit `asOf` and you get the
current document — the default behaviour is unchanged.

```ts
// a single document, as it stood last New Year's Eve
const post = await kernel.findByID({
  collection: 'posts',
  id,
  asOf: '2025-12-31T23:59:59Z',
})

// null when the document did not exist yet at that instant
const before = await kernel.findByID({ collection: 'posts', id, asOf: '2020-01-01T00:00:00Z' })
// → null
```

`asOf` works on list reads too, alongside the usual `where`, `limit`, and `page`.
Each matching document is reconstructed to its `asOf` state, and a document that did
not exist yet simply does not appear:

```ts
const { docs } = await kernel.find({
  collection: 'posts',
  asOf: '2026-01-15T00:00:00Z',
  where: { author: { equals: authorId } },
  limit: 20,
})
```

## The history timeline (`history`)

`history` returns the full change timeline for one document, oldest → newest:

```ts
const timeline = await kernel.history({ collection: 'posts', id })
// Array<{
//   versionId, at, by, byType, status, autosave, changedFields
// }>
```

Each entry is one snapshot:

- **`versionId`** — the snapshot id (use it as a `from`/`to` in a diff).
- **`at`** — when the snapshot was written.
- **`by`** / **`byType`** — who authored it (`user` or `agent`), so "show me what the
  agent changed" is a filter over the timeline.
- **`status`** — the `_status` at that point (`draft` / `published`) on a
  drafts-enabled collection.
- **`autosave`** — whether the save was an autosave.
- **`changedFields`** — the fields that differ from the *previous* snapshot. On the
  first (create) snapshot, every field counts as changed.

## Field-level diffs (`diffVersions`)

`diffVersions` compares two points and returns only the fields that changed, each as
a `{ from, to }` pair:

```ts
const diff = await kernel.diffVersions({
  collection: 'posts',
  id,
  from: timeline[0].versionId,
  to: timeline[2].versionId,
})
// → { title: { from: 'Draft', to: 'Hello world' }, body: { from: …, to: … } }
```

`from` and `to` are independent: each may be a **versionId** *or* an **ISO
timestamp**. A timestamp resolves to the snapshot at-or-before it (the same rule as
`asOf`), so you can diff two version ids, two instants, or one of each:

```ts
// "what changed between last Monday and now"
const diff = await kernel.diffVersions({
  collection: 'posts',
  id,
  from: '2026-06-08T00:00:00Z',
  to: '2026-06-13T00:00:00Z',
})
```

## Restore as-of (`restoreAsOf`)

`restoreAsOf` reverts a document to its state at a past instant — by writing that
historical content back through the **normal update path**:

```ts
await kernel.restoreAsOf({
  collection: 'posts',
  id,
  asOf: '2026-06-01T00:00:00Z',
})
```

The guardrails are the point, and they all follow from "it's a normal update":

- **Content fields only.** `_status` and system columns are excluded from the
  restored payload, so a restore writes *content* — it can never flip a draft to
  published. A restore is not a publish.
- **No access bypass.** It runs through the validated update path with no
  `overrideAccess`, so the caller's update access (and field-level access, and
  validation) all apply exactly as on any other write.
- **The agent draft-only brake still holds.** An [AI agent](agentic-workflows.md)
  can restore content but, like any other write, cannot use a restore to publish.
- **It records a new version.** The revert is itself a snapshot at the head of the
  timeline — you can always restore *forward* again. History is append-only.

## The REST surface

Every operation has an HTTP equivalent. Reads take `asOf` as a query parameter; the
restore route is gated exactly like a normal update:

```http
GET  /api/:collection/:id?asOf=<iso>          # one document, as of an instant
GET  /api/:collection?asOf=<iso>              # point-in-time list
GET  /api/:collection/:id/history             # the change timeline
GET  /api/:collection/:id/diff?from=&to=      # field-level diff (versionId or iso)
POST /api/:collection/:id/restore-as-of?asOf= # revert (gated like an update)
```

```bash
curl "http://localhost:3000/api/posts/$ID?asOf=2025-12-31T23:59:59Z"
curl "http://localhost:3000/api/posts/$ID/history"
curl "http://localhost:3000/api/posts/$ID/diff?from=2026-06-08T00:00:00Z&to=2026-06-13T00:00:00Z"
curl -X POST "http://localhost:3000/api/posts/$ID/restore-as-of?asOf=2026-06-01T00:00:00Z"
```

## The security property: history reads exactly like the present

Time-travel is **not** a way around access control. Every historical read, diff, and
timeline runs through the *same* access read-check and field stripping as a live read,
evaluated against the caller's **current** access — there is no traveling back to a
moment when access was wider:

- A caller who cannot read the document **now** cannot read its `asOf` state, its
  `history`, or any `diff` of it. Revoked access stays revoked for the past too.
- A field the caller cannot read never appears in an `asOf` document, never shows up
  in a snapshot's `changedFields`, and never appears in a `diff`.
- Historical **draft** states are hidden unless you pass `draft: true` — the same
  rule as a live read on a drafts-enabled collection.
- `restoreAsOf` writes through the normal validated update with no `overrideAccess`,
  so it can never write content the caller couldn't write directly.

The net effect: the time-machine is a view *into* the same access-checked content
engine, never a side door around it.
</content>
</invoke>
