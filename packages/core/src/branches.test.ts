import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { defineConfig, initKernel } from './index'
import type { Kernel } from './index'

// Content branches ("git for content"): a named workspace where field edits are STAGED as a
// copy-on-write overlay (the live document is never touched), previewed/diffed, then merged
// (each staged change replayed through the normal access-checked `update`) or discarded.
// These tests pin the reviewer gate (create/merge/discard), the copy-on-write guarantee (the
// live doc is unchanged after staging), the stage-time UPDATE-access gate, proto/unknown-field
// rejection, deep-merge re-staging, the diff, that merge replays through the REAL `update`
// (audit side effect + validation failures land in `failed[]` without corrupting live), that
// discard drops the overlay, branch lifecycle (merged/discarded can't be staged on), and that
// `_branches` / `_branch_docs` are not reachable via generic CRUD or when disabled.

// Assert a call rejects with an access/validation-style error. Mirrors the verify `denied`
// helper: matches the error's code/name/message (a ForbiddenError's message is "You are not
// allowed to perform this action.", so matching the message alone is not enough).
async function rejectsLike(fn: () => Promise<unknown>, re: RegExp): Promise<void> {
  try {
    await fn()
  } catch (e: any) {
    expect(`${e?.code}${e?.name}${e?.message}`).toMatch(re)
    return
  }
  throw new Error('expected the call to reject, but it resolved')
}

const FORBIDDEN = /forbidden/i
const BAD_REQUEST = /bad.?request|invalid|not.?enabled|not enabled|conflict|already exists|unknown|not.?found|illegal/i

// `locked` is admin-only to UPDATE — used to prove the stage gate requires update access.
const adminUpdate = ({ req }: any) => Boolean(req.user?.roles?.includes('admin'))
// Owner-scoped read: only the owner (or an admin) can read a row. A non-owner read yields a
// scope MISMATCH (not an outright deny), so the access-checked read returns null — which is
// what previewBranch surfaces as `null`.
const ownerRead = ({ req }: any) => {
  if (req.user?.roles?.includes('admin')) return true
  return { owner: { equals: req.user?.id ?? '__none__' } }
}

const editor = { user: { id: 'ed', roles: ['editor'] } } // reviewer
const admin = { user: { id: 'adm', roles: ['admin'] } } // reviewer
const viewer = { user: { id: 'vw', roles: ['viewer'] } } // NOT a reviewer
const anon = { user: null } as any // anonymous

function branchesConfig(overrides: Record<string, unknown> = {}) {
  return defineConfig({
    secret: 'branches-test-secret',
    db: sqliteAdapter({ url: ':memory:' }),
    audit: true,
    branches: true,
    collections: [
      {
        slug: 'posts',
        access: { read: () => true, create: () => true, update: () => true },
        fields: [
          { name: 'title', type: 'text', required: true },
          { name: 'body', type: 'text' },
        ],
      },
      {
        // Admin-only UPDATE — the stage gate must mirror this.
        slug: 'locked',
        access: { read: () => true, create: () => true, update: adminUpdate },
        fields: [
          { name: 'title', type: 'text', required: true },
          { name: 'contact', type: 'email' },
        ],
      },
    ],
    ...overrides,
  })
}

describe('createBranch — reviewer gate + name validation', () => {
  let kernel: Kernel
  beforeEach(async () => {
    kernel = await initKernel(branchesConfig(), { logLevel: 'error', autoMigrate: true })
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('lets an editor (reviewer) create an open branch', async () => {
    const b = await kernel.createBranch({ name: 'feature-x', req: editor })
    expect(b.name).toBe('feature-x')
    expect(b.status).toBe('open')
    expect(b.createdBy).toBe('ed')
  })

  it('lets an admin create a branch', async () => {
    const b = await kernel.createBranch({ name: 'admin-branch', req: admin })
    expect(b.status).toBe('open')
  })

  it('forbids a viewer (non-reviewer) from creating a branch', async () => {
    await rejectsLike(() => kernel.createBranch({ name: 'nope', req: viewer }), FORBIDDEN)
  })

  it('forbids an anonymous caller from creating a branch', async () => {
    await rejectsLike(() => kernel.createBranch({ name: 'ghost', req: anon }), /forbidden|unauthorized/i)
  })

  it('rejects an invalid branch name (spaces)', async () => {
    await rejectsLike(() => kernel.createBranch({ name: 'has spaces', req: editor }), BAD_REQUEST)
  })

  it('rejects an over-long branch name (> 80 chars)', async () => {
    await rejectsLike(() => kernel.createBranch({ name: 'a'.repeat(81), req: editor }), BAD_REQUEST)
  })

  it('rejects a duplicate branch name with Conflict', async () => {
    await kernel.createBranch({ name: 'dup', req: editor })
    await rejectsLike(() => kernel.createBranch({ name: 'dup', req: admin }), /conflict|already exists/i)
  })

  it('lists branches newest-first', async () => {
    await kernel.createBranch({ name: 'first', req: editor })
    await kernel.createBranch({ name: 'second', req: editor })
    const all = await kernel.listBranches({ req: editor })
    // Sorted by createdAt DESC. (Two branches created in the same tick can tie on the
    // timestamp, so assert the set + the descending order rather than a brittle exact pair.)
    expect(all.map((b) => b.name).sort()).toEqual(['first', 'second'])
    const times = all.map((b) => b.createdAt)
    expect([...times].sort((a, b) => (a < b ? 1 : -1))).toEqual(times)
  })

  it('filters listBranches by status', async () => {
    await kernel.createBranch({ name: 'open-one', req: editor })
    const discarded = await kernel.createBranch({ name: 'gone', req: editor })
    await kernel.discardBranch({ branch: discarded.name, req: editor })
    const open = await kernel.listBranches({ status: 'open', req: editor })
    expect(open.map((b) => b.name)).toEqual(['open-one'])
  })
})

describe('stageChange — copy-on-write overlay', () => {
  let kernel: Kernel
  beforeEach(async () => {
    kernel = await initKernel(branchesConfig(), { logLevel: 'error', autoMigrate: true })
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('stages a field edit without touching the live document; preview shows the overlay', async () => {
    const post = await kernel.create({ collection: 'posts', data: { title: 'Live', body: 'original' }, ...editor })
    await kernel.createBranch({ name: 'edit-title', req: editor })
    await kernel.stageChange({
      branch: 'edit-title',
      collection: 'posts',
      id: post.id,
      data: { title: 'Staged' },
      req: editor,
    })

    // The LIVE document is unchanged.
    const live = await kernel.findByID({ collection: 'posts', id: post.id, req: editor })
    expect(live?.title).toBe('Live')

    // Preview overlays the staged title while keeping the unstaged body from live.
    const preview = await kernel.previewBranch({ branch: 'edit-title', collection: 'posts', id: post.id, req: editor })
    expect(preview?.title).toBe('Staged')
    expect(preview?.body).toBe('original')
  })

  it('does not leak the staged overlay to a caller who cannot read the live doc', async () => {
    // Owner-scoped read: the live read is access-checked. previewBranch returns the overlay
    // ONLY for a caller who can read live; a caller who cannot read it gets `null` (when the
    // read yields nothing) or a Forbidden — never the staged content. Pins the no-leak property.
    const kernel2 = await initKernel(
      branchesConfig({
        collections: [
          {
            slug: 'posts',
            access: { read: ownerRead, create: () => true, update: () => true },
            fields: [
              { name: 'owner', type: 'text' },
              { name: 'title', type: 'text', required: true },
            ],
          },
        ],
      }),
      { logLevel: 'error', autoMigrate: true },
    )
    try {
      const post = await kernel2.create({ collection: 'posts', data: { owner: 'adm', title: 'secret' }, ...admin })
      await kernel2.createBranch({ name: 'b', req: admin })
      await kernel2.stageChange({ branch: 'b', collection: 'posts', id: post.id, data: { title: 'x' }, req: admin })
      // The owner (admin) sees the staged overlay.
      const owned = await kernel2.previewBranch({ branch: 'b', collection: 'posts', id: post.id, req: admin })
      expect(owned?.title).toBe('x')
      // A non-owner never sees the staged title — either null or a thrown Forbidden.
      let leaked: unknown
      try {
        leaked = await kernel2.previewBranch({ branch: 'b', collection: 'posts', id: post.id, req: viewer })
      } catch (e: any) {
        expect(`${e?.code}${e?.name}${e?.message}`).toMatch(FORBIDDEN)
        leaked = null
      }
      expect((leaked as any)?.title).not.toBe('x')
      // previewBranch for a non-existent live doc is null (the read returns nothing).
      const missing = await kernel2.previewBranch({ branch: 'b', collection: 'posts', id: 'no-such-id', req: admin })
      expect(missing).toBeNull()
    } finally {
      await kernel2.destroy()
    }
  })

  it('requires UPDATE access on the target doc to stage an edit', async () => {
    const doc = await kernel.create({ collection: 'locked', data: { title: 'Locked' }, ...admin })
    await kernel.createBranch({ name: 'try-locked', req: editor })
    // Editor can read but NOT update `locked` (admin-only).
    await rejectsLike(
      () =>
        kernel.stageChange({
          branch: 'try-locked',
          collection: 'locked',
          id: doc.id,
          data: { title: 'hacked' },
          req: editor,
        }),
      FORBIDDEN,
    )
    // Admin (who CAN update) may stage.
    const staged = await kernel.stageChange({
      branch: 'try-locked',
      collection: 'locked',
      id: doc.id,
      data: { title: 'fixed' },
      req: admin,
    })
    expect(staged.documentId).toBe(doc.id)
  })

  it('rejects staging an unknown field', async () => {
    const post = await kernel.create({ collection: 'posts', data: { title: 'x' }, ...editor })
    await kernel.createBranch({ name: 'unknown-field', req: editor })
    await rejectsLike(
      () =>
        kernel.stageChange({
          branch: 'unknown-field',
          collection: 'posts',
          id: post.id,
          data: { nope: 1 } as any,
          req: editor,
        }),
      BAD_REQUEST,
    )
  })

  it('rejects staging a __proto__ field (no prototype pollution)', async () => {
    const post = await kernel.create({ collection: 'posts', data: { title: 'x' }, ...editor })
    await kernel.createBranch({ name: 'proto', req: editor })
    // An OWN `__proto__` property (as a JSON payload over HTTP would produce), not a literal
    // prototype assignment — this is what the proto-guard must reject.
    const payload: any = JSON.parse('{"__proto__": {"polluted": true}}')
    await rejectsLike(
      () => kernel.stageChange({ branch: 'proto', collection: 'posts', id: post.id, data: payload, req: editor }),
      BAD_REQUEST,
    )
    expect(({} as any).polluted).toBeUndefined()
  })

  it('deep-merges when the same doc is staged again', async () => {
    const post = await kernel.create({ collection: 'posts', data: { title: 'Live', body: 'Live body' }, ...editor })
    await kernel.createBranch({ name: 'two-stages', req: editor })
    await kernel.stageChange({
      branch: 'two-stages',
      collection: 'posts',
      id: post.id,
      data: { title: 'New title' },
      req: editor,
    })
    await kernel.stageChange({
      branch: 'two-stages',
      collection: 'posts',
      id: post.id,
      data: { body: 'New body' },
      req: editor,
    })
    const preview = await kernel.previewBranch({ branch: 'two-stages', collection: 'posts', id: post.id, req: editor })
    expect(preview?.title).toBe('New title')
    expect(preview?.body).toBe('New body')
  })

  it('rejects staging on a non-existent document with NotFound', async () => {
    await kernel.createBranch({ name: 'missing-doc', req: editor })
    await rejectsLike(
      () =>
        kernel.stageChange({
          branch: 'missing-doc',
          collection: 'posts',
          id: 'does-not-exist',
          data: { title: 'x' },
          req: editor,
        }),
      /not.?found/i,
    )
  })
})

describe('diffBranch', () => {
  let kernel: Kernel
  beforeEach(async () => {
    kernel = await initKernel(branchesConfig(), { logLevel: 'error', autoMigrate: true })
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('lists the staged changes per document (collection, id, changed field names)', async () => {
    const a = await kernel.create({ collection: 'posts', data: { title: 'A' }, ...editor })
    const b = await kernel.create({ collection: 'posts', data: { title: 'B' }, ...editor })
    await kernel.createBranch({ name: 'diff-it', req: editor })
    await kernel.stageChange({
      branch: 'diff-it',
      collection: 'posts',
      id: a.id,
      data: { title: 'A2', body: 'note' },
      req: editor,
    })
    await kernel.stageChange({ branch: 'diff-it', collection: 'posts', id: b.id, data: { title: 'B2' }, req: editor })
    const diff = await kernel.diffBranch({ branch: 'diff-it', req: editor })
    expect(diff).toHaveLength(2)
    const forA = diff.find((d) => d.documentId === a.id)
    expect(forA?.collection).toBe('posts')
    expect(forA?.fields.sort()).toEqual(['body', 'title'])
    const forB = diff.find((d) => d.documentId === b.id)
    expect(forB?.fields).toEqual(['title'])
  })
})

describe('mergeBranch — replays through the real update', () => {
  let kernel: Kernel
  beforeEach(async () => {
    kernel = await initKernel(branchesConfig(), { logLevel: 'error', autoMigrate: true })
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('applies each staged change to the live doc, marks merged, and drops the overlay', async () => {
    const post = await kernel.create({ collection: 'posts', data: { title: 'Live', body: 'b' }, ...editor })
    const branch = await kernel.createBranch({ name: 'ship-it', req: editor })
    await kernel.stageChange({
      branch: branch.name,
      collection: 'posts',
      id: post.id,
      data: { title: 'Merged' },
      req: editor,
    })

    const result = await kernel.mergeBranch({ branch: branch.name, req: editor })
    expect(result.failed).toEqual([])
    expect(result.merged).toEqual([`posts:${post.id}`])

    // The LIVE doc now reflects the merged value.
    const live = await kernel.findByID({ collection: 'posts', id: post.id, req: editor })
    expect(live?.title).toBe('Merged')

    // The branch is marked merged and the overlay is gone.
    const branches = await kernel.listBranches({ req: editor })
    expect(branches.find((b) => b.name === branch.name)?.status).toBe('merged')
    expect(await kernel.diffBranch({ branch: branch.name, req: editor })).toEqual([])
  })

  it('replays through the NORMAL update (records an `update` audit entry, not a raw write)', async () => {
    const post = await kernel.create({ collection: 'posts', data: { title: 'Live' }, ...editor })
    const branch = await kernel.createBranch({ name: 'audit-proof', req: editor })
    await kernel.stageChange({
      branch: branch.name,
      collection: 'posts',
      id: post.id,
      data: { title: 'Via update' },
      req: editor,
    })
    await kernel.mergeBranch({ branch: branch.name, req: editor })

    const audit = await (kernel as any).findAuditLog({
      where: { and: [{ action: { equals: 'update' } }, { documentId: { equals: post.id } }] },
    })
    expect((audit?.docs ?? []).length).toBeGreaterThan(0)
  })

  it('reports a staged change that fails validation in failed[] without corrupting the live doc', async () => {
    const doc = await kernel.create({
      collection: 'locked',
      data: { title: 'Live', contact: 'good@example.com' },
      ...admin,
    })
    const branch = await kernel.createBranch({ name: 'bad-merge', req: admin })
    // Stage an INVALID email value (stage validates field NAMES, not values).
    await kernel.stageChange({
      branch: branch.name,
      collection: 'locked',
      id: doc.id,
      data: { contact: 'not-an-email' },
      req: admin,
    })

    const result = await kernel.mergeBranch({ branch: branch.name, req: admin })
    expect(result.merged).toEqual([])
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]?.collection).toBe('locked')
    expect(result.failed[0]?.documentId).toBe(doc.id)
    expect(result.failed[0]?.reason).toBeTruthy()

    // The live doc keeps its valid value — the failed merge did not corrupt it.
    const live = await kernel.findByID({ collection: 'locked', id: doc.id, req: admin })
    expect(live?.contact).toBe('good@example.com')
  })

  it('forbids a viewer (non-reviewer) from merging', async () => {
    const post = await kernel.create({ collection: 'posts', data: { title: 'x' }, ...editor })
    const branch = await kernel.createBranch({ name: 'no-merge', req: editor })
    await kernel.stageChange({
      branch: branch.name,
      collection: 'posts',
      id: post.id,
      data: { title: 'y' },
      req: editor,
    })
    await rejectsLike(() => kernel.mergeBranch({ branch: branch.name, req: viewer }), FORBIDDEN)
  })
})

describe('discardBranch', () => {
  let kernel: Kernel
  beforeEach(async () => {
    kernel = await initKernel(branchesConfig(), { logLevel: 'error', autoMigrate: true })
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('drops the overlay, leaves the live doc unchanged, and marks the branch discarded', async () => {
    const post = await kernel.create({ collection: 'posts', data: { title: 'Live' }, ...editor })
    const branch = await kernel.createBranch({ name: 'abandon', req: editor })
    await kernel.stageChange({
      branch: branch.name,
      collection: 'posts',
      id: post.id,
      data: { title: 'Never' },
      req: editor,
    })

    await kernel.discardBranch({ branch: branch.name, req: editor })

    const live = await kernel.findByID({ collection: 'posts', id: post.id, req: editor })
    expect(live?.title).toBe('Live')
    expect(await kernel.diffBranch({ branch: branch.name, req: editor })).toEqual([])
    const branches = await kernel.listBranches({ req: editor })
    expect(branches.find((b) => b.name === branch.name)?.status).toBe('discarded')
  })

  it('forbids a viewer (non-reviewer) from discarding', async () => {
    const branch = await kernel.createBranch({ name: 'guard-discard', req: editor })
    await rejectsLike(() => kernel.discardBranch({ branch: branch.name, req: viewer }), FORBIDDEN)
  })

  it('cannot stage on a discarded branch (BadRequest)', async () => {
    const post = await kernel.create({ collection: 'posts', data: { title: 'x' }, ...editor })
    const branch = await kernel.createBranch({ name: 'closed', req: editor })
    await kernel.discardBranch({ branch: branch.name, req: editor })
    await rejectsLike(
      () =>
        kernel.stageChange({
          branch: branch.name,
          collection: 'posts',
          id: post.id,
          data: { title: 'y' },
          req: editor,
        }),
      /bad.?request|not open|discarded/i,
    )
  })

  it('cannot stage on a merged branch (BadRequest)', async () => {
    const post = await kernel.create({ collection: 'posts', data: { title: 'x' }, ...editor })
    const branch = await kernel.createBranch({ name: 'shipped', req: editor })
    await kernel.stageChange({
      branch: branch.name,
      collection: 'posts',
      id: post.id,
      data: { title: 'y' },
      req: editor,
    })
    await kernel.mergeBranch({ branch: branch.name, req: editor })
    await rejectsLike(
      () =>
        kernel.stageChange({
          branch: branch.name,
          collection: 'posts',
          id: post.id,
          data: { title: 'z' },
          req: editor,
        }),
      /bad.?request|not open|merged/i,
    )
  })
})

describe('system-table isolation + disabled', () => {
  it('does not expose _branches / _branch_docs via generic CRUD', async () => {
    const kernel = await initKernel(branchesConfig(), { logLevel: 'error', autoMigrate: true })
    try {
      await rejectsLike(() => kernel.find({ collection: '_branches', req: admin }), /bad.?request|unknown/i)
      await rejectsLike(() => kernel.find({ collection: '_branch_docs', req: admin }), /bad.?request|unknown/i)
      await rejectsLike(
        () => kernel.create({ collection: '_branches', data: { name: 'x' }, overrideAccess: true }),
        /bad.?request|unknown/i,
      )
      await rejectsLike(
        () => kernel.create({ collection: '_branch_docs', data: { branch: 'x' }, overrideAccess: true }),
        /bad.?request|unknown/i,
      )
    } finally {
      await kernel.destroy()
    }
  })

  it('with branches:false, listBranches returns [] and the mutating ops throw a clean not-enabled error', async () => {
    const kernel = await initKernel(branchesConfig({ branches: false }), { logLevel: 'error', autoMigrate: true })
    try {
      expect(await kernel.listBranches({ req: admin })).toEqual([])
      await rejectsLike(() => kernel.createBranch({ name: 'x', req: admin }), /not.?enabled|not enabled|bad.?request/i)
      await rejectsLike(
        () => kernel.stageChange({ branch: 'x', collection: 'posts', id: 'y', data: { title: 'z' }, req: admin }),
        /not.?enabled|not enabled|bad.?request/i,
      )
      await rejectsLike(() => kernel.mergeBranch({ branch: 'x', req: admin }), /not.?enabled|not enabled|bad.?request/i)
    } finally {
      await kernel.destroy()
    }
  })
})
