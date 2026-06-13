import { beforeEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { initKernel } from '@kernel/core'
import type { AuthUser, Kernel } from '@kernel/core'
import { createRequestHandler } from './index'

// The admin role-builder UI calls these endpoints. They are admin-only (same gate as
// /_admin/audit) and each mutation persists to `_roles` and updates the live store.

let kernel: Kernel

beforeEach(async () => {
  kernel = await initKernel(
    {
      secret: 'roles-route-test',
      db: sqliteAdapter({ url: ':memory:' }),
      rbac: { roles: { author: { collections: { posts: ['read', 'create'] } } } },
      collections: [{ slug: 'posts', fields: [{ name: 'title', type: 'text' }] }],
    },
    { logLevel: 'error', autoMigrate: true },
  )
})

const admin: AuthUser = { id: 'admin-1', roles: ['admin'], collection: 'users' } as AuthUser
const member: AuthUser = { id: 'member-1', roles: ['editor'], collection: 'users' } as AuthUser

const withUser = (user: AuthUser | null) => ({
  getUser: (): AuthUser | null => user,
  rateLimit: { enabled: false } as const,
})

const url = (path: string) => `http://localhost/api/_admin/roles${path}`

describe('/api/_admin/roles (admin only)', () => {
  it('returns 401 when unauthenticated', async () => {
    const handler = createRequestHandler(kernel, { rateLimit: { enabled: false } })
    const res = await handler(new Request(url('')))
    expect(res.status).toBe(401)
  })

  it('returns 403 for a non-admin user', async () => {
    const handler = createRequestHandler(kernel, withUser(member))
    const res = await handler(new Request(url('')))
    expect(res.status).toBe(403)
  })

  it('lists seeded roles for an admin', async () => {
    const handler = createRequestHandler(kernel, withUser(admin))
    const res = await handler(new Request(url('')))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { roles: Array<{ name: string }> }
    expect(body.roles.map((r) => r.name)).toEqual(['author'])
  })

  it('creates a role (201) and persists it', async () => {
    const handler = createRequestHandler(kernel, withUser(admin))
    const res = await handler(
      new Request(url(''), {
        method: 'POST',
        body: JSON.stringify({ name: 'viewer', def: { collections: { posts: ['read'] } } }),
      }),
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as { role: { name: string } }
    expect(body.role.name).toBe('viewer')
    expect((await kernel.findRoles()).map((r) => r.name).sort()).toEqual(['author', 'viewer'])
  })

  it('rejects an invalid definition with a 400', async () => {
    const handler = createRequestHandler(kernel, withUser(admin))
    const res = await handler(
      new Request(url(''), {
        method: 'POST',
        body: JSON.stringify({ name: 'bad', def: { collections: { posts: ['nope'] } } }),
      }),
    )
    expect(res.status).toBe(400)
  })

  it('updates a role via PATCH', async () => {
    const handler = createRequestHandler(kernel, withUser(admin))
    const res = await handler(
      new Request(url('/author'), {
        method: 'PATCH',
        body: JSON.stringify({ def: { collections: { posts: ['read', 'create', 'update'] } } }),
      }),
    )
    expect(res.status).toBe(200)
    const row = await kernel.db.findByID({ collection: '_roles', id: 'author' })
    expect(row?.def).toMatchObject({ collections: { posts: ['read', 'create', 'update'] } })
  })

  it('deletes a role via DELETE', async () => {
    const handler = createRequestHandler(kernel, withUser(admin))
    const res = await handler(new Request(url('/author'), { method: 'DELETE' }))
    expect(res.status).toBe(200)
    expect((await kernel.findRoles()).map((r) => r.name)).not.toContain('author')
  })

  it('a non-admin cannot mutate roles (403)', async () => {
    const handler = createRequestHandler(kernel, withUser(member))
    const res = await handler(new Request(url('/author'), { method: 'DELETE' }))
    expect(res.status).toBe(403)
  })
})
