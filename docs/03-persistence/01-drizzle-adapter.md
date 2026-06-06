# Drizzle Adapter

The Drizzle adapter is the default persistence backend for SQL databases in KernelCMS. It compiles your config-as-code content model into Drizzle table definitions at boot, translates the shared KernelCMS query language into typed Drizzle queries, materializes relationships across collections, and feeds the migration pipeline by diffing the generated schema against the live database. It is the concrete implementation behind `@kernel/db-postgres`, `@kernel/db-sqlite`, and `@kernel/db-mysql` — three dialects, one adapter, one contract.

KernelCMS does not ship its own query DSL the way Payload ships a Mongoose/Drizzle hybrid or Strapi ships its own query engine over Knex. We treat Drizzle as a first-class peer: the adapter generates real Drizzle schema objects you can import, inspect, and extend, and every operation the Local/RPC API performs resolves to a Drizzle statement you could have written by hand. Sanity, by contrast, hides persistence entirely behind GROQ and its hosted datastore — there is no SQL to own. KernelCMS gives you the opposite guarantee: the database is yours, the schema is legible, and the ORM is not a black box.

## Where the Drizzle adapter sits

```
kernel.config.ts (collections, globals, fields)
        │  defineSchema()
        ▼
@kernel/db  ── Adapter contract (CRUD, transactions, query) ──┐
        │                                                      │
        ▼                                                      ▼
@kernel/db-postgres ─┐                              Local/RPC operation core
@kernel/db-sqlite  ──┼─► Drizzle schema + dialect            (@kernel/rpc)
@kernel/db-mysql   ─┘        │                                  │
                            ▼                                   ▼
                   drizzle-kit (migrations) ◄──── schema diff ──┘
```

The adapter is selected in `kernel.config.ts`. You never import dialect-specific Drizzle yourself for ordinary work — the adapter owns the connection, the schema registry, and the dialect quirks.

```ts
import { defineConfig } from '@kernel/core'
import { postgresAdapter } from '@kernel/db-postgres'

export default defineConfig({
  db: postgresAdapter({
    connectionString: process.env.DATABASE_URL!,
    // Optional: extend or override generated tables (escape hatch).
    schemaHooks: {
      afterGenerate: ({ tables, dialect }) => tables,
    },
    pool: { max: 10, idleTimeoutMs: 30_000 },
  }),
  collections: [Posts, Authors, Media],
  globals: [SiteSettings],
})
```

Swapping to SQLite for local dev or to MySQL in production is a one-line change (`sqliteAdapter`, `mysqlAdapter`); the generated schema and migration story adapt to the dialect. See [Schema Generation Internals](../01-architecture/07-content-schema-and-type-generation.md) and Migrations for the layers underneath.

## Drizzle schema generation

Each collection and global becomes one base Drizzle table plus a deterministic set of side tables for fields that cannot live inline. The field-type-to-column mapping is fixed and dialect-aware:

| Field type     | Postgres                     | SQLite            | MySQL                  | Notes |
|----------------|------------------------------|-------------------|------------------------|-------|
| `text`         | `text`                       | `text`            | `varchar(255)`/`text`  | length from `maxLength` |
| `number`       | `numeric`/`integer`          | `real`/`integer`  | `decimal`/`int`        | integer vs float from `precision` |
| `boolean`      | `boolean`                    | `integer` (0/1)   | `boolean`              | |
| `date`         | `timestamptz`                | `text` (ISO)      | `datetime`             | always UTC |
| `email`        | `text` + check               | `text`            | `varchar(320)`         | validated app-side too |
| `json`         | `jsonb`                      | `text` (JSON)     | `json`                 | |
| `point`        | `geometry(Point)`            | `text` (GeoJSON)  | `point`                | PostGIS optional |
| `select`/`radio` | `text` + check enum        | `text`            | `enum`                 | |
| `richText`     | `jsonb`                      | `text`            | `json`                 | portable AST |
| `relationship` | FK column or join table      | same              | same                   | see Relations |
| `array`/`blocks` | child table + `_order`     | child table       | child table            | one table per array/block set |
| `group`/`row`/`tabs` | inlined columns        | inlined           | inlined                | presentational nesting flattens |
| `upload`       | FK to media collection       | FK                | FK                     | |
| `ui`           | (none)                       | (none)            | (none)                 | no column emitted |

Every base table also carries adapter-managed system columns: `id` (uuid v7 by default, configurable), `createdAt`, `updatedAt`, and — when drafts are enabled — `_status` plus a versions side table. Localized fields are not split into per-locale columns the way naive schemas do; instead a single `_locales` child table holds `(parent_id, locale, ...localized_columns)`, which keeps the base table narrow and lets you add a locale without a migration of the parent.

```ts
// Generated (conceptually) for a Posts collection with a localized title,
// a blocks field, and a relationship to Authors.
export const posts = pgTable('posts', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull(),
  status: text('_status', { enum: ['draft', 'published'] }).default('draft'),
  authorId: uuid('author_id').references(() => authors.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
})

export const postsLocales = pgTable('posts_locales', {
  id: uuid('id').primaryKey().defaultRandom(),
  parentId: uuid('parent_id').references(() => posts.id, { onDelete: 'cascade' }),
  locale: text('locale').notNull(),
  title: text('title').notNull(),
})
```

Generation is pure and deterministic: the same config always produces byte-identical schema objects, which is what makes the migration diff trustworthy. Payload's Drizzle layer does something similar, but KernelCMS exposes the generated tables through `adapter.tables` so plugins (`@kernel/plugin-sdk`) and your own server functions can run typed queries against them without reaching into internals.

## Query building

The shared KernelCMS query language — `where`, `sort`, pagination, and `depth` — is identical across REST, GraphQL, and the Local/RPC API. The Drizzle adapter is the single place it gets compiled to SQL. Operators map directly to Drizzle expression builders:

| Query operator        | Drizzle output                          |
|-----------------------|-----------------------------------------|
| `equals` / `not_equals` | `eq()` / `ne()`                       |
| `greater_than` (`gt`) | `gt()`                                  |
| `in` / `not_in`       | `inArray()` / `notInArray()`            |
| `contains` (text)     | `ilike('%v%')` (Postgres) / `like`      |
| `near` (point)        | dialect distance fn (`ST_DWithin`, …)   |
| `and` / `or`          | `and()` / `or()` nesting                |
| localized field       | join to `_locales` filtered by locale   |

```ts
// Local API — same shape the REST/GraphQL layers normalize into.
const result = await kernel.find({
  collection: 'posts',
  where: {
    and: [
      { _status: { equals: 'published' } },
      { 'author.name': { contains: 'Lars' } }, // dotted path → relation join
    ],
  },
  sort: ['-createdAt'],
  locale: 'en',
  depth: 1,
  limit: 20,
})
```

Dotted paths in `where` and `sort` are resolved against the relationship graph and turned into joins, not N+1 round trips. Pagination uses keyset pagination by default for `sort` on indexed columns, falling back to `limit/offset` only when the sort is unstable — this keeps deep pages fast, which is a concrete win over Strapi's offset-only default. The compiled SQL, parameter list, and chosen index are available on the result in `explain` mode for debugging:

```ts
const { sql, params } = await kernel.find({ collection: 'posts', explain: true })
```

Critically, the adapter only ever emits parameterized statements — user input from `where` clauses is bound, never interpolated. There is no string-concatenation path into SQL anywhere in the query builder. See [Access Control](../06-auth-security/01-authorization-and-access-control.md) for how access constraints are merged into the same `where` tree before compilation, so authorization is enforced in the database, not after the rows are fetched.

## Relations

KernelCMS supports four relationship shapes, and the adapter chooses storage per shape:

| Shape                        | Storage                                  |
|------------------------------|------------------------------------------|
| to-one                       | FK column on the owning table            |
| to-many                      | junction table `<owner>_rels`            |
| polymorphic (multiple collections) | `<owner>_rels` with `relation_to` discriminator |
| self / hierarchical          | FK to same table, optional closure table |

```ts
relationship({
  name: 'author',
  relationTo: 'authors',        // to-one → author_id FK
}),
relationship({
  name: 'related',
  relationTo: ['posts', 'guides'], // polymorphic → posts_rels table
  hasMany: true,
}),
```

The `depth` parameter controls population. `depth: 0` returns raw foreign keys; `depth: 1` joins and embeds the immediate related documents; higher depths recurse, with a hard ceiling to prevent runaway joins. The adapter batches related fetches per level using `inArray()` so a list of 20 posts with `depth: 1` authors is two queries, not 21. This is the same N+1 problem Strapi's populate and Sanity's reference expansion fight; KernelCMS solves it at the adapter by design rather than asking the caller to hand-tune populate trees.

```
find posts (limit 20)              ── query 1
  └─ collect author_ids            ── in memory
       └─ select authors where id in (...) ── query 2 (batched)
```

Drizzle's relational query API (`db.query.posts.findMany({ with: { author: true } })`) backs simple cases, but the adapter falls back to explicit joins for polymorphic and localized relations where the relational API is insufficient. Either way, the result is shaped to the KernelCMS document contract, so the operation core never sees Drizzle row shapes.

## Migration integration

Schema is generated from config, so migrations are generated from schema diffs — there is no separate migration DSL to learn. The adapter wraps `drizzle-kit` and snapshots the generated schema on every change.

```bash
kernel migrate:generate   # diff config-derived schema vs last snapshot → SQL
kernel migrate:status     # pending vs applied
kernel migrate:up         # apply forward
kernel migrate:down       # roll back last batch
```

The workflow:

```
edit kernel.config.ts
   │
   ▼
kernel migrate:generate ── snapshot diff ──► migrations/0007_add_excerpt.sql
   │                                              + meta journal entry
   ▼
review SQL (committed to git)
   │
   ▼
kernel migrate:up ──► applied, recorded in __kernel_migrations
```

Generated SQL is written to disk, committed, and reviewed like any code — KernelCMS never silently `push`es schema changes in production. This is a deliberate split from Sanity (schema is config, no SQL to review) and a sharper default than Strapi, whose auto-`alter` in dev has surprised many teams. Destructive operations (dropping a column, narrowing a type) are flagged during `generate` and require an explicit `--allow-destructive` flag plus a generated data-backfill stub, so an accidental field rename can never quietly delete a column of content.

Migrations run inside a transaction per dialect where supported (Postgres, MySQL DDL is partially transactional and the adapter warns accordingly). The `__kernel_migrations` table records hash, name, and applied-at, and the adapter refuses to boot if the live schema hash diverges from the expected snapshot in `strict` mode — catching the "someone hand-edited prod" class of incident before it serves bad data.

## Open questions

- **Cross-dialect type fidelity.** `point` and `richText` have clean Postgres mappings but degrade to `text` on SQLite. Whether to surface a capability matrix and hard-fail at config time when a field requires a feature the chosen dialect lacks, versus silently degrading, is unresolved.
- **Closure tables for deep hierarchies.** Self-referential relations work via FK, but unbounded tree queries (full ancestor/descendant) may warrant an optional closure-table strategy. Whether this is adapter-default or an opt-in plugin in `@kernel/plugin-sdk` is undecided.
- **Online destructive migrations.** The current model is review-then-apply with a maintenance assumption. A zero-downtime expand/contract workflow (add column, backfill, swap, drop) is desirable but not yet specified for the managed [KernelCMS Cloud](../10-cloud-operations/00-deployment-models-self-host-vs-cloud.md) path.
