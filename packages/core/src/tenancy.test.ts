import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { defineConfig, initKernel } from './index'
import type { Kernel } from './index'

// Automatic multi-tenancy. A scoped collection (`posts`) is auto-constrained to the acting
// principal's tenant; a non-scoped public collection (`pages`) is untouched. These pin down:
// cross-tenant isolation (read/findByID/update/delete/count), create auto-stamp + anti-spoof,
// fail-closed for a tenant-less principal, and the overrideAccess system bypass.

function tenancyConfig() {
  return defineConfig({
    secret: 'test-secret',
    db: sqliteAdapter({ url: ':memory:' }),
    tenancy: { field: 'tenant' },
    collections: [
      // Scoped by default (non-system, non-auth).
      { slug: 'posts', access: { read: () => true }, fields: [{ name: 'title', type: 'text' }] },
      // Public, non-scoped: tenancy must leave it alone. Excluded via an explicit allow-list
      // would also work; here we rely on the default (all non-system/non-auth) and assert the
      // scoped set, so we add `pages` to a SEPARATE kernel below for the non-scoped case.
    ],
  })
}

const acme = { req: { user: { id: 'a', tenant: 'acme' } } }
const globex = { req: { user: { id: 'b', tenant: 'globex' } } }
const tenantless = { req: { user: { id: 'c' } } }
const sys = { overrideAccess: true }

let kernel: Kernel

beforeEach(async () => {
  kernel = await initKernel(tenancyConfig(), { logLevel: 'error', autoMigrate: true })
})

afterEach(async () => {
  await kernel.destroy()
})

describe('multi-tenancy: auto-scoping by principal', () => {
  it('auto-stamps the owning tenant from the principal on create', async () => {
    const post = await kernel.create({ collection: 'posts', data: { title: 'hello' }, ...acme })
    expect((post as Record<string, unknown>).tenant).toBe('acme')
  })

  it('overrides a client-supplied tenant (anti-spoof on create)', async () => {
    const post = await kernel.create({ collection: 'posts', data: { title: 'x', tenant: 'globex' }, ...acme })
    expect((post as Record<string, unknown>).tenant).toBe('acme')
  })

  it('isolates reads — a tenant only sees its own rows', async () => {
    await kernel.create({ collection: 'posts', data: { title: 'acme-1' }, ...acme })
    await kernel.create({ collection: 'posts', data: { title: 'globex-1' }, ...globex })

    const acmeList = await kernel.find({ collection: 'posts', ...acme })
    expect(acmeList.docs.map((d) => d.title)).toEqual(['acme-1'])

    const globexList = await kernel.find({ collection: 'posts', ...globex })
    expect(globexList.docs.map((d) => d.title)).toEqual(['globex-1'])
  })

  it('isolates count by tenant', async () => {
    await kernel.create({ collection: 'posts', data: { title: 'a1' }, ...acme })
    await kernel.create({ collection: 'posts', data: { title: 'a2' }, ...acme })
    await kernel.create({ collection: 'posts', data: { title: 'g1' }, ...globex })

    expect(await kernel.count({ collection: 'posts', ...acme })).toBe(2)
    expect(await kernel.count({ collection: 'posts', ...globex })).toBe(1)
  })

  it('blocks cross-tenant findByID/update/delete', async () => {
    const acmePost = await kernel.create({ collection: 'posts', data: { title: 'secret' }, ...acme })

    // A row-scope mismatch is Forbidden (IDOR-safe), exactly like a denying access Where.
    await expect(kernel.findByID({ collection: 'posts', id: acmePost.id, ...globex })).rejects.toMatchObject({
      status: 403,
    })
    await expect(
      kernel.update({ collection: 'posts', id: acmePost.id, data: { title: 'hax' }, ...globex }),
    ).rejects.toMatchObject({ status: 403 })
    await expect(kernel.delete({ collection: 'posts', id: acmePost.id, ...globex })).rejects.toMatchObject({
      status: 403,
    })
  })

  it('cannot move a doc across tenants on update (anti-spoof)', async () => {
    const post = await kernel.create({ collection: 'posts', data: { title: 't' }, ...acme })
    const updated = await kernel.update({ collection: 'posts', id: post.id, data: { tenant: 'globex' }, ...acme })
    expect((updated as Record<string, unknown>).tenant).toBe('acme')
    // And globex still can't reach it.
    await expect(kernel.findByID({ collection: 'posts', id: post.id, ...globex })).rejects.toMatchObject({
      status: 403,
    })
  })

  it('fails closed for a tenant-less principal (requireTenant default)', async () => {
    await kernel.create({ collection: 'posts', data: { title: 'a1' }, ...acme })
    const list = await kernel.find({ collection: 'posts', ...tenantless })
    expect(list.docs.length).toBe(0)
    await expect(kernel.create({ collection: 'posts', data: { title: 'nope' }, ...tenantless })).rejects.toMatchObject({
      status: 403,
    })
  })

  it('overrideAccess bypasses tenancy (system escape hatch)', async () => {
    await kernel.create({ collection: 'posts', data: { title: 'a1' }, ...acme })
    await kernel.create({ collection: 'posts', data: { title: 'g1' }, ...globex })
    const all = await kernel.find({ collection: 'posts', ...sys })
    expect(all.docs.length).toBe(2)
  })
})

describe('multi-tenancy: non-scoped collections are unaffected', () => {
  it('leaves an explicitly excluded collection unscoped', async () => {
    const k = await initKernel(
      defineConfig({
        secret: 'test-secret',
        db: sqliteAdapter({ url: ':memory:' }),
        // Only `posts` is scoped; `pages` is public + unscoped.
        tenancy: { field: 'tenant', collections: ['posts'] },
        collections: [
          { slug: 'posts', access: { read: () => true }, fields: [{ name: 'title', type: 'text' }] },
          {
            slug: 'pages',
            access: { read: () => true, create: () => true },
            fields: [{ name: 'title', type: 'text' }],
          },
        ],
      }),
      { logLevel: 'error', autoMigrate: true },
    )
    try {
      await k.create({ collection: 'pages', data: { title: 'public' }, ...acme })
      // A different tenant (and a tenant-less principal) both still see the page.
      const seen = await k.find({ collection: 'pages', ...globex })
      expect(seen.docs.map((d) => d.title)).toEqual(['public'])
      const page = (await k.find({ collection: 'pages', ...acme })).docs[0]
      expect((page as Record<string, unknown>).tenant).toBeUndefined()
    } finally {
      await k.destroy()
    }
  })
})
