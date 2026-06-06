# Query Engine & Find API

KernelCMS exposes one query language across every surface — Local API, typed RPC, REST, and GraphQL — and compiles it down to native SQL via Drizzle or to a MongoDB aggregation pipeline. You write `where`, `sort`, `limit`, `page`, and `depth` once; `@kernel/core` validates the shape against your collection schema, the active `Adapter` translates it, and the database does the work. There is no second query dialect to learn per backend, and no raw query string leaks out of an endpoint. This document specifies that language, the operator set, pagination semantics, relationship population (`depth`), and how the same query object compiles differently on Postgres, SQLite/libSQL, MySQL, and MongoDB.

## The Find API surface

Every operation hangs off `payload`-style collection handles, but the canonical entry is the Local API, which is the in-process operation core with full type inference. The same arguments flow over the wire as typed RPC ([TanStack Start server functions](../05-api/03-typed-rpc-and-local-api.md)) and are projected into [REST](../05-api/01-rest-api.md) and [GraphQL](../05-api/02-graphql-api.md).

```ts
import { getKernel } from '@kernel/server'

const kernel = await getKernel()

const result = await kernel.find({
  collection: 'posts',
  where: {
    and: [
      { status: { equals: 'published' } },
      { publishedAt: { less_than_equal: new Date() } },
      { 'author.role': { equals: 'editor' } },
    ],
  },
  sort: ['-publishedAt', 'title'],
  limit: 20,
  page: 1,
  depth: 1,
  locale: 'en',
})
```

The return type is inferred end-to-end. `result.docs` is `Post[]` with relationships populated to the requested `depth`, and `result` carries the pagination envelope (`totalDocs`, `totalPages`, `page`, `hasNextPage`, …). Unlike Strapi, where the REST query string (`filters[$and][0]...`) and the Node `entityService` API diverge in both shape and capability, KernelCMS guarantees that what you can express in-process you can express over the wire, and vice versa.

`findByID`, `count`, `findVersions`, and the `update`/`delete`-by-`where` bulk operations all consume the same `where` grammar, so the engine has exactly one parser to maintain and harden.

## `where` syntax

A `where` is a recursive tree of **field conditions** and **logical groups**. A field condition is `{ <fieldPath>: { <operator>: <value> } }`. A logical group is `{ and: Where[] }` or `{ or: Where[] }`. Groups nest arbitrarily; an implicit top-level object with multiple keys is treated as `and`.

```ts
type Where = {
  and?: Where[]
  or?: Where[]
} & {
  [fieldPath: string]: WhereField | Where[] | undefined
}

type WhereField = Partial<Record<Operator, unknown>>
```

Field paths use dot notation to traverse `group`, `tab`, and `relationship` fields. `'author.role'` filters on the related document's `role`; `'meta.seo.title'` reaches into nested groups. Localized fields are addressed by their base name — the engine rewrites the path to the active `locale` column or sub-document during compilation, so `{ title: { contains: 'kernel' } }` queries `title_en` when `locale: 'en'`.

```text
where
├─ and
│  ├─ { status: { equals: 'published' } }      field condition
│  ├─ { 'author.role': { in: ['editor'] } }    relationship traversal
│  └─ or
│     ├─ { pinned: { equals: true } }
│     └─ { views: { greater_than: 10_000 } }
```

Field paths and operators are validated against the compiled schema before any SQL is built. An unknown field or an operator the field type does not support is a typed error at the boundary, never a silently-empty result. This is a deliberate departure from Sanity's GROQ, which is enormously expressive but is a string you can get wrong at runtime with no schema awareness, and from Mongo-style raw filters, which happily match nothing when you typo a key.

## Operators

The operator set is fixed and field-type-aware. The schema decides which operators a field exposes; a `boolean` rejects `greater_than`, a `point` rejects `contains`.

| Operator                              | Applies to                    | Meaning                                                   |
| ------------------------------------- | ----------------------------- | --------------------------------------------------------- |
| `equals` / `not_equals`               | all                           | exact match / negation                                    |
| `greater_than` / `greater_than_equal` | number, date                  | `>` / `>=`                                                |
| `less_than` / `less_than_equal`       | number, date                  | `<` / `<=`                                                |
| `like` / `contains`                   | text, textarea, email         | case-insensitive substring (`contains`), pattern (`like`) |
| `in` / `not_in`                       | scalar fields                 | membership against an array                               |
| `exists`                              | all                           | `true` → not null; `false` → null                         |
| `near`                                | point                         | geospatial proximity `[lng, lat, maxMeters, minMeters]`   |
| `within` / `intersects`               | point                         | geometry containment / intersection                       |
| `all`                                 | array, relationship (hasMany) | every supplied value present                              |

Operator names are verbose on purpose — `greater_than_equal` reads identically in TypeScript, in a REST query string, and in a saved [TanStack Table](../04-admin-ui/05-collection-list-views.md) filter, so the admin filter UI and a curl command produce byte-identical `where` trees. Payload established this convention and it has aged well; KernelCMS keeps it and adds the geospatial trio (`near`, `within`, `intersects`) for `point` fields, which Payload lacks and which Strapi only approximates through provider-specific escape hatches.

Values are coerced and validated by the field's own schema before reaching the adapter, so a `date` operator receives a `Date`, not a string the database has to guess at.

## Sort, limit, and pagination

`sort` accepts a single field or an ordered array; a leading `-` means descending. Sorting is stable — the engine always appends the collection's primary key as a final tiebreaker so page boundaries never duplicate or drop rows.

```ts
await kernel.find({
  collection: 'posts',
  sort: ['-pinned', '-publishedAt'], // pinned first, then newest
  limit: 25,
  page: 3,
})
```

Two pagination modes are supported, and the choice is explicit:

**Offset pagination** (`page` + `limit`) is the default. It returns a full envelope including `totalDocs` and `totalPages`, which the admin list view needs for its pager. The cost is a second `COUNT(*)` query and `OFFSET` scan cost that grows with page depth.

**Cursor pagination** (`after` / `before` + `limit`) is opt-in for high-throughput frontends and infinite-scroll. The engine encodes the sort tuple plus primary key into an opaque cursor and translates the next page into a `WHERE (sortcol, id) > (:cursor)` seek, which stays O(limit) regardless of depth.

```ts
const firstPage = await kernel.find({
  collection: 'posts',
  sort: ['-publishedAt'],
  limit: 50,
  pagination: 'cursor',
})

const next = await kernel.find({
  collection: 'posts',
  sort: ['-publishedAt'],
  limit: 50,
  pagination: 'cursor',
  after: firstPage.endCursor,
})
```

| Mode                      | Returns `totalDocs` | Cost at page N | Best for                       |
| ------------------------- | ------------------- | -------------- | ------------------------------ |
| offset (`page`)           | yes                 | grows with N   | admin pager, jump-to-page      |
| cursor (`after`/`before`) | no (opt-in count)   | constant       | infinite scroll, APIs at scale |

`limit` is clamped to a per-collection `maxLimit` (default 100, `limit: 0` disables paging only when explicitly allowed). This is enforced server-side so a public REST consumer cannot request `limit: 1000000`. Strapi historically shipped with no hard cap, which is a real denial-of-service vector; KernelCMS caps by default and makes raising the cap a deliberate config decision.

## Depth and population

`depth` controls relationship population. At `depth: 0`, relationship and upload fields return raw IDs. Each increment resolves one more level of related documents, recursively.

```ts
// depth: 0  → author is an id
{ id: '1', title: 'Hello', author: 'usr_42' }

// depth: 1  → author resolved, its own relations stay as ids
{ id: '1', title: 'Hello', author: { id: 'usr_42', name: 'Sven', team: 'team_3' } }

// depth: 2  → author.team resolved too
{ ..., author: { ..., team: { id: 'team_3', name: 'Core' } } }
```

Population respects access control at every level — a related document the requesting user cannot read is returned as `null` (or its ID, depending on field config), evaluated by the same operation/document/field access rules as a direct read. See [access control](../06-auth-security/01-authorization-and-access-control.md).

Per-field overrides via `populate` and `select` keep payloads tight without sacrificing the convenient global `depth`:

```ts
await kernel.find({
  collection: 'posts',
  depth: 1,
  populate: {
    author: { select: { name: true, avatar: true } }, // only these fields
  },
  select: { title: true, author: true }, // top-level projection
})
```

This is the lever Sanity solves with GROQ projections and Strapi with `populate` trees; KernelCMS gives you both a blunt global `depth` for prototyping and surgical `select`/`populate` for production payloads, with full type narrowing — `select` changes the inferred return type, so over-fetching is a type error, not a runtime surprise.

## Query compilation per backend

The `where`/`sort`/`page`/`depth` object is backend-agnostic. Each `Adapter` (see [the adapter contract](./00-persistence-overview-and-adapter-contract.md)) implements a `compileFind` that lowers the object into native operations. The pipeline:

```text
Where tree ──▶ validate vs schema ──▶ normalize (locale paths, coercion)
          ──▶ Adapter.compileFind ──▶ native query ──▶ hydrate + populate
```

**SQL adapters (`@kernel/db-postgres`, `@kernel/db-sqlite`, `@kernel/db-mysql`)** build a Drizzle query. Logical groups become `and()`/`or()`; operators map to Drizzle expression builders; relationship traversals become `JOIN`s (or correlated subqueries when a `hasMany` would multiply rows). `depth` is resolved with Drizzle's relational query API in a single round trip per level, batched to avoid N+1. Dialect differences are handled here, not in the caller:

| Concern            | Postgres                  | SQLite/libSQL             | MySQL                 |
| ------------------ | ------------------------- | ------------------------- | --------------------- |
| `contains`         | `ILIKE`                   | `LIKE` + `COLLATE NOCASE` | `LIKE` (CI collation) |
| `json` field query | `jsonb` operators / `@>`  | `json_extract`            | `JSON_EXTRACT`        |
| `point` / `near`   | PostGIS / `earthdistance` | bounded-box fallback      | `ST_Distance_Sphere`  |
| `in` (large set)   | `= ANY($1)` array param   | expanded placeholders     | expanded placeholders |

All values are bound as parameters — no string concatenation reaches the driver, so injection is structurally impossible. PostGIS-class geospatial operators are first-class on Postgres; SQLite degrades `near` to a bounding-box prefilter and a precise post-filter, and the adapter advertises this in its capability flags so the engine never silently returns wrong geo results.

**MongoDB adapter (`@kernel/db-mongodb`)** compiles to a `find` filter plus aggregation `$lookup` stages for population. `and`/`or` map to `$and`/`$or`, operators to `$eq`/`$gt`/`$in`/`$regex`/`$geoNear`, and dot-paths address embedded documents natively. `depth` becomes a `$lookup` + `$unwind` pipeline; `select`/`populate` become `$project` stages.

```text
{ author: { in: ['a','b'] } }
  ─ SQL ─▶  WHERE author_id = ANY($1)
  ─ Mongo ▶  { author: { $in: ['a','b'] } }
```

Because the engine validates and normalizes before dispatch, capability gaps are surfaced as typed errors rather than divergent behavior — if a backend can't honor an operator, the adapter declares it unsupported for that field type and the query is rejected at compile time. This is the core promise: one query language, predictable compilation, no per-database dialect in your application code.

## Open questions

- **Full-text search ownership.** Should `like`/`contains` quietly upgrade to a backend's native FTS (Postgres `tsvector`, Mongo text index) above a length threshold, or should text search stay strictly in the `@kernel/search` adapter so behavior is identical across backends? Leaning toward keeping the query engine literal and routing real search through the search adapter.
- **Cursor encoding stability.** Cursors currently encode the sort tuple; changing a query's `sort` mid-pagination invalidates them. Do we sign cursors and reject mismatched sorts, or document them as sort-bound and move on?
- **Computed/virtual field filtering.** Filtering on hook-derived fields requires either materialization or a per-query expression. Undecided whether to support it at all in v1 or push users to persist the value.
