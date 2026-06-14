import { describe, expect, it } from 'vitest'
import type { VectorEntry } from '@kernel/db'
import {
  clampPairLimit,
  clampThreshold,
  DEFAULT_DUPLICATE_THRESHOLD,
  filterReadablePairs,
  findDuplicatePairs,
  MAX_DEDUP_PAIRS,
} from './content-intel'

/** Build a VectorEntry from a raw (un-normalized) vector. `findDuplicatePairs` compares with
 *  a bare dot product, so vectors must be unit-length for the dot to equal cosine — the store
 *  normalizes on upsert; here we hand it pre-normalized vectors. */
function entry(id: string, vector: number[]): VectorEntry {
  return { id, vector, metadata: {} }
}

describe('clampThreshold', () => {
  it('passes a valid in-band value through', () => {
    expect(clampThreshold(0.85)).toBe(0.85)
  })

  it('pulls an above-1 value down to 1', () => {
    expect(clampThreshold(1.5)).toBe(1)
  })

  it('pulls a negative value up to 0', () => {
    expect(clampThreshold(-3)).toBe(0)
  })

  it('falls back to the default for NaN / non-numeric', () => {
    expect(clampThreshold(Number.NaN)).toBe(DEFAULT_DUPLICATE_THRESHOLD)
    expect(clampThreshold(undefined)).toBe(DEFAULT_DUPLICATE_THRESHOLD)
  })
})

describe('clampPairLimit', () => {
  it('clamps a huge value to the max', () => {
    expect(clampPairLimit(10_000)).toBe(MAX_DEDUP_PAIRS)
  })

  it('floors to at least 1', () => {
    expect(clampPairLimit(0)).toBe(1)
    expect(clampPairLimit(-5)).toBe(1)
  })

  it('falls back to the max for NaN', () => {
    expect(clampPairLimit(Number.NaN)).toBe(MAX_DEDUP_PAIRS)
  })
})

describe('findDuplicatePairs', () => {
  it('returns a near-identical pair above the threshold', () => {
    const entries = [
      entry('a', [1, 0, 0]),
      entry('b', [0.9999, 0.0141, 0]), // ~0.9999 cosine with a
      entry('c', [0, 1, 0]), // orthogonal to both
    ]
    const pairs = findDuplicatePairs(entries, 0.95, 10)
    expect(pairs).toHaveLength(1)
    expect(pairs[0]!.a).toBe('a')
    expect(pairs[0]!.b).toBe('b')
    expect(pairs[0]!.score).toBeGreaterThanOrEqual(0.95)
  })

  it('drops the pair when the threshold is raised past their similarity', () => {
    const entries = [entry('a', [1, 0, 0]), entry('b', [0.9999, 0.0141, 0])]
    expect(findDuplicatePairs(entries, 0.99, 10)).toHaveLength(1)
    expect(findDuplicatePairs(entries, 0.99999, 10)).toHaveLength(0)
  })

  it('never pairs a document with itself', () => {
    const entries = [entry('a', [1, 0, 0]), entry('a2', [1, 0, 0])]
    const pairs = findDuplicatePairs(entries, 0.5, 10)
    expect(pairs.every((p) => p.a !== p.b)).toBe(true)
  })

  it('emits each unordered pair exactly once', () => {
    const entries = [entry('a', [1, 0, 0]), entry('b', [1, 0, 0]), entry('c', [1, 0, 0])]
    // 3 identical vectors -> C(3,2) = 3 pairs, no duplicates / reverses.
    const pairs = findDuplicatePairs(entries, 0.5, 100)
    expect(pairs).toHaveLength(3)
  })

  it('orders pairs by descending score', () => {
    const entries = [entry('a', [1, 0, 0]), entry('b', [1, 0, 0]), entry('c', [0.96, 0.28, 0])]
    const pairs = findDuplicatePairs(entries, 0.9, 100)
    for (let i = 1; i < pairs.length; i++) {
      expect(pairs[i - 1]!.score).toBeGreaterThanOrEqual(pairs[i]!.score)
    }
  })

  it('caps the number of returned pairs at the limit', () => {
    const entries = Array.from({ length: 6 }, (_, i) => entry(`d${i}`, [1, 0, 0]))
    // C(6,2) = 15 candidate pairs; limit caps the output.
    const pairs = findDuplicatePairs(entries, 0.5, 4)
    expect(pairs).toHaveLength(4)
  })

  it('treats mismatched-length vectors as incomparable (score 0, excluded)', () => {
    const entries = [entry('a', [1, 0, 0]), entry('b', [1, 0])]
    expect(findDuplicatePairs(entries, 0.5, 10)).toHaveLength(0)
  })
})

describe('filterReadablePairs', () => {
  it('keeps a pair only when BOTH ids are readable', () => {
    const pairs = [
      { a: 'a', b: 'b', score: 0.99 },
      { a: 'a', b: 'secret', score: 0.98 },
      { a: 'secret', b: 'b', score: 0.97 },
    ]
    const readable = new Set(['a', 'b'])
    const kept = filterReadablePairs(pairs, readable)
    expect(kept).toHaveLength(1)
    expect(kept[0]!).toEqual({ a: 'a', b: 'b', score: 0.99 })
  })

  it('drops every pair when nothing is readable', () => {
    const pairs = [{ a: 'a', b: 'b', score: 0.99 }]
    expect(filterReadablePairs(pairs, new Set())).toHaveLength(0)
  })
})
