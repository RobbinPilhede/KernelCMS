/**
 * Content intelligence — the PURE math behind "related content" (more-like-this) and
 * near-duplicate detection, built on the same vector store that backs semantic search.
 *
 * The access-checked ops live in `kernel.ts` (they reuse `loadAccessChecked` + the
 * embed path); this module owns only the side-effect-free pieces — threshold/limit
 * clamping and the bounded O(n²) pairwise scan — so they can be unit-tested in
 * isolation. Nothing here touches the database, the network, or access control.
 */
import { dot } from './vector'
import type { VectorEntry } from '@kernel/db'

/** Hard cap on documents a single duplicate scan will compare. The scan is O(n²), so
 *  this bounds it at ~`MAX_DEDUP_DOCS²/2` similarity computations — a DoS brake against
 *  running dedup over an unbounded collection. The vector adapter's `list` is asked for
 *  at most this many entries. */
export const MAX_DEDUP_DOCS = 2000

/** Default cosine-similarity threshold above which two documents are "near-duplicates".
 *  0.9 is high enough that only substantially overlapping content pairs up. */
export const DEFAULT_DUPLICATE_THRESHOLD = 0.9

/** Hard cap on returned duplicate pairs — bounds the response even when a collection is
 *  full of near-identical rows (e.g. a scraped import). */
export const MAX_DEDUP_PAIRS = 100
/** Over-fetch cap: how many candidate pairs to compute BEFORE the access filter, so the
 *  post-filter result can still fill up to `limit` readable pairs in a mixed-visibility
 *  collection (bounded — the pair array is already small thanks to the threshold). */
export const MAX_CANDIDATE_PAIRS = 2000

/** A near-duplicate pair: two distinct document ids and their cosine similarity. */
export interface DuplicatePair {
  a: string
  b: string
  score: number
}

/**
 * Clamp a caller-supplied threshold into the valid cosine band [0, 1]. A NaN / non-numeric
 * value falls back to the default; values outside the band are pulled to the nearest edge
 * (a request for 1.5 becomes 1, for -3 becomes 0). Never throws — the caller's intent is
 * honoured as closely as the math allows.
 */
export function clampThreshold(threshold: number | undefined): number {
  const n = Number(threshold)
  if (!Number.isFinite(n)) return DEFAULT_DUPLICATE_THRESHOLD
  return Math.min(1, Math.max(0, n))
}

/** Clamp the max number of returned pairs to a finite [1, MAX_DEDUP_PAIRS]. */
export function clampPairLimit(limit: number | undefined): number {
  const n = Math.floor(Number(limit ?? MAX_DEDUP_PAIRS))
  if (!Number.isFinite(n)) return MAX_DEDUP_PAIRS
  return Math.min(Math.max(1, n), MAX_DEDUP_PAIRS)
}

/**
 * Find every pair of entries whose cosine similarity is ≥ `threshold`, highest score
 * first, capped at `limit` pairs. The store hands back unit-normalized vectors, so a
 * single `dot` IS the cosine similarity; mismatched-length vectors score 0 (incomparable)
 * and are naturally excluded. Self-pairs are impossible (j starts at i+1) and each
 * unordered pair is emitted once. O(n²) over `entries.length` — bound the input slice
 * before calling (see `MAX_DEDUP_DOCS`).
 */
export function findDuplicatePairs(entries: VectorEntry[], threshold: number, limit: number): DuplicatePair[] {
  const pairs: DuplicatePair[] = []
  for (let i = 0; i < entries.length; i++) {
    const a = entries[i]!
    for (let j = i + 1; j < entries.length; j++) {
      const b = entries[j]!
      const score = dot(a.vector, b.vector)
      if (score >= threshold) pairs.push({ a: a.id, b: b.id, score })
    }
  }
  pairs.sort((p, q) => q.score - p.score)
  return pairs.slice(0, Math.max(0, limit))
}

/**
 * Keep only the pairs whose BOTH ids are readable by the caller. `readable` is the set of
 * ids that survived an access-checked load; a pair touching even one unreadable doc is
 * dropped entirely — so duplicate detection can never be used to infer the existence (or
 * the id) of content the caller is not allowed to see.
 */
export function filterReadablePairs(pairs: DuplicatePair[], readable: ReadonlySet<string>): DuplicatePair[] {
  return pairs.filter((p) => readable.has(p.a) && readable.has(p.b))
}
