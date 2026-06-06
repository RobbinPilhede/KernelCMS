# GraphQL API

KernelCMS generates a complete, type-safe GraphQL schema from your content config at boot. Every collection, global, field type, localization, draft, and access rule maps to GraphQL types, queries, and mutations through the `@kernel/graphql` package, which is a thin presentation layer over the same operation core that powers REST and the Local API. There is no separate GraphQL data model to maintain, no resolver boilerplate to write, and no drift between what the admin panel can do and what the GraphQL endpoint exposes. This document specifies how the schema is built, the shape of the generated operations, the cost-control limits that keep the endpoint safe, and where KernelCMS deliberately diverges from Strapi and Payload.

## Schema generation

The schema is derived from `kernel.config.ts` during server initialization. `@kernel/graphql` walks the resolved collection and global definitions, maps each field to a GraphQL type, and assembles the root `Query` and `Mutation` types. The mapping is deterministic — the same config always produces the same schema — which means the SDL can be snapshotted, committed, and diffed in CI to catch breaking changes before they ship.

```ts
// kernel.config.ts
import { defineConfig } from '@kernel/core'
import { graphql } from '@kernel/graphql'
import { postgres } from '@kernel/db-postgres'

export default defineConfig({
  db: postgres({ url: process.env.DATABASE_URL }),
  plugins: [
    graphql({
      // mount point for the HTTP handler (TanStack Start server route)
      path: '/api/graphql',
      // expose GraphiQL in non-production only
      playground: process.env.NODE_ENV !== 'production',
      maxDepth: 8,
      maxComplexity: 1000,
      // emit SDL on build for snapshot testing / client codegen
      schemaOutput: './generated/schema.graphql',
    }),
  ],
  collections: [Posts, Authors, Media],
  globals: [SiteSettings],
})
```

Field types map onto GraphQL as follows. The left column is the KernelCMS field `type`; the right is what lands in the SDL.

| Field type        | GraphQL type                                  |
|-------------------|-----------------------------------------------|
| `text`, `email`, `code`, `textarea` | `String`                    |
| `number`          | `Float` (or `Int` when `step: 1` is declared) |
| `boolean`, `checkbox` | `Boolean`                                 |
| `date`            | `DateTime` (custom scalar)                     |
| `json`            | `JSON` (custom scalar)                         |
| `point`           | `GeoPoint` object type                         |
| `select`, `radio` | generated `enum` from the declared options     |
| `relationship`    | the related collection's type (or a union for poly-relations) |
| `upload`          | the upload collection's type (e.g. `Media`)    |
| `richText`        | `JSON` scalar plus an optional `_html` resolver |
| `array`           | a generated `[<Field>Item!]` object type list  |
| `blocks`          | a generated union of block object types        |
| `group`, `row`, `tabs` | inlined object types (presentational containers collapse) |
| `ui`              | omitted — presentational only, no schema output |

Localized fields are exposed two ways. Reading a single locale uses the `locale` argument on the query; reading every translation at once uses the generated `<Field>_locales` sub-selection. This mirrors the locale model documented in [Localization](../02-data-modeling/09-localization-and-i18n.md) and avoids the Strapi pattern of forcing a separate entry per locale.

```graphql
type Post {
  id: ID!
  title(locale: LocaleInputType, fallback: Boolean): String
  title_locales: PostTitleLocales        # { en: "...", de: "...", fr: "..." }
  status: Post_status                     # generated enum
  author(depth: Int): Author              # relationship resolved on demand
  body: JSON                              # richText
  createdAt: DateTime!
  updatedAt: DateTime!
}
```

```
kernel.config.ts ──► @kernel/core (resolve) ──► @kernel/graphql (build)
                                                     │
        collections + globals + fields              ▼
                                          ┌──────────────────────┐
                                          │ GraphQLSchema         │
                                          │  Query / Mutation     │
                                          │  scalars, enums       │
                                          │  object & union types │
                                          └──────────┬───────────┘
                                                     ▼
                                  TanStack Start server route (/api/graphql)
```

Access control is compiled into the schema generation step, not bolted on at request time as an afterthought. Field-level access rules become resolver guards; operation-level rules gate whole queries and mutations. A field a user cannot read resolves to `null` with an authorization extension on the error path rather than leaking through. See [Access Control](../06-auth-security/01-authorization-and-access-control.md) for the evaluation order.

## Queries and mutations

For every collection, `@kernel/graphql` emits a predictable set of root fields. A collection named `Posts` (singular `Post`) produces:

| Operation        | Root field          | Returns                         |
|------------------|---------------------|---------------------------------|
| Find one by ID   | `Post(id: ID!)`     | `Post`                          |
| Find many        | `Posts(...)`        | `Posts` (paginated wrapper)     |
| Count            | `countPosts(...)`   | `Int`                           |
| Drafts/versions  | `versionPost(id)`   | `PostVersion`                   |
| Create           | `createPost(data:)` | `Post`                          |
| Update           | `updatePost(id, data:)` | `Post`                      |
| Delete           | `deletePost(id:)`   | `Post`                          |

The `where`, `sort`, `limit`, `page`, and `depth` arguments are the same shared query language used across REST, RPC, and the Local API — there is one operator vocabulary to learn, documented in Query Language. The `where` input is a generated type with one field per queryable column plus the logical `and` / `or` / `not` combinators.

```graphql
query PublishedPosts($q: String!) {
  Posts(
    where: {
      and: [
        { status: { equals: published } }
        { title: { contains: $q } }
        { author: { equals: "auth_123" } }
      ]
    }
    sort: "-publishedAt"
    limit: 20
    page: 1
    depth: 1
  ) {
    docs {
      id
      title(locale: en)
      author { name }
    }
    totalDocs
    totalPages
    hasNextPage
  }
}
```

Mutations accept a generated `data` input type that strips read-only and `ui` fields. They run the identical hooks, validation, and access pipeline as `payload`-style Local API calls — there is no second code path. Drafts are first-class: passing `draft: true` writes to the version table without touching the published row, and `Posts(draft: true)` reads the latest draft. This is the same machinery described in [Drafts & Versions](../02-data-modeling/10-versioning-drafts-and-autosave.md).

```graphql
mutation Publish($id: ID!, $body: JSON!) {
  updatePost(id: $id, draft: false, data: { status: published, body: $body }) {
    id
    status
    updatedAt
  }
}
```

Globals get a matching pair — `SiteSettings` to read and `updateSiteSettings` to write — with no `find`/`create`/`delete`, since singletons have exactly one row. Auth-enabled collections additionally emit `me`, `login`, `logout`, and `refreshToken` operations from `@kernel/auth`.

## Depth and complexity limits

An auto-generated schema with relationships is an open invitation to abusive queries — deeply nested selections, recursive relationship traversal, and unbounded list pagination can each turn one request into thousands of database round-trips. KernelCMS enforces three independent limits, all configurable, all on by default.

**Depth limit.** The `depth` argument controls how many relationship levels are *resolved* (a post → its author → the author's avatar is depth 2). Independently, `maxDepth` caps the *selection-set nesting* the parser will accept, rejecting pathological queries before any resolver runs. The two are distinct: `depth` is a data-shaping knob; `maxDepth` is a safety ceiling.

**Query complexity.** Every field carries a cost. Scalars cost 1, object fields cost 1, and list fields multiply their child cost by the requested `limit` (defaulting to a configured page size when absent). The summed cost is checked against `maxComplexity` during validation, before execution.

```
cost(Posts(limit: 20) { author { avatar { url } } })
  = 20 × ( author(1) + avatar(1) + url(1) ) = 60
```

**Rate limiting.** The HTTP handler applies the same per-IP and per-token rate limits as the REST surface, with stricter buckets on mutations and auth operations.

```ts
graphql({
  maxDepth: 8,            // reject selection sets nested deeper than 8
  maxComplexity: 1000,    // reject queries whose computed cost exceeds 1000
  defaultLimit: 25,       // assumed list size when `limit` is omitted, for costing
  maxLimit: 200,          // hard ceiling on any single list request
  disableIntrospection: process.env.NODE_ENV === 'production',
})
```

When a limit is exceeded the request fails validation with a typed error in `extensions.code` (`QUERY_TOO_DEEP`, `QUERY_TOO_COMPLEX`, `LIMIT_EXCEEDED`) so clients can react programmatically. Relationship resolution is automatically dataloader-batched per request, collapsing the classic N+1 fan-out into one query per relationship level.

## Comparison to Strapi and Payload GraphQL

All three CMSs generate GraphQL from content models, but the guarantees differ.

| Concern                | Strapi                                   | Payload                                  | KernelCMS                                              |
|------------------------|------------------------------------------|------------------------------------------|--------------------------------------------------------|
| GraphQL is             | a plugin (`@strapi/plugin-graphql`)      | built-in, generated                      | `@kernel/graphql` over the shared operation core       |
| Same code path as REST | no — separate resolver layer             | shared core                              | yes — identical hooks, validation, access              |
| Depth limit            | configurable                             | configurable                             | depth **and** independent `maxDepth` ceiling           |
| Complexity costing     | manual via add-on                        | not built in                             | built in, list-aware                                   |
| Localization           | per-locale entries, `locale` arg         | localized fields, `locale` arg           | `locale` arg **plus** `<field>_locales` block          |
| End-to-end types       | codegen against runtime schema           | generated TS types                       | SDL emitted at build + `@kernel/client` typed RPC      |
| Introspection in prod  | on by default                            | configurable                             | off by default                                         |

Strapi treats GraphQL as an optional plugin with its own resolver layer, so behavior can drift from the REST controllers and the admin — a field policy fixed in one place is not automatically fixed everywhere. Payload is much closer to the KernelCMS model: GraphQL, REST, and Local API share a core, and types are generated. KernelCMS pushes further on three fronts — a list-aware complexity budget rather than depth-only protection, the `<field>_locales` ergonomic for fetching every translation in one round-trip, and a build-time SDL artifact that drops straight into [`@kernel/client`](./03-typed-rpc-and-local-api.md) and any GraphQL codegen pipeline. Because the schema is a pure function of config, schema review happens in pull requests against a committed `schema.graphql` rather than in a running instance.

## Open questions

- Should `blocks` fields default to a GraphQL `union` (precise, but verbose for clients) or a single `JSON` scalar (simpler, untyped), with the other behind a flag?
- Persisted queries / APQ: ship in `@kernel/graphql` core, or leave to the deployment layer and CDN?
- Whether `maxComplexity` should support per-collection or per-role overrides, or stay a single global ceiling for predictability.
