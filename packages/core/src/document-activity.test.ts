import { describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { defineConfig, initKernel } from './index'
import type { Kernel } from './index'

// `documentActivity` merges a document's versions + comments (any reader) with reviews +
// audit (reviewers only) into one access-checked, newest-first feed. The security property
// under test: the WHOLE feed is gated on the document's READ access, and the reviewer-only
// sources are added ONLY for a reviewer principal — a non-reviewer who can read the doc sees
// version/comment events but NEVER audit/review, and `includesReviewerEvents` reflects that.

const admin = { user: { id: 'adm', roles: ['admin'] } } as const
const editor = { user: { id: 'ed', roles: ['editor'] } } as const
const viewer = { user: { id: 'vw', roles: ['viewer'] } } as const
const viewerB = { user: { id: 'vw2', roles: ['viewer'] } } as const
const anon = {} as const

// Owner-scoped read: a row is only readable by its owner (or an admin).
const ownerRead = ({ req }: any): any => {
  if (req.user?.roles?.includes('admin')) return true
  return { owner: { equals: req.user?.id ?? '__none__' } }
}

function publicConfig() {
  return defineConfig({
    secret: 'test-secret-32-characters-long!!!!',
    db: sqliteAdapter({ url: ':memory:' }),
    audit: true,
    comments: true,
    collections: [
      {
        slug: 'posts',
        versions: { drafts: true },
        access: { read: () => true, create: () => true, update: () => true },
        fields: [
          { name: 'title', type: 'text', required: true },
          { name: 'body', type: 'text' },
        ],
      },
      {
        slug: 'secrets',
        versions: { drafts: true },
        access: { read: ownerRead, create: () => true, update: () => true },
        fields: [
          { name: 'owner', type: 'text' },
          { name: 'note', type: 'text' },
        ],
      },
    ],
  })
}

type Ev = { type: string; at: string; actor: { id: string | null; type: string }; action: string; data: any }

async function seedPost(kernel: Kernel): Promise<string> {
  const post = await kernel.create({ collection: 'posts', data: { title: 'Hello' }, req: editor as any })
  await kernel.update({ collection: 'posts', id: post.id, data: { title: 'Hello v2' }, req: editor as any })
  await kernel.addComment({ collection: 'posts', id: post.id, body: 'first comment', req: viewer as any })
  return post.id
}

describe('documentActivity — merged feed', () => {
  it('a reviewer sees a merged, newest-first feed with version + comment + audit', async () => {
    const kernel = await initKernel(publicConfig(), { autoMigrate: true })
    const id = await seedPost(kernel)

    const { events, includesReviewerEvents } = await kernel.documentActivity({
      collection: 'posts',
      id,
      req: editor as any,
    })

    expect(includesReviewerEvents).toBe(true)
    const types = new Set(events.map((e) => e.type))
    expect(events.filter((e) => e.type === 'version').length).toBeGreaterThanOrEqual(2)
    expect(types.has('comment')).toBe(true)
    expect(types.has('audit')).toBe(true)

    for (let i = 0; i < events.length - 1; i++) {
      expect(events[i]!.at >= events[i + 1]!.at).toBe(true)
    }
    await kernel.destroy()
  })

  it('a non-reviewer reader sees ONLY version + comment events, no audit/review', async () => {
    const kernel = await initKernel(publicConfig(), { autoMigrate: true })
    const id = await seedPost(kernel)

    const { events, includesReviewerEvents } = await kernel.documentActivity({
      collection: 'posts',
      id,
      req: viewer as any,
    })

    expect(includesReviewerEvents).toBe(false)
    const types = new Set(events.map((e) => e.type))
    expect(types.has('version')).toBe(true)
    expect(types.has('comment')).toBe(true)
    expect(types.has('audit')).toBe(false)
    expect(types.has('review')).toBe(false)
    await kernel.destroy()
  })

  it('the whole feed is gated on the document READ access (no leak)', async () => {
    const kernel = await initKernel(publicConfig(), { autoMigrate: true })
    const secret = await kernel.create({
      collection: 'secrets',
      data: { owner: 'vw', note: 'top secret' },
      req: viewer as any,
    })
    await kernel.addComment({ collection: 'secrets', id: secret.id, body: 'mine', req: viewer as any })

    // A caller who cannot read the doc is denied — the feed throws (Forbidden/NotFound), no
    // events leak.
    const denied = async (req: unknown): Promise<{ name: string; code: string }> => {
      try {
        await kernel.documentActivity({ collection: 'secrets', id: secret.id, req: req as any })
        throw new Error('expected documentActivity to throw, but it resolved')
      } catch (e) {
        return { name: (e as Error).name, code: (e as { code?: string }).code ?? '' }
      }
    }
    expect((await denied(viewerB)).name).toMatch(/ForbiddenError|NotFoundError/)
    expect((await denied(anon)).name).toMatch(/ForbiddenError|NotFoundError/)

    // The owner gets its own feed.
    const owned = await kernel.documentActivity({ collection: 'secrets', id: secret.id, req: viewer as any })
    expect(owned.events.some((e) => e.type === 'comment')).toBe(true)
    // An admin can read any doc and gets the reviewer feed.
    const byAdmin = await kernel.documentActivity({ collection: 'secrets', id: secret.id, req: admin as any })
    expect(byAdmin.includesReviewerEvents).toBe(true)
    await kernel.destroy()
  })

  it('types filters to specific event types and respects reviewer gating', async () => {
    const kernel = await initKernel(publicConfig(), { autoMigrate: true })
    const id = await seedPost(kernel)

    const onlyComments = await kernel.documentActivity({
      collection: 'posts',
      id,
      types: ['comment'],
      req: editor as any,
    })
    expect(onlyComments.events.length).toBeGreaterThan(0)
    expect(onlyComments.events.every((e) => e.type === 'comment')).toBe(true)

    // audit is reviewer-only: a viewer asking for audit gets nothing.
    const viewerAudit = await kernel.documentActivity({
      collection: 'posts',
      id,
      types: ['audit'],
      req: viewer as any,
    })
    expect(viewerAudit.events).toEqual([])
    expect(viewerAudit.includesReviewerEvents).toBe(false)

    // a reviewer asking for audit gets audit events.
    const reviewerAudit = await kernel.documentActivity({
      collection: 'posts',
      id,
      types: ['audit'],
      req: editor as any,
    })
    expect(reviewerAudit.events.length).toBeGreaterThan(0)
    expect(reviewerAudit.events.every((e) => e.type === 'audit')).toBe(true)
    await kernel.destroy()
  })

  it('limit caps the number of events returned', async () => {
    const kernel = await initKernel(publicConfig(), { autoMigrate: true })
    const post = await kernel.create({ collection: 'posts', data: { title: 't0' }, req: editor as any })
    for (let i = 1; i <= 10; i++) {
      await kernel.addComment({ collection: 'posts', id: post.id, body: `c${i}`, req: viewer as any })
    }

    const limit = 3
    const { events } = await kernel.documentActivity({ collection: 'posts', id: post.id, limit, req: editor as any })
    expect(events.length).toBeLessThanOrEqual(limit)
    await kernel.destroy()
  })

  it('event mapping: comment/version/audit fields and actor are correct', async () => {
    const kernel = await initKernel(publicConfig(), { autoMigrate: true })
    const post = await kernel.create({ collection: 'posts', data: { title: 't0', body: 'b0' }, req: editor as any })
    await kernel.update({ collection: 'posts', id: post.id, data: { title: 't1' }, req: editor as any })
    const comment = await kernel.addComment({
      collection: 'posts',
      id: post.id,
      body: 'map me',
      req: viewer as any,
    })

    const { events } = await kernel.documentActivity({ collection: 'posts', id: post.id, req: editor as any })

    const commentEvent = events.find((e) => e.type === 'comment') as Ev
    expect(commentEvent).toBeTruthy()
    expect(commentEvent.data.commentId).toBe(comment.id)
    expect(commentEvent.data.body).toBe('map me')
    expect(commentEvent.data.resolved).toBe(false)
    expect(commentEvent.actor.id).toBe('vw')
    expect(commentEvent.actor.type).toBe('user')

    const versionEvent = events.find((e) => e.type === 'version') as Ev
    expect(versionEvent).toBeTruthy()
    expect(typeof versionEvent.data.versionId).toBe('string')
    expect(Array.isArray(versionEvent.data.changedFields)).toBe(true)

    const auditActions = events.filter((e) => e.type === 'audit').map((e) => e.action)
    expect(auditActions.length).toBeGreaterThan(0)
    expect(auditActions.every((a) => ['create', 'update', 'comment.create'].includes(a))).toBe(true)
    await kernel.destroy()
  })

  it('sources are skipped cleanly when their feature is off', async () => {
    // comments + audit off, but versions on: still get version events, no comment/audit.
    const cfg = defineConfig({
      secret: 'test-secret-32-characters-long!!!!',
      db: sqliteAdapter({ url: ':memory:' }),
      collections: [
        {
          slug: 'posts',
          versions: { drafts: true },
          access: { read: () => true, create: () => true, update: () => true },
          fields: [{ name: 'title', type: 'text', required: true }],
        },
        {
          // A non-versioned collection: no version events, and it must not throw.
          slug: 'plain',
          access: { read: () => true, create: () => true, update: () => true },
          fields: [{ name: 'title', type: 'text', required: true }],
        },
      ],
    })
    const kernel = await initKernel(cfg, { autoMigrate: true })

    const post = await kernel.create({ collection: 'posts', data: { title: 't0' }, req: editor as any })
    await kernel.update({ collection: 'posts', id: post.id, data: { title: 't1' }, req: editor as any })
    const feed = await kernel.documentActivity({ collection: 'posts', id: post.id, req: editor as any })
    const types = new Set(feed.events.map((e) => e.type))
    expect(types.has('version')).toBe(true)
    expect(types.has('comment')).toBe(false)
    expect(types.has('audit')).toBe(false)

    const plain = await kernel.create({ collection: 'plain', data: { title: 'p' }, req: editor as any })
    const plainFeed = await kernel.documentActivity({ collection: 'plain', id: plain.id, req: editor as any })
    expect(plainFeed.events.some((e) => e.type === 'version')).toBe(false)
    await kernel.destroy()
  })

  it("a comment by user A is visible in user B's feed (both can read), but B sees no audit", async () => {
    const kernel = await initKernel(publicConfig(), { autoMigrate: true })
    const post = await kernel.create({ collection: 'posts', data: { title: 'shared' }, req: editor as any })
    const comment = await kernel.addComment({ collection: 'posts', id: post.id, body: 'by A', req: viewer as any })

    const { events, includesReviewerEvents } = await kernel.documentActivity({
      collection: 'posts',
      id: post.id,
      req: viewerB as any,
    })

    expect(includesReviewerEvents).toBe(false)
    const commentEvent = events.find((e) => e.type === 'comment' && e.data.commentId === comment.id) as Ev
    expect(commentEvent).toBeTruthy()
    expect(commentEvent.actor.id).toBe('vw')
    expect(events.some((e) => e.type === 'audit')).toBe(false)
    await kernel.destroy()
  })
})
