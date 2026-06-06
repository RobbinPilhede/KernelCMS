# Persistence Overview & Adapter Contract

KernelCMS treats the database as a swappable adapter, not a hard dependency. Every backend — Postgres, SQLite/libSQL, MySQL, MongoDB, or a custom store — implements one `Adapter` contract, and the operation core (`find`, `create`, `update`, `delete`, plus transactions) is written once against that contract. This is the inversion that Payload only achieved late (its Postgres support arrived years after its Mongo origins) and that Sanity never offered at all (you get Sanity's hosted Content Lake, full stop). In KernelCMS you choose the database the same way you choose storage or auth: as a line in `kernel.config.ts`.

## The shape of the contract

The `Adapter` interface lives in [`@kernel/db`](../01-architecture/adr/0002-drizzle-and-pluggable-db.md). It is deliberately small. The operation core in [`@kernel/server`](../01-architecture/03-runtime-and-server-model.md) compiles a high-level request — a where clause, a sort, pagination, a `depth` for relationship population — into a normalized **Query AST**, then hands that AST to the adapter. The adapter's only job is to turn the AST into native queries and return rows. Validation, access control, hooks, localization merging, and draft/version resolution all happen above the adapter, so a backend author never reimplements business logic.

```ts
// @kernel/db
export interface Adapter {
  readonly capabilities: AdapterCapabilities;

  init(ctx: AdapterInitContext): Promise<void>;
  destroy(): Promise<void>;

  find<T>(args: FindArgs): Promise<PaginatedResult<T>>;
  findOne<T>(args: FindOneArgs): Promise<T | null>;
  create<T>(args: CreateArgs): Promise<T>;
  update<T>(args: UpdateArgs): Promise<T>;
  updateMany<T>(args: UpdateManyArgs): Promise<BulkResult>;
  delete<T>(args: DeleteArgs): Promise<T>;
  deleteMany(args: DeleteManyArgs): Promise<BulkResult>;
  count(args: CountArgs): Promise<number>;

  transaction<R>(fn: (tx: Adapter) => Promise<R>): Promise<R>;

  // Schema lifecycle
  diff(schema: KernelSchema): Promise<MigrationPlan>;
  migrate(plan: MigrationPlan): Promise<void>;
}
```

Two design rules are non-negotiable. First, **every method is async and returns plain JSON-serializable objects** — no ORM entity proxies leak upward, because the Local API, RPC, REST, and GraphQL layers all consume the same shapes. Second, **`transaction` re-enters the same interface**: the callback receives an `Adapter` bound to the open transaction, so the operation core can run a multi-document write (e.g. a document plus its version row plus a relationship join) without knowing whether the underlying store is SQL or Mongo.

### find / create / update / delete

The four CRUD operations share a common argument envelope so the operation core can treat them uniformly.

| Method | Required args | Returns | Notes |
| --- | --- | --- | --- |
| `find` | `collection`, `where`, `sort`, `limit`, `page` | `PaginatedResult<T>` | Returns `docs`, `totalDocs`, `page`, `hasNextPage`. Cursor pagination optional via `capabilities.cursorPagination`. |
| `findOne` | `collection`, `where` | `T \| null` | Convenience path; adapters may special-case lookup by primary key. |
| `create` | `collection`, `data` | `T` | Returns the persisted row including DB-generated id, timestamps. |
| `update` | `collection`, `id` \| `where`, `data` | `T` | Single-document update by id, or first-match by where. |
| `delete` | `collection`, `id` \| `where` | `T` | Returns the deleted document so hooks can fire on the snapshot. |

The adapter does **not** see field-level access rules or `beforeChange` hooks — those run in `@kernel/server`. By the time `create` is called, `data` is already validated and access-filtered. This keeps adapters honest: they persist exactly what they are given.

```ts
// What the operation core hands a SQL adapter for a paginated query
await adapter.find({
  collection: 'posts',
  where: { and: [{ status: { equals: 'published' } }, { authorAge: { gte: 18 } }] },
  sort: [{ field: 'publishedAt', direction: 'desc' }],
  limit: 20,
  page: 1,
  locale: 'en',
  depth: 1, // relationship population requested
});
```

### Transactions

Transactions are first-class because content writes are rarely single-row. Publishing a document touches the document, a version snapshot, and possibly localized rows and relationship joins. SQL adapters wrap these in a real `BEGIN/COMMIT`. The MongoDB adapter uses multi-document transactions when the deployment is a replica set, and otherwise advertises `transactions: false` so the core can degrade to best-effort sequencing with compensating cleanup.

```
operation core            adapter (SQL)
─────────────             ─────────────
publish(doc) ──► transaction(tx => {
                   tx.update('posts', …)      ┐
                   tx.create('_posts_v', …)   │  one BEGIN/COMMIT
                   tx.update('_posts_rels',…) ┘
                 })
```

## Capability flags

No two databases are equal, and pretending otherwise produces leaky abstractions — Strapi's query engine, for instance, exposes operators that silently behave differently across SQL dialects. KernelCMS makes the differences explicit. Each adapter publishes an `AdapterCapabilities` object, and the operation core reads it to decide what it can ask for and what it must emulate.

```ts
export interface AdapterCapabilities {
  transactions: boolean;        // real ACID transactions
  nestedTransactions: boolean;  // savepoints
  jsonQueries: boolean;         // query inside json/jsonb columns
  fullTextSearch: boolean;      // native FTS operator support
  geoQueries: boolean;          // 'point' field near/within
  cursorPagination: boolean;    // keyset pagination
  caseInsensitiveLike: boolean; // ilike / collation-driven
  arrayContains: boolean;       // native array membership
  returning: boolean;           // RETURNING / write-then-read in one round-trip
  maxInClauseSize: number;      // batching threshold for `in`
}
```

| Capability | postgres | sqlite | mysql | mongodb |
| --- | --- | --- | --- | --- |
| `transactions` | ✅ | ✅ | ✅ | ⚠️ replica set only |
| `jsonQueries` | ✅ jsonb | ⚠️ json1 ext | ✅ | ✅ native |
| `fullTextSearch` | ✅ tsvector | ⚠️ FTS5 | ✅ | ✅ text index |
| `geoQueries` | ✅ PostGIS opt. | ❌ | ⚠️ | ✅ 2dsphere |
| `returning` | ✅ | ✅ | ❌ | n/a |
| `cursorPagination` | ✅ | ✅ | ✅ | ✅ |

When a capability is missing, the core has a defined fallback: no native FTS means the `like` operator drives a degraded substring search and search-heavy installs are nudged toward a real search adapter; no `returning` means MySQL does an insert followed by a keyed read inside the same transaction. The contract is that **a missing capability degrades gracefully — it never throws "unsupported."**

## The Query AST

The AST is the lingua franca between the operation core and every adapter. It is the single shared query language the brief promises across REST, GraphQL, RPC, and the Local API. A `where` clause from any surface — a GraphQL `where` input, a REST `?where[status][equals]=published`, or a typed Local API call — parses into the same tree before it ever reaches a database.

```ts
export type WhereNode =
  | { and: WhereNode[] }
  | { or: WhereNode[] }
  | { field: string; operator: Operator; value: unknown };

export type Operator =
  | 'equals' | 'not_equals'
  | 'gt' | 'gte' | 'lt' | 'lte'
  | 'in' | 'not_in'
  | 'like' | 'contains'      // text
  | 'exists'
  | 'near' | 'within';        // geo (point fields)

export interface QueryAST {
  collection: string;
  where?: WhereNode;
  sort: SortClause[];
  pagination: { limit: number; page?: number; cursor?: string };
  depth: number;     // relationship population levels
  locale?: string;   // localized field resolution
  select?: string[]; // projection
}
```

Two properties make this worth the indirection. The AST is **introspectable** — the access-control layer rewrites it before execution, appending tenant or ownership constraints so a user can never query outside their authorization (an `or` node is wrapped in an `and` with the access filter, never merely appended). And it is **field-aware**: because the AST carries the collection's compiled field map, the Postgres adapter knows that `where: { tags: { contains: 'x' } }` targets a relationship join table while `where: { meta: { contains: 'x' } }` targets a `jsonb` column — the same operator, two physical strategies, resolved from config rather than from string guessing.

```
GraphQL / REST / RPC / Local API
            │   (one parser per surface)
            ▼
        Query AST  ──►  access-control rewrite  ──►  adapter.find()
                                                         │
                                          ┌──────────────┼──────────────┐
                                       Drizzle SQL                   Mongo
                                    (postgres/sqlite/mysql)        (find/agg)
```

## How config maps to storage

A collection in `kernel.config.ts` is the source of truth. The SQL adapters compile it through Drizzle into tables; the Mongo adapter compiles it into a collection with a validated shape. Migrations are generated from the diff between the compiled schema and the live database — there is no separate migration DSL to maintain.

```ts
// kernel.config.ts
import { defineConfig, collection } from '@kernel/core';
import { postgresAdapter } from '@kernel/db-postgres';

export default defineConfig({
  db: postgresAdapter({ connectionString: process.env.DATABASE_URL }),
  collections: [
    collection('posts', {
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'body', type: 'richText' },
        { name: 'author', type: 'relationship', relationTo: 'users' },
        { name: 'tags', type: 'relationship', relationTo: 'tags', hasMany: true },
        { name: 'meta', type: 'json' },
        { name: 'location', type: 'point' },
      ],
      localized: ['title', 'body'],
      versions: { drafts: true, autosave: true },
    }),
  ],
});
```

The SQL mapping is opinionated and predictable:

| Config construct | SQL physical model |
| --- | --- |
| `collection('posts', …)` | `posts` table, surrogate `id` + `createdAt`/`updatedAt` |
| scalar field (`text`, `number`, `boolean`, `date`) | column with mapped type + nullability |
| `relationship` (`hasMany: false`) | foreign-key column `author_id` |
| `relationship` (`hasMany: true`) | join table `_posts_rels` (polymorphic-safe) |
| `array` / `blocks` field | child table keyed by parent id + `_order` |
| `json` / `meta` | `jsonb` (Postgres), `json` (MySQL/SQLite) |
| `point` | `geometry`/`point` when `geoQueries`, else two numeric columns |
| `localized: [...]` | `_locales` child table, one row per `(parent, locale)` |
| `versions.drafts` | `_posts_v` version table, autosave rows flagged `latest` |

Mongo collapses arrays, blocks, and localized fields into embedded subdocuments rather than child tables, which is exactly why the adapter exists — document-oriented workflows where a post and its blocks are one read. The key invariant holds across both: **the same `kernel.config.ts` runs unchanged on any adapter.** Content and config are portable between self-host backends and KernelCMS Cloud, with no rewrite — the promise Sanity cannot make because its schema is bound to its hosted Content Lake, and that Payload approximates only within its own two SQL/Mongo paths.

Schema changes flow through `diff` → `MigrationPlan` → `migrate`. The plan is a serializable, reviewable artifact (you commit it), so CI can run migrations deterministically and Cloud can apply them per-tenant. See [Migrations & Schema Diffing](../02-data-modeling/11-data-migrations-and-schema-evolution.md) and the [Drizzle adapter internals](../01-architecture/adr/0002-drizzle-and-pluggable-db.md) for the generation pipeline.

## Open questions

- **Polymorphic relationship indexing.** Join-table `_rels` rows carry a `relationTo` discriminator; whether to maintain per-target partial indexes or one composite index is unsettled and likely dialect-dependent.
- **Cross-adapter transaction semantics.** When a write spans the DB adapter and an external search/queue adapter, we have no distributed transaction. The current plan is outbox-pattern eventual consistency, but the contract surface for it is not finalized.
- **Mongo schema validation strictness.** Whether to enforce `$jsonSchema` validators (rejecting writes at the DB) or rely solely on the operation core's validation is open — the former duplicates rules, the latter loses defense-in-depth.
- **Capability negotiation for custom field types.** A plugin-defined field type may need a capability the core does not yet name. The `AdapterCapabilities` extension mechanism for third-party flags is still under design.
