/**
 * Portable data import. Migrating from Payload/Sanity/Strapi (track 12) reduces to
 * producing a portable `{ [slug]: rows[] }` document and importing it here: each
 * row flows through the normal create pipeline (validation, hooks, access), so a
 * bad row is reported, not silently dropped. Deterministic and resumable-friendly.
 */
import type { Row } from '@kernel/db'
import { fromHTML } from '@kernel/richtext'
import type { CollectionConfig, Kernel } from './types'
import { effectiveFields } from './fields'
import { ValidationError } from './errors'

export type ImportPayload = Record<string, Row[]>

/** Top-level richText field names on a collection (portable exports keep richText
 *  as an HTML string at the top level — the common migration shape). */
function richTextFields(collection: CollectionConfig): string[] {
  return effectiveFields(collection.fields)
    .filter((f) => f.type === 'richText')
    .map((f) => f.name)
}

/** Convert any HTML/Markdown-ish string in a richText field to the node tree, so a
 *  portable HTML export populates the editor instead of becoming one plain run. */
function coerceRichText(row: Row, fields: string[]): Row {
  if (fields.length === 0) return row
  let out: Row | null = null
  for (const name of fields) {
    if (typeof row[name] === 'string') {
      out ??= { ...row }
      out[name] = fromHTML(row[name] as string)
    }
  }
  return out ?? row
}

export interface ImportError {
  collection: string
  index: number
  message: string
}

export interface ImportReport {
  created: Record<string, number>
  errors: ImportError[]
  total: number
  ok: boolean
}

export interface ImportOptions {
  /** Run as a trusted caller (bypass access). Default true (migrations are operator-run). */
  overrideAccess?: boolean
  /** Stop at the first failing row instead of collecting and continuing. Default false. */
  stopOnError?: boolean
}

/** Import a portable payload into the kernel. Unknown collections are reported, not thrown. */
export async function importData(
  kernel: Kernel,
  payload: ImportPayload,
  options: ImportOptions = {},
): Promise<ImportReport> {
  const overrideAccess = options.overrideAccess ?? true
  const created: Record<string, number> = {}
  const errors: ImportError[] = []
  let total = 0

  for (const [collection, rows] of Object.entries(payload)) {
    created[collection] = 0
    const collConfig = kernel.config.collectionsBySlug[collection]
    if (!collConfig) {
      errors.push({ collection, index: -1, message: `Unknown collection "${collection}".` })
      if (options.stopOnError) return finalize(created, errors, total)
      continue
    }
    const rtFields = richTextFields(collConfig)
    for (let i = 0; i < rows.length; i++) {
      total++
      try {
        await kernel.create({ collection, data: coerceRichText(rows[i]!, rtFields), overrideAccess })
        created[collection]++
      } catch (err) {
        const message =
          err instanceof ValidationError
            ? err.errors.map((e) => `${e.path}: ${e.message}`).join('; ')
            : (err as Error).message
        errors.push({ collection, index: i, message })
        if (options.stopOnError) return finalize(created, errors, total)
      }
    }
  }
  return finalize(created, errors, total)
}

function finalize(created: Record<string, number>, errors: ImportError[], total: number): ImportReport {
  return { created, errors, total, ok: errors.length === 0 }
}
