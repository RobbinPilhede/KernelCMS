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

/** Storage table holding content-analytics events — one metadata-only row per captured
 *  content-usage event (view / search / ai_retrieval / citation / variant_impression /
 *  conversion / custom). Provisioned only when `config.analytics` is enabled. NO PII is
 *  ever stored: no principal id/IP/visitor key/email/token — only content/event metadata.
 *  `seq` (the monotonic cursor + trim order), `at`, `type`, `collection`, `documentId`,
 *  `experiment`, and `variant` are indexed so the bounded insight scans filter efficiently.
 *  Never reachable via generic CRUD (like `_audit`/`_changes`). */
export const ANALYTICS_TABLE = '_analytics'

/** Storage table holding editorial comments / annotations — one row per comment on a
 *  content document (with an optional field-name anchor + threaded `parentId`).
 *  Provisioned only when `config.comments` is enabled. `(collection, documentId)` is the
 *  per-document lookup the list scan uses; `documentId` alone is indexed for the
 *  per-comment ops. NEVER reachable via generic CRUD (like `_audit`); access is gated by
 *  the target DOCUMENT's read access, so a comment can't leak content a caller can't see. */
export const COMMENTS_TABLE = '_comments'

/** Storage table holding saved views / smart collections — one row per named query preset
 *  (`collection`, `name`, JSON `where`/`sort`/`columns`, `ownerId`, `shared`). Provisioned
 *  only when `config.views` is enabled. `ownerId` and `collection` are indexed for the list
 *  scan (own + shared-by-collection). NEVER reachable via generic CRUD; the view ops gate on
 *  ownership and on the target collection's read access, and applying a view runs the normal
 *  access-checked `find`, so a stored filter can only narrow within the caller's access. */
export const VIEWS_TABLE = '_views'

/** Storage table backing the durable webhook outbox — one row per queued delivery
 *  (`webhook` slug, event, target collection/documentId, JSON `payload`, `status`,
 *  `attempts`, `lastStatus`, `nextAttemptAt`, `deliveredAt`). Provisioned only when at
 *  least one `durable` webhook is configured. `status` + `nextAttemptAt` are indexed for
 *  the cron drain scan. NEVER reachable via generic CRUD. */
export const WEBHOOK_DELIVERIES_TABLE = '_webhook_deliveries'

/** Storage table backing saved-search alerts / content subscriptions — one row per standing
 *  query (`ownerId`/`ownerType`, target `collection`, JSON `where`, the delivery `webhook`
 *  slug, `active`, and a `lastSeq` change-feed cursor). Provisioned only when
 *  `config.subscriptions` is enabled. `ownerId` + `collection` + `active` are indexed for the
 *  drain scan. NEVER reachable via generic CRUD. */
export const SUBSCRIPTIONS_TABLE = '_subscriptions'

/** Storage tables for content branches: `_branches` (one row per named workspace — name,
 *  status, createdBy) and `_branch_docs` (the copy-on-write overlay — one row per staged
 *  document edit: branch, collection, documentId, JSON data). Provisioned only when
 *  `config.branches` is enabled. NEVER reachable via generic CRUD. */
export const BRANCHES_TABLE = '_branches'
export const BRANCH_DOCS_TABLE = '_branch_docs'

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
    // Content lifecycle (archive action): a server-managed timestamp stamped when the
    // expiry drain archives a doc. An archived doc is `_status:'draft'` (hidden from
    // public reads) AND carries a non-null `_archived_at` (distinguishable from a plain
    // draft). Client writes can never set/clear it (it is not a schema field, so
    // `serializeDoc` drops it; the engine writes it only via the trusted drain).
    if (config.lifecycle.archiveSlugs.includes(collection.slug)) {
      columns.push({
        name: '_archived_at',
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

  // Content-analytics events (CDC-style metadata outbox), provisioned only when
  // analytics is enabled. A flat metadata row: `seq` (monotonic cursor + trim order),
  // `at`, the event `type`, the target collection/documentId, the search `query` TERMS,
  // the experiment+variant, a numeric `value`, and a non-PII `meta` JSON. NO principal,
  // IP, visitor key, email, or token column exists — there is nowhere to store PII.
  if (config.analytics.enabled) {
    tables.push({
      table: ANALYTICS_TABLE,
      slug: ANALYTICS_TABLE,
      columns: [
        { name: 'seq', type: 'integer', required: true, unique: true, indexed: true, localized: false },
        { name: 'at', type: 'timestamp', required: true, unique: false, indexed: true, localized: false },
        { name: 'type', type: 'text', required: true, unique: false, indexed: true, localized: false },
        { name: 'collection', type: 'text', required: false, unique: false, indexed: true, localized: false },
        { name: 'documentId', type: 'text', required: false, unique: false, indexed: true, localized: false },
        { name: 'query', type: 'text', required: false, unique: false, indexed: false, localized: false },
        { name: 'experiment', type: 'text', required: false, unique: false, indexed: true, localized: false },
        { name: 'variant', type: 'text', required: false, unique: false, indexed: true, localized: false },
        { name: 'value', type: 'real', required: false, unique: false, indexed: false, localized: false },
        { name: 'meta', type: 'json', required: false, unique: false, indexed: false, localized: false },
      ],
      timestamps: true,
      singleton: false,
    })
  }

  // Editorial comments / annotations, provisioned only when `config.comments` is enabled.
  // A flat row keyed by `(collection, documentId)` (both indexed for the per-document list
  // scan); `field` is an optional field-name anchor and `parentId` threads replies. The
  // author (`authorId`/`authorType`) is recorded from the trusted principal at write time.
  // Never reachable via generic CRUD (like `_audit`); access is gated by the target
  // document's read access in the comment ops.
  if (config.comments.enabled) {
    tables.push({
      table: COMMENTS_TABLE,
      slug: COMMENTS_TABLE,
      columns: [
        { name: 'collection', type: 'text', required: true, unique: false, indexed: true, localized: false },
        { name: 'documentId', type: 'text', required: true, unique: false, indexed: true, localized: false },
        { name: 'field', type: 'text', required: false, unique: false, indexed: false, localized: false },
        { name: 'parentId', type: 'text', required: false, unique: false, indexed: true, localized: false },
        { name: 'body', type: 'text', required: true, unique: false, indexed: false, localized: false },
        { name: 'authorId', type: 'text', required: false, unique: false, indexed: true, localized: false },
        { name: 'authorType', type: 'text', required: false, unique: false, indexed: false, localized: false },
        { name: 'resolved', type: 'boolean', required: false, unique: false, indexed: true, localized: false },
      ],
      timestamps: true,
      singleton: false,
    })
  }

  // Saved views / smart collections, provisioned only when `config.views` is enabled. A flat
  // row per named query preset: `collection` + `name`, the JSON `where`/`sort`/`columns`
  // payload, the `ownerId` (recorded from the trusted principal at write time, indexed for the
  // "my views" scan), and a `shared` flag. Never reachable via generic CRUD; the view ops gate
  // on ownership + the target collection's read access, and applying re-validates the stored
  // filter and runs the normal access-checked find.
  if (config.views.enabled) {
    tables.push({
      table: VIEWS_TABLE,
      slug: VIEWS_TABLE,
      columns: [
        { name: 'collection', type: 'text', required: true, unique: false, indexed: true, localized: false },
        { name: 'name', type: 'text', required: true, unique: false, indexed: false, localized: false },
        { name: 'where', type: 'json', required: false, unique: false, indexed: false, localized: false },
        { name: 'sort', type: 'json', required: false, unique: false, indexed: false, localized: false },
        { name: 'columns', type: 'json', required: false, unique: false, indexed: false, localized: false },
        { name: 'ownerId', type: 'text', required: false, unique: false, indexed: true, localized: false },
        { name: 'shared', type: 'boolean', required: false, unique: false, indexed: true, localized: false },
      ],
      timestamps: true,
      singleton: false,
    })
  }

  // Durable webhook outbox, provisioned only when at least one configured webhook opts into
  // `durable` delivery. One row per queued delivery; `status` + `nextAttemptAt` index the
  // cron drain scan. Never reachable via generic CRUD; written only by the webhook enqueue
  // hook + the drain (`processWebhooks`), both trusted/override.
  // The webhook outbox is also the delivery channel for saved-search alerts, so provision it
  // when subscriptions are enabled even if no webhook opted into `durable`.
  if (config.webhooks.some((w) => w.durable) || config.subscriptions.enabled) {
    tables.push({
      table: WEBHOOK_DELIVERIES_TABLE,
      slug: WEBHOOK_DELIVERIES_TABLE,
      columns: [
        { name: 'webhook', type: 'text', required: true, unique: false, indexed: true, localized: false },
        { name: 'event', type: 'text', required: true, unique: false, indexed: false, localized: false },
        { name: 'collection', type: 'text', required: true, unique: false, indexed: true, localized: false },
        { name: 'documentId', type: 'text', required: true, unique: false, indexed: false, localized: false },
        { name: 'payload', type: 'json', required: false, unique: false, indexed: false, localized: false },
        { name: 'status', type: 'text', required: true, unique: false, indexed: true, localized: false },
        { name: 'attempts', type: 'integer', required: false, unique: false, indexed: false, localized: false },
        { name: 'lastStatus', type: 'text', required: false, unique: false, indexed: false, localized: false },
        { name: 'nextAttemptAt', type: 'timestamp', required: false, unique: false, indexed: true, localized: false },
        { name: 'deliveredAt', type: 'timestamp', required: false, unique: false, indexed: false, localized: false },
      ],
      timestamps: true,
      singleton: false,
    })
  }

  // Saved-search alerts / content subscriptions, provisioned only when enabled. One row per
  // standing query; `ownerId`/`collection`/`active` index the drain scan. Never reachable via
  // generic CRUD; written only by the subscription ops + the drain (cursor advance).
  if (config.subscriptions.enabled) {
    tables.push({
      table: SUBSCRIPTIONS_TABLE,
      slug: SUBSCRIPTIONS_TABLE,
      columns: [
        { name: 'ownerId', type: 'text', required: false, unique: false, indexed: true, localized: false },
        { name: 'ownerType', type: 'text', required: false, unique: false, indexed: false, localized: false },
        { name: 'ownerRoles', type: 'json', required: false, unique: false, indexed: false, localized: false },
        { name: 'collection', type: 'text', required: true, unique: false, indexed: true, localized: false },
        { name: 'where', type: 'json', required: false, unique: false, indexed: false, localized: false },
        { name: 'webhook', type: 'text', required: true, unique: false, indexed: false, localized: false },
        { name: 'active', type: 'boolean', required: false, unique: false, indexed: true, localized: false },
        { name: 'lastSeq', type: 'integer', required: false, unique: false, indexed: false, localized: false },
      ],
      timestamps: true,
      singleton: false,
    })
  }

  // Content branches: the named workspaces + their copy-on-write overlay. Provisioned only
  // when enabled. Never reachable via generic CRUD; written only by the branch ops.
  if (config.branches.enabled) {
    tables.push({
      table: BRANCHES_TABLE,
      slug: BRANCHES_TABLE,
      columns: [
        { name: 'name', type: 'text', required: true, unique: true, indexed: true, localized: false },
        { name: 'status', type: 'text', required: true, unique: false, indexed: true, localized: false },
        { name: 'createdBy', type: 'text', required: false, unique: false, indexed: false, localized: false },
      ],
      timestamps: true,
      singleton: false,
    })
    tables.push({
      table: BRANCH_DOCS_TABLE,
      slug: BRANCH_DOCS_TABLE,
      columns: [
        { name: 'branch', type: 'text', required: true, unique: false, indexed: true, localized: false },
        { name: 'collection', type: 'text', required: true, unique: false, indexed: true, localized: false },
        { name: 'documentId', type: 'text', required: true, unique: false, indexed: true, localized: false },
        { name: 'data', type: 'json', required: false, unique: false, indexed: false, localized: false },
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
