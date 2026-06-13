import { beforeEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { initKernel } from '@kernel/core'
import type { AuthUser, Kernel } from '@kernel/core'
import { createRequestHandler } from './index'

// The admin review-inbox routes. REVIEWER-gated (admin OR editor; never an agent), and
// the reviewer identity comes only from the server-resolved `user`. Approve reuses the
// core publish gate, so a reviewer lacking publish access is rejected (403) by core.

const isEditor = ({ req }: { req: { user: AuthUser | null } }) => Boolean(req.user?.roles?.includes('editor'))

let kernel: Kernel

beforeEach(async () => {
  kernel = await initKernel(
    {
      secret: 'reviews-route-test',
      db: sqliteAdapter({ url: ':memory:' }),
      agents: [{ id: 'bot', token: 'bot-token-reviews-route', roles: [], fieldScope: { allow: ['title', 'layout'] } }],
      collections: [
        {
          slug: 'posts',
          versions: { drafts: true },
          access: { read: () => true, create: () => true, update: () => true, publish: isEditor },
          fields: [
            { name: 'title', type: 'text' },
            { name: 'layout', type: 'blocks', blocks: [{ slug: 'hero', fields: [{ name: 'heading', type: 'text' }] }] },
          ],
        },
      ],
    },
    { logLevel: 'error', autoMigrate: true },
  )
})

const admin: AuthUser = { id: 'admin-1', roles: ['admin'], collection: 'users' } as AuthUser
const editor: AuthUser = { id: 'ed-1', roles: ['editor'], collection: 'users' } as AuthUser
const viewer: AuthUser = { id: 'vw-1', roles: ['viewer'], collection: 'users' } as AuthUser

const withUser = (user: AuthUser | null) => ({
  getUser: (): AuthUser | null => user,
  rateLimit: { enabled: false } as const,
})

const url = (qs = '') => `http://localhost/api/_admin/reviews${qs}`

/** Seed one agent-authored draft via composePage and return its id. */
async function seedAgentDraft(): Promise<string> {
  const agent = {
    user: { id: 'bot', principalType: 'agent' as const, roles: [], fieldScope: { allow: ['title', 'layout'] } },
  }
  const doc = await kernel.composePage({
    collection: 'posts',
    blocks: [{ type: 'hero', data: { heading: 'Hi' } }],
    data: { title: 'Bot' },
    req: agent,
  })
  return doc.id
}

describe('/api/_admin/reviews (reviewer only)', () => {
  it('returns 401 when unauthenticated', async () => {
    const handler = createRequestHandler(kernel, { rateLimit: { enabled: false } })
    const res = await handler(new Request(url()))
    expect(res.status).toBe(401)
  })

  it('returns 403 for a non-reviewer (viewer)', async () => {
    const handler = createRequestHandler(kernel, withUser(viewer))
    const res = await handler(new Request(url()))
    expect(res.status).toBe(403)
  })

  it('lists the queue for an editor', async () => {
    const id = await seedAgentDraft()
    const handler = createRequestHandler(kernel, withUser(editor))
    const res = await handler(new Request(url()))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { docs: Array<{ id: string }>; count: number }
    expect(body.count).toBe(1)
    expect(body.docs[0]?.id).toBe(id)
  })

  it('lists the queue for an admin too', async () => {
    await seedAgentDraft()
    const handler = createRequestHandler(kernel, withUser(admin))
    const res = await handler(new Request(url()))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { count: number }
    expect(body.count).toBe(1)
  })

  it('approves a draft (publishes it) on POST', async () => {
    const id = await seedAgentDraft()
    const handler = createRequestHandler(kernel, withUser(editor))
    const res = await handler(
      new Request(url(), { method: 'POST', body: JSON.stringify({ collection: 'posts', id, decision: 'approve' }) }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { decision: string }
    expect(body.decision).toBe('approved')
    const published = await kernel.findByID({ collection: 'posts', id })
    expect(published?._status).toBe('published')
  })

  it('request_changes keeps the draft and records the note', async () => {
    const id = await seedAgentDraft()
    const handler = createRequestHandler(kernel, withUser(editor))
    const res = await handler(
      new Request(url(), {
        method: 'POST',
        body: JSON.stringify({ collection: 'posts', id, decision: 'request_changes', note: 'fix it' }),
      }),
    )
    expect(res.status).toBe(200)
    const after = await kernel.findByID({ collection: 'posts', id, draft: true, overrideAccess: true })
    expect(after?._status).toBe('draft')
  })

  it('rejects an invalid decision with a 400', async () => {
    const id = await seedAgentDraft()
    const handler = createRequestHandler(kernel, withUser(editor))
    const res = await handler(
      new Request(url(), { method: 'POST', body: JSON.stringify({ collection: 'posts', id, decision: 'nope' }) }),
    )
    expect(res.status).toBe(400)
  })

  it('a non-reviewer cannot submit a decision (403)', async () => {
    const id = await seedAgentDraft()
    const handler = createRequestHandler(kernel, withUser(viewer))
    const res = await handler(
      new Request(url(), { method: 'POST', body: JSON.stringify({ collection: 'posts', id, decision: 'approve' }) }),
    )
    expect(res.status).toBe(403)
  })
})
