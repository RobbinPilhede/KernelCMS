import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { defineConfig, initKernel } from './index'
import type { Kernel } from './index'

// Content federation / sync: export a collection's documents as a portable, deterministic
// bundle (sorted by id, READ-access-checked) and apply it into another environment by id
// (create-or-update) through the NORMAL access-checked pipeline (access + validation +
// publish gate). A dry run plans without writing. Identity (id) is preserved across
// environments. These tests pin round-trip id preservation, the dry-run no-write guarantee,
// idempotent re-sync, selective update, the access-checked export/sync gates, the publish
// gate on sync, bad-input handling, the disabled error, and the `create({ id })` option.

const ownerRead = ({ req }: any) => {
  if (req.user?.roles?.includes('admin')) return true
  return { owner: { equals: req.user?.id ?? '__none__' } }
}

const isAdmin = ({ req }: any) => Boolean(req.user?.roles?.includes('admin'))

const alice = { user: { id: 'alice', roles: ['viewer'] } }
const bob = { user: { id: 'bob', roles: ['viewer'] } }
const admin = { user: { id: 'adm', roles: ['admin'] } }

function fedConfig(overrides: Record<string, unknown> = {}) {
  return defineConfig({
    secret: 'federation-test-secret',
    db: sqliteAdapter({ url: ':memory:' }),
    federation: true,
    collections: [
      {
        // Public-ish: anyone can read/create/update.
        slug: 'posts',
        access: { read: () => true, create: () => true, update: () => true },
        fields: [
          { name: 'title', type: 'text' },
          { name: 'body', type: 'text' },
        ],
      },
      {
        // Owner-scoped read: a row is only readable by its owner (or an admin).
        slug: 'secrets',
        access: { read: ownerRead, create: () => true, update: () => true },
        fields: [
          { name: 'owner', type: 'text' },
          { name: 'note', type: 'text' },
        ],
      },
      {
        // Admin-only create/update: a viewer can read but cannot write.
        slug: 'locked',
        access: { read: () => true, create: isAdmin, update: isAdmin },
        fields: [{ name: 'title', type: 'text' }],
      },
      {
        // Drafts collection where ONLY an admin may publish; anyone may create/update drafts.
        slug: 'articles',
        versions: { drafts: true },
        access: { read: () => true, create: () => true, update: () => true, publish: isAdmin },
        fields: [{ name: 'title', type: 'text' }],
      },
    ],
    ...overrides,
  })
}

describe('federation — export/sync round-trip', () => {
  let envA: Kernel
  let envB: Kernel
  beforeEach(async () => {
    envA = await initKernel(fedConfig(), { logLevel: 'error', autoMigrate: true })
    envB = await initKernel(fedConfig(), { logLevel: 'error', autoMigrate: true })
  })
  afterEach(async () => {
    await envA.destroy()
    await envB.destroy()
  })

  it('round-trips with id preservation', async () => {
    const p1 = await envA.create({ collection: 'posts', data: { title: 'First', body: 'a' }, overrideAccess: true })
    const p2 = await envA.create({ collection: 'posts', data: { title: 'Second', body: 'b' }, overrideAccess: true })

    const bundle = await envA.exportContent({ collection: 'posts', overrideAccess: true })
    expect(bundle.version).toBe(1)
    expect(bundle.documents).toHaveLength(2)
    // Bundle ids match the source ids, sorted ascending.
    const sortedSourceIds = [String(p1.id), String(p2.id)].sort()
    expect(bundle.documents.map((d) => d.id)).toEqual(sortedSourceIds)
    // Data carries the storage fields.
    const byId = new Map(bundle.documents.map((d) => [d.id, d.data]))
    expect(byId.get(String(p1.id))).toMatchObject({ title: 'First', body: 'a' })

    const result = await envB.syncContent({ bundle, overrideAccess: true })
    expect(result.created).toBe(2)
    expect(result.updated).toBe(0)
    expect(result.dryRun).toBe(false)

    // The synced doc has the SAME id in env B.
    const got = await envB.findByID({ collection: 'posts', id: String(p1.id), overrideAccess: true })
    expect(got?.id).toBe(String(p1.id))
    expect(got).toMatchObject({ title: 'First', body: 'a' })
  })

  it('dry run computes the plan but writes nothing', async () => {
    await envA.create({ collection: 'posts', data: { title: 'First' }, overrideAccess: true })
    await envA.create({ collection: 'posts', data: { title: 'Second' }, overrideAccess: true })
    const bundle = await envA.exportContent({ collection: 'posts', overrideAccess: true })

    const result = await envB.syncContent({ bundle, dryRun: true, overrideAccess: true })
    expect(result.dryRun).toBe(true)
    expect(result.created).toBe(2)
    expect(result.plan).toHaveLength(2)
    expect(result.plan.every((p) => p.action === 'create')).toBe(true)

    // Nothing was written.
    const live = await envB.find({ collection: 'posts', overrideAccess: true })
    expect(live.docs).toHaveLength(0)
  })

  it('is idempotent: a second sync of the same bundle is all unchanged', async () => {
    await envA.create({ collection: 'posts', data: { title: 'First' }, overrideAccess: true })
    await envA.create({ collection: 'posts', data: { title: 'Second' }, overrideAccess: true })
    const bundle = await envA.exportContent({ collection: 'posts', overrideAccess: true })

    const first = await envB.syncContent({ bundle, overrideAccess: true })
    expect(first.created).toBe(2)

    const second = await envB.syncContent({ bundle, overrideAccess: true })
    expect(second.created).toBe(0)
    expect(second.updated).toBe(0)
    expect(second.unchanged).toBe(2)
    expect(second.plan.every((p) => p.action === 'unchanged')).toBe(true)
  })

  it('selectively updates only the changed document', async () => {
    const p1 = await envA.create({ collection: 'posts', data: { title: 'First' }, overrideAccess: true })
    const p2 = await envA.create({ collection: 'posts', data: { title: 'Second' }, overrideAccess: true })
    await envB.syncContent({
      bundle: await envA.exportContent({ collection: 'posts', overrideAccess: true }),
      overrideAccess: true,
    })

    // Edit one source post, re-export, re-sync.
    await envA.update({
      collection: 'posts',
      id: String(p1.id),
      data: { title: 'First (edited)' },
      overrideAccess: true,
    })
    const bundle2 = await envA.exportContent({ collection: 'posts', overrideAccess: true })
    const result = await envB.syncContent({ bundle: bundle2, overrideAccess: true })
    expect(result.updated).toBe(1)
    expect(result.unchanged).toBe(1)

    // Env B reflects the new value for the edited doc; the other is untouched.
    const edited = await envB.findByID({ collection: 'posts', id: String(p1.id), overrideAccess: true })
    expect(edited).toMatchObject({ title: 'First (edited)' })
    const untouched = await envB.findByID({ collection: 'posts', id: String(p2.id), overrideAccess: true })
    expect(untouched).toMatchObject({ title: 'Second' })
  })

  it('access-checks export: a non-override caller exports only readable rows', async () => {
    const aliceSecret = await envA.create({
      collection: 'secrets',
      data: { owner: 'alice', note: 'a-secret' },
      req: alice,
    })
    const bobSecret = await envA.create({ collection: 'secrets', data: { owner: 'bob', note: 'b-secret' }, req: bob })

    // Bob (non-override) exports — only his own secret is readable.
    const bobBundle = await envA.exportContent({ collection: 'secrets', req: bob })
    expect(bobBundle.documents.map((d) => d.id)).toEqual([String(bobSecret.id)])
    expect(bobBundle.documents.some((d) => d.id === String(aliceSecret.id))).toBe(false)

    // An override/admin export includes both.
    const adminBundle = await envA.exportContent({ collection: 'secrets', overrideAccess: true })
    expect(adminBundle.documents.map((d) => d.id).sort()).toEqual([String(aliceSecret.id), String(bobSecret.id)].sort())
  })

  it('access-checks sync: a caller lacking create/update access lands docs in failed[]', async () => {
    // Build a bundle (as admin) for an admin-only-write collection.
    const a = await envA.create({ collection: 'locked', data: { title: 'L1' }, req: admin })
    const b = await envA.create({ collection: 'locked', data: { title: 'L2' }, req: admin })
    const bundle = await envA.exportContent({ collection: 'locked', overrideAccess: true })

    // A viewer (bob) cannot create in `locked` → both entries fail, nothing is written.
    const result = await envB.syncContent({ bundle, req: bob })
    expect(result.created).toBe(0)
    expect(result.failed).toHaveLength(2)
    expect(result.failed.map((f) => f.id).sort()).toEqual([String(a.id), String(b.id)].sort())

    const live = await envB.find({ collection: 'locked', overrideAccess: true })
    expect(live.docs).toHaveLength(0)
  })

  it('enforces the publish gate on sync', async () => {
    // A published article in env A.
    const art = await envA.create({ collection: 'articles', data: { title: 'Live', _status: 'published' }, req: admin })
    const bundle = await envA.exportContent({ collection: 'articles', draft: true, overrideAccess: true })
    expect(bundle.documents[0]?.data._status).toBe('published')

    // A non-override viewer who lacks publish access → the published doc fails (not applied).
    const denied = await envB.syncContent({ bundle, req: bob })
    expect(denied.created).toBe(0)
    expect(denied.failed.map((f) => f.id)).toEqual([String(art.id)])
    const liveAfterDeny = await envB.find({ collection: 'articles', draft: true, overrideAccess: true })
    expect(liveAfterDeny.docs).toHaveLength(0)

    // With override/admin → it applies and is published.
    const ok = await envB.syncContent({ bundle, overrideAccess: true })
    expect(ok.created).toBe(1)
    const synced = await envB.findByID({
      collection: 'articles',
      id: String(art.id),
      draft: true,
      overrideAccess: true,
    })
    expect(synced?._status).toBe('published')
  })

  it('rejects an invalid bundle and routes bad entries to failed[]', async () => {
    // version wrong.
    await expect(
      envB.syncContent({ bundle: { version: 2, documents: [] } as any, overrideAccess: true }),
    ).rejects.toThrow()
    // documents not an array.
    await expect(
      envB.syncContent({ bundle: { version: 1, documents: {} } as any, overrideAccess: true }),
    ).rejects.toThrow()

    // A mixed bundle: a valid post, an unknown collection, an empty id, a __proto__ id.
    const good = await envA.create({ collection: 'posts', data: { title: 'Good' }, overrideAccess: true })
    const bundle = {
      version: 1 as const,
      documents: [
        { collection: 'posts', id: String(good.id), data: { title: 'Good' } },
        { collection: 'nope', id: 'x1', data: { title: 'unknown' } },
        { collection: 'posts', id: '', data: { title: 'empty id' } },
        { collection: 'posts', id: '__proto__', data: { title: 'evil' } },
      ],
    }
    const result = await envB.syncContent({ bundle, overrideAccess: true })
    expect(result.created).toBe(1)
    expect(result.failed).toHaveLength(3)
    expect(result.failed.map((f) => f.collection).sort()).toEqual(['nope', 'posts', 'posts'])
    // The good doc applied with its id preserved.
    const got = await envB.findByID({ collection: 'posts', id: String(good.id), overrideAccess: true })
    expect(got?.id).toBe(String(good.id))
    // No prototype pollution from the __proto__ id.
    expect(({} as any).polluted).toBeUndefined()
  })
})

describe('federation — disabled', () => {
  let kernel: Kernel
  beforeEach(async () => {
    kernel = await initKernel(fedConfig({ federation: false }), { logLevel: 'error', autoMigrate: true })
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('exportContent throws a clean not-enabled error', async () => {
    await expect(kernel.exportContent({ collection: 'posts', overrideAccess: true })).rejects.toThrow(/not enabled/i)
  })

  it('syncContent throws a clean not-enabled error', async () => {
    await expect(kernel.syncContent({ bundle: { version: 1, documents: [] }, overrideAccess: true })).rejects.toThrow(
      /not enabled/i,
    )
  })
})

describe('create — id option (identity preservation)', () => {
  let kernel: Kernel
  beforeEach(async () => {
    kernel = await initKernel(fedConfig(), { logLevel: 'error', autoMigrate: true })
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('creates with a caller-provided id', async () => {
    const doc = await kernel.create({
      collection: 'posts',
      id: 'fixed-id-1',
      data: { title: 'Fixed' },
      overrideAccess: true,
    })
    expect(doc.id).toBe('fixed-id-1')
    const got = await kernel.findByID({ collection: 'posts', id: 'fixed-id-1', overrideAccess: true })
    expect(got?.id).toBe('fixed-id-1')
  })

  it('rejects a duplicate id as a conflict', async () => {
    await kernel.create({ collection: 'posts', id: 'dup-id', data: { title: 'One' }, overrideAccess: true })
    await expect(
      kernel.create({ collection: 'posts', id: 'dup-id', data: { title: 'Two' }, overrideAccess: true }),
    ).rejects.toThrow()
  })

  it('rejects a __proto__ id', async () => {
    await expect(
      kernel.create({ collection: 'posts', id: '__proto__', data: { title: 'evil' }, overrideAccess: true }),
    ).rejects.toThrow()
    expect(({} as any).polluted).toBeUndefined()
  })
})
