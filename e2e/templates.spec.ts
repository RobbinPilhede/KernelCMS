import { test, expect } from '@playwright/test'

// In-practice test of content templates against the LIVE server: list the available
// templates and create a pre-filled document from one (with an override) over HTTP.

const AUTH = { Authorization: 'Bearer e2e-key', 'content-type': 'application/json' }

test('list templates and create a pre-filled document from one over the live server', async ({ request }) => {
  // The configured template is listed (metadata only).
  const list = await request.get('/api/_admin/templates?collection=articles', { headers: AUTH })
  expect(list.ok()).toBeTruthy()
  const templates = await list.json()
  const arr = Array.isArray(templates) ? templates : (templates.templates ?? [])
  expect(arr.some((t: { slug: string }) => t.slug === 'article_starter')).toBeTruthy()
  // List never exposes the raw template data.
  const starter = arr.find((t: { slug: string }) => t.slug === 'article_starter')
  expect(starter.data).toBeUndefined()

  // Create from the template — the new doc is pre-filled with the template defaults.
  const created = await request.post('/api/articles/from-template', {
    headers: AUTH,
    data: { template: 'article_starter' },
  })
  expect(created.ok()).toBeTruthy()
  const doc = await created.json()
  expect(doc.title).toBe('Untitled article')
  expect(doc.summary).toBe('Start writing…')

  // Caller data overrides the template default.
  const overridden = await request.post('/api/articles/from-template', {
    headers: AUTH,
    data: { template: 'article_starter', data: { title: 'My custom title' } },
  })
  const doc2 = await overridden.json()
  expect(doc2.title).toBe('My custom title')
  expect(doc2.summary).toBe('Start writing…') // untouched default
})

test('a template cannot create into a different collection (route is authoritative)', async ({ request }) => {
  // article_starter targets `articles`; using it on the `pages` route is rejected.
  const res = await request.post('/api/pages/from-template', {
    headers: AUTH,
    data: { template: 'article_starter' },
  })
  expect(res.status()).toBeGreaterThanOrEqual(400)
  expect(res.status()).toBeLessThan(500)
})
