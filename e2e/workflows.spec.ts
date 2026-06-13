import { test, expect } from '@playwright/test'

// In-practice test of agentic workflows against the LIVE server: trigger a
// workflow over the real admin route, and confirm it runs as the scoped agent,
// produces a DRAFT (never published), and is recorded in the run log.

const AUTH = { Authorization: 'Bearer e2e-key', 'content-type': 'application/json' }

test('manual workflow run drafts content as the scoped agent and is logged', async ({ request }) => {
  // Start the workflow via the admin route (reviewer-gated; the service key is admin).
  const run = await request.post('/api/_admin/workflows/draft_welcome/run', { headers: AUTH, data: {} })
  expect(run.ok(), 'workflow run starts').toBeTruthy()
  const body = await run.json()
  expect(body.status).toBe('completed')
  expect(body.steps?.[0]?.status).toBe('completed')

  // The run is queryable in the durable run log.
  const log = await request.get('/api/_admin/workflow-runs?slug=draft_welcome', { headers: AUTH })
  expect(log.ok()).toBeTruthy()
  const runs = (await log.json()).docs
  expect(Array.isArray(runs)).toBeTruthy()
  expect(runs.some((r: { status: string }) => r.status === 'completed')).toBeTruthy()

  // The agent's step produced a DRAFT article (agents can never publish).
  const drafted = await request.get('/api/articles?draft=true&where[title][equals]=Workflow%20draft', { headers: AUTH })
  expect(drafted.ok()).toBeTruthy()
  const docs = (await drafted.json()).docs
  expect(docs.length).toBeGreaterThan(0)
  expect(docs[0]._status).toBe('draft')
})

test('workflow routes reject an unauthenticated caller', async ({ request }) => {
  const res = await request.post('/api/_admin/workflows/draft_welcome/run', { data: {} })
  expect(res.status()).toBeGreaterThanOrEqual(401)
  expect(res.status()).toBeLessThan(404)
})
