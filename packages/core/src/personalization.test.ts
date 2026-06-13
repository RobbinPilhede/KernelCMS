import { describe, expect, it } from 'vitest'
import {
  bucketVariant,
  isSafeSegmentKey,
  resolvePersonalized,
  segmentMapCopy,
  serializeDoc,
  deserializeDoc,
} from './index'
import type { BucketExperiment } from './index'
import type { ConfigField } from './index'

// Personalized fields are stored as `{ [segment]: value }` JSON maps — the personalization
// parallel of localized fields. These tests pin down the resolve/fallback chain, the
// merge-no-clobber write, the deterministic bucketing + distribution, and the
// segment-key guards against prototype pollution.

describe('resolvePersonalized (fallback chain)', () => {
  const raw = { default: 'Hello', vip: 'Hello VIP' }

  it('resolves the requested segment when present', () => {
    expect(resolvePersonalized(raw, { segment: 'vip', defaultSegment: 'default' })).toBe('Hello VIP')
  })

  it('falls back to the default segment when the requested one is missing', () => {
    expect(resolvePersonalized(raw, { segment: 'beta', defaultSegment: 'default' })).toBe('Hello')
  })

  it('returns null when neither the segment nor the default has a value', () => {
    expect(resolvePersonalized({ vip: 'x' }, { segment: 'beta', defaultSegment: 'default' })).toBeNull()
  })

  it('returns a non-object raw value as-is (legacy/non-personalized storage)', () => {
    expect(resolvePersonalized('plain', { segment: 'vip', defaultSegment: 'default' })).toBe('plain')
  })

  it('never reads through a prototype-pollution segment key', () => {
    expect(resolvePersonalized(raw, { segment: '__proto__', defaultSegment: 'default' })).toBe('Hello')
    expect(resolvePersonalized(raw, { segment: 'vip', defaultSegment: '__proto__' })).toBe('Hello VIP')
  })
})

describe('segmentMapCopy', () => {
  it('returns a defensive copy that excludes pollution keys', () => {
    const copy = segmentMapCopy({ default: 'a', vip: 'b' })
    copy.default = 'mutated'
    expect(segmentMapCopy({ default: 'a' }).default).toBe('a')
  })

  it('drops forbidden keys from the copy', () => {
    const copy = segmentMapCopy(JSON.parse('{"default":"a","__proto__":"x"}'))
    expect(Object.prototype.hasOwnProperty.call(copy, '__proto__')).toBe(false)
    expect(copy.default).toBe('a')
  })
})

describe('isSafeSegmentKey', () => {
  it('rejects prototype-pollution keys', () => {
    expect(isSafeSegmentKey('__proto__')).toBe(false)
    expect(isSafeSegmentKey('constructor')).toBe(false)
    expect(isSafeSegmentKey('prototype')).toBe(false)
  })

  it('accepts normal segment ids', () => {
    expect(isSafeSegmentKey('vip')).toBe(true)
    expect(isSafeSegmentKey('default')).toBe(true)
  })
})

describe('serializeDoc — personalized merge (no clobber)', () => {
  const fields: ConfigField[] = [
    { name: 'headline', type: 'text', personalized: true },
    { name: 'slug', type: 'text' },
  ]

  it('writes a value into the target segment without touching other segments', () => {
    const existing = { headline: { default: 'Default headline', vip: 'VIP headline' } }
    const row = serializeDoc(
      fields,
      { headline: 'Beta headline' },
      { locale: 'en', segment: 'beta', existingRow: existing },
    )
    expect(row.headline).toEqual({ default: 'Default headline', vip: 'VIP headline', beta: 'Beta headline' })
  })

  it('overwrites only the written segment on a re-write', () => {
    const existing = { headline: { default: 'A', vip: 'B' } }
    const row = serializeDoc(fields, { headline: 'B2' }, { locale: 'en', segment: 'vip', existingRow: existing })
    expect(row.headline).toEqual({ default: 'A', vip: 'B2' })
  })

  it('preserves the existing map when the field is absent from the write', () => {
    const existing = { headline: { default: 'A' } }
    const row = serializeDoc(fields, { slug: 'p' }, { locale: 'en', segment: 'vip', existingRow: existing })
    expect(row.headline).toEqual({ default: 'A' })
  })

  it('never writes through a prototype-pollution segment key', () => {
    const row = serializeDoc(fields, { headline: 'x' }, { locale: 'en', segment: '__proto__' })
    expect(row.headline).toEqual({})
  })
})

describe('deserializeDoc — personalized resolve', () => {
  const fields: ConfigField[] = [{ name: 'headline', type: 'text', personalized: true }]
  const row = { headline: { default: 'Default', vip: 'VIP' } }

  it('resolves to the active segment', () => {
    const doc = deserializeDoc(fields, row, {
      locale: 'en',
      fallbackLocale: false,
      segment: 'vip',
      defaultSegment: 'default',
    })
    expect(doc.headline).toBe('VIP')
  })

  it('falls back to the default segment for an unknown-value segment', () => {
    const doc = deserializeDoc(fields, row, {
      locale: 'en',
      fallbackLocale: false,
      segment: 'beta',
      defaultSegment: 'default',
    })
    expect(doc.headline).toBe('Default')
  })

  it('returns the full map under allLocales', () => {
    const doc = deserializeDoc(fields, row, {
      locale: 'all',
      fallbackLocale: false,
      allLocales: true,
      segment: 'vip',
      defaultSegment: 'default',
    })
    expect(doc.headline).toEqual({ default: 'Default', vip: 'VIP' })
  })
})

describe('bucketVariant — deterministic A/B bucketing', () => {
  const experiment: BucketExperiment = {
    slug: 'hero_test',
    variants: ['default', 'vip'],
    weights: [1, 1],
    seed: 'hero_test',
  }

  it('is sticky: the same key always maps to the same variant', () => {
    const first = bucketVariant(experiment, 'visitor-123')
    for (let i = 0; i < 50; i++) {
      expect(bucketVariant(experiment, 'visitor-123')).toBe(first)
    }
  })

  it('only ever returns a configured variant', () => {
    for (let i = 0; i < 200; i++) {
      expect(experiment.variants).toContain(bucketVariant(experiment, `k-${i}`))
    }
  })

  it('distributes roughly evenly over many keys with equal weights', () => {
    let vip = 0
    const n = 2000
    for (let i = 0; i < n; i++) {
      if (bucketVariant(experiment, `visitor-${i}`) === 'vip') vip++
    }
    const ratio = vip / n
    expect(ratio).toBeGreaterThan(0.4)
    expect(ratio).toBeLessThan(0.6)
  })

  it('respects skewed weights (90/10)', () => {
    const skewed: BucketExperiment = { slug: 'skew', variants: ['a', 'b'], weights: [9, 1], seed: 'skew' }
    let b = 0
    const n = 2000
    for (let i = 0; i < n; i++) {
      if (bucketVariant(skewed, `v-${i}`) === 'b') b++
    }
    const ratio = b / n
    expect(ratio).toBeGreaterThan(0.05)
    expect(ratio).toBeLessThan(0.16)
  })

  it('a different seed reshuffles assignments', () => {
    const a: BucketExperiment = { ...experiment, seed: 'seed-a' }
    const b: BucketExperiment = { ...experiment, seed: 'seed-b' }
    let differ = 0
    for (let i = 0; i < 200; i++) {
      if (bucketVariant(a, `k-${i}`) !== bucketVariant(b, `k-${i}`)) differ++
    }
    expect(differ).toBeGreaterThan(0)
  })
})
