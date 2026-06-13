import { test, expect } from '@playwright/test'

// In-practice test of personalization + A/B against the LIVE server: write
// audience-targeted variants of a field, read each variant back via ?audience=,
// and confirm deterministic experiment bucketing — all over real HTTP.

const AUTH = { Authorization: 'Bearer e2e-key', 'content-type': 'application/json' }

test('audience-targeted field variants resolve per ?audience= over the live server', async ({ request }) => {
  // Create with the default-segment tagline.
  const create = await request.post('/api/articles?audience=default', {
    headers: AUTH,
    data: { title: 'Personalized article', tagline: 'For everyone', _status: 'published' },
  })
  expect(create.ok()).toBeTruthy()
  const id = (await create.json()).id

  // Write the vip-segment variant of the same field (merges, doesn't clobber default).
  const patch = await request.patch(`/api/articles/${id}?audience=vip`, {
    headers: AUTH,
    data: { tagline: 'For VIPs only' },
  })
  expect(patch.ok()).toBeTruthy()

  // Read each audience back.
  const vip = await request.get(`/api/articles/${id}?audience=vip`, { headers: AUTH })
  expect((await vip.json()).tagline).toBe('For VIPs only')

  const def = await request.get(`/api/articles/${id}?audience=default`, { headers: AUTH })
  expect((await def.json()).tagline).toBe('For everyone')

  // An unknown audience falls back to the default segment.
  const unknown = await request.get(`/api/articles/${id}?audience=zzz`, { headers: AUTH })
  expect((await unknown.json()).tagline).toBe('For everyone')
})

test('experiment assignment is deterministic per visitor key over the live server', async ({ request }) => {
  const a = await request.get('/api/_experiments/hero/assign?key=visitor-abc')
  expect(a.ok()).toBeTruthy()
  const first = (await a.json()).variant
  expect(['default', 'vip']).toContain(first)

  // Same key → same variant (sticky).
  const b = await request.get('/api/_experiments/hero/assign?key=visitor-abc')
  expect((await b.json()).variant).toBe(first)
})
