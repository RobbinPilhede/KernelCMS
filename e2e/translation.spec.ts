import { test, expect } from '@playwright/test'

// In-practice test of AI translation against the LIVE server: create a doc with an
// English localized field and auto-translate it into Spanish via the configured
// provider, then read the translated locale back — all over real HTTP.

const AUTH = { Authorization: 'Bearer e2e-key', 'content-type': 'application/json' }

test('translateDocument fills a target locale via the provider over the live server', async ({ request }) => {
  // Create with an English summary (the default locale).
  const create = await request.post('/api/articles', {
    headers: AUTH,
    data: { title: 'Translatable', summary: 'Hello world', _status: 'published' },
  })
  expect(create.ok()).toBeTruthy()
  const id = (await create.json()).id

  // Translate en → es via the document translate route.
  const tr = await request.post(`/api/articles/${id}/translate`, { headers: AUTH, data: { from: 'en', to: 'es' } })
  expect(tr.ok()).toBeTruthy()

  // Reading the es locale returns the provider's translation; en is untouched.
  const es = await request.get(`/api/articles/${id}?locale=es`, { headers: AUTH })
  expect((await es.json()).summary).toBe('[es] Hello world')
  const en = await request.get(`/api/articles/${id}?locale=en`, { headers: AUTH })
  expect((await en.json()).summary).toBe('Hello world')
})
