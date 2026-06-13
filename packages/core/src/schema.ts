import type { KernelSchema, TableSchema } from '@kernel/db'
import type { SanitizedConfig } from './types'
import { columnForField, storageFields } from './fields'

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
