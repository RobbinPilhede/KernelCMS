import { describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { initKernel, type Kernel } from './index'
import {
  buildAnalyticsRow,
  clampAnalyticsRetain,
  clampInsightsLimit,
  isAnalyticsEventType,
  sanitizeMeta,
  DEFAULT_ANALYTICS_RETAIN,
  MAX_ANALYTICS_RETAIN,
  MIN_ANALYTICS_RETAIN,
} from './analytics'
import { ANALYTICS_TABLE } from './schema'

// ---------------------------------------------------------------------------
// Pure helpers — PII strip, meta guard, type validation, clamps
// ---------------------------------------------------------------------------

describe('sanitizeMeta — strips PII + prototype-pollution keys', () => {
  it('drops obvious PII-ish keys and keeps non-PII scalar dimensions', () => {
    const out = sanitizeMeta({
      userId: 'u-123',
      email: 'a@b.com',
      ip: '1.2.3.4',
      sessionToken: 'secret',
      source: 'rag',
      locale: 'en',
      position: 3,
      cited: true,
    })
    expect(out).toEqual({ source: 'rag', locale: 'en', position: 3, cited: true })
    expect(out).not.toHaveProperty('userId')
    expect(out).not.toHaveProperty('email')
    expect(out).not.toHaveProperty('ip')
    expect(out).not.toHaveProperty('sessionToken')
  })

  it('drops prototype-pollution keys and never pollutes Object.prototype', () => {
    const out = sanitizeMeta(JSON.parse('{"__proto__":{"polluted":true},"constructor":1,"source":"ok"}'))
    expect(out).toEqual({ source: 'ok' })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.prototype).not.toHaveProperty('polluted')
  })

  it('drops non-scalar values so a nested object cannot smuggle PII', () => {
    const out = sanitizeMeta({ ok: 'yes', nested: { userId: 'u-1' }, arr: [1, 2], fn: () => 1 })
    expect(out).toEqual({ ok: 'yes' })
  })

  it('returns null when nothing safe remains, and for non-objects', () => {
    expect(sanitizeMeta({ userId: 'x', email: 'y' })).toBeNull()
    expect(sanitizeMeta(null)).toBeNull()
    expect(sanitizeMeta('string')).toBeNull()
    expect(sanitizeMeta([1, 2, 3])).toBeNull()
  })
})

describe('buildAnalyticsRow — validates type, clamps, and carries NO PII', () => {
  it('rejects an invalid event type', () => {
    expect(buildAnalyticsRow({ type: 'hack' as never })).toBeNull()
    expect(buildAnalyticsRow({ type: '' as never })).toBeNull()
  })

  it('builds a sanitized row for a valid type with only content metadata', () => {
    const row = buildAnalyticsRow({
      type: 'view',
      collection: 'posts',
      documentId: 'p1',
      query: '  pricing  ',
      value: 42,
      meta: { userId: 'leak', source: 'web' },
    })
    expect(row).toEqual({
      type: 'view',
      collection: 'posts',
      documentId: 'p1',
      query: 'pricing',
      experiment: null,
      variant: null,
      value: 42,
      meta: { source: 'web' },
    })
    // Crucially: there is no place for a principal id/token on the built row.
    expect(row).not.toHaveProperty('principalId')
    expect(row).not.toHaveProperty('userId')
  })

  it('nulls empty/whitespace strings and non-finite values', () => {
    const row = buildAnalyticsRow({ type: 'search', query: '   ', value: Number.NaN })
    expect(row?.query).toBeNull()
    expect(row?.value).toBeNull()
  })
})

describe('clamps + type guard', () => {
  it('clampAnalyticsRetain bounds into [MIN, MAX] with a default', () => {
    expect(clampAnalyticsRetain(undefined)).toBe(DEFAULT_ANALYTICS_RETAIN)
    expect(clampAnalyticsRetain(0)).toBe(MIN_ANALYTICS_RETAIN)
    expect(clampAnalyticsRetain(-5)).toBe(MIN_ANALYTICS_RETAIN)
    expect(clampAnalyticsRetain(99_999_999)).toBe(MAX_ANALYTICS_RETAIN)
    expect(clampAnalyticsRetain(Number.NaN)).toBe(DEFAULT_ANALYTICS_RETAIN)
    expect(clampAnalyticsRetain(500)).toBe(500)
  })

  it('clampInsightsLimit bounds into [1, MAX] with a default', () => {
    expect(clampInsightsLimit(undefined)).toBe(20)
    expect(clampInsightsLimit(0)).toBe(1)
    expect(clampInsightsLimit(10_000)).toBe(500)
    expect(clampInsightsLimit(50)).toBe(50)
  })

  it('isAnalyticsEventType accepts the closed set only', () => {
    expect(isAnalyticsEventType('ai_retrieval')).toBe(true)
    expect(isAnalyticsEventType('conversion')).toBe(true)
    expect(isAnalyticsEventType('nope')).toBe(false)
    expect(isAnalyticsEventType(7)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Integration — aggregate math + retention + resilience against a real kernel
// ---------------------------------------------------------------------------

const open = { read: () => true, create: () => true, update: () => true, delete: () => true }

function makeKernel(opts?: { retain?: number; autoCapture?: boolean }): Promise<Kernel> {
  return initKernel(
    {
      secret: 'analytics-test-secret-aaaaaaaaaaaa',
      db: sqliteAdapter({ url: ':memory:' }),
      analytics: {
        enabled: true,
        ...(opts?.retain !== undefined ? { retain: opts.retain } : {}),
        ...(opts?.autoCapture ? { autoCapture: true } : {}),
      },
      collections: [{ slug: 'posts', access: open, fields: [{ name: 'title', type: 'text' }] }],
    },
    { autoMigrate: true, logLevel: 'error' },
  )
}

describe('insights aggregate math', () => {
  it('top_content ranks the most-viewed document first with correct counts', async () => {
    const kernel = await makeKernel()
    for (let i = 0; i < 3; i++) await kernel.track({ type: 'view', collection: 'posts', documentId: 'a' })
    await kernel.track({ type: 'view', collection: 'posts', documentId: 'b' })
    const result = await kernel.insights({ metric: 'top_content', overrideAccess: true })
    expect(result.rows[0]).toEqual({ collection: 'posts', documentId: 'a', count: 3 })
    expect(result.rows[1]).toEqual({ collection: 'posts', documentId: 'b', count: 1 })
    await kernel.destroy()
  })

  it('top_queries counts search terms', async () => {
    const kernel = await makeKernel()
    await kernel.track({ type: 'search', query: 'pricing' })
    await kernel.track({ type: 'search', query: 'pricing' })
    await kernel.track({ type: 'search', query: 'docs' })
    const result = await kernel.insights({ metric: 'top_queries', overrideAccess: true })
    expect(result.rows[0]).toEqual({ query: 'pricing', count: 2 })
    await kernel.destroy()
  })

  it('variant_performance reports impressions, conversions, and rate', async () => {
    const kernel = await makeKernel()
    await kernel.track({ type: 'variant_impression', experiment: 'exp', variant: 'a' })
    await kernel.track({ type: 'variant_impression', experiment: 'exp', variant: 'a' })
    await kernel.track({ type: 'conversion', experiment: 'exp', variant: 'a' })
    const result = await kernel.insights({ metric: 'variant_performance', overrideAccess: true })
    expect(result.rows[0]).toEqual({ experiment: 'exp', variant: 'a', impressions: 2, conversions: 1, rate: 0.5 })
    await kernel.destroy()
  })

  it('ai_retrieval_leaderboard ranks only ai_retrieval events', async () => {
    const kernel = await makeKernel()
    await kernel.track({ type: 'view', collection: 'posts', documentId: 'a' })
    await kernel.track({ type: 'ai_retrieval', collection: 'posts', documentId: 'b' })
    await kernel.track({ type: 'ai_retrieval', collection: 'posts', documentId: 'b' })
    const result = await kernel.insights({ metric: 'ai_retrieval_leaderboard', overrideAccess: true })
    expect(result.rows).toEqual([{ collection: 'posts', documentId: 'b', count: 2 }])
    await kernel.destroy()
  })

  it('activity buckets events by UTC day with per-type counts', async () => {
    const kernel = await makeKernel()
    await kernel.track({ type: 'view', collection: 'posts', documentId: 'a' })
    await kernel.track({ type: 'search', query: 'x' })
    const result = await kernel.insights({ metric: 'activity', overrideAccess: true })
    expect(result.rows.length).toBe(1)
    const row = result.rows[0] as { bucket: string; count: number; byType: Record<string, number> }
    expect(row.count).toBe(2)
    expect(row.byType.view).toBe(1)
    expect(row.byType.search).toBe(1)
    await kernel.destroy()
  })
})

describe('privacy + safety against a real kernel', () => {
  it('a tracked meta with PII is stripped before it ever hits the table', async () => {
    const kernel = await makeKernel()
    await kernel.track({
      type: 'view',
      collection: 'posts',
      documentId: 'a',
      meta: JSON.parse('{"userId":"u1","email":"a@b.com","ip":"1.2.3.4","__proto__":{"x":1},"source":"rag"}'),
    })
    const rows = await kernel.db.find({ collection: ANALYTICS_TABLE, limit: 10, page: 1 })
    const meta = rows.docs[0]?.meta as Record<string, unknown>
    expect(meta).toEqual({ source: 'rag' })
    // No principal/PII column exists on the stored row at all.
    expect(rows.docs[0]).not.toHaveProperty('principalId')
    expect(rows.docs[0]).not.toHaveProperty('userId')
    expect(Object.prototype).not.toHaveProperty('x')
    await kernel.destroy()
  })

  it('track only ever writes _analytics — a collection value cannot redirect the write', async () => {
    const kernel = await makeKernel()
    const before = await kernel.count({ collection: 'posts', overrideAccess: true })
    await kernel.track({ type: 'view', collection: 'posts', documentId: 'a' })
    const after = await kernel.count({ collection: 'posts', overrideAccess: true })
    expect(after).toBe(before) // the posts collection was never written
    const analytics = await kernel.db.count({ collection: ANALYTICS_TABLE })
    expect(analytics).toBe(1)
    await kernel.destroy()
  })

  it('retention trims the oldest events to the configured cap', async () => {
    const kernel = await makeKernel({ retain: 3 })
    for (let i = 0; i < 6; i++) await kernel.track({ type: 'view', collection: 'posts', documentId: `d${i}` })
    const total = await kernel.db.count({ collection: ANALYTICS_TABLE })
    expect(total).toBe(3)
    // The survivors are the NEWEST three.
    const result = await kernel.insights({ metric: 'top_content', overrideAccess: true })
    const ids = result.rows.map((r) => (r as { documentId: string }).documentId).sort()
    expect(ids).toEqual(['d3', 'd4', 'd5'])
    await kernel.destroy()
  })

  it('an invalid event type is dropped without throwing', async () => {
    const kernel = await makeKernel()
    await expect(kernel.track({ type: 'totally-invalid' as never })).resolves.toBeUndefined()
    const total = await kernel.db.count({ collection: ANALYTICS_TABLE })
    expect(total).toBe(0)
    await kernel.destroy()
  })

  it('insights are empty when analytics is disabled', async () => {
    const kernel = await initKernel(
      {
        secret: 'analytics-test-secret-aaaaaaaaaaaa',
        db: sqliteAdapter({ url: ':memory:' }),
        collections: [{ slug: 'posts', access: open, fields: [{ name: 'title', type: 'text' }] }],
      },
      { autoMigrate: true, logLevel: 'error' },
    )
    await kernel.track({ type: 'view', collection: 'posts', documentId: 'a' }) // no-op
    const result = await kernel.insights({ metric: 'top_content' })
    expect(result.rows).toEqual([])
    await kernel.destroy()
  })
})
