# Migrations Engine

KernelCMS treats your `kernel.config.ts` as the single source of truth for schema. The migrations engine reconciles that declared shape against what is physically in the database: it diffs the desired schema against the current one, emits a deterministic, reviewable migration file, and applies it transactionally with a recorded history. This document covers the full lifecycle — generation from diff, apply, rollback, and the production strategy that keeps zero-downtime deploys honest.

## Why an engine, not magic sync

Sanity hides storage entirely; you never write a migration because there is no relational schema to migrate — the trade is that you don't own the database. Strapi auto-syncs its schema on boot in development, which is convenient until it silently drops a column in production. Payload generates Drizzle migrations from its config and is the closest peer to what KernelCMS does here. KernelCMS follows Payload's instinct — checked-in, reviewable SQL — but unifies it across SQL and MongoDB behind one `Adapter` migration contract, and refuses to ever mutate a production schema implicitly.

The non-negotiable rules:

- **No implicit schema changes in production.** `dev` auto-applies (opt-in); `production` only applies committed migration files.
- **Migrations are code.** They live in your repo, get code-reviewed, and run in CI.
- **Every migration is reversible** or explicitly marked irreversible with a documented reason.

## The migration lifecycle

A migration moves through five states. The engine records every transition in a `_kernel_migrations` ledger table (or a `_kernel_migrations` collection on MongoDB).

```
  config change          kernel generate         git commit + CI         kernel migrate
       │                       │                       │                       │
       ▼                       ▼                       ▼                       ▼
 ┌──────────┐  diff   ┌──────────────┐  review ┌────────────┐  apply  ┌──────────────┐
 │ DESIRED  │────────▶│  GENERATED   │────────▶│  COMMITTED │────────▶│   APPLIED    │
 │ (config) │         │ (.ts on disk)│         │ (in repo)  │         │ (in ledger)  │
 └──────────┘         └──────────────┘         └────────────┘         └──────────────┘
                                                                            │
                                                                rollback    ▼
                                                                      ┌──────────────┐
                                                                      │  REVERTED    │
                                                                      └──────────────┘
```

The ledger is the system of record, not the filesystem. A migration file on disk that is not in the ledger is *pending*; a ledger row whose file is missing is a *drift error* the CLI refuses to proceed past.

```ts
// shape of a ledger row — @kernel/db
interface MigrationRecord {
  name: string;          // 20260530120000_add_author_bio
  batch: number;         // monotonic; one deploy = one batch
  checksum: string;      // sha256 of the up() body at apply time
  appliedAt: Date;
  durationMs: number;
  by: string | null;     // CI run id or operator
}
```

The `checksum` is what catches the classic footgun: someone edits an already-applied migration file. On the next `kernel migrate status`, the engine compares the stored checksum against the on-disk body and hard-fails if they diverge.

## Generation from schema diff

Collections and globals compile to a canonical, adapter-agnostic intermediate representation (IR) — tables, columns, indexes, FKs, enums, and the join tables that back `relationship`, `array`, and `blocks` fields. The engine snapshots the IR into `kernel/schema-snapshot.json` after each migration. `kernel generate` diffs the freshly compiled IR against that snapshot.

```ts
// kernel.config.ts
import { defineConfig, collection } from '@kernel/core';
import { postgres } from '@kernel/db-postgres';

export default defineConfig({
  db: postgres({ url: process.env.DATABASE_URL }),
  collections: [
    collection('posts', {
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'slug', type: 'text', unique: true, index: true },
        { name: 'authorBio', type: 'textarea' }, // ← newly added field
        { name: 'author', type: 'relationship', to: 'users' },
      ],
    }),
  ],
});
```

Adding `authorBio` and running the generator:

```bash
kernel generate --name add_author_bio
```

produces a typed, hand-editable migration. The engine writes Drizzle DDL for SQL adapters and collection operations for MongoDB — same file interface, different body.

```ts
// kernel/migrations/20260530120000_add_author_bio.ts
import type { Migration } from '@kernel/db';
import { sql } from '@kernel/db-postgres';

export const migration: Migration = {
  async up({ db }) {
    await db.execute(sql`
      ALTER TABLE "posts" ADD COLUMN "author_bio" text;
    `);
  },
  async down({ db }) {
    await db.execute(sql`
      ALTER TABLE "posts" DROP COLUMN "author_bio";
    `);
  },
};
```

### How the diff classifies changes

The diff engine sorts every operation by risk so reviewers see what matters first.

| Change | Class | Auto-generated `down`? | Notes |
|---|---|---|---|
| Add nullable column | safe | yes | No table rewrite |
| Add column with default | safe | yes | Backfill strategy chosen per adapter |
| Add index | safe* | yes | Emitted `CONCURRENTLY` on Postgres |
| Rename field | ambiguous | yes | Diff cannot tell rename from drop+add |
| Drop column | destructive | no (data loss) | Requires `--allow-destructive` |
| Narrow type (text→varchar(80)) | destructive | partial | May truncate; guarded |
| Change `required` false→true | destructive | yes | Fails if existing nulls |

The ambiguous case — renames — is where pure diffing breaks down, exactly as it does in Payload. A diff sees `oldName` gone and `newName` present and assumes drop + add, which destroys data. KernelCMS resolves this with stable field IDs: each field carries an internal `id` independent of its `name`, so the IR can detect that field `f_8c1a` merely changed its column name and emit a `RENAME COLUMN` instead of drop/add. When the engine can't be sure, it stops and asks rather than guessing.

```bash
kernel generate --name rename_bio
# ⚠  Detected possible rename on posts: "authorBio" → "bio"
#    [r] rename (preserve data)   [d] drop + add (DESTROYS data)   [a] abort
```

## Apply and rollback

`kernel migrate` applies every pending migration in filename-timestamp order, each wrapped in its own transaction where the adapter supports transactional DDL (Postgres and SQLite do; MySQL's DDL is largely non-transactional, and MongoDB has no DDL transactions across collections — both are flagged in `migrate status`).

```bash
kernel migrate                 # apply all pending, one batch
kernel migrate --to 20260530   # apply up to a target
kernel migrate status          # show pending / applied / drifted
kernel migrate rollback        # revert the last batch
kernel migrate rollback --steps 3
```

The apply loop is conservative by design:

```
for each pending migration (sorted):
  ├─ BEGIN (if adapter supports transactional DDL)
  ├─ run up({ db, logger })
  ├─ INSERT ledger row (name, batch, checksum, durationMs)
  ├─ COMMIT
  └─ on error → ROLLBACK, halt, surface SQL + offending file
```

Rollback walks the most recent batch in reverse and runs each `down()`. Because a batch maps to one deploy, `rollback` cleanly reverts a single release. Migrations whose `down` is `null` (destructive drops) cannot be auto-reverted — the CLI says so loudly and points you at a restore-from-backup runbook rather than pretending.

A subtle but important guarantee: **migrations never call into the operation core.** They talk to the adapter's `db` handle directly. If a migration needed `payload.find()`-style access (as data backfills sometimes do in Payload), a future hook version of your config could break a historical migration. KernelCMS migrations are frozen against the raw schema, so a migration written today still runs identically two years and forty config changes later.

### Data migrations

Schema and data are separate concerns. The same file can carry a data step, but it runs as raw SQL/driver operations, never through `@kernel/rpc` or collection hooks:

```ts
export const migration: Migration = {
  async up({ db }) {
    await db.execute(sql`ALTER TABLE "posts" ADD COLUMN "reading_time" integer;`);
    await db.execute(sql`
      UPDATE "posts"
      SET "reading_time" = GREATEST(1, ceil(length("body") / 1000.0));
    `);
  },
  async down({ db }) {
    await db.execute(sql`ALTER TABLE "posts" DROP COLUMN "reading_time";`);
  },
};
```

For backfills over millions of rows, batch inside `up()` and keep each transaction small — a single `UPDATE` over a huge table will hold locks and block writes.

## Production migration strategy

The hard rule: **migrations run as a discrete deploy step, before new application code serves traffic, and they must be backward-compatible with the currently running version.** This is the expand/contract pattern, and it is the only safe path to zero downtime.

```
 v1 running          v1 + v2 running          v2 running
     │                     │                       │
     ▼                     ▼                       ▼
 ┌────────┐  EXPAND   ┌─────────┐   deploy v2  ┌─────────┐  CONTRACT  ┌────────┐
 │ schema │──────────▶│ schema  │─────────────▶│ schema  │───────────▶│ schema │
 │   A    │ add col   │  A + B  │  cut traffic │  A + B  │ drop old   │   B    │
 └────────┘ (nullable)└─────────┘              └─────────┘            └────────┘
```

A column rename in production is therefore *three* deploys, never one:

1. **Expand** — add `new_col`, dual-write from app code (both columns populated). Old code ignores it; new code prefers it. Backward-compatible.
2. **Backfill** — copy `old_col → new_col` for historical rows, in batches, off the hot path.
3. **Contract** — once no running version reads `old_col`, drop it.

`kernel migrate --check` runs in CI and fails the build on any migration the policy flags as unsafe-for-online without an explicit `// @kernel-online-safe: reason` annotation. Destructive operations in a migration targeting `production` require `--allow-destructive` *and* a maintenance-window flag.

```ts
// kernel.config.ts — migration policy
export default defineConfig({
  // ...
  migrations: {
    dir: './kernel/migrations',
    auto: process.env.NODE_ENV === 'development', // dev only
    transactional: true,
    onDrift: 'fail',          // 'fail' | 'warn'
    lockTimeoutMs: 15_000,    // bound how long DDL waits on locks
    advisoryLockKey: 'kernel:migrate',
  },
});
```

### Concurrency and the deploy lock

Two app instances booting at once must not both run migrations. The engine takes a database advisory lock (`pg_advisory_lock` on Postgres, a lock document on MongoDB) before reading the ledger. The loser waits, re-reads, and finds nothing pending. This makes `kernel migrate` safe to run as a Kubernetes init container or a one-shot job across a rolling deploy.

| Surface | When migrations run | Mechanism |
|---|---|---|
| Docker / Compose | entrypoint, pre-boot | `kernel migrate` then `kernel start` |
| Kubernetes | init container or Job | advisory lock guards concurrency |
| KernelCMS Cloud | managed deploy pipeline | gated step with auto-snapshot before apply |

KernelCMS Cloud takes a backup snapshot immediately before any `production` apply, so the destructive-without-`down` case still has a clean restore point. See [Deployment](../10-cloud-operations/00-deployment-models-self-host-vs-cloud.md) and the adapter contract in [The Adapter Contract](./00-persistence-overview-and-adapter-contract.md) for how each backend implements the migration interface.

## Open questions

- **Squashing.** Long-lived projects accumulate hundreds of migrations that slow fresh-DB setup. Do we ship a `kernel migrate squash` that collapses applied history into a single baseline, and how do we keep that safe for environments mid-upgrade?
- **MongoDB "migrations."** Document stores have no DDL. We currently scope Mongo migrations to index management and data reshaping — is a versioned migration ledger the right model there, or should it be a separate, lighter mechanism?
- **Cross-adapter portability.** A migration authored against Postgres `sql` won't run on MySQL verbatim. Do we keep migrations adapter-specific (current plan) or invest in an adapter-neutral DDL builder that sacrifices escape-hatch raw SQL?
- **Online schema change tooling.** Should the engine optionally shell out to `pg-osc` / `gh-ost`-style tools for table rewrites on very large tables, or stay pure and document the manual path?
