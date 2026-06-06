# Document Edit View

The document edit view is where editors spend most of their time, so it gets the most engineering attention. It renders a single document (or a global), binds every field to TanStack Form, drives autosave through the typed RPC layer, and surfaces drafts, versions, and validation in a way that never makes an editor guess what state their work is in. This document specifies the layout, the field rendering pipeline, the status/versions sidebar, autosave behavior, and how validation errors reach the right field — and where KernelCMS deliberately diverges from Payload, Sanity, and Strapi.

## The Edit Layout

The route is `/admin/collections/$collection/$id` (and `/admin/globals/$global`), resolved by TanStack Router. The loader fetches the document via `@kernel/client` using one `findByID` call with the `depth` and `locale` taken from search params, so the URL is the single source of truth for what you're looking at. Refresh, deep-link, and back-button all reconstruct the exact same editor state — including which tab is open and which locale is active.

```
+--------------------------------------------------------------+
|  Posts / Editing "Launch announcement"        [Save] [Publish]|  <- header
+-----------------------------------------------+--------------+
|                                               |  STATUS      |
|  [ Content ] [ SEO ] [ Settings ]   <- tabs   |  Draft       |
|                                               |  Autosaved   |
|  Title  [____________________________]        |  2s ago      |
|  Slug   [____________________________]        |--------------|
|                                               |  VERSIONS    |
|  Body                                         |  v14 (you)   |
|  +------------------------------------------+ |  v13 Anders  |
|  |  rich text editor (blocks)               | |  v12 ...     |
|  +------------------------------------------+ |--------------|
|                                               |  LOCALES     |
|  Author  [ relationship picker ]              |  en  da  de  |
|                                               |              |
+-----------------------------------------------+--------------+
        main field column (~70%)                  sidebar (~30%)
```

The header is sticky and owns the primary actions. The field column is a single scroll container virtualized by TanStack Virtual once a document exceeds a threshold of mounted field nodes (long `blocks` and `array` fields are the usual cause). The sidebar is non-virtualized and always mounted. On narrow viewports the sidebar collapses into a bottom sheet, and tabs become a horizontal scroller — the layout is mobile-first per our CSS rules, not a desktop layout shrunk down.

Field placement is config-driven. `tabs`, `row`, `group`, and `collapsible` presentational fields control structure; `admin.position: 'sidebar'` hoists a field out of the main column into the sidebar (Payload's pattern, kept because it's genuinely good for status-adjacent fields like `publishedAt`).

```ts
// kernel.config.ts
fields: [
  { name: 'title', type: 'text', required: true },
  { name: 'slug', type: 'text', admin: { components: { Field: SlugField } } },
  {
    type: 'tabs',
    tabs: [
      { label: 'Content', fields: [{ name: 'body', type: 'richText' }] },
      { label: 'SEO', fields: [{ name: 'meta', type: 'group', fields: [/* ... */] }] },
    ],
  },
  { name: 'publishedAt', type: 'date', admin: { position: 'sidebar' } },
]
```

## The Field Rendering Pipeline

This is the core of the edit view. A document's field config is a tree; rendering walks that tree and produces a React node per field. Three things make a field component: its **type** (resolves the default renderer from `@kernel/ui`), its **path** (dotted, e.g. `meta.title` or `blocks.2.heading` — used as the TanStack Form field name and as the validation-error key), and its **admin overrides** (custom `Field` component, conditions, width).

```
config tree ──► resolveFieldComponent(type, admin.components)
                        │
                        ▼
         <FieldProvider path locale> ── TanStack Form bind ──► useField(path)
                        │
                        ▼
         renderer reads value, errors, isDirty from one store
```

Every renderer is bound through a single `useField(path)` hook backed by one TanStack Form instance for the whole document. There is no per-field form state and no prop-drilling of values — the form store is the single source of truth, and field components subscribe only to their own path, so editing the title doesn't re-render the rich-text body. Strapi re-renders broad slices of its edit view on change; we explicitly don't.

Container field types recurse:

| Field type | Renders | Child paths |
|------------|---------|-------------|
| `group`    | nested fieldset | `parent.child` |
| `array`    | repeatable rows, drag-reorder | `field.0.child` |
| `blocks`   | typed block list, block picker | `field.2.blockField` |
| `tabs`/`row` | layout only, no data | inherit parent path |

Custom field types register a renderer in `@kernel/ui`; the config references it by name, and `@kernel/core` generates the TypeScript type so the value is typed end-to-end. The escape hatch is total: any field can supply `admin.components.Field`, and that component receives the same `useField` contract, so a custom field is a first-class citizen, not a sandboxed iframe. This is where we beat Sanity — Sanity's custom inputs are powerful but live inside its own schema/store abstraction; ours are plain React reading a TanStack Form field. See [Field Components](./07-field-components-and-rendering.md) for the renderer contract.

Conditional fields (`admin.condition`) are evaluated reactively against the live form values via a TanStack Store selector, so showing/hiding a field on a checkbox toggle is instant and doesn't refetch. Hidden fields are unmounted but their last value is retained in the form store so toggling back doesn't lose data.

## The Status and Versions Sidebar

The sidebar answers three questions at a glance: what's the publish state, what changed and when, and which locale am I editing. It's powered by a single TanStack Query subscription per document keyed `['doc', collection, id]`, invalidated on every successful save so it never drifts from the main column.

**Status** shows the draft/published state machine. With drafts enabled, a document has a published version and a possibly-newer draft; the sidebar makes the divergence explicit rather than hiding it the way Strapi's draft/publish does.

```
 Draft only      Published       Published + newer draft
 [ Draft ]       [ Published ]   [ Published • Draft ahead ]
                                  └ "Changes since publish"
```

**Versions** lists the version history (autosave + manual saves), newest first, virtualized with TanStack Virtual because long-lived documents accumulate thousands. Each row shows author, relative time, and the trigger (`autosave`, `save`, `publish`). Clicking a row opens a field-level diff against the current draft; restore writes the selected version as a new draft (never a destructive overwrite). This is Payload's model done with our diff engine — and unlike Sanity, version history is on by default for any collection with `versions` enabled, not a separate dataset concept.

```ts
// kernel.config.ts
collections: [{
  slug: 'posts',
  versions: {
    drafts: { autosave: { interval: 800 } },
    maxPerDoc: 200,            // prune older autosaves, keep manual saves
  },
}]
```

**Locales** renders one chip per configured locale, with a per-locale completeness indicator (computed from required localized fields). Switching locale updates the `locale` search param, which re-runs the loader; the form rehydrates with that locale's values for localized fields while keeping non-localized fields shared. See [Localization](../02-data-modeling/09-localization-and-i18n.md).

## Autosave UI

Autosave is opt-in per collection and runs against the **draft** version only — never the published one. The flow is debounced, optimistic, and reconciled:

```
keystroke ──► form store dirty ──► debounce(interval)
   │                                     │
   │                                     ▼
   └─ status: "Editing…"      RPC saveDraft (TanStack Start server fn)
                                         │
                              ┌──────────┴───────────┐
                          success                  error
                              │                       │
                     status: "Saved 2s ago"   status: "Save failed — Retry"
                     invalidate ['doc'...]     keep dirty, exponential backoff
```

The save call goes through `@kernel/client` to a typed RPC server function — the same operation core as the Local API, so autosave runs the identical access control and validation an external API write would. We never save invalid required-field state silently the way Sanity's continuous sync can; an autosave that fails server validation returns field errors and the status reflects "Save failed," keeping the document dirty.

The status indicator is a small TanStack Store atom with a tight state set so the UI is never ambiguous:

| State | Trigger | UI |
|-------|---------|----|
| `idle` | no unsaved changes | "Saved {relative}" |
| `editing` | form dirty, debounce pending | "Editing…" |
| `saving` | RPC in flight | spinner + "Saving…" |
| `saved` | RPC resolved | "Saved just now" |
| `error` | RPC rejected | "Save failed — Retry" |
| `conflict` | server version newer | "Newer version exists — Review" |

Conflict handling matters and most CMSs punt on it. Each autosave sends the version it's based on; if another session advanced the draft, the server rejects with a conflict and the sidebar offers a diff-and-merge view instead of clobbering. Real-time co-editing presence is layered on top via `@kernel/db` reactive collections (TanStack DB) when enabled — see [Live Preview](./10-live-preview-and-visual-editing.md) — but the conflict guard works without it.

Autosave is suppressed while a field is mid-async-validation (e.g. a slug-uniqueness check) to avoid persisting a value that's about to be rejected, and while the document is in a hard-invalid state for required fields. Manual `Save draft` and `Publish` bypass the debounce and run a full validation pass.

## Surfacing Validation Errors

Validation runs in two places and both feed the same error map keyed by field path. Sync and cross-field validators run client-side on blur (not on every keystroke — per our React rules) for instant feedback; async validators and the authoritative pass run server-side in the operation core, because client validation is a UX nicety and the server is the boundary that actually enforces it.

```ts
// kernel.config.ts
{
  name: 'slug',
  type: 'text',
  validate: async (value, { req, siblingData }) => {
    if (!/^[a-z0-9-]+$/.test(value)) return 'Lowercase, numbers, and hyphens only'
    const taken = await req.payload.find({ /* uniqueness check */ })
    return taken ? 'Slug already in use' : true
  },
}
```

Errors are returned as `{ path: string; message: string }[]` and merged into the TanStack Form error store by path. Because the field renderer already subscribes to its own path, the matching input shows its error inline with zero extra wiring — including deep paths like `blocks.2.cta.label`, which is exactly where Strapi's error surfacing tends to break down on nested components.

When a save or publish fails validation, the editor also gets a navigable summary so errors aren't lost off-screen in a long document:

```
+--------------------------------------------------+
|  ⚠ 3 fields need attention                        |
|   • Title is required            → jump           |
|   • Slug already in use          → jump           |
|   • SEO ▸ Meta description too long → jump (SEO)   |
+--------------------------------------------------+
```

Each entry deep-links to the field: clicking activates the owning tab/array-row, scrolls the virtualized list to that node, and focuses the input. Errors on collapsed `tabs`, `array` rows, or `blocks` bubble a badge up to their container so a hidden error is never silently ignored — a concrete win over both Payload (which surfaces inline but doesn't always reveal collapsed containers) and Strapi. The Publish button stays enabled (we don't disable-and-confuse); attempting to publish an invalid document runs validation, populates the summary, and focuses the first error. See [Validation](../02-data-modeling/08-validation-and-constraints.md) and [Access Control](../06-auth-security/01-authorization-and-access-control.md) for how field-level access can also strip fields before they ever render.

## Open Questions

- **Conflict UX depth**: is diff-and-merge enough for the non-real-time case, or do we need optimistic CRDT-style merging for plain text fields even without TanStack DB presence enabled?
- **Autosave granularity**: full-document draft writes vs. field-patch writes. Patches reduce payload and conflict surface but complicate the version history model (a "version" that's a partial patch).
- **Validation summary scope**: should async/server-only errors appear in the live inline UI before a save attempt, or only after? Running every async validator on blur could be expensive on relationship-heavy documents.
- **Version pruning policy**: `maxPerDoc` prunes autosaves — should manual saves and published versions ever be pruned, or are they retained indefinitely with separate retention controls?
