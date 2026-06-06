# Collection List Views

The list view is the workhorse screen of any CMS admin: it's where editors find, filter, sort, and act on content in bulk. In KernelCMS, every collection automatically gets a list view rendered by `@kernel/admin` on top of TanStack Table. The table is fully virtualized, column behavior is driven by your collection's field config, and all filter/sort/pagination state lives in the URL via TanStack Router search params. This document specifies how the list view is assembled, how to configure it from `kernel.config.ts`, and where the escape hatches are.

## TanStack Table integration

KernelCMS list views are built on `@tanstack/react-table` with our own row-data layer wired to TanStack Query. We deliberately use the headless core rather than a pre-styled grid component — the cells render through `@kernel/ui` primitives so list views inherit design tokens, dark mode, and WCAG 2.2 AA focus handling for free. Payload ships a bespoke list table, Strapi uses its own content-manager grid, and Sanity's default Desk pane is a flat document list with no real tabular sorting. KernelCMS instead exposes the table model directly: anything TanStack Table can do — column sizing, pinning, grouping, manual vs. client sorting — is reachable.

The data flow is one direction. URL search params are the single source of truth; the query reads them, the table renders them.

```
TanStack Router search params  ──►  buildListQuery()  ──►  @kernel/client.find()
        ▲                                                         │
        │                                                         ▼
   user interaction  ◄──  TanStack Table model  ◄──  { docs, totalDocs, page }
```

Sorting, filtering, and pagination are **manual** (server-driven). We never pull the full collection into the browser to sort it — the table hands its state to `@kernel/client`, which compiles it into the shared query language (`where` / `sort` / `limit` / `page` / `depth`) used identically by REST, GraphQL, and RPC. See The shared query language for the grammar.

```typescript
// Simplified internals of useCollectionList (@kernel/admin)
import { useReactTable, getCoreRowModel } from '@tanstack/react-table'
import { useQuery } from '@tanstack/react-query'
import { client } from '@kernel/client'

export function useCollectionList<TSlug extends CollectionSlug>(slug: TSlug) {
  const search = Route.useSearch() // { page, sort, where, columns }
  const query = useQuery({
    queryKey: ['list', slug, search],
    queryFn: () => client.collections[slug].find({
      where: search.where,
      sort: search.sort,
      page: search.page,
      limit: search.limit,
      depth: 1,
    }),
    placeholderData: (prev) => prev, // keep rows visible during refetch
  })

  return useReactTable({
    data: query.data?.docs ?? [],
    columns: resolveColumns(slug, search.columns),
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true,
    manualFiltering: true,
    manualPagination: true,
    rowCount: query.data?.totalDocs ?? 0,
    state: { sorting: toSortingState(search.sort) },
    getRowId: (row) => row.id,
  })
}
```

Long lists are virtualized with TanStack Virtual, so a 50k-row collection renders a constant number of DOM nodes. Row height is fixed per density setting (`comfortable` / `compact`) to keep the virtualizer's measurement cheap.

## Column configuration

Columns derive from a collection's `fields` by default, but you control which appear and how they render through the `admin.list` block in `kernel.config.ts`. The resolver merges three layers, last wins: field defaults → collection config → the user's saved column preferences.

```typescript
// kernel.config.ts
import { defineCollection } from '@kernel/core'

export const posts = defineCollection({
  slug: 'posts',
  fields: [
    { name: 'title', type: 'text', required: true },
    { name: 'status', type: 'select', options: ['draft', 'review', 'published'] },
    { name: 'author', type: 'relationship', relationTo: 'users' },
    { name: 'publishedAt', type: 'date' },
    { name: 'views', type: 'number' },
  ],
  admin: {
    list: {
      // Columns shown by default, in order
      defaultColumns: ['title', 'status', 'author', 'publishedAt'],
      columns: {
        title: { sticky: 'left', minWidth: 240 },
        status: {
          // Custom cell — receives the row doc and field value
          cell: ({ value }) => <StatusBadge status={value} />,
          width: 120,
        },
        views: { align: 'right', enableSorting: true },
      },
    },
  },
})
```

Each field type ships a sensible default cell renderer, summarized below.

| Field type     | Default cell                          | Sortable | Notes                                  |
| -------------- | ------------------------------------- | -------- | -------------------------------------- |
| `text`         | Truncated text, click to open doc     | yes      | First text field becomes the link cell |
| `select`/`radio` | Token/badge                         | yes      | Sorts by option order, not label       |
| `relationship` | Resolved title (uses `useAsTitle`)    | no¹      | Depth-1 fetch; falls back to id        |
| `upload`       | Thumbnail                             | no       | Lazy-loaded, `aspect-ratio` boxed      |
| `date`         | Localized via the admin's i18n locale | yes      | Stored UTC, rendered in user TZ        |
| `number`       | Right-aligned, locale-grouped         | yes      |                                        |
| `richText`     | Plain-text excerpt                    | no       | Stripped to ~80 chars                  |
| `array`/`blocks` | Count chip (e.g. `3 items`)         | no       |                                        |

¹ Sorting on relationship columns is opt-in and requires a sortable scalar (e.g. `relationTo` title denormalized); otherwise the header sort control is disabled.

Column **width, order, pinning, and visibility** are user-adjustable at runtime via the column manager (a TanStack Store-backed popover). Those preferences persist per user per collection — see saved views below. This is a step beyond Strapi, where column selection is global per role, and Sanity, which has no column model at all.

## Filters, search, and sort

Filtering is the most-used surface, so it gets first-class treatment. The filter bar compiles a structured UI into a `where` clause; it is never a free-form query box that users can break.

### Structured filters

Each filterable field exposes operators appropriate to its type. The builder emits the same `where` tree the API consumes, so what you filter in the admin is exactly reproducible over REST/GraphQL/RPC.

```typescript
// What the filter bar produces in the URL (?where=…)
const where = {
  and: [
    { status: { equals: 'published' } },
    { publishedAt: { greater_than: '2026-01-01' } },
    { author: { in: ['usr_12', 'usr_88'] } },
  ],
}
```

| Field type     | Operators offered                                         |
| -------------- | --------------------------------------------------------- |
| `text`         | `equals`, `not_equals`, `contains`, `like`                |
| `number`/`date` | `equals`, `greater_than`, `less_than`, `between`         |
| `select`/`relationship` | `equals`, `in`, `not_in`                         |
| `boolean`      | `equals`                                                  |
| any            | `exists` (null / not-null)                                |

### Search

Search is a dedicated input wired to a configurable set of fields via `admin.list.searchFields`. By default it targets the collection's `useAsTitle` field. For SQL adapters it compiles to `ILIKE` across the chosen columns; when a search adapter (`@kernel/search`, e.g. Postgres FTS or an external engine) is registered, the same input routes to it transparently — the editor's experience doesn't change, only the relevance does.

```typescript
admin: {
  list: {
    searchFields: ['title', 'excerpt'],
  },
}
```

### Sort

Clicking a sortable header cycles `asc → desc → none` and writes `?sort=-publishedAt` (the `-` prefix means descending, matching the API). Multi-column sort is supported with Shift-click; the order of clicks is the sort precedence. Because sorting is server-side, large collections stay correct — you're sorting the dataset, not the loaded page, which is the trap users hit with client-only grids.

All three controls write to the URL, which means a filtered/sorted list view is **shareable and bookmarkable**. Paste the link to a colleague and they see the same rows (subject to their own access control). Payload and Strapi keep most of this state in component memory, so a refresh or a shared link loses it.

## Bulk actions

Selecting rows reveals the bulk action bar. Selection state is held in the table model; KernelCMS supports both the visible-page selection and a **"select all N matching"** mode that operates over the entire current `where` set, not just the loaded page.

```typescript
// kernel.config.ts — register a custom bulk action
admin: {
  list: {
    bulkActions: [
      {
        label: 'Publish',
        icon: 'upload',
        // Server-side handler runs through the operation core,
        // so access control + hooks + validation all apply.
        handler: async ({ ids, req, kernel }) => {
          await kernel.collections.posts.update({
            where: { id: { in: ids } },
            data: { status: 'published' },
            req, // carries the authenticated user
          })
        },
        confirm: { title: 'Publish selected posts?' },
      },
    ],
  },
}
```

Built-in bulk actions: **delete**, **publish/unpublish** (draft-enabled collections), and **edit fields** (apply one field value across the selection). Every bulk action runs through the same operation core as a single-document write — meaning [access control](../06-auth-security/01-authorization-and-access-control.md) is evaluated per document and per field, hooks fire, and validation runs. There is no privileged bulk path that skips authorization. Failures are reported per-row; a partial failure does not silently drop records, and the action bar surfaces a "3 of 40 failed" summary with reasons.

For destructive actions over a "select all matching" set, the confirm dialog states the resolved count, and the operation is chunked and rate-limited server-side to avoid long-held transactions.

## Saved views

A saved view is a named bundle of list state: `where`, `sort`, visible columns, column order/width, density, and page size. They turn the list view from a transient screen into a reusable workspace — "My drafts", "Needs review", "Published this month". This is where KernelCMS is opinionated: views are stored content, not browser localStorage, so they survive devices and can be shared.

```typescript
// Shape of a stored view (@kernel/core)
interface SavedView {
  id: string
  collection: CollectionSlug
  name: string
  scope: 'personal' | 'shared'   // shared views visible to the collection's role
  where?: WhereClause
  sort?: string
  columns: { name: string; width?: number; visible: boolean }[]
  density: 'comfortable' | 'compact'
  pageSize: number
  owner: string                  // user id
}
```

Views are themselves access-controlled: a `shared` view is readable by anyone with read access to the collection, but only the owner or an admin can mutate it. Personal views are private. You can declare default views in config so a fresh install ships useful starting points:

```typescript
admin: {
  list: {
    views: [
      {
        name: 'Needs review',
        scope: 'shared',
        where: { status: { equals: 'review' } },
        sort: '-updatedAt',
      },
    ],
  },
}
```

Switching views is a router navigation — selecting one writes its state into the search params, so a saved view is still just a URL underneath and remains shareable. Strapi's "saved filters" are per-user and don't carry column/density. Sanity requires you to hand-author Structure Builder code to get anything view-like. KernelCMS gives editors the same capability declaratively and at runtime, with the config-as-code defaults as the floor.

## Open questions

- **Cross-collection views.** Should saved views ever span multiple collections (a unified "everything assigned to me" inbox), or stay strictly per-collection? Cross-collection breaks the clean mapping to a single `find()` call.
- **Server-side view evaluation for counts.** Sidebar view counts (e.g. "Needs review (12)") require a count query per view. Do we eagerly compute them, lazily on hover, or cache via `@kernel/cache` with a short TTL?
- **Grouping UI.** TanStack Table supports row grouping, but a grouped server-paginated list has ambiguous pagination semantics. Defer grouping to a future "board" view rather than overloading the table?
- **Inline edit.** Should selected cells be editable in place (Airtable-style), or do we keep all writes in the document edit form to preserve the single validation path? Leaning toward read-only cells plus the bulk "edit fields" action.
