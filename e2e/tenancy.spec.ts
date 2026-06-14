import { test, expect, type APIRequestContext } from '@playwright/test'

// In-practice test of multi-tenancy against the LIVE server: two authenticated
// users in different tenants must each see ONLY their own tenant's notes — over
// real HTTP, with the tenant resolved from the authenticated principal.

const SVC = { Authorization: 'Bearer e2e-key', 'content-type': 'application/json' }

async function makeTenantUser(request: APIRequestContext, email: string, tenant: string): Promise<string> {
  // Create the user (service key sets the tenant claim), then log in for a token.
  const create = await request.post('/api/users', {
    headers: SVC,
    data: { email, password: 'supersecret123', tenant, roles: ['user'] },
  })
  expect(create.ok(), `create ${email}`).toBeTruthy()
  const login = await request.post('/api/users/login', {
    headers: { 'content-type': 'application/json' },
    data: { email, password: 'supersecret123' },
  })
  expect(login.ok(), `login ${email}`).toBeTruthy()
  const token = (await login.json()).token
  expect(token, `token ${email}`).toBeTruthy()
  return token
}

test('each tenant sees only its own notes over the live server', async ({ request }) => {
  const acme = await makeTenantUser(request, `acme-${Date.now()}@t.test`, 'acme')
  const globex = await makeTenantUser(request, `globex-${Date.now()}@t.test`, 'globex')
  const asAcme = { Authorization: `Bearer ${acme}`, 'content-type': 'application/json' }
  const asGlobex = { Authorization: `Bearer ${globex}`, 'content-type': 'application/json' }

  // Each tenant creates a note (auto-stamped with their tenant; a spoofed tenant is overridden).
  const a = await request.post('/api/notes', { headers: asAcme, data: { body: 'acme secret note', tenant: 'globex' } })
  expect(a.ok()).toBeTruthy()
  await request.post('/api/notes', { headers: asGlobex, data: { body: 'globex secret note' } })

  // Acme sees only acme notes.
  const acmeList = await request.get('/api/notes', { headers: asAcme })
  const acmeBodies = (await acmeList.json()).docs.map((d: { body: string }) => d.body)
  expect(acmeBodies).toContain('acme secret note')
  expect(acmeBodies).not.toContain('globex secret note')

  // Globex sees only globex notes — never acme's (cross-tenant isolation).
  const globexList = await request.get('/api/notes', { headers: asGlobex })
  const globexBodies = (await globexList.json()).docs.map((d: { body: string }) => d.body)
  expect(globexBodies).toContain('globex secret note')
  expect(globexBodies).not.toContain('acme secret note')

  // Anti-spoof: the acme note kept tenant=acme despite the create passing tenant=globex.
  const acmeNote = (await acmeList.json()).docs.find((d: { body: string }) => d.body === 'acme secret note')
  expect(acmeNote.tenant).toBe('acme')
})
