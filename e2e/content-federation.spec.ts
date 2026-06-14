import { test, expect, type APIRequestContext } from '@playwright/test'

// In-practice test of content federation against the LIVE server. The service key is admin.
// Export an article bundle, dry-run a sync (no writes), then sync it (idempotent: re-applying
// the same bundle reports `unchanged`). Within one environment a re-sync of an unchanged
// bundle is a no-op — proving the deterministic upsert + dry-run + access-only-admin surface.

const SVC = { Authorization: 'Bearer e2e-key', 'content-type': 'application/json' }

test('export a content bundle, dry-run, then sync (idempotent) over the live server', async ({ request }) => {
  // Seed two articles.
  const a1 = await (await request.post('/api/articles', { headers: SVC, data: { title: 'Fed One' } })).json()
  const a2 = await (await request.post('/api/articles', { headers: SVC, data: { title: 'Fed Two' } })).json()

  // Export just those two by id → a portable bundle with stable ids.
  const exp = await request.get(`/api/_admin/federation/export?collection=articles&draft=true&ids=${a1.id},${a2.id}`, {
    headers: SVC,
  })
  expect(exp.ok()).toBeTruthy()
  const bundle = await exp.json()
  expect(bundle.version).toBe(1)
  expect(bundle.documents.map((d: { id: string }) => d.id).sort()).toEqual([a1.id, a2.id].sort())

  // Dry-run a sync of the SAME bundle into this env: both already exist + are identical → the
  // plan is all `unchanged`, and nothing is written.
  const dry = await request.post('/api/_admin/federation/sync', { headers: SVC, data: { bundle, dryRun: true } })
  expect(dry.ok()).toBeTruthy()
  const dryRes = await dry.json()
  expect(dryRes.dryRun).toBe(true)
  expect(dryRes.unchanged).toBe(2)
  expect(dryRes.plan.every((p: { action: string }) => p.action === 'unchanged')).toBeTruthy()

  // Real sync of the unchanged bundle is a no-op (idempotent).
  const sync = await request.post('/api/_admin/federation/sync', { headers: SVC, data: { bundle } })
  const syncRes = await sync.json()
  expect(syncRes.unchanged).toBe(2)
  expect(syncRes.created).toBe(0)
  expect(syncRes.updated).toBe(0)
})

test('content federation is admin-only (a plain user is forbidden, anonymous 401)', async ({ request }) => {
  // Anonymous first (cookie-free context).
  const anon = await request.get('/api/_admin/federation/export?collection=articles')
  expect(anon.status()).toBe(401)

  const email = `fed-${Date.now()}@t.test`
  await request.post('/api/users', { headers: SVC, data: { email, password: 'supersecret123', roles: ['user'] } })
  const login = await request.post('/api/users/login', {
    headers: { 'content-type': 'application/json' },
    data: { email, password: 'supersecret123' },
  })
  const token = (await login.json()).token
  const res = await request.get('/api/_admin/federation/export?collection=articles', {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(res.status()).toBeGreaterThanOrEqual(403)
})
