/**
 * Full-text search: a default in-memory `SearchAdapter` plus the wiring that
 * keeps the index in sync with content. Searchable collections index their
 * configured text fields on write and drop the document on delete.
 *
 * `kernel.search()` returns scored hits, then loads each document through the
 * normal access-checked read path — so the index can never surface a document a
 * caller is not allowed to read.
 */
import type { AdapterContext, Logger, SearchAdapter, SearchResult } from '@kernel/db'
import type { CollectionConfig, Doc } from './types'
import { effectiveFields } from './fields'

const SEARCH_CONTRACT_VERSION = '1.0' as const

/** Lowercase alphanumeric tokens; collapses punctuation and whitespace. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length > 0)
}

/**
 * In-memory inverted index. Per-process; fine for a single node and modest
 * corpora. Scores a hit by how many distinct query tokens it contains. For large
 * corpora or multi-node, back this with a database FTS or external search engine
 * adapter (same contract).
 */
export function memorySearch(): SearchAdapter {
  // collection -> token -> set of doc ids
  const index = new Map<string, Map<string, Set<string>>>()
  // collection -> id -> the tokens that doc contributed (for clean removal)
  const docs = new Map<string, Map<string, Set<string>>>()

  function colIndex(collection: string): Map<string, Set<string>> {
    let m = index.get(collection)
    if (!m) {
      m = new Map()
      index.set(collection, m)
    }
    return m
  }
  function colDocs(collection: string): Map<string, Set<string>> {
    let m = docs.get(collection)
    if (!m) {
      m = new Map()
      docs.set(collection, m)
    }
    return m
  }

  function removeInternal(collection: string, id: string): void {
    const dm = docs.get(collection)
    const tokens = dm?.get(id)
    if (!tokens) return
    const idx = index.get(collection)
    if (idx) {
      for (const token of tokens) {
        const set = idx.get(token)
        if (!set) continue
        set.delete(id)
        if (set.size === 0) idx.delete(token)
      }
    }
    dm!.delete(id)
  }

  return {
    kind: 'search',
    name: 'memory',
    contractVersion: SEARCH_CONTRACT_VERSION,
    async init(_ctx: AdapterContext): Promise<void> {},
    async health() {
      return { status: 'ok' as const }
    },
    async destroy(): Promise<void> {
      index.clear()
      docs.clear()
    },
    async index({ collection, id, text }): Promise<void> {
      removeInternal(collection, id) // replace any prior entry cleanly
      const tokens = new Set(tokenize(text))
      if (tokens.size === 0) return
      const idx = colIndex(collection)
      for (const token of tokens) {
        let set = idx.get(token)
        if (!set) {
          set = new Set()
          idx.set(token, set)
        }
        set.add(id)
      }
      colDocs(collection).set(id, tokens)
    },
    async remove({ collection, id }): Promise<void> {
      removeInternal(collection, id)
    },
    async search({ collection, query, limit }): Promise<SearchResult> {
      const idx = index.get(collection)
      if (!idx) return { hits: [] }
      const terms = new Set(tokenize(query))
      if (terms.size === 0) return { hits: [] }
      const scores = new Map<string, number>()
      for (const term of terms) {
        const set = idx.get(term)
        if (!set) continue
        for (const id of set) scores.set(id, (scores.get(id) ?? 0) + 1)
      }
      const hits = [...scores.entries()]
        .map(([id, score]) => ({ id, score }))
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.max(1, limit))
      return { hits }
    },
    async clear(collection?: string): Promise<void> {
      if (collection) {
        index.delete(collection)
        docs.delete(collection)
      } else {
        index.clear()
        docs.clear()
      }
    },
  }
}

/** Concatenate the searchable text of a document from its configured fields. */
export function extractSearchText(collection: CollectionConfig, fields: string[], doc: Doc): string {
  const allowed = new Set(fields)
  const parts: string[] = []
  for (const field of effectiveFields(collection.fields)) {
    if (!allowed.has(field.name)) continue
    const value = doc[field.name]
    parts.push(flatten(value))
  }
  return parts.join(' ').trim()
}

/** Best-effort text from a field value (strings, rich text doc, arrays of either). */
function flatten(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(flatten).join(' ')
  if (typeof value === 'object') {
    // Rich text / nested: pull any string leaves (e.g. { text } nodes).
    const obj = value as Record<string, unknown>
    if (typeof obj.text === 'string') return obj.text
    return Object.values(obj).map(flatten).join(' ')
  }
  return ''
}

/**
 * Attach index-sync hooks to searchable collections: index configured fields on
 * create/update, remove on delete. System collections are excluded. Mutates the
 * collections in place. Errors are caught and logged — search-sync must never
 * fail a write.
 */
export function attachSearch(
  collections: CollectionConfig[],
  search: SearchAdapter,
  searchableFields: Readonly<Record<string, string[]>>,
  logger: Logger,
): void {
  for (const collection of collections) {
    const fields = searchableFields[collection.slug]
    if (!fields || fields.length === 0) continue
    const slug = collection.slug
    const hooks = (collection.hooks ??= {})

    const onChange = async (args: { doc: Doc }): Promise<Doc> => {
      try {
        const text = extractSearchText(collection, fields, args.doc)
        await search.index({ collection: slug, id: args.doc.id, text })
      } catch (err) {
        logger.warn(`search index failed for ${slug}/${args.doc.id}`, err)
      }
      return args.doc
    }
    hooks.afterChange = [...(hooks.afterChange ?? []), onChange as never]

    const onDelete = async (args: { id: string }): Promise<void> => {
      try {
        await search.remove({ collection: slug, id: args.id })
      } catch (err) {
        logger.warn(`search remove failed for ${slug}/${args.id}`, err)
      }
    }
    hooks.afterDelete = [...(hooks.afterDelete ?? []), onDelete as never]
  }
}
