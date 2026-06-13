import { test, expect } from '@playwright/test'

// In-practice test of content releases against the LIVE server: stage a draft into
// a named release and publish the bundle atomically over the real admin routes.

const AUTH = { Authorization: 'Bearer e2e-key', 'content-type': 'application/json' }

test('a release publishes its staged drafts atomically over the live server', async ({ request }) => {
  // A draft article to stage.
  const draft = await request.post('/api/articles', { headers: AUTH, data: { title: 'Launch post', _status: 'draft' } })
  expect(draft.ok()).toBeTruthy()
  const docId = (await draft.json()).id

  // Create a release.
  const create = await request.post('/api/_admin/releases', { headers: AUTH, data: { name: 'Spring launch' } })
  expect(create.ok()).toBeTruthy()
  const release = await create.json()
  const releaseId = release.id ?? release.release?.id
  expect(releaseId).toBeTruthy()

  // Add the draft as a member.
  const add = await request.post(`/api/_admin/releases/${releaseId}/items`, {
    headers: AUTH,
    data: { collection: 'articles', id: docId },
  })
  expect(add.ok()).toBeTruthy()

  // The draft is still a draft before publishing the release.
  const before = await request.get(`/api/articles/${docId}?draft=true`, { headers: AUTH })
  expect((await before.json())._status).toBe('draft')

  // Publish the release.
  const pub = await request.post(`/api/_admin/releases/${releaseId}/publish`, { headers: AUTH, data: {} })
  expect(pub.ok()).toBeTruthy()
  const result = await pub.json()
  expect(result.status ?? result.release?.status).toBe('published')

  // The member is now live.
  const after = await request.get(`/api/articles/${docId}?draft=true`, { headers: AUTH })
  expect((await after.json())._status).toBe('published')
})

test('release routes reject an unauthenticated caller', async ({ request }) => {
  const res = await request.post('/api/_admin/releases', { data: { name: 'nope' } })
  expect(res.status()).toBeGreaterThanOrEqual(401)
  expect(res.status()).toBeLessThan(404)
})
