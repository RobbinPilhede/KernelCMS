import { describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { defineConfig, initKernel } from './index'
import type { Kernel } from './index'
import { changedFieldNames, deepEqual, diffDocs } from './timemachine'

// The content time-machine turns the existing version snapshots into a navigable timeline:
// point-in-time reads (asOf), a field-level change history, diffs between two points, and a
// restore-to-as-of through the normal write path. The security property under test: a
// historical read NEVER widens what a live read would expose (doc access + field stripping).

describe('diffDocs / deepEqual (pure)', () => {
  it('deepEqual compares structurally, order-independent for objects', () => {
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true)
    expect(deepEqual([1, 2, 3], [1, 2, 3])).toBe(true)
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false)
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false)
    expect(deepEqual(null, undefined)).toBe(false)
    expect(deepEqual(NaN, NaN)).toBe(true)
  })

  it('deepEqual reports richText-like nested objects changed on any nested diff', () => {
    const a = { type: 'doc', content: [{ type: 'p', text: 'hello' }] }
    const b = { type: 'doc', content: [{ type: 'p', text: 'world' }] }
    expect(deepEqual(a, b)).toBe(false)
    expect(deepEqual(a, structuredClone(a))).toBe(true)
  })

  it('diffDocs returns only changed fields with from/to, restricted to fieldNames', () => {
    const before = { title: 'A', body: 'one', secret: 'x' }
    const after = { title: 'B', body: 'one', secret: 'y' }
    // `secret` is intentionally excluded from fieldNames — a read-denied field must not leak.
    const diff = diffDocs(before, after, ['title', 'body'])
    expect(diff).toEqual({ title: { from: 'A', to: 'B' } })
    expect('secret' in diff).toBe(false)
  })

  it('changedFieldNames lists the changed field names only', () => {
    expect(changedFieldNames({ a: 1, b: 2 }, { a: 1, b: 9 }, ['a', 'b'])).toEqual(['b'])
    expect(changedFieldNames({ a: 1 }, { a: 1 }, ['a'])).toEqual([])
  })
})

function postsConfig() {
  return defineConfig({
    secret: 'test-secret',
    db: sqliteAdapter({ url: ':memory:' }),
    collections: [
      {
        slug: 'posts',
        versions: { drafts: true },
        access: { read: () => true, create: () => true, update: () => true },
        fields: [
          { name: 'title', type: 'text' },
          { name: 'body', type: 'text' },
        ],
      },
    ],
  })
}

async function capture(kernel: Kernel, id: string): Promise<string[]> {
  const v = await kernel.findVersions({ collection: 'posts', id })
  // findVersions is newest-first; return createdAt oldest-first for readability.
  return v.docs.map((d) => String(d.createdAt)).reverse()
}

describe('time-machine ops', () => {
  it('asOf snapshot selection returns the state at that instant', async () => {
    const kernel = await initKernel(postsConfig(), { autoMigrate: true })
    const post = await kernel.create({ collection: 'posts', data: { title: 't0', body: 'b0' } })
    await new Promise((r) => setTimeout(r, 5))
    await kernel.update({ collection: 'posts', id: post.id, data: { title: 't1' } })
    const at = await capture(kernel, post.id)

    const between = new Date(new Date(at[1]!).getTime() - 1).toISOString()
    const asOf0 = await kernel.findByID({ collection: 'posts', id: post.id, asOf: between, draft: true })
    expect(asOf0?.title).toBe('t0')

    const before = new Date(new Date(at[0]!).getTime() - 1000).toISOString()
    expect(await kernel.findByID({ collection: 'posts', id: post.id, asOf: before, draft: true })).toBeNull()

    const now = await kernel.findByID({ collection: 'posts', id: post.id, asOf: new Date().toISOString(), draft: true })
    expect(now?.title).toBe('t1')

    // Published-only default: without draft:true a historical DRAFT is hidden, exactly like a
    // live read — the time-machine must not surface a draft a normal read would null.
    expect(await kernel.findByID({ collection: 'posts', id: post.id, asOf: between })).toBeNull()
    await kernel.destroy()
  })

  it('history changedFields: create -> all, then per-edit field sets', async () => {
    const kernel = await initKernel(postsConfig(), { autoMigrate: true })
    const post = await kernel.create({ collection: 'posts', data: { title: 't0', body: 'b0' } })
    await kernel.update({ collection: 'posts', id: post.id, data: { title: 't1' } })
    await kernel.update({ collection: 'posts', id: post.id, data: { body: 'b2' } })

    const hist = await kernel.history({ collection: 'posts', id: post.id })
    expect(hist.length).toBe(3)
    expect(hist[0]!.changedFields.sort()).toEqual(['body', 'title'])
    expect(hist[1]!.changedFields).toEqual(['title'])
    expect(hist[2]!.changedFields).toEqual(['body'])
    await kernel.destroy()
  })

  it('asOf and history strip a read-denied field', async () => {
    const config = defineConfig({
      secret: 'test-secret',
      db: sqliteAdapter({ url: ':memory:' }),
      collections: [
        {
          slug: 'posts',
          versions: { drafts: true },
          access: { read: () => true, create: () => true, update: () => true },
          fields: [
            { name: 'title', type: 'text' },
            // Never readable: must vanish from asOf reads AND from history changedFields.
            { name: 'classified', type: 'text', access: { read: () => false } },
          ],
        },
      ],
    })
    const kernel = await initKernel(config, { autoMigrate: true })
    const post = await kernel.create({ collection: 'posts', data: { title: 't0', classified: 'secret-0' } })
    await kernel.update({ collection: 'posts', id: post.id, data: { classified: 'secret-1' } })

    const asOf = await kernel.findByID({
      collection: 'posts',
      id: post.id,
      asOf: new Date().toISOString(),
      draft: true,
    })
    expect(asOf?.title).toBe('t0')
    expect('classified' in (asOf as object)).toBe(false)

    const hist = await kernel.history({ collection: 'posts', id: post.id })
    for (const entry of hist) expect(entry.changedFields).not.toContain('classified')
    await kernel.destroy()
  })

  it('asOf on a non-versioned collection throws a BadRequestError', async () => {
    const config = defineConfig({
      secret: 'test-secret',
      db: sqliteAdapter({ url: ':memory:' }),
      collections: [
        { slug: 'plain', access: { read: () => true, create: () => true }, fields: [{ name: 'title', type: 'text' }] },
      ],
    })
    const kernel = await initKernel(config, { autoMigrate: true })
    const doc = await kernel.create({ collection: 'plain', data: { title: 'x' } })
    await expect(kernel.findByID({ collection: 'plain', id: doc.id, asOf: new Date().toISOString() })).rejects.toThrow(
      /versions/i,
    )
    await kernel.destroy()
  })
})
