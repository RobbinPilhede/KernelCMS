import type { KernelSchema, TableSchema } from '@kernel/db'
import type { SanitizedConfig } from './types'
import { columnForField, storageFields } from './fields'
import { ROLES_TABLE } from './rbac'

export function tableForCollection(slug: string): string {
  return slug
}

export function tableForGlobal(slug: string): string {
  return `__global_${slug}`
}

/** Storage table holding a collection's version snapshots. */
export function tableForVersions(slug: string): string {
  return `_versions_${slug}`
}

/** Resolve a collection's versions config into a normalized shape. */
export function resolveVersions(versions: boolean | { drafts?: boolean; maxPerDoc?: number } | undefined): {
  enabled: boolean
  drafts: boolean
  maxPerDoc: number
} {
  if (!versions) return { enabled: false, drafts: false, maxPerDoc: 100 }
  if (versions === true) return { enabled: true, drafts: false, maxPerDoc: 100 }
  return { enabled: true, drafts: Boolean(versions.drafts), maxPerDoc: versions.maxPerDoc ?? 100 }
}

/** The fixed primary-key id used for the single row backing a global. */
export const GLOBAL_ROW_ID = 'singleton'

/** Storage table holding the append-only governance audit log. */
export const AUDIT_TABLE = '_audit'

/** Storage table holding agent-review decisions (the human approval inbox). */
export const REVIEWS_TABLE = '_reviews'

/** Storage table holding content releases — one row per named bundle of drafts published
 *  as a unit. Provisioned only when `config.releases` is enabled. `status` is indexed for
 *  the list/drain scans; `scheduledAt` (indexed) drives the scheduled-release drain. */
export const RELEASES_TABLE = '_releases'

/** Storage table holding release membership — one row per (release, collection, documentId).
 *  Provisioned only when `config.releases` is enabled. `release` is indexed for the items
 *  lookup; `documentId` is indexed so a doc's releases are queryable. */
export const RELEASE_ITEMS_TABLE = '_release_items'

/** Storage table holding the migration journal — one row per applied migration,
 *  recording exactly what was created so a rollback can invert only those changes. */
export const MIGRATIONS_TABLE = '_migrations'

/** Storage table holding ADVISORY soft locks — one row per `${collection}:${documentId}`
 *  a principal is editing. Advisory only: a lock NEVER changes write authorization, it
 *  just signals "someone else is here". Always provisioned (a system table, no opt-in). */
export const LOCKS_TABLE = '_locks'

/** Storage table holding lightweight presence — one row per
 *  `${collection}:${documentId}:${principalId}` heartbeat (who's viewing/editing).
 *  Active set is derived by a `lastSeen` TTL filter. Always provisioned. */
export const PRESENCE_TABLE = '_presence'

/** Storage table holding content credentials — one signed, tamper-evident manifest row
 *  per publish (current + history). The signature covers the manifest; the manifest
 *  embeds the published doc's content hash so a later edit is detectable. Always
 *  provisioned (a system table); writes happen only when `config.signing` is enabled. */
export const CREDENTIALS_TABLE = '_credentials'

/** Storage table holding the durable change feed (CDC outbox) — one row per content
 *  change on a non-system collection. Each row carries METADATA ONLY (no document body):
 *  a monotonic `seq` cursor, the time, the collection + documentId, the event, and the
 *  acting principal's id + kind. Provisioned only when `config.realtime` is enabled. The
 *  pull feed + SSE stream read it; it is NEVER reachable via generic CRUD (like `_audit`).
 *  `seq` is indexed (the cursor scan + trim both order by it). */
export const CHANGES_TABLE = '_changes'

/** Storage table holding the durable workflow run log — one row per workflow run,
 *  recording its status, trigger, and per-step status/log. Provisioned only when
 *  `config.workflows` is set. The engine reads/writes it via the trusted (overrideAccess)
 *  path; content writes inside a run still go through the scoped agent principal. */
export const WORKFLOW_RUNS_TABLE = '_workflow_runs'

/** Compile the sanitized config into the storage-facing schema for the adapter. */
export function compileSchema(config: SanitizedConfig): KernelSchema {
  const tables: TableSchema[] = []

  for (const collection of config.collections) {
    const versions = resolveVersions(collection.versions)
    const columns = storageFields(collection.fields).map(columnForField)
    // Drafts add a system status column to the main row, plus a scheduled-publish time.
    if (versions.drafts) {
      columns.push({ name: '_status', type: 'text', required: false, unique: false, indexed: true, localized: false })
      columns.push({
        name: '_scheduled_at',
        type: 'timestamp',
        required: false,
        unique: false,
        indexed: true,
        localized: false,
      })
    }
    tables.push({
      table: tableForCollection(collection.slug),
      slug: collection.slug,
      columns,
      timestamps: collection.timestamps ?? true,
      singleton: false,
    })

    // A version-snapshot table per versioned collection.
    if (resolveVersions(collection.versions).enabled) {
      tables.push({
        table: tableForVersions(collection.slug),
        slug: tableForVersions(collection.slug),
        columns: [
          { name: 'parent', type: 'text', required: true, unique: false, indexed: true, localized: false },
          { name: 'version', type: 'json', required: false, unique: false, indexed: false, localized: false },
          { name: 'status', type: 'text', required: false, unique: false, indexed: true, localized: false },
          { name: 'autosave', type: 'boolean', required: false, unique: false, indexed: false, localized: false },
          { name: 'createdBy', type: 'text', required: false, unique: false, indexed: false, localized: false },
          // Principal kind that authored the snapshot ('user' | 'agent') so agent
          // changes are queryable for review. Nullable; defaults to 'user'.
          { name: 'createdByType', type: 'text', required: false, unique: false, indexed: true, localized: false },
          // The approver of a review-approved publish (provenance chain). Nullable —
          // only a publish-via-approval (or a non-review publish) sets it.
          { name: 'approvedBy', type: 'text', required: false, unique: false, indexed: false, localized: false },
          { name: 'approvedByType', type: 'text', required: false, unique: false, indexed: false, localized: false },
        ],
        timestamps: true,
        singleton: false,
      })
    }
  }

  // Single append-only audit table, provisioned only when auditing is enabled.
  // Mirrors the version-table definition style: a flat row of indexed columns plus
  // JSON payloads. `at` is the event time (indexed for range/sort); the principal
  // and target columns are nullable + indexed so the log filters efficiently.
  if (config.audit.enabled) {
    tables.push({
      table: AUDIT_TABLE,
      slug: AUDIT_TABLE,
      columns: [
        { name: 'at', type: 'timestamp', required: true, unique: false, indexed: true, localized: false },
        { name: 'action', type: 'text', required: true, unique: false, indexed: true, localized: false },
        { name: 'collection', type: 'text', required: false, unique: false, indexed: true, localized: false },
        { name: 'documentId', type: 'text', required: false, unique: false, indexed: true, localized: false },
        { name: 'principalId', type: 'text', required: false, unique: false, indexed: true, localized: false },
        { name: 'principalType', type: 'text', required: false, unique: false, indexed: false, localized: false },
        { name: 'fields', type: 'json', required: false, unique: false, indexed: false, localized: false },
        { name: 'meta', type: 'json', required: false, unique: false, indexed: false, localized: false },
      ],
      timestamps: true,
      singleton: false,
    })
  }

  // Agent-review decisions, provisioned only when the review inbox is enabled. Mirrors
  // the audit-table style: a flat row of indexed columns. The queue is DERIVED from the
  // documents (agent-authored drafts) + these rows; this table only persists decisions.
  // `(collection, documentId)` is the lookup the queue scan and `submitReview` both use;
  // `documentId` alone is indexed for cross-collection latest-review lookups.
  if (config.review.enabled) {
    tables.push({
      table: REVIEWS_TABLE,
      slug: REVIEWS_TABLE,
      columns: [
        { name: 'at', type: 'timestamp', required: true, unique: false, indexed: true, localized: false },
        { name: 'collection', type: 'text', required: true, unique: false, indexed: true, localized: false },
        { name: 'documentId', type: 'text', required: true, unique: false, indexed: true, localized: false },
        { name: 'decision', type: 'text', required: true, unique: false, indexed: true, localized: false },
        { name: 'reviewerId', type: 'text', required: false, unique: false, indexed: true, localized: false },
        { name: 'reviewerType', type: 'text', required: false, unique: false, indexed: false, localized: false },
        { name: 'note', type: 'text', required: false, unique: false, indexed: false, localized: false },
      ],
      timestamps: true,
      singleton: false,
    })
  }

  // Content releases, provisioned only when releases are enabled. `_releases` is the
  // bundle header (status/schedule/provenance); `_release_items` is the membership list,
  // a flat (release, collection, documentId) row. `status` + `scheduledAt` are indexed
  // for the list + drain scans; `release` + `documentId` on items are indexed for the
  // per-release items lookup and reverse "which releases hold this doc" queries. The
  // (release, collection, documentId) uniqueness is enforced in the op (de-dupe), not a
  // composite DB constraint, to stay portable across adapters.
  if (config.releases.enabled) {
    tables.push({
      table: RELEASES_TABLE,
      slug: RELEASES_TABLE,
      columns: [
        { name: 'name', type: 'text', required: true, unique: false, indexed: false, localized: false },
        { name: 'status', type: 'text', required: true, unique: false, indexed: true, localized: false },
        { name: 'scheduledAt', type: 'timestamp', required: false, unique: false, indexed: true, localized: false },
        { name: 'createdBy', type: 'text', required: false, unique: false, indexed: true, localized: false },
        { name: 'createdByType', type: 'text', required: false, unique: false, indexed: false, localized: false },
        { name: 'publishedAt', type: 'timestamp', required: false, unique: false, indexed: false, localized: false },
      ],
      timestamps: true,
      singleton: false,
    })
    tables.push({
      table: RELEASE_ITEMS_TABLE,
      slug: RELEASE_ITEMS_TABLE,
      columns: [
        { name: 'release', type: 'text', required: true, unique: false, indexed: true, localized: false },
        { name: 'collection', type: 'text', required: true, unique: false, indexed: false, localized: false },
        { name: 'documentId', type: 'text', required: true, unique: false, indexed: true, localized: false },
      ],
      timestamps: true,
      singleton: false,
    })
  }

  // Runtime-editable RBAC roles, provisioned only when RBAC is enabled. `name` is the
  // primary key (text); `def` holds the RoleDef as JSON. Seeded from config on first boot.
  if (config.rbac.enabled) {
    tables.push({
      table: ROLES_TABLE,
      slug: ROLES_TABLE,
      columns: [
        { name: 'name', type: 'text', required: true, unique: true, indexed: true, localized: false },
        { name: 'def', type: 'json', required: false, unique: false, indexed: false, localized: false },
      ],
      timestamps: true,
      singleton: false,
    })
  }

  // Migration journal: one row per applied (non-empty, non-dry-run) migration,
  // recording the createdTables/addedColumns/statements so a rollback can invert
  // ONLY what this tool added. Always provisioned — like a system table — so the
  // engine can record/read it on any boot without a config opt-in.
  tables.push({
    table: MIGRATIONS_TABLE,
    slug: MIGRATIONS_TABLE,
    columns: [
      { name: 'at', type: 'timestamp', required: true, unique: false, indexed: true, localized: false },
      { name: 'createdTables', type: 'json', required: false, unique: false, indexed: false, localized: false },
      { name: 'addedColumns', type: 'json', required: false, unique: false, indexed: false, localized: false },
      { name: 'statements', type: 'json', required: false, unique: false, indexed: false, localized: false },
    ],
    timestamps: true,
    singleton: false,
  })

  // Advisory soft locks. Always provisioned (a system table, no config opt-in) so the
  // collaboration ops work on any boot. The pk is `${collection}:${documentId}`, so a
  // doc has at most ONE lock row; `expiresAt` (indexed) drives the unexpired filter and
  // a re-acquire by the same principal just overwrites the row. Advisory by contract —
  // nothing here gates writes; access control is unaffected (see operations.acquireLock).
  tables.push({
    table: LOCKS_TABLE,
    slug: LOCKS_TABLE,
    columns: [
      { name: 'collection', type: 'text', required: true, unique: false, indexed: true, localized: false },
      { name: 'documentId', type: 'text', required: true, unique: false, indexed: true, localized: false },
      { name: 'principalId', type: 'text', required: true, unique: false, indexed: true, localized: false },
      { name: 'principalType', type: 'text', required: false, unique: false, indexed: false, localized: false },
      { name: 'acquiredAt', type: 'timestamp', required: true, unique: false, indexed: false, localized: false },
      { name: 'expiresAt', type: 'timestamp', required: true, unique: false, indexed: true, localized: false },
      { name: 'label', type: 'text', required: false, unique: false, indexed: false, localized: false },
    ],
    timestamps: true,
    singleton: false,
  })

  // Lightweight presence. Always provisioned. The pk is
  // `${collection}:${documentId}:${principalId}`, so each principal has at most ONE row
  // per doc and a heartbeat is a cheap idempotent upsert. The active set is whoever's
  // `lastSeen` (indexed) is within the TTL of "now"; stale rows are simply filtered out
  // (and lazily pruned). `kind` records 'viewing'|'editing'.
  tables.push({
    table: PRESENCE_TABLE,
    slug: PRESENCE_TABLE,
    columns: [
      { name: 'collection', type: 'text', required: true, unique: false, indexed: true, localized: false },
      { name: 'documentId', type: 'text', required: true, unique: false, indexed: true, localized: false },
      { name: 'principalId', type: 'text', required: true, unique: false, indexed: true, localized: false },
      { name: 'principalType', type: 'text', required: false, unique: false, indexed: false, localized: false },
      { name: 'kind', type: 'text', required: false, unique: false, indexed: false, localized: false },
      { name: 'lastSeen', type: 'timestamp', required: true, unique: false, indexed: true, localized: false },
    ],
    timestamps: true,
    singleton: false,
  })

  // Content credentials. Always provisioned (a system table). A row per publish, holding
  // the signed manifest (JSON) + signature + algorithm. `(collection, documentId)` is the
  // lookup for the latest credential; `signedAt` orders the history newest-first. No key
  // material is ever stored here — only the manifest claims, the signature, and the alg.
  tables.push({
    table: CREDENTIALS_TABLE,
    slug: CREDENTIALS_TABLE,
    columns: [
      { name: 'collection', type: 'text', required: true, unique: false, indexed: true, localized: false },
      { name: 'documentId', type: 'text', required: true, unique: false, indexed: true, localized: false },
      { name: 'versionId', type: 'text', required: false, unique: false, indexed: false, localized: false },
      { name: 'manifest', type: 'json', required: false, unique: false, indexed: false, localized: false },
      { name: 'signature', type: 'text', required: true, unique: false, indexed: false, localized: false },
      { name: 'algorithm', type: 'text', required: true, unique: false, indexed: false, localized: false },
      { name: 'signedAt', type: 'timestamp', required: true, unique: false, indexed: true, localized: false },
    ],
    timestamps: true,
    singleton: false,
  })

  // Durable workflow run log, provisioned only when workflows are configured. A flat
  // row of indexed lookup columns (`slug`, `status`) plus JSON payloads for the trigger
  // and per-step records. `attempts`/`lastError` mirror the jobs retry bookkeeping.
  if (config.workflows.length > 0) {
    tables.push({
      table: WORKFLOW_RUNS_TABLE,
      slug: WORKFLOW_RUNS_TABLE,
      columns: [
        { name: 'slug', type: 'text', required: true, unique: false, indexed: true, localized: false },
        { name: 'status', type: 'text', required: true, unique: false, indexed: true, localized: false },
        { name: 'trigger', type: 'json', required: false, unique: false, indexed: false, localized: false },
        { name: 'steps', type: 'json', required: false, unique: false, indexed: false, localized: false },
        { name: 'attempts', type: 'integer', required: false, unique: false, indexed: false, localized: false },
        { name: 'lastError', type: 'text', required: false, unique: false, indexed: false, localized: false },
      ],
      timestamps: true,
      singleton: false,
    })
  }

  // Durable change feed (CDC outbox), provisioned only when realtime is enabled. A flat
  // metadata row: `seq` (the monotonic cursor, indexed for range scans + trim ordering),
  // `at`, the target collection/documentId, the event, and the acting principal id/kind.
  // No document body is ever stored here — a change row can never leak field values.
  if (config.realtime.enabled) {
    tables.push({
      table: CHANGES_TABLE,
      slug: CHANGES_TABLE,
      columns: [
        { name: 'seq', type: 'integer', required: true, unique: true, indexed: true, localized: false },
        { name: 'at', type: 'timestamp', required: true, unique: false, indexed: true, localized: false },
        { name: 'collection', type: 'text', required: true, unique: false, indexed: true, localized: false },
        { name: 'documentId', type: 'text', required: true, unique: false, indexed: true, localized: false },
        { name: 'event', type: 'text', required: true, unique: false, indexed: true, localized: false },
        { name: 'principalId', type: 'text', required: false, unique: false, indexed: false, localized: false },
        { name: 'principalType', type: 'text', required: false, unique: false, indexed: false, localized: false },
      ],
      timestamps: true,
      singleton: false,
    })
  }

  for (const global of config.globals) {
    tables.push({
      table: tableForGlobal(global.slug),
      slug: global.slug,
      columns: storageFields(global.fields).map(columnForField),
      timestamps: true,
      singleton: true,
    })
  }

  return { tables }
}
