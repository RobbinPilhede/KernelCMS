import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { defineConfig, initKernel, ROLES_TABLE } from './index'
import type { Kernel } from './index'

// Granular RBAC. A role grants per-collection ops; the injected access rules enforce
// them against a runtime-editable store. These tests pin down: per-op grants, the
// admin super-grant, explicit-access-fn precedence, full backward compat when RBAC is
// off, runtime edits changing enforcement, and `_roles` seeding from config.

// An author may only read+create posts (not update/delete). An admin role does
// everything. Drafts are on so `publish` is also an injectable op.
function rbacConfig() {
  return defineConfig({
    secret: 'test-secret',
    db: sqliteAdapter({ url: ':memory:' }),
    rbac: {
      roles: {
        author: { collections: { posts: ['read', 'create'] } },
        superuser: { admin: true },
      },
    },
    collections: [
      {
        slug: 'posts',
        versions: { drafts: true },
        fields: [{ name: 'title', type: 'text' }],
      },
    ],
  })
}

const author = { id: 'a1', roles: ['author'], collection: 'users' }
const superuser = { id: 's1', roles: ['superuser'], collection: 'users' }
const nobody = { id: 'n1', roles: ['guest'], collection: 'users' }

let kernel: Kernel

beforeEach(async () => {
  kernel = await initKernel(rbacConfig(), { logLevel: 'error', autoMigrate: true })
})

afterEach(async () => {
  await kernel.destroy()
})

describe('RBAC enforcement by injection', () => {
  it('grants only the listed ops to a role (read/create yes, update/delete no)', async () => {
    const created = await kernel.create({ collection: 'posts', data: { title: 'hi' }, req: { user: author } })
    expect(created.title).toBe('hi')

    const list = await kernel.find({ collection: 'posts', req: { user: author }, draft: true })
    expect(list.docs.length).toBe(1)

    await expect(
      kernel.update({ collection: 'posts', id: created.id, data: { title: 'edited' }, req: { user: author } }),
    ).rejects.toMatchObject({ status: 403 })

    await expect(kernel.delete({ collection: 'posts', id: created.id, req: { user: author } })).rejects.toMatchObject({
      status: 403,
    })
  })

  it('an admin:true role can do everything', async () => {
    const created = await kernel.create({ collection: 'posts', data: { title: 'x' }, req: { user: superuser } })
    const updated = await kernel.update({
      collection: 'posts',
      id: created.id,
      data: { title: 'y' },
      req: { user: superuser },
    })
    expect(updated?.title).toBe('y')
    const removed = await kernel.delete({ collection: 'posts', id: created.id, req: { user: superuser } })
    expect(removed?.id).toBe(created.id)
  })

  it('denies a principal whose roles grant nothing', async () => {
    await expect(
      kernel.create({ collection: 'posts', data: { title: 'z' }, req: { user: nobody } }),
    ).rejects.toMatchObject({ status: 403 })
  })

  it('seeds the `_roles` table from config on first boot', async () => {
    const rows = await kernel.db.find({ collection: ROLES_TABLE, limit: 100, page: 1 })
    const names = rows.docs.map((r) => r.name).sort()
    expect(names).toEqual(['author', 'superuser'])
    expect(await kernel.findRoles()).toEqual([
      { name: 'author', def: { collections: { posts: ['read', 'create'] } } },
      { name: 'superuser', def: { admin: true } },
    ])
  })
})

describe('RBAC runtime edits', () => {
  it('updateRole changes enforcement immediately (a denied op then succeeds)', async () => {
    const created = await kernel.create({ collection: 'posts', data: { title: 'orig' }, req: { user: superuser } })

    // Author cannot update yet.
    await expect(
      kernel.update({ collection: 'posts', id: created.id, data: { title: 'no' }, req: { user: author } }),
    ).rejects.toMatchObject({ status: 403 })

    // Grant update at runtime — the live store is captured by reference, so the next
    // access check sees it without a restart.
    await kernel.updateRole('author', { collections: { posts: ['read', 'create', 'update'] } })

    const updated = await kernel.update({
      collection: 'posts',
      id: created.id,
      data: { title: 'yes' },
      req: { user: author },
    })
    expect(updated?.title).toBe('yes')

    // The change is persisted to `_roles` too.
    const row = await kernel.db.findByID({ collection: ROLES_TABLE, id: 'author' })
    expect(row?.def).toMatchObject({ collections: { posts: ['read', 'create', 'update'] } })
  })

  it('createRole and deleteRole keep store + table in sync', async () => {
    await kernel.createRole('viewer', { collections: { posts: ['read'] } })
    expect((await kernel.findRoles()).map((r) => r.name)).toContain('viewer')

    await kernel.deleteRole('viewer')
    expect((await kernel.findRoles()).map((r) => r.name)).not.toContain('viewer')
    expect(await kernel.db.findByID({ collection: ROLES_TABLE, id: 'viewer' })).toBeNull()
  })

  it('rejects an invalid role definition with a 400', async () => {
    await expect(kernel.createRole('bad', { collections: { posts: ['frobnicate'] } } as never)).rejects.toMatchObject({
      status: 400,
    })
  })

  it('rejects a duplicate role name with a 409', async () => {
    await expect(kernel.createRole('author', { collections: {} })).rejects.toMatchObject({ status: 409 })
  })
})

describe('RBAC precedence + backward compatibility', () => {
  it('an explicit access fn wins over RBAC (the fn decides, grants are ignored)', async () => {
    // `comments` declares its own create rule that ALWAYS allows; RBAC grants nothing
    // for it. The explicit fn must win, so even a no-grant principal can create.
    const k = await initKernel(
      defineConfig({
        secret: 'test-secret',
        db: sqliteAdapter({ url: ':memory:' }),
        rbac: { roles: { author: { collections: {} } } },
        collections: [
          {
            slug: 'comments',
            access: { read: () => true, create: () => true },
            fields: [{ name: 'body', type: 'text' }],
          },
        ],
      }),
      { logLevel: 'error', autoMigrate: true },
    )
    const created = await k.create({ collection: 'comments', data: { body: 'hey' }, req: { user: nobody } })
    expect(created.body).toBe('hey')
    await k.destroy()
  })

  it('without config.rbac, nothing changes (deny-by-default with no rule holds)', async () => {
    const k = await initKernel(
      defineConfig({
        secret: 'test-secret',
        db: sqliteAdapter({ url: ':memory:' }),
        collections: [{ slug: 'posts', fields: [{ name: 'title', type: 'text' }] }],
      }),
      { logLevel: 'error', autoMigrate: true },
    )
    // No access rule + no rbac: secure-by-default allows an authenticated user, denies
    // anonymous — exactly the historical behaviour.
    await expect(k.create({ collection: 'posts', data: { title: 'a' } })).rejects.toMatchObject({ status: 403 })
    const ok = await k.create({ collection: 'posts', data: { title: 'a' }, req: { user: nobody } })
    expect(ok.title).toBe('a')
    // No `_roles` table is provisioned.
    await expect(k.findRoles()).resolves.toEqual([])
    await k.destroy()
  })
})
