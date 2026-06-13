import { test, expect } from '@playwright/test'

// In-practice test of the AI-discoverability (GEO) feature against the LIVE server:
// seed a PUBLISHED and a DRAFT article over real HTTP, then hit the public
// /api/llms.txt, /api/llms-full.txt and /geo endpoints as an UNAUTHENTICATED
// caller and assert the published content is exposed while the draft never leaks.

const AUTH = { Authorization: 'Bearer e2e-key', 'content-type': 'application/json' }
const PUBLISHED = 'Published GEO article about widgets'
const DRAFT = 'Secret draft that must never leak'

test('llms.txt + geo expose published content but never drafts (unauthenticated)', async ({ request }) => {
  // Seed one published + one draft article via the service key.
  const pub = await request.post('/api/articles', {
    headers: AUTH,
    data: { title: PUBLISHED, summary: 'A public summary of widgets.', _status: 'published' },
  })
  expect(pub.ok()).toBeTruthy()
  const pubId = (await pub.json()).id
  const draft = await request.post('/api/articles', { headers: AUTH, data: { title: DRAFT, _status: 'draft' } })
  expect(draft.ok()).toBeTruthy()

  // /api/llms.txt — PUBLIC, no auth header. Lists the published article, not the draft.
  const llms = await request.get('/api/llms.txt')
  expect(llms.ok()).toBeTruthy()
  expect(llms.headers()['content-type']).toContain('text/plain')
  const llmsBody = await llms.text()
  expect(llmsBody).toContain(PUBLISHED)
  expect(llmsBody).not.toContain(DRAFT)

  // /api/llms-full.txt — full corpus, still published-only.
  const full = await request.get('/api/llms-full.txt')
  expect(full.ok()).toBeTruthy()
  const fullBody = await full.text()
  expect(fullBody).toContain(PUBLISHED)
  expect(fullBody).not.toContain(DRAFT)

  // /geo for the published doc → markdown with the title.
  const geo = await request.get(`/api/articles/${pubId}/geo`)
  expect(geo.ok()).toBeTruthy()
  expect(await geo.text()).toContain(PUBLISHED)
})

test('geo of a draft document is not exposed (404)', async ({ request }) => {
  const draft = await request.post('/api/articles', {
    headers: AUTH,
    data: { title: 'Another hidden draft', _status: 'draft' },
  })
  const id = (await draft.json()).id
  const geo = await request.get(`/api/articles/${id}/geo`)
  expect(geo.status()).toBe(404)
})
