# TanStack Stack Integration

KernelCMS is built on TanStack from the ground up — not as a UI veneer over a conventional Node backend, but as the actual runtime, router, and data layer for both the API host and the admin application. This is the wedge: Payload ships a custom Express/Next hybrid, Sanity runs a proprietary hosted datastore with its own React admin, and Strapi is a Koa server with a Webpack-bundled admin. None of them share a single, type-safe primitive set across server and client. KernelCMS does. This document specifies exactly which TanStack library owns which concern, where it runs, and why we chose it over the alternative each competitor reaches for.

## The stack at a glance

```
                 ┌──────────────────────────────────────────────┐
                 │              TanStack Start                    │
                 │   SSR · server functions · file-based routes   │
                 └───────────────┬───────────────┬────────────────┘
                                 │               │
                  admin app ◄────┘               └────► API host
                     │                                     │
   ┌─────────────────┼──────────────────┐        ┌─────────┴──────────┐
   │ Router  Query   │  Table  Form      │        │  RPC server fns     │
   │ Store   Virtual │  DB (optional)    │        │  (typed Local API)  │
   └─────────────────┴──────────────────┘        └────────────────────┘
```

| Library          | Where it runs            | Owns                                                    |
| ---------------- | ------------------------ | ------------------------------------------------------- |
| TanStack Start   | server + admin           | SSR, server functions, the route tree for both surfaces |
| TanStack Router  | admin                    | Type-safe routing and search-param state                |
| TanStack Query   | admin + `@kernel/client` | All data fetching, caching, invalidation                |
| TanStack Table   | admin                    | Collection list views                                   |
| TanStack Form    | admin                    | Document edit forms and field binding                   |
| TanStack Store   | admin                    | Lightweight reactive UI state                           |
| TanStack Virtual | admin                    | Virtualized lists and long documents                    |
| TanStack DB      | admin + frontends        | Optional reactive client-side collections               |

## TanStack Start: SSR and server functions

Start is the host. The same Start application serves the rendered admin panel _and_ exposes the API, so there is exactly one process model to deploy, one router, and one way to write a backend operation. See Self-Host Deployment for the Node/Bun/edge runtime matrix.

Server functions are the mechanism. Every operation in the Local API — `create`, `find`, `findByID`, `update`, `delete` — is a plain async function that runs in-process with full type inference. Start's `createServerFn` is what exposes that same operation over the wire as typed RPC, so the client calls it as if it were local. This is the core type-safety claim: there is no hand-written OpenAPI client, no codegen step between server and admin, and no `any` at the boundary.

```ts
// @kernel/rpc — every operation is a Start server function
import { createServerFn } from '@kernel/server'
import { resolveCollection } from '@kernel/core'

export const find = createServerFn({ method: 'POST' })
  .validator((input: FindArgs) => findSchema.parse(input))
  .handler(async ({ data, context }) => {
    const collection = resolveCollection(data.collection)
    await collection.access.read(context) // server-side, always
    return collection.operations.find(data) // shared op core
  })
```

REST and GraphQL are generated from the same content config and call the same operation core; they are alternate transports, not parallel implementations. Compare Payload, where the Local API and REST handlers share logic but the client must still be generated separately, and Strapi, where the REST/GraphQL layers wrap a service layer you cannot call with end-to-end types from a React app. In KernelCMS the admin imports the operation's _types_ directly from `@kernel/core`, and TanStack Start guarantees the runtime payload matches.

SSR matters for the admin because the first paint of a document edit view should arrive with data, not a spinner. Start streams the route's loader output, and Query rehydrates it on the client (see below). Sanity's Studio is a pure SPA that boots empty and fetches; we render the list and document shells server-side.

## TanStack Router

Router owns the admin's URL space. Routes are file-based and fully typed, which means `/collections/$collection/$id` is not a string you assemble by hand — it is a typed `Link` with checked params. This eliminates an entire class of broken-link bugs that Strapi's admin (React Router with untyped params) ships with.

The decisive feature is **search-param state as a typed schema**. Collection list filters, sort, pagination, and column visibility live in the URL, validated and parsed by Router. A filtered, sorted view is therefore shareable and bookmarkable, and the back button works.

```ts
// admin route: collection list with typed search params
export const Route = createFileRoute('/collections/$collection/')({
  validateSearch: (s): ListSearch => listSearchSchema.parse(s),
  loaderDeps: ({ search }) => ({ where: search.where, sort: search.sort, page: search.page }),
  loader: ({ deps, params }) => client.collections[params.collection].find({ ...deps, depth: 0 }),
})
```

Because `loaderDeps` derives from validated search params, changing a filter is a URL change, which re-runs the loader, which calls the same `where`/`sort`/`pagination` query language used by REST, GraphQL, and RPC. One query language, one source of truth, surfaced directly in the address bar.

## TanStack Query

Query is the only data-fetching layer in the admin and in `@kernel/client`. Loaders prime the cache during SSR; components read from it with `useQuery`/`useSuspenseQuery`; mutations invalidate by key.

The query-key convention mirrors the operation surface, so invalidation is mechanical rather than guesswork:

```ts
const keys = {
  collection: (slug: string) => ['collection', slug] as const,
  doc: (slug: string, id: string) => ['collection', slug, id] as const,
}

// after update, invalidate the document and any list it appears in
await client.collections.posts.update({ id, data })
queryClient.invalidateQueries({ queryKey: keys.collection('posts') })
```

This replaces the bespoke caching each competitor reinvents — Payload's admin leans on React state and manual refetch, Strapi uses Redux with hand-written thunks. Query gives us request deduplication, stale-while-revalidate, optimistic updates, and offline retry for free, and the same client ships to end-user frontends via `@kernel/client` so a Next.js or TanStack Start site gets identical caching semantics. See Query Language and APIs for how `depth` and `where` flow through these keys.

## TanStack Table and Form

These two libraries carry the two screens an editor lives in: the list and the document.

### Table — collection list views

Every collection list is a TanStack Table instance. Sorting, column filtering, column sizing, and visibility are headless and driven by config. Crucially, Table's row model is paired with Virtual (below) so a collection with 200k documents renders only the visible rows. The sort and filter state is _not_ component-local — it is lifted into Router search params, so Table state, the URL, and the server query stay in lockstep.

```ts
// columns derive from the collection's field config in kernel.config.ts
const columns = collection.admin.defaultColumns.map((name) =>
  columnHelper.accessor(name, {
    header: collection.fields[name].label,
    enableSorting: collection.fields[name].sortable ?? true,
  }),
)
```

Strapi and Payload both ship fixed list tables with bolt-on column config; ours is a real headless table, so a plugin can supply a custom cell renderer or an entirely custom list view without forking the admin.

### Form — document edit forms

Every document edit view is a TanStack Form instance. Each field type (`text`, `relationship`, `array`, `blocks`, `richText`, `tabs`, …) maps to a Form-bound field component, and validation runs per field — sync, async, and cross-field — using the same validators declared in config. Field-level localization and access control hook into the same binding: a field the current user cannot edit is rendered read-only by the same access result the server enforces.

```ts
const form = useKernelForm({
  collection: 'posts',
  defaultValues: doc,
  onSubmit: ({ value }) => client.collections.posts.update({ id: doc.id, data: value }),
})

// per-field binding with the field's own validator
<form.Field name="slug" validators={{ onBlur: slugValidator }}>
  {(field) => <TextField field={field} locale={activeLocale} />}
</form.Field>
```

Validation on blur, not on every keystroke; loading, error, and saved states on every async field. Autosave writes drafts through the same mutation path, feeding version history. Payload's form layer is custom React context; Sanity's is its own patch-based system tied to its datastore. TanStack Form gives us a standard, testable binding model that plugin authors already know.

## TanStack Store, Virtual, and DB

### Store — reactive admin UI state

Store holds the small, cross-cutting UI state that does not belong in the URL or the server cache: command-palette open state, the active locale, sidebar collapse, unsaved-changes guards, theme. It is reactive and granular, so toggling the locale re-renders only the fields that read it. We deliberately keep Store thin — anything cacheable belongs to Query, anything shareable belongs to Router.

```ts
export const uiStore = new Store({
  paletteOpen: false,
  activeLocale: 'en',
  theme: 'system' as Theme,
})
```

### Virtual — long lists and long documents

Virtual backs two things: the collection list (with Table) and long documents. A document with a 500-item `array` field or a `blocks` field with hundreds of blocks only mounts the blocks in view. This is what keeps the editor responsive on real content; Sanity's Studio degrades on very long documents precisely because it lacks this.

### DB — optional reactive client collections

TanStack DB is opt-in. When enabled, it provides client-side reactive collections for live and offline admin, and for end-user frontends that want live content without writing socket code. It sits in front of Query as a normalized, queryable store that updates from a sync stream.

```ts
// kernel.config.ts — opt into live/offline collections
export default defineKernelConfig({
  admin: {
    liveCollections: {
      adapter: tanstackDB({ sync: 'electric' }),
      collections: ['posts', 'media'],
    },
  },
})
```

No competitor offers a first-party, type-safe offline/live admin layer. This is where the TanStack-native bet compounds: the same `where`/`sort` query language the server speaks is the one DB evaluates on the client.

## Open questions

- **TanStack DB sync transport.** Electric SQL is the leading candidate for the sync stream, but a native WebSocket adapter over the RPC layer would avoid a second infrastructure dependency. Undecided pending load testing against multi-tenant Cloud.
- **SSR boundary for the richtext editor.** The block-based editor (`@kernel/richtext`) is heavy; whether to SSR its read-only render and hydrate lazily, or skip SSR entirely for the edit surface, is still open.
- **Store vs. Router for transient filter drafts.** Filters being typed mid-edit (before "apply") could live in Store to avoid URL thrash, then commit to Router on apply. Needs a UX decision before we lock the contract.
