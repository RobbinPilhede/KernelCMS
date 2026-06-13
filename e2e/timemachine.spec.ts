import { test, expect } from '@playwright/test'

// In-practice test of the content time-machine against the LIVE server: create
// and edit an article (building version history), then reconstruct its past state
// via ?asOf= and read its change timeline via /history — all over real HTTP.

const AUTH = { Authorization: 'Bearer e2e-key', 'content-type': 'application/json' }

test('asOf reconstructs a past state and /history lists the change timeline', async ({ request }) => {
  // t0: create published.
  const create = await request.post('/api/articles', {
    headers: AUTH,
    data: { title: 'Original title', _status: 'published' },
  })
  expect(create.ok()).toBeTruthy()
  const id = (await create.json()).id

  // t1: edit the title (a new version is recorded).
  const update = await request.patch(`/api/articles/${id}`, { headers: AUTH, data: { title: 'Updated title' } })
  expect(update.ok()).toBeTruthy()

  // History: the change timeline, oldest → newest, with field-level changedFields.
  const hist = await request.get(`/api/articles/${id}/history`, { headers: AUTH })
  expect(hist.ok()).toBeTruthy()
  const entries = await hist.json()
  expect(Array.isArray(entries)).toBeTruthy()
  expect(entries.length).toBeGreaterThanOrEqual(2)
  // The latest entry changed the title.
  const latest = entries[entries.length - 1]
  expect(latest.changedFields).toContain('title')

  // The live doc shows the updated title.
  const live = await request.get(`/api/articles/${id}`, { headers: AUTH })
  expect((await live.json()).title).toBe('Updated title')

  // Time-travel: reconstruct the doc as of the FIRST history entry's timestamp.
  const t0 = entries[0].at
  const past = await request.get(`/api/articles/${id}?asOf=${encodeURIComponent(t0)}`, { headers: AUTH })
  expect(past.ok()).toBeTruthy()
  expect((await past.json()).title).toBe('Original title')
})

test('asOf before a document existed returns not-found', async ({ request }) => {
  const create = await request.post('/api/articles', {
    headers: AUTH,
    data: { title: 'Future doc', _status: 'published' },
  })
  const id = (await create.json()).id
  // A timestamp well before creation → the doc did not exist yet.
  const past = await request.get(`/api/articles/${id}?asOf=2000-01-01T00:00:00.000Z`, { headers: AUTH })
  expect(past.status()).toBe(404)
})
