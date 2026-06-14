import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { defineConfig, initKernel } from './index'
import type { Kernel } from './index'

// Saved views / smart collections: a named (where + sort + columns) query preset for one
// collection, stored in the private `_views` system table. A view is owned by its creator
// (owner from the principal, never client input) and private unless `shared`. The stored
// filter/sort/columns are validated against the collection on save AND re-validated on apply.
// Applying a view runs the NORMAL access-checked `find`, so a saved/shared view can only ever
// NARROW within the caller's read access — it can never widen or bypass it. These tests pin
// owner-from-principal, shared-vs-private visibility, the access-checked applyView narrowing
// (the headline security property), owner-only edit/delete, validation, and system-table
// isolation of `_views`.

const ownerRead = ({ req }: any) => {
  if (req.user?.roles?.includes('admin')) return true
  return { owner: { equals: req.user?.id ?? '__none__' } }
}

const alice = { user: { id: 'alice', roles: ['viewer'] } }
const bob = { user: { id: 'bob', roles: ['viewer'] } }
const admin = { user: { id: 'adm', roles: ['admin'] } }

function viewsConfig(overrides: Record<string, unknown> = {}) {
  return defineConfig({
    secret: 'views-test-secret',
    db: sqliteAdapter({ url: ':memory:' }),
    audit: true,
    views: true,
    collections: [
      {
        slug: 'posts',
        access: { read: () => true, create: () => true, update: () => true },
        fields: [
          { name: 'title', type: 'text' },
          { name: 'status', type: 'text' },
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
      {
        // Admin-only: the read rule is a hard boolean deny for non-admins (no row scope),
        // so a non-admin cannot read ANY of it — the collection-level gate rejects.
        slug: 'vault',
        access: {
          read: ({ req }: any) => Boolean(req.user?.roles?.includes('admin')),
          create: () => true,
          update: () => true,
        },
        fields: [
          { name: 'owner', type: 'text' },
          { name: 'secret', type: 'text' },
        ],
      },
    ],
    ...overrides,
  })
}

describe('saveView — owner from principal + validation', () => {
  let kernel: Kernel
  beforeEach(async () => {
    kernel = await initKernel(viewsConfig(), { logLevel: 'error', autoMigrate: true })
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('records the owner from the principal and stores where/sort/columns, defaulting shared=false', async () => {
    const view = await kernel.saveView({
      collection: 'posts',
      name: '  Published posts  ',
      where: { status: { equals: 'published' } },
      sort: '-title',
      columns: ['title', 'status'],
      req: alice,
    })
    expect(view.ownerId).toBe('alice')
    expect(view.name).toBe('Published posts') // trimmed
    expect(view.where).toEqual({ status: { equals: 'published' } })
    expect(view.sort).toBe('-title')
    expect(view.columns).toEqual(['title', 'status'])
    expect(view.shared).toBe(false)
    expect(view.collection).toBe('posts')
  })

  it('rejects an anonymous caller (no req.user) saving a view', async () => {
    await expect(kernel.saveView({ collection: 'posts', name: 'Anon view', req: {} as never })).rejects.toThrow()
  })

  it('forbids saving a view for a collection the caller cannot read', async () => {
    // `vault`'s read rule is a hard boolean deny for non-admins (no row scope) — bob cannot
    // read ANY of it, so the collection-level gate rejects his attempt to save a view.
    await expect(kernel.saveView({ collection: 'vault', name: 'peek', req: bob })).rejects.toThrow()
    // An admin CAN read `vault`, so an admin may build a view over it.
    const adminView = await kernel.saveView({ collection: 'vault', name: 'all vault', req: admin })
    expect(adminView.ownerId).toBe('adm')
    // `secrets` resolves the read rule to a Where (row-scope), not an outright deny — the
    // collection gate is allowed-with-scope, so a non-admin CAN build a view over their rows.
    const ok = await kernel.saveView({ collection: 'secrets', name: 'my secrets', req: alice })
    expect(ok.ownerId).toBe('alice')
  })

  it('validates where/sort/columns/name against the collection', async () => {
    await expect(
      kernel.saveView({ collection: 'posts', name: 'bad', where: { nope: { equals: 1 } }, req: alice }),
    ).rejects.toThrow() // unknown field in where
    await expect(
      kernel.saveView({ collection: 'posts', name: 'bad', where: { title: { regex: 'x' } } as never, req: alice }),
    ).rejects.toThrow() // unknown operator
    await expect(
      kernel.saveView({ collection: 'posts', name: 'bad', sort: 'not_a_field', req: alice }),
    ).rejects.toThrow() // unknown sort field
    await expect(
      kernel.saveView({ collection: 'posts', name: 'bad', columns: ['title', 'ghost'], req: alice }),
    ).rejects.toThrow() // unknown column
    await expect(kernel.saveView({ collection: 'posts', name: '   ', req: alice })).rejects.toThrow() // empty name
    await expect(kernel.saveView({ collection: 'posts', name: undefined as never, req: alice })).rejects.toThrow()
  })
})

describe('listViews — own + shared visibility', () => {
  let kernel: Kernel
  beforeEach(async () => {
    kernel = await initKernel(viewsConfig(), { logLevel: 'error', autoMigrate: true })
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it("lists the caller's own views but not another user's private view", async () => {
    const mine = await kernel.saveView({ collection: 'posts', name: 'mine', req: alice })
    await kernel.saveView({ collection: 'posts', name: 'bobs private', req: bob })
    const aliceList = await kernel.listViews({ collection: 'posts', req: alice })
    const ids = aliceList.map((v) => v.id)
    expect(ids).toContain(mine.id)
    expect(aliceList.every((v) => v.ownerId === 'alice')).toBe(true)
    // Bob's private view is not visible to alice.
    expect(aliceList.some((v) => v.name === 'bobs private')).toBe(false)
  })

  it('shows a shared view on a readable collection to another user', async () => {
    const shared = await kernel.saveView({ collection: 'posts', name: 'shared posts', shared: true, req: alice })
    const bobList = await kernel.listViews({ collection: 'posts', req: bob })
    expect(bobList.map((v) => v.id)).toContain(shared.id)
  })

  it('hides a shared view on a collection the caller cannot read at all', async () => {
    // Admin shares a view on `vault`, which a non-admin cannot read at the collection gate.
    const shared = await kernel.saveView({ collection: 'vault', name: 'shared vault', shared: true, req: admin })
    // Bob, a non-admin, cannot read `vault` → the shared view is hidden from both list + get.
    const bobList = await kernel.listViews({ collection: 'vault', req: bob })
    expect(bobList).toHaveLength(0)
    expect(await kernel.getView({ viewId: shared.id, req: bob })).toBeNull()
  })

  it('narrows a shared `secrets` view to the caller’s own rows on apply', async () => {
    // `secrets` is row-scoped: bob CAN read it (only his rows), so he correctly sees a shared
    // view's metadata. The real security property is that APPLYING it returns only his rows.
    await kernel.create({ collection: 'secrets', data: { owner: 'alice', note: 'a1' }, ...alice })
    await kernel.create({ collection: 'secrets', data: { owner: 'bob', note: 'b1' }, ...bob })
    const shared = await kernel.saveView({ collection: 'secrets', name: 'shared secrets', shared: true, req: admin })
    // Bob sees the shared view (row-scoped read = allowed-with-scope at the collection gate)...
    const bobList = await kernel.listViews({ collection: 'secrets', req: bob })
    expect(bobList.map((v) => v.id)).toContain(shared.id)
    // ...but applying it returns ONLY bob's rows — never alice's. The view cannot widen access.
    const result = await kernel.applyView({ viewId: shared.id, req: bob })
    expect(result.docs.every((d: any) => d.owner === 'bob')).toBe(true)
    expect(result.docs.some((d: any) => d.owner === 'alice')).toBe(false)
  })

  it('returns views newest-first', async () => {
    const first = await kernel.saveView({ collection: 'posts', name: 'first', req: alice })
    const second = await kernel.saveView({ collection: 'posts', name: 'second', req: alice })
    const list = await kernel.listViews({ collection: 'posts', req: alice })
    // Both saved views are present...
    const ids = list.map((v) => v.id)
    expect(new Set(ids)).toEqual(new Set([first.id, second.id]))
    // ...and the list is ordered non-increasing by createdAt (newest-first). Two saves can
    // land in the same millisecond, so a tie is allowed — we assert monotonicity, not a
    // strict id order that would depend on sub-millisecond resolution.
    for (let i = 0; i < list.length - 1; i++) {
      expect(list[i]!.createdAt >= list[i + 1]!.createdAt).toBe(true)
    }
  })
})

describe('getView — owner + shared, null otherwise', () => {
  let kernel: Kernel
  beforeEach(async () => {
    kernel = await initKernel(viewsConfig(), { logLevel: 'error', autoMigrate: true })
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('owner sees their view; non-owner sees a shared one; private view of another user is null', async () => {
    const priv = await kernel.saveView({ collection: 'posts', name: 'private', req: alice })
    const shared = await kernel.saveView({ collection: 'posts', name: 'shared', shared: true, req: alice })
    // Owner sees their own private view.
    expect((await kernel.getView({ viewId: priv.id, req: alice }))?.id).toBe(priv.id)
    // Non-owner sees the shared view...
    expect((await kernel.getView({ viewId: shared.id, req: bob }))?.id).toBe(shared.id)
    // ...but NOT alice's private view.
    expect(await kernel.getView({ viewId: priv.id, req: bob })).toBeNull()
  })
})

describe('applyView — access-checked (security)', () => {
  let kernel: Kernel
  beforeEach(async () => {
    kernel = await initKernel(viewsConfig(), { logLevel: 'error', autoMigrate: true })
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it("never widens access: an admin's shared `secrets` view, applied by bob, returns ONLY bob's rows", async () => {
    await kernel.create({ collection: 'secrets', data: { owner: 'alice', note: 'a1' }, ...alice })
    await kernel.create({ collection: 'secrets', data: { owner: 'bob', note: 'b1' }, ...bob })
    await kernel.create({ collection: 'secrets', data: { owner: 'bob', note: 'b2' }, ...bob })
    // Admin (who CAN read every secret) saves a SHARED view with NO where (broad as possible).
    const shared = await kernel.saveView({ collection: 'secrets', name: 'all secrets', shared: true, req: admin })

    // When bob applies it, the collection read rule is AND-combined inside the normal find,
    // so he gets ONLY his own rows — never alice's. The shared view cannot widen his access.
    const result = await kernel.applyView({ viewId: shared.id, req: bob })
    expect(result.docs).toHaveLength(2)
    expect(result.docs.every((d: any) => d.owner === 'bob')).toBe(true)
    expect(result.docs.some((d: any) => d.owner === 'alice')).toBe(false)

    // The admin, applying the same view, still sees everything (their own access is broad).
    const adminResult = await kernel.applyView({ viewId: shared.id, req: admin })
    expect(adminResult.docs).toHaveLength(3)
  })

  it('an extra caller `where` further narrows the stored filter', async () => {
    await kernel.create({ collection: 'posts', data: { title: 'p1', status: 'published' }, ...alice })
    await kernel.create({ collection: 'posts', data: { title: 'p2', status: 'draft' }, ...alice })
    await kernel.create({ collection: 'posts', data: { title: 'p3', status: 'published' }, ...alice })
    const view = await kernel.saveView({
      collection: 'posts',
      name: 'published',
      where: { status: { equals: 'published' } },
      req: alice,
    })
    // Stored where alone → both published rows.
    expect((await kernel.applyView({ viewId: view.id, req: alice })).docs).toHaveLength(2)
    // Extra where AND-combined → only the one matching both.
    const narrowed = await kernel.applyView({ viewId: view.id, where: { title: { equals: 'p1' } }, req: alice })
    expect(narrowed.docs.map((d: any) => d.title)).toEqual(['p1'])
  })

  it('uses the stored sort, and a caller sort overrides it', async () => {
    await kernel.create({ collection: 'posts', data: { title: 'b' }, ...alice })
    await kernel.create({ collection: 'posts', data: { title: 'a' }, ...alice })
    await kernel.create({ collection: 'posts', data: { title: 'c' }, ...alice })
    const view = await kernel.saveView({ collection: 'posts', name: 'by title asc', sort: 'title', req: alice })
    // Stored ascending sort.
    const asc = await kernel.applyView({ viewId: view.id, req: alice })
    expect(asc.docs.map((d: any) => d.title)).toEqual(['a', 'b', 'c'])
    // Caller sort overrides the stored one.
    const desc = await kernel.applyView({ viewId: view.id, sort: '-title', req: alice })
    expect(desc.docs.map((d: any) => d.title)).toEqual(['c', 'b', 'a'])
  })

  it('cannot be applied by a user who can neither own nor see the view', async () => {
    const priv = await kernel.saveView({ collection: 'posts', name: 'alice only', req: alice })
    await expect(kernel.applyView({ viewId: priv.id, req: bob })).rejects.toThrow()
  })
})

describe('updateView / deleteView — owner or admin only', () => {
  let kernel: Kernel
  beforeEach(async () => {
    kernel = await initKernel(viewsConfig(), { logLevel: 'error', autoMigrate: true })
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('a non-owner who can SEE a shared view still cannot update or delete it', async () => {
    const shared = await kernel.saveView({ collection: 'posts', name: 'shared', shared: true, req: alice })
    // Bob can see it (shared, readable collection) but is not the owner / admin.
    expect((await kernel.getView({ viewId: shared.id, req: bob }))?.id).toBe(shared.id)
    await expect(kernel.updateView({ viewId: shared.id, name: 'hijacked', req: bob })).rejects.toThrow()
    await expect(kernel.deleteView({ viewId: shared.id, req: bob })).rejects.toThrow()
    // The owner CAN update; an admin CAN delete.
    const updated = await kernel.updateView({ viewId: shared.id, name: 'renamed', req: alice })
    expect(updated.name).toBe('renamed')
    const del = await kernel.deleteView({ viewId: shared.id, req: admin })
    expect(del.id).toBe(shared.id)
    expect(await kernel.getView({ viewId: shared.id, req: alice })).toBeNull()
  })

  it('re-validates a changed where/sort on update', async () => {
    const view = await kernel.saveView({ collection: 'posts', name: 'v', req: alice })
    await expect(kernel.updateView({ viewId: view.id, where: { nope: { equals: 1 } }, req: alice })).rejects.toThrow()
    await expect(kernel.updateView({ viewId: view.id, sort: 'not_a_field', req: alice })).rejects.toThrow()
  })
})

describe('views — validation, prototype-pollution, system-table isolation', () => {
  let kernel: Kernel
  beforeEach(async () => {
    kernel = await initKernel(viewsConfig(), { logLevel: 'error', autoMigrate: true })
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('rejects a prototype-pollution viewId and a __proto__ key in a where', async () => {
    await expect(kernel.getView({ viewId: '__proto__', req: alice })).rejects.toThrow()
    await expect(kernel.getView({ viewId: 'constructor', req: alice })).rejects.toThrow()
    // A where carrying an OWN `__proto__` key — the real attack vector comes via JSON, where
    // `JSON.parse('{"__proto__":...}')` creates an own enumerable property (an object literal
    // would instead set the prototype and expose nothing). `assertWhereFields` walks it as an
    // unknown filter field and rejects — no pollution.
    const evilWhere = JSON.parse('{"__proto__": {"equals": "x"}}')
    await expect(
      kernel.saveView({ collection: 'posts', name: 'evil', where: evilWhere as never, req: alice }),
    ).rejects.toThrow()
    expect(({} as any).polluted).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call({}, 'equals')).toBe(false)
  })

  it('_views is not reachable via generic CRUD', async () => {
    await expect(kernel.find({ collection: '_views', ...alice })).rejects.toThrow()
    await expect(
      kernel.create({ collection: '_views', data: { name: 'x', collection: 'posts' }, overrideAccess: true }),
    ).rejects.toThrow()
  })
})

describe('views disabled', () => {
  it('listViews returns [] and saveView/applyView throw a clean not-enabled error', async () => {
    const kernel = await initKernel(viewsConfig({ views: false }), { logLevel: 'error', autoMigrate: true })
    expect(await kernel.listViews({ collection: 'posts', req: alice })).toEqual([])
    await expect(kernel.saveView({ collection: 'posts', name: 'x', req: alice })).rejects.toThrow(/not enabled/i)
    await expect(kernel.applyView({ viewId: 'whatever', req: alice })).rejects.toThrow(/not enabled/i)
    await kernel.destroy()
  })
})
