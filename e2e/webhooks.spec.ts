import { test, expect, type APIRequestContext } from '@playwright/test'

// In-practice test of durable outbound webhooks against the LIVE server. The e2e config
// declares one DURABLE webhook (`demo_sink`) on the `articles` collection. The drain
// (`processWebhooks`) is a trusted cron-only op with no HTTP trigger by design — so the
// HTTP-observable surface here is: a content write ENQUEUES a delivery into the outbox,
// the admin can read the redacted config + the delivery log, and requeue a delivery. The
// real end-to-end POST + retry/backoff is covered by verify/webhooks.ts (a live sink).

const SVC = { Authorization: 'Bearer e2e-key', 'content-type': 'application/json' }

async function userToken(request: APIRequestContext, roles: string[] = ['user']): Promise<string> {
  const email = `wh-${Date.now()}-${Math.round(Math.random() * 1e6)}@t.test`
  const create = await request.post('/api/users', { headers: SVC, data: { email, password: 'supersecret123', roles } })
  expect(create.ok()).toBeTruthy()
  const login = await request.post('/api/users/login', {
    headers: { 'content-type': 'application/json' },
    data: { email, password: 'supersecret123' },
  })
  expect(login.ok()).toBeTruthy()
  return (await login.json()).token
}

test('the admin webhook config is listed redacted (no secret)', async ({ request }) => {
  // The service key is an admin override.
  const res = await request.get('/api/_admin/webhooks', { headers: SVC })
  expect(res.ok()).toBeTruthy()
  const { webhooks } = await res.json()
  const sink = webhooks.find((w: { slug: string }) => w.slug === 'demo_sink')
  expect(sink).toBeTruthy()
  expect(sink.durable).toBe(true)
  expect(sink.signed).toBe(true) // has a secret…
  // …but the secret and any custom headers are NEVER returned.
  expect(JSON.stringify(sink)).not.toContain('demo-webhook-secret')
  expect(sink.secret).toBeUndefined()
  expect(sink.headers).toBeUndefined()
})

test('a content write enqueues a durable delivery that the admin can read and requeue', async ({ request }) => {
  // Write an article -> the durable webhook enqueues a `pending` delivery.
  const article = await (await request.post('/api/articles', { headers: SVC, data: { title: 'Webhook me' } })).json()

  // The delivery shows up in the admin log, tied to that document and webhook.
  const log = await request.get(`/api/_admin/webhooks/deliveries?webhook=demo_sink`, { headers: SVC })
  expect(log.ok()).toBeTruthy()
  const { docs } = await log.json()
  const delivery = docs.find((d: { documentId: string }) => d.documentId === article.id)
  expect(delivery).toBeTruthy()
  expect(delivery.webhook).toBe('demo_sink')
  expect(delivery.event).toBe('create')
  expect(['pending', 'failed']).toContain(delivery.status)

  // Filtering by status works.
  const pending = await request.get('/api/_admin/webhooks/deliveries?status=pending', { headers: SVC })
  expect(pending.ok()).toBeTruthy()

  // Requeue the delivery -> it's reset to pending, due now.
  const retry = await request.post(`/api/_admin/webhooks/deliveries/${delivery.id}/retry`, { headers: SVC, data: {} })
  expect(retry.ok()).toBeTruthy()
  const requeued = await retry.json()
  expect(requeued.status).toBe('pending')
  expect(requeued.id).toBe(delivery.id)
})

test('the webhook admin surface is admin-only (anonymous 401, non-admin forbidden)', async ({ request }) => {
  // Anonymous FIRST, before any login sets a session cookie on this request context.
  const anon = await request.get('/api/_admin/webhooks')
  expect(anon.status()).toBe(401)

  // A plain authenticated user is not an admin -> Forbidden.
  const token = await userToken(request, ['user'])
  const asUser = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const list = await request.get('/api/_admin/webhooks', { headers: asUser })
  expect(list.status()).toBeGreaterThanOrEqual(403)
  const deliveries = await request.get('/api/_admin/webhooks/deliveries', { headers: asUser })
  expect(deliveries.status()).toBeGreaterThanOrEqual(403)
})
