import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { defineConfig, initKernel } from './index'
import type { Kernel } from './index'

// The agent review inbox: agents author drafts (attributed createdByType:'agent'), a
// human reviewer either approves (publish, via the existing publish gate) or requests
// changes (keep draft + note). The queue is DERIVED, not a new `_status`. These tests
// pin the derivation, the compose validation, and the disabled-returns-empty contract.

const isEditor = ({ req }: any) => Boolean(req.user?.roles?.includes('editor'))
const agent = {
  user: { id: 'bot', principalType: 'agent' as const, roles: [], fieldScope: { allow: ['title', 'body', 'layout'] } },
}
const editor = { user: { id: 'ed', roles: ['editor'] } }
const viewer = { user: { id: 'vw', roles: ['viewer'] } }

function reviewConfig(overrides: Record<string, unknown> = {}) {
  return defineConfig({
    secret: 'review-test-secret',
    db: sqliteAdapter({ url: ':memory:' }),
    audit: true,
    agents: [
      { id: 'bot', token: 'bot-token-review-test', roles: [], fieldScope: { allow: ['title', 'body', 'layout'] } },
    ],
    collections: [
      {
        slug: 'posts',
        versions: { drafts: true },
        access: { read: () => true, create: () => true, update: () => true, publish: isEditor },
        fields: [
          { name: 'title', type: 'text' },
          { name: 'body', type: 'text' },
          {
            name: 'layout',
            type: 'blocks',
            blocks: [
              { slug: 'hero', fields: [{ name: 'heading', type: 'text' }] },
              {
                slug: 'cta',
                fields: [
                  { name: 'label', type: 'text' },
                  { name: 'href', type: 'text' },
                ],
              },
            ],
          },
        ],
      },
    ],
    ...overrides,
  })
}

async function composeDraft(kernel: Kernel) {
  return kernel.composePage({
    collection: 'posts',
    blocks: [
      { type: 'hero', data: { heading: 'Hi' } },
      { type: 'cta', data: { label: 'Go', href: '/go' } },
    ],
    data: { title: 'Bot post' },
    req: agent,
  })
}

describe('composePage', () => {
  let kernel: Kernel
  beforeEach(async () => {
    kernel = await initKernel(reviewConfig(), { logLevel: 'error', autoMigrate: true })
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('assembles a valid layout as an agent-authored draft', async () => {
    const doc = await composeDraft(kernel)
    expect(doc._status).toBe('draft')
    expect(Array.isArray(doc.layout)).toBe(true)
    expect((doc.layout as Array<{ blockType: string }>).map((b) => b.blockType)).toEqual(['hero', 'cta'])
    const versions = await kernel.findVersions({ collection: 'posts', id: doc.id, overrideAccess: true })
    expect(versions.docs.some((v) => v.createdByType === 'agent')).toBe(true)
  })

  it('rejects an unknown block type', async () => {
    await expect(
      kernel.composePage({ collection: 'posts', blocks: [{ type: 'nope', data: {} }], req: agent }),
    ).rejects.toThrow(/unknown block type/i)
  })

  it('rejects an unknown block field', async () => {
    await expect(
      kernel.composePage({ collection: 'posts', blocks: [{ type: 'hero', data: { bogus: 'x' } }], req: agent }),
    ).rejects.toThrow(/no field/i)
  })

  it('rejects a prototype-pollution key in block data', async () => {
    await expect(
      kernel.composePage({
        collection: 'posts',
        blocks: [{ type: 'hero', data: JSON.parse('{"__proto__":"x"}') as Record<string, unknown> }],
        req: agent,
      }),
    ).rejects.toThrow(/illegal block field key/i)
  })

  it('errors when no field given and there is more than one blocks field', async () => {
    const kernel2 = await initKernel(
      reviewConfig({
        collections: [
          {
            slug: 'pages',
            versions: { drafts: true },
            access: { read: () => true, create: () => true, update: () => true, publish: isEditor },
            fields: [
              { name: 'a', type: 'blocks', blocks: [{ slug: 'hero', fields: [{ name: 'heading', type: 'text' }] }] },
              { name: 'b', type: 'blocks', blocks: [{ slug: 'hero', fields: [{ name: 'heading', type: 'text' }] }] },
            ],
          },
        ],
      }),
      { logLevel: 'error', autoMigrate: true },
    )
    await expect(
      kernel2.composePage({ collection: 'pages', blocks: [{ type: 'hero', data: {} }], req: agent }),
    ).rejects.toThrow(/multiple blocks fields/i)
    await kernel2.destroy()
  })
})

describe('findReviewQueue derivation', () => {
  let kernel: Kernel
  beforeEach(async () => {
    kernel = await initKernel(reviewConfig(), { logLevel: 'error', autoMigrate: true })
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('lists an agent-authored draft as pending', async () => {
    const doc = await composeDraft(kernel)
    const queue = await kernel.findReviewQueue({ req: editor })
    expect(queue.count).toBe(1)
    expect(queue.docs[0]?.id).toBe(doc.id)
    expect(queue.docs[0]?.createdBy).toBe('bot')
  })

  it('excludes a human-authored draft', async () => {
    await kernel.create({ collection: 'posts', data: { title: 'human', _status: 'draft' }, req: editor })
    const queue = await kernel.findReviewQueue({ req: editor })
    expect(queue.count).toBe(0)
  })

  it('keeps a changes_requested draft in the queue with the note', async () => {
    const doc = await composeDraft(kernel)
    await kernel.submitReview({
      collection: 'posts',
      id: doc.id,
      decision: 'request_changes',
      note: 'fix it',
      req: editor,
    })
    const queue = await kernel.findReviewQueue({ req: editor })
    const item = queue.docs.find((d) => d.id === doc.id)
    expect(item).toBeTruthy()
    expect(item?.lastReview?.decision).toBe('changes_requested')
    expect(item?.lastReview?.note).toBe('fix it')
  })

  it('flags revisedSince after the agent revises a changes_requested draft', async () => {
    const doc = await composeDraft(kernel)
    await kernel.submitReview({
      collection: 'posts',
      id: doc.id,
      decision: 'request_changes',
      note: 'fix it',
      req: editor,
    })
    await new Promise((r) => setTimeout(r, 10))
    await kernel.update({ collection: 'posts', id: doc.id, data: { body: 'revised' }, req: agent })
    const queue = await kernel.findReviewQueue({ req: editor })
    const item = queue.docs.find((d) => d.id === doc.id)
    expect(item?.revisedSince).toBe(true)
  })

  it('removes an approved draft from the queue', async () => {
    const doc = await composeDraft(kernel)
    await kernel.submitReview({ collection: 'posts', id: doc.id, decision: 'approve', req: editor })
    const queue = await kernel.findReviewQueue({ req: editor })
    expect(queue.docs.some((d) => d.id === doc.id)).toBe(false)
  })
})

describe('submitReview', () => {
  let kernel: Kernel
  beforeEach(async () => {
    kernel = await initKernel(reviewConfig(), { logLevel: 'error', autoMigrate: true })
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('approve publishes the draft (reusing the publish gate)', async () => {
    const doc = await composeDraft(kernel)
    const result = await kernel.submitReview({ collection: 'posts', id: doc.id, decision: 'approve', req: editor })
    expect(result.decision).toBe('approved')
    const published = await kernel.findByID({ collection: 'posts', id: doc.id })
    expect(published?._status).toBe('published')
  })

  it('rejects approve from a non-publisher (publish gate)', async () => {
    const doc = await composeDraft(kernel)
    await expect(
      kernel.submitReview({ collection: 'posts', id: doc.id, decision: 'approve', req: viewer }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const after = await kernel.findByID({ collection: 'posts', id: doc.id, draft: true, overrideAccess: true })
    expect(after?._status).toBe('draft')
  })

  it('request_changes keeps the doc a draft', async () => {
    const doc = await composeDraft(kernel)
    const result = await kernel.submitReview({
      collection: 'posts',
      id: doc.id,
      decision: 'request_changes',
      req: editor,
    })
    expect(result.decision).toBe('changes_requested')
    const after = await kernel.findByID({ collection: 'posts', id: doc.id, draft: true, overrideAccess: true })
    expect(after?._status).toBe('draft')
  })

  it('refuses to review a human-authored draft', async () => {
    const human = await kernel.create({ collection: 'posts', data: { title: 'human', _status: 'draft' }, req: editor })
    await expect(
      kernel.submitReview({ collection: 'posts', id: human.id, decision: 'approve', req: editor }),
    ).rejects.toThrow(/agent-authored/i)
  })

  it('records review.approve / review.request_changes in the audit log', async () => {
    const a = await composeDraft(kernel)
    await kernel.submitReview({ collection: 'posts', id: a.id, decision: 'request_changes', req: editor })
    const b = await composeDraft(kernel)
    await kernel.submitReview({ collection: 'posts', id: b.id, decision: 'approve', req: editor })
    const audit = await kernel.findAuditLog({ limit: 100 })
    const actions = audit.docs.map((d) => d.action)
    expect(actions).toContain('review.request_changes')
    expect(actions).toContain('review.approve')
  })
})

describe('review disabled (no agents, no review flag)', () => {
  let kernel: Kernel
  beforeEach(async () => {
    kernel = await initKernel(
      defineConfig({
        secret: 'review-off',
        db: sqliteAdapter({ url: ':memory:' }),
        collections: [{ slug: 'posts', versions: { drafts: true }, fields: [{ name: 'title', type: 'text' }] }],
      }),
      { logLevel: 'error', autoMigrate: true },
    )
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('findReviewQueue returns empty', async () => {
    const queue = await kernel.findReviewQueue()
    expect(queue).toEqual({ docs: [], count: 0 })
  })

  it('submitReview throws a disabled error', async () => {
    await expect(kernel.submitReview({ collection: 'posts', id: 'x', decision: 'approve' })).rejects.toThrow(
      /not enabled/i,
    )
  })

  it('composePage still works (it is just a create) and stays a normal draft', async () => {
    const kernel2 = await initKernel(
      defineConfig({
        secret: 'review-off-2',
        db: sqliteAdapter({ url: ':memory:' }),
        collections: [
          {
            slug: 'posts',
            versions: { drafts: true },
            access: { read: () => true, create: () => true, update: () => true },
            fields: [
              {
                name: 'layout',
                type: 'blocks',
                blocks: [{ slug: 'hero', fields: [{ name: 'heading', type: 'text' }] }],
              },
            ],
          },
        ],
      }),
      { logLevel: 'error', autoMigrate: true },
    )
    const doc = await kernel2.composePage({ collection: 'posts', blocks: [{ type: 'hero', data: { heading: 'x' } }] })
    expect(Array.isArray(doc.layout)).toBe(true)
    await kernel2.destroy()
  })
})
