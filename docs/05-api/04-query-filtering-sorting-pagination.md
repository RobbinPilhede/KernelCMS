# Querying: Filtering, Sorting & Pagination

KernelCMS exposes one query language. Whether you call `payload.find()`-style operations through the Local API, hit `/api/posts?where[...]`, write a GraphQL `where` argument, or invoke a typed RPC server function, the shape of the query — `where`, `sort`, pagination, and `depth` — is identical. The query is parsed once into a normalized AST, validated against the collection config, run through access control, and compiled to the active adapter (Drizzle SQL or MongoDB). This document specifies that language: the operators, the sort grammar, the two pagination models, and how relationship population works via `depth` and `select`/`populate`.

The design goal is that you learn the query language exactly once and reuse it across REST, GraphQL, RPC, and in-process calls. Payload comes closest to this with its shared `where` object, but its REST surface and GraphQL surface diverge in subtle ways. Sanity uses GROQ (a bespoke query language) everywhere, which is powerful but proprietary and disconnected from your TypeScript types. Strapi ships two incompatible query styles (REST filters vs. the entity service / Document Service API). KernelCMS commits to a single typed object that is the same on every surface.

## The shared query object

Every read operation accepts the same options. In the Local API and RPC, you pass a typed object; over REST it is serialized into bracketed query params; in GraphQL it maps to input types generated from your config.

```ts
import { kernel } from '@kernel/client'

const { docs, totalDocs, hasNextPage } = await kernel.find({
  collection: 'posts',
  where: {
    and: [
      { status: { equals: 'published' } },
      { publishedAt: { less_than_equal: new Date() } },
      { 'author.role': { in: ['editor', 'admin'] } },
    ],
  },
  sort: ['-publishedAt', 'title'],
  limit: 20,
  page: 1,
  depth: 1,
  locale: 'en',
})
```

The `where` AST, the `sort` array, the pagination fields, and `depth` are the four pillars covered below. Each is fully typed: `keyof` the collection's fields drives autocomplete on field paths, and operator availability is narrowed by field type (you cannot ask for `contains` on a `boolean`).

## Filter operators

Filters are expressed as a tree of field conditions combined with `and` / `or`. A leaf is `{ <fieldPath>: { <operator>: <value> } }`. Logical nodes are `{ and: [...] }` and `{ or: [...] }`, and they nest arbitrarily.

```ts
where: {
  or: [
    { 'category.slug': { equals: 'engineering' } },
    {
      and: [
        { featured: { equals: true } },
        { views: { greater_than: 1000 } },
      ],
    },
  ],
}
```

### Operator reference

| Operator                              | Applies to                              | Meaning                                               |
| ------------------------------------- | --------------------------------------- | ----------------------------------------------------- |
| `equals` / `not_equals`               | all scalar types                        | exact match / negation                                |
| `greater_than` / `greater_than_equal` | number, date                            | `>` / `>=`                                            |
| `less_than` / `less_than_equal`       | number, date                            | `<` / `<=`                                            |
| `in` / `not_in`                       | scalars, relationship ids               | membership against an array                           |
| `exists`                              | all                                     | `true` = field is set; `false` = null/unset           |
| `like`                                | text, textarea, email, richText (plain) | case-insensitive substring (`ILIKE %v%`)              |
| `contains`                            | text, array of scalars                  | substring / array membership                          |
| `near`                                | point                                   | geospatial radius, `[lng, lat, maxMeters, minMeters]` |
| `within` / `intersects`               | point                                   | geometry containment (Postgres + Mongo only)          |
| `all`                                 | array, relationship (hasMany)           | every supplied value must be present                  |

Operators are deliberately spelled out (`greater_than_equal`, not `gte`) so a serialized REST query is self-documenting and matches the GraphQL input field names one-to-one. This is the Payload convention, and we keep it; Strapi's `$gte`/`$contains` MongoDB-flavored operators are terse but leak a backend dialect into the public API.

### Field-type narrowing

The operator set is constrained at the type level. Each field type maps to an allowed operator union, and the query builder rejects mismatches at compile time:

```ts
// number field -> numeric + equality operators only
{
  views: {
    greater_than: 1000
  }
} // ok
{
  views: {
    like: 'foo'
  }
} // type error: 'like' not assignable
```

This is the concrete win over Strapi and Sanity: invalid filters fail in your editor, not at runtime against the database.

### Filtering on relationships and nested fields

Dotted paths traverse relationships, groups, and array/blocks fields. `author.role` filters on the related `users` document; `meta.seo.title` reaches into a `group`. Relationship traversal compiles to a join (SQL) or `$lookup` + `$match` (Mongo). Depth of traversal is capped by config (`queryDepthLimit`, default 3) to keep adversarial queries from generating pathological joins.

```ts
where: {
  'author.role':       { equals: 'editor' },   // join into users
  'blocks.cta.label':  { like: 'Subscribe' },   // into a blocks field
}
```

### Access control is folded into the filter

Filters never bypass authorization. Collection-level `access.read` can return a `where` constraint — a query-shaped object — that is `and`-merged with the caller's `where` before compilation. A user querying `posts` only ever sees the intersection of their access filter and their own filter. See [access control](../06-auth-security/01-authorization-and-access-control.md) for how read constraints are authored.

```
  caller where ─┐
                ├─ AND ─► normalized AST ─► adapter compile
  access where ─┘
```

## Sorting

`sort` is an array of field paths. A leading `-` means descending; bare means ascending. Order in the array is sort precedence (primary, secondary, …). A single string is accepted as shorthand.

```ts
sort: ['-publishedAt', 'title'] // newest first, then A→Z by title
sort: 'title' // shorthand, ascending
```

| Input                        | SQL `ORDER BY`                  |
| ---------------------------- | ------------------------------- |
| `['-publishedAt']`           | `published_at DESC`             |
| `['priority', '-createdAt']` | `priority ASC, created_at DESC` |

Sortable fields are validated against config. Only fields backed by a column or index are sortable; computed/virtual and `ui` fields are rejected. We strongly recommend marking sort fields with `index: true` in `kernel.config.ts` — the query layer emits a dev-time warning when you sort on an unindexed column, because unindexed sorts plus large offsets are the classic source of slow list views.

```ts
// kernel.config.ts
fields: [
  { name: 'publishedAt', type: 'date', index: true },
  { name: 'title', type: 'text', index: true },
]
```

Localized fields sort by the resolved `locale`. Nulls sort last by default on every adapter; override per-query with `sort: [{ field: 'priority', order: 'asc', nulls: 'first' }]` when you need the explicit form. Relationship sort (`sort: ['author.lastName']`) is supported on SQL adapters via join; on MongoDB it requires the related field to be denormalized or it falls back to an aggregation pipeline.

## Pagination: offset vs. cursor

KernelCMS supports both pagination models on every read operation. Offset is the default because it is what admin list views and most REST consumers expect; cursor pagination is opt-in for stable, deep, high-volume iteration.

### Offset pagination

Driven by `page` and `limit`. The response includes the full pagination envelope, which is what powers the [TanStack Table](../04-admin-ui/05-collection-list-views.md) list views (page counters, jump-to-page).

```ts
const res = await kernel.find({ collection: 'posts', page: 3, limit: 25 })
// res: { docs, totalDocs, totalPages, page, limit,
//        hasPrevPage, hasNextPage, prevPage, nextPage }
```

```
page=1        page=2        page=3
[ 0..24 ]     [ 25..49 ]    [ 50..74 ]   <- OFFSET 50 LIMIT 25
```

Offset is simple and gives a total count, but cost grows with the offset (the database still scans skipped rows) and results can shift if rows are inserted between page loads. For admin UIs over reasonable datasets this is fine. For programmatic export, feeds, or anything past a few thousand rows, use cursor.

### Cursor pagination

Opt in with `pagination: 'cursor'`. Instead of `page`, you pass the opaque `after` (or `before`) cursor returned by the previous response. The cursor encodes the `sort` tuple of the last row plus its id, base64-encoded, so it is stable under inserts and cheap at any depth.

```ts
let after: string | undefined
do {
  const res = await kernel.find({
    collection: 'events',
    sort: ['-occurredAt', 'id'],
    limit: 500,
    pagination: 'cursor',
    after,
  })
  process(res.docs)
  after = res.pageInfo.endCursor
} while (res.pageInfo.hasNextPage)
```

The compiler turns the cursor into a keyset (seek) predicate rather than an `OFFSET`:

```sql
-- after a row with (occurredAt = T, id = X), descending
WHERE (occurred_at, id) < (T, X)
ORDER BY occurred_at DESC, id DESC
LIMIT 500
```

Because the sort key must be unique to be stable, KernelCMS automatically appends `id` as the final tie-breaker to any cursor query. `totalDocs` is omitted from cursor responses by default (counting defeats the point of keyset paging); request it explicitly with `count: true` if you accept the extra query.

|                      | Offset      | Cursor                          |
| -------------------- | ----------- | ------------------------------- |
| Random page access   | yes         | no                              |
| Stable under inserts | no          | yes                             |
| Cost at depth        | O(offset)   | O(limit)                        |
| Total count          | always      | opt-in                          |
| Best for             | admin lists | exports, feeds, infinite scroll |

This is a sharper split than the competition. Payload is offset-only out of the box. Strapi's REST is offset/page-based; cursor support is partial and inconsistent across its APIs. Sanity's GROQ does range slicing (`[0...20]`) which behaves like offset. Making keyset pagination a first-class, typed option — with the tie-breaker handled for you — is a deliberate KernelCMS differentiator for data-heavy frontends backed by [TanStack Query](../09-developer-experience/03-client-sdk-and-data-fetching.md) infinite queries.

## Population and depth

Relationship and upload fields store references. `depth` controls how far KernelCMS follows those references and inlines the related documents.

- `depth: 0` — references stay as ids (or `{ relationTo, value }` for polymorphic relations). Fastest, smallest payload.
- `depth: 1` — direct relationships are replaced with the full related document.
- `depth: n` — relationships of relationships are populated, recursively, up to `n`.

```ts
// depth: 0
{ author: 'usr_123', category: 'cat_9' }

// depth: 1
{ author: { id: 'usr_123', name: 'Sven', role: 'editor' },
  category: { id: 'cat_9', slug: 'engineering' } }

// depth: 2 — author.team is itself populated
{ author: { id: 'usr_123', name: 'Sven', team: { id: 'team_1', name: 'Core' } } }
```

Each populated step runs through the related collection's read access control, so population can never leak a document the caller could not have fetched directly. Fields the caller cannot read are stripped from the populated object.

### Bounding the cost of depth

Unbounded `depth` is a footgun: a graph with cycles plus high `depth` can fan out into thousands of fetches. KernelCMS bounds this three ways:

1. **`maxDepth` per field.** A relationship field can cap its own population depth in config, overriding a higher request-level `depth`.
2. **`defaultDepth` / `maxDepth` per collection** in `kernel.config.ts`, enforced server-side regardless of what the client asks for.
3. **Batched loading.** Population is resolved with a per-request DataLoader, so N documents referencing the same author trigger one query, not N (no N+1).

```ts
// kernel.config.ts
collections: [
  {
    slug: 'posts',
    defaultDepth: 1,
    maxDepth: 4,
    fields: [{ name: 'author', type: 'relationship', relationTo: 'users', maxDepth: 1 }],
  },
]
```

### `select` and `populate` for precise payloads

`depth` is a blunt instrument. For surgical control, use `select` (which top-level fields to return) and `populate` (which fields to pull from populated relationships). This is how you keep list views lean while edit views fetch everything.

```ts
await kernel.find({
  collection: 'posts',
  depth: 1,
  select: { title: true, slug: true, author: true }, // only these columns
  populate: { author: { name: true, avatar: true } }, // only these from the author
})
```

`select` compiles to a column projection in SQL (not `SELECT *`), so it reduces I/O at the database, not just on the wire. In GraphQL, projection is derived automatically from the requested selection set — you get `select`/`populate` behavior for free from the query shape, which is GraphQL's natural advantage over REST here.

Compared to Payload's `depth` + `select`, KernelCMS adds the typed `populate` map and database-level projection. Versus Sanity, you get the same field-precision GROQ offers via projections, but expressed as a typed object that flows through your generated types instead of a string DSL.

## Open questions

- **Default `count` behavior for offset at scale.** Should very large collections switch to an estimated count (`reltuples` on Postgres) past a threshold to avoid expensive `COUNT(*)`, and how is that surfaced in the envelope (`totalDocs` vs. `estimatedTotalDocs`)?
- **Full-text vs. `like`.** `like` is substring-based. Where the search adapter is configured, should `where` gain a first-class `search` operator that routes to the adapter, or stay separate from the structured filter language?
- **Cursor stability across sort changes.** A cursor encodes a specific `sort`. Do we hard-error when a client reuses a cursor under a different `sort`, or attempt a best-effort fallback to offset?
- **`within`/`intersects` on MySQL.** Geospatial containment is uneven across MySQL versions; decide whether to require a minimum version or degrade these operators to an unsupported error on that adapter.
