# MySQL Adapter

`@kernel/db-mysql` is the Drizzle-backed adapter for MySQL 8.0+ and MariaDB 10.6+. It implements the same Adapter contract as [`@kernel/db-postgres`](./02-postgres-adapter.md) and [`@kernel/db-sqlite`](./03-sqlite-adapter.md), so collections, globals, drafts, versions, localization, and access control all behave identically at the operation layer. What differs is below the waterline: MySQL's type system, its weaker JSON ergonomics, and its index/row-size limits force a handful of concrete decisions that this document spells out. Read it before you commit to MySQL, because two of the constraints — generated-column indexing and the 3072-byte index prefix limit — will shape how you model rich content.

## When to choose MySQL

Postgres is the default backend for KernelCMS and the one we optimize first. Choose MySQL when you already operate a MySQL fleet, when your hosting (PlanetScale, Vitess, RDS MySQL, Aurora MySQL) mandates it, or when an existing application's data lives in MySQL and you want KernelCMS tables alongside it. Payload added MySQL as a first-class Drizzle target in its 3.0 line; Strapi runs on MySQL/MariaDB through Knex; Sanity has no SQL story at all. KernelCMS sits with Payload and Strapi here, but unlike Strapi's Knex layer — which papers over backend differences and silently degrades — we expose the limitations explicitly and fail loudly in `kernel doctor` rather than at runtime.

```ts
// kernel.config.ts
import { defineConfig } from '@kernel/core'
import { mysqlAdapter } from '@kernel/db-mysql'

export default defineConfig({
  db: mysqlAdapter({
    url: process.env.DATABASE_URL, // mysql://user:pass@host:3306/kernel
    pool: { connectionLimit: 10 },
    // MariaDB needs an explicit flavor: JSON, CHECK, and functional
    // index support differ enough that we branch on it internally.
    flavor: 'mysql', // 'mysql' | 'mariadb'
    charset: 'utf8mb4', // enforced; see "Charset and collation"
  }),
  collections: [Posts, Media],
  globals: [SiteSettings],
})
```

`flavor` is not cosmetic. MariaDB stores `JSON` as `LONGTEXT` with a `CHECK (json_valid(...))` constraint and lacks MySQL's binary JSON functions; the adapter generates different DDL and different query SQL for each. Setting it wrong produces migrations that apply but query paths that throw, so the adapter cross-checks `flavor` against `SELECT VERSION()` at boot and refuses to start on a mismatch.

## Type mapping

Every KernelCMS field type maps to a concrete MySQL column type. The adapter never uses `TEXT` where a sized `VARCHAR` is correct, because indexing rules (below) depend on it.

| Field type         | MySQL column                                                | Notes                                                                                                                    |
| ------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `text`             | `VARCHAR(255)` default, `TEXT` when `maxLength > 255`       | Crossing 255 silently moves the column to `TEXT`, which changes indexability. The adapter warns.                         |
| `textarea`         | `TEXT`                                                      | `MEDIUMTEXT`/`LONGTEXT` selectable via `field.db.columnType`.                                                            |
| `number`           | `DOUBLE`, or `BIGINT`/`INT` when `field.db.integer`         | `decimal` mode emits `DECIMAL(p,s)` for money.                                                                           |
| `boolean`          | `TINYINT(1)`                                                | MySQL has no native boolean; `1`/`0` round-trip to JS `true`/`false`.                                                    |
| `date`             | `DATETIME(3)`                                               | `TIMESTAMP` is avoided — its 2038 ceiling and implicit `ON UPDATE` are footguns. Millisecond precision is on by default. |
| `email`            | `VARCHAR(255)`                                              | Indexed with a normalized lowercase generated column when `unique`.                                                      |
| `json`             | `JSON` (MySQL) / `LONGTEXT + json_valid` (MariaDB)          | See [JSON columns](#json-columns).                                                                                       |
| `code`             | `LONGTEXT`                                                  | No length cap; not indexed.                                                                                              |
| `point`            | `POINT` with SRID 4326                                      | `ST_*` functions; spatial index requires `NOT NULL`.                                                                     |
| `select` / `radio` | `VARCHAR(255)`                                              | We do **not** emit `ENUM`; see below.                                                                                    |
| `relationship`     | `BIGINT` FK column, or join table for `hasMany`/polymorphic | Matches the Postgres relational layout.                                                                                  |
| `upload`           | `BIGINT` FK to the media collection                         | Same as `relationship`.                                                                                                  |
| `richText`         | `JSON`                                                      | The block tree is stored as JSON; see [JSON columns](#json-columns).                                                     |
| `array` / `blocks` | child table with `_order` + `_parent_id`                    | Identical strategy to Postgres for stable ordering.                                                                      |

### Why no ENUM for `select`

MySQL `ENUM` looks like the natural home for a `select` field, and Strapi-on-MySQL leans on it. We refuse it. Adding or reordering an `ENUM` value is an `ALTER TABLE` that, on older MySQL, copies the whole table and takes a metadata lock — unacceptable when an editor adds one option to a "status" field on a 50M-row collection. `select` options are config-as-code and change as often as code does, so they map to `VARCHAR(255)` with an application-level and optional `CHECK` constraint:

```ts
// A select field's options live in config, not in DDL.
{
  name: 'status',
  type: 'select',
  options: ['draft', 'in_review', 'published'],
  // Adapter emits: status VARCHAR(255), plus
  // CHECK (status IN ('draft','in_review','published')) on MySQL 8.0.16+.
}
```

On MariaDB and pre-8.0.16 MySQL the `CHECK` is enforced in the operation layer by validation instead, so behavior is uniform regardless of where the constraint lives.

## JSON columns

`json`, `richText`, and any field marked `field.db.type = 'json'` land in a JSON column. This is where the MySQL/MariaDB split is sharpest.

```
KernelCMS field                  MySQL 8.0            MariaDB 10.6+
─────────────────────────────────────────────────────────────────────
json / richText  ──────────────► JSON (binary)        LONGTEXT + json_valid()
where: { meta->>'$.lang' }  ────► JSON_EXTRACT +       JSON_VALUE / JSON_EXTRACT
                                  JSON_UNQUOTE         (string semantics)
index on a JSON path  ──────────► generated col +      generated col +
                                  index                index (10.6+ only)
```

On MySQL 8, JSON is a real binary type with partial in-place updates and `->>` path operators, and the shared KernelCMS query language compiles `where` clauses against JSON paths natively:

```ts
// One query language, all backends. On MySQL this compiles to
// JSON_UNQUOTE(JSON_EXTRACT(meta, '$.seo.title')) = ?
const res = await kernel.find({
  collection: 'posts',
  where: { 'meta.seo.title': { equals: 'Launch' } },
  depth: 0,
})
```

On MariaDB, `JSON` is an alias for `LONGTEXT`, so comparisons are string comparisons unless you route through `JSON_VALUE`. The adapter does that routing for you, but two consequences leak through and you should know them:

- **No partial updates.** MariaDB rewrites the entire `LONGTEXT` on every save. For a large `richText` document this is more write amplification than MySQL 8's in-place `JSON_SET`. Keep oversized rich-text trees out of hot-write collections.
- **Ordering and equality are byte-wise.** Numeric JSON values do not sort numerically without an explicit cast, which the adapter inserts when the field's declared type is `number`.

To index inside JSON, MySQL and MariaDB both require a **generated column** plus an index on it — you cannot index a raw JSON path directly. KernelCMS makes this declarative:

```ts
{
  name: 'meta',
  type: 'json',
  db: {
    // Promotes meta->'$.seo.slug' to a stored generated column
    // and indexes it. The migration generator emits the ALTER.
    indexedPaths: [
      { path: '$.seo.slug', as: 'meta_seo_slug', type: 'varchar(191)', unique: true },
    ],
  },
}
```

That produces:

```sql
ALTER TABLE posts
  ADD COLUMN meta_seo_slug VARCHAR(191)
    AS (JSON_UNQUOTE(JSON_EXTRACT(meta, '$.seo.slug'))) STORED,
  ADD UNIQUE INDEX posts_meta_seo_slug_uq (meta_seo_slug);
```

Sanity indexes everything in its hosted GROQ engine and you never think about this; the trade is you cannot self-host it. KernelCMS hands you the lever and the cost: every indexed JSON path is a stored column you maintain. The generator surfaces unindexed `where` filters on JSON paths as a `kernel doctor` warning so you find the missing index before production does.

## Limitations versus Postgres

These are the differences that change how you model content, not micro-optimizations. The adapter normalizes what it can and refuses migrations that would silently break.

| Capability                   | Postgres               | MySQL / MariaDB                         | KernelCMS handling                                                                  |
| ---------------------------- | ---------------------- | --------------------------------------- | ----------------------------------------------------------------------------------- |
| `JSONB` in-place ops         | Yes                    | MySQL 8 partial; MariaDB full rewrite   | Adapter avoids hot-write JSON on MariaDB; documented.                               |
| Array column type            | Native `_type[]`       | None                                    | `hasMany` and arrays always use child tables — no behavioral gap.                   |
| Partial / expression indexes | Yes                    | Generated column only                   | `indexedPaths` API generates the column for you.                                    |
| `ENUM` for selects           | Native, cheap to alter | Expensive to alter                      | We use `VARCHAR` + `CHECK` everywhere.                                              |
| Index key length             | ~2704 bytes effective  | **3072 bytes** (InnoDB, utf8mb4)        | Long `text` keys auto-prefixed; see below.                                          |
| `RETURNING` on write         | Yes                    | No                                      | Adapter does insert-then-select in one transaction.                                 |
| Transactional DDL            | Yes                    | No (implicit commit per DDL)            | Migrations run statement-by-statement with a recovery checkpoint.                   |
| Deferred FK constraints      | Yes                    | No                                      | Insert order is topologically sorted by the writer.                                 |
| Case-sensitive text          | Per-column             | Collation-driven (`utf8mb4_0900_ai_ci`) | `unique` text uses a `_bin`-collated generated column to avoid surprise collisions. |

The two that bite hardest:

**No transactional DDL.** Each `ALTER TABLE` commits on its own. A migration that fails halfway cannot roll back the statements before it. `kernel migrate` writes a per-statement checkpoint and, on failure, prints exactly which statement landed and what to run to recover — it does not pretend the whole migration was atomic, because on MySQL it never is. Postgres users get true all-or-nothing; plan maintenance windows accordingly.

**The 3072-byte index limit.** With `utf8mb4` (4 bytes/char), a `VARCHAR(255)` index key is 1020 bytes — fine. But a unique index across two `VARCHAR(255)` columns, or any index touching a long `text` field, can blow the limit. The adapter caps index key prefixes at 191 characters (`191 × 4 = 764 bytes`) when a `text` field is indexed and warns when a composite unique would exceed the limit, suggesting a hashed generated column instead:

```sql
-- Instead of indexing a long path directly, hash it:
ALTER TABLE pages
  ADD COLUMN path_hash BINARY(20)
    AS (UNHEX(SHA1(path))) STORED,
  ADD UNIQUE INDEX pages_path_hash_uq (path_hash);
```

## Indexing notes

The defaults are tuned so a fresh collection performs well without hand-tuning, and every index is config-as-code so it lands in a reviewable migration rather than being applied out of band.

- **Primary keys.** `BIGINT AUTO_INCREMENT` by default. Opt into `CHAR(36)` UUIDv7 or `BINARY(16)` for distributed/sharded setups via `idStrategy`. UUIDv7 keeps inserts append-friendly on the clustered index — random UUIDv4 fragments the B-tree and is a common MySQL performance bug we steer you away from.
- **Clustered index awareness.** InnoDB clusters rows on the PK and every secondary index carries the PK as its tail. A wide PK inflates every index, so keep it narrow — another reason `BIGINT` beats `CHAR(36)` unless you genuinely need distributed IDs.
- **Localization.** Localized fields live in a `_locales` child table keyed by `(_parent_id, _locale)`, indexed as a composite. List queries filtered by locale hit that index directly; there is no per-locale column explosion.
- **Drafts and versions.** The `_versions` table is indexed on `(parent_id, version, updated_at)` so version-history pagination and autosave lookups stay on an index. High-churn autosave collections should set a `versions.max` retention cap — unbounded version rows are the most common way a MySQL-backed KernelCMS table grows out of control.
- **Foreign keys.** Every `relationship`/`upload` FK column is indexed automatically; MySQL does not auto-index FKs in all engine paths and an unindexed FK turns cascading deletes into table scans.
- **Full-text.** `FULLTEXT` indexes are available on `text`/`textarea` via `field.db.fulltext`, but they are a fallback. For real search, use a search adapter (`@kernel/search-*`); MySQL `FULLTEXT` has no relevance tuning, no faceting, and ignores `utf8mb4` emoji.

```ts
{
  name: 'slug',
  type: 'text',
  unique: true, // emits a 191-char-prefixed unique index on utf8mb4
  index: true,
  db: { columnType: 'varchar(191)' }, // explicit, indexable, no warning
}
```

### Charset and collation

The adapter forces `utf8mb4` and refuses `utf8` (the 3-byte legacy charset that cannot store emoji or many CJK characters). The default collation is `utf8mb4_0900_ai_ci` on MySQL 8 and `utf8mb4_uca1400_ai_ci` on MariaDB. Both are accent- and case-insensitive for matching, which is what editors expect from search-style filters. `unique` text fields additionally get a `_bin`-collated generated column so that `Foo` and `foo` are treated as distinct keys when uniqueness must be exact — otherwise the default case-insensitive collation would reject `foo` as a duplicate of `Foo`, a subtle bug Strapi users hit regularly.

## Open questions

- **MariaDB JSON parity.** Whether to keep MariaDB at full parity or mark it "supported, JSON-degraded" and steer JSON-heavy schemas to MySQL 8 / Postgres. The write-amplification on `LONGTEXT` rich text is the deciding factor and needs benchmarking against real document sizes.
- **Vitess/PlanetScale FK story.** PlanetScale historically disallowed foreign keys; our relational layout depends on them. We may ship a `foreignKeys: 'application'` mode that enforces referential integrity in the writer instead of the database, but the cascade semantics for `array`/`blocks` child tables are not yet settled.
- **Online DDL strategy.** Whether to integrate `gh-ost`/`pt-online-schema-change` hooks into `kernel migrate` for large tables, given MySQL's lack of transactional DDL, or leave that to the operator.
