import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { defineConfig, initKernel, sanitizeConfig } from './index'
import type { Kernel } from './index'

// Content lifecycle: a cron-driven drain retires PUBLISHED documents whose expiry
// (`expireField`) has passed. The inverse of scheduled publish. Three actions:
// unpublish (→ draft), archive (→ draft + `_archived_at`), delete (→ removed).

const admin = { req: { user: { id: 'u-admin', roles: ['admin'] } } }

function lifecycleConfig() {
  return defineConfig({
    secret: 'test-secret-32-characters-long!!!',
    db: sqliteAdapter({ url: ':memory:' }),
    audit: true,
    lifecycle: {
      collections: [
        { slug: 'posts', expireField: 'expire_at', onExpire: 'unpublish' },
        { slug: 'news', expireField: 'expire_at', onExpire: 'archive' },
        { slug: 'temp', expireField: 'expire_at', onExpire: 'delete' },
      ],
    },
    collections: [
      {
        slug: 'posts',
        versions: { drafts: true },
        access: { read: () => true, create: () => true, update: () => true, delete: () => true },
        fields: [
          { name: 'title', type: 'text' },
          { name: 'expire_at', type: 'date' },
        ],
      },
      {
        slug: 'news',
        versions: { drafts: true },
        access: { read: () => true, create: () => true, update: () => true, delete: () => true },
        fields: [
          { name: 'title', type: 'text' },
          { name: 'expire_at', type: 'date' },
        ],
      },
      {
        slug: 'temp',
        versions: { drafts: true },
        access: { read: () => true, create: () => true, update: () => true, delete: () => true },
        fields: [
          { name: 'title', type: 'text' },
          { name: 'expire_at', type: 'date' },
        ],
      },
    ],
  })
}

const PAST = '2020-01-01T00:00:00.000Z'
const FUTURE = '2999-01-01T00:00:00.000Z'
const NOW = new Date('2026-01-01T00:00:00.000Z')

async function publishedDoc(kernel: Kernel, collection: string, expireAt: string | null) {
  const doc = await kernel.create({
    collection,
    data: { title: 'doc', ...(expireAt ? { expire_at: expireAt } : {}) },
    ...admin,
  })
  await kernel.publish({ collection, id: doc.id, ...admin })
  return doc
}

describe('content lifecycle — expiry drain', () => {
  let kernel: Kernel

  beforeEach(async () => {
    kernel = await initKernel(lifecycleConfig(), { autoMigrate: true })
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('unpublishes a published doc whose expiry has passed', async () => {
    const past = await publishedDoc(kernel, 'posts', PAST)
    const result = await kernel.processContentLifecycle({ now: NOW })

    expect(result.processed).toContainEqual({ collection: 'posts', id: past.id, action: 'unpublish' })
    const reread = await kernel.findByID({ collection: 'posts', id: past.id, draft: true, ...admin })
    expect(reread?._status).toBe('draft')
  })

  it('leaves a future-expiry and a no-expiry published doc untouched', async () => {
    const future = await publishedDoc(kernel, 'posts', FUTURE)
    const none = await publishedDoc(kernel, 'posts', null)
    const result = await kernel.processContentLifecycle({ now: NOW })

    expect(result.processed).toHaveLength(0)
    expect((await kernel.findByID({ collection: 'posts', id: future.id, ...admin }))?._status).toBe('published')
    expect((await kernel.findByID({ collection: 'posts', id: none.id, ...admin }))?._status).toBe('published')
  })

  it('archives a past-expiry doc: draft + `_archived_at`, distinguishable from a plain draft', async () => {
    const expired = await publishedDoc(kernel, 'news', PAST)
    const plainDraft = await kernel.create({ collection: 'news', data: { title: 'plain' }, ...admin })

    const result = await kernel.processContentLifecycle({ now: NOW })
    expect(result.processed).toContainEqual({ collection: 'news', id: expired.id, action: 'archive' })

    const archived = await kernel.findByID({ collection: 'news', id: expired.id, draft: true, ...admin })
    expect(archived?._status).toBe('draft')
    expect(archived?._archived_at).toBe(NOW.toISOString())

    // A plain draft has NO `_archived_at` — the marker distinguishes archived from draft.
    const draft = await kernel.findByID({ collection: 'news', id: plainDraft.id, draft: true, ...admin })
    expect(draft?._status).toBe('draft')
    expect(draft?._archived_at ?? null).toBeNull()
  })

  it('does not re-archive an already-archived doc (idempotent)', async () => {
    const expired = await publishedDoc(kernel, 'news', PAST)
    await kernel.processContentLifecycle({ now: NOW })
    const second = await kernel.processContentLifecycle({ now: new Date(NOW.getTime() + 60_000) })
    expect(second.processed).not.toContainEqual({ collection: 'news', id: expired.id, action: 'archive' })
    // The original stamp is preserved (not overwritten by the second drain).
    const archived = await kernel.findByID({ collection: 'news', id: expired.id, draft: true, ...admin })
    expect(archived?._archived_at).toBe(NOW.toISOString())
  })

  it('deletes a past-expiry doc', async () => {
    const expired = await publishedDoc(kernel, 'temp', PAST)
    const result = await kernel.processContentLifecycle({ now: NOW })

    expect(result.processed).toContainEqual({ collection: 'temp', id: expired.id, action: 'delete' })
    expect(await kernel.findByID({ collection: 'temp', id: expired.id, draft: true, ...admin })).toBeNull()
  })

  it('`now` controls the cutoff deterministically', async () => {
    const at = '2026-06-01T00:00:00.000Z'
    const doc = await publishedDoc(kernel, 'posts', at)

    // Before the expiry: nothing due.
    const before = await kernel.processContentLifecycle({ now: new Date('2026-05-01T00:00:00.000Z') })
    expect(before.processed).toHaveLength(0)
    expect((await kernel.findByID({ collection: 'posts', id: doc.id, ...admin }))?._status).toBe('published')

    // At/after the expiry: due.
    const after = await kernel.processContentLifecycle({ now: new Date('2026-07-01T00:00:00.000Z') })
    expect(after.processed).toContainEqual({ collection: 'posts', id: doc.id, action: 'unpublish' })
  })

  it('audits each retirement with the action in meta', async () => {
    const post = await publishedDoc(kernel, 'posts', PAST)
    await kernel.processContentLifecycle({ now: NOW })

    const log = await kernel.findAuditLog({ where: { action: { equals: 'content.expire' } } })
    const entry = log.docs.find((d) => d.documentId === post.id)
    expect(entry).toBeTruthy()
    expect(entry?.principalType).toBe('system')
    expect((entry?.meta as { action?: string } | null)?.action).toBe('unpublish')
  })

  it('bounds the drain by `limit` (per collection)', async () => {
    for (let i = 0; i < 3; i++) await publishedDoc(kernel, 'posts', PAST)
    const result = await kernel.processContentLifecycle({ now: NOW, limit: 2 })
    expect(result.processed).toHaveLength(2)
  })

  it('a client cannot set `_archived_at` via a normal update (server-managed)', async () => {
    const doc = await publishedDoc(kernel, 'news', null)
    await kernel.update({
      collection: 'news',
      id: doc.id,
      data: { title: 'edited', _archived_at: NOW.toISOString() } as never,
      ...admin,
    })
    const reread = await kernel.findByID({ collection: 'news', id: doc.id, ...admin })
    expect(reread?._archived_at ?? null).toBeNull()
  })

  it('a client cannot CLEAR `_archived_at` via a normal update (un-archive)', async () => {
    const expired = await publishedDoc(kernel, 'news', PAST)
    await kernel.processContentLifecycle({ now: NOW })
    // Try to wipe the marker through a normal (non-override) write.
    await kernel.update({
      collection: 'news',
      id: expired.id,
      data: { title: 'tamper', _archived_at: null } as never,
      draft: true,
      ...admin,
    })
    const reread = await kernel.findByID({ collection: 'news', id: expired.id, draft: true, ...admin })
    expect(reread?._archived_at).toBe(NOW.toISOString())
  })

  it('is a no-op when lifecycle is not configured', async () => {
    const plain = await initKernel(
      defineConfig({
        secret: 'test-secret-32-characters-long!!!',
        db: sqliteAdapter({ url: ':memory:' }),
        collections: [{ slug: 'posts', versions: { drafts: true }, fields: [{ name: 'title', type: 'text' }] }],
      }),
      { autoMigrate: true },
    )
    expect(await plain.processContentLifecycle({ now: NOW })).toEqual({ processed: [] })
    await plain.destroy()
  })
})

describe('content lifecycle — config validation', () => {
  it('rejects a lifecycle collection that does not exist', async () => {
    expect(() =>
      sanitizeConfig({
        secret: 'test-secret-32-characters-long!!!',
        db: sqliteAdapter({ url: ':memory:' }),
        lifecycle: { collections: [{ slug: 'ghost' }] },
        collections: [{ slug: 'posts', versions: { drafts: true }, fields: [{ name: 'title', type: 'text' }] }],
      }),
    ).toThrow(/unknown collection/i)
  })

  it('rejects a lifecycle collection without drafts', async () => {
    expect(() =>
      sanitizeConfig({
        secret: 'test-secret-32-characters-long!!!',
        db: sqliteAdapter({ url: ':memory:' }),
        lifecycle: { collections: [{ slug: 'posts' }] },
        collections: [
          {
            slug: 'posts',
            fields: [
              { name: 'title', type: 'text' },
              { name: 'expire_at', type: 'date' },
            ],
          },
        ],
      }),
    ).toThrow(/drafts/i)
  })

  it('rejects a missing expire field', async () => {
    expect(() =>
      sanitizeConfig({
        secret: 'test-secret-32-characters-long!!!',
        db: sqliteAdapter({ url: ':memory:' }),
        lifecycle: { collections: [{ slug: 'posts' }] },
        collections: [{ slug: 'posts', versions: { drafts: true }, fields: [{ name: 'title', type: 'text' }] }],
      }),
    ).toThrow(/no field "expire_at"/i)
  })

  it('rejects an expire field that is not a date', async () => {
    expect(() =>
      sanitizeConfig({
        secret: 'test-secret-32-characters-long!!!',
        db: sqliteAdapter({ url: ':memory:' }),
        lifecycle: { collections: [{ slug: 'posts', expireField: 'title' }] },
        collections: [{ slug: 'posts', versions: { drafts: true }, fields: [{ name: 'title', type: 'text' }] }],
      }),
    ).toThrow(/must be a `date` field/i)
  })
})
