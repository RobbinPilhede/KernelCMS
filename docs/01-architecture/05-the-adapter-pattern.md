# The Adapter Pattern

The adapter pattern is the single extensibility primitive that makes KernelCMS's "choose everything" promise real. Every infrastructure concern that a CMS normally hard-wires — the database, file storage, transactional email, authentication, search, cache, and the job queue — is expressed in KernelCMS as a narrow, versioned contract. A concrete implementation of that contract is an adapter. The core ships zero opinions about *which* implementation you use; it only knows the contract. This document specifies the contract shape, how adapters are registered and resolved at boot, the first-party adapters we ship, the rules for community adapters, and the philosophy that ties it together.

## Why adapters, not plugins-of-everything

Payload bakes Mongoose/Drizzle access into its operation layer and treats storage as an adapter but auth as a built-in. Strapi hard-wires its Knex-based database layer and its own users-permissions plugin; swapping the database means swapping a Strapi-blessed connector, and swapping auth means fighting the framework. Sanity sidesteps the problem by hosting the datastore itself — you do not choose your database, because there is only one, theirs.

KernelCMS takes the opposite stance: **there is no privileged infrastructure**. The operation core (`@kernel/core`) is written against contracts in `@kernel/db`, `@kernel/storage`, `@kernel/auth`, and the rest. It never imports a driver. This is what lets the same content config run on Postgres in production, SQLite in CI, and MongoDB on a teammate's laptop with a one-line change — and what lets you replace S3 with R2, or Resend with SES, without touching a collection definition.

```
            ┌──────────────────────────────────────────┐
            │              @kernel/core                 │
            │   operations · access · validation · API  │
            └───────────────────┬──────────────────────┘
                                │  (contracts only)
   ┌──────────┬──────────┬──────┴─────┬──────────┬──────────┬──────────┐
   ▼          ▼          ▼            ▼          ▼          ▼          ▼
 db        storage     auth        email      search      cache      queue
 adapter   adapter     adapter     adapter    adapter     adapter    adapter
   │          │          │            │          │          │          │
 Postgres   S3         Better-Auth  Resend     Typesense  Redis      BullMQ
 SQLite     R2         OIDC         SES        Meilisearch Memory    SQS
 MongoDB    GCS        ...          SMTP       Postgres FTS ...       ...
```

## The adapter contract

An adapter contract is a TypeScript `interface` plus a factory signature. The contract is the law; the factory is the constructor. Every contract extends a shared `Adapter` base so the registry can treat them uniformly for lifecycle and health.

```ts
// @kernel/core/adapter
export interface Adapter {
  /** Stable identifier, e.g. "db", "storage". Set by the contract, not the impl. */
  readonly kind: AdapterKind;
  /** Implementation name for logs and the admin "About" panel, e.g. "postgres". */
  readonly name: string;
  /** Contract version this adapter implements. Checked at resolution. */
  readonly contractVersion: `${number}.${number}`;
  /** Called once during boot, after config is frozen. */
  init(ctx: AdapterContext): Promise<void>;
  /** Liveness probe for /health and the admin status page. */
  health(): Promise<HealthStatus>;
  /** Graceful shutdown: drain pools, flush buffers, close sockets. */
  destroy(): Promise<void>;
}

export type AdapterKind =
  | "db" | "storage" | "auth" | "email" | "search" | "cache" | "queue";
```

A concrete contract narrows `kind` and adds the operations the core depends on. The database contract is the largest, because it carries the entire persistence surface:

```ts
// @kernel/db
export interface DatabaseAdapter extends Adapter {
  readonly kind: "db";
  /** Translate a parsed query (where/sort/pagination/depth) into a result set. */
  find<T>(args: FindArgs): Promise<PaginatedResult<T>>;
  findByID<T>(args: FindByIDArgs): Promise<T | null>;
  create<T>(args: CreateArgs): Promise<T>;
  update<T>(args: UpdateArgs): Promise<T>;
  delete<T>(args: DeleteArgs): Promise<T>;
  /** Run fn inside a transaction; nested calls join the ambient tx. */
  transaction<R>(fn: (tx: TransactionScope) => Promise<R>): Promise<R>;
  /** Diff config schema against the live schema; emit a migration plan. */
  buildMigration(schema: KernelSchema): Promise<MigrationPlan>;
  /** Capabilities the core branches on (see below). */
  readonly capabilities: DatabaseCapabilities;
}
```

### Capabilities, not feature-flags

Not every backend can do everything. Postgres has native JSON containment operators and real transactions; SQLite's transaction model differs; MongoDB has no joins. Rather than the core probing for driver quirks, each adapter declares a `capabilities` object and the core branches on it. This keeps backend-specific logic out of `@kernel/core` and inside the adapter where it belongs.

```ts
export interface DatabaseCapabilities {
  transactions: boolean;
  joins: "native" | "application";   // SQL joins vs. depth-resolution in core
  jsonQuery: boolean;                 // can it filter inside JSON columns?
  fullTextSearch: boolean;           // used by the Postgres FTS search adapter
  returning: boolean;                // RETURNING clause support
}
```

| Contract | Package | Core methods | Notable capability flags |
|---|---|---|---|
| `DatabaseAdapter` | `@kernel/db` | find / create / update / delete / transaction / buildMigration | transactions, joins, jsonQuery |
| `StorageAdapter` | `@kernel/storage` | put / get / delete / getSignedURL / stat | signedUploads, rangeRequests |
| `AuthAdapter` | `@kernel/auth` | verify / issueSession / revoke / strategies | mfa, oauthProviders |
| `EmailAdapter` | `@kernel/email` | send / sendBatch | templates, scheduling |
| `SearchAdapter` | `@kernel/search` | index / query / removeFromIndex | facets, typoTolerance |
| `CacheAdapter` | `@kernel/cache` | get / set / delete / wrap | ttl, tagInvalidation |
| `QueueAdapter` | `@kernel/queue` | enqueue / process / schedule | delayedJobs, retries |

### Versioning the contract

`contractVersion` is checked at resolution against the version the running `@kernel/core` expects. A patch mismatch is allowed; a minor or major mismatch fails boot with an actionable error rather than a runtime `undefined is not a function` three weeks later. Contracts follow a deprecate-then-remove cycle: a method is marked `@deprecated` for one minor, replaced, and only removed at the next major. This is the same discipline `@kernel/plugin-sdk` enforces for plugins.

## The adapter registry and resolution

Adapters are not imported by the core. They are *provided* in `kernel.config.ts` and resolved by a registry at boot. The config takes adapter *factories* — not instances — so the registry controls construction order, injects the shared `AdapterContext` (logger, config, secrets, the resolved sibling adapters), and owns the lifecycle.

```ts
// kernel.config.ts
import { defineConfig } from "@kernel/core";
import { postgres } from "@kernel/db-postgres";
import { s3 } from "@kernel/storage";
import { betterAuth } from "@kernel/auth";
import { resend } from "@kernel/email";
import { redis } from "@kernel/cache";

export default defineConfig({
  adapters: {
    db: postgres({ url: process.env.DATABASE_URL! }),
    storage: s3({ bucket: "media", region: "eu-west-1" }),
    auth: betterAuth({ providers: ["github", "credentials"] }),
    email: resend({ apiKey: process.env.RESEND_KEY! }),
    cache: redis({ url: process.env.REDIS_URL! }),
    // search and queue omitted -> sensible defaults selected
  },
  collections: [Posts, Media, Users],
  globals: [SiteSettings],
});
```

Resolution proceeds in a deterministic order so dependencies are always available when an adapter's `init` runs:

```
config frozen
   │
   ▼
topological sort of adapters by declared deps
   │   (cache may depend on db; search may depend on db; queue standalone)
   ▼
for each adapter, in order:
   construct(factory)  →  contractVersion check  →  init(ctx)  →  health()
   │
   ▼
if any health() != "ok" and adapter is required → abort boot with diagnostics
   │
   ▼
registry frozen; exposed to core as ctx.adapters
```

The registry is exposed to the core and to plugins as a typed accessor. There is no service locator string-keyed magic — `ctx.adapters.db` is fully typed as `DatabaseAdapter`, and TanStack Start server functions and the Local API both read through the same frozen registry, so an in-process call and an RPC call hit identical adapter instances.

```ts
// inside an operation in @kernel/core
const result = await ctx.adapters.db.find<Post>({
  collection: "posts",
  where: { status: { equals: "published" } },
  sort: ["-publishedAt"],
  limit: 20,
  depth: 1,
});
```

### Defaults and zero-config

If you omit an adapter, the registry selects a default appropriate to the runtime: an in-memory cache, an in-memory queue, and a database-backed search using the active `DatabaseAdapter`'s `fullTextSearch` capability when present. `create-kernel` scaffolds SQLite + local-disk storage so `kernel dev` runs with no external services. Production configs override these explicitly. This mirrors Payload's "works out of the box" feel without Payload's coupling — the defaults are themselves adapters, swappable like any other.

## First-party adapters

These are maintained in the monorepo, versioned in lockstep with `@kernel/core`, and covered by the shared adapter conformance suite (see Testing Adapters).

| Concern | Package(s) | Implementations |
|---|---|---|
| Database (SQL) | `@kernel/db-postgres`, `@kernel/db-sqlite`, `@kernel/db-mysql` | Drizzle on Postgres (default), SQLite/libSQL, MySQL |
| Database (document) | `@kernel/db-mongodb` | MongoDB native driver |
| Storage | `@kernel/storage` | Local disk, S3, Cloudflare R2, Google Cloud Storage |
| Auth | `@kernel/auth` | Credentials, OIDC, OAuth (GitHub/Google), API keys |
| Email | `@kernel/email` | Resend, AWS SES, SMTP, console (dev) |
| Search | `@kernel/search` | Postgres FTS, Typesense, Meilisearch |
| Cache | `@kernel/cache` | Memory, Redis |
| Queue | `@kernel/queue` | Memory, Redis/BullMQ, SQS |

The three SQL database adapters share a Drizzle-based core (schema generation, migration diffing) and differ only where the dialects diverge — `RETURNING`, JSON operators, upsert syntax. The MongoDB adapter implements the same `DatabaseAdapter` contract but sets `joins: "application"`, which tells `@kernel/core` to resolve relationship `depth` in-process rather than emitting SQL joins. The content config does not change; only the adapter does.

## Community adapters

The contract is public and stable, so anyone can publish an adapter to npm. There is no plugin marketplace gatekeeping and no need to fork the core — exactly the gap that bites Strapi users when a needed database connector is not on Strapi's approved list. A community adapter is an ordinary package that:

1. Exports a factory returning an object implementing the relevant contract.
2. Declares a peer dependency on the contract package (e.g. `@kernel/storage`) with a version range.
3. Passes the published conformance suite for its kind.

```ts
// kernel.config.ts using a community adapter
import { backblaze } from "kernel-storage-backblaze"; // third-party

export default defineConfig({
  adapters: {
    db: postgres({ url: process.env.DATABASE_URL! }),
    storage: backblaze({ keyId: "...", appKey: "..." }),
  },
  // ...
});
```

We publish `@kernel/adapter-conformance`, a runnable test kit per contract. An adapter that passes it behaves identically to a first-party one from the core's perspective — same query semantics, same transaction guarantees, same error shapes. Adapters that pass and opt in are listed in a community registry, but listing is discovery, not a runtime dependency. The `kernel doctor` command runs the conformance suite against your configured adapters and warns on capability gaps (e.g. a search adapter without `facets` when a collection's admin config requests faceted filtering).

## The choose-everything philosophy

Three rules keep the pattern honest:

- **The core depends on contracts, never implementations.** If you can `grep @kernel/core` and find an `import` of a driver, that is a bug. Drivers live behind contracts; the core is testable against in-memory fakes.
- **Capabilities are explicit and inspected.** The core never feature-detects a driver at runtime. An adapter declares what it can do; the core adapts its behavior and surfaces gaps at boot, not in production.
- **Portability is a guarantee, not a hope.** Because every backend implements one contract and content is config-as-code, migrating Postgres → MongoDB or S3 → R2 is a config edit plus a data move, not a rewrite. This is the concrete mechanism behind "no lock-in" and the portability promise between self-host and KernelCMS Cloud — Cloud is just a curated set of first-party adapters with managed operations.

Where Sanity asks you to accept its datastore and Strapi/Payload ask you to accept their persistence layer, KernelCMS asks only that your infrastructure speak a contract. Everything downstream of that contract is yours to choose. See [Configuration](./06-configuration-system.md) for the full `kernel.config.ts` reference and Operation Lifecycle for how operations thread through the resolved registry.

## Open questions

- **Hot-swapping adapters at runtime.** The registry is frozen at boot. Should KernelCMS Cloud support draining and re-resolving a single adapter (e.g. rotating a cache backend) without a full restart, or is restart-on-change acceptable?
- **Per-collection storage adapters.** Today storage is global. A media-heavy collection might want R2 while another wants local disk. Do we widen the contract to a keyed map, or keep this a routing concern inside a single storage adapter?
- **Capability negotiation for search.** When a collection requests faceting but the active search adapter lacks `facets`, do we fail boot, silently degrade, or fall back to the database adapter for that collection? Current lean is fail-fast in `kernel doctor`, degrade-with-warning at runtime.
