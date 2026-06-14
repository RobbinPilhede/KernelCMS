import { test, expect, type APIRequestContext } from '@playwright/test'

// In-practice test of content snippets against the LIVE server. `snippets` is a snippet
// library; `articles.cta` is a `snippet` field that transcludes a fragment on read (with
// ?depth=1). Editing the fragment is reflected by every referencing article (edit-once).

const SVC = { Authorization: 'Bearer e2e-key', 'content-type': 'application/json' }

async function userToken(request: APIRequestContext): Promise<string> {
  const email = `sn-${Date.now()}-${Math.round(Math.random() * 1e6)}@t.test`
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

test('a snippet field transcludes the live fragment on read, and reflects edits everywhere', async ({ request }) => {
  const token = await userToken(request)
  const asUser = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }

  // Create a reusable fragment + an article that references it.
  const snippet = await (
    await request.post('/api/snippets', { headers: asUser, data: { label: 'Signup CTA', body: 'Get started today' } })
  ).json()
  const article = await (
    await request.post('/api/articles', { headers: asUser, data: { title: 'Home', cta: snippet.id } })
  ).json()

  // With depth=1 the snippet is transcluded inline.
  const read = await request.get(`/api/articles/${article.id}?depth=1&draft=true`, { headers: asUser })
  const doc = await read.json()
  expect(typeof doc.cta).toBe('object')
  expect(doc.cta.body).toBe('Get started today')

  // With depth=0 it stays the raw id.
  const shallow = await request.get(`/api/articles/${article.id}?depth=0&draft=true`, { headers: asUser })
  expect((await shallow.json()).cta).toBe(snippet.id)

  // Edit the fragment once — the article reflects it (live transclusion, not a copy).
  await request.patch(`/api/snippets/${snippet.id}`, { headers: asUser, data: { body: 'New launch copy' } })
  const reread = await request.get(`/api/articles/${article.id}?depth=1&draft=true`, { headers: asUser })
  expect((await reread.json()).cta.body).toBe('New launch copy')
})
