import { test, expect, type APIRequestContext } from '@playwright/test'

// In-practice test of the per-document activity timeline against the LIVE server. The feed
// merges versions + comments (any reader) and reviews + audit (reviewers only), gated on the
// document's read access. The service key is an admin (reviewer/override); a plain user is a
// non-reviewer.

const SVC = { Authorization: 'Bearer e2e-key', 'content-type': 'application/json' }

async function userToken(request: APIRequestContext): Promise<string> {
  const email = `act-${Date.now()}-${Math.round(Math.random() * 1e6)}@t.test`
  const create = await request.post('/api/users', {
    headers: SVC,
    data: { email, password: 'supersecret123', roles: ['user'] },
  })
  expect(create.ok()).toBeTruthy()
  const login = await request.post('/api/users/login', {
    headers: { 'content-type': 'application/json' },
    data: { email, password: 'supersecret123' },
  })
  expect(login.ok()).toBeTruthy()
  return (await login.json()).token
}

test('the activity feed merges versions + comments + audit for a reviewer, newest-first', async ({ request }) => {
  // Seed an article (create + update produce version + audit events) and a comment.
  const article = await (await request.post('/api/articles', { headers: SVC, data: { title: 'v1' } })).json()
  await request.patch(`/api/articles/${article.id}`, { headers: SVC, data: { title: 'v2' } })
  await request.post(`/api/articles/${article.id}/comments`, { headers: SVC, data: { body: 'nice' } })

  const res = await request.get(`/api/articles/${article.id}/activity`, { headers: SVC })
  expect(res.ok()).toBeTruthy()
  const { events, includesReviewerEvents } = await res.json()
  expect(includesReviewerEvents).toBe(true)
  const types = new Set(events.map((e: { type: string }) => e.type))
  expect(types.has('version')).toBeTruthy()
  expect(types.has('comment')).toBeTruthy()
  expect(types.has('audit')).toBeTruthy()
  // Newest-first.
  for (let i = 0; i + 1 < events.length; i++) expect(events[i].at >= events[i + 1].at).toBeTruthy()
})

test('a non-reviewer reader sees only version + comment events (no audit/review leak)', async ({ request }) => {
  const article = await (await request.post('/api/articles', { headers: SVC, data: { title: 'public' } })).json()
  await request.post(`/api/articles/${article.id}/comments`, { headers: SVC, data: { body: 'hello' } })

  const token = await userToken(request)
  const asUser = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const res = await request.get(`/api/articles/${article.id}/activity`, { headers: asUser })
  expect(res.ok()).toBeTruthy()
  const { events, includesReviewerEvents } = await res.json()
  expect(includesReviewerEvents).toBe(false)
  const types = new Set(events.map((e: { type: string }) => e.type))
  expect(types.has('comment')).toBeTruthy()
  expect(types.has('audit')).toBeFalsy()
  expect(types.has('review')).toBeFalsy()
})

test('the activity feed filters by type', async ({ request }) => {
  const article = await (await request.post('/api/articles', { headers: SVC, data: { title: 'filter' } })).json()
  await request.post(`/api/articles/${article.id}/comments`, { headers: SVC, data: { body: 'just comments' } })

  const res = await request.get(`/api/articles/${article.id}/activity?types=comment`, { headers: SVC })
  const { events } = await res.json()
  expect(events.length).toBeGreaterThanOrEqual(1)
  expect(events.every((e: { type: string }) => e.type === 'comment')).toBeTruthy()
})
