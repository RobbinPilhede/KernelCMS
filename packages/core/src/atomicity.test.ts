import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { defineConfig, initKernel } from './index'
import type { Kernel } from './index'

// These tests pin down the multi-write atomicity guarantees: a mid-sequence failure
// must roll back EVERY write already applied, never leave a half-applied result.
// The failure is injected through a `beforeChange` hook that throws on a sentinel —
// it runs DURING the write (after earlier members/docs have written to the shared
// transaction) but is NOT exercised by the release pre-flight, so it reaches the real
// apply loop and forces the rollback path.

const editor = { user: { id: 'ed', roles: ['editor'] } }

/** A `beforeChange` that throws on update when the doc's title is the sentinel — used to
 *  fail one member/document mid-loop. Allows the sentinel on create so a draft can be seeded. */
const explodeOnUpdate = (args: { operation: string; data: Record<string, unknown> }) => {
  if (args.operation === 'update' && args.data.title === 'BOOM') {
    throw new Error('beforeChange exploded for BOOM')
  }
  return args.data
}

describe('publishRelease is all-or-nothing (transactional rollback)', () => {
  let kernel: Kernel
  beforeEach(async () => {
    kernel = await initKernel(
      defineConfig({
        secret: 'test-secret-32-characters-long!!',
        db: sqliteAdapter({ url: ':memory:' }),
        releases: true,
        collections: [
          {
            slug: 'posts',
            versions: { drafts: true },
            access: { read: () => true, create: () => true, update: () => true, publish: () => true },
            hooks: { beforeChange: [explodeOnUpdate] },
            fields: [{ name: 'title', type: 'text' }],
          },
        ],
      }),
      { logLevel: 'error' },
    )
    await kernel.migrate()
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('rolls back members already published when a later member fails mid-loop', async () => {
    const a = await kernel.create({ collection: 'posts', data: { title: 'A' }, req: editor })
    const b = await kernel.create({ collection: 'posts', data: { title: 'B' }, req: editor })
    // C will explode on its publish (update), AFTER A and B have published into the txn.
    const c = await kernel.create({ collection: 'posts', data: { title: 'BOOM' }, req: editor })

    const release = await kernel.createRelease({ name: 'Launch', req: editor })
    for (const id of [a.id, b.id, c.id]) {
      await kernel.addToRelease({ release: release.id, collection: 'posts', id, req: editor })
    }

    const res = await kernel.publishRelease({ release: release.id, req: editor })

    expect(res.status).toBe('failed')
    expect(res.published).toEqual([]) // nothing reported live
    expect(res.failed.some((f) => f.id === c.id)).toBe(true)

    // The crux: A and B must be rolled back to draft — not left published.
    const aAfter = await kernel.findByID({ collection: 'posts', id: a.id, draft: true, overrideAccess: true })
    const bAfter = await kernel.findByID({ collection: 'posts', id: b.id, draft: true, overrideAccess: true })
    expect(aAfter?._status).toBe('draft')
    expect(bAfter?._status).toBe('draft')

    // And no published version snapshot survived the rollback for A.
    const versionsA = await kernel.findVersions({ collection: 'posts', id: a.id, overrideAccess: true })
    expect(versionsA.docs.every((v) => v.status !== 'published')).toBe(true)
  })
})

describe('syncContent atomic mode (whole-bundle rollback)', () => {
  let kernel: Kernel
  const makeKernel = async () =>
    initKernel(
      defineConfig({
        secret: 'test-secret-32-characters-long!!',
        db: sqliteAdapter({ url: ':memory:' }),
        federation: true,
        collections: [
          {
            slug: 'posts',
            access: { read: () => true, create: () => true, update: () => true },
            fields: [{ name: 'title', type: 'text' }],
          },
        ],
      }),
      { logLevel: 'error' },
    )
  beforeEach(async () => {
    kernel = await makeKernel()
    await kernel.migrate()
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  // A bundle whose second entry targets an unknown collection — that entry throws inside
  // the apply, which must roll the first (valid) create back under atomic mode.
  const bundle = {
    version: 1 as const,
    documents: [
      { collection: 'posts', id: 'p1', data: { title: 'one' } },
      { collection: 'nope', id: 'x1', data: { title: 'bad' } },
    ],
  }

  it('writes nothing when any document fails under atomic:true', async () => {
    const res = await kernel.syncContent({ bundle, atomic: true, overrideAccess: true })
    expect(res.failed.length).toBeGreaterThan(0)
    expect(res.created).toBe(0)
    const all = await kernel.find({ collection: 'posts', overrideAccess: true })
    expect(all.totalDocs).toBe(0) // the valid p1 was rolled back
  })

  it('applies the good document and collects the failure under the default mode', async () => {
    const res = await kernel.syncContent({ bundle, overrideAccess: true })
    expect(res.created).toBe(1)
    expect(res.failed.length).toBe(1)
    const all = await kernel.find({ collection: 'posts', overrideAccess: true })
    expect(all.totalDocs).toBe(1) // p1 stays applied
  })
})

describe('mergeBranch atomic mode (whole-merge rollback)', () => {
  let kernel: Kernel
  let p1: string
  let p2: string
  beforeEach(async () => {
    kernel = await initKernel(
      defineConfig({
        secret: 'test-secret-32-characters-long!!',
        db: sqliteAdapter({ url: ':memory:' }),
        branches: true,
        collections: [
          {
            slug: 'posts',
            access: { read: () => true, create: () => true, update: () => true },
            fields: [{ name: 'title', type: 'text', required: true }],
          },
        ],
      }),
      { logLevel: 'error' },
    )
    await kernel.migrate()
    const a = await kernel.create({ collection: 'posts', data: { title: 'first' }, req: editor })
    const b = await kernel.create({ collection: 'posts', data: { title: 'second' }, req: editor })
    p1 = a.id
    p2 = b.id
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('rolls back a valid change when another change in the merge fails', async () => {
    await kernel.createBranch({ name: 'feature', req: editor })
    // p1: a valid edit. p2: clearing a REQUIRED field — fails validation on merge.
    await kernel.stageChange({ branch: 'feature', collection: 'posts', id: p1, data: { title: 'edited' }, req: editor })
    await kernel.stageChange({ branch: 'feature', collection: 'posts', id: p2, data: { title: '' }, req: editor })

    const res = await kernel.mergeBranch({ branch: 'feature', atomic: true, req: editor })

    expect(res.merged).toEqual([]) // nothing merged
    expect(res.failed.length).toBeGreaterThan(0)
    // Both live docs are untouched, and the branch stays open (overlay intact, retryable).
    const after1 = await kernel.findByID({ collection: 'posts', id: p1, overrideAccess: true })
    expect(after1?.title).toBe('first')
    const branches = await kernel.listBranches({ status: 'open', req: editor })
    expect(branches.some((br) => br.name === 'feature')).toBe(true)
  })
})
