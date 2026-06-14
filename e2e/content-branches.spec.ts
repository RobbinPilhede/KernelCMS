import { test, expect } from '@playwright/test'

// In-practice test of content branches against the LIVE server. The service key is an admin
// (reviewer). Stage an edit on a branch, confirm the live doc is untouched, preview the
// overlay, diff it, then merge it into the live doc.

const SVC = { Authorization: 'Bearer e2e-key', 'content-type': 'application/json' }

test('stage on a branch (copy-on-write), preview, diff, then merge to live', async ({ request }) => {
  // Seed + publish an article so it's live-readable.
  const article = await (await request.post('/api/articles', { headers: SVC, data: { title: 'Original' } })).json()
  await request.post(`/api/articles/${article.id}/publish`, { headers: SVC, data: {} })

  // Create a branch and stage a title edit.
  const branchName = `redesign-${Date.now()}`
  const created = await request.post('/api/_admin/branches', { headers: SVC, data: { name: branchName } })
  expect(created.status()).toBe(201)
  expect((await created.json()).status).toBe('open')

  const stage = await request.post(`/api/_admin/branches/${branchName}/stage`, {
    headers: SVC,
    data: { collection: 'articles', id: article.id, data: { title: 'Reworked' } },
  })
  expect(stage.status()).toBe(201)

  // The LIVE article is unchanged (copy-on-write).
  const live = await request.get(`/api/articles/${article.id}`, { headers: SVC })
  expect((await live.json()).title).toBe('Original')

  // Preview shows the staged overlay.
  const preview = await request.get(`/api/_admin/branches/${branchName}/preview?collection=articles&id=${article.id}`, {
    headers: SVC,
  })
  expect(preview.ok()).toBeTruthy()
  expect((await preview.json()).title).toBe('Reworked')

  // Diff lists the staged change.
  const diff = await request.get(`/api/_admin/branches/${branchName}/diff`, { headers: SVC })
  const { changes } = await diff.json()
  expect(
    changes.some(
      (c: { documentId: string; fields: string[] }) => c.documentId === article.id && c.fields.includes('title'),
    ),
  ).toBeTruthy()

  // Merge applies it to the live article.
  const merge = await request.post(`/api/_admin/branches/${branchName}/merge`, { headers: SVC, data: {} })
  expect(merge.ok()).toBeTruthy()
  expect((await merge.json()).merged).toContain(`articles:${article.id}`)

  const afterMerge = await request.get(`/api/articles/${article.id}`, { headers: SVC })
  expect((await afterMerge.json()).title).toBe('Reworked')

  // The branch is now merged (no longer open).
  const branches = await request.get('/api/_admin/branches?status=merged', { headers: SVC })
  expect((await branches.json()).branches.some((b: { name: string }) => b.name === branchName)).toBeTruthy()
})

test('content branches are reviewer-gated (a plain user is forbidden)', async ({ request }) => {
  const email = `br-${Date.now()}@t.test`
  await request.post('/api/users', { headers: SVC, data: { email, password: 'supersecret123', roles: ['user'] } })
  const token = (
    await (
      await request.post('/api/users/login', {
        headers: { 'content-type': 'application/json' },
        data: { email, password: 'supersecret123' },
      })
    ).json()
  ).token
  const asUser = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const res = await request.post('/api/_admin/branches', { headers: asUser, data: { name: 'nope' } })
  expect(res.status()).toBeGreaterThanOrEqual(403)
})
