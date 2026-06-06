# Typed RPC & Local API

KernelCMS exposes one operation core — `create`, `find`, `findByID`, `update`, `delete`, and their global counterparts — and surfaces it three ways: in-process as the **Local API**, over the wire as **typed RPC** via TanStack Start server functions, and as the generated [REST](./01-rest-api.md) and [GraphQL](./02-graphql-api.md) endpoints. The Local API is the privileged, zero-serialization path you call from server code; the typed RPC layer is that same path projected to the browser with full type inference and no hand-written client. This document specifies all three and the inference machine that makes them feel like ordinary function calls.

## The Local API surface

The Local API is a single object, `kernel`, returned by `getKernel()` (or injected into server-function context). Every method is fully typed against your `kernel.config.ts`. Collection slugs, field names, `where` operators, populated relationship shapes, and localization all flow from the config — there is no separate generated SDK to keep in sync.

```ts
// app/server/posts.ts
import { getKernel } from '@kernel/server'

const kernel = await getKernel()

// Typed: collection is 'posts', `where` only allows real fields,
// the result is Post with `author` populated to User at depth 1.
const { docs, totalDocs, hasNextPage } = await kernel.find({
  collection: 'posts',
  where: { status: { equals: 'published' }, 'author.role': { equals: 'editor' } },
  sort: '-publishedAt',
  depth: 1,
  limit: 20,
  locale: 'en',
})

const post = await kernel.create({
  collection: 'posts',
  data: { title: 'Adapters, not lock-in', author: editor.id, status: 'draft' },
})
```

The operation set is deliberately small and uniform. Every collection method takes the same option bag and shares one query language — `where`, `sort`, pagination, `depth`, `locale`, and `fallbackLocale`. Globals collapse pagination away since they are singletons.

| Method                            | Target     | Returns                | Notes                                                                                    |
| --------------------------------- | ---------- | ---------------------- | ---------------------------------------------------------------------------------------- |
| `find`                            | collection | `PaginatedDocs<T>`     | `where` / `sort` / `limit` / `page` / `depth`                                            |
| `findByID`                        | collection | `T`                    | `disableErrors` returns `null` instead of throwing                                       |
| `create`                          | collection | `T`                    | runs validation + `beforeChange` hooks                                                   |
| `update`                          | collection | `T` or `BulkResult<T>` | by `id` or by `where` for bulk                                                           |
| `delete`                          | collection | `T` or `BulkResult<T>` | by `id` or by `where`                                                                    |
| `count`                           | collection | `{ totalDocs }`        | cheap existence/size checks                                                              |
| `findGlobal`                      | global     | `G`                    | `slug` + `depth` + `locale`                                                              |
| `updateGlobal`                    | global     | `G`                    | partial `data` merge                                                                     |
| `findVersions` / `restoreVersion` | both       | version records        | pairs with [drafts & versions](../02-data-modeling/10-versioning-drafts-and-autosave.md) |
| `auth.*`                          | —          | sessions/users         | login, refresh, me, via @kernel/auth                                                     |

Two flags govern how privileged a call is. `overrideAccess` (default `true` for in-process calls, `false` for anything originating from an HTTP/RPC boundary) bypasses [access control](../06-auth-security/01-authorization-and-access-control.md). `user` carries the acting principal so that document- and field-level access, `createdBy`, and audit metadata resolve correctly. This is the single most important difference from Sanity, whose `@sanity/client` always speaks to a remote API and always serializes; the Local API runs the same code Sanity would run on its servers, in your process, with no round trip.

```ts
// Run as a specific user, enforcing their access rules.
await kernel.update({
  collection: 'posts',
  id,
  data: { status: 'published' },
  user: req.user,
  overrideAccess: false, // field-level write rules now apply
})
```

### Hooks, transactions, and depth

Local API calls are not thin DB wrappers. Each runs the full pipeline: access evaluation, field validation (sync, async, cross-field), `beforeValidate` → `beforeChange` → DB write → `afterChange` → `afterRead` hooks, and relationship population to the requested `depth`. Multi-document work runs inside a single adapter transaction:

```ts
await kernel.transaction(async (tx) => {
  const order = await tx.create({ collection: 'orders', data })
  await tx.update({ collection: 'inventory', id: sku, data: { qty: { decrement: 1 } } })
  return order // commits on resolve, rolls back on throw
})
```

Payload pioneered this in-process Local API and it is the model KernelCMS extends; the difference is that KernelCMS threads the _same_ types out to the client over RPC, which Payload's Local API cannot do because it is server-only.

## TanStack Start server functions

The wire transport is not a bespoke RPC framework. It is TanStack Start `createServerFn`. KernelCMS generates one server function per operation, registers them with the Start server, and the admin and `@kernel/client` consume them through TanStack Query. The browser never sees SQL, never sees an adapter, and never sees a manually maintained fetch client.

```
 Browser (admin / @kernel/client)
   │  useQuery / useMutation  (TanStack Query)
   ▼
 createServerFn('POST', kernel.find)      ← TanStack Start server function
   │  validator(input)  → boundary: overrideAccess=false, user=session
   ▼
 Local API operation core  (hooks, access, validation, depth)
   │
   ▼
 Adapter → Drizzle / Mongo → database
```

A generated server function is roughly:

```ts
// generated: app/server/rpc/posts.find.ts
import { createServerFn } from '@tanstack/react-start'
import { findInput } from '@kernel/rpc/validators'
import { getKernel, getSession } from '@kernel/server'

export const postsFind = createServerFn({ method: 'POST' })
  .validator(findInput('posts')) // zod schema derived from the collection config
  .handler(async ({ data }) => {
    const kernel = await getKernel()
    const user = await getSession()
    // boundary defaults: access enforced, acting user attached
    return kernel.find({ ...data, collection: 'posts', user, overrideAccess: false })
  })
```

The crucial property: the boundary flips `overrideAccess` to `false` and binds `user` from the verified session. You cannot accidentally ship an un-authorized endpoint, because the _only_ way content leaves the process over RPC is through a server function whose handler already applied access control. This is server-side-by-default in the literal sense — there is no public Local API.

`@kernel/client` wraps these with a typed proxy so application frontends get the same ergonomics as the admin:

```ts
import { createClient } from '@kernel/client'
import type { Kernel } from './kernel.config' // the inferred config type

const client = createClient<Kernel>({ url: '/api/rpc' })

const { docs } = await client.find('posts', { where: { status: { equals: 'published' } } })
//      ^ Post[] — inferred, including populated relationships at the requested depth
```

Strapi requires you to learn its REST/GraphQL plugin conventions and write fetch calls by hand or lean on a community SDK; the types are bolted on afterward and drift. KernelCMS derives the client signature _from the same config object_ that defines the schema, so a renamed field is a compile error in the frontend, not a 200 with a missing key.

### Caching and invalidation

Because every read flows through TanStack Query, cache keys are structured and invalidation is precise. The convention is `[collection, operation, args]`, and mutations invalidate by collection plus document id.

```ts
const qc = useQueryClient()
const publish = useMutation({
  mutationFn: (id: string) => client.update('posts', { id, data: { status: 'published' } }),
  onSuccess: (doc) => {
    qc.invalidateQueries({ queryKey: ['posts', 'find'] })
    qc.setQueryData(['posts', 'findByID', doc.id], doc)
  },
})
```

For live and offline admin views, the same operations back optional [TanStack DB](../04-admin-ui/10-live-preview-and-visual-editing.md) collections, so a server-function mutation can optimistically patch a reactive client collection and reconcile on the server response.

## In-process, no-HTTP access

The Local API does not open a socket, does not serialize to JSON, and does not pass through a router. When you call `kernel.find()` from a server function, a TanStack Start loader, a queue worker, a migration, or a cron job, you invoke the operation core directly. This matters for three concrete reasons.

- **Latency.** No localhost HTTP hop, no JSON encode/decode of large documents, no re-parsing of `Date`/`Buffer` into strings. A `depth: 2` document with nested arrays stays as live objects the whole way.
- **Fidelity.** Values keep their real types. A `point` field is a tuple, a `date` is a `Date`, an `upload` carries its resolved file object — none of it is flattened to wire-safe primitives and rehydrated.
- **Composition.** Server functions, [REST](./01-rest-api.md) handlers, and [GraphQL](./02-graphql-api.md) resolvers are all _thin shells_ over the same Local API call. There is exactly one place where business logic lives.

```
                 ┌───────────── one operation core ─────────────┐
 REST handler ───►                                              │
 GraphQL resolver►   kernel.find / create / update / delete  ───► Adapter
 RPC server fn ──►                                              │
 your server code►                                             │
                 └───────────────────────────────────────────────┘
```

This is the inverse of Sanity, where everything is a remote API call by design — even server-side code talks to api.sanity.io. KernelCMS gives you Sanity-style portability (self-host or [KernelCMS Cloud](../10-cloud-operations/00-deployment-models-self-host-vs-cloud.md), content always portable) without making your own backend pay a network tax to read its own data.

A practical use: a seed or migration script reuses validation and hooks rather than writing raw rows.

```ts
// scripts/seed.ts
const kernel = await getKernel()
for (const row of fixtures) {
  await kernel.create({ collection: 'authors', data: row, overrideAccess: true })
}
```

## Type inference end to end

Inference starts at `kernel.config.ts` and never breaks. `defineConfig` captures literal field types and slugs; `@kernel/core` derives a `GeneratedTypes` map; the Local API, the RPC validators, and `@kernel/client` all read from that one map.

```ts
// kernel.config.ts
import { defineConfig, collection, fields } from '@kernel/core'

export default defineConfig({
  collections: [
    collection('posts', {
      fields: [
        fields.text('title', { required: true }),
        fields.select('status', { options: ['draft', 'published'] as const }),
        fields.relationship('author', { to: 'users' }),
        fields.richText('body'),
      ],
    }),
  ],
})

export type Kernel = typeof config // consumed by @kernel/client and generated types
```

The flow:

```
kernel.config.ts ──(defineConfig)──► GeneratedTypes
        │                                  │
        │                                  ├─► kernel.find<'posts'>(...) : Post
        │                                  ├─► findInput('posts')        : zod schema
        │                                  └─► client.find('posts', ...) : Post[]
        └──(kernel generate:types)──► kernel.d.ts (optional emit for fast IDE)
```

Two inference rules make `depth` and localization honest. Increasing `depth` changes a relationship field's static type from `string` (the id) to the populated document; setting a `locale` collapses localized fields from `{ [locale]: T }` to `T`.

```ts
const a = await kernel.findByID({ collection: 'posts', id, depth: 0 })
//    a.author : string                 — id only
const b = await kernel.findByID({ collection: 'posts', id, depth: 1 })
//    b.author : User                   — populated
```

Run `kernel generate:types` in CI to emit `kernel.d.ts` for faster editor performance and to fail the build when config and code disagree. Unlike Strapi's `strapi ts:generate-types`, which types the data layer but not a typed client, KernelCMS's emitted types are the _same_ types the RPC client and server functions enforce — one source, three surfaces.

| Concern                    | Payload           | Sanity             | Strapi                    | KernelCMS                  |
| -------------------------- | ----------------- | ------------------ | ------------------------- | -------------------------- |
| In-process Local API       | Yes (server-only) | No (always remote) | Partial (`entityService`) | Yes                        |
| Typed client over the wire | Limited           | GROQ, weak types   | Community SDKs            | Generated, fully typed RPC |
| Same types client + server | No                | No                 | No                        | Yes, from one config       |
| Transport                  | Express           | HTTP API           | HTTP API                  | TanStack Start server fns  |

## Open questions

- **Batch/streaming RPC.** Whether to expose a `kernel.batch([...])` server function that pipelines multiple operations in one round trip and one transaction, versus relying on TanStack Query request deduplication. Leaning toward an explicit batch endpoint for list-then-hydrate flows.
- **Selective field projection.** A `select`/`fields` option to trim payloads (GROQ-style) would cut RPC size, but complicates the inferred return type. Open question is whether the inference cost is worth it or whether `depth` plus collection design covers most cases.
- **Server-function codegen vs. single dispatcher.** Emitting one server function per operation gives clean stack traces and per-route caching; a single generic dispatcher is simpler to maintain. Current lean is per-operation generation with a shared handler factory.
