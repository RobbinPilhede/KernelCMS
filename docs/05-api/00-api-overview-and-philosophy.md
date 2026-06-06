# API Overview & Philosophy

KernelCMS exposes three coordinated API surfaces — REST, GraphQL, and a fully typed Local/RPC API — that are all generated from the same content config and all execute against one shared operation core. There is no "primary" API with second-class siblings: the surface is a transport choice, not a capability choice. This document explains what each surface is for, how they stay consistent, and how to pick one (or several) per use case.

## The three surfaces at a glance

Every collection and global you declare in `kernel.config.ts` produces all three surfaces automatically. You write the schema once; KernelCMS derives the route table, the GraphQL SDL, and the typed RPC client from it.

```ts
// kernel.config.ts
import { defineConfig } from '@kernel/core'
import { postgres } from '@kernel/db-postgres'

export default defineConfig({
  db: postgres({ url: process.env.DATABASE_URL! }),
  collections: [
    {
      slug: 'posts',
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'slug', type: 'text', unique: true, index: true },
        { name: 'body', type: 'richText' },
        { name: 'author', type: 'relationship', relationTo: 'users' },
        { name: 'status', type: 'select', options: ['draft', 'published'] },
      ],
      versions: { drafts: true, autosave: true },
      access: {
        read: ({ req }) => req.user != null || { status: { equals: 'published' } },
      },
    },
  ],
})
```

From that single definition you get:

| Surface   | Transport                                  | Best for                                          | Type story                          |
| --------- | ------------------------------------------ | ------------------------------------------------- | ----------------------------------- |
| REST      | HTTP + JSON, predictable URLs              | Webhooks, third-party integrations, cURL, no-code | OpenAPI 3.1 schema, generated types |
| GraphQL   | HTTP POST `/graphql`, single endpoint      | Aggregating clients, partial selection, mobile    | Generated SDL + codegen             |
| RPC/Local | TanStack Start server fns (wire) or direct | Your own TS app, the admin panel, SSR, scripts    | End-to-end inference, zero codegen  |

```
                kernel.config.ts (collections, globals, fields)
                                │
                                ▼
                      ┌───────────────────┐
                      │  Operation Core   │  find / findByID / create
                      │  (@kernel/server) │  update / delete / count
                      └───────────────────┘
                       ▲        ▲        ▲
            ┌──────────┘        │        └──────────┐
       @kernel/rest        @kernel/rpc         @kernel/graphql
        (HTTP/JSON)     (TanStack server fns)   (/graphql SDL)
            ▲                   ▲                     ▲
        cURL, webhooks    admin + your TS app    aggregating clients
```

## REST

The REST surface (`@kernel/rest`) maps the operation core onto conventional, guessable URLs. If you have used Payload's REST API, the shape will feel familiar — we keep the same operation vocabulary because it is well-understood — but we generate an OpenAPI 3.1 document for every deployment so the contract is machine-readable rather than prose.

```
GET    /api/posts?where[status][equals]=published&sort=-createdAt&limit=20&depth=1
GET    /api/posts/:id
POST   /api/posts
PATCH  /api/posts/:id
DELETE /api/posts/:id

GET    /api/globals/site-settings
PATCH  /api/globals/site-settings
```

The query language — `where`, `sort`, pagination (`limit`/`page`), and `depth` — is the _same_ language used by GraphQL and RPC, just URL-encoded. `depth` controls relationship population: `depth=0` returns related documents as IDs, `depth=2` populates two levels deep. This is the one knob most REST CMSs get wrong: Strapi requires the verbose `populate` syntax per-request and Sanity has no relationship traversal without GROQ joins, whereas in KernelCMS `depth` is uniform across every surface.

REST is the right call when the consumer is _not_ a TypeScript program: an incoming webhook, a Zapier-style automation, a Go service, or a curl one-liner in a runbook. Because the schema is OpenAPI, you can hand consumers a generated client in any language. Authentication is via the same session cookie or API key bearer token used everywhere else — see [Authentication & Sessions](../06-auth-security/00-authentication.md).

What REST is _not_ good at: avoiding over-fetching. A list endpoint returns every field on every document at the requested `depth`. If your client only needs `title` and `slug`, reach for GraphQL or a `select` clause (see Open questions).

## GraphQL

The GraphQL surface (`@kernel/graphql`) generates a typed schema from your config: one query and mutation set per collection, plus global queries, version/draft queries, and a shared `where` input that mirrors the REST filter language. The endpoint is a single `POST /graphql`.

```graphql
query PublishedPosts {
  Posts(where: { status: { equals: published } }, sort: "-createdAt", limit: 20) {
    docs {
      id
      title
      slug
      author {
        name
      } # relationship populated inline
    }
    totalDocs
    hasNextPage
  }
}
```

GraphQL wins when the client decides the shape of the response. Mobile apps on metered connections, dashboards that stitch several collections into one screen, and federated gateways all benefit from selecting exactly the fields they need in one round trip. This is Sanity's home turf with GROQ — and GROQ is genuinely powerful for projections — but GROQ is a bespoke query language your team must learn and tool around. KernelCMS gives you standard GraphQL, which means every existing client (Apollo, urql, `graphql-request`), every codegen tool, and every developer who already knows the language works on day one.

The generated SDL is stable and introspectable, so `graphql-codegen` produces typed operations for your frontend. Field-level access control is enforced _inside_ the resolvers, not bolted on at the gateway: a field the current user cannot read is stripped from the response (and from introspection where configured), identically to how REST and RPC behave.

## Typed RPC & the Local API

This is the surface that makes KernelCMS TanStack-native, and it is the one we reach for first internally. The Local API is the operation core called **in-process** with full type inference — no HTTP, no serialization, no codegen:

```ts
import { getPayloadClient } from '@kernel/server'

const kernel = await getPayloadClient()

// `post` is fully typed from kernel.config.ts — title: string, status: 'draft' | 'published', ...
const post = await kernel.findByID({
  collection: 'posts',
  id,
  depth: 1,
})

const created = await kernel.create({
  collection: 'posts',
  data: { title: 'Hello', status: 'draft' }, // type error if a required field is missing
})
```

The same operations are exposed _over the wire_ as typed RPC through TanStack Start server functions. The admin panel and any `@kernel/client` consumer call these with end-to-end inference — the client type is derived from the server config, so a field rename in `kernel.config.ts` surfaces as a compile error in your React component, not a runtime 500.

```ts
// In a TanStack Start route or admin component
import { useQuery } from '@tanstack/react-query'
import { kernelRpc } from '@kernel/client'

const { data } = useQuery({
  queryKey: ['posts', { status: 'published' }],
  queryFn: () => kernelRpc.posts.find({ where: { status: { equals: 'published' } } }),
})
// `data.docs[0].title` is typed; no codegen step ran.
```

This is the decisive difference from Payload, Sanity, and Strapi. Payload has a Local API, but its over-the-wire story is REST/GraphQL with separately generated types. Sanity and Strapi have no in-process typed core at all — every call is HTTP. In KernelCMS, RPC and Local are the _same_ code path, so SSR (TanStack Start server functions), background jobs, migration scripts, and the admin UI all share one typed entry point. TanStack Query handles caching and invalidation on the client; see Query Language & Pagination and [The Local API](./03-typed-rpc-and-local-api.md).

## The shared operation core

All three surfaces are thin transport adapters over `@kernel/server`'s operation core. A `find` is the same function whether it arrives by HTTP GET, a GraphQL resolver, or a direct call. That core is where the real work happens, and where the rules live:

1. **Access control** — operation-, document-, and field-level, evaluated server-side.
2. **Validation** — sync, async, and cross-field, run before any write.
3. **Hooks** — `beforeChange`, `afterChange`, `beforeRead`, etc., fire once per operation regardless of surface.
4. **Field transforms** — localization resolution, relationship population by `depth`, richText serialization.
5. **Drafts & versions** — autosave and version history applied uniformly.

Because the pipeline is shared, a `beforeChange` hook that normalizes a slug runs identically whether the document was created via curl, a GraphQL mutation, or `kernel.create()`. Contrast this with systems where REST and GraphQL diverge in subtle ways — the guarantee here is structural, not aspirational.

## Consistency guarantees

These hold across REST, GraphQL, and RPC by construction:

- **One query language.** `where`, `sort`, pagination, and `depth` mean the same thing everywhere. Learn it once.
- **One access model.** A field you cannot read is absent on every surface. There is no "the GraphQL gateway forgot to check authz" class of bug, because authz is in the core, not the transport.
- **One validation pass.** A write rejected by RPC is rejected identically by REST and GraphQL, with the same error structure.
- **One hook timeline.** Side effects fire once, in the same order, per logical operation.
- **One source of truth.** Change a field in `kernel.config.ts` and all three contracts regenerate together; they cannot drift.

```
Same input  →  Same core  →  Same access, validation, hooks  →  Same result
                                    (transport is irrelevant)
```

## Choosing an API surface

| If you are…                                      | Use       | Why                                          |
| ------------------------------------------------ | --------- | -------------------------------------------- |
| Building the admin panel or your own TS app      | RPC/Local | End-to-end types, no codegen, TanStack Query |
| Running SSR / server functions in TanStack Start | Local     | In-process, zero network hop                 |
| Writing a migration or seed script               | Local     | Direct, typed, runs hooks                    |
| Consuming from a non-TS service or webhook       | REST      | Stable URLs, OpenAPI client in any language  |
| Building a mobile app or aggregating dashboard   | GraphQL   | Field selection, one round trip              |
| Integrating a no-code/automation tool            | REST      | Predictable, documented, JSON                |

The honest default: if it is your own TypeScript, use RPC/Local; if it is someone else's system, use REST; if the client needs to shape the payload, use GraphQL. You are never locked in — the surfaces coexist on the same deployment and the same data.

## Open questions

- **`select` clause for REST.** GraphQL handles partial selection natively; a `?select=title,slug` projection for REST and RPC is desirable but the interaction with `depth` and field-level access needs nailing down.
- **GraphQL subscriptions vs. TanStack DB.** Live data may be better served by `@kernel/db` reactive collections than by GraphQL subscriptions. Whether we ship subscriptions at all is undecided.
- **RPC batching.** Whether to expose a batched multi-operation RPC call (transactional) or rely on per-operation calls with TanStack Query deduplication.
- **OpenAPI for the Cloud-managed CDN.** How the global content CDN surfaces cache headers and stale-while-revalidate semantics through the REST contract.
