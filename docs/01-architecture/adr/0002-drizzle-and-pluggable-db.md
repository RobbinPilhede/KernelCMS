# ADR 0002: Drizzle and Pluggable Database Adapters

KernelCMS treats the database as a swappable adapter, not a hard-wired dependency. This ADR records why **Drizzle** is the default ORM for the SQL adapters (`@kernel/db-postgres`, `@kernel/db-sqlite`, `@kernel/db-mysql`), why a separate non-Drizzle path exists for `@kernel/db-mongodb`, and how every backend is forced to satisfy a single `Adapter` contract defined in `@kernel/db`. It also records what we rejected — Prisma and hand-rolled raw SQL — and the consequences we are accepting in exchange for end-to-end type safety and schema-diff migrations.

## Status

Accepted. Supersedes the exploratory spike noted in ADR 0001. Affects `@kernel/db`, `@kernel/db-postgres`, `@kernel/db-sqlite`, `@kernel/db-mysql`, `@kernel/db-mongodb`, and the migration tooling shipped in `@kernel/cli`.

## Context

Content in KernelCMS is modeled in code. A `kernel.config.ts` declares collections, globals, and fields, and that config is the single source of truth — see [collections and fields](../../02-data-modeling/01-collections.md). Everything downstream (REST, GraphQL, the typed RPC/Local API, the admin forms built on TanStack Form) is generated from it. The database layer has one job: take an abstract content schema plus a query (`where` / `sort` / pagination / `depth`) and turn it into reads and writes against a concrete store, with full type inference preserved on the way out.

That job pulls in three hard requirements:

1. **We do not own the database choice.** The wedge of the product is _choose everything_. Payload effectively centers on Mongo (with a newer Postgres path), Strapi defaults to its own knex-based layer, and Sanity is a proprietary hosted datastore you cannot self-host. KernelCMS has to support Postgres (default), SQLite/libSQL, MySQL, and MongoDB _behind one contract_, and let a community ship a sixth.
2. **Types must survive the round trip.** A field declared `text` and `required` must produce a non-nullable `string` at the call site of `payload.find()` (our Local API) with zero `any`. The ORM cannot be a type black hole.
3. **Migrations come from schema diffs.** The user never writes a migration by hand for a field they added in `kernel.config.ts`. The CLI diffs the desired schema against the live database and emits a migration. That means the schema representation has to be _introspectable as data_, not buried in a code generator we don't control.

A CMS schema is also unusually dynamic. Collections are user-defined, fields can be localized (one column or one row per locale), drafts and versions multiply the physical tables, and relationships and `upload` fields create join tables. We are not mapping a fixed set of hand-written models — we are _constructing_ Drizzle table definitions at boot from the content config. The ORM must let us build schema objects programmatically and still type the results.

```
kernel.config.ts (collections, globals, fields)
        │  compile
        ▼
  abstract schema (IR)  ──►  @kernel/db  Adapter contract
        │                         │
        │            ┌────────────┼────────────┬──────────────┐
        ▼            ▼            ▼             ▼              ▼
   migration     db-postgres   db-sqlite    db-mysql      db-mongodb
   diff engine   (Drizzle/pg)  (Drizzle)    (Drizzle)     (native driver)
```

## Decision

**Use Drizzle as the default ORM for all SQL adapters. Define one `Adapter` interface in `@kernel/db` that every backend implements, SQL or not. Generate Drizzle table objects from the compiled content schema at boot, and drive migrations from schema diffs through `drizzle-kit`'s introspection primitives.**

### Why Drizzle specifically

Drizzle is a thin, SQL-first query builder with a fully typed schema-as-data model. Three properties made it the choice:

- **Schema is a value, not a DSL file.** `pgTable("posts", { ... })` returns a plain object we can build at runtime from our IR. We need exactly this — our tables don't exist until we read the user's collections.
- **No separate codegen step or query engine binary.** Drizzle compiles to SQL in-process. There is no Rust query engine to ship per-platform (the operational tax that makes Prisma painful on edge runtimes and serverless cold starts). KernelCMS targets Node, Bun, _and_ edge — see [deployment runtimes](../../10-cloud-operations/00-deployment-models-self-host-vs-cloud.md) — so a pure-TS data layer is non-negotiable.
- **Inference is precise.** A Drizzle column's nullability, type, and default flow through `InferSelectModel` / `InferInsertModel` into our result types without an `as` cast.

### The adapter contract

Every backend — Postgres, SQLite, MySQL, Mongo — implements the same surface. The operation core in `@kernel/server` only ever calls this; it has no knowledge of Drizzle or any driver.

```ts
// @kernel/db
export interface DatabaseAdapter {
  readonly name: 'postgres' | 'sqlite' | 'mysql' | 'mongodb' | (string & {})

  init(schema: CompiledSchema): Promise<void>

  find<T extends CollectionSlug>(args: FindArgs<T>): Promise<Paginated<DocumentOf<T>>>

  findByID<T extends CollectionSlug>(args: {
    collection: T
    id: ID
    depth?: number
    locale?: Locale
  }): Promise<DocumentOf<T> | null>

  create<T extends CollectionSlug>(args: { collection: T; data: InsertOf<T>; locale?: Locale }): Promise<DocumentOf<T>>

  update<T extends CollectionSlug>(args: { collection: T; id: ID; data: Partial<InsertOf<T>> }): Promise<DocumentOf<T>>

  delete<T extends CollectionSlug>(args: { collection: T; id: ID }): Promise<DocumentOf<T>>

  // versions / drafts / autosave
  createVersion<T extends CollectionSlug>(args: VersionArgs<T>): Promise<Version<T>>

  // transactions span an entire operation (doc + relations + versions)
  transaction<R>(fn: (tx: TransactionScope) => Promise<R>): Promise<R>

  // migrations are introspected and applied through the adapter
  migrate(args: { direction: 'up' | 'down' }): Promise<MigrationResult>
}
```

The shared query language (`where` / `sort` / pagination / `depth`) is the _same_ across every surface and every adapter. The SQL adapters translate a `where` tree into Drizzle conditions; the Mongo adapter translates the identical tree into a filter document. The user — and the REST/GraphQL/RPC generators — never see the difference.

### Selecting an adapter in `kernel.config.ts`

The adapter is one line. Switching databases changes the import and the connection, nothing else in the content config.

```ts
import { defineConfig } from '@kernel/core'
import { postgresAdapter } from '@kernel/db-postgres'
import { Posts } from './collections/Posts'
import { SiteSettings } from './globals/SiteSettings'

export default defineConfig({
  db: postgresAdapter({
    url: process.env.DATABASE_URL!, // never hardcode credentials
    pool: { max: 10 },
    schema: 'public',
  }),
  collections: [Posts],
  globals: [SiteSettings],
})
```

```ts
// SQLite / libSQL — same config, different adapter
import { sqliteAdapter } from '@kernel/db-sqlite'

db: sqliteAdapter({
  url: process.env.DATABASE_URL ?? 'file:./kernel.db',
  authToken: process.env.TURSO_AUTH_TOKEN, // libSQL/Turso
}),
```

```ts
// MongoDB — document-oriented; same Adapter contract, no Drizzle underneath
import { mongodbAdapter } from '@kernel/db-mongodb'

db: mongodbAdapter({ url: process.env.MONGODB_URI! }),
```

### Migrations from schema diffs

`@kernel/cli` compiles `kernel.config.ts` to the desired schema, asks the live database for its current shape, and produces a diff. For SQL adapters this rides on `drizzle-kit`'s introspection; the CLI emits a reviewable, checked-in TypeScript migration rather than auto-mutating production.

```bash
kernel db generate   # diff config → SQL migration file
kernel db migrate    # apply pending migrations
kernel db status     # show applied / pending
```

Generated migrations are versioned and ordered. The default policy is **generate-and-review**: KernelCMS never silently runs DDL against a production database the way `prisma db push` encourages in development. See [migrations](../../02-data-modeling/11-data-migrations-and-schema-evolution.md).

## Consequences

### Positive

- **One contract, many stores.** Adding a backend means implementing `DatabaseAdapter`, not touching the operation core. The community can ship `@kernel/db-cockroach` or a D1 adapter without a fork.
- **Edge-ready.** No query-engine binary, no codegen daemon. Cold starts are fast; Bun and edge runtimes work without per-target builds.
- **Type fidelity end to end.** Drizzle's inference is the backbone of the typed Local API and the RPC layer, with zero `any` in the data path.
- **Reviewable migrations** that live in the repo and pass through code review.

### Negative / costs we accept

| Cost                                                                                         | Mitigation                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Drizzle's relational query API is younger than Prisma's; some advanced joins are hand-built. | We control the `where`→SQL translation in `@kernel/db-postgres`; complex relational reads are our code, not a leaky abstraction.                                            |
| Two physical paradigms (SQL tables vs. Mongo documents) behind one interface.                | The `Adapter` contract is behavioral, not structural — versions/drafts are modeled per-adapter, validated by a shared conformance test suite.                               |
| SQL-dialect drift (Postgres `jsonb` vs. MySQL `json` vs. SQLite text-JSON).                  | Field-type→column mapping is centralized per adapter and covered by the conformance suite; the `json`, `point`, and `richText` fields have explicit per-dialect strategies. |
| We own more low-level SQL than a "batteries-included" ORM would write for us.                | This is the intended trade: predictable SQL beats a magic query planner we cannot inspect.                                                                                  |

### Conformance suite

Because the contract is behavioral, every adapter must pass the same suite in `@kernel/db`: CRUD, pagination, `depth`-based relationship population, localized fields, drafts/versions/autosave, transactional rollback, and `where`-operator coverage. An adapter that compiles but fails conformance is not a supported backend. This is how we keep "swappable" honest instead of aspirational.

## Alternatives considered

### Prisma

Prisma offers excellent ergonomics and the most mature relational query API in the TS ecosystem, which is why Payload added a Prisma-adjacent path and many teams reach for it first.

We rejected it for KernelCMS as the _default_ for concrete reasons:

- **The schema is a `.prisma` DSL, not data.** Our collections are user-defined at runtime; we'd have to generate a `.prisma` file from config, run codegen, and reload the client. That is a build step inside a content operation — wrong shape entirely.
- **The query engine binary.** Prisma historically shipped a Rust engine per platform. Even with the newer driver-adapter / pure-JS direction, the operational and cold-start cost on edge and serverless conflicted with our runtime matrix.
- **Migrations assume hand-edited models.** `prisma migrate` is built around a developer editing `schema.prisma`. Our migrations are derived from config diffs the user never hand-writes.

Prisma is a fine choice for an app with a fixed, developer-authored schema. KernelCMS has neither.

### Raw SQL (hand-written, per dialect)

The maximal-control option: write SQL by hand for each of Postgres, SQLite, and MySQL.

- **Pro:** zero abstraction tax, perfect SQL.
- **Con:** we'd re-implement parameterization, type inference, and three dialects of DDL ourselves, then maintain it forever. Type safety from a content config to a raw string is something we'd have to _build_ — which is most of what Drizzle already gives us for free.

We use raw SQL surgically — inside specific adapter methods where a Drizzle expression is awkward — but never as the foundation. Drizzle gives us typed parameterized queries by default, which directly satisfies the always-on rule that there is **no string concatenation in SQL**.

### TypeORM / Kysely / Knex

- **Knex** (what Strapi uses) is a query builder with weak type inference; it would not carry types to the Local API.
- **Kysely** is excellent and type-safe, but its schema is not as naturally constructable-from-data as Drizzle's, and `drizzle-kit`'s diff/introspect tooling gave us the migration story out of the box.
- **TypeORM**'s decorator/active-record model is fundamentally class-first and a poor fit for a runtime-generated schema.

## Open questions

- **MongoDB migrations.** SQL adapters get schema-diff migrations cleanly. For `@kernel/db-mongodb` we lean on application-level migrations plus document validators; whether the CLI should generate validator updates from config diffs is undecided.
- **Cross-adapter portability guarantees.** Content is portable between self-host and KernelCMS Cloud, but a Postgres→Mongo _physical_ migration needs a defined export/import path (logical documents, not table dumps). The format is being specified in [portability](../../10-cloud-operations/00-deployment-models-self-host-vs-cloud.md).
- **Read replicas and per-operation routing.** Whether the adapter exposes explicit read/write split, or we layer it above the contract, is still open.
- **`point` field indexing.** PostGIS vs. native `geography` vs. Mongo 2dsphere — the per-adapter strategy for geospatial queries needs a single agreed semantics for the shared `where` language.
