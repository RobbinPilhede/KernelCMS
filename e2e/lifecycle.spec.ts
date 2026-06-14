import { test, expect, type APIRequestContext } from '@playwright/test'

// In-practice test of content lifecycle against the LIVE server. The expiry drain
// is a trusted cron-only operation (no HTTP trigger by design), so the
// HTTP-reachable property we verify here is that the server-managed `_archived_at`
// marker is client-IMMUTABLE for a NORMAL (non-override) user — no fake-archive or
// un-archive over the API. (The drain behaviour is covered by verify/lifecycle.ts;
// the trusted service key intentionally CAN write it, so we use a plain user.)

const SVC = { Authorization: 'Bearer e2e-key', 'content-type': 'application/json' }

async function userToken(request: APIRequestContext): Promise<string> {
  const email = `lc-${Date.now()}@t.test`
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

test('a normal user can set expire_at but never the server-managed _archived_at', async ({ request }) => {
  const token = await userToken(request)
  const asUser = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }

  // expire_at is an ordinary editor field; _archived_at on create is stripped.
  const create = await request.post('/api/articles', {
    headers: asUser,
    data: {
      title: 'Expiring article',
      expire_at: '2030-01-01T00:00:00.000Z',
      _archived_at: '2020-01-01T00:00:00.000Z',
    },
  })
  expect(create.ok()).toBeTruthy()
  const doc = await create.json()
  expect(doc.expire_at).toContain('2030')
  expect(doc._archived_at ?? null).toBeNull()

  // Setting _archived_at on update is also stripped (no fake-archive over the API).
  await request.patch(`/api/articles/${doc.id}`, {
    headers: asUser,
    data: { _archived_at: '2020-01-01T00:00:00.000Z' },
  })
  const read = await request.get(`/api/articles/${doc.id}?draft=true`, { headers: asUser })
  expect((await read.json())._archived_at ?? null).toBeNull()
})
