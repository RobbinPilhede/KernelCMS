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
