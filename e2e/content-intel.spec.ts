import { test, expect } from '@playwright/test'

// In-practice test of content intelligence against the LIVE server: seed two
// near-identical articles, then confirm related-content surfaces one from the
// other, and duplicate-detection flags the pair — all over real HTTP.

const AUTH = { Authorization: 'Bearer e2e-key', 'content-type': 'application/json' }
const TEXT = 'quantum entanglement superposition qubit decoherence intel'

test('related content + duplicate detection over the live server', async ({ request }) => {
  const a = await request.post('/api/articles', {
    headers: AUTH,
    data: { title: 'Intel dup A', summary: TEXT, _status: 'published' },
  })
  const aId = (await a.json()).id
  const b = await request.post('/api/articles', {
    headers: AUTH,
    data: { title: 'Intel dup B', summary: TEXT, _status: 'published' },
  })
  const bId = (await b.json()).id

  // Related: from A, the near-identical B should surface (and not A itself).
  const related = await request.get(`/api/articles/${aId}/related?limit=5`, { headers: AUTH })
  expect(related.ok()).toBeTruthy()
  const relatedIds = (await related.json()).docs.map((d: { id: string }) => d.id)
  expect(relatedIds).not.toContain(aId)
  expect(relatedIds).toContain(bId)

  // Duplicates: the A/B pair appears with a high score.
  const dups = await request.get('/api/_admin/duplicates?collection=articles&threshold=0.9&limit=50', { headers: AUTH })
  expect(dups.ok()).toBeTruthy()
  const pairs = (await dups.json()).pairs
  const mine = pairs.find((p: { a: string; b: string }) => (p.a === aId && p.b === bId) || (p.a === bId && p.b === aId))
  expect(mine, 'A/B flagged as a duplicate pair').toBeTruthy()
  expect(mine.score).toBeGreaterThanOrEqual(0.9)
})

test('duplicate detection is admin-gated', async ({ request }) => {
  const res = await request.get('/api/_admin/duplicates?collection=articles')
  expect(res.status()).toBeGreaterThanOrEqual(401)
  expect(res.status()).toBeLessThan(404)
})
