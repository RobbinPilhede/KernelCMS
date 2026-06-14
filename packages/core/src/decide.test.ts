import { afterEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { defineConfig, initKernel } from './index'
import type { Kernel } from './index'
import { fnv1a32, resolveAudienceSegment } from './personalization'

// `kernel.decide({ slug, viewerKey?, req?, overrideAccess? })` is a STATELESS delivery op: it
// looks up a configured decision by slug, fetches a bounded pool of PUBLISHED, access-checked
// candidates via the normal `find` path (so drafts / private rows / field-restricted content can
// NEVER be surfaced), narrows by the caller's resolved audience segment when `audienceField` is
// set (with a `fallback` of 'default' | 'any' | 'none'), and picks ONE document STICKILY from the
// pool: `idx = fnv1a32(`${slug}:${viewerKey}`) % pool.length`. The same viewerKey always lands on
// the same document. These tests pin every branch of that contract against a live kernel.

// A single human caller and an admin. Decisions read PUBLISHED content, so an anonymous (req-less)
// caller works whenever read access is public.
const admin = { user: { id: 'admin', roles: ['admin'] } } as any
const anon = undefined

const SECRET = 'decide-test-secret-32-characters!'

// A deterministic promo factory: a stable title derived from its segment + index so assertions can
// reason about which document was chosen without any random / time-dependent data.
const promo = (segment: string | string[], priority: number) => {
  const segments = Array.isArray(segment) ? segment : [segment]
  // `segment` is a hasMany select, so its value is ALWAYS an array (even for one target).
  return { title: `promo-${segments.join('+')}-${priority}`, segment: segments, priority }
}

/** Build a kernel with a `promos` collection and the supplied decisions/audiences. Reads are
 *  PUBLIC by default so an anonymous caller can decide; `versions.drafts` is opt-in per test. */
async function makeKernel(opts: {
  decisions: any[]
  audiences?: { segments: string[]; default: string }
  drafts?: boolean
  read?: (args: any) => unknown
}): Promise<Kernel> {
  const config = defineConfig({
    secret: SECRET,
    db: sqliteAdapter({ url: ':memory:' }),
    ...(opts.audiences ? { audiences: opts.audiences } : {}),
    decisions: opts.decisions,
    collections: [
      {
        slug: 'promos',
        ...(opts.drafts ? { versions: { drafts: true } } : {}),
        access: {
          // `read` may return a Where filter (owner-scoped) or a boolean — cast like the existing
          // test fixtures, since an inline-typed access fn would over-narrow the union.
          read: (opts.read ?? (() => true)) as any,
          create: () => true,
          update: () => true,
        },
        fields: [
          { name: 'title', type: 'text' },
          { name: 'owner', type: 'text' },
          { name: 'priority', type: 'number' },
          // A hasMany select doubles as the audience field — a candidate can target many segments.
          { name: 'segment', type: 'select', hasMany: true, options: ['default', 'vip', 'beta'] },
        ],
      },
    ],
  })
  const kernel = await initKernel(config, { logLevel: 'error' })
  await kernel.migrate()
  return kernel
}

let kernel: Kernel
afterEach(async () => {
  if (kernel) await kernel.destroy()
})

describe('kernel.decide — unknown / empty slots yield null', () => {
  it('returns null for an unconfigured slug', async () => {
    kernel = await makeKernel({ decisions: [{ slug: 'hero', collection: 'promos' }] })
    await kernel.create({ collection: 'promos', data: promo('default', 1), req: admin })
    expect(await kernel.decide({ slug: 'not-a-slot', req: anon })).toBeNull()
  })

  it('returns null when the collection has no candidates', async () => {
    kernel = await makeKernel({ decisions: [{ slug: 'hero', collection: 'promos' }] })
    expect(await kernel.decide({ slug: 'hero', req: anon })).toBeNull()
  })
})

describe('kernel.decide — selection without an audience field', () => {
  it("a single published doc is chosen with reason 'single'", async () => {
    kernel = await makeKernel({ decisions: [{ slug: 'hero', collection: 'promos' }] })
    const only = await kernel.create({ collection: 'promos', data: promo('default', 1), req: admin })

    const result = await kernel.decide({ slug: 'hero', viewerKey: 'v1', req: anon })
    expect(result).not.toBeNull()
    expect(result!.reason).toBe('single')
    expect(result!.chosenId).toBe(String(only.id))
    expect(result!.candidateIds).toEqual([String(only.id)])
    expect(result!.collection).toBe('promos')
  })

  it('honors the configured sort within the candidate pool', async () => {
    kernel = await makeKernel({ decisions: [{ slug: 'hero', collection: 'promos', sort: '-priority' }] })
    const low = await kernel.create({ collection: 'promos', data: promo('default', 1), req: admin })
    const high = await kernel.create({ collection: 'promos', data: promo('default', 9), req: admin })
    const mid = await kernel.create({ collection: 'promos', data: promo('default', 5), req: admin })

    const result = await kernel.decide({ slug: 'hero', viewerKey: 'v1', req: anon })
    expect(result).not.toBeNull()
    // candidateIds reflect the configured descending-priority sort, not insertion order.
    expect(result!.candidateIds).toEqual([String(high.id), String(mid.id), String(low.id)])
  })
})

describe('kernel.decide — audience narrowing', () => {
  const audiences = { segments: ['default', 'vip', 'beta'], default: 'default' }

  it("narrows to the matching segment with reason 'audience-match'", async () => {
    kernel = await makeKernel({
      audiences,
      decisions: [{ slug: 'hero', collection: 'promos', audienceField: 'segment' }],
    })
    const def = await kernel.create({ collection: 'promos', data: promo('default', 1), req: admin })
    const vip = await kernel.create({ collection: 'promos', data: promo('vip', 1), req: admin })

    const result = await kernel.decide({ slug: 'hero', viewerKey: 'v1', req: { audience: 'vip' } as any })
    expect(result).not.toBeNull()
    expect(result!.reason).toBe('audience-match')
    expect(result!.audience).toBe('vip')
    expect(result!.candidateIds).toEqual([String(vip.id)])
    expect(result!.chosenId).toBe(String(vip.id))
    // The default-segment promo is never in a vip-targeted pool.
    expect(result!.candidateIds).not.toContain(String(def.id))
  })

  it("a hasMany-select target (['default','vip']) matches BOTH segments", async () => {
    kernel = await makeKernel({
      audiences,
      decisions: [{ slug: 'hero', collection: 'promos', audienceField: 'segment' }],
    })
    const both = await kernel.create({ collection: 'promos', data: promo(['default', 'vip'], 1), req: admin })

    const asDefault = await kernel.decide({ slug: 'hero', viewerKey: 'v1', req: { audience: 'default' } as any })
    const asVip = await kernel.decide({ slug: 'hero', viewerKey: 'v1', req: { audience: 'vip' } as any })

    expect(asDefault!.reason).toBe('audience-match')
    expect(asDefault!.chosenId).toBe(String(both.id))
    expect(asVip!.reason).toBe('audience-match')
    expect(asVip!.chosenId).toBe(String(both.id))
  })

  it("fallback 'default' falls to default-segment docs with reason 'audience-fallback'", async () => {
    kernel = await makeKernel({
      audiences,
      decisions: [{ slug: 'hero', collection: 'promos', audienceField: 'segment', fallback: 'default' }],
    })
    const def = await kernel.create({ collection: 'promos', data: promo('default', 1), req: admin })
    await kernel.create({ collection: 'promos', data: promo('vip', 1), req: admin })

    // 'beta' has no targeted candidate → fall to the default segment.
    const result = await kernel.decide({ slug: 'hero', viewerKey: 'v1', req: { audience: 'beta' } as any })
    expect(result).not.toBeNull()
    expect(result!.reason).toBe('audience-fallback')
    expect(result!.audience).toBe('beta')
    expect(result!.candidateIds).toEqual([String(def.id)])
    expect(result!.chosenId).toBe(String(def.id))
  })

  it("fallback 'any' considers all docs with reason 'audience-fallback'", async () => {
    kernel = await makeKernel({
      audiences,
      decisions: [{ slug: 'hero', collection: 'promos', audienceField: 'segment', fallback: 'any' }],
    })
    const def = await kernel.create({ collection: 'promos', data: promo('default', 1), req: admin })
    const vip = await kernel.create({ collection: 'promos', data: promo('vip', 1), req: admin })

    const result = await kernel.decide({ slug: 'hero', viewerKey: 'v1', req: { audience: 'beta' } as any })
    expect(result).not.toBeNull()
    expect(result!.reason).toBe('audience-fallback')
    // No 'beta' target, so the whole pool is in play.
    expect(result!.candidateIds.sort()).toEqual([String(def.id), String(vip.id)].sort())
  })

  it("fallback 'none' returns null when no candidate targets the segment", async () => {
    kernel = await makeKernel({
      audiences,
      decisions: [{ slug: 'hero', collection: 'promos', audienceField: 'segment', fallback: 'none' }],
    })
    await kernel.create({ collection: 'promos', data: promo('default', 1), req: admin })
    await kernel.create({ collection: 'promos', data: promo('vip', 1), req: admin })

    expect(await kernel.decide({ slug: 'hero', viewerKey: 'v1', req: { audience: 'beta' } as any })).toBeNull()
  })

  it('an unknown / hostile audience resolves to the default segment (no throw)', async () => {
    kernel = await makeKernel({
      audiences,
      decisions: [{ slug: 'hero', collection: 'promos', audienceField: 'segment', fallback: 'default' }],
    })
    const def = await kernel.create({ collection: 'promos', data: promo('default', 1), req: admin })
    await kernel.create({ collection: 'promos', data: promo('vip', 1), req: admin })

    // Both a prototype-pollution vector and a plain unknown value collapse to 'default'.
    for (const hostile of ['__proto__', 'bogus']) {
      const result = await kernel.decide({ slug: 'hero', viewerKey: 'v1', req: { audience: hostile } as any })
      expect(result).not.toBeNull()
      expect(result!.audience).toBe('default')
      // Cross-check against the shared pure resolver — the same definition decide uses.
      expect(resolveAudienceSegment({ enabled: true, segments: audiences.segments, default: 'default' }, hostile)).toBe(
        'default',
      )
      // A 'default'-resolved audience matches the default promo directly (no fallback needed).
      expect(result!.reason).toBe('audience-match')
      expect(result!.chosenId).toBe(String(def.id))
    }
  })
})

describe('kernel.decide — stickiness', () => {
  it('the same viewerKey lands on the same pooled document across calls', async () => {
    kernel = await makeKernel({ decisions: [{ slug: 'hero', collection: 'promos', sort: '-priority' }] })
    const ids = new Set<string>()
    for (let i = 0; i < 5; i++) {
      const p = await kernel.create({ collection: 'promos', data: promo('default', i), req: admin })
      ids.add(String(p.id))
    }

    const first = await kernel.decide({ slug: 'hero', viewerKey: 'sticky-viewer', req: anon })
    const second = await kernel.decide({ slug: 'hero', viewerKey: 'sticky-viewer', req: anon })

    expect(first).not.toBeNull()
    expect(second!.chosenId).toBe(first!.chosenId)
    // The pick is always a member of the candidate pool...
    expect(first!.candidateIds).toContain(first!.chosenId)
    expect(ids.has(first!.chosenId)).toBe(true)
    // ...and matches the documented sticky formula exactly.
    const expectedIdx = fnv1a32(`hero:sticky-viewer`) % first!.candidateIds.length
    expect(first!.chosenId).toBe(first!.candidateIds[expectedIdx])
  })
})

describe('kernel.decide — published-only (no draft leak)', () => {
  it('a DRAFT candidate is never chosen and never in candidateIds, even as the top sort match', async () => {
    kernel = await makeKernel({
      audiences: { segments: ['default', 'vip', 'beta'], default: 'default' },
      drafts: true,
      decisions: [{ slug: 'hero', collection: 'promos', sort: '-priority', audienceField: 'segment' }],
    })
    // A DRAFT vip promo with the HIGHEST priority — it would win on sort + audience, but it is
    // never published, so it must be invisible to the decision.
    await kernel.create({ collection: 'promos', data: promo('vip', 999), req: admin })
    // A PUBLISHED vip promo (lower priority).
    const live = await kernel.create({ collection: 'promos', data: promo('vip', 1), req: admin })
    const published = await kernel.publish({ collection: 'promos', id: live.id, req: admin })
    expect(published?._status).toBe('published')

    const result = await kernel.decide({ slug: 'hero', viewerKey: 'v1', req: { audience: 'vip' } as any })
    expect(result).not.toBeNull()
    expect(result!.candidateIds).toEqual([String(live.id)])
    expect(result!.chosenId).toBe(String(live.id))
  })
})

describe('kernel.decide — access-checked (non-public collection yields no decision)', () => {
  it('a read:()=>false collection never surfaces a decision (access enforced, no leak)', async () => {
    kernel = await makeKernel({
      decisions: [{ slug: 'hero', collection: 'promos' }],
      read: () => false,
    })
    // Seeded with overrideAccess so the row exists despite the closed read rule.
    await kernel.create({ collection: 'promos', data: promo('default', 1), req: admin, overrideAccess: true } as any)

    // A hard-closed read rule is enforced at the find layer — the caller is refused, so the
    // published row can never leak through the decision.
    await expect(kernel.decide({ slug: 'hero', req: anon })).rejects.toThrow(/forbidden|not allowed/i)
  })

  it('an owner-scoped read excludes a non-owner caller → null', async () => {
    const ownerRead = ({ req }: any) => {
      if (req?.user?.roles?.includes('admin')) return true
      return { owner: { equals: req?.user?.id ?? '__none__' } }
    }
    kernel = await makeKernel({
      decisions: [{ slug: 'hero', collection: 'promos' }],
      read: ownerRead,
    })
    await kernel.create({ collection: 'promos', data: { ...promo('default', 1), owner: 'someone-else' }, req: admin })

    // Anonymous (no user) fails the owner scope → no candidate qualifies → null.
    expect(await kernel.decide({ slug: 'hero', req: anon })).toBeNull()
  })
})
