/**
 * Semantic (vector) search: a default in-memory cosine-similarity `VectorAdapter`
 * plus the wiring that keeps embeddings in sync with content. A collection that
 * opts into `search: { semantic: true }` has each document's metadata-enriched
 * text embedded on write and upserted into the store, and removed on delete.
 *
 * The semantic ops (`kernel.semanticSearch` / `kernel.hybridSearch`) query the
 * store, then load each hit through the normal access-checked read path — so the
 * store can never surface a document a caller is not allowed to read. The text
 * indexed here is derived server-side from the full document; only the RETURNED
 * documents are access-checked (the embeddings themselves are never exposed).
 */
import type { AdapterContext, Logger, VectorAdapter, VectorEntry, VectorResult } from '@kernel/db'
import type { CollectionConfig, Doc, EmbedFn } from './types'
import { effectiveFields, fieldLabel } from './fields'
import { extractSearchText } from './search'

const VECTOR_CONTRACT_VERSION = '1.0' as const

/** Hard cap on embedding dimensionality — a sanity bound against a misconfigured
 *  or hostile `embed` returning an enormous vector (memory/CPU DoS). */
export const MAX_VECTOR_DIMENSIONS = 8192

/** Normalize a vector to unit length so a dot product equals cosine similarity. A
 *  zero vector normalizes to itself (all-zero), yielding a 0 score against anything. */
function normalize(vector: number[]): number[] {
  let sumSq = 0
  for (const v of vector) sumSq += v * v
  const norm = Math.sqrt(sumSq)
  if (norm === 0) return vector.slice()
  const out = new Array<number>(vector.length)
  for (let i = 0; i < vector.length; i++) out[i] = vector[i]! / norm
  return out
}

/** Dot product of two equal-length vectors. With unit-normalized inputs this is the
 *  cosine similarity. Mismatched lengths score 0 (incomparable). */
export function dot(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!
  return sum
}

/** Cosine similarity of two raw (un-normalized) vectors, in [-1, 1]. */
export function cosineSimilarity(a: number[], b: number[]): number {
  return dot(normalize(a), normalize(b))
}

interface StoredVector {
  vector: number[]
  metadata: Record<string, string | number | boolean | null>
}

/**
 * In-memory, per-collection cosine-similarity store. Vectors are unit-normalized on
 * upsert so a query is a single dot product per candidate; top-K is a partial sort.
 * Per-process — fine for a single node and modest corpora. For production scale or
 * multi-node, back this with pgvector (same `VectorAdapter` contract).
 */
export function memoryVector(): VectorAdapter {
  // collection -> id -> stored vector + metadata
  const store = new Map<string, Map<string, StoredVector>>()

  function col(collection: string): Map<string, StoredVector> {
    let m = store.get(collection)
    if (!m) {
      m = new Map()
      store.set(collection, m)
    }
    return m
  }

  function matchesFilter(
    metadata: Record<string, string | number | boolean | null>,
    filter: Record<string, string | number | boolean | null>,
  ): boolean {
    for (const key of Object.keys(filter)) {
      if (metadata[key] !== filter[key]) return false
    }
    return true
  }

  return {
    kind: 'vector',
    name: 'memory',
    contractVersion: VECTOR_CONTRACT_VERSION,
    async init(_ctx: AdapterContext): Promise<void> {},
    async health() {
      return { status: 'ok' as const }
    },
    async destroy(): Promise<void> {
      store.clear()
    },
    async upsert({ collection, id, vector, metadata }): Promise<void> {
      // Defensive: never store a non-finite or over-large vector.
      if (vector.length === 0 || vector.length > MAX_VECTOR_DIMENSIONS) return
      if (!vector.every((v) => Number.isFinite(v))) return
      col(collection).set(id, { vector: normalize(vector), metadata: metadata ?? {} })
    },
    async query({ collection, vector, limit, filter }): Promise<VectorResult> {
      const m = store.get(collection)
      if (!m || m.size === 0) return { hits: [] }
      if (vector.length === 0 || vector.length > MAX_VECTOR_DIMENSIONS) return { hits: [] }
      // Reject non-finite query vectors (NaN/Infinity components) — mirrors the upsert
      // guard so a bad embedding can't produce NaN scores across the whole store.
      if (!vector.every((v) => Number.isFinite(v))) return { hits: [] }
      const q = normalize(vector)
      const k = Math.max(1, limit)
      const scored: { id: string; score: number }[] = []
      for (const [id, entry] of m) {
        if (filter && !matchesFilter(entry.metadata, filter)) continue
        scored.push({ id, score: dot(q, entry.vector) })
      }
      scored.sort((a, b) => b.score - a.score)
      return { hits: scored.slice(0, k) }
    },
    async list({ collection, limit }): Promise<VectorEntry[]> {
      const m = store.get(collection)
      if (!m || m.size === 0) return []
      // Bounded snapshot: cap the number of entries materialized so a huge collection
      // can't be pulled into memory wholesale (core also caps the dedup scan). The
      // vectors are returned as defensive copies so a caller can't mutate the store.
      const cap = Math.max(0, Math.floor(limit))
      const out: VectorEntry[] = []
      for (const [id, entry] of m) {
        if (out.length >= cap) break
        out.push({ id, vector: entry.vector.slice(), metadata: { ...entry.metadata } })
      }
      return out
    },
    async remove({ collection, id }): Promise<void> {
      store.get(collection)?.delete(id)
    },
    async clear(collection?: string): Promise<void> {
      if (collection) store.delete(collection)
      else store.clear()
    },
  }
}

/**
 * Build the metadata-enriched text that gets embedded for a document. Research shows
 * prepending the collection name and labelling each field ("posts | Title: … | Body:
 * …") materially raises retrieval accuracy over a bare field concatenation, because
 * the embedding captures *what kind of thing* the text describes, not just its words.
 * Field VALUES are read server-side from the full doc (same as full-text indexing).
 */
export function enrichedEmbeddingText(collection: CollectionConfig, fields: string[], doc: Doc): string {
  const allowed = new Set(fields)
  const parts: string[] = []
  for (const field of effectiveFields(collection.fields)) {
    if (!allowed.has(field.name)) continue
    const text = extractSearchText(collection, [field.name], doc)
    if (text.length === 0) continue
    parts.push(`${fieldLabel(field)}: ${text}`)
  }
  const label = collection.labels?.plural ?? collection.slug
  return `${label} | ${parts.join(' | ')}`.trim()
}

/**
 * Attach semantic index-sync hooks to collections whose `search.semantic` is on, when
 * embeddings + a vector adapter are configured. On create/update it builds the
 * metadata-enriched text, embeds it, and upserts the vector REAL-TIME (the same write
 * hook as full-text); on delete it removes the vector. Resilient by contract: an
 * `embed` failure is logged and swallowed so it can NEVER break the content write.
 * Never logs the embedding text, the vector, or any provider error detail (which
 * could carry an API key) — only the collection/id and a generic message.
 */
export function attachSemantic(
  collections: CollectionConfig[],
  vector: VectorAdapter,
  embed: EmbedFn,
  semanticFields: Readonly<Record<string, string[]>>,
  logger: Logger,
): void {
  for (const collection of collections) {
    const fields = semanticFields[collection.slug]
    if (!fields || fields.length === 0) continue
    const slug = collection.slug
    const hooks = (collection.hooks ??= {})

    const onChange = async (args: { doc: Doc }): Promise<Doc> => {
      try {
        const text = enrichedEmbeddingText(collection, fields, args.doc)
        const [vec] = await embed([text])
        if (vec && vec.length > 0) {
          await vector.upsert({ collection: slug, id: args.doc.id, vector: vec })
        }
      } catch {
        // Never surface provider error detail (may contain a key). Log id only.
        logger.warn(`semantic index failed for ${slug}/${args.doc.id}`)
      }
      return args.doc
    }
    hooks.afterChange = [...(hooks.afterChange ?? []), onChange as never]

    const onDelete = async (args: { id: string }): Promise<void> => {
      try {
        await vector.remove({ collection: slug, id: args.id })
      } catch {
        logger.warn(`semantic remove failed for ${slug}/${args.id}`)
      }
    }
    hooks.afterDelete = [...(hooks.afterDelete ?? []), onDelete as never]
  }
}

/**
 * Reciprocal Rank Fusion. Combines several ranked id-lists into one ranking by
 * summing 1/(k + rank) across the lists a given id appears in (rank is 0-based;
 * k=60 is the standard constant that damps the contribution of low-ranked hits).
 * An id ranked highly in EITHER signal floats up; an id present in BOTH outranks
 * one present in only one — which is exactly the hybrid-search property we want.
 */
export function reciprocalRankFusion(rankedLists: string[][], k = 60): { id: string; score: number }[] {
  const scores = new Map<string, number>()
  for (const list of rankedLists) {
    for (let rank = 0; rank < list.length; rank++) {
      const id = list[rank]!
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank))
    }
  }
  return [...scores.entries()].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score)
}
