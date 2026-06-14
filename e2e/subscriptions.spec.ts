import { test, expect, type APIRequestContext } from '@playwright/test'

// In-practice test of saved-search alerts against the LIVE server. The drain (processSubscriptions)
// is a trusted cron-only op with no HTTP trigger (covered by verify/subscriptions.ts), so the
// HTTP-observable surface here is the owner-scoped admin CRUD: create / list / delete a
// subscription, owner isolation, and config validation.

const SVC = { Authorization: 'Bearer e2e-key', 'content-type': 'application/json' }

async function userToken(request: APIRequestContext): Promise<string> {
  const email = `sub-${Date.now()}-${Math.round(Math.random() * 1e6)}@t.test`
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

test('create, list, and delete a subscription over the live server (owner-scoped)', async ({ request }) => {
  const token = await userToken(request)
  const asUser = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }

  // Subscribe to articles where title contains "launch", delivered via the `alerts` webhook.
  const created = await request.post('/api/_admin/subscriptions', {
    headers: asUser,
    data: { collection: 'articles', where: { title: { like: 'launch' } }, webhook: 'alerts' },
  })
  expect(created.status()).toBe(201)
  const sub = await created.json()
  expect(sub.collection).toBe('articles')
  expect(sub.webhook).toBe('alerts')
  expect(sub.active).toBe(true)
  expect(sub.ownerId).toBeTruthy()

  // It appears in the owner's list.
  const list = await request.get('/api/_admin/subscriptions?collection=articles', { headers: asUser })
  expect((await list.json()).subscriptions.some((s: { id: string }) => s.id === sub.id)).toBeTruthy()

  // A DIFFERENT user does not see it, and cannot delete it.
  const otherToken = await userToken(request)
  const asOther = { Authorization: `Bearer ${otherToken}`, 'content-type': 'application/json' }
  expect(
    (await (await request.get('/api/_admin/subscriptions', { headers: asOther })).json()).subscriptions,
  ).toHaveLength(0)
  const otherDelete = await request.delete(`/api/_admin/subscriptions/${sub.id}`, { headers: asOther })
  expect(otherDelete.status()).toBeGreaterThanOrEqual(403)

  // The owner can delete it.
  const del = await request.delete(`/api/_admin/subscriptions/${sub.id}`, { headers: asUser })
  expect(del.ok()).toBeTruthy()
  const after = await request.get('/api/_admin/subscriptions', { headers: asUser })
  expect((await after.json()).subscriptions.some((s: { id: string }) => s.id === sub.id)).toBeFalsy()
})

test('subscribing to an unknown webhook is rejected; anonymous is 401', async ({ request }) => {
  // Anonymous first (no login cookie on this context yet).
  const anon = await request.get('/api/_admin/subscriptions')
  expect(anon.status()).toBe(401)

  const token = await userToken(request)
  const asUser = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const bad = await request.post('/api/_admin/subscriptions', {
    headers: asUser,
    data: { collection: 'articles', webhook: 'does-not-exist' },
  })
  expect(bad.status()).toBeGreaterThanOrEqual(400)
  expect(bad.status()).toBeLessThan(500)
})
