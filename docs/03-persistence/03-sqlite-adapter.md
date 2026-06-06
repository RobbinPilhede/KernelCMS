# SQLite Adapter

`@kernel/db-sqlite` is the embedded and edge-facing backend for KernelCMS. It targets two runtime shapes from one Drizzle-backed adapter: a local file (`better-sqlite3` / `node:sqlite` / `bun:sqlite`) for development and small self-hosted deployments, and libSQL — the open-source SQLite fork behind [Turso](https://turso.tech) — for replicated, edge-distributed production. Both speak the same `Adapter` contract as [`@kernel/db-postgres`](./02-postgres-adapter.md), so collections, globals, drafts, versions, and access control behave identically; only the connection and a handful of capability flags change.

## Why SQLite is a first-class backend

Payload treats SQLite as a supported-but-secondary database and Strapi's SQLite story is explicitly "development only, do not use in production." Sanity has no SQLite path at all — it is a hosted document store. KernelCMS takes the opposite position: SQLite, via libSQL, is a legitimate production target. The wedge is that the _same content config_ and the _same operation core_ run on an in-process file during `kernel dev` and on a globally replicated Turso database in production, with no code changes and no schema drift. You get Postgres-grade correctness for the relational pieces (foreign keys, transactions, generated columns) and SQLite's near-zero operational footprint.

```ts
// kernel.config.ts
import { defineConfig } from '@kernel/core'
import { sqliteAdapter } from '@kernel/db-sqlite'

export default defineConfig({
  db: sqliteAdapter({
    // Local file in dev, libSQL URL in production.
    url: process.env.DATABASE_URL ?? 'file:./.kernel/data.db',
    authToken: process.env.DATABASE_AUTH_TOKEN, // Turso/libSQL only
  }),
  collections: [Posts, Media, Users],
  globals: [SiteSettings],
})
```

The adapter inspects `url`: a `file:` scheme selects the embedded driver, while `libsql://` or `https://` selects the libSQL HTTP/WebSocket client. `kernel migrate` generates the same Drizzle migration set for both — the SQL dialect is identical because libSQL _is_ SQLite.

## libSQL and Turso

libSQL is a fork of SQLite that adds a network protocol (HTTP and WebSocket), server-side write replication, embedded read replicas, and an auth-token model. Turso is the managed multi-region platform built on it. KernelCMS targets the libSQL client (`@libsql/client`) directly, so you can point at Turso, a self-hosted `sqld`, or a plain file with one config surface.

```ts
db: sqliteAdapter({
  url: 'libsql://acme-prod.turso.io',
  authToken: process.env.TURSO_AUTH_TOKEN,

  // Embedded replica: a local SQLite file kept in sync with the primary.
  // Reads hit the local file (microseconds); writes forward to the primary.
  embeddedReplica: {
    path: './.kernel/replica.db',
    syncInterval: 60, // seconds; or call adapter.sync() manually
    readYourWrites: true,
  },
}),
```

### Embedded replicas

The embedded-replica mode is the feature that makes libSQL compelling for a CMS. The KernelCMS server holds a local SQLite file that libSQL keeps in sync with the Turso primary. Every read query — and collection list views in TanStack Table fire a lot of them — resolves against local disk. Writes are forwarded to the primary and, with `readYourWrites: true`, the local replica is brought forward before the write returns, so the admin never sees a stale document after saving.

```
 admin save (write)            list view (read)
        │                           │
        ▼                           ▼
  ┌───────────────┐          ┌───────────────┐
  │ KernelCMS     │  sync    │ embedded      │
  │ server        │◀────────▶│ replica .db   │  ← local reads (µs)
  └──────┬────────┘          └───────────────┘
         │ write forward
         ▼
  ┌───────────────┐
  │ Turso primary │  (multi-region, WAL-based replication)
  └───────────────┘
```

This sidesteps the classic single-writer objection to SQLite: the primary serializes writes, but reads scale out across every replica. Payload and Strapi on SQLite give you one file and one process — no replication story. KernelCMS gets read-local latency with a durable, replicated primary, exposed through `adapter.sync()` for explicit control in queue workers and cron jobs.

| Turso feature             | KernelCMS surface        | Notes                                                                                                           |
| ------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Multi-region primary      | `url`                    | Place the primary near your write traffic.                                                                      |
| Embedded read replica     | `embeddedReplica`        | Local-disk reads, periodic or manual `sync()`.                                                                  |
| Auth tokens (scoped)      | `authToken`              | Per-database, rotateable; never inline.                                                                         |
| Multi-DB / per-tenant     | `resolveDatabase()` hook | One libSQL database per tenant — see [Multi-tenancy](../10-cloud-operations/03-multi-tenancy-and-isolation.md). |
| Branching (point-in-time) | `kernel db branch`       | Fork a DB for preview/staging from the CLI.                                                                     |

### Per-tenant databases

Turso's cheap database creation makes database-per-tenant practical, which is awkward on Postgres and impossible on a shared SQLite file. KernelCMS exposes a `resolveDatabase` hook so the adapter can pick a libSQL URL from request context:

```ts
db: sqliteAdapter({
  resolveDatabase: ({ tenant }) => ({
    url: `libsql://${tenant.slug}-${process.env.TURSO_ORG}.turso.io`,
    authToken: tenant.dbToken, // scoped, stored encrypted
  }),
}),
```

Each tenant gets a fully isolated database — no row-level-security gymnastics, no noisy-neighbor query contention. This is a structural advantage over the single-database tenancy that Strapi and Payload assume.

## Local-first development

The default `kernel dev` experience uses `file:./.kernel/data.db`. There is no container to start, no connection string to provision, and the file is git-ignored. A new contributor clones the repo, runs `kernel dev`, and the adapter creates the file, applies migrations, and seeds in under a second.

```ts
// kernel.config.ts — typical local default
db: sqliteAdapter({
  url: 'file:./.kernel/data.db',
  // Pragmas applied on every connection.
  pragma: {
    journal_mode: 'WAL',   // concurrent readers during a write
    busy_timeout: 5000,    // wait, don't fail, on a brief write lock
    foreign_keys: 'ON',    // enforce relationship integrity
    synchronous: 'NORMAL', // good durability/throughput balance with WAL
  },
}),
```

WAL mode is non-negotiable for the admin: TanStack Query fires overlapping reads while a save is in flight, and WAL lets readers proceed without blocking on the writer. `busy_timeout` converts the occasional `SQLITE_BUSY` into a short wait instead of a thrown error.

For tests, point the adapter at an in-memory database so each suite gets an isolated, disposable instance:

```ts
import { sqliteAdapter } from '@kernel/db-sqlite'

export const testDb = sqliteAdapter({ url: 'file::memory:?cache=shared' })
// kernel test migrates + seeds this fresh per worker.
```

This is a real differentiator. Strapi recommends against SQLite in production _and_ makes local SQLite the path of least resistance, so teams routinely develop on SQLite and deploy on Postgres — two dialects, two sets of surprises. KernelCMS lets you keep one dialect from laptop to edge, and when you _do_ want Postgres in production, the [`Adapter` contract](./00-persistence-overview-and-adapter-contract.md) and migration generator absorb the swap. You opt into divergence; you don't trip into it.

### Migrations

Migrations are generated from schema diffs by `kernel generate` and written to `./migrations` as SQLite-dialect SQL. The adapter never auto-applies destructive changes; `kernel migrate` runs pending forward migrations inside a transaction.

```bash
kernel generate           # diff config → SQL migration
kernel migrate            # apply pending migrations (transactional)
kernel migrate --to 0007  # pin to a specific version
```

Because libSQL and file SQLite share the dialect, a migration generated against your local file applies byte-identically against Turso. There is no "works locally, breaks in prod" class of migration bug here.

## Limitations

SQLite is not Postgres, and the adapter is honest about the gaps rather than emulating them silently.

| Concern                  | SQLite reality                       | KernelCMS handling                                             |
| ------------------------ | ------------------------------------ | -------------------------------------------------------------- |
| Concurrent writes        | Single writer per database file      | WAL + `busy_timeout`; route heavy write throughput to Postgres |
| Column types             | Dynamic typing, no native `jsonb`    | `json` fields stored as `TEXT`, validated at the field layer   |
| `ALTER TABLE`            | No drop/alter column in old engines  | Drizzle table-rebuild strategy in generated migrations         |
| Full-text search         | `FTS5` extension, not always present | Prefer a search adapter (e.g. Typesense)                       |
| Decimal precision        | No exact `NUMERIC`                   | `number` fields are `REAL`; use integer cents for money        |
| Max DB size / write IOPS | Bounded by a single file/primary     | Scale reads via replicas; shard via per-tenant DBs             |

The hard limit to internalize: **one writer at a time per database.** For a content workflow — editors saving documents, occasional autosave — this is a non-issue; write contention in a CMS is low and bursty, and WAL plus `busy_timeout` smooths it. For write-heavy _application_ data (event ingestion, high-frequency counters), SQLite is the wrong tool and KernelCMS will tell you to put that workload on [`@kernel/db-postgres`](./02-postgres-adapter.md) or a queue adapter.

`json` fields deserve a specific note. Postgres gives you `jsonb` with indexable containment queries; SQLite stores JSON as `TEXT`. The shared query language still works — `where` on a JSON path compiles to `json_extract()` — but it can't use a GIN-style index, so deep JSON filtering on large collections is slower. If you query inside JSON heavily, model those fields relationally or move to Postgres.

The adapter exposes its capabilities so plugins and the admin can adapt instead of failing:

```ts
const caps = adapter.capabilities
// {
//   transactions: true,
//   jsonb: false,
//   fullTextSearch: 'fts5' | false,
//   concurrentWrites: false,
//   returningClause: true,
// }
```

## Edge usage

libSQL's HTTP protocol means a database connection is a `fetch`, which is exactly what edge runtimes (Cloudflare Workers, Vercel Edge, Deno Deploy) permit. The SQLite adapter runs in those runtimes where a TCP-socket Postgres driver cannot, so KernelCMS's REST, GraphQL, and RPC surfaces — hosted on TanStack Start server functions — can be deployed to the edge with content data one HTTP round trip away.

```ts
// kernel.config.ts for an edge deployment
db: sqliteAdapter({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
  // No embedded replica at the edge: the runtime is ephemeral and
  // has no durable local disk. Use the HTTP client directly and
  // pin reads to the nearest Turso region.
  protocol: 'http',
}),
```

```
        ┌─────────── Cloudflare / Vercel Edge ───────────┐
 request│  TanStack Start server fn → @kernel/db-sqlite  │
   ─────▶│            (libSQL HTTP client)                │
        └───────────────────────┬────────────────────────┘
                                 │ HTTPS (auth token)
                                 ▼
                    ┌────────────────────────┐
                    │  Turso, nearest region │
                    └────────────────────────┘
```

The trade-off at the edge is that you give up the embedded replica — there is no durable local disk in an ephemeral isolate — so every read is an HTTP hop to the nearest Turso region rather than a microsecond local read. For read-mostly delivery (the public REST/GraphQL API serving published content) this is fine, especially behind the KernelCMS Cloud CDN. For the admin panel, which is read-and-write heavy, run it on a long-lived Node or Bun process with an embedded replica and keep only the _delivery_ API at the edge. This split — admin on a stateful node, delivery at the edge, one libSQL primary behind both — is the recommended topology and something neither Strapi nor Payload offers out of the box.

Connection handling at the edge must be per-request: create the libSQL client inside the request scope, never as a module-level singleton that outlives an isolate. The adapter does this automatically when `protocol: 'http'` is set, so you don't hold connections across invocations.

## Open questions

- **Embedded replica sync triggers.** Should the adapter expose a write-hook that calls `sync()` immediately after mutating operations on _other_ replicas, or is interval-based sync plus `readYourWrites` sufficient? Leaning toward interval + manual `sync()` in queue workers, but cross-replica read-after-write consistency for a multi-node admin is unresolved.
- **Per-tenant DB provisioning.** Whether `kernel` should orchestrate Turso database creation/branching directly via the platform API, or treat database provisioning as out-of-band infrastructure that `resolveDatabase` merely consumes.
- **FTS5 availability detection.** How aggressively to probe for the `FTS5` extension at startup and whether to auto-fall-back to a search adapter versus failing loudly when a collection declares full-text search but the engine lacks it.
