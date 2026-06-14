import { test, expect, type APIRequestContext } from '@playwright/test'

// In-practice test of saved views / smart collections against the LIVE server. A view is a
// named query preset (where+sort) for a collection; owned by its creator, private unless
// shared. Applying a view runs the NORMAL access-checked find, so it can only ever narrow
// within the caller's access. The HTTP routes require auth up front (anonymous → 401).

const SVC = { Authorization: 'Bearer e2e-key', 'content-type': 'application/json' }

async function userToken(request: APIRequestContext, roles: string[] = ['user']): Promise<string> {
  const email = `vw-${Date.now()}-${Math.round(Math.random() * 1e6)}@t.test`
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

test('save, list, apply, update, and delete a view over the live server', async ({ request }) => {
  const token = await userToken(request)
  const asUser = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }

  // Seed a couple of articles to filter.
  await request.post('/api/articles', { headers: asUser, data: { title: 'Alpha', summary: 'keep' } })
  await request.post('/api/articles', { headers: asUser, data: { title: 'Beta', summary: 'keep' } })

  // Save a view: title-contains filter + sort.
  const save = await request.post('/api/_admin/views', {
    headers: asUser,
    data: {
      collection: 'articles',
      name: 'Alphas',
      where: { title: { like: 'Alpha' } },
      sort: '-title',
      columns: ['title', 'summary'],
      // A forged ownerId in the body must be ignored (owner comes from the principal).
      ownerId: 'forged-admin',
    },
  })
  expect(save.status()).toBe(201)
  const view = await save.json()
  expect(view.name).toBe('Alphas')
  expect(view.ownerId).not.toBe('forged-admin')
  expect(view.shared).toBe(false)

  // It appears in the owner's list (scoped to the collection).
  const list = await request.get('/api/_admin/views?collection=articles', { headers: asUser })
  expect((await list.json()).views.some((v: { id: string }) => v.id === view.id)).toBeTruthy()

  // Applying it runs the access-checked find — only the matching article comes back. The
  // editor view spans drafts (these freshly-created articles are drafts).
  const applied = await request.post(`/api/_admin/views/${view.id}/apply`, { headers: asUser, data: { draft: true } })
  expect(applied.ok()).toBeTruthy()
  const result = await applied.json()
  expect(result.docs.every((d: { title: string }) => d.title.includes('Alpha'))).toBeTruthy()
  expect(result.docs.length).toBeGreaterThanOrEqual(1)

  // Update the view's name + filter; re-apply reflects it.
  const patch = await request.patch(`/api/_admin/views/${view.id}`, {
    headers: asUser,
    data: { name: 'Betas', where: { title: { like: 'Beta' } } },
  })
  expect(patch.ok()).toBeTruthy()
  expect((await patch.json()).name).toBe('Betas')
  const reapplied = await request.post(`/api/_admin/views/${view.id}/apply`, {
    headers: asUser,
    data: { draft: true },
  })
  expect((await reapplied.json()).docs.every((d: { title: string }) => d.title.includes('Beta'))).toBeTruthy()

  // Delete it; it's gone from the list.
  const del = await request.delete(`/api/_admin/views/${view.id}`, { headers: asUser })
  expect(del.ok()).toBeTruthy()
  const after = await request.get('/api/_admin/views?collection=articles', { headers: asUser })
  expect((await after.json()).views.some((v: { id: string }) => v.id === view.id)).toBeFalsy()
})

test('a saved view is rejected when it references an unknown field', async ({ request }) => {
  const token = await userToken(request)
  const asUser = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const res = await request.post('/api/_admin/views', {
    headers: asUser,
    data: { collection: 'articles', name: 'Bad', where: { nope: { equals: 'x' } } },
  })
  expect(res.status()).toBeGreaterThanOrEqual(400)
  expect(res.status()).toBeLessThan(500)
})

test('view endpoints require authentication (anonymous gets 401)', async ({ request }) => {
  // Seed via the service key (Bearer API key sets NO session cookie) so the context is
  // genuinely cookie-less and the calls below are truly anonymous.
  const list = await request.get('/api/_admin/views')
  expect(list.status()).toBe(401)
  const save = await request.post('/api/_admin/views', {
    headers: { 'content-type': 'application/json' },
    data: { collection: 'articles', name: 'x' },
  })
  expect(save.status()).toBe(401)
})

test('a private view is invisible to other users; a shared view applied by another narrows to their access', async ({
  request,
}) => {
  const ownerToken = await userToken(request)
  const asOwner = { Authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json' }
  const otherToken = await userToken(request)
  const asOther = { Authorization: `Bearer ${otherToken}`, 'content-type': 'application/json' }

  // A PRIVATE view by the owner.
  const priv = await (
    await request.post('/api/_admin/views', {
      headers: asOwner,
      data: { collection: 'articles', name: 'Private', where: { summary: { like: 'keep' } } },
    })
  ).json()

  // The other user cannot see it (GET → 404) and cannot apply it (404 — no existence oracle).
  const get = await request.get(`/api/_admin/views/${priv.id}`, { headers: asOther })
  expect(get.status()).toBe(404)
  const apply = await request.post(`/api/_admin/views/${priv.id}/apply`, { headers: asOther, data: {} })
  expect(apply.status()).toBe(404)

  // A SHARED view IS visible to the other user (articles is publicly readable), and applying
  // it runs as the OTHER user through the normal access-checked find.
  const shared = await (
    await request.post('/api/_admin/views', {
      headers: asOwner,
      data: { collection: 'articles', name: 'Shared', where: { summary: { like: 'keep' } }, shared: true },
    })
  ).json()
  const seen = await request.get(`/api/_admin/views/${shared.id}`, { headers: asOther })
  expect(seen.ok()).toBeTruthy()
  const appliedByOther = await request.post(`/api/_admin/views/${shared.id}/apply`, { headers: asOther, data: {} })
  expect(appliedByOther.ok()).toBeTruthy()

  // The other user cannot update or delete the owner's shared view.
  const patch = await request.patch(`/api/_admin/views/${shared.id}`, { headers: asOther, data: { name: 'hijack' } })
  expect(patch.status()).toBeGreaterThanOrEqual(403)
  const del = await request.delete(`/api/_admin/views/${shared.id}`, { headers: asOther })
  expect(del.status()).toBeGreaterThanOrEqual(403)
})
