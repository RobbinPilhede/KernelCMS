import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { defineConfig, initKernel } from './index'
import { isKernelError } from './errors'
import type { Doc, Kernel } from './index'

const trusted = { overrideAccess: true } as const

// One config exercising every onDelete variant: restrict, setNull (single + hasMany),
// cascade (including a self-referential cycle), polymorphic, and a default (no onDelete).
function buildConfig() {
  return defineConfig({
    secret: 'test-secret',
    db: sqliteAdapter({ url: ':memory:' }),
    collections: [
      { slug: 'authors', access: { read: () => true }, fields: [{ name: 'name', type: 'text' }] },
      { slug: 'tags', access: { read: () => true }, fields: [{ name: 'label', type: 'text' }] },
      {
        slug: 'posts',
        access: { read: () => true },
        fields: [
          { name: 'title', type: 'text' },
          // restrict: deleting an author with posts is blocked.
          { name: 'author', type: 'relationship', relationTo: 'authors', onDelete: 'restrict' },
          // setNull single: clearing a tag nulls this; hasMany: pulled from the list.
          { name: 'primary_tag', type: 'relationship', relationTo: 'tags', onDelete: 'setNull' },
          { name: 'tags', type: 'relationship', relationTo: 'tags', hasMany: true, onDelete: 'setNull' },
          // default (no onDelete): legacy dangling behaviour.
          { name: 'reviewer', type: 'relationship', relationTo: 'authors' },
        ],
      },
      {
        slug: 'comments',
        access: { read: () => true },
        fields: [
          { name: 'body', type: 'text' },
          // cascade: deleting a post deletes its comments.
          { name: 'post', type: 'relationship', relationTo: 'posts', onDelete: 'cascade' },
          // self-referential cascade: a reply points at its parent comment.
          { name: 'parent', type: 'relationship', relationTo: 'comments', onDelete: 'cascade' },
        ],
      },
      {
        slug: 'reactions',
        access: { read: () => true },
        fields: [
          { name: 'emoji', type: 'text' },
          // polymorphic setNull: may target a post OR a comment.
          { name: 'subject', type: 'relationship', relationTo: ['posts', 'comments'], onDelete: 'setNull' },
        ],
      },
    ],
  })
}

let kernel: Kernel
beforeEach(async () => {
  kernel = await initKernel(buildConfig(), { logLevel: 'error' })
  await kernel.migrate()
})
afterEach(async () => {
  await kernel.destroy()
})

describe('onDelete referential integrity', () => {
  it('restrict blocks deletion while a referrer exists and allows it when none', async () => {
    const author = await kernel.create({ collection: 'authors', data: { name: 'Ada' }, ...trusted })
    const post = await kernel.create({
      collection: 'posts',
      data: { title: 'Hello', author: author.id },
      ...trusted,
    })

    await expect(kernel.delete({ collection: 'authors', id: author.id, ...trusted })).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    // The author is still there — the delete was aborted.
    expect(await kernel.findByID({ collection: 'authors', id: author.id, ...trusted })).not.toBeNull()

    // Remove the referrer; the delete now succeeds.
    await kernel.delete({ collection: 'posts', id: post.id, ...trusted })
    await kernel.delete({ collection: 'authors', id: author.id, ...trusted })
    expect(await kernel.findByID({ collection: 'authors', id: author.id, ...trusted })).toBeNull()
  })

  it('setNull nulls a single ref and pulls from a hasMany array', async () => {
    const t1 = await kernel.create({ collection: 'tags', data: { label: 'one' }, ...trusted })
    const t2 = await kernel.create({ collection: 'tags', data: { label: 'two' }, ...trusted })
    const post = await kernel.create({
      collection: 'posts',
      data: { title: 'Tagged', primary_tag: t1.id, tags: [t1.id, t2.id] },
      ...trusted,
    })

    await kernel.delete({ collection: 'tags', id: t1.id, ...trusted })

    const after = await kernel.findByID({ collection: 'posts', id: post.id, ...trusted })
    expect(after?.primary_tag).toBeNull()
    expect(after?.tags).toEqual([t2.id])
  })

  it('cascade deletes referrers', async () => {
    const post = await kernel.create({ collection: 'posts', data: { title: 'P' }, ...trusted })
    const c1 = await kernel.create({ collection: 'comments', data: { body: 'a', post: post.id }, ...trusted })
    const c2 = await kernel.create({ collection: 'comments', data: { body: 'b', post: post.id }, ...trusted })

    await kernel.delete({ collection: 'posts', id: post.id, ...trusted })

    expect(await kernel.findByID({ collection: 'comments', id: c1.id, ...trusted })).toBeNull()
    expect(await kernel.findByID({ collection: 'comments', id: c2.id, ...trusted })).toBeNull()
  })

  it('nested cascade honors the visited guard on a reference cycle', async () => {
    // a <-> b each cascade-point at the other; deleting a must not loop forever.
    const a = await kernel.create({ collection: 'comments', data: { body: 'a' }, ...trusted })
    const b = await kernel.create({ collection: 'comments', data: { body: 'b', parent: a.id }, ...trusted })
    await kernel.update({ collection: 'comments', id: a.id, data: { parent: b.id }, ...trusted })

    await kernel.delete({ collection: 'comments', id: a.id, ...trusted })

    expect(await kernel.findByID({ collection: 'comments', id: a.id, ...trusted })).toBeNull()
    expect(await kernel.findByID({ collection: 'comments', id: b.id, ...trusted })).toBeNull()
  })

  it('handles a polymorphic relationTo (setNull on the matching member)', async () => {
    const post = await kernel.create({ collection: 'posts', data: { title: 'Poly' }, ...trusted })
    const reaction = await kernel.create({
      collection: 'reactions',
      data: { emoji: '🔥', subject: { relationTo: 'posts', value: post.id } },
      ...trusted,
    })

    await kernel.delete({ collection: 'posts', id: post.id, ...trusted })

    const after = await kernel.findByID({ collection: 'reactions', id: reaction.id, depth: 0, ...trusted })
    expect(after?.subject).toBeNull()
  })

  it('leaves references dangling by default (no onDelete) — unchanged behaviour', async () => {
    const reviewer = await kernel.create({ collection: 'authors', data: { name: 'Rev' }, ...trusted })
    const post = await kernel.create({
      collection: 'posts',
      data: { title: 'Dangle', reviewer: reviewer.id },
      ...trusted,
    })

    await kernel.delete({ collection: 'authors', id: reviewer.id, ...trusted })

    // The post still holds the now-dangling id at depth 0.
    const raw = await kernel.findByID({ collection: 'posts', id: post.id, depth: 0, ...trusted })
    expect(raw?.reviewer).toBe(reviewer.id)
    // populate tolerates the missing target (falls back to the raw id).
    const populated = await kernel.findByID({ collection: 'posts', id: post.id, depth: 1, ...trusted })
    expect(populated?.reviewer).toBe(reviewer.id)
  })
})

// Agent-initiated cascades must flow through the SAME access pipeline as the agent's
// own writes: an agent's one authorized delete must NOT cascade/setNull into referrer
// docs the agent cannot access. A human keeps the trusted (overrideAccess) cascade.
function cascadeAccessConfig() {
  return defineConfig({
    secret: 'test-secret',
    db: sqliteAdapter({ url: ':memory:' }),
    collections: [
      // The delete TARGET: anyone may delete it (the agent holds this grant).
      { slug: 'posts', access: { read: () => true, delete: () => true }, fields: [{ name: 'title', type: 'text' }] },
      // The REFERRER: only its owner ('u-owner') may delete/update it. An agent that is
      // not the owner has NO access — its cascade into a comment must be rejected.
      {
        slug: 'comments',
        access: {
          read: () => true,
          delete: ({ req }) => req.user?.id === 'u-owner',
          update: ({ req }) => req.user?.id === 'u-owner',
        },
        fields: [
          { name: 'body', type: 'text' },
          { name: 'post', type: 'relationship', relationTo: 'posts', onDelete: 'cascade' },
        ],
      },
    ],
  })
}

describe('agent-initiated cascade is access-checked (authorization blast radius)', () => {
  let kernel: Kernel
  let postId: string
  let commentId: string

  beforeEach(async () => {
    kernel = await initKernel(cascadeAccessConfig(), { logLevel: 'error' })
    await kernel.migrate()
    const post = await kernel.create({ collection: 'posts', data: { title: 'P' }, ...trusted })
    postId = post.id
    const comment = await kernel.create({ collection: 'comments', data: { body: 'c', post: post.id }, ...trusted })
    commentId = comment.id
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('rejects the delete (ForbiddenError) and leaves both target and referrer intact when the agent cannot access the referrer', async () => {
    const agent = { user: { id: 'agent-x', principalType: 'agent' as const, roles: [] } }
    await expect(kernel.delete({ collection: 'posts', id: postId, req: agent })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    // Fail-closed: the post is NOT deleted (cascade aborted before the target was removed)…
    expect(await kernel.findByID({ collection: 'posts', id: postId, ...trusted })).not.toBeNull()
    // …and the referrer the agent could not touch is untouched.
    expect(await kernel.findByID({ collection: 'comments', id: commentId, ...trusted })).not.toBeNull()
  })

  it('a human with the same config still cascades successfully (unchanged behaviour)', async () => {
    // The owner (human, no principalType) cascades the comment as before via the
    // trusted override path.
    const human = { user: { id: 'u-owner', collection: 'users', roles: [] } }
    await kernel.delete({ collection: 'posts', id: postId, req: human })
    expect(await kernel.findByID({ collection: 'posts', id: postId, ...trusted })).toBeNull()
    expect(await kernel.findByID({ collection: 'comments', id: commentId, ...trusted })).toBeNull()
  })
})

// Sanity: the typed error really is a KernelError surfaced as CONFLICT.
it('restrict throws a typed KernelError', async () => {
  const k = await initKernel(buildConfig(), { logLevel: 'error' })
  await k.migrate()
  try {
    const author = await k.create({ collection: 'authors', data: { name: 'X' }, ...trusted })
    await k.create({ collection: 'posts', data: { title: 'T', author: author.id }, ...trusted })
    let caught: unknown
    try {
      await k.delete({ collection: 'authors', id: author.id, ...trusted })
    } catch (err) {
      caught = err
    }
    expect(isKernelError(caught)).toBe(true)
  } finally {
    await k.destroy()
  }
})
