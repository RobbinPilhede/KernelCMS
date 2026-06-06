# Backups & Disaster Recovery

KernelCMS treats backups as a first-class part of the persistence layer, not an afterthought bolted onto whatever database you happen to run. Because every backend implements one `Adapter` contract, the backup, point-in-time recovery, and restore-drill machinery is uniform whether you run `@kernel/db-postgres`, `@kernel/db-sqlite`, `@kernel/db-mysql`, or `@kernel/db-mongodb`. This document specifies the backup strategy, point-in-time recovery (PITR), the restore-drill discipline that keeps recovery honest, and the RPO/RTO targets you should commit to — for both self-hosted deployments and KernelCMS Cloud.

The core principle: a backup you have never restored is a hypothesis, not a guarantee. Everything here is built to turn that hypothesis into a measured, repeatable fact.

## What "data" means in KernelCMS

Disaster recovery for a CMS spans more than a single SQL dump. KernelCMS has four distinct durable artifacts, and a recovery plan must account for all of them or you restore a hollow site:

| Artifact | Where it lives | Adapter | Backup mechanism |
| --- | --- | --- | --- |
| Content (collections, globals, versions, drafts) | Primary database | `@kernel/db-*` | Logical + physical snapshots, WAL/binlog |
| Media binaries | Object store | `@kernel/storage` | Versioned bucket + cross-region replication |
| Config-as-code | `kernel.config.ts` in git | — | Source control, tagged per deploy |
| Search index | Search adapter | `@kernel/server` search adapter | Rebuilt from content (derived, not backed up) |

Config-as-code is the structural backbone. Because the schema, access rules, and field definitions live in `kernel.config.ts` under version control, a content restore is always paired with a known config revision. This is a real advantage over Sanity, where the schema lives in your studio repo but content shape drift is reconciled at the dataset level, and over Strapi, where content types and the data that conforms to them can diverge across environments unless you carefully manage migrations. KernelCMS pins them together: every backup records the config commit SHA that produced the schema, so a restore never lands content into an incompatible table layout. Search is deliberately *derived* — never restore it, rebuild it. See Search adapters.

## Backup strategy

KernelCMS uses a tiered strategy: frequent incremental capture, periodic full snapshots, and continuous write-ahead log archival for the SQL adapters. You configure it declaratively in `kernel.config.ts`, and the server enforces it through the active database adapter.

```ts
// kernel.config.ts
import { defineConfig } from '@kernel/core'
import { postgres } from '@kernel/db-postgres'
import { s3Storage } from '@kernel/storage'

export default defineConfig({
  db: postgres({
    url: process.env.DATABASE_URL,
    backups: {
      // Continuous WAL archival → PITR window
      walArchive: {
        destination: 's3://kernel-backups/wal',
        retention: '14d',
      },
      // Periodic base snapshots
      snapshots: {
        full: { schedule: '0 2 * * 0', retention: '90d' },   // weekly, Sun 02:00
        incremental: { schedule: '0 2 * * 1-6', retention: '14d' },
      },
      // Encrypt at rest before leaving the host
      encryption: { kms: process.env.BACKUP_KMS_KEY },
      // Verify every snapshot is restorable, not just present
      verify: 'restore-check',
    },
  }),
  storage: s3Storage({
    bucket: process.env.MEDIA_BUCKET,
    versioning: true,
    replication: { region: 'eu-west-1' },
  }),
})
```

Three rules are enforced by default and we recommend you never relax them:

- **3-2-1.** Three copies, two media classes, one off-region. The `replication` block and an off-region `walArchive` destination satisfy this without extra tooling.
- **Encrypt before transit.** Snapshots are encrypted with your KMS key on the host before upload. KernelCMS never holds plaintext backups, and on Cloud the key can be customer-managed (BYOK).
- **Verify, don't trust.** `verify: 'restore-check'` spins each snapshot into a throwaway database and runs a schema-and-row-count assertion. A snapshot that fails verification is alarmed, not silently retained.

### Media and the database must be consistent

The subtle failure mode in any CMS is a content row that references a media object the storage backup doesn't contain — or vice versa. Payload, Sanity, and Strapi all leave this consistency to your ops discipline. KernelCMS coordinates it: the snapshot job records the storage backup's generation marker (S3 version-id watermark or equivalent) alongside the database snapshot. On restore, the orchestrator restores the database first, then reconciles uploads against that watermark, and reports any dangling references before declaring success.

```
   DB snapshot (T)                Storage watermark (T)
        │                                 │
        ▼                                 ▼
  ┌───────────┐   restore    ┌──────────────────────┐
  │  content  │ ───────────▶ │ reconcile uploads vs │
  │  + refs   │              │   version watermark  │
  └───────────┘              └──────────┬───────────┘
                                        │ dangling refs?
                                        ▼
                                 fail-fast report
```

## Point-in-time recovery

Snapshots alone give you coarse recovery — you lose everything written since the last snapshot. PITR closes that gap. For the SQL adapters, KernelCMS archives the write-ahead log (Postgres WAL, MySQL binlog) continuously and replays it on top of the most recent base snapshot to reconstruct state at any chosen timestamp within the retention window.

```ts
// CLI: recover the dataset to a precise instant
// kernel restore --to "2026-05-30T13:42:10Z" --target staging
```

Programmatically, the same operation is exposed through the typed admin/ops API:

```ts
import { createRecovery } from '@kernel/server'

const recovery = await createRecovery({
  adapter: 'postgres',
  pointInTime: new Date('2026-05-30T13:42:10Z'),
  target: 'staging',           // never restore over prod by default
  reconcileStorage: true,
})

await recovery.run()           // streams progress events
console.log(recovery.report()) // rows restored, dangling refs, duration
```

PITR support differs by adapter, and we are explicit about it rather than papering over the gap:

| Adapter | PITR mechanism | Granularity |
| --- | --- | --- |
| `@kernel/db-postgres` | WAL archive + base backup replay | Single transaction |
| `@kernel/db-mysql` | Binlog replay | Single transaction |
| `@kernel/db-sqlite` (libSQL) | Replication frames / litestream-style WAL shipping | Frame (sub-second) |
| `@kernel/db-mongodb` | Oplog replay | Single operation |

This is where KernelCMS pulls ahead of the field. Self-hosted Payload and Strapi inherit whatever your database gives you and leave orchestration entirely to you. Sanity offers dataset rollback and a history API on its managed platform, but you do not run it yourself and the granularity is tied to their transaction log, not yours. KernelCMS gives you transaction-level PITR you operate directly, with the *same command surface* across four databases — so switching adapters does not mean relearning recovery.

PITR also composes with KernelCMS version history. Version history (autosave snapshots of individual documents) is the right tool to revert one editor's mistake; PITR is the right tool to undo a bad migration or a corrupting bulk write across the whole dataset. They are complementary, not redundant — see Versions & drafts.

## Restore drills

A restore path that is not exercised regularly will fail when you need it. KernelCMS ships a drill harness so recovery is a scheduled, measured routine — not a panicked improvisation during an outage.

```ts
// kernel.config.ts (excerpt)
backups: {
  drills: {
    schedule: '0 4 * * 1',        // every Monday 04:00
    target: 'ephemeral',          // throwaway DB, torn down after
    assertions: [
      'schema-matches-config',    // restored schema === kernel.config.ts
      'row-counts-within(1%)',    // content volume sanity
      'no-dangling-uploads',      // storage/db consistency
      'rpo-within-target',        // measured lag ≤ declared RPO
    ],
    onFailure: 'page',            // route to on-call, open incident
  },
}
```

Each drill produces a signed report with the measured RTO (wall-clock time to a usable dataset) and the measured RPO (the gap between the recovery point and the last durable write). These are not estimates — they are observations from a real restore against real backup artifacts. Trend them; a creeping RTO is an early warning that your dataset has outgrown your recovery plan.

Run the loop:

```
 take backup ──▶ store off-region ──▶ scheduled drill
      ▲                                     │
      │                                     ▼
   adjust plan ◀── review measured ◀── assert + report
                   RPO / RTO
```

On KernelCMS Cloud, drills run automatically against every tenant's backups on a rolling schedule, and the measured RPO/RTO are surfaced in the observability dashboard. Self-hosters get the same harness via `kernel drill --run` and should wire it into CI so a failing drill blocks nothing in prod but pages a human.

## RPO and RTO targets

Recovery Point Objective (how much data you can afford to lose) and Recovery Time Objective (how long recovery may take) are commitments, not aspirations. Set them per environment and let the backup configuration prove they are achievable through the drill harness.

| Tier | RPO | RTO | Backup posture |
| --- | --- | --- | --- |
| Cloud (Business) | ≤ 5 min | ≤ 30 min | Continuous WAL, hot standby, off-region replication |
| Cloud (Standard) | ≤ 1 h | ≤ 4 h | Continuous WAL, snapshot restore |
| Self-host (recommended) | ≤ 15 min | ≤ 1 h | WAL archive + weekly full + daily incremental |
| Self-host (minimum) | ≤ 24 h | best-effort | Daily snapshot only — acceptable only for dev |

The relationship is direct: your RPO is bounded by how frequently durable state leaves the primary. Continuous WAL/binlog archival pushes RPO toward seconds; snapshot-only postures cap it at the snapshot interval. RTO is bounded by dataset size, restore bandwidth, and WAL-replay distance from the nearest base snapshot — which is exactly why the strategy above keeps a recent base backup: shorter replay, faster recovery.

KernelCMS makes these targets enforceable. Declare them in config, and the drill harness fails loudly when reality drifts past the line:

```ts
backups: {
  objectives: {
    rpo: '15m',
    rto: '1h',
  },
  // drills assert measured RPO/RTO ≤ objectives, else `onFailure: 'page'`
}
```

This is the wedge against the competition once more: Payload and Strapi give you no built-in notion of RPO/RTO — you assemble it from external tooling and hope. Sanity meets aggressive objectives but only because they operate the infrastructure and you accept their numbers. KernelCMS lets you *declare* objectives and *measure* against them, whether you self-host or run on Cloud, with content and config portable between the two so a DR plan survives a platform move. See Self-hosting and Cloud overview.

## Open questions

- **Cross-adapter restore.** Should `kernel restore` support restoring a Postgres backup into a MySQL target via the logical content format, or do we keep restores adapter-homogeneous and require a migration for cross-engine moves?
- **Media PITR.** Object versioning gives us per-object history, but a true storage-side "point in time" across millions of objects is expensive. Is the version-watermark reconciliation sufficient, or do we need a manifest-based storage snapshot for strict consistency guarantees?
- **Drill cost on Cloud.** Per-tenant ephemeral restores are the gold standard but costly at scale. Do we sample tenants statistically below a certain size tier, and if so, how do we keep the per-tenant RPO/RTO numbers honest?
