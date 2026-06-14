import { test, expect } from '@playwright/test'

// In-practice test of content QA / linting against the LIVE server. The `qa_docs` collection
// declares a blocking `requiredFields(['summary'])` eval and a non-blocking `readability`
// nudge. The same rules that gate publish are surfaced on demand via GET /api/:c/:id/lint, so
// an editor sees blocking errors + quality warnings BEFORE attempting to publish. Linting is an
// editorial tool gated on UPDATE access (it inspects the live draft), so the lint GETs below
// carry the admin service key — an anonymous caller is rejected (see the access test).

const SVC = { Authorization: 'Bearer e2e-key', 'content-type': 'application/json' }

test('lint surfaces a blocking required-field error, clears once fixed', async ({ request }) => {
  // A draft with no summary: the required-field rule is unsatisfied.
  const created = await (await request.post('/api/qa_docs', { headers: SVC, data: { title: 'QA draft' } })).json()

  const before = await request.get(`/api/qa_docs/${created.id}/lint`, { headers: SVC })
  expect(before.ok()).toBeTruthy()
  const lintBefore = await before.json()
  expect(lintBefore.ok).toBe(false)
  expect(lintBefore.blocking.length).toBeGreaterThan(0)
  const summaryFinding = lintBefore.blocking.find((f: { field?: string }) => f.field === 'summary')
  expect(summaryFinding).toBeTruthy()
  expect(summaryFinding.severity).toBe('error')
  expect(summaryFinding.blocking).toBe(true)

  // Fill the summary → the blocking finding clears.
  await request.patch(`/api/qa_docs/${created.id}`, { headers: SVC, data: { summary: 'A short, clear summary.' } })
  const after = await request.get(`/api/qa_docs/${created.id}/lint`, { headers: SVC })
  const lintAfter = await after.json()
  expect(lintAfter.ok).toBe(true)
  expect(lintAfter.blocking).toEqual([])
})

test('publish is blocked while a blocking eval fails, allowed once it passes', async ({ request }) => {
  // Publishing a doc with no summary trips the blocking eval → 400 VALIDATION, no write.
  const blocked = await request.post('/api/qa_docs', {
    headers: SVC,
    data: { title: 'Tries to publish', _status: 'published' },
  })
  expect(blocked.status()).toBe(400)
  const err = await blocked.json()
  expect(err.error.code).toBe('VALIDATION')

  // The same publish WITH a summary succeeds.
  const ok = await request.post('/api/qa_docs', {
    headers: SVC,
    data: { title: 'Publishes cleanly', summary: 'Ready to ship.', _status: 'published' },
  })
  expect(ok.ok()).toBeTruthy()
  expect((await ok.json())._status).toBe('published')
})

test('readability is a non-blocking nudge (warns, never blocks publish)', async ({ request }) => {
  // A run-on summary blows past maxAvgSentenceWords: 8 → a warn finding, but `ok` stays true
  // because warnings never block.
  const runOn =
    'This particular summary deliberately runs on well past the configured average sentence length threshold'
  const created = await (
    await request.post('/api/qa_docs', { headers: SVC, data: { title: 'Wordy', summary: runOn } })
  ).json()

  const lint = await (await request.get(`/api/qa_docs/${created.id}/lint`, { headers: SVC })).json()
  expect(lint.ok).toBe(true)
  const warn = lint.findings.find((f: { severity: string; ok: boolean }) => f.severity === 'warn' && !f.ok)
  expect(warn).toBeTruthy()
  expect(warn.blocking).toBe(false)
})

test('lint is an editorial surface — gated on update access, not public read', async ({ request }) => {
  // qa_docs is publicly READABLE but only an authenticated editor can UPDATE it. Linting
  // inspects the live draft, so it must require edit rights: an anonymous caller is rejected
  // even though they could read the published doc. This stops drafts leaking via lint findings.
  const created = await (
    await request.post('/api/qa_docs', { headers: SVC, data: { title: 'Editor only', summary: 'x' } })
  ).json()
  const anon = await request.get(`/api/qa_docs/${created.id}/lint`)
  expect(anon.status()).toBe(403)
})

test('linting a missing document is a clean 404', async ({ request }) => {
  const res = await request.get('/api/qa_docs/does-not-exist/lint', { headers: SVC })
  expect(res.status()).toBe(404)
})
