# MongoDB Adapter

`@kernel/db-mongodb` is the document-oriented backend for KernelCMS. Unlike the SQL adapters that lower your collections into Drizzle tables, the Mongo adapter stores each document as a single BSON record, embedding arrays, blocks, groups, and localized values inline. It exists for teams that already run MongoDB, want schemaless flexibility for deeply nested content, or are migrating off Payload's Mongo backend. It implements the same Adapter contract as every other backend (see [The Adapter Contract](./00-persistence-overview-and-adapter-contract.md)), so the Local API, REST, GraphQL, and RPC surfaces behave identically — the query language, access control, drafts, and versions all work the same. What changes is how data lands on disk and how `where`/`sort`/`depth` are translated to a query engine that has no joins.

## Configuration

You wire it up in `kernel.config.ts` exactly like any other adapter. There is no separate "Mongo mode" — the rest of your config is untouched.

```ts
import { defineConfig } from '@kernel/core'
import { mongodbAdapter } from '@kernel/db-mongodb'

export default defineConfig({
  db: mongodbAdapter({
    url: process.env.MONGODB_URL!, // mongodb+srv://… or mongodb://…
    dbName: 'kernel',
    // Mongo has no DDL, so there are no generated SQL migrations.
    // Index definitions are reconciled on boot instead (see "Indexes").
    transactionOptions: {
      // Requires a replica set or mongos. Single-node standalone has no txns.
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
    },
    // Opt into Mongo-specific storage shapes:
    useObjectIds: false, // store _id as a string ULID, not ObjectId — see "Document mapping"
  }),
  collections: [Posts, Media, Authors],
  globals: [SiteSettings],
})
```

The adapter is a thin wrapper over the official `mongodb` driver. We do not depend on Mongoose — Mongoose's schema layer would duplicate the modeling that already lives in your KernelCMS collection config, and its casting rules would fight our field validation. The driver gives us raw control over the aggregation pipeline, which we need for relationship resolution.

## Document mapping

Each KernelCMS collection maps to one Mongo collection. Each document maps to one BSON document. This is the adapter's defining property: there is no flattening, no join table, no `_rels` side table. A document with three `blocks`, a localized `richText` field, and a nested `array` is stored as exactly one record.

```
Posts collection config            Mongo document (BSON)
─────────────────────           ──────────────────────────────
text       title          →      { _id, title, slug,
richText   body           →        body: { … lexical JSON … },
array      seo[]          →        seo: [ { … }, { … } ],
blocks     content[]      →        content: [
relationship author       →          { blockType: 'hero', … },
upload     cover          →          { blockType: 'quote', … }
                                   ],
                                   author: '01HZX…',   // stored id
                                   cover: '01J2A…',
                                   _status: 'published',
                                   updatedAt, createdAt }
```

### Identifiers

The `_id` strategy is a real decision, not a default to ignore.

| `useObjectIds` | `_id` type | Pros | Cons |
| --- | --- | --- | --- |
| `false` (default) | string ULID | Portable to SQL adapters, lexically sortable, no driver-specific casting in the API | 26-char string index, slightly larger |
| `true` | `ObjectId` | Native Mongo, smallest index, embedded timestamp | Leaks BSON types into the wire format; harder to migrate to Postgres |

We default to string ULIDs because content portability between adapters and between self-host and KernelCMS Cloud is a core tenet — a ULID `_id` round-trips into a Postgres `text` primary key without rewriting every relationship reference. Payload, by contrast, leans on `ObjectId` in its Mongo adapter and string UUIDs only in Postgres, which makes its two backends subtly non-interchangeable at the id level. KernelCMS keeps one id shape across all adapters by default.

### Localization

Localized fields are stored as a nested object keyed by locale, embedded in the same document — never a separate table.

```jsonc
{
  "title": { "en": "Launch day", "de": "Tag des Starts" },
  "body":  { "en": { /* lexical */ }, "de": { /* lexical */ } }
}
```

The Local API still returns a single resolved value for the requested locale (`locale: 'de'` or `locale: 'all'`); the per-locale shape is an internal storage detail. This mirrors how Sanity stores localized fields as objects, but KernelCMS keeps the locale keying consistent with the SQL adapters' column-per-locale-or-row strategy so the API contract is identical regardless of backend.

### Drafts, versions, and autosave

Published documents live in the collection (`posts`). Versions live in a sibling collection (`_posts_versions`) with a `parent` reference, `version` snapshot, `latest` flag, and `autosave` boolean. This matches the SQL adapters' version-table approach and means [drafts and version history](../02-data-modeling/10-versioning-drafts-and-autosave.md) behave identically. The only Mongo-specific win: a version snapshot is a single embedded document, so reconstructing a historical revision is one `findOne`, not a multi-table reassembly.

## Query translation

The shared query language (`where` / `sort` / `pagination` / `depth`) is the same one documented in The Query Language. The Mongo adapter compiles it into a query filter and, when `depth > 0`, an aggregation pipeline.

### Operator mapping

```
where: {                          Mongo filter:
  status: { equals: 'published' } { _status: 'published',
  views:  { greater_than: 100 }     views: { $gt: 100 },
  tags:   { in: ['a', 'b'] }        tags: { $in: ['a','b'] },
  title:  { like: 'launch' }        title: { $regex: 'launch', $options: 'i' }
}                                 }
```

| KernelCMS operator | Mongo |
| --- | --- |
| `equals` / `not_equals` | `$eq` / `$ne` |
| `greater_than` / `less_than` | `$gt` / `$lt` (and `_equal` → `$gte`/`$lte`) |
| `in` / `not_in` | `$in` / `$nin` |
| `like` / `contains` | `$regex` with `$options: 'i'` |
| `exists` | `$exists` |
| `near` (point fields) | `$geoNear` / `$near` with a `2dsphere` index |
| `and` / `or` | `$and` / `$or` |

Nested field access uses Mongo's dot-path syntax, so `where: { 'seo.description': { like: 'kernel' } }` compiles to `{ 'seo.description': { $regex: … } }` and queries inside the embedded array for free — no join required. This is the structural advantage of the document model and the main reason a team would pick it.

### The depth problem

Relationships are stored as bare ids. Resolving them (`depth: 1` and deeper) is where the document model costs you. There are no foreign keys and no `JOIN`. The adapter has two strategies:

1. **`$lookup` pipeline** (default) — emit a single aggregation with one `$lookup` stage per relationship field, plus `$unwind` for to-one and nested `$lookup` for the next depth level.
2. **Batched id resolution** — run the base query, collect all referenced ids, then `find({ _id: { $in } })` once per target collection (a DataLoader-style N+1 collapse) and stitch in memory.

```ts
// depth: 2 on Posts → author → author.avatar
[
  { $match: { _status: 'published' } },
  { $sort: { createdAt: -1 } },
  { $skip: 0 }, { $limit: 20 },
  { $lookup: {
      from: 'authors', localField: 'author',
      foreignField: '_id', as: 'author',
  }},
  { $unwind: { path: '$author', preserveNullAndEmptyArrays: true } },
  { $lookup: { from: 'media', localField: 'author.avatar',
      foreignField: '_id', as: 'author.avatar' }},
  { $unwind: { path: '$author.avatar', preserveNullAndEmptyArrays: true } },
]
```

The adapter picks `$lookup` for shallow, bounded depth and switches to batched resolution past a configurable `lookupDepthLimit` (default `2`), because deeply chained `$lookup` stages degrade fast and can blow the 100MB aggregation memory limit. Polymorphic relationships (a field that can point at multiple collections) always use batched resolution — `$lookup` cannot fan out across `from` collections in one stage. Access control is applied as an additional `$match` injected at the top of the pipeline and again after each `$lookup`, so a user who lacks read access to `authors` gets a null relationship rather than a leaked join.

### Pagination

Offset pagination (`page` + `limit`) uses `$skip`/`$limit`. The adapter also supports keyset pagination on the default `createdAt`/`_id` sort, which avoids the deep-skip performance cliff that hurts both Mongo and SQL — important for the [admin list views](../04-admin-ui/05-collection-list-views.md) backed by TanStack Table virtualization.

## Transactions

Multi-document operations — a publish that writes the document plus a version row, a cascade, a bulk update — run inside a Mongo session transaction. This is non-negotiable for KernelCMS: the version table and the live document must move together or not at all.

```ts
const session = client.startSession()
await session.withTransaction(async () => {
  await posts.updateOne({ _id }, { $set: next }, { session })
  await versions.insertOne({ parent: _id, version: snapshot,
    latest: true, autosave: false }, { session })
  await versions.updateMany(
    { parent: _id, _id: { $ne: snapshotId } },
    { $set: { latest: false } }, { session })
})
```

The hard constraint: **Mongo transactions require a replica set or sharded cluster.** A standalone `mongod` has none. The adapter detects topology at boot. On standalone it logs a loud warning and falls back to best-effort sequential writes, which is acceptable for local dev but not for production. The configuration check is explicit:

```
┌─────────────────────────────────────────────┐
│ topology          transactions   stance      │
├─────────────────────────────────────────────┤
│ standalone        ✗              dev only     │
│ replica set       ✓              production   │
│ sharded (mongos)  ✓              production   │
│ Atlas (any tier)  ✓              production   │
└─────────────────────────────────────────────┘
```

Because transactions are scoped to a session that flows through the adapter, the Local API exposes them through the same `req.transactionID` mechanism the SQL adapters use, so a custom hook or [access control](../06-auth-security/01-authorization-and-access-control.md) function that performs extra writes joins the same atomic unit. There is no Mongo-specific transaction API leaking into your application code — that is the point of the contract.

## When to choose Mongo

Pick `@kernel/db-mongodb` deliberately, not by default. KernelCMS defaults to Postgres via `@kernel/db-postgres` for a reason: relational integrity, mature tooling, and generated migrations.

**Choose Mongo when:**

- You already operate MongoDB or Atlas and don't want a second datastore.
- Your content is genuinely document-shaped and read as a whole — a marketing page with deeply nested `blocks` is fetched and rendered as one unit, so the single-document read is a real win over reassembling SQL tables.
- You are migrating off Payload's Mongo backend and want a near-1:1 storage shape with a more flexible adapter ecosystem.
- Schema churn is high and you don't want a migration on every field addition — Mongo's lack of DDL means adding an optional field is a no-op.

**Stay on SQL (Postgres/SQLite/MySQL) when:**

- You need cross-document relational integrity or report-style queries across many collections — `$lookup` is not a substitute for real joins, and our adapter caps lookup depth for good reason.
- You want generated, reviewable migrations as a deployment gate. The Mongo adapter reconciles indexes on boot but has no equivalent to a versioned SQL migration history.
- You run a single-node database in production — you lose transactions, which KernelCMS treats as required for safe publishing.

Sanity hides its datastore entirely (its content lake is not yours to operate); Strapi defaults to SQL and treats Mongo as a deprecated second class; Payload makes Mongo a first-class but opinionated default. KernelCMS's position is different: Mongo is a fully supported, contract-conformant adapter you select on purpose, with the same APIs, the same access control, and content that stays portable to SQL and to KernelCMS Cloud. Nothing is hard-wired, including the database. See Choosing a Database Adapter for the decision matrix across all backends.

## Indexes

There is no schema diff to migrate, so indexes are declared in field config and reconciled against `collection.indexes()` on boot — created if missing, dropped if removed (behind a `--prune-indexes` flag to avoid accidental drops in production). Unique fields, relationship fields, and `point` fields (which get a `2dsphere` index) are indexed automatically.

```ts
text({ name: 'slug', unique: true, index: true })
point({ name: 'location' }) // → 2dsphere index, enables `near` queries
```

## Open questions

- **Change streams for live admin.** Mongo change streams could drive [TanStack DB live collections](../04-admin-ui/10-live-preview-and-visual-editing.md) without polling, but they also require a replica set and add a persistent connection per tenant. Whether we enable them by default or gate behind config is undecided.
- **Aggregation memory limit.** For very deep `depth` on large result sets we may need `allowDiskUse: true`, which has a real performance cost. The threshold at which we flip it on, versus forcing batched resolution, is not yet finalized.
- **`ObjectId` interop on Cloud.** If a user imports a `useObjectIds: true` dataset into KernelCMS Cloud (which standardizes on string ids), the migration step's id-rewriting cost on large datasets is still being benchmarked.
