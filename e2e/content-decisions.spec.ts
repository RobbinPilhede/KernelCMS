import { test, expect } from '@playwright/test'

// In-practice test of content DECISIONS against the LIVE server. The `hero_promo` decision picks
// the best PUBLISHED promo for the caller's audience (`?audience=`), highest priority first, with
// a sticky per-viewer choice (`?viewer=`). Published-only + access-checked: a draft promo is never
// chosen, and an unknown audience collapses to the default segment.

const SVC = { Authorization: 'Bearer e2e-key', 'content-type': 'application/json' }

// Seed once: two published default-segment promos, one published vip promo, one DRAFT vip promo.
let defaultA = ''
let defaultB = ''
let vipPublished = ''
let vipDraft = ''

test.beforeAll(async ({ request }) => {
  const mk = async (data: Record<string, unknown>) =>
    (await (await request.post('/api/promos', { headers: SVC, data })).json()).id as string
  defaultA = await mk({ label: 'Default Hero A', segment: 'default', priority: 2, _status: 'published' })
  defaultB = await mk({ label: 'Default Hero B', segment: 'default', priority: 1, _status: 'published' })
  vipPublished = await mk({ label: 'VIP Hero', segment: 'vip', priority: 5, _status: 'published' })
  vipDraft = await mk({ label: 'Draft VIP', segment: 'vip', priority: 9, _status: 'draft' })
})

test('picks a published promo for the matching audience (never a draft)', async ({ request }) => {
  const res = await request.get('/api/_decide/hero_promo?audience=vip&viewer=u1')
  expect(res.ok()).toBeTruthy()
  const d = await res.json()
  expect(d.slug).toBe('hero_promo')
  expect(d.audience).toBe('vip')
  expect(d.reason).toBe('audience-match')
  expect(d.chosenId).toBe(vipPublished) // the published vip promo…
  expect(d.chosenId).not.toBe(vipDraft) // …never the higher-priority DRAFT
  expect(d.candidateIds).toEqual([vipPublished]) // the draft isn't even a candidate
  expect(d.document.label).toBe('VIP Hero')
})

test('the decision is STICKY per viewer (same viewer → same document)', async ({ request }) => {
  const first = await (await request.get('/api/_decide/hero_promo?audience=default&viewer=sticky-1')).json()
  const second = await (await request.get('/api/_decide/hero_promo?audience=default&viewer=sticky-1')).json()
  expect(first.reason).toBe('audience-match')
  expect([defaultA, defaultB]).toContain(first.chosenId)
  expect(second.chosenId).toBe(first.chosenId) // sticky across requests
})

test('an unknown audience collapses to the default segment (no injection)', async ({ request }) => {
  const d = await (await request.get('/api/_decide/hero_promo?audience=__proto__&viewer=u9')).json()
  expect(d.audience).toBe('default') // hostile/unknown segment → default, never honored as a key
  expect([defaultA, defaultB]).toContain(d.chosenId)
})

test('an unknown decision slug is a clean 404', async ({ request }) => {
  const res = await request.get('/api/_decide/no_such_decision?viewer=u1')
  expect(res.status()).toBe(404)
})

test('a decision response is per-viewer and never shared-cached', async ({ request }) => {
  const res = await request.get('/api/_decide/hero_promo?audience=vip&viewer=u1')
  expect(res.headers()['cache-control']).toContain('no-store')
})
