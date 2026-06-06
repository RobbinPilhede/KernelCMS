# Spec 02 — Versions, Drafts, Autosave & Scheduled Publish

Status: Draft · Owner: core · Track: C (Content Modeling) · Priority: P0 · Effort: XL
Depends on: operation pipeline, adapter contract, access control, jobs queue (Spec 18
for scheduling), admin document editor, rich-text diff (Spec 01).

---

## 1. Context & problem

KernelCMS has no history, no draft/publish split, no autosave, no scheduled
publishing. Editors cannot safely draft changes, can't recover from mistakes, and
have no audit trail. This is core editorial infrastructure and a signature Payload
capability. We build it as a first-class engine feature with a **clean separation
of "what is stored" from "what is publicly readable,"** integrated with access
control so drafts are governed like any other data.

Differentiator: our version diff can show a **rendered-section diff** (what the
page looked like) in addition to a structured field diff — leveraging the page
builder + live preview we already have.

## 2. Goals / Non-goals

**Goals**

- Per-collection/global opt-in `versions` with three escalating modes:
  history-only, drafts, drafts+autosave.
- A **separate versions store** per collection (no change to the main row shape) —
  history is cheap and never bloats the live table.
- A true **draft vs published** lifecycle with `_status: 'draft' | 'published'`,
  governed by **access control** (who reads drafts vs published).
- **Autosave** to a draft version (debounced, conflict-aware) — never mutates the
  published document.
- **Version browse + diff + restore** in the admin, including rendered diff.
- **Scheduled publish/unpublish** at a future timestamp via the jobs queue.
- Deterministic, well-typed APIs across Local/REST(/GraphQL).

**Non-goals (v1)**

- Branching/merge workflows or per-field approval. (Design leaves room; not v1.)
- Multiplayer co-editing (separate; document locking covers concurrency v1).

## 3. Configuration

```ts
interface CollectionConfig {
  // ...
  versions?: boolean | VersionsOptions
}
interface VersionsOptions {
  drafts?: boolean | DraftsOptions // default false (history-only)
  maxPerDoc?: number // ring-buffer cap, default 100 (0 = unlimited)
}
interface DraftsOptions {
  autosave?: boolean | { interval?: number /* ms, default 800 */ }
  /** Allow scheduling publish/unpublish at a future date. Default false. */
  schedulePublish?: boolean
  /** Validate drafts on save. Default false (drafts may be incomplete). */
  validate?: boolean
}
```

**Modes**

1. `versions: true` → **history-only**: every successful update snapshots a version;
   the newest is always "live." Good for audit (e.g. users).
2. `versions: { drafts: true }` → **drafts**: documents carry `_status`; you can save
   draft versions newer than the published doc; access decides who sees which.
3. `+ autosave` → drafts saved automatically as you type.

Decision: versions are **opt-in** (unlike Payload's opt-out default) to keep the
zero-config footprint small; the scaffolder enables drafts on content collections.

## 4. Data model

### 4.1 Main collection row

- History-only: unchanged.
- Drafts: add a system column **`_status`** (`'draft' | 'published'`, indexed).
  The main row always holds the **latest published** snapshot (what public reads
  get by default). Draft-only changes live in the versions store until published.

### 4.2 Versions store

One table per versioned collection: `_versions_<slug>` (globals: `_versions_global_<slug>`).

```ts
interface VersionRow {
  id: string // version id
  parent: string // the document id this version belongs to (indexed)
  version: Row // full serialized document snapshot at this point
  status: 'draft' | 'published'
  autosave: boolean // true if produced by autosave (collapsible in UI)
  createdAt: string // when this version was captured (indexed, desc)
  createdBy?: string // user id (audit)
  publishedAt?: string // set when this version became the published one
  snapshotMeta?: { previewHash?: string } // for rendered-diff caching
}
```

Rationale for full snapshots (not deltas): simple, robust restore, trivial diffing,
and "versions don't change the shape of your data." `maxPerDoc` trims oldest
non-published, non-autosave-pinned rows (ring buffer). Autosave versions are
coalesced (keep latest autosave per editing session) to avoid unbounded growth.

### 4.3 Schema compilation

`compileSchema` emits the `_versions_<slug>` table (columns: id, parent, version
[json], status, autosave [bool], createdAt, createdBy, publishedAt, snapshotMeta
[json]) whenever the collection has versions enabled. `parent` + `createdAt`
indexed; `status` indexed.

## 5. Operation pipeline integration

The version logic is a **pipeline stage**, not scattered across handlers.

- **create**
  - drafts off: create row (as today) + write a `published` version.
  - drafts on: `_status` defaults from input (`draft` unless explicitly published).
    Always write a version with that status. If created as `draft`, the main row
    still stores the data but `_status='draft'` (no published snapshot yet).
- **update**
  - history-only: update row, append `published` version.
  - drafts on, `draft: true` (or autosave): **do not** overwrite the published
    fields destructively — write a new `draft` version; the main row's published
    snapshot is only replaced on publish. (Implementation: keep latest content in
    the main row but gate public reads by `_status`/`where` from access; OR keep
    main row = published and overlay drafts from versions. **Decision:** main row =
    latest published; "current draft" = newest draft version. Reads resolve per
    `draft` flag, see §6. This keeps public queries fast and uncomplicated.)
  - drafts on, `publish` (`_status: 'published'`): validate (always), write the
    content to the main row, append a `published` version, set `publishedAt`.
- **find/findByID**
  - new option `draft?: boolean` (default false). `draft:false` → published view
    (main row, filtered to `_status:'published'` semantics). `draft:true` → overlay
    the newest draft version for each doc (admin editing & draft preview).
- **delete** — cascade delete the doc's versions (or soft-delete with Trash spec).

**Access integration:** reading drafts requires passing access for the draft view.
Collections expose `readVersions`/draft access; by default, `draft:true` reads
require an authenticated user (secure-by-default), and public (`draft:false`) reads
only ever see published content. Field/row access still applies.

New Local API ops: `findVersions`, `findVersionByID`, `restoreVersion`,
`publish`, `unpublish`, `schedulewrite` (internal). Existing `find/findByID/
update/create` gain `draft?: boolean`.

## 6. Read resolution (the important subtlety)

- **Published read** (`draft:false`): query main rows where `_status='published'`
  (or status absent for history-only). Fast path, cacheable, what the live site uses.
- **Draft read** (`draft:true`): start from published main row, **overlay** the
  newest `draft` version's content for each id (a single batched versions query by
  `parent IN (...)`). This avoids dual-writing drafts to the main table and keeps
  the public path pristine.
- Live preview and the admin editor always read `draft:true`.

## 7. Autosave

- Admin: debounced (`interval`, default 800ms) PATCH with `draft:true,
autosave:true`. Server coalesces consecutive autosaves in the same session
  (replace the latest autosave version rather than append) to bound growth.
- **Conflict handling:** each editor load gets the `updatedAt`/version id it based
  on; autosave/publish send `If-Match: <versionId>`. If the server's latest draft
  is newer (someone else / another tab), respond `409` with the diverging version;
  the admin offers “review changes / overwrite.” Pairs with **document locking**
  (separate spec) which prevents most conflicts up front.
- Autosave never validates hard (drafts may be incomplete) unless `validate:true`.
- Indicator UI: “Saving… / Saved <time> / Unsaved changes / Conflict”.

## 8. Scheduled publish / unpublish

- Requires the **jobs queue** (Spec 18). `schedulePublish: true` exposes, in the
  editor, “Publish on <date>” / “Unpublish on <date>”.
- Mechanism: a `publishAt`/`unpublishAt` is stored on the draft version + a job is
  enqueued with `waitUntil`. The job runs `publish`/`unpublish` with override
  access at the due time, writing a normal published version (audited as
  `createdBy: system`).
- Cancellation: editing/clearing the schedule cancels the job.

## 9. Admin UX

- **Status pill** in the editor header (Draft / Published / Changed since publish /
  Scheduled). Save bar shows **Save draft** + **Publish** (split button), with
  schedule option behind the publish menu.
- **Versions view** (`/collections/:slug/:id/versions`): list of versions (time,
  author, status, autosave badge), filterable; autosaves grouped/collapsed.
- **Diff view:** select two versions →
  - **Field diff:** structured per-field changes (text/number/select shown inline;
    rich text shown via Spec 01 model diff; arrays/blocks show added/removed/moved
    rows).
  - **Rendered diff (differentiator):** side-by-side or overlay of the two versions
    rendered through live preview (uses `snapshotMeta.previewHash`), so editors see
    _what the page looked like_, not just JSON.
- **Restore:** restore a version → creates a new draft (or publishes, with confirm),
  never destroys history.
- **Draft preview link:** shareable tokenized URL (`?draft=<token>`) that renders
  the draft via the frontend live-preview path for stakeholders without admin access.
- States: empty (no versions yet), loading, conflict modal, scheduled banner.
- A11y AA; keyboard navigation of version list & diff; reduced motion.

## 10. API surface

REST (additive):

- `GET /api/<slug>?draft=true` and `GET /api/<slug>/:id?draft=true`
- `GET /api/<slug>/:id/versions` (+ filter/paginate), `GET .../versions/:vid`
- `POST /api/<slug>/:id/versions/:vid/restore`
- `POST /api/<slug>/:id/publish`, `POST /api/<slug>/:id/unpublish`
- Update accepts `{ _status, autosave, publishAt, unpublishAt }`; `If-Match` header
  for optimistic concurrency.

Local API mirrors all of the above with full types. GraphQL (future) adds
`version(s)`, `restoreVersion`, `publish`, and a `draft` arg on queries.

## 11. Performance & scale

- Published reads unaffected (single indexed `_status` filter); no joins on the hot
  path. Draft overlay is one batched versions query keyed by `parent`.
- Versions table grows append-only; `maxPerDoc` ring-buffer + autosave coalescing
  bound it; an optional retention job prunes old autosaves.
- Diff is computed on demand and cached by version-pair hash. Rendered diff reuses
  preview snapshots; capture is a background job, not on the save path.
- Budgets: publish op < 50ms (excl. validation); versions list (100 rows) < 80ms;
  draft overlay adds < 10ms to a 25-row list.

## 12. Security

- Drafts are data: full access control applies; public can never read drafts.
- Draft preview tokens are signed, scoped to one doc, short-TTL, revocable.
- Restore/publish are privileged ops; audited (`createdBy`). Rate-limited.
- Scheduled jobs run with system override but log the original requester.

## 13. Migration & rollout

- Enabling versions on an existing collection: a migration creates `_versions_<slug>`
  and (drafts mode) adds `_status` defaulting existing rows to `'published'`, then
  backfills an initial `published` version per row (batched, idempotent).
- Disabling: keep the versions table (data retention) but stop writing; documented.
- Phases:
  1. History-only (versions table + snapshot on update + versions list/restore).
  2. Drafts (`_status`, `draft` read resolution, publish/unpublish, status UI).
  3. Autosave (+ conflict/If-Match + indicator).
  4. Diff view (field diff → rich-text diff → rendered diff).
  5. Scheduled publish (needs jobs queue).
  6. Draft preview links.

## 14. Testing strategy

- **Pipeline:** create/update/publish/unpublish transitions write the correct
  version rows and `_status`; `draft:true` overlays newest draft; published reads
  never see drafts.
- **Access:** anonymous cannot read drafts; field/row access still applies to draft
  reads; restore/publish require permission.
- **Autosave/concurrency:** coalescing keeps one autosave/session; `If-Match`
  mismatch → 409; ring-buffer trims correctly; autosave never mutates published.
- **Restore:** restoring an old version reproduces its content exactly; history
  preserved.
- **Scheduling:** job publishes at `waitUntil`; cancel removes the job; unpublish works.
- **Diff:** field/array/blocks/rich-text diffs correct on fixtures; rendered-diff
  snapshot stability.
- Coverage 80/70; access + concurrency tests required.

## 15. Acceptance criteria

- [ ] `versions: { drafts: true, autosave: true }` yields: autosaving editor,
      Save-draft + Publish, status pill, versions list, diff, restore.
- [ ] Public `GET /api/pages?...` returns only published; `?draft=true` (authed)
      returns latest drafts overlaid.
- [ ] Publishing writes the main row + a published version + `publishedAt`;
      restore creates a new draft and never deletes history.
- [ ] Two-tab edit triggers a 409 conflict with a clear resolution path.
- [ ] Scheduled publish goes live at the set time via a job; cancel works.
- [ ] Versions table respects `maxPerDoc`; autosaves are coalesced.
- [ ] Rendered diff shows the visual before/after of a page. ✦ no-AI-feel review passed.

## 16. Open questions

- Store drafts in the main row (overlay-free) vs versions-overlay? (Chosen:
  overlay, to keep public path clean — revisit if draft reads dominate.)
- Per-field publish (granular) — defer to v2; model leaves room via per-field
  version metadata.
- Localization × drafts: per-locale publish status? (v2; v1 publishes the document.)
