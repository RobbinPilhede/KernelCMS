# Admin Panel Architecture

The KernelCMS admin is a React application served by TanStack Start. It is not a separate single-page app bolted onto a REST backend the way Strapi's admin talks to its Koa server, nor a bespoke Vite SPA like Sanity Studio. The admin and the API share one TanStack Start server process: routes are server-rendered, data is fetched through type-safe server functions, and every screen is generated from the same `kernel.config.ts` that drives the REST, GraphQL, and RPC surfaces. This document covers how the admin is laid out — route structure, the data layer, config-driven rendering, and how it stays small through aggressive code-splitting.

## High-level structure

The admin ships from `@kernel/admin` as a mountable TanStack Start application. You don't fork it; you mount it and feed it config. A self-hosted deployment hands `@kernel/admin` the same config object your server uses, plus the typed RPC client from `@kernel/rpc`.

```
@kernel/server (TanStack Start host)
        |
        |  shares config + server functions
        v
@kernel/admin  ── routes ──> @kernel/ui (tokens, primitives)
        |                        ^
        |  TanStack Query        |  field components resolved
        v                        |  from config at render time
@kernel/rpc (typed server fns) ──┘
        |
        v
@kernel/core (operation core: find/create/update/delete)
```

The admin never reaches into the database. Every read and write goes through the same operation core in `@kernel/core` that powers the public APIs, so access control, validation, hooks, and field-level localization behave identically whether a request arrives from the admin, a REST client, or an in-process Local API call. Payload achieves something similar by routing its admin through its own Local API; KernelCMS differs in that the transport between admin and core is TanStack Start server functions with end-to-end inferred types, not a REST round-trip the admin has to re-type by hand.

## Route structure with TanStack Router

The admin's URL space is generated, not authored screen-by-screen. TanStack Router gives us a file-based, fully type-safe route tree, and KernelCMS layers a config-driven layer on top: collections and globals from `kernel.config.ts` expand into routes at build time.

The static skeleton looks like this:

```
routes/
  __root.tsx                      // shell: nav, command palette, auth gate
  _authed.tsx                     // layout route: requires a session
  _authed/index.tsx               // dashboard
  _authed/collections/
    $collection/index.tsx         // list view  (TanStack Table)
    $collection/create.tsx        // create form (TanStack Form)
    $collection/$id.tsx           // edit form  + version history
  _authed/globals/
    $global.tsx                   // singleton editor
  _authed/media/index.tsx         // media library
  login.tsx
```

The `$collection` and `$global` params are not free-form strings. A route loader validates them against the config registry and throws a typed `notFound()` for anything unknown, so `/collections/widgets` 404s cleanly when no `widgets` collection exists.

Search-param state is where TanStack Router earns its place. List-view state — pagination, sort, active filters, column visibility, selected locale — lives in the URL, validated and typed through `validateSearch`. This makes every list view shareable and bookmarkable, and it means the back button restores filter state for free. Strapi keeps most list state in component state and React context, which is why a refresh wipes your filters; KernelCMS treats the URL as the source of truth for view state.

```ts
// _authed/collections/$collection/index.tsx
export const Route = createFileRoute('/_authed/collections/$collection/')({
  validateSearch: (search) =>
    listSearchSchema.parse(search) satisfies ListSearch,
  loaderDeps: ({ search }) => ({
    page: search.page,
    sort: search.sort,
    where: search.where,
    locale: search.locale,
  }),
  loader: ({ params, deps, context }) =>
    context.queryClient.ensureQueryData(
      collectionListQuery(params.collection, deps),
    ),
  component: CollectionListView,
})
```

The `where` and `sort` fragments in the URL use the same shared query language documented in the query language reference — `where`, `sort`, pagination, and `depth`. One grammar spans the admin URL bar, the REST querystring, and the GraphQL arguments, so a filter you build in the admin is the exact filter you'd send over REST.

| Concern | Where it lives | Mechanism |
| --- | --- | --- |
| Which collection/global | Path param (`$collection`) | Validated against config registry |
| Pagination / sort | Search params | `validateSearch` + `loaderDeps` |
| Active filters (`where`) | Search params | Shared query-language grammar |
| Active locale | Search params | Falls back to default locale |
| Auth requirement | Layout route (`_authed`) | `beforeLoad` session check |
| Unsaved-form guard | Route `beforeLoad` / blocker | Router navigation blocker |

Auth is enforced at the `_authed` layout route via `beforeLoad`, which checks the session resolved by `@kernel/auth` and redirects to `/login` with a `redirect` search param. Because it's a layout route, every child inherits the guard — there's no per-page checkbox to forget.

## The data layer with TanStack Query

All admin data flows through TanStack Query. There is no Redux store, no hand-rolled fetch cache, and no global mutable state for server data. Query is the cache; TanStack Store (covered below) handles only ephemeral UI state.

Queries are defined as typed factories that pair a structured query key with a function that calls the `@kernel/rpc` client. The RPC client is generated from config, so `rpc.collections.posts.find(...)` is fully typed down to the field level — no manual response interfaces, unlike a Strapi admin that re-declares types for every endpoint.

```ts
// query factories
export const collectionListQuery = (
  slug: string,
  deps: ListSearch,
) =>
  queryOptions({
    queryKey: ['collection', slug, 'list', deps] as const,
    queryFn: () => rpc.collections[slug].find(deps),
    staleTime: 30_000,
  })

export const docQuery = (slug: string, id: string, locale: string) =>
  queryOptions({
    queryKey: ['collection', slug, 'doc', id, locale] as const,
    queryFn: () => rpc.collections[slug].findById({ id, locale }),
  })
```

Key conventions are strict because invalidation depends on them. The shape is always `[entityKind, slug, view, ...specifics]`. A mutation invalidates by prefix: saving a document invalidates `['collection', slug]`, which clears both the doc and every list view for that collection in one call.

```ts
const save = useMutation({
  mutationFn: (input: UpdateInput) =>
    rpc.collections[slug].update({ id, data: input, locale }),
  onMutate: async (input) => {
    await queryClient.cancelQueries({ queryKey: ['collection', slug, 'doc', id] })
    const prev = queryClient.getQueryData(docKey)
    queryClient.setQueryData(docKey, optimistic(prev, input)) // optimistic patch
    return { prev }
  },
  onError: (_e, _v, ctx) => queryClient.setQueryData(docKey, ctx?.prev),
  onSettled: () => queryClient.invalidateQueries({ queryKey: ['collection', slug] }),
})
```

Server-side rendering is wired through the router's `queryClient` context. Route loaders call `ensureQueryData`, so the first paint is server-rendered with data already present; the client hydrates the same cache and continues without a refetch. This gives the admin SSR'd, indexable-by-the-browser-history first loads — something Sanity Studio (a pure client SPA) and Strapi's admin don't do.

A short menu of behaviors we standardize on:

- **Autosave** for drafts debounces a mutation that writes a new version through `@kernel/core`'s version history. See [drafts and versions](../02-data-modeling/10-versioning-drafts-and-autosave.md).
- **Optimistic updates** on single-document edits and on list-row actions (publish, delete), always with rollback in `onError`.
- **`depth`-aware fetching**: relationship and upload fields are populated by setting `depth` in the query, the same control the public APIs expose.
- **TanStack DB** is available as an opt-in for live/offline collections, layering a reactive client store over Query for real-time admin views and collaborative editing surfaces.

## Config-driven UI

This is the heart of the admin and the biggest departure from a hand-built CMS UI. No screen in `@kernel/admin` is written for a specific content type. The admin reads `kernel.config.ts`, walks the field definitions, and renders the matching components from a registry. Add a field to a collection and the edit form, the list column options, and the validation all appear — no admin code to touch.

```ts
// kernel.config.ts
import { defineConfig, collection } from '@kernel/core'

export default defineConfig({
  collections: [
    collection({
      slug: 'posts',
      admin: {
        useAsTitle: 'title',
        defaultColumns: ['title', 'status', 'updatedAt'],
        group: 'Content',
      },
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'slug', type: 'text', unique: true, admin: { position: 'sidebar' } },
        { name: 'body', type: 'richText' },
        { name: 'author', type: 'relationship', relationTo: 'users' },
        { name: 'status', type: 'select', options: ['draft', 'published'] },
      ],
    }),
  ],
})
```

At render time the form layer maps each `field.type` to a component through the field registry. Every field component is bound through TanStack Form, so validation, dirty tracking, and per-field error display are handled by one form engine rather than per-field bespoke wiring.

```ts
// field registry (simplified)
const fieldRegistry: Record<FieldType, FieldComponent> = {
  text: TextField,
  richText: RichTextField,
  relationship: RelationshipField,
  upload: UploadField,
  blocks: BlocksField,
  array: ArrayField,
  // ...custom types merged from config and plugins
}

export function renderField(field: FieldConfig, form: FormApi) {
  const Component = fieldRegistry[field.type] ?? UnknownField
  return <Component field={field} form={form} />
}
```

Escape hatches are first-class, because config-driven rendering only wins if you can override it without forking. Any field can specify `admin.components.Field` to swap in a custom React component, and custom field types register their own renderer through `@kernel/plugin-sdk`. This is the Payload model — config-as-code with component overrides — and KernelCMS keeps the same ergonomics while binding overrides to TanStack Form and TanStack Query rather than Payload's internal state. Sanity's Studio is also config-driven and highly customizable, but its schema lives in GROQ/Sanity-specific structures; KernelCMS field config is plain typed TypeScript that the same config also uses to generate the database schema and the API.

Presentation-only structure (`ui`, `tabs`, `row`, `group`, `collapsible`) is data in the same config tree, so layout is declared alongside fields. Design tokens from `@kernel/ui` drive theming, dark mode, white-labeling, and WCAG 2.2 AA contrast without per-component style overrides — see theming and design tokens.

## Code-splitting strategy

The admin must stay fast even when a project defines fifty collections and a dozen custom field types. The strategy is layered.

**Route-level splitting** comes from TanStack Router. Each route file is its own chunk, lazy-loaded on navigation. The dashboard shell, command palette, and the active route load; nothing else does. A blocking route mask shows the shell instantly while the route chunk and its loader data stream in.

**Field-component splitting** is the high-leverage one. Heavy field types — the block-based rich-text editor from `@kernel/richtext`, the code field's syntax engine, the map control for `point` — are lazily imported by the field registry. A collection with no `richText` field never ships the editor bundle.

```ts
const RichTextField = lazy(() => import('@kernel/richtext/field'))
const CodeField = lazy(() => import('./fields/CodeField'))
```

**Plugin splitting**: components contributed via `@kernel/plugin-sdk` are dynamically imported behind their registry entry, so an installed-but-unused plugin costs nothing on routes that don't render it.

| Layer | Split unit | Trigger |
| --- | --- | --- |
| Routes | One chunk per route file | Navigation (TanStack Router) |
| Field types | `richText`, `code`, `point`, etc. | First render of that field type |
| Plugin components | Per plugin entry | Registry resolves the component |
| Vendor | Editor, charts, date libs | Imported by their feature only |

Long collections and long documents are virtualized with TanStack Virtual rather than split, keeping the DOM bounded regardless of row count. The net effect: initial admin payload tracks the surface you actually open, not the total size of your content model — a meaningful win over Strapi, whose admin bundle grows with installed plugins regardless of the current screen.

## Open questions

- **Per-tenant config in KernelCMS Cloud**: multi-tenant hosting may need the config (and therefore the generated route tree) resolved per request. Whether that's a server-function lookup or a build-per-tenant artifact is undecided.
- **Live preview channel**: whether visual editing drives the preview iframe over TanStack DB's reactive collections or a dedicated postMessage protocol is still being prototyped.
- **Query-key normalization for deep relationships**: deduplicating populated relationship documents across list and doc caches without a normalized cache layer needs validation under realistic `depth` settings.
