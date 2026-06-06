# Transactions & Consistency

KernelCMS treats every write operation as a unit of work that either commits whole or not at all. A single `create`, `update`, or `delete` may fan out into relationship writes, version snapshots, localized field rows, upload metadata, and an arbitrary chain of user hooks — and all of it lives inside one transaction. This document specifies the transaction boundary model, how hooks participate in (and can poison) that transaction, what consistency you actually get when more than one adapter is involved, and how idempotency keys make retries safe. The design goal is blunt: the database never observes a half-written document, and your hooks never observe state that a later failure will roll back.

## Transaction boundaries

A KernelCMS operation is the boundary. When you call `payload`-style local API methods — here `kernel.create`, `kernel.update`, `kernel.delete`, or their bulk variants — the operation core opens a transaction on the active database adapter, runs the entire pipeline, and commits at the end. There is no "auto-commit per statement" mode in the default path.

```ts
// @kernel/core — operation lifecycle (simplified)
const result = await db.transaction(async (tx) => {
  await runHooks('beforeValidate', ctx, tx)
  await validate(ctx, tx)
  await runHooks('beforeChange', ctx, tx)

  const doc = await adapter.create({ collection, data, tx })
  await writeRelationships({ doc, tx })
  await writeLocalizedRows({ doc, tx })
  await snapshotVersion({ doc, tx })

  await runHooks('afterChange', ctx, tx) // still inside tx — see below
  return doc
})
// commit happens here; afterRead/afterOperation hooks run post-commit
```

The `tx` handle threads through every adapter call and every hook via `ctx.transaction`. For SQL adapters (`@kernel/db-postgres`, `@kernel/db-sqlite`, `@kernel/db-mysql`) this maps to a Drizzle transaction — Postgres and MySQL get real `BEGIN`/`COMMIT`, SQLite/libSQL get `BEGIN IMMEDIATE`. For `@kernel/db-mongodb` it maps to a multi-document transaction over a session, which requires a replica set or `mongos`; standalone Mongo silently degrades to no real isolation, and we surface that as a startup warning rather than a runtime surprise.

This is where KernelCMS diverges from the field. Payload only added transaction support relatively late and wires it through a `req.transactionID` that hooks must remember to forward; forget to pass `req` and your hook's writes escape the transaction. Strapi's default v4/v5 lifecycle does not wrap the whole operation in one transaction at all — its lifecycle subscribers commonly run against the connection pool, not the operation's transaction, so a failing `afterCreate` leaves the row behind. Sanity sidesteps the question with a different model entirely: its content lake exposes atomic **mutations** and optimistic-concurrency transactions keyed on document revision (`ifRevisionID`), but you do not get to run arbitrary server code inside that atomic unit. KernelCMS gives you Sanity-style atomicity *and* Payload-style server hooks in the same boundary.

### Nested operations and savepoints

Hooks frequently call back into the API — an `afterChange` on `posts` might `kernel.update` an `authors` aggregate. By default a nested operation **joins the ambient transaction** when `ctx.transaction` is present, so it commits or rolls back with the parent. You can opt a nested call out for genuinely independent side effects:

```ts
await kernel.update({
  collection: 'authors',
  id: authorId,
  data: { postCount },
  // join the parent tx (default), or detach for an independent unit:
  transaction: ctx.transaction, // explicit join
})
```

On SQL adapters, nested joins use **savepoints** so a recoverable sub-failure (e.g. a caught unique-constraint retry) does not abort the whole outer transaction. MongoDB has no savepoints, so a nested failure there aborts the entire session — a real consistency difference we document per adapter rather than paper over.

### Read consistency and depth

Reads default to **read-committed** outside a transaction. Inside an operation, populated relationships (`depth > 0`) are resolved against `tx`, so a document and the related rows it just wrote are mutually consistent. See Query Language: depth & population for how `depth` interacts with this.

| Surface | Boundary | Isolation (Postgres default) |
| --- | --- | --- |
| Local API single op | per operation | read-committed + savepoints |
| Bulk op (`updateMany`) | one tx for the batch | read-committed |
| REST / GraphQL request | one op = one tx | inherits adapter default |
| RPC server function | one op = one tx | inherits adapter default |

## Hooks running inside transactions

Hooks are not bystanders — they are participants. `beforeValidate`, `beforeChange`, and `afterChange` run **inside** the transaction; `afterRead` and `afterOperation` run **after commit**. The rule that makes this safe: any database work a hook performs must use `ctx.transaction`, and `@kernel/core` injects it for you on every nested `@kernel/*` call.

```ts
// kernel.config.ts
import { defineCollection } from '@kernel/core'

export const Orders = defineCollection({
  slug: 'orders',
  hooks: {
    afterChange: [
      async ({ doc, ctx }) => {
        // Runs inside the tx. If this throws, the order write rolls back.
        await ctx.adapters.db.update({
          collection: 'inventory',
          where: { sku: { equals: doc.sku } },
          data: { reserved: { increment: doc.qty } },
          tx: ctx.transaction,
        })
      },
    ],
  },
})
```

A hook that throws aborts the transaction. That is the feature, not a bug: if reserving inventory fails, the order should not exist. This is the opposite of Strapi's common footgun where a thrown lifecycle hook leaves the primary write committed.

### Side effects that must not roll back

The hard cases are **non-transactional side effects**: sending email via `@kernel/auth`/notification adapters, enqueuing a job, calling a payment provider, invalidating a CDN cache. These do not belong inside the transaction — you cannot roll back an email. KernelCMS provides a deferred effect queue that fires **only on successful commit**:

```ts
afterChange: [
  ({ doc, ctx }) => {
    // Deferred: runs once, after COMMIT. Skipped entirely on rollback.
    ctx.afterCommit(async () => {
      await ctx.adapters.queue.enqueue('order.placed', { id: doc.id })
      await ctx.adapters.email.send(receiptFor(doc))
    })
  },
]
```

```
 BEGIN ──► beforeChange ──► write ──► afterChange ──► COMMIT
                                          │              │
                                  register afterCommit   └─► drain afterCommit queue
                                                              (email, queue, CDN purge)
       any throw before COMMIT ──► ROLLBACK ──► afterCommit queue discarded
```

| Hook | Runs in tx | On rollback | Use for |
| --- | --- | --- | --- |
| `beforeValidate` | yes | discarded | normalize input |
| `beforeChange` | yes | discarded | derive fields, deny writes |
| `afterChange` (sync work) | yes | rolled back | dependent DB writes |
| `afterChange` → `ctx.afterCommit` | no | skipped | email, queue, webhooks |
| `afterRead` | no (post-commit) | n/a | shape output |
| `afterOperation` | no (post-commit) | n/a | metrics, audit logs |

### Timeouts and long hooks

A hook holding a transaction open holds locks. We enforce a configurable `transactionTimeout` (default 15s); exceeding it aborts the transaction with `TransactionTimeoutError`. Network calls inside `beforeChange`/`afterChange` are a smell — push them to `afterCommit`. The admin surfaces a dev-mode warning when a hook inside the boundary performs an outbound fetch.

## Cross-adapter consistency

Here is the honest part. KernelCMS has many adapters — database, storage, search, cache, email, queue — and **only the database adapter is transactional**. You cannot two-phase-commit an S3 upload and a Postgres row. We do not pretend otherwise, and we do not ship a distributed-transaction abstraction that lies about the guarantee.

The model is **transactional outbox + idempotent consumers**, the same pattern mature systems use:

```
┌──────────── DB transaction ────────────┐
│  upsert document                        │
│  upsert upload metadata row             │      afterCommit
│  INSERT INTO _kernel_outbox (event)     │ ────────────────►  worker drains outbox
└─────────────────────────────────────────┘                    ├─ storage.put(file)
        commit is the single source of truth                    ├─ search.index(doc)
                                                                 └─ cache.invalidate(key)
```

The database commit is the only thing that is atomic. Everything else — pushing bytes to `@kernel/storage`, indexing into the search adapter, invalidating cache — is recorded as an outbox event in the same transaction and processed after commit with retry. This gives **eventual consistency** for non-DB adapters with a clear, durable record of intent.

For uploads specifically, the order is deliberate: write the file to staging storage **before** the transaction (so the DB never references a missing blob), commit the metadata row, then promote/finalize the blob in `afterCommit`. Orphaned staging blobs are reaped by a sweeper. This beats Strapi's upload flow, where a failed entry write can leave a stored file with no row, and contrasts with Sanity, where assets and documents live in one managed content lake so the question doesn't arise — a real advantage of Sanity's hosted model that self-hosted KernelCMS answers with the outbox instead.

```ts
// kernel.config.ts — consistency posture is explicit
export default defineConfig({
  consistency: {
    transactionTimeout: 15_000,
    outbox: { enabled: true, maxRetries: 8, backoff: 'exponential' },
    search: { mode: 'eventual' }, // 'eventual' | 'sync-best-effort'
  },
})
```

## Idempotency

Retries are inevitable: a client times out, a queue redelivers, a webhook fires twice. Every mutating surface in KernelCMS accepts an **idempotency key**, and the operation core deduplicates on it within a configurable window.

```ts
await kernel.create({
  collection: 'orders',
  data,
  idempotencyKey: req.headers['idempotency-key'], // REST/GraphQL/RPC all honor this
})
```

The key, the operation signature, and a hash of the response are stored in `_kernel_idempotency` **inside the same transaction** as the write. A replayed request with a matching key returns the stored response without re-executing hooks — so `afterCommit` emails fire exactly once, not once per retry.

Outbox consumers are idempotent by construction: each event carries a stable `eventId`, and adapters use upsert-by-id semantics (`search.index` is a put, `cache.invalidate` is naturally idempotent, `storage.put` keys on content hash). This is stronger than Payload, which leaves idempotency to the caller, and aligns with Sanity's revision-based optimistic concurrency without requiring clients to track revisions for the common case.

| Concern | Mechanism | Guarantee |
| --- | --- | --- |
| Duplicate API request | `idempotencyKey` + `_kernel_idempotency` | exactly-once effect within window |
| Concurrent edit | optimistic `version` check on `update` | rejects stale writes (409) |
| Outbox redelivery | `eventId` + upsert consumers | at-least-once delivery, idempotent apply |

For concurrent edits, optimistic concurrency is the default: `update` accepts an expected `version` and rejects a stale write with a `ConflictError` rather than silently clobbering — see [Versions & Drafts](../02-data-modeling/10-versioning-drafts-and-autosave.md).

## Open questions

- **Cross-adapter sagas.** Should we ship a first-class compensating-action API for multi-step external workflows, or keep that strictly in userland on top of the queue adapter?
- **Idempotency window storage.** Default TTL and whether the dedup table should be pruneable via the cache adapter instead of the DB for high-throughput tenants.
- **MongoDB savepoint gap.** Whether to emulate savepoint-style nested rollback on Mongo via explicit document snapshots, or simply document the difference and refuse nested partial rollback there.
- **Read-your-writes across replicas.** On read-replica deployments, guaranteeing that a post-commit `afterCommit` read hits the primary — sticky routing vs. forced primary reads.
