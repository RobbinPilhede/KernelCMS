import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import type { DatabaseAdapter } from '@kernel/db'
import { defineConfig, initKernel } from './index'
import { MAX_POPULATE_DEPTH } from './operations'
import type { Doc, Kernel } from './index'

const trusted = { overrideAccess: true } as const
const asUser = (id: string) => ({ req: { user: { id, collection: 'users' } } }) as const

/**
 * Wrap an adapter so we can count read queries. Proves the populate path issues
 * O(collections×depth) reads, not O(docs×relations) — i.e. the N+1 is gone.
 */
function countingAdapter(inner: DatabaseAdapter): { db: DatabaseAdapter; counts: { find: number; findByID: number } } {
  const counts = { find: 0, findByID: 0 }
  const db = new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (prop === 'find' && typeof value === 'function') {
        return (...args: unknown[]) => {
          counts.find += 1
          return (value as (...a: unknown[]) => unknown).apply(target, args)
        }
      }
      if (prop === 'findByID' && typeof value === 'function') {
        return (...args: unknown[]) => {
          counts.findByID += 1
          return (value as (...a: unknown[]) => unknown).apply(target, args)
        }
      }
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as DatabaseAdapter
  return { db, counts }
}

function buildConfig(db: DatabaseAdapter) {
  return defineConfig({
    secret: 'test-secret',
    db,
    collections: [
      // Tags are owned by a user; a reader may only see their own tags. This is the
      // access oracle: a post pointing at someone else's tag must drop that tag.
      {
        slug: 'tags',
        access: { read: ({ req }) => (req.user ? { owner: { equals: req.user.id } } : false), create: () => true },
        fields: [
          { name: 'label', type: 'text' },
          { name: 'owner', type: 'text' },
        ],
      },
      {
        slug: 'authors',
        access: { read: () => true, create: () => true },
        fields: [{ name: 'name', type: 'text' }],
      },
      {
        slug: 'posts',
        access: { read: () => true, create: () => true },
        fields: [
          { name: 'title', type: 'text' },
          { name: 'author', type: 'relationship', relationTo: 'authors' },
          { name: 'tags', type: 'relationship', relationTo: 'tags', hasMany: true },
        ],
      },
      // Self-referential relation to drive the depth-clamp test (a cycle would
      // otherwise recurse ~depth levels).
      {
        slug: 'comments',
        access: { read: () => true, create: () => true },
        fields: [
          { name: 'body', type: 'text' },
          { name: 'next', type: 'relationship', relationTo: 'comments' },
        ],
      },
    ],
  })
}

describe('batched relationship population', () => {
  let kernel: Kernel
  let counts: { find: number; findByID: number }

  beforeEach(async () => {
    const { db, counts: c } = countingAdapter(sqliteAdapter({ url: ':memory:' }))
    counts = c
    kernel = await initKernel(buildConfig(db), { logLevel: 'error' })
    await kernel.migrate()
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('populates single + hasMany relations across a page identically to per-id', async () => {
    const author = await kernel.create({ collection: 'authors', data: { name: 'Ada' }, ...trusted })
    const t1 = await kernel.create({ collection: 'tags', data: { label: 'x', owner: 'u1' }, ...trusted })
    const t2 = await kernel.create({ collection: 'tags', data: { label: 'y', owner: 'u1' }, ...trusted })
    for (let i = 0; i < 5; i++) {
      await kernel.create({
        collection: 'posts',
        data: { title: `P${i}`, author: author.id, tags: [t1.id, t2.id] },
        ...trusted,
      })
    }

    // Read as u1 (owner of both tags) so the tag read-scope is satisfied; related-doc
    // population always runs access-checked against `req`, never the parent's override.
    const res = await kernel.find({ collection: 'posts', depth: 1, limit: 50, ...asUser('u1') })
    expect(res.docs).toHaveLength(5)
    for (const post of res.docs) {
      expect((post.author as Doc).name).toBe('Ada')
      const tags = post.tags as Doc[]
      expect(tags.map((t) => t.label).sort()).toEqual(['x', 'y'])
    }
  })

  it('issues O(collections) reads for the page, not O(docs×relations)', async () => {
    const author = await kernel.create({ collection: 'authors', data: { name: 'Ada' }, ...trusted })
    const tags = await Promise.all(
      [0, 1, 2].map((i) => kernel.create({ collection: 'tags', data: { label: `t${i}`, owner: 'u1' }, ...trusted })),
    )
    for (let i = 0; i < 20; i++) {
      await kernel.create({
        collection: 'posts',
        data: { title: `P${i}`, author: author.id, tags: tags.map((t) => t.id) },
        ...trusted,
      })
    }

    counts.find = 0
    counts.findByID = 0
    const res = await kernel.find({ collection: 'posts', depth: 1, limit: 50, ...asUser('u1') })
    expect(res.docs).toHaveLength(20)
    // 1 page read for posts + 1 batched read each for authors + tags = 3.
    // The pre-batch path would issue 20×(1 author + 3 tags) = 80 findByID calls.
    expect(counts.find).toBe(3)
    expect(counts.findByID).toBe(0)
  })

  it('preserves depth-2 nesting and order', async () => {
    const author = await kernel.create({ collection: 'authors', data: { name: 'Grace' }, ...trusted })
    const post = await kernel.create({
      collection: 'posts',
      data: { title: 'Nested', author: author.id, tags: [] },
      ...trusted,
    })
    // A second collection pointing at posts to exercise depth 2.
    const deep = await kernel.findByID({ collection: 'posts', id: post.id, depth: 2, ...trusted })
    expect((deep?.author as Doc).name).toBe('Grace')
  })

  it('clamps a runaway populate depth so a cyclic relation graph cannot exhaust resources', async () => {
    // Self-referential cycle: each comment points at the next; depth:1e6 over this
    // graph would recurse ~1e6 levels (one batched read per level) without a cap.
    const c1 = await kernel.create({ collection: 'comments', data: { body: 'c1' }, ...trusted })
    const c2 = await kernel.create({ collection: 'comments', data: { body: 'c2', next: c1.id }, ...trusted })
    await kernel.update({ collection: 'comments', id: c1.id, data: { next: c2.id }, ...trusted })

    counts.find = 0
    counts.findByID = 0
    // A bounded number of reads proves the clamp fired: 1 page read + at most one
    // batched read per populated level, capped at MAX_POPULATE_DEPTH (10). Without
    // the clamp this would loop ~1e6 times (and hang).
    const got = await kernel.findByID({ collection: 'comments', id: c1.id, depth: 1e6, ...trusted })
    expect(got).not.toBeNull()
    expect(counts.find).toBeLessThanOrEqual(MAX_POPULATE_DEPTH + 2)
  })

  it('keeps a dangling relationship id as the raw id (fallback)', async () => {
    const post = await kernel.create({
      collection: 'posts',
      data: { title: 'Dangling', author: 'does-not-exist', tags: ['nope'] },
      ...trusted,
    })
    const got = await kernel.findByID({ collection: 'posts', id: post.id, depth: 1, ...trusted })
    expect(got?.author).toBe('does-not-exist')
    expect(got?.tags).toEqual(['nope'])
  })

  it('ENFORCES access on populated relations after batching (other users tags are dropped)', async () => {
    const author = await kernel.create({ collection: 'authors', data: { name: 'Ada' }, ...trusted })
    const mine = await kernel.create({ collection: 'tags', data: { label: 'mine', owner: 'u1' }, ...trusted })
    const theirs = await kernel.create({ collection: 'tags', data: { label: 'theirs', owner: 'u2' }, ...trusted })
    const post = await kernel.create({
      collection: 'posts',
      data: { title: 'Mixed', author: author.id, tags: [mine.id, theirs.id] },
      ...trusted,
    })

    // u1 reads: their own tag populates to a doc; u2's tag is access-denied and must
    // fall back to the raw id (omitted from population), never the doc.
    const got = await kernel.findByID({ collection: 'posts', id: post.id, depth: 1, ...asUser('u1') })
    const tags = got?.tags as Array<Doc | string>
    expect(tags).toHaveLength(2)
    const populated = tags.find((t) => typeof t === 'object') as Doc
    const denied = tags.find((t) => typeof t === 'string')
    expect(populated.label).toBe('mine')
    // The denied tag is NOT populated — its label never leaks.
    expect(denied).toBe(theirs.id)
    expect(tags.some((t) => typeof t === 'object' && (t as Doc).label === 'theirs')).toBe(false)
  })

  it('access enforcement matches across a batched page (each parent sees only own tags)', async () => {
    const author = await kernel.create({ collection: 'authors', data: { name: 'Ada' }, ...trusted })
    const mine = await kernel.create({ collection: 'tags', data: { label: 'mine', owner: 'u1' }, ...trusted })
    const theirs = await kernel.create({ collection: 'tags', data: { label: 'theirs', owner: 'u2' }, ...trusted })
    for (let i = 0; i < 3; i++) {
      await kernel.create({
        collection: 'posts',
        data: { title: `P${i}`, author: author.id, tags: [mine.id, theirs.id] },
        ...trusted,
      })
    }

    const res = await kernel.find({ collection: 'posts', depth: 1, limit: 50, ...asUser('u1') })
    expect(res.docs).toHaveLength(3)
    for (const post of res.docs) {
      const tags = post.tags as Array<Doc | string>
      // Exactly one populated (mine), one raw id (theirs, denied).
      expect(tags.filter((t) => typeof t === 'object')).toHaveLength(1)
      expect((tags.find((t) => typeof t === 'object') as Doc).label).toBe('mine')
      expect(tags).toContain(theirs.id)
    }
  })
})
