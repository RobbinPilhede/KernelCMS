import { test, expect } from '@playwright/test'

// In-practice test of JSON-LD structured data against the LIVE server: create a
// published article and confirm /jsonld returns valid schema.org markup, and that
// a draft is not exposed to an anonymous caller.

const AUTH = { Authorization: 'Bearer e2e-key', 'content-type': 'application/json' }

test('jsonld returns schema.org Article markup for a published doc', async ({ request }) => {
  const create = await request.post('/api/articles', {
    headers: AUTH,
    data: { title: 'A structured article', summary: 'A short summary.', _status: 'published' },
  })
  expect(create.ok()).toBeTruthy()
  const id = (await create.json()).id

  // Public, unauthenticated read of the JSON-LD.
  const res = await request.get(`/api/articles/${id}/jsonld`)
  expect(res.ok()).toBeTruthy()
  expect(res.headers()['content-type']).toContain('application/ld+json')
  const ld = await res.json()
  expect(ld['@context']).toBe('https://schema.org')
  expect(ld['@type']).toBe('Article')
  expect(typeof ld['@id']).toBe('string')
  // The title maps to name/headline via smart defaults.
  expect(ld.headline ?? ld.name).toBe('A structured article')
})

test('jsonld of a draft is not exposed to an anonymous caller (404)', async ({ request }) => {
  const create = await request.post('/api/articles', {
    headers: AUTH,
    data: { title: 'Hidden draft', _status: 'draft' },
  })
  const id = (await create.json()).id
  const res = await request.get(`/api/articles/${id}/jsonld`)
  expect(res.status()).toBe(404)
})
