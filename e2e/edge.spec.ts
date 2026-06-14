import { test, expect } from '@playwright/test'

// In-practice test of edge delivery against the LIVE server: an anonymous read of
// public content gets public cache headers + a surrogate key; the SAME route with
// auth must be private; the purge feed is admin-gated.

const AUTH = { Authorization: 'Bearer e2e-key', 'content-type': 'application/json' }

test('anonymous public read is edge-cacheable; an authenticated read is private', async ({ request }) => {
  const create = await request.post('/api/articles', {
    headers: AUTH,
    data: { title: 'Edge piece', _status: 'published' },
  })
  const id = (await create.json()).id

  // Anonymous read → public, cacheable + surrogate key.
  const anon = await request.get(`/api/articles/${id}`)
  expect(anon.ok()).toBeTruthy()
  const cc = anon.headers()['cache-control'] ?? ''
  expect(cc).toContain('s-maxage')
  const sk = anon.headers()['surrogate-key'] ?? ''
  expect(sk).toContain(`articles:${id}`)

  // Authenticated read of the SAME route → never publicly cached.
  const authed = await request.get(`/api/articles/${id}`, { headers: AUTH })
  expect(authed.ok()).toBeTruthy()
  const authedCC = authed.headers()['cache-control'] ?? ''
  expect(authedCC).not.toContain('s-maxage')
  expect(authedCC).toContain('no-store')
  expect(authed.headers()['surrogate-key']).toBeFalsy()
})

test('the purge feed is admin-gated', async ({ request }) => {
  const anon = await request.get('/api/_edge/purge?since=0')
  expect(anon.status()).toBeGreaterThanOrEqual(401)
  expect(anon.status()).toBeLessThan(404)

  // With the admin service key it returns purge tags + a cursor.
  const admin = await request.get('/api/_edge/purge?since=0', { headers: AUTH })
  expect(admin.ok()).toBeTruthy()
  const body = await admin.json()
  expect(Array.isArray(body.tags)).toBeTruthy()
  expect(typeof body.cursor).toBe('number')
})
