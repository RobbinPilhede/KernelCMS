# Content releases

A **release** is a named bundle of draft documents that publish **together**, in one
atomic step — optionally on a schedule. Instead of publishing a coordinated launch one
document at a time (and risking a half-shipped state where the new landing page is live
but two of its posts are not), you gather the changes into a release, preview the whole
bundle as it will read, and ship it as a single unit with an all-or-nothing safety net.

Releases are the practical heart of *content environments*: coordinate a launch or a
campaign, then publish it atomically.

## Opt in

Releases are off until you enable them. Set `releases: true` on the config; that
provisions two system tables — `_releases` and `_release_items` — and unlocks the ops
below.

```ts
export default defineConfig({
  releases: true, // provisions _releases + _release_items
  collections: [
    // members must be real, non-system, drafts-enabled collection documents
    { slug: 'posts', versions: { drafts: true }, fields: [/* … */] },
    { slug: 'pages', versions: { drafts: true }, fields: [/* … */] },
  ],
})
```

A release member must be a **real, non-system, drafts-enabled collection document**. You
cannot add a system collection, a collection without `drafts`, or a document that does
not exist.

## The lifecycle

Open a release, add the draft documents that belong to it, preview the bundle, then
publish it now or schedule it for later.

```ts
// 1. open a release — status: 'open', editable
const release = await kernel.createRelease({ name: 'Spring launch' })

// 2. add draft members (access-checked — see the guarantees below)
await kernel.addToRelease({ release: release.id, collection: 'posts', id: postId })
await kernel.addToRelease({ release: release.id, collection: 'pages', id: pageId })

// …remove one again while the release is still open
await kernel.removeFromRelease({ release: release.id, collection: 'pages', id: pageId })

// 3. preview the whole bundle in its current draft state
const { docs } = await kernel.previewRelease({ release: release.id })

// 4. publish every member together, atomically
const result = await kernel.publishRelease({ release: release.id })
// → { status: 'published' | 'failed', published: [...], failed: [...] }
```

`previewRelease` returns the member documents in their **current draft state**, each
loaded through the access-checked read path. A member the caller cannot read is dropped
from the preview rather than leaked — so the preview is exactly what *this* caller would
see go live.

## The operations

All ops are on the Local API (`kernel`):

| Op | Effect |
| -- | ------ |
| `createRelease({ name })` | Open a new release (`status: 'open'`). |
| `addToRelease({ release, collection, id })` | Add a draft member (access-checked). |
| `removeFromRelease({ release, collection, id })` | Remove a member (open releases only). |
| `listReleases({ status? })` | List releases; `status?` filters `open` / `scheduled` / `published` / `failed`. |
| `getRelease({ release })` | The release plus its items. |
| `previewRelease({ release })` | Member docs in current draft state, access-checked. |
| `publishRelease({ release })` | Publish all members atomically → `{ status, published, failed }`. |
| `scheduleRelease({ release, at })` | Publish the bundle at a future instant. |
| `cancelRelease({ release })` | Cancel a scheduled release. |
| `processScheduledReleases()` | Drain due scheduled releases (call from a cron). |

## The state machine

A release moves through a small, explicit set of states. **Only an `open` release is
editable**; once published it is immutable.

```text
open  ──publishRelease──▶ published      (all members live, publishedAt set)
  │
  ├──scheduleRelease──▶ scheduled ──drain──▶ published
  │
  └──(a member fails mid-publish)──▶ failed
```

- **`open`** — editable. Add and remove members freely.
- **`published`** — every member is live, `publishedAt` is set, and the release is
  **immutable**.
- **`scheduled`** — awaiting the cron drain; flips to `published` when due.
- **`failed`** — a member errored partway through publishing (see the next section).

## All-or-nothing pre-flight

`publishRelease` does not publish member-by-member and hope. It first **dry-runs the
publish gate for every member**:

- the per-document **publish access** check,
- the **agent draft-only brake**, and
- the blocking **eval / content-CI gate** against each member's *current* draft content.

If **any** member would fail, it publishes **none**. The call returns
`{ status: 'failed', failed: [...] }` with the reasons, and the release **stays `open`**
so you can fix and retry — there is no partial go-live. Only when *all* members pass does
it publish each one through the normal `publish` op.

> **Best-effort atomic, not a transaction.** The pre-flight is a full dry-run, so the
> common failures are caught before anything goes live. A fault that only surfaces
> *mid-publish* (after the dry-run passed) leaves the release in `failed` with whatever
> published so far recorded — it is not rolled back. Treat `failed` as "inspect and
> re-run", not "nothing happened".

## Scheduling (the cron drain)

Instead of publishing now, schedule the whole bundle for a future instant. The release
moves to `scheduled`, and a cron drains it when due. Call `processScheduledReleases()`
**alongside** `processScheduledPublishes()` — they share the same cron-driven model.

```ts
await kernel.scheduleRelease({ release: release.id, at: '2026-07-01T09:00:00Z' })

// change your mind before it fires — back to 'open'
await kernel.cancelRelease({ release: release.id })
```

```bash
# a cron that drains due scheduled releases and per-document publishes
* * * * * cd /app && node -e "const k=require('./run'); \
  k.processScheduledPublishes(); k.processScheduledReleases()"
```

A scheduled release is **gate-checked at schedule time** — the same model as a scheduled
per-document publish — and the drain **re-checks the eval gate** against the then-current
draft content before it goes live. A member that has since regressed (or whose author
lost publish access) is caught at drain, not silently shipped.

## The REST surface

Every release route is **admin/editor-gated**:

```http
GET    /api/_admin/releases                                   # list (status filter)
POST   /api/_admin/releases                                   # create { name }
GET    /api/_admin/releases/:id                               # the release + items
DELETE /api/_admin/releases/:id                               # delete a release
POST   /api/_admin/releases/:id/items                         # add { collection, id }
DELETE /api/_admin/releases/:id/items/:collection/:docId      # remove a member
GET    /api/_admin/releases/:id/preview                       # the bundle, current draft state
POST   /api/_admin/releases/:id/publish                       # publish atomically
POST   /api/_admin/releases/:id/schedule                      # schedule { at }
```

## The guarantees

Publishing a release is held to **exactly the same bar as a direct publish** — there is
no second, looser code path for going live in bulk.

- **Per-document publish gate.** Each member is published through the normal `publish`
  op, so the collection's `access.publish` rule applies to every member. A caller can
  only publish a release whose every member they could publish directly.
- **Agents can never publish a release.** The agent draft-only brake holds at the bundle
  level too — an AI agent principal can curate a release (add/remove members) but cannot
  make it live.
- **Member management is access-checked.** You cannot pull a document you can't read into
  a release, and the preview drops members you can't read.
- **Eval gates still apply.** The blocking content-CI eval runs in the pre-flight and
  again on the scheduled drain — a member that fails its evals blocks the whole release.
- **Scheduled releases are gate-checked at schedule time** and re-checked at drain.

Red-teamed to **Risk LOW**. Releases pair naturally with the
[draft/publish lifecycle](conventions.md#drafts-publish-and-the-default-read-view) and
the [content time-machine](time-machine.md).
