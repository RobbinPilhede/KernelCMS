import { beforeEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { initKernel } from '@kernel/core'
import type { AccessArgs, AuthUser, Kernel } from '@kernel/core'
import { createRequestHandler } from './index'

// The editorial-comments routes. AUTH-REQUIRED and gated by the target document's READ
// access in core; the author is the server-resolved `user` only (never the client body).
// GET/POST live under /:collection/:id/comments; resolve/delete under /_admin/comments/:id
// with author-or-reviewer / author-or-admin authz enforced by core.

const ownerRead = ({ req }: AccessArgs) => {
  if (req.user?.roles?.includes('admin')) return true
  return { owner: { equals: req.user?.id ?? '__none__' } }
}

let kernel: Kernel

beforeEach(async () => {
  kernel = await initKernel(
    {
      secret: 'comments-route-test',
      db: sqliteAdapter({ url: ':memory:' }),
      comments: true,
      collections: [
        {
          slug: 'posts',
          access: { read: () => true, create: () => true, update: () => true },
          fields: [{ name: 'title', type: 'text' }],
        },
        {
          slug: 'secrets',
          access: { read: ownerRead, create: () => true, update: () => true },
          fields: [
            { name: 'owner', type: 'text' },
            { name: 'note', type: 'text' },
          ],
        },
      ],
    },
    { logLevel: 'error', autoMigrate: true },
  )
})

const alice: AuthUser = { id: 'alice', roles: ['viewer'], collection: 'users' } as AuthUser
const bob: AuthUser = { id: 'bob', roles: ['viewer'], collection: 'users' } as AuthUser
const admin: AuthUser = { id: 'adm', roles: ['admin'], collection: 'users' } as AuthUser

const withUser = (user: AuthUser | null) => ({
  getUser: (): AuthUser | null => user,
  rateLimit: { enabled: false } as const,
})

describe('/api/:collection/:id/comments', () => {
  it('returns 401 when unauthenticated', async () => {
    const post = await kernel.create({ collection: 'posts', data: { title: 'x' }, req: { user: alice } })
    const handler = createRequestHandler(kernel, { rateLimit: { enabled: false } })
    const res = await handler(new Request(`http://localhost/api/posts/${post.id}/comments`))
    expect(res.status).toBe(401)
  })

  it('adds and lists a comment, recording the author from the principal', async () => {
    const post = await kernel.create({ collection: 'posts', data: { title: 'x' }, req: { user: alice } })
    const handler = createRequestHandler(kernel, withUser(alice))
    const created = await handler(
      new Request(`http://localhost/api/posts/${post.id}/comments`, {
        method: 'POST',
        // A forged authorId in the body must be ignored.
        body: JSON.stringify({ body: 'needs work', authorId: 'bob' }),
      }),
    )
    expect(created.status).toBe(201)
    const c = (await created.json()) as { id: string; authorId: string }
    expect(c.authorId).toBe('alice')

    const listed = await handler(new Request(`http://localhost/api/posts/${post.id}/comments`))
    expect(listed.status).toBe(200)
    const body = (await listed.json()) as { comments: Array<{ id: string }> }
    expect(body.comments.map((x) => x.id)).toEqual([c.id])
  })

  it('forbids listing comments on a document the caller cannot read (no leak)', async () => {
    const secret = await kernel.create({ collection: 'secrets', data: { owner: 'alice' }, req: { user: alice } })
    const handler = createRequestHandler(kernel, withUser(bob))
    const res = await handler(new Request(`http://localhost/api/secrets/${secret.id}/comments`))
    expect(res.status).toBe(403)
  })
})

describe('/api/_admin/comments/:commentId', () => {
  it('the author can resolve their comment; a random user cannot', async () => {
    const post = await kernel.create({ collection: 'posts', data: { title: 'x' }, req: { user: alice } })
    const c = await kernel.addComment({ collection: 'posts', id: post.id, body: 'note', req: { user: alice } })

    const asBob = createRequestHandler(kernel, withUser(bob))
    const denied = await asBob(
      new Request(`http://localhost/api/_admin/comments/${c.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ resolved: true }),
      }),
    )
    expect(denied.status).toBe(403)

    const asAlice = createRequestHandler(kernel, withUser(alice))
    const ok = await asAlice(
      new Request(`http://localhost/api/_admin/comments/${c.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ resolved: true }),
      }),
    )
    expect(ok.status).toBe(200)
    const resolved = (await ok.json()) as { resolved: boolean }
    expect(resolved.resolved).toBe(true)
  })

  it('an admin can delete any comment', async () => {
    const post = await kernel.create({ collection: 'posts', data: { title: 'x' }, req: { user: alice } })
    const c = await kernel.addComment({ collection: 'posts', id: post.id, body: 'note', req: { user: bob } })
    const handler = createRequestHandler(kernel, withUser(admin))
    const res = await handler(new Request(`http://localhost/api/_admin/comments/${c.id}`, { method: 'DELETE' }))
    expect(res.status).toBe(200)
    const left = await kernel.listComments({ collection: 'posts', id: post.id, req: { user: alice } })
    expect(left).toHaveLength(0)
  })
})
