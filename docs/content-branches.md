# Content branches

A **branch** is a named workspace where you prepare a set of changes **off to the side** —
staged, previewed, and diffed — and then **merge** them into the live content in one move,
or throw them away. Instead of editing live documents in place and hoping the set hangs
together (a half-finished rename here, a price you meant to revert there), you stage every
edit on a branch, look at exactly what would change, and only then replay it onto the live
docs through the normal access-checked update.

Branches are *git-for-content* at the editing layer: a copy-on-write overlay over the live
documents. The live read/write path is never touched while you work — staged edits live in
a separate overlay — so a branch is a safe place to build up a change set before it counts.

> **Scope — be honest.** This is **field-level staged overlays plus a replayed merge**, not
> full git-style three-way merge with conflict resolution. A merge applies the branch's
> staged fields *over the current live document*; there is no common-ancestor reconciliation.

## Opt in

Branches are off until you enable them. Set `branches: true` on the config; that provisions
two system tables — `_branches` and `_branch_docs` — and unlocks the ops below.

```ts
export default defineConfig({
  branches: true, // provisions _branches + _branch_docs (the copy-on-write overlay)
  collections: [/* … */],
})
```

`_branches` and `_branch_docs` are system tables: like every system table they are **not**
reachable through generic CRUD (`find`/`create` on them is rejected). The overlay is only
ever touched through the dedicated, reviewer-gated operations below.

## Stage edits on a branch

Open a branch, then stage field edits against the documents you want to change. Staging is
**copy-on-write**: the edit is recorded on the branch's overlay and the **live document is
never touched**.

```ts
// 1. open a branch — status: 'open'
const branch = await kernel.createBranch({ name: 'autumn-pricing' })
// -> { id, name, status: 'open' | 'merged' | 'discarded', … }

// 2. stage field edits on the branch (the live doc is unchanged)
await kernel.stageChange({
  branch: branch.name,
  collection: 'products',
  id: productId,
  data: { price: 1900, badge: 'sale' },
})

// re-staging the same doc deep-merges onto what's already staged
await kernel.stageChange({
  branch: branch.name,
  collection: 'products',
  id: productId,
  data: { badge: 'clearance' }, // price: 1900 is retained, badge is overwritten
})

// list branches, optionally filtered by status
const open = await kernel.listBranches({ status: 'open' })
```

`stageChange` **requires update access to the target document** — you can only stage an edit
you could make directly. It does not write the live doc; it records the fields on the
branch's overlay, and re-staging the same document **deep-merges** the new fields onto the
already-staged ones.

## Preview & diff

Preview shows the live document with the branch's staged overlay applied — what the doc
*would* read like if the branch merged — and the diff lists everything the branch would
change.

```ts
// the live (access-checked) doc with this branch's staged fields applied on top
const preview = await kernel.previewBranch({
  branch: branch.name, collection: 'products', id: productId,
})

// everything the branch would change, across every staged document
const changes = await kernel.diffBranch({ branch: branch.name })
// -> [{ collection, documentId, fields }, …]
```

`previewBranch` loads the live document through the **access-checked read path** and applies
the staged overlay on top — a caller who can't read the document can't preview it, exactly as
with a plain read. `diffBranch` returns one entry per staged document with the `fields` the
branch would set, so you can review the whole change set before it touches anything.

## Merge or discard

When the branch is ready, **merge** it: each staged change is replayed onto the live document
through the **normal, access-checked update**. Or **discard** it: the overlay is dropped and
nothing ever reaches the live docs.

```ts
// replay every staged change onto the live docs through the normal update
const result = await kernel.mergeBranch({ branch: branch.name })
// -> { merged: [...], failed: [...] }  — branch marked 'merged', overlay dropped

// …or throw the whole change set away
await kernel.discardBranch({ branch: branch.name })
// overlay dropped, branch marked 'discarded'
```

`mergeBranch` does **not** write fields straight into the database. It replays each staged
change through the same `update` op a direct edit takes — so the **publish gate, field-level
access, and validation all apply to every merged change**. A change that fails (lost access,
a validation error, a field the caller can no longer write) lands in `failed[]` with its
reason; the rest still merge. When merge finishes the branch is marked `merged` and the
overlay is dropped. `discardBranch` simply drops the overlay and marks the branch
`discarded` — the live documents are left exactly as they were.

### All-or-nothing merge (opt-in)

By default a merge applies each staged change independently — the good ones land, failures
collect in `failed[]`. Pass `atomic: true` to run the **whole merge in one database
transaction** instead: if any change fails, every change already applied **rolls back**, the
overlay is left intact, and the branch stays `open` so you can fix the offending change and
retry.

```ts
// default: partial merge
await kernel.mergeBranch({ branch: branch.name })

// atomic: the whole branch merges together, or nothing does (branch stays open)
await kernel.mergeBranch({ branch: branch.name, atomic: true })
```

(Atomic merge falls back to the per-change apply on a database adapter without transaction
support; the bundled SQLite and Postgres adapters both support transactions.)

## The REST surface

Every branch route is **reviewer-gated** (admin/editor):

```http
GET    /api/_admin/branches                                # list (status filter)
POST   /api/_admin/branches                                # create { name }
GET    /api/_admin/branches/:name/diff                     # the change set
GET    /api/_admin/branches/:name/preview?collection=&id=  # live doc + staged overlay
POST   /api/_admin/branches/:name/stage                    # stage { collection, id, data }
POST   /api/_admin/branches/:name/merge                    # merge (replays through update)
POST   /api/_admin/branches/:name/discard                  # discard the overlay
```

```bash
# open a branch
curl -X POST "http://localhost:3000/api/_admin/branches" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"autumn-pricing"}'

# stage a field edit on it (the live doc stays untouched)
curl -X POST "http://localhost:3000/api/_admin/branches/autumn-pricing/stage" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"collection":"products","id":"<id>","data":{"price":1900,"badge":"sale"}}'

# review what it would change, then merge it (replayed through the access-checked update)
curl "http://localhost:3000/api/_admin/branches/autumn-pricing/diff" -H "Authorization: Bearer $TOKEN"
curl -X POST "http://localhost:3000/api/_admin/branches/autumn-pricing/merge" -H "Authorization: Bearer $TOKEN"
```

## The guarantees

A branch is a staging overlay, not a back door — there is no second, looser write path through
a branch than through the collection it edits.

- **The live path is untouched.** Branch edits live entirely in a separate `_branches` +
  `_branch_docs` overlay. Staging, preview, and diff never read or write the live document's
  row — until you merge, the live content is exactly as it was.
- **Staging is access-checked.** `stageChange` requires **update access to the target
  document**; you can only stage an edit you could make directly. Re-staging deep-merges onto
  the already-staged fields.
- **Merge replays through the access-checked update.** Each staged change is applied through
  the normal `update` op, so a branch can **never bypass the publish gate, field-level access,
  or validation**. A change that no longer passes lands in `failed[]`; it is not forced
  through.
- **Preview reads like a live read.** `previewBranch` loads the live document through the
  access-checked read path before applying the overlay — a caller who can't read the document
  can't preview it.
- **Reviewer-gated management.** Creating, staging, previewing, diffing, merging, and
  discarding branches are all admin/editor-only.
- **System-table isolation.** `_branches` and `_branch_docs` are unreachable through generic
  CRUD — the overlay can only be touched through the dedicated ops.
- **Audited.** Branch create / merge / discard are recorded in the [audit log](conventions.md)
  when auditing is on.

Red-teamed to **Risk LOW**. Branches pair naturally with the
[draft/publish lifecycle](conventions.md#drafts-publish-and-the-default-read-view), the
[content time-machine](time-machine.md), and [content releases](releases.md).
