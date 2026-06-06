# REST API

KernelCMS generates a complete REST API from your content config the moment you define a collection or global in `kernel.config.ts`. There is no codegen step, no separate route file, and no GraphQL-only escape hatch you have to fall back to. Every collection gets a predictable set of CRUD endpoints, every global gets a singleton endpoint, and all of them share one query language for `where`, `sort`, pagination, and relationship `depth`. The REST layer lives in `@kernel/rest` and is mounted by `@kernel/server` on top of TanStack Start server functions, so it runs in the same process as the Local API and shares the exact same operation core — REST is a thin, well-specified HTTP shell over `payload`-style operations, not a parallel implementation.

## Where REST sits in the stack

REST is one of three wire surfaces over a single operation core. The Local API (`@kernel/client` in-process), typed [RPC](./03-typed-rpc-and-local-api.md), [GraphQL](./02-graphql-api.md), and REST all funnel into the same `find`, `findByID`, `create`, `update`, and `delete` operations, which enforce the same access control, hooks, and validation.

```
                 ┌──────────────────────────────────────┐
  HTTP client →  │  @kernel/rest  (route + query parse)  │
  RPC caller  →  │  @kernel/rpc   (TanStack server fns)  │
  GraphQL     →  │  @kernel/graphql                      │
  in-process  →  │  @kernel/client (Local API)           │
                 └───────────────────┬──────────────────┘
                                     │  one operation core
                          find / findByID / create / update / delete
                                     │
                         access control · hooks · validation
                                     │
                         @kernel/db adapter (Drizzle / Mongo)
```

This is the same architectural bet Payload makes — its REST and GraphQL APIs wrap a shared Local API. KernelCMS goes further by making the in-process surface a first-class typed RPC over TanStack Start server functions, so the admin app never pays an HTTP round-trip it doesn't need, while external integrators get the same semantics over REST. Strapi, by contrast, has historically maintained REST and GraphQL as semi-divergent layers with subtly different filtering syntax; we refuse that split. Sanity exposes a query-language-first HTTP API (GROQ over a single endpoint) — powerful, but it pushes a bespoke query language onto every consumer. KernelCMS keeps REST resource-shaped and conventional, and reserves the richer query surface for `where`.

## Endpoint shape

All REST routes are served under a configurable base path, `/api` by default, set in `kernel.config.ts`:

```ts
import { defineConfig } from '@kernel/core'
import { postgres } from '@kernel/db-postgres'

export default defineConfig({
  db: postgres({ url: process.env.DATABASE_URL! }),
  routes: {
    rest: '/api', // mount point for @kernel/rest
  },
  collections: [
    {
      slug: 'posts',
      labels: { singular: 'Post', plural: 'Posts' },
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'status', type: 'select', options: ['draft', 'published'] },
        { name: 'author', type: 'relationship', relationTo: 'users' },
      ],
      versions: { drafts: true },
    },
  ],
  globals: [
    {
      slug: 'site-settings',
      fields: [{ name: 'siteName', type: 'text', required: true }],
    },
  ],
})
```

The `slug` is the URL segment. Collections are plural resources; globals are singletons. There is one canonical shape, and it does not change between SQL and MongoDB adapters:

| Resource | URL pattern | Notes |
|----------|-------------|-------|
| Collection list | `/api/{collection}` | Paginated, filterable |
| Collection document | `/api/{collection}/{id}` | `id` is the document primary key |
| Collection count | `/api/{collection}/count` | Returns total matching `where` |
| Global | `/api/globals/{global}` | Singleton, no `id` |
| Upload file | `/api/{collection}/{id}/file/{filename}` | Served by `@kernel/storage` |

IDs are whatever the adapter uses: an auto-incrementing integer or UUID under Drizzle SQL (`@kernel/db-postgres`, `@kernel/db-sqlite`, `@kernel/db-mysql`), an ObjectId string under `@kernel/db-mongodb`. The REST layer treats `id` as an opaque string in the path and lets the adapter coerce it.

## CRUD routes

Each collection gets the full set. Globals get only read and update, because a singleton can be neither created nor deleted through the API.

| Operation | Method | Path | Body | Success |
|-----------|--------|------|------|---------|
| List | `GET` | `/api/posts` | — | `200` paginated envelope |
| Read one | `GET` | `/api/posts/:id` | — | `200` document |
| Count | `GET` | `/api/posts/count` | — | `200 { totalDocs }` |
| Create | `POST` | `/api/posts` | document | `201` created document |
| Replace/Update | `PATCH` | `/api/posts/:id` | partial document | `200` updated document |
| Bulk update | `PATCH` | `/api/posts?where=...` | partial document | `200 { docs, errors }` |
| Delete | `DELETE` | `/api/posts/:id` | — | `200` deleted document |
| Bulk delete | `DELETE` | `/api/posts?where=...` | — | `200 { docs, errors }` |
| Read global | `GET` | `/api/globals/site-settings` | — | `200` document |
| Update global | `PATCH` | `/api/globals/site-settings` | partial | `200` updated |

We use `PATCH` rather than `PUT` for updates because document updates are always partial merges — you send the fields you changed, and field-level hooks and validation run only against what you sent plus what's required. This matches Payload's update semantics and avoids the footgun of `PUT` silently clearing omitted fields. Strapi's older `PUT`-based update was a frequent source of accidental data loss; we don't ship that edge.

The list and document responses are typed end-to-end. The same TypeScript types that `@kernel/client` infers from your config are exported, so an external TypeScript consumer can import them:

```ts
import type { Post, PaginatedDocs } from '@kernel/client/types'

const res = await fetch('https://cms.example.com/api/posts?limit=10')
const page = (await res.json()) as PaginatedDocs<Post>
//    ^ page.docs is Post[], fully typed
```

### Response envelopes

List responses use a stable pagination envelope. There is exactly one shape, so clients never branch on whether pagination metadata is present:

```jsonc
{
  "docs": [ /* Post[] */ ],
  "totalDocs": 137,
  "limit": 10,
  "totalPages": 14,
  "page": 1,
  "pagingCounter": 1,
  "hasPrevPage": false,
  "hasNextPage": true,
  "prevPage": null,
  "nextPage": 2
}
```

Single-document responses return the document directly at the top level (no `{ doc: ... }` wrapper) for reads, and `{ message, doc }` for mutating operations so a human-readable status travels with the result.

## Query parameters

One query language spans every surface — REST, GraphQL, RPC, and Local. Over HTTP it is expressed as URL query parameters. The parser in `@kernel/rest` accepts bracket-style nested keys (Strapi-and-Payload-compatible) and a JSON-encoded `where` for complex trees.

| Param | Type | Default | Purpose |
|-------|------|---------|---------|
| `where` | object | — | Filter tree; field operators below |
| `sort` | string | adapter default | Comma list, `-` prefix = descending |
| `limit` | number | `10` | Page size; `0` disables pagination |
| `page` | number | `1` | 1-indexed page |
| `depth` | number | `1` | Relationship/upload population depth |
| `select` | object | all | Field projection (include/exclude) |
| `populate` | object | — | Per-relation field projection |
| `locale` | string | default locale | Field-level localization |
| `fallbackLocale` | string | config | Locale to fall back to |
| `draft` | boolean | `false` | Read latest draft instead of published |

The `where` operators are explicit, not magic substrings:

| Operator | Meaning | Example |
|----------|---------|---------|
| `equals` / `not_equals` | exact match | `where[status][equals]=published` |
| `greater_than` / `less_than` | numeric/date | `where[views][greater_than]=100` |
| `greater_than_equal` / `less_than_equal` | inclusive | — |
| `like` / `contains` | substring | `where[title][like]=launch` |
| `in` / `not_in` | set membership | `where[id][in]=1,2,3` |
| `exists` | null check | `where[author][exists]=true` |
| `near` | geospatial on `point` | `where[loc][near]=12.5,55.6,5000` |
| `and` / `or` | boolean grouping | nested arrays |

A non-trivial filter, sent two equivalent ways:

```
# Bracket form
GET /api/posts?where[and][0][status][equals]=published
              &where[and][1][title][like]=tanstack
              &sort=-publishedAt&limit=5&depth=2&locale=en

# JSON form (URL-encoded)
GET /api/posts?where=%7B%22and%22%3A%5B...%5D%7D
```

Both compile to the same `Where` object the operation core consumes:

```ts
const where = {
  and: [
    { status: { equals: 'published' } },
    { title: { like: 'tanstack' } },
  ],
}
```

`depth` is the population control that Payload popularized and that Sanity solves with explicit GROQ joins. At `depth: 0` a relationship field returns just the related ID; at `depth: 1` it returns the related document one level deep; each increment populates one more hop. We cap `depth` per request (config `maxDepth`, default `10`) so a hostile client can't trigger an unbounded join cascade. Use `select` and `populate` to trim payloads — projecting fields server-side is far cheaper than over-fetching and discarding client-side, and it keeps the [access-control](../06-auth-security/01-authorization-and-access-control.md) surface tight by never serializing fields the caller can't read.

## Auth

Authentication is handled by `@kernel/auth` and enforced server-side on every REST request, before any operation runs. There is no "public by default" mode; if a collection has access control, REST honors it. Three credential mechanisms are accepted on REST:

| Mechanism | Header / cookie | Use case |
|-----------|-----------------|----------|
| Session cookie | `Cookie: kernel-token=...` | Admin app, same-site browser |
| Bearer token (JWT) | `Authorization: Bearer <jwt>` | SPA, mobile, server-to-server |
| API key | `Authorization: <collection> API-Key <key>` | Service integrations, CI |

API keys are scoped to an auth-enabled collection (typically `users` or a dedicated `service-accounts` collection) and carry that document's roles, so authorization is resource-level rather than a global god-token. Cookies are issued `Secure`, `HttpOnly`, and `SameSite=Lax` by default; CORS origins are an explicit allowlist in config — never a wildcard with credentials.

```ts
// kernel.config.ts
export default defineConfig({
  cors: { origins: ['https://app.example.com'], credentials: true },
  collections: [
    {
      slug: 'posts',
      auth: false,
      access: {
        read: () => true, // public read
        create: ({ req }) => Boolean(req.user), // must be logged in
        update: ({ req, id }) => ({ author: { equals: req.user?.id } }), // owner-only
        delete: ({ req }) => req.user?.roles?.includes('editor') ?? false,
      },
      fields: [/* ... */],
    },
  ],
})
```

Access functions can return a boolean or a `Where` constraint. When they return a `Where`, it is **merged into the query**, so a list request never leaks documents the caller isn't allowed to see — the filter is applied in the database, not after fetching. This is the IDOR-resistant default: `GET /api/posts/:id` for a document you can't read returns `404`, not `403`, so existence isn't disclosed. Field-level access runs during serialization, stripping unreadable fields from the response and rejecting writes to unwritable ones. Rate limiting is applied at the edge — public endpoints get a default budget, and `/api/users/login` and other auth routes get a stricter one.

## Worked examples

Authenticate, then create and query, using only `curl`:

```bash
# 1. Log in — sets the session cookie and returns a JWT
curl -s -X POST https://cms.example.com/api/users/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"ada@example.com","password":"correct horse"}'
# → { "user": {...}, "token": "eyJhbGci...", "exp": 1735689600 }

# 2. Create a draft (Bearer auth)
curl -s -X POST https://cms.example.com/api/posts?draft=true \
  -H 'Authorization: Bearer eyJhbGci...' \
  -H 'Content-Type: application/json' \
  -d '{"title":"Going TanStack-native","status":"draft"}'
# → 201 { "message": "Post created.", "doc": { "id": 42, ... } }

# 3. Publish via partial update
curl -s -X PATCH https://cms.example.com/api/posts/42 \
  -H 'Authorization: Bearer eyJhbGci...' \
  -H 'Content-Type: application/json' \
  -d '{"status":"published"}'

# 4. Public, filtered, populated read
curl -s 'https://cms.example.com/api/posts?\
where[status][equals]=published&sort=-publishedAt&depth=1&limit=5'
```

The same operations from TypeScript, with full inference, via the generated client in `@kernel/client`:

```ts
import { createClient } from '@kernel/client'
import type { Post } from '@kernel/client/types'

const cms = createClient({ url: 'https://cms.example.com/api', token })

const { docs } = await cms.collections.posts.find({
  where: { status: { equals: 'published' } },
  sort: '-publishedAt',
  depth: 1,
  limit: 5,
})
//    ^ docs: Post[]

const updated: Post = await cms.collections.posts.update({
  id: 42,
  data: { status: 'published' },
})
```

A bulk update across many documents in one round-trip:

```bash
curl -s -X PATCH 'https://cms.example.com/api/posts?where[status][equals]=draft' \
  -H 'Authorization: Bearer eyJhbGci...' \
  -H 'Content-Type: application/json' \
  -d '{"status":"published"}'
# → { "docs": [ /* updated */ ], "errors": [ /* per-doc failures */ ] }
```

Bulk operations return partial-success envelopes: each document is processed independently, and a validation failure on document 7 doesn't roll back documents 1–6 unless you opt into a transaction (`?transaction=true` on adapters that support it). This mirrors how Strapi handles bulk actions but with a typed `errors[]` array instead of an opaque 400.

## Error format

Errors are a single typed shape, never a bare string. HTTP status maps to a named error class from the operation core (`ValidationError`, `Forbidden`, `NotFound`, `Unauthorized`), and field-level validation failures are itemized so a form can map them back to inputs:

```jsonc
{
  "errors": [
    {
      "name": "ValidationError",
      "message": "The following field is invalid: title",
      "data": [{ "field": "title", "message": "This field is required." }]
    }
  ]
}
```

| Status | Class | Trigger |
|--------|-------|---------|
| `400` | `ValidationError` | Field validation or malformed `where` |
| `401` | `Unauthorized` | Missing/expired credential |
| `403` | `Forbidden` | Authenticated but operation denied |
| `404` | `NotFound` | Missing doc, or read-denied (intentional) |
| `429` | `TooManyRequests` | Rate limit exceeded |

## Open questions

- **Bulk-write cap.** Should unbounded `PATCH`/`DELETE` with a broad `where` require an explicit `limit` or a confirmation flag to prevent a one-line accidental mass mutation? Leaning toward a configurable `maxBulkDocs` that hard-fails above the threshold.
- **`PUT` for full replacement.** Some integrators genuinely want replace-not-merge semantics. Open question whether to add `PUT` as an explicit full-replacement verb alongside `PATCH`, or keep the surface minimal.
- **Cursor pagination.** Offset pagination (`page`/`limit`) is the default. We may add opaque cursor pagination (`?cursor=...`) for large, frequently-mutated collections where offset drift matters — undecided whether it ships in core or as a `@kernel/rest` option.
- **OpenAPI emission.** We will emit an OpenAPI 3.1 document from config; open question is whether it lives at `/api/openapi.json` by default or behind a flag.
