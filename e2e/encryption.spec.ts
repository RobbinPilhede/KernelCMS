import { test, expect, type APIRequestContext } from '@playwright/test'

// In-practice test of field-level encryption at rest against the LIVE server. `vault_items`
// has two `encrypted` fields (`secret` text, `meta` json): they round-trip transparently over
// the API (decrypted on read) but can't be filtered on (opaque ciphertext). The ciphertext-at-
// rest property is covered by verify/encryption.ts (raw-row inspection); over HTTP we verify
// the transparent round-trip and the filter rejection.

const SVC = { Authorization: 'Bearer e2e-key', 'content-type': 'application/json' }

async function userToken(request: APIRequestContext): Promise<string> {
  const email = `enc-${Date.now()}-${Math.round(Math.random() * 1e6)}@t.test`
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

test('an encrypted field round-trips transparently over the API', async ({ request }) => {
  const token = await userToken(request)
  const asUser = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }

  const created = await request.post('/api/vault_items', {
    headers: asUser,
    data: { label: 'Ada keys', secret: 'hunter2-the-real-secret', meta: { rotation: 90, tags: ['prod', 'db'] } },
  })
  expect(created.ok()).toBeTruthy()
  const doc = await created.json()
  // The response carries the DECRYPTED value (encryption is transparent to the API caller).
  expect(doc.secret).toBe('hunter2-the-real-secret')
  expect(doc.meta).toEqual({ rotation: 90, tags: ['prod', 'db'] })

  // Re-reading also decrypts.
  const read = await request.get(`/api/vault_items/${doc.id}`, { headers: asUser })
  const reread = await read.json()
  expect(reread.secret).toBe('hunter2-the-real-secret')
  expect(reread.meta.rotation).toBe(90)
})

test('an encrypted field cannot be filtered on (opaque ciphertext)', async ({ request }) => {
  const token = await userToken(request)
  const asUser = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  await request.post('/api/vault_items', {
    headers: asUser,
    data: { label: 'x', secret: 'find-me-if-you-can' },
  })

  // Filtering on the encrypted `secret` field is rejected — you can't query ciphertext.
  const res = await request.get('/api/vault_items?where[secret][equals]=find-me-if-you-can', { headers: asUser })
  expect(res.status()).toBeGreaterThanOrEqual(400)
  expect(res.status()).toBeLessThan(500)

  // The plaintext `label` field is still filterable.
  const ok = await request.get('/api/vault_items?where[label][equals]=x', { headers: asUser })
  expect(ok.ok()).toBeTruthy()
})
