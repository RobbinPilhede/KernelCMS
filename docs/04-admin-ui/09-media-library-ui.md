# Media Library UI

The media library is the admin surface for everything that lives in `upload` collections: images, video, PDFs, audio, and arbitrary binaries. It is one screen used in two modes — a standalone browser you reach from the nav, and an embedded picker that opens inside any `upload` or `relationship` field. Both modes render the same component tree (`@kernel/admin/media`), share the same TanStack Query cache, and talk to the same `@kernel/storage` adapter. This document specifies the browsing surfaces, the drag-and-drop upload pipeline, search and folder navigation, and how field-level selection reuses all of it. The visual editing and live-preview integration is covered separately in [live preview](./10-live-preview-and-visual-editing.md); media transforms and storage adapters live in the [storage](../07-media-files/01-storage-adapters.md) docs.

## Architecture and data flow

Media is not special-cased the way Strapi treats its Media Library as a bolted-on plugin with its own data model. In KernelCMS an upload collection is a normal collection with `upload: true`, so the same access control, hooks, versioning, and query language apply. The library is a view over that collection.

```
┌──────────────────────────────────────────────────────┐
│  MediaLibrary  (route or modal)                       │
│  ┌────────────┐  ┌──────────────────────────────────┐ │
│  │ FolderTree │  │ Toolbar: search · view · upload  │ │
│  │ (Store)    │  ├──────────────────────────────────┤ │
│  │            │  │ Grid / Table  (Table + Virtual)  │ │
│  │            │  │   ← infinite query, depth=0      │ │
│  └────────────┘  └──────────────────────────────────┘ │
│         │ Dropzone overlay (window-level dragenter)    │
└─────────┼────────────────────────────────────────────-┘
          ▼
   @kernel/client  →  RPC create  →  @kernel/storage adapter
```

State splits cleanly: server state (the documents, folders, upload progress reconciliation) is **TanStack Query**; ephemeral UI state (selected IDs, view mode, drag-hover target, in-flight upload list) is a **TanStack Store** scoped to the library instance. We never push selection or drag state into Query, and we never cache upload progress in a ref — both are reactive `Store` slices so the grid, toolbar, and field trigger all re-render from one source.

```ts
// @kernel/admin/media/store.ts
import { Store } from '@tanstack/store'

export interface MediaUIState {
  view: 'grid' | 'list'
  folderId: string | null
  selected: Set<string>
  multiple: boolean
  uploads: UploadTask[] // optimistic, drives progress chips
}

export const mediaStore = new Store<MediaUIState>({
  view: 'grid',
  folderId: null,
  selected: new Set(),
  multiple: false,
  uploads: [],
})
```

## Grid and list browsing

The library ships two views and remembers the choice per user. **Grid** is the default for visual collections — a virtualized masonry-ish grid of thumbnails. **List** is a `@kernel/ui` table for metadata-heavy work (filenames, sizes, dimensions, alt text, last modified, who uploaded). Both are powered by the same `useInfiniteQuery`; only the row renderer changes.

The grid uses **TanStack Virtual** with a fixed-row windowing strategy so a 40,000-asset folder scrolls at 60fps and never mounts more than ~3 screens of DOM. The list uses **TanStack Table** for column sizing, sort, and the same column model the rest of the admin uses, virtualized with the same `@tanstack/react-virtual` row virtualizer. Sanity's default asset browser is comfortable but not built for tens of thousands of assets in one place; Payload's list view is solid but image-first browsing is an afterthought. KernelCMS treats both as first-class and lets the collection config decide the default.

```ts
// kernel.config.ts
import { defineCollection } from '@kernel/core'

export const media = defineCollection({
  slug: 'media',
  upload: {
    staticDir: 'media',
    mimeTypes: ['image/*', 'video/*', 'application/pdf'],
    imageSizes: [
      { name: 'thumbnail', width: 320, height: 320, fit: 'cover' },
      { name: 'card', width: 768 },
      { name: 'og', width: 1200, height: 630, fit: 'cover' },
    ],
    focalPoint: true,
  },
  admin: {
    media: {
      defaultView: 'grid', // 'grid' | 'list'
      thumbnailSize: 'thumbnail', // which imageSize feeds the grid
      gridColumns: { base: 2, md: 4, xl: 6 },
    },
  },
  fields: [
    { name: 'alt', type: 'text', required: true },
    { name: 'caption', type: 'text', localized: true },
  ],
})
```

The list query requests `depth: 0` and a narrow projection so the table stays light. Grid thumbnails are served from the `thumbnail` `imageSize`, never the original — the original may be a 30MB TIFF. Each cell is keyed by document `id`, so reordering on sort never remounts an image and re-triggers a network fetch.

| View | Renderer                                | Virtualizer     | Best for                           |
| ---- | --------------------------------------- | --------------- | ---------------------------------- |
| Grid | `MediaGrid` (CSS grid + `aspect-ratio`) | row windowing   | visual scanning, image collections |
| List | `@kernel/ui` `DataTable` (Table)        | row virtualizer | metadata, audit, bulk ops          |

Selection works identically in both: click selects, `Shift+Click` range-selects against the current query order, `Cmd/Ctrl+Click` toggles, and the whole thing is keyboard-drivable (arrow keys move a roving focus, `Space` toggles, `Enter` confirms in picker mode) to hold the WCAG 2.2 AA line.

## Drag-and-drop upload UX

Upload is the screen's hot path and gets the most attention. There are three entry points: the toolbar **Upload** button (file dialog), drag-and-drop onto the library, and paste (`Cmd/Ctrl+V` from clipboard). All three funnel into one `useUpload()` hook so progress, validation, and error handling are identical.

Drag-and-drop listens at the **window** level, not just the dropzone, so a drag from the OS file manager anywhere over the library reveals a full-surface overlay. This avoids the Strapi/Payload papercut where users miss a small target. We track `dragenter`/`dragleave` with a counter (the classic child-element `dragleave` bug) so the overlay doesn't flicker.

```ts
// @kernel/admin/media/use-upload.ts
export function useUpload(collection: string) {
  const client = useKernelClient()

  return useMutation({
    mutationFn: async (file: File): Promise<MediaDoc> => {
      // 1. client-side gate: mime + size, instant feedback
      assertAllowed(file, collection)
      // 2. presigned direct-to-storage when the adapter supports it
      const { url, fields, key } = await client.storage.presign({
        collection,
        filename: file.name,
        contentType: file.type,
      })
      await putWithProgress(url, fields, file, (pct) => mediaStore.setState((s) => patchProgress(s, file, pct)))
      // 3. finalize: create the doc, run hooks, generate imageSizes
      return client.collections[collection].create({
        data: { filename: file.name, mimeType: file.type, filesize: file.size, storageKey: key },
      })
    },
    onSuccess: (doc) => {
      queryClient.invalidateQueries({ queryKey: ['media', collection] })
      mediaStore.setState((s) => completeUpload(s, doc))
    },
  })
}
```

Two design decisions matter here. First, **direct-to-storage presigned uploads** when the `@kernel/storage` adapter exposes them (S3, R2, GCS), so large files never round-trip through the Node/Bun server. The server is only asked to mint a presigned URL and then finalize a small JSON document. Adapters without presigning (local disk) fall back to a streamed multipart POST through an RPC server function. Second, uploads are **optimistic and concurrent**: each file becomes an `UploadTask` chip immediately, with its own progress bar, retry button, and cancel (an `AbortController` per task). We cap concurrency (default 3) and queue the rest so a 200-file drop doesn't saturate the connection.

```
 drop 12 files
 ┌───────────────────────────────────────────┐
 │ ▣ hero.jpg        ████████░░  78%   ✕      │
 │ ▣ team.png        ██████████  done         │
 │ ▣ deck.pdf        ███░░░░░░░  22%   ✕      │
 │ ▣ promo.mp4       queued…                  │
 │ … 8 more                          [Cancel] │
 └───────────────────────────────────────────┘
```

Validation runs client-side for instant rejection (wrong MIME, over `maxFileSize`) **and** server-side in the create operation — the client gate is UX, the server gate is the security boundary. Failures stay in the chip list with a human-readable reason and a retry, rather than dumping the whole batch. Duplicate detection (by content hash) is surfaced as a non-blocking warning with a "use existing" shortcut.

All motion respects `prefers-reduced-motion`; the overlay and progress bars degrade to opacity/width changes with no transform animation when reduced motion is requested.

## Search and folders

Search is a debounced query against the upload collection using the same `where` language as every other surface — there is no bespoke media search index to drift out of sync. It searches filename, alt text, and caption by default, and the config can extend the searchable fields.

```ts
const { data } = client.collections.media.find({
  where: {
    folder: { equals: folderId },
    or: [{ filename: { contains: q } }, { alt: { like: q } }],
    mimeType: { in: ['image/png', 'image/jpeg'] }, // facet chip
  },
  sort: '-createdAt',
  limit: 60,
})
```

Above the results sits a row of **facet chips** — type (image/video/doc), date range, dimensions, and uploader — that compose into the same `where`. Each chip is reflected into the **TanStack Router** search params, so a filtered media view is a shareable, bookmarkable URL and survives a refresh. This is the same router-as-state-store pattern used across the admin and is something neither Sanity nor Strapi gives you for the media browser.

**Folders** are optional and opt-in. When enabled, they are stored as a self-referential field on the media collection (`parent` relationship), not as a separate filesystem concept — moving a file between folders is a document update, fully access-controlled and versioned, and it never moves bytes in storage. The storage key is stable for the life of the asset.

```ts
admin: {
  media: {
    folders: {
      enabled: true,
      field: 'folder',        // relationship<self> created automatically
      allowRoot: true,
    },
  },
}
```

The folder tree is a `Store`-backed component on the left. Dropping files onto a folder uploads into it; dropping a _selected asset_ onto a folder moves it (with an optimistic update + invalidation). Strapi added folders relatively late and they remain a separate construct; Payload leans on relationships and collection filters instead of a folder UI. KernelCMS models folders as relationships _and_ gives them a real tree UI — you get the queryable data model and the spatial navigation.

## Selecting media inside fields

The picker is the same `MediaLibrary` component opened in a `<dialog>`, parameterized by the field. An `upload` field opens it in single-select; an `upload` with `hasMany: true` or an `array` of uploads opens it in multi-select with a confirm bar. Because it is the same component over the same Query cache, files you just uploaded in the picker are already warm when you reopen the standalone library, and vice versa.

```ts
// kernel.config.ts — a field that picks from the media library
fields: [
  {
    name: 'hero',
    type: 'upload',
    relationTo: 'media',
    required: true,
    filterOptions: { mimeType: { contains: 'image' } }, // picker pre-filters
  },
  {
    name: 'gallery',
    type: 'upload',
    relationTo: 'media',
    hasMany: true,
    maxRows: 12,
  },
]
```

The field component is a **TanStack Form** field. Selecting in the dialog writes the chosen ID(s) back through the form binding, which runs the field's validation (e.g. `required`, `maxRows`) and marks the form dirty. The dialog supports uploading on the spot — drop a file into the picker and it is created, selected, and returned in one motion, which is the flow content editors actually want and the thing Strapi's modal historically made clunky.

```
 [ Hero image ]                         field
 ┌──────────────┐  ┌──────────────────────────────┐
 │   thumb      │  │  open ▸  MediaLibrary(dialog) │
 │  hero.jpg    │  │   filterOptions → where       │
 │  edit · ✕    │  │   multiple = false            │
 └──────────────┘  └──────────────────────────────┘
```

`filterOptions` is merged into the picker's base `where`, so a "hero" field can be restricted to images and a "downloads" field to PDFs without writing UI code. Selection in a relationship field that targets media reuses the exact same picker — there is one selection primitive, not two. After confirm, the field shows a thumbnail, alt-text preview, and inline edit/remove controls, with focal-point editing available when `focalPoint` is enabled on the upload config.

## Open questions

- **Folders as relationships vs. materialized paths.** A `parent` relationship is clean but deep trees need recursive queries; a materialized `path` column makes "everything under /brand" trivial at the cost of move-time rewrites. Leaning toward storing both — relationship as source of truth, denormalized `path` for queries.
- **Bulk move/tag affordance.** Whether multi-select bulk operations live in the standalone library only, or also inside the field picker. Current plan: read/select in the picker, full bulk ops only in the standalone view to keep the picker focused.
- **Client-side image processing.** Whether to generate a fast blurhash/thumbnail in the browser before upload for instant grid placeholders, or always wait for the server `imageSizes`. The blurhash-on-client path is appealing but adds a wasm dependency we may not want by default.
- **TanStack DB for live media.** Using `@kernel/db`'s reactive client collections so multiple editors see new uploads appear live without manual invalidation — promising for team workflows, but we need to settle the conflict story for concurrent folder moves first.
