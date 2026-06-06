import type { KernelSchema, TableSchema } from '@kernel/db'
import type { SanitizedConfig } from './types'
import { columnForField } from './fields'

export function tableForCollection(slug: string): string {
  return slug
}

export function tableForGlobal(slug: string): string {
  return `__global_${slug}`
}

/** The fixed primary-key id used for the single row backing a global. */
export const GLOBAL_ROW_ID = 'singleton'

/** Compile the sanitized config into the storage-facing schema for the adapter. */
export function compileSchema(config: SanitizedConfig): KernelSchema {
  const tables: TableSchema[] = []

  for (const collection of config.collections) {
    tables.push({
      table: tableForCollection(collection.slug),
      slug: collection.slug,
      columns: collection.fields.map(columnForField),
      timestamps: collection.timestamps ?? true,
      singleton: false,
    })
  }

  for (const global of config.globals) {
    tables.push({
      table: tableForGlobal(global.slug),
      slug: global.slug,
      columns: global.fields.map(columnForField),
      timestamps: true,
      singleton: true,
    })
  }

  return { tables }
}
