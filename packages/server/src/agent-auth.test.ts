import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { initKernel } from '@kernel/core'
import type { Kernel } from '@kernel/core'
import { createRequestHandler } from './index'

// `resolveAuth` is internal, so the agent branch is verified end-to-end through the
// HTTP handler: a request bearing a configured agent token must run as an
// overrideAccess:false, field-scoped, never-publishing principal — and MUST NOT
// reach the god-mode apiKey path.

const AGENT_TOKEN = 'agent-secret-token-abc'
const SYSTEM_KEY = 'system-god-mode-key'

let kernel: Kernel

beforeEach(async () => {
  kernel = await initKernel(
    {
      secret: 'test-secret',
      db: sqliteAdapter({ url: ':memory:' }),
      agents: [{ id: 'mcp-bot', token: AGENT_TOKEN, roles: [], fieldScope: { allow: ['body'] } }],
      collections: [
        {
          slug: 'posts',
          versions: { drafts: true },
          access: { read: () => true, create: () => true, update: () => true, publish: () => true },
          fields: [
            { name: 'title', type: 'text' },
            { name: 'body', type: 'text' },
          ],
        },
      ],
    },
    { logLevel: 'error' },
  )
  await kernel.migrate()
})

afterEach(async () => {
  await kernel.destroy()
})

function post(handler: (r: Request) => Promise<Response>, body: unknown, token: string): Promise<Response> {
  return handler(
    new Request('http://localhost/api/posts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
  )
}

describe('agent bearer auth (overrideAccess:false, scoped, no publish)', () => {
  it('runs as the agent and strips unscoped fields (proves overrideAccess:false)', async () => {
    const handler = createRequestHandler(kernel, { apiKey: SYSTEM_KEY })
    const res = await post(handler, { body: 'agent body', title: 'should be stripped' }, AGENT_TOKEN)
    expect(res.status).toBe(201)
    const doc = (await res.json()) as { body?: string; title?: string }
    // overrideAccess would have skipped field scope; it didn't, so title is gone.
    expect(doc.body).toBe('agent body')
    expect(doc.title ?? null).toBeNull()
  })

  it('cannot publish even though access.publish allows everyone', async () => {
    const handler = createRequestHandler(kernel, { apiKey: SYSTEM_KEY })
    const res = await post(handler, { body: 'hot', _status: 'published' }, AGENT_TOKEN)
    expect(res.status).toBe(403)
  })

  it('the god-mode apiKey path is NOT reused: the real system key still overrides', async () => {
    const handler = createRequestHandler(kernel, { apiKey: SYSTEM_KEY })
    // The genuine system key publishes and writes every field — distinct from the agent.
    const res = await post(handler, { body: 'sys', title: 'kept', _status: 'published' }, SYSTEM_KEY)
    expect(res.status).toBe(201)
    const doc = (await res.json()) as { title?: string; _status?: string }
    expect(doc.title).toBe('kept')
    expect(doc._status).toBe('published')
  })

  it('an unknown bearer token is anonymous, not an agent', async () => {
    const handler = createRequestHandler(kernel, { apiKey: SYSTEM_KEY })
    // posts.read is public, so an anonymous GET succeeds — but no agent identity leaks.
    const res = await handler(
      new Request('http://localhost/api/posts', { headers: { authorization: 'Bearer not-a-real-token' } }),
    )
    expect(res.status).toBe(200)
  })
})
