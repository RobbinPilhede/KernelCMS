import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { defineConfig, initKernel } from './index'
import type { Kernel } from './index'

// Editorial comments / annotations: threaded review feedback on documents, gated by the
// target document's READ access. You can only comment on / see comments for a document you
// can read; the author is recorded from the authenticated principal (never client input);
// resolve/delete are gated to the author or an admin/editor. These tests pin the access
// gate, the author-from-principal guarantee, the resolve/delete authz, and validation.

const ownerRead = ({ req }: any) => {
  if (req.user?.roles?.includes('admin')) return true
  return { owner: { equals: req.user?.id ?? '__none__' } }
}

const alice = { user: { id: 'alice', roles: ['viewer'] } }
const bob = { user: { id: 'bob', roles: ['viewer'] } }
const editor = { user: { id: 'ed', roles: ['editor'] } }
const admin = { user: { id: 'adm', roles: ['admin'] } }

function commentsConfig(overrides: Record<string, unknown> = {}) {
  return defineConfig({
    secret: 'comments-test-secret',
    db: sqliteAdapter({ url: ':memory:' }),
    audit: true,
    comments: true,
    collections: [
      {
        slug: 'posts',
        access: { read: () => true, create: () => true, update: () => true },
        fields: [
          { name: 'title', type: 'text' },
          { name: 'body', type: 'text' },
        ],
      },
      {
        // Owner-scoped: a row is only readable by its owner (or an admin).
        slug: 'secrets',
        access: { read: ownerRead, create: () => true, update: () => true },
        fields: [
          { name: 'owner', type: 'text' },
          { name: 'note', type: 'text' },
        ],
      },
    ],
    ...overrides,
  })
}

describe('addComment', () => {
  let kernel: Kernel
  beforeEach(async () => {
    kernel = await initKernel(commentsConfig(), { logLevel: 'error', autoMigrate: true })
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('stores a comment with the author from the principal and lists it', async () => {
    const post = await kernel.create({ collection: 'posts', data: { title: 'Hello' }, ...alice })
    const c = await kernel.addComment({ collection: 'posts', id: post.id, body: '  needs work  ', req: alice })
    expect(c.body).toBe('needs work') // trimmed
    expect(c.authorId).toBe('alice')
    expect(c.resolved).toBe(false)
    const list = await kernel.listComments({ collection: 'posts', id: post.id, req: alice })
    expect(list.map((x) => x.id)).toEqual([c.id])
  })

  it('records the author from the principal, ignoring a forged authorId', async () => {
    const post = await kernel.create({ collection: 'posts', data: { title: 'x' }, ...alice })
    const c = await kernel.addComment({
      collection: 'posts',
      id: post.id,
      body: 'hi',
      // Forged author fields — must be ignored.
      authorId: 'bob',
      authorType: 'admin',
      req: alice,
    } as never)
    expect(c.authorId).toBe('alice')
    expect(c.authorType).toBe('user')
  })

  it('supports a threaded reply on the same document', async () => {
    const post = await kernel.create({ collection: 'posts', data: { title: 'x' }, ...alice })
    const root = await kernel.addComment({ collection: 'posts', id: post.id, body: 'root', req: alice })
    const reply = await kernel.addComment({
      collection: 'posts',
      id: post.id,
      body: 'reply',
      parentId: root.id,
      req: bob,
    })
    expect(reply.parentId).toBe(root.id)
  })

  it('validates and stores a field anchor; rejects an invalid field', async () => {
    const post = await kernel.create({ collection: 'posts', data: { title: 'x' }, ...alice })
    const c = await kernel.addComment({
      collection: 'posts',
      id: post.id,
      body: 'on title',
      field: 'title',
      req: alice,
    })
    expect(c.field).toBe('title')
    await expect(
      kernel.addComment({ collection: 'posts', id: post.id, body: 'bad', field: 'not_a_field', req: alice }),
    ).rejects.toThrow()
  })

  it('rejects a parentId from a different document', async () => {
    const a = await kernel.create({ collection: 'posts', data: { title: 'a' }, ...alice })
    const b = await kernel.create({ collection: 'posts', data: { title: 'b' }, ...alice })
    const onA = await kernel.addComment({ collection: 'posts', id: a.id, body: 'on a', req: alice })
    await expect(
      kernel.addComment({ collection: 'posts', id: b.id, body: 'reply', parentId: onA.id, req: alice }),
    ).rejects.toThrow()
  })

  it('rejects empty / oversized bodies and a __proto__ field', async () => {
    const post = await kernel.create({ collection: 'posts', data: { title: 'x' }, ...alice })
    await expect(kernel.addComment({ collection: 'posts', id: post.id, body: '   ', req: alice })).rejects.toThrow()
    await expect(
      kernel.addComment({ collection: 'posts', id: post.id, body: 'a'.repeat(10_001), req: alice }),
    ).rejects.toThrow()
    await expect(
      kernel.addComment({ collection: 'posts', id: post.id, body: 'x', field: '__proto__', req: alice }),
    ).rejects.toThrow()
  })

  it('rejects an anonymous comment', async () => {
    const post = await kernel.create({ collection: 'posts', data: { title: 'x' }, ...alice })
    await expect(kernel.addComment({ collection: 'posts', id: post.id, body: 'hi' })).rejects.toThrow()
  })
})

describe('comments respect document read access', () => {
  let kernel: Kernel
  beforeEach(async () => {
    kernel = await initKernel(commentsConfig(), { logLevel: 'error', autoMigrate: true })
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('forbids commenting on a document the caller cannot read', async () => {
    const secret = await kernel.create({ collection: 'secrets', data: { owner: 'alice', note: 's' }, ...alice })
    // Bob cannot read alice's secret.
    await expect(kernel.addComment({ collection: 'secrets', id: secret.id, body: 'peek', req: bob })).rejects.toThrow()
    await expect(kernel.listComments({ collection: 'secrets', id: secret.id, req: bob })).rejects.toThrow()
    // The owner can.
    const c = await kernel.addComment({ collection: 'secrets', id: secret.id, body: 'mine', req: alice })
    expect(c.authorId).toBe('alice')
    const list = await kernel.listComments({ collection: 'secrets', id: secret.id, req: alice })
    expect(list).toHaveLength(1)
  })

  it('holds an anonymous Local-API caller (no req.user) to the document read rule', async () => {
    // Regression: an anonymous Local-API/embedder call (no req.user, no overrideAccess)
    // must NOT bypass the target-document read gate. Previously `assertCanCommentOn`
    // short-circuited on `!req.user`, leaking comment bodies/authors/counts and letting
    // anonymous callers resolve/delete on docs they can't read.
    const secret = await kernel.create({ collection: 'secrets', data: { owner: 'alice', note: 's' }, ...alice })
    const c = await kernel.addComment({ collection: 'secrets', id: secret.id, body: 'mine', req: alice })

    // No req.user → owner-scoped rule resolves to `__none__`, so the doc is unreadable.
    const anon = {} as Record<string, unknown>
    await expect(kernel.listComments({ collection: 'secrets', id: secret.id, ...anon })).rejects.toThrow()
    await expect(kernel.commentCount({ collection: 'secrets', id: secret.id, ...anon })).rejects.toThrow()
    await expect(kernel.addComment({ collection: 'secrets', id: secret.id, body: 'x', ...anon })).rejects.toThrow()
    await expect(kernel.resolveComment({ commentId: c.id, ...anon })).rejects.toThrow()
    await expect(kernel.deleteComment({ commentId: c.id, ...anon })).rejects.toThrow()

    // The comment is untouched and still visible to its rightful reader.
    const list = await kernel.listComments({ collection: 'secrets', id: secret.id, req: alice })
    expect(list).toHaveLength(1)
    expect(list[0].resolved).toBe(false)

    // A public-read document is still anonymously readable (the gate is the doc rule,
    // not a blanket auth requirement) — listing/counting works, but adding still needs a user.
    const post = await kernel.create({ collection: 'posts', data: { title: 'x' }, ...alice })
    await kernel.addComment({ collection: 'posts', id: post.id, body: 'hi', req: alice })
    expect(await kernel.listComments({ collection: 'posts', id: post.id, ...anon })).toHaveLength(1)
    expect(await kernel.commentCount({ collection: 'posts', id: post.id, ...anon })).toBe(1)
    await expect(kernel.addComment({ collection: 'posts', id: post.id, body: 'no', ...anon })).rejects.toThrow()
  })
})

describe('resolveComment / deleteComment authz', () => {
  let kernel: Kernel
  beforeEach(async () => {
    kernel = await initKernel(commentsConfig(), { logLevel: 'error', autoMigrate: true })
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('only the author or a reviewer can resolve; a random user cannot', async () => {
    const post = await kernel.create({ collection: 'posts', data: { title: 'x' }, ...alice })
    const c = await kernel.addComment({ collection: 'posts', id: post.id, body: 'note', req: alice })
    // Bob (read access but not author / reviewer) cannot resolve.
    await expect(kernel.resolveComment({ commentId: c.id, req: bob })).rejects.toThrow()
    // The author can.
    const resolved = await kernel.resolveComment({ commentId: c.id, req: alice })
    expect(resolved.resolved).toBe(true)
    // An editor (reviewer) can unresolve someone else's comment.
    const reopened = await kernel.resolveComment({ commentId: c.id, resolved: false, req: editor })
    expect(reopened.resolved).toBe(false)
  })

  it('only the author or an admin can delete', async () => {
    const post = await kernel.create({ collection: 'posts', data: { title: 'x' }, ...alice })
    const c = await kernel.addComment({ collection: 'posts', id: post.id, body: 'note', req: alice })
    await expect(kernel.deleteComment({ commentId: c.id, req: bob })).rejects.toThrow()
    // An editor is NOT enough to delete (only author or admin).
    await expect(kernel.deleteComment({ commentId: c.id, req: editor })).rejects.toThrow()
    const del = await kernel.deleteComment({ commentId: c.id, req: admin })
    expect(del.id).toBe(c.id)
    expect(await kernel.listComments({ collection: 'posts', id: post.id, req: alice })).toHaveLength(0)
  })
})

describe('listComments filtering + commentCount', () => {
  let kernel: Kernel
  beforeEach(async () => {
    kernel = await initKernel(commentsConfig(), { logLevel: 'error', autoMigrate: true })
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('hides resolved comments unless includeResolved, and counts accordingly', async () => {
    const post = await kernel.create({ collection: 'posts', data: { title: 'x' }, ...alice })
    const a = await kernel.addComment({ collection: 'posts', id: post.id, body: 'one', req: alice })
    await kernel.addComment({ collection: 'posts', id: post.id, body: 'two', req: alice })
    await kernel.resolveComment({ commentId: a.id, req: alice })
    expect(await kernel.listComments({ collection: 'posts', id: post.id, req: alice })).toHaveLength(1)
    expect(
      await kernel.listComments({ collection: 'posts', id: post.id, includeResolved: true, req: alice }),
    ).toHaveLength(2)
    expect(await kernel.commentCount({ collection: 'posts', id: post.id, req: alice })).toBe(1)
    expect(await kernel.commentCount({ collection: 'posts', id: post.id, includeResolved: true, req: alice })).toBe(2)
  })
})

describe('comments disabled / system-table isolation', () => {
  it('ops are no-ops/throw cleanly when comments are disabled', async () => {
    const kernel = await initKernel(commentsConfig({ comments: false }), { logLevel: 'error', autoMigrate: true })
    const post = await kernel.create({ collection: 'posts', data: { title: 'x' }, ...alice })
    expect(await kernel.listComments({ collection: 'posts', id: post.id, req: alice })).toEqual([])
    await expect(kernel.addComment({ collection: 'posts', id: post.id, body: 'x', req: alice })).rejects.toThrow()
    await kernel.destroy()
  })

  it('_comments is not reachable via generic CRUD', async () => {
    const kernel = await initKernel(commentsConfig(), { logLevel: 'error', autoMigrate: true })
    await expect(kernel.find({ collection: '_comments', ...alice })).rejects.toThrow()
    await expect(
      kernel.create({ collection: '_comments', data: { body: 'x' }, overrideAccess: true }),
    ).rejects.toThrow()
    await kernel.destroy()
  })
})
