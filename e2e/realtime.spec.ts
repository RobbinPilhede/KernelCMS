import { test, expect } from '@playwright/test'

// In-practice test of the real-time change feed against the LIVE server: create
// and update content over real HTTP, then pull the durable change feed and assert
// the ordered, metadata-only change events appear.

const AUTH = { Authorization: 'Bearer e2e-key', 'content-type': 'application/json' }

test('the change feed records create + update as ordered, metadata-only events', async ({ request }) => {
  // Snapshot the current cursor so we only assert on events from this test.
  const before = await request.get('/api/changes?since=0&limit=1000', { headers: AUTH })
  expect(before.ok()).toBeTruthy()
  const startCursor = (await before.json()).cursor ?? 0

  const create = await request.post('/api/articles', {
    headers: AUTH,
    data: { title: 'Realtime article', _status: 'published' },
  })
  expect(create.ok()).toBeTruthy()
  const id = (await create.json()).id

  await request.patch(`/api/articles/${id}`, { headers: AUTH, data: { title: 'Realtime article (edited)' } })

  // Pull changes since our start cursor.
  const feed = await request.get(`/api/changes?since=${startCursor}&limit=100`, { headers: AUTH })
  expect(feed.ok()).toBeTruthy()
  const body = await feed.json()
  const mine = body.changes.filter((c: { documentId: string }) => c.documentId === id)

  // At least a create and an update event, in seq order.
  expect(mine.length).toBeGreaterThanOrEqual(2)
  expect(mine[0].collection).toBe('articles')
  expect(mine.map((c: { event: string }) => c.event)).toContain('create')
  const seqs = mine.map((c: { seq: number }) => c.seq)
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b))

  // Metadata-only: the event must NOT carry the document body/title.
  expect(JSON.stringify(mine)).not.toContain('Realtime article')
  // cursor advances past our events.
  expect(body.cursor).toBeGreaterThan(startCursor)
})

test('the change feed requires authentication', async ({ request }) => {
  const res = await request.get('/api/changes?since=0')
  expect(res.status()).toBeGreaterThanOrEqual(401)
  expect(res.status()).toBeLessThan(404)
})
