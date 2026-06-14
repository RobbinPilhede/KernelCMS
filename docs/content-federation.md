# Content federation

**Federation** moves content **between environments**. You export a collection's documents
as a portable, deterministic **bundle**, carry it to another instance, and **sync** it in by
id — create-or-update, with a dry-run diff first. Instead of re-keying a staging launch into
production by hand (and praying the ids line up), you export exactly what you can read, look
at precisely what would change, and apply it through the normal access-checked pipeline. The
use case: promote content from staging to production, or keep two instances in sync.

> **Scope — be honest.** This is a **deterministic upsert-by-id sync with a diff**, not
> real-time replication. A sync applies the field data you exported into the target —
> create-or-update keyed on the id, **last-write-wins per field** on an update. There is no
> live stream, no conflict resolution, and no delete propagation: it syncs the documents in
> the bundle and leaves everything else alone.

## Opt in

Federation is off until you enable it. Set `federation: true` on the config; that unlocks the
export/sync ops and the admin REST routes below.

```ts
export default defineConfig({
  federation: true, // unlocks exportContent / syncContent + the admin routes
  collections: [/* … */],
})
```

## Export a bundle

`exportContent` reads a collection's documents and returns a **portable, deterministic
bundle**. The export is **access-checked** — only documents the caller can **read** are
included — and **sorted by id**, so the same inputs always produce byte-identical output.

```ts
const bundle = await kernel.exportContent({
  collection: 'posts',
  // optional narrowing:
  where: { status: { equals: 'live' } }, // a normal query filter
  ids: ['post_a', 'post_b'],             // …or an explicit id set
  draft: true,                           // export draft values (drafts collections)
})
// -> ContentBundle
// {
//   version: 1,
//   documents: [
//     { collection: 'posts', id: 'post_a', data: { /* stored field values (+ _status) */ } },
//     { collection: 'posts', id: 'post_b', data: { /* … */ } },
//   ],
// }
```

Each entry's `data` is the collection's **stored field values** — plus `_status` for
drafts-enabled collections — so both **identity (the id)** and **publish state round-trip**
when you sync the bundle into another environment. The bundle is plain JSON: write it to a
file, commit it, or POST it straight at the target's sync route.

## Sync into another environment

`syncContent` applies a bundle into the current instance, **keyed on the id**. For each
document it **creates** it (preserving the id) if it's missing, **updates** it if a field
differs, and **leaves it unchanged** if it's already identical.

```ts
const result = await kernel.syncContent({ bundle })
// -> {
//   created:   [{ collection, id }, …],
//   updated:   [{ collection, id }, …],
//   unchanged: [{ collection, id }, …],
//   failed:    [{ collection, id, reason }, …],
//   plan:      [{ collection, id, action: 'create' | 'update' | 'unchanged' }, …],
//   dryRun:    false,
// }
```

Every create and update goes through the **normal, access-checked pipeline** — the same
`create` / `update` ops a direct edit takes — so **access, validation, and the publish gate
all apply to every applied document**. A sync can't bypass them: a document that fails (no
access, a validation error, a publish it isn't allowed to make) lands in `failed[]` with its
reason while the rest still apply. The `plan` lists the decided action per document, and
`created` / `updated` / `unchanged` / `failed` partition the outcome. **Re-syncing the same
bundle is idempotent** — the second run reports every document `unchanged` and writes nothing.

> To preserve identity across environments, `kernel.create` now accepts an optional `id`.
> Sync uses it under the hood to recreate a missing document with its original id; a
> **duplicate id is a conflict** (the existing document wins and the apply lands in
> `failed[]`, never a silent overwrite). You can pass `id` to `create` directly for your own
> imports.

## Preview with a dry run

Pass `dryRun: true` to compute the plan **without writing anything**. You get the same
`created` / `updated` / `unchanged` / `failed` partition and `plan` you'd get from a real
sync — the diff — so you can review exactly what an apply would do before you commit.

```ts
const preview = await kernel.syncContent({ bundle, dryRun: true })
// -> { created, updated, unchanged, failed, plan, dryRun: true } — nothing was written

if (preview.created.length || preview.updated.length) {
  await kernel.syncContent({ bundle }) // commit it for real
}
```

A `dryRun` still runs the access checks, so it won't promise a write the real apply couldn't
make — what the dry run shows as appliable is what will apply.

## The REST surface

Both federation routes are **admin-only**:

```http
GET    /api/_admin/federation/export?collection=&ids=&draft=   # -> ContentBundle
POST   /api/_admin/federation/sync                             # { bundle, dryRun? }
```

```bash
# export 'posts' from the source (staging), saving the bundle to a file
curl "http://staging.example.com/api/_admin/federation/export?collection=posts&draft=true" \
  -H "Authorization: Bearer $STAGING_TOKEN" > bundle.json

# dry-run the sync into the target (production) — see the diff, write nothing
curl -X POST "http://prod.example.com/api/_admin/federation/sync" \
  -H "Authorization: Bearer $PROD_TOKEN" \
  -d "{\"bundle\": $(cat bundle.json), \"dryRun\": true}"

# happy with the plan? apply it for real
curl -X POST "http://prod.example.com/api/_admin/federation/sync" \
  -H "Authorization: Bearer $PROD_TOKEN" \
  -d "{\"bundle\": $(cat bundle.json)}"
```

## The guarantees

Federation is a deterministic, access-checked transfer — there is no second, looser write
path through a sync than through the collection it lands in.

- **Stable-id round-trip.** Export from A and sync into B and the documents keep the **same
  ids** — identity is part of the bundle, and `create` preserves it. Publish state
  round-trips too via `_status`.
- **Access-checked export.** `exportContent` only includes documents the caller can **read**;
  you can never export what you can't see.
- **Access-checked, validated, publish-gated sync.** Every create/update is replayed through
  the normal pipeline, so **a sync can't elevate** — access, validation, and the publish gate
  apply to each applied document, and anything that fails lands in `failed[]` rather than
  being forced through.
- **Dry-run diff first.** `dryRun: true` returns the full plan without writing, so you review
  exactly what would change before you commit.
- **Idempotent.** Re-syncing the same bundle writes nothing — every document comes back
  `unchanged`.
- **Admin-only over REST.** Both `/export` and `/sync` are admin-gated.
- **Deterministic.** Bundles are sorted by id; the same inputs produce byte-identical output.

Red-teamed to **Risk LOW**. Federation pairs naturally with
[content branches](content-branches.md) and [content releases](releases.md) for staging a
change set before it ships, and with the
[draft/publish lifecycle](conventions.md#drafts-publish-and-the-default-read-view) for moving
publish state between environments.
