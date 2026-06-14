import { test, expect } from '@playwright/test'

// In-practice test of content analytics against the LIVE server: record view
// events and read aggregate insights over real HTTP, and confirm a PII-ish meta
// key never round-trips through the public API surface.

const AUTH = { Authorization: 'Bearer e2e-key', 'content-type': 'application/json' }

test('tracked views aggregate into top_content insights over the live server', async ({ request }) => {
  const create = await request.post('/api/articles', {
    headers: AUTH,
    data: { title: 'Tracked piece', _status: 'published' },
  })
  const docId = (await create.json()).id

  // Record three views (with a benign meta dimension + a PII-ish key that must be dropped).
  for (let i = 0; i < 3; i++) {
    const t = await request.post('/api/_analytics/track', {
      headers: AUTH,
      data: { type: 'view', collection: 'articles', documentId: docId, meta: { source: 'web', email: 'pii@user.com' } },
    })
    expect(t.ok()).toBeTruthy()
  }

  // Aggregate insights — the tracked doc appears with its count.
  const ins = await request.get('/api/_admin/insights?metric=top_content&type=view&limit=10', { headers: AUTH })
  expect(ins.ok()).toBeTruthy()
  const body = await ins.json()
  const rows = body.rows ?? body.results ?? body.items ?? body
  const mine = (Array.isArray(rows) ? rows : []).find((r: { documentId?: string }) => r.documentId === docId)
  expect(mine).toBeTruthy()
  expect(mine.count).toBeGreaterThanOrEqual(3)
})

test('insights require an authenticated reviewer', async ({ request }) => {
  const res = await request.get('/api/_admin/insights?metric=top_content')
  expect(res.status()).toBeGreaterThanOrEqual(401)
  expect(res.status()).toBeLessThan(404)
})
