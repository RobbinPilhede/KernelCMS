import { test, expect, type APIRequestContext } from '@playwright/test'

// In-practice test of editorial comments against the LIVE server. Comments are threaded
// review annotations gated by the TARGET DOCUMENT's read access — you can only see/add
// comments on a document you can read, the author is recorded from the authenticated
// principal (never client input), and resolve/delete are gated to the author or a
// reviewer/admin. The HTTP routes require auth up front, so the anonymous surface is a
// hard 401 (the deeper Local-API doc-read gate is covered by the unit/verify suites).

const SVC = { Authorization: 'Bearer e2e-key', 'content-type': 'application/json' }

async function userToken(request: APIRequestContext, roles: string[] = ['user']): Promise<string> {
  const email = `cm-${Date.now()}-${Math.round(Math.random() * 1e6)}@t.test`
  const create = await request.post('/api/users', {
    headers: SVC,
    data: { email, password: 'supersecret123', roles },
  })
  expect(create.ok()).toBeTruthy()
  const login = await request.post('/api/users/login', {
    headers: { 'content-type': 'application/json' },
    data: { email, password: 'supersecret123' },
  })
  expect(login.ok()).toBeTruthy()
  return (await login.json()).token
}

test('the full comment lifecycle over the live server: add, thread, list, resolve, delete', async ({ request }) => {
  const token = await userToken(request)
  const asAuthor = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }

  // Seed an article to annotate.
  const created = await request.post('/api/articles', { headers: asAuthor, data: { title: 'Needs review' } })
  expect(created.ok()).toBeTruthy()
  const article = await created.json()

  // Add a comment — body is trimmed and the author is taken from the principal, not the
  // client (a forged authorId is ignored).
  const add = await request.post(`/api/articles/${article.id}/comments`, {
    headers: asAuthor,
    data: { body: '  tighten the intro  ', field: 'summary', authorId: 'forged-admin' },
  })
  expect(add.status()).toBe(201)
  const comment = await add.json()
  expect(comment.body).toBe('tighten the intro')
  expect(comment.field).toBe('summary')
  expect(comment.resolved).toBe(false)
  expect(comment.authorId).not.toBe('forged-admin')

  // A threaded reply anchored to the same document.
  const replyRes = await request.post(`/api/articles/${article.id}/comments`, {
    headers: asAuthor,
    data: { body: 'agreed', parentId: comment.id },
  })
  expect(replyRes.status()).toBe(201)
  const reply = await replyRes.json()
  expect(reply.parentId).toBe(comment.id)

  // List returns both, oldest -> newest.
  const list = await request.get(`/api/articles/${article.id}/comments`, { headers: asAuthor })
  expect(list.ok()).toBeTruthy()
  const { comments } = await list.json()
  expect(comments.map((c: { id: string }) => c.id)).toEqual([comment.id, reply.id])

  // Resolve the root comment (the author may resolve their own).
  const resolve = await request.patch(`/api/_admin/comments/${comment.id}`, {
    headers: asAuthor,
    data: { resolved: true },
  })
  expect(resolve.ok()).toBeTruthy()
  expect((await resolve.json()).resolved).toBe(true)

  // Resolved comments are hidden by default, visible with includeResolved.
  const open = await request.get(`/api/articles/${article.id}/comments`, { headers: asAuthor })
  expect((await open.json()).comments.map((c: { id: string }) => c.id)).toEqual([reply.id])
  const all = await request.get(`/api/articles/${article.id}/comments?includeResolved=true`, { headers: asAuthor })
  expect((await all.json()).comments).toHaveLength(2)

  // The author can delete their own comment.
  const del = await request.delete(`/api/_admin/comments/${comment.id}`, { headers: asAuthor })
  expect(del.ok()).toBeTruthy()
  const afterDelete = await request.get(`/api/articles/${article.id}/comments?includeResolved=true`, {
    headers: asAuthor,
  })
  expect((await afterDelete.json()).comments.map((c: { id: string }) => c.id)).toEqual([reply.id])
})

test('comment endpoints require authentication (anonymous gets 401)', async ({ request }) => {
  // Seed via the service key (Bearer API key sets NO session cookie), so this test's
  // request context stays truly cookie-less and the calls below are genuinely anonymous.
  const article = await (await request.post('/api/articles', { headers: SVC, data: { title: 'x' } })).json()

  // No Authorization header on any comment route -> Unauthorized, never comment data.
  const anonGet = await request.get(`/api/articles/${article.id}/comments`)
  expect(anonGet.status()).toBe(401)
  const anonPost = await request.post(`/api/articles/${article.id}/comments`, {
    headers: { 'content-type': 'application/json' },
    data: { body: 'sneak' },
  })
  expect(anonPost.status()).toBe(401)
})

test('a non-author, non-reviewer cannot resolve or delete someone else’s comment', async ({ request }) => {
  const authorToken = await userToken(request)
  const asAuthor = { Authorization: `Bearer ${authorToken}`, 'content-type': 'application/json' }
  const otherToken = await userToken(request)
  const asOther = { Authorization: `Bearer ${otherToken}`, 'content-type': 'application/json' }

  const article = await (await request.post('/api/articles', { headers: asAuthor, data: { title: 'shared' } })).json()
  const comment = await (
    await request.post(`/api/articles/${article.id}/comments`, { headers: asAuthor, data: { body: 'mine' } })
  ).json()

  // A different plain user (can read the public article, but is not author/reviewer) is denied.
  const resolve = await request.patch(`/api/_admin/comments/${comment.id}`, {
    headers: asOther,
    data: { resolved: true },
  })
  expect(resolve.status()).toBeGreaterThanOrEqual(403)
  const del = await request.delete(`/api/_admin/comments/${comment.id}`, { headers: asOther })
  expect(del.status()).toBeGreaterThanOrEqual(403)

  // The comment is untouched.
  const list = await request.get(`/api/articles/${article.id}/comments`, { headers: asAuthor })
  expect((await list.json()).comments).toHaveLength(1)
})
