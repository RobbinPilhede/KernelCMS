# Versioning, Drafts & Autosave

KernelCMS treats every document as an append-only stream of versions, not a single mutable row. Drafts, autosave snapshots, scheduled publishes, and the live published state are all rows in one `_versions` table keyed by the parent document. This is the same model Payload uses, and it is deliberate: once you have an immutable version log, drafts, diffs, restore, and scheduling stop being separate features and become queries against the same data. This page specifies how that log behaves, how you opt collections into it, and how the admin and APIs surface it.

## Enabling versions

Versioning is per-collection and per-global, off by default so simple content types stay cheap. You opt in through the `versions` key in `kernel.config.ts`.

```ts
import { defineCollection } from '@kernel/core'

export const Posts = defineCollection({
  slug: 'posts',
  fields: [
    { name: 'title', type: 'text', required: true },
    { name: 'body', type: 'richText' },
    { name: 'publishedAt', type: 'date' },
  ],
  versions: {
    drafts: {
      autosave: { interval: 800 },     // ms of idle before a snapshot
      schedulePublish: true,
      validate: false,                  // skip required-field checks on drafts
    },
    maxPerDoc: 50,                       // prune oldest beyond this
  },
})
```

Three shapes are valid:

| `versions` value | Behavior |
| --- | --- |
| `false` / omitted | No version log. Saves mutate the row in place. |
| `true` | Version history on, but no draft/publish split — every save is immediately live, history is kept. |
| `{ drafts: {...} }` | Full draft/publish workflow plus history, autosave, and scheduling. |

The distinction between `true` and `{ drafts }` matters. Sanity always splits documents into a `drafts.` perspective and a published one; Strapi's Draft & Publish is a per-content-type toggle that gives you a two-state status but, until recent versions, no real history. KernelCMS lets you keep an audit trail (`versions: true`) without forcing editors through a publish step, which is the right default for internal tools and settings globals.

## Draft versus published

When `drafts` is enabled, a document has two logical states derived from the version log:

```
documents row (id, current pointers)
        │
        ├──► latestPublishedVersionId ──► version (status: published)
        └──► latestDraftVersionId     ──► version (status: draft) [optional]

_versions: [ v1 published ][ v2 draft ][ v3 draft (autosave) ] ...
```

The `documents` row holds the denormalized published snapshot for fast reads; the `_versions` table holds the full lineage. A draft is a version whose `status` is `draft` and that is newer than the latest published version. Publishing copies that draft's field values into the `documents` row and writes a new version with `status: published`.

Reads choose a state with the `draft` query parameter, which spans REST, GraphQL, and the Local/RPC API through the one shared query language:

```ts
import { getPayload } from '@kernel/server'

const kernel = await getPayload()

// Public read — published only (the default everywhere)
const live = await kernel.find({ collection: 'posts', where: { slug: { equals: 'launch' } } })

// Preview read — draft when present, else fall back to published
const preview = await kernel.find({
  collection: 'posts',
  draft: true,
  where: { slug: { equals: 'launch' } },
})
```

`draft: true` is gated by access control, evaluated server-side at the operation level (see [Access Control](../06-auth-security/01-authorization-and-access-control.md)). Anonymous REST/GraphQL callers cannot request drafts unless your `read` access function permits it for the requesting user. This is the wedge against accidental leaks: in Strapi the published/draft split is enforced in the controller layer, but custom endpoints routinely forget the filter. KernelCMS makes published-only the default return for every surface and requires an explicit, authorized opt-in to see drafts.

`_status` is exposed as a virtual field on every versioned document, so list views and `where` clauses can filter on it directly: `where: { _status: { equals: 'draft' } }`.

## Version history and diffs

Every save appends a version row. The shape stored per version:

| Column | Meaning |
| --- | --- |
| `id` | Version ID (ULID, monotonic) |
| `parent` | Document ID this version belongs to |
| `version` | Full field snapshot (JSON) at save time |
| `status` | `draft` \| `published` |
| `autosave` | `true` if written by the autosave loop |
| `createdAt` | Timestamp |
| `createdBy` | User ID from the request context |

Snapshots are full, not deltas. Storing complete field state per version trades disk for correctness and read speed — reconstructing a point-in-time document is a single row read, and diffs are computed on demand rather than replayed. Postgres/MySQL store `version` as `jsonb`; the MongoDB adapter stores it as a subdocument. With `maxPerDoc` set, autosave versions are pruned first (oldest, `autosave: true`), then non-autosave drafts, never the published lineage.

Diffs are computed by `@kernel/core`'s field-aware differ, which walks the collection's field config rather than doing a blind JSON compare. That means a `richText` change renders as a prose diff, a `relationship` change resolves both sides to their titles, and `array`/`blocks` changes report row insertions and moves instead of a wall of index churn.

```ts
const { from, to, changes } = await kernel.diffVersions({
  collection: 'posts',
  parent: postId,
  fromVersion: 'v_01J...A',   // older
  toVersion: 'v_01J...K',     // newer
})

for (const change of changes) {
  // change.path e.g. ['body'], ['blocks', 2, 'heading']
  // change.kind  'added' | 'removed' | 'modified'
  // change.field the resolved field config for rendering
}
```

The admin renders this in a side-by-side or inline view backed by TanStack Table for the version list and TanStack Virtual for long documents. Sanity's history view is timeline-based and excellent, but it is tied to the Content Lake; KernelCMS keeps the same field-level granularity while writing to whichever database adapter you chose, so the diff travels with your data when you move between self-host and KernelCMS Cloud.

## Autosave

Autosave is a debounced draft writer. TanStack Form holds the dirty document state in the editor; a TanStack Store subscription debounces by `interval` and fires a draft save through TanStack Query's mutation pipeline. The first edit after a published version creates a new draft version; subsequent autosaves within the same editing session **update that draft version in place** rather than appending a new row on every keystroke pause.

```
edit ─┐  idle 800ms   ┌─ autosave (draft v2 created)
      ├──────────────►│
edit ─┘               └─ autosave (draft v2 updated, not v3)
                         ...
manual Save Draft ─────► draft v2 finalized, new session boundary
```

This keeps the history readable. Without in-place coalescing, an hour of writing produces hundreds of near-identical rows; Payload solves this the same way, marking autosave versions distinctly and collapsing them. A new appended version is cut on explicit "Save Draft", on publish, or when the editing session changes (different user, or a configurable session timeout).

Validation is relaxed for autosave by design — `validate: false` (the default for drafts) lets a half-finished document persist even when `required` fields are empty. Full validation runs at publish. You can opt into async/cross-field validation on drafts by setting `versions.drafts.validate: true` when partial documents must still satisfy invariants.

Concurrency uses optimistic locking. Each autosave carries the version ID it read; if the draft moved underneath it, the mutation returns a `409` with the current draft, and the admin surfaces a non-destructive conflict banner rather than silently clobbering a co-editor's work. Real-time co-presence (cursors, live merge) is layered on top via `@kernel/admin` and TanStack DB where enabled — see [Live Preview & Collaboration](../04-admin-ui/10-live-preview-and-visual-editing.md).

## Scheduled publish

When `schedulePublish` is on, a draft can be assigned a future `publishAt`. The draft is stored normally; a row is written to a `_scheduled_publishes` queue with the version ID and timestamp. The configured queue adapter (`@kernel/queue`) drains due jobs and runs the same `publish` operation an editor would, so access control, hooks, and validation all execute identically.

```ts
await kernel.schedulePublish({
  collection: 'posts',
  id: postId,
  versionId: draftVersionId,
  publishAt: new Date('2026-06-01T09:00:00Z'),
})

// Cancel
await kernel.unschedulePublish({ collection: 'posts', id: postId })
```

The job runner is the queue adapter, not a CMS-internal `setTimeout`, which is what makes scheduling survive restarts and scale horizontally. On a single Node box the default in-process queue polls the table; on KernelCMS Cloud the managed queue handles it across tenants. Strapi gained scheduled publishing relatively late and ties it to its own job layer; KernelCMS routes it through the same swappable queue adapter you already chose for the rest of the system, so there is no second scheduler to operate.

Symmetric scheduled **unpublish** is supported via `unpublishAt`, which writes an `unpublish` job that reverts the `documents` row to no published version while preserving history.

## Restore a version

Restore never rewinds the log — it appends. Restoring version *N* reads its snapshot, runs it through `beforeChange` hooks, and writes a **new** version with those values, so the audit trail stays linear and you can always restore the restore.

```ts
const restored = await kernel.restoreVersion({
  collection: 'posts',
  parent: postId,
  versionId: 'v_01J...A',   // the snapshot to bring back
  draft: true,               // restore into a draft; omit to republish directly
})
```

| Option | Result |
| --- | --- |
| `draft: true` | New draft version with the old values; editor reviews, then publishes. |
| `draft: false` (default) | New published version immediately; `documents` row updated. |

```
v1 pub ── v2 draft ── v3 pub ── v4 (restore of v1) pub
                                   └ same field values as v1, new id + timestamp
```

In the admin, restore is a single action from the version list (TanStack Table row) with a confirmation that shows the diff against current. Field-level access control still applies on restore: if the user cannot write a given field, that field is preserved from the current document rather than overwritten, so restore can never be used to bypass `field.access.update`.

## Open questions

- **Cross-document restore atomicity.** Restoring a version that contains `relationship` fields pointing at since-deleted documents needs a defined policy — null the ref, block the restore, or restore into a draft with a validation warning. Leaning toward the last, but undecided.
- **Localization granularity in diffs.** Whether a diff defaults to the active locale only or shows all locales side by side for localized fields. See [Localization](./09-localization-and-i18n.md).
- **Autosave session boundary.** Whether the session timeout that cuts a new version row should be a fixed default or fully config-driven per collection.
- **Version retention vs. compliance holds.** `maxPerDoc` pruning must interact with legal-hold flags; the precedence rule when a held version is also the oldest is not yet specified.
