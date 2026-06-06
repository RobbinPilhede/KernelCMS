# PostgreSQL Adapter

`@kernel/db-postgres` is the default persistence backend for KernelCMS. It implements the single `Adapter` contract from [`@kernel/db`](./00-persistence-overview-and-adapter-contract.md) on top of Drizzle and `node-postgres`/`postgres.js`, and it is the backend we tune hardest. Postgres gives us transactional DDL, native JSONB, real full-text search, partial and expression indexes, and `LISTEN/NOTIFY` — primitives that let KernelCMS push features down into the database instead of emulating them in application code the way the MongoDB adapter must. This document covers the Postgres-specific behavior the adapter relies on, and the knobs you control from `kernel.config.ts`.

## Configuration

The adapter is wired in `kernel.config.ts`. Everything below the connection string is optional and has production-safe defaults.

```ts
import { defineConfig } from '@kernel/core'
import { postgresAdapter } from '@kernel/db-postgres'

export default defineConfig({
  db: postgresAdapter({
    url: process.env.DATABASE_URL!,
    schema: 'public',
    pool: { max: 20, idleTimeoutMs: 30_000, connectionTimeoutMs: 5_000 },
    // Push field-level features into native Postgres constructs.
    jsonb: true,
    fullTextSearch: {
      enabled: true,
      language: 'english',
      generatedColumn: true, // store a STORED tsvector, not a runtime expression
    },
  }),
  collections: [Posts, Media, Authors],
})
```

Unlike Strapi — which abstracts over Knex and targets the lowest common denominator across SQLite/MySQL/Postgres — KernelCMS ships a *dedicated* Postgres adapter. Where Payload exposes a thin Drizzle layer and leans on Drizzle's portable subset, we deliberately emit Postgres-native DDL when the adapter detects it can win. The portability promise lives at the config and operation layer, not in the generated SQL.

## JSONB usage

Most KernelCMS fields map to first-class columns: `text` → `text`, `number` → `numeric`/`integer`, `date` → `timestamptz`, `boolean` → `boolean`, `point` → `geometry`/`point`. Structured composite fields — `json`, `group`, `array`, `blocks` — are where the relational/document split matters, and where Postgres's JSONB earns its place.

The adapter follows a hybrid model:

| Field type | Default storage | Rationale |
|---|---|---|
| `json`, `code` | `jsonb` column | Opaque payload; no per-element querying expected |
| `group` | flattened columns *or* `jsonb` | Flattened when the group is fixed-shape and queried; `jsonb` when presentational |
| `array` | child table *or* `jsonb` | Child table when rows are filtered/sorted; `jsonb` for small ordered lists |
| `blocks` | child table (`_blocks` + discriminator) | Always relational — blocks need stable IDs, ordering, and per-block access control |
| `richText` | `jsonb` document | Editor AST stored whole; queried by extracted plain text (see below) |

`jsonb` over `json` is non-negotiable for the adapter: `json` stores the raw text and reparses on every access, while `jsonb` is decomposed binary, deduplicates keys, supports GIN indexing, and powers the `@>`, `?`, and `jsonb_path_query` operators we map the query language onto.

The shared KernelCMS query language (`where` / `sort` / `pagination` / `depth`) compiles JSONB access down to native operators. A `where` clause against a nested key becomes a containment or path query, not a full-table scan:

```ts
// Local API — typed, in-process
const posts = await payload.find('posts', {
  where: { 'seo.canonical': { exists: true } },
  sort: '-publishedAt',
})
```

```sql
-- emitted by @kernel/db-postgres
SELECT * FROM posts
WHERE (data -> 'seo' ? 'canonical')
ORDER BY published_at DESC
LIMIT 25;
```

For hot JSONB paths the adapter can promote a key to a generated column plus a btree index (see indexing). Sanity's GROQ runs against an opaque document store and Sanity owns the indexing decisions; in KernelCMS you keep relational guarantees — foreign keys, transactional writes, `EXPLAIN` you can read — while still getting document flexibility where it pays off.

### When the adapter chooses a child table

Arrays and blocks default to child tables because version history, drafts, and field-level access control all need stable per-row identity. A `blocks` field generates one table per parent collection with a `_type` discriminator, a `_order` column, and a foreign key back to the parent revision. This keeps autosave diffs small and lets `depth` joins resolve relationships inside blocks without rehydrating an entire JSONB tree.

## Full-text search

The Postgres adapter implements the `search` capability of the `Adapter` contract using native `tsvector`/`tsquery` rather than `ILIKE '%term%'`. `ILIKE` can't use a btree index, ignores stemming, and degrades linearly with table size — fine for Strapi's default content-type search at small scale, wrong as a default at ours.

When `fullTextSearch.enabled` is true, the adapter generates a **STORED generated column** per searchable collection and a GIN index over it:

```sql
ALTER TABLE posts ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(excerpt, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(plain_text, '')), 'C')
  ) STORED;

CREATE INDEX posts_search_idx ON posts USING gin (search_vector);
```

`plain_text` is the flattened text extraction of the `richText` JSONB AST, maintained by `@kernel/richtext` on write — we never run `to_tsvector` over raw editor JSON. Weights (`A`–`D`) let title matches outrank body matches in `ts_rank`. You declare searchability and weights per field:

```ts
fields: [
  { name: 'title',   type: 'text',     index: { search: 'A' } },
  { name: 'excerpt', type: 'textarea', index: { search: 'B' } },
  { name: 'body',    type: 'richText', index: { search: 'C' } },
]
```

A search query flows through the same operation core as everything else:

```ts
const results = await payload.find('posts', {
  where: { _search: { matches: 'tanstack router' } },
  sort: '-_rank',
})
```

```sql
SELECT *, ts_rank(search_vector, query) AS _rank
FROM posts, websearch_to_tsquery('english', $1) query
WHERE search_vector @@ query
ORDER BY _rank DESC
LIMIT 25;
```

We use `websearch_to_tsquery` so end-user input (`"exact phrase" -excluded`) is parsed safely without hand-rolling `tsquery` syntax — and `$1` is always parameterized, never interpolated. This is the default, zero-infrastructure search tier. When you outgrow it, the same `_search` operator is satisfied by an external `@kernel/search` adapter (Postgres FTS → Typesense/Meilisearch/Elastic) with no change to collection config or query code. Sanity ships hosted search as part of the platform; KernelCMS makes the *built-in* tier production-real and the *upgrade* a swap.

## Indexing strategy

The adapter generates indexes from config and from access patterns it can prove, then leaves an escape hatch for everything else. There is no magic auto-indexing daemon; indexes are emitted into migrations so they are reviewable and reproducible.

What the adapter creates automatically:

- **Primary keys** — `uuid` (default) or `serial`, configurable per collection.
- **Foreign key columns** — every `relationship`/`upload` FK column gets a btree index. Postgres does *not* index FK columns automatically, and missing them is the most common cause of slow `depth` joins and slow cascade deletes.
- **`unique` fields** — a unique btree index; with localization, scoped `(value, locale)`.
- **Sort defaults** — the collection's `defaultSort` column.
- **Soft-delete / draft predicate** — a **partial index** so the common "published only" read path stays cheap:

```sql
CREATE INDEX posts_published_idx ON posts (published_at DESC)
  WHERE _status = 'published' AND deleted_at IS NULL;
```

You declare additional indexes per field or per collection, including composite and JSONB expression indexes:

```ts
const Posts = defineCollection({
  slug: 'posts',
  indexes: [
    { fields: ['authorId', 'publishedAt'], order: ['asc', 'desc'] }, // composite
    { on: "(data->>'sku')", unique: true },                          // JSONB expression
  ],
  fields: [
    { name: 'slug', type: 'text', unique: true, index: true },
  ],
})
```

Index decision flow:

```
field/query
    │
    ├─ FK column? ───────────────► btree (auto)
    ├─ unique constraint? ───────► unique btree (auto, locale-scoped if localized)
    ├─ searchable? ──────────────► gin over tsvector (auto)
    ├─ jsonb containment query? ─► gin (jsonb_path_ops) on the jsonb column
    ├─ hot jsonb scalar path? ───► generated column + btree
    ├─ filtered subset (status)? ► partial btree
    └─ declared composite? ──────► multicolumn btree (order-aware)
```

GIN over JSONB uses `jsonb_path_ops` by default — smaller and faster for the `@>` containment queries our query compiler emits, at the cost of not supporting key-existence (`?`) lookups. The adapter picks the default GIN opclass when a path uses existence operators. Strapi leaves indexing almost entirely to you; Payload indexes fields you flag. KernelCMS adds the access-pattern-derived defaults (FK, partial-status, search) on top of declarative flags, because those are the indexes people forget and then page on.

## Connection pooling

KernelCMS runs on TanStack Start across Node, Bun, and edge runtimes, so the pool strategy adapts to the host.

```
Node / Bun (long-lived process)
  app ──► node-postgres Pool (max: 20) ──► Postgres
          └ idle reuse, keepalive, server-side prepared statements

Edge / serverless (per-invocation, no socket reuse)
  fn ──► HTTP driver (Neon/Supabase) ──► PgBouncer/pooler ──► Postgres
         └ no client pool; transaction-mode pooling upstream
```

On a persistent server, the adapter holds one `node-postgres` Pool. Defaults: `max: 20`, `idleTimeoutMs: 30_000`, `connectionTimeoutMs: 5_000`, plus TCP keepalive. The cap matters — Postgres connections are processes, and `max` across all app instances must stay under `max_connections` minus headroom. Size it as `(max_connections - superuser_reserved - admin) / instance_count`, not by guessing per box.

In serverless and edge deployments there is no durable socket to pool, so the adapter switches to an HTTP/WebSocket driver and expects an external pooler (PgBouncer, Neon, Supabase) in **transaction mode**. The adapter detects transaction-mode pooling and disables client-side prepared statements automatically (named prepared statements break across pooled connections). You can force it:

```ts
postgresAdapter({
  url: process.env.DATABASE_URL!,
  pool: { mode: 'transaction', preparedStatements: false },
})
```

Every KernelCMS write operation — create/update with versioning, draft promotion, block child-table rewrites — runs inside a single transaction acquired from the pool and released promptly. Long-running reads (exports, large `find` with deep `depth`) are routed to a separate read pool when `replicas` are configured, so a slow report never starves the write path. Payload and Strapi both pool, but neither separates the autosave/version write path from heavy reads by default; at scale that separation is the difference between a janky admin and a smooth one.

## Postgres-only features

Capabilities the adapter exposes that have no portable equivalent — gated behind capability flags so the shared API stays honest on other backends:

- **`LISTEN/NOTIFY`** — the change-feed source for TanStack DB live collections and admin live preview. On write, the adapter emits `NOTIFY kernel_changes` with the collection and document ID; `@kernel/server` fans it out over server functions to subscribed TanStack Query caches. No polling, no separate broker for single-region deploys.
- **Transactional DDL** — migrations generated from schema diffs run inside a transaction and roll back cleanly on failure. SQLite gets most of this; MySQL's implicit-commit DDL does not, which is why Postgres is the recommended production target.
- **Row-level security** — optional generation of RLS policies from collection access-control rules for defense-in-depth, so a leaked connection string still can't read another tenant's rows. See [multi-tenancy](../10-cloud-operations/03-multi-tenancy-and-isolation.md).
- **Expression & partial indexes** — used throughout the indexing strategy above; not expressible on MySQL/SQLite the same way.
- **`generated ... stored` columns** — back both the FTS vector and promoted JSONB scalar paths.
- **`citext` / `pg_trgm`** — optional case-insensitive uniqueness and trigram fuzzy matching for the search adapter's typo tolerance tier.

These run as `@kernel/db` capability flags. Code written against the Local/RPC API stays portable; when a flag is unsupported on the active adapter (e.g. MongoDB), the operation core falls back or surfaces a typed `UnsupportedCapabilityError` rather than silently degrading.

## Open questions

- **JSONB vs. child-table threshold for `array`.** The default heuristic (filterable/sortable → child table) may need a `storage: 'jsonb' | 'table'` per-field override exposed in stable config rather than as an experimental flag.
- **Default GIN opclass.** Defaulting to `jsonb_path_ops` optimizes containment but breaks key-existence queries; we may need to inspect declared `where` shapes at build time and pick the opclass per index automatically.
- **Logical replication for change feeds.** `LISTEN/NOTIFY` is simple but doesn't survive multi-region or guarantee delivery. Whether to offer a `wal2json`/logical-replication change source as a Cloud-tier upgrade is undecided.
- **Pool ownership under heavy SSR.** Whether the read/write pool split should be automatic when replicas are detected, or always opt-in via config, is still open.
