import { describe, expect, it } from 'vitest'
import { cosineSimilarity, dot, memoryVector, reciprocalRankFusion, enrichedEmbeddingText } from './vector'
import type { CollectionConfig, Doc } from './types'

describe('cosine similarity', () => {
  it('is 1 for identical direction regardless of magnitude', () => {
    expect(cosineSimilarity([1, 0, 0], [3, 0, 0])).toBeCloseTo(1, 6)
  })

  it('is 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6)
  })

  it('is -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 1], [-1, -1])).toBeCloseTo(-1, 6)
  })

  it('scores a zero vector as 0 against anything (no NaN)', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0)
  })

  it('scores mismatched-length vectors as 0', () => {
    expect(dot([1, 2], [1, 2, 3])).toBe(0)
  })
})

describe('memoryVector store', () => {
  it('ranks the nearest vector first and respects top-K', async () => {
    const store = memoryVector()
    await store.upsert({ collection: 'c', id: 'a', vector: [1, 0, 0] })
    await store.upsert({ collection: 'c', id: 'b', vector: [0.9, 0.1, 0] })
    await store.upsert({ collection: 'c', id: 'c', vector: [0, 1, 0] })
    const { hits } = await store.query({ collection: 'c', vector: [1, 0, 0], limit: 2 })
    expect(hits.map((h) => h.id)).toEqual(['a', 'b'])
    expect(hits).toHaveLength(2)
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score)
  })

  it('upsert replaces a prior vector for the same id', async () => {
    const store = memoryVector()
    await store.upsert({ collection: 'c', id: 'a', vector: [1, 0] })
    await store.upsert({ collection: 'c', id: 'a', vector: [0, 1] })
    const near = await store.query({ collection: 'c', vector: [0, 1], limit: 1 })
    expect(near.hits[0]!.score).toBeCloseTo(1, 6)
  })

  it('remove drops a vector from results', async () => {
    const store = memoryVector()
    await store.upsert({ collection: 'c', id: 'a', vector: [1, 0] })
    await store.remove({ collection: 'c', id: 'a' })
    const { hits } = await store.query({ collection: 'c', vector: [1, 0], limit: 5 })
    expect(hits).toHaveLength(0)
  })

  it('clear(collection) empties only that collection', async () => {
    const store = memoryVector()
    await store.upsert({ collection: 'a', id: '1', vector: [1, 0] })
    await store.upsert({ collection: 'b', id: '1', vector: [1, 0] })
    await store.clear('a')
    expect((await store.query({ collection: 'a', vector: [1, 0], limit: 5 })).hits).toHaveLength(0)
    expect((await store.query({ collection: 'b', vector: [1, 0], limit: 5 })).hits).toHaveLength(1)
  })

  it('applies an exact-match metadata filter', async () => {
    const store = memoryVector()
    await store.upsert({ collection: 'c', id: 'pub', vector: [1, 0], metadata: { status: 'published' } })
    await store.upsert({ collection: 'c', id: 'draft', vector: [1, 0], metadata: { status: 'draft' } })
    const { hits } = await store.query({ collection: 'c', vector: [1, 0], limit: 5, filter: { status: 'published' } })
    expect(hits.map((h) => h.id)).toEqual(['pub'])
  })

  it('ignores an over-dimensional or empty vector instead of storing it', async () => {
    const store = memoryVector()
    await store.upsert({ collection: 'c', id: 'empty', vector: [] })
    await store.upsert({ collection: 'c', id: 'nan', vector: [Number.NaN, 1] })
    const { hits } = await store.query({ collection: 'c', vector: [1, 0], limit: 5 })
    expect(hits).toHaveLength(0)
  })
})

describe('reciprocal rank fusion', () => {
  it('ranks an id present in both lists above one present in only one', () => {
    const fulltext = ['x', 'y'] // x is keyword-only top hit
    const semantic = ['z', 'y'] // z is semantic-only top hit; y is in both
    const fused = reciprocalRankFusion([fulltext, semantic])
    // y appears in both lists -> highest fused score.
    expect(fused[0]!.id).toBe('y')
    // x and z each appear once at rank 0 -> equal score, both below y.
    const yScore = fused.find((f) => f.id === 'y')!.score
    const xScore = fused.find((f) => f.id === 'x')!.score
    expect(yScore).toBeGreaterThan(xScore)
  })

  it('uses k to damp lower ranks (1/(k+rank))', () => {
    const fused = reciprocalRankFusion([['a', 'b', 'c']], 60)
    expect(fused[0]!.score).toBeCloseTo(1 / 60, 9)
    expect(fused[1]!.score).toBeCloseTo(1 / 61, 9)
    expect(fused[2]!.score).toBeCloseTo(1 / 62, 9)
  })

  it('surfaces a keyword-only and a semantic-only hit together', () => {
    const fused = reciprocalRankFusion([['kw'], ['sem']])
    const ids = fused.map((f) => f.id)
    expect(ids).toContain('kw')
    expect(ids).toContain('sem')
  })
})

describe('enrichedEmbeddingText', () => {
  const collection: CollectionConfig = {
    slug: 'articles',
    labels: { plural: 'Articles' },
    fields: [
      { name: 'title', type: 'text' },
      { name: 'body', type: 'text' },
    ],
  }

  it('prepends the collection label and labels each field', () => {
    const doc: Doc = { id: '1', title: 'Brewing coffee', body: 'a pour-over guide' }
    const text = enrichedEmbeddingText(collection, ['title', 'body'], doc)
    expect(text).toBe('Articles | Title: Brewing coffee | Body: a pour-over guide')
  })

  it('skips empty fields but keeps the label prefix', () => {
    const doc: Doc = { id: '1', title: 'Only a title', body: '' }
    const text = enrichedEmbeddingText(collection, ['title', 'body'], doc)
    expect(text).toBe('Articles | Title: Only a title')
  })
})
