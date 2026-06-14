/* Live content-branches verification: a named workspace where field edits are STAGED as a
 * copy-on-write overlay (the live document is never touched), previewed/diffed, then merged
 * (each staged change replayed through the normal access-checked `update`) or discarded.
 * Proves: reviewer-gated create/merge/discard (a viewer/anon is rejected); copy-on-write (the
 * live doc is UNCHANGED after staging); the preview overlay (staged fields over the live read);
 * the diff; merge applies to the live doc + marks `merged` + clears the overlay (and replays
 * through the REAL `update` — proven via the `update` audit entry); discard drops the overlay +
 * marks `discarded`; the stage-time UPDATE-access gate (you must be able to update the doc); and
 * that `_branches` / `_branch_docs` are not reachable via generic CRUD.
 * Run: pnpm tsx verify/branches.ts */
import { mkdtempSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig, initKernel } from '@kernel/core'
import { sqliteAdapter } from '@kernel/db-sqlite'

let pass = 0
const fails: string[] = []
const check = (n: string, c: boolean, e = '') => {
  if (c) {
    pass++
    console.log(`  \x1b[32mPASS\x1b[0m ${n}${e ? ` — ${e}` : ''}`)
  } else {
    fails.push(n)
    console.log(`  \x1b[31mFAIL\x1b[0m ${n}${e ? ` — ${e}` : ''}`)
  }
}
async function denied(n: string, fn: () => Promise<unknown>) {
  try {
    await fn()
    check(n, false, 'expected an error, succeeded')
  } catch (e: any) {
    check(
      n,
      /forbidden|not.?found|unauthorized|validation|bad.?request|invalid|conflict/i.test(
        `${e?.code}${e?.name}${e?.message}`,
      ),
      `threw ${e?.code ?? e?.name}`,
    )
  }
}

// A reviewer (editor), an admin (reviewer + the only one who can update `locked`), a non-reviewer
// viewer, and anonymous (no user).
const editor = { user: { id: 'ed', roles: ['editor'] } } as any
const admin = { user: { id: 'adm', roles: ['admin'] } } as any
const viewer = { user: { id: 'vw', roles: ['viewer'] } } as any
const anon = { user: null } as any

// `locked` is admin-only to UPDATE — the stage gate must mirror this.
const adminUpdate = ({ req }: any) => Boolean(req.user?.roles?.includes('admin'))

async function main() {
  const dbDir = mkdtempSync(join(tmpdir(), 'kverify-branches-'))
  const dbFile = join(dbDir, 'b.db')
  const config = defineConfig({
    secret: 'verify-secret-32-characters-long!!',
    db: sqliteAdapter({ url: `file:${dbFile}` }),
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
        // Admin-only UPDATE — used to prove the stage gate requires update access.
        slug: 'locked',
        access: { read: () => true, create: () => true, update: adminUpdate },
        fields: [
          { name: 'title', type: 'text', required: true },
          { name: 'contact', type: 'email' },
        ],
      },
    ],
  })
  const kernel = await initKernel(config, { autoMigrate: true } as any)

  try {
    console.log('\n\x1b[1mBranches — create is reviewer-gated + name validated\x1b[0m')
    const branch = await kernel.createBranch({ name: 'feature-x', req: editor })
    check(
      'an editor (reviewer) can create an open branch',
      branch.status === 'open' && branch.name === 'feature-x',
      `status=${branch.status}`,
    )
    check('createdBy comes from the principal', branch.createdBy === 'ed', `createdBy=${branch.createdBy}`)
    await denied('a viewer (non-reviewer) CANNOT create a branch', () =>
      kernel.createBranch({ name: 'nope', req: viewer }),
    )
    await denied('an anonymous caller CANNOT create a branch', () => kernel.createBranch({ name: 'ghost', req: anon }))
    await denied('an invalid name (spaces) is rejected', () => kernel.createBranch({ name: 'has spaces', req: editor }))
    await denied('an over-long name (> 80 chars) is rejected', () =>
      kernel.createBranch({ name: 'a'.repeat(81), req: editor }),
    )
    await denied('a duplicate name is a Conflict', () => kernel.createBranch({ name: 'feature-x', req: admin }))
    const open = await kernel.listBranches({ status: 'open', req: editor })
    check(
      'listBranches(status:open) returns the open branch',
      open.some((b: any) => b.name === 'feature-x'),
      `n=${open.length}`,
    )

    console.log('\n\x1b[1mBranches — copy-on-write: the LIVE doc is never touched by a stage\x1b[0m')
    const post = await kernel.create({ collection: 'posts', data: { title: 'Live', body: 'original' }, ...editor })
    await kernel.stageChange({
      branch: 'feature-x',
      collection: 'posts',
      id: post.id,
      data: { title: 'Staged' },
      req: editor,
    })
    const liveAfterStage = await kernel.findByID({ collection: 'posts', id: post.id, req: editor })
    check(
      'the LIVE doc is UNCHANGED after staging',
      liveAfterStage?.title === 'Live',
      `live.title="${liveAfterStage?.title}"`,
    )

    console.log('\n\x1b[1mBranches — preview overlays the staged fields on the live doc\x1b[0m')
    const preview = await kernel.previewBranch({ branch: 'feature-x', collection: 'posts', id: post.id, req: editor })
    check(
      'preview shows the STAGED title',
      (preview as any)?.title === 'Staged',
      `preview.title="${(preview as any)?.title}"`,
    )
    check(
      'preview keeps the unstaged body from live',
      (preview as any)?.body === 'original',
      `preview.body="${(preview as any)?.body}"`,
    )

    console.log('\n\x1b[1mBranches — re-staging the same doc deep-merges\x1b[0m')
    await kernel.stageChange({
      branch: 'feature-x',
      collection: 'posts',
      id: post.id,
      data: { body: 'staged body' },
      req: editor,
    })
    const preview2 = await kernel.previewBranch({ branch: 'feature-x', collection: 'posts', id: post.id, req: editor })
    check(
      're-stage deep-merges (both staged fields present)',
      (preview2 as any)?.title === 'Staged' && (preview2 as any)?.body === 'staged body',
      `title="${(preview2 as any)?.title}" body="${(preview2 as any)?.body}"`,
    )

    console.log('\n\x1b[1mBranches — diff lists the staged changes\x1b[0m')
    const diff = await kernel.diffBranch({ branch: 'feature-x', req: editor })
    const entry = diff.find((d: any) => d.documentId === post.id)
    check(
      'diff lists the staged doc (collection + id)',
      entry?.collection === 'posts',
      `collection=${entry?.collection}`,
    )
    check(
      'diff lists the changed field names',
      (entry?.fields ?? []).slice().sort().join(',') === 'body,title',
      `fields=${entry?.fields}`,
    )

    console.log('\n\x1b[1mBranches — stage requires UPDATE access on the target doc\x1b[0m')
    const lockedDoc = await kernel.create({ collection: 'locked', data: { title: 'Locked' }, ...admin })
    await kernel.createBranch({ name: 'touch-locked', req: editor })
    // Editor can READ but not UPDATE `locked` → cannot stage an edit to it.
    await denied('an editor who cannot UPDATE the doc CANNOT stage an edit', () =>
      kernel.stageChange({
        branch: 'touch-locked',
        collection: 'locked',
        id: lockedDoc.id,
        data: { title: 'hacked' },
        req: editor,
      }),
    )
    const stagedByAdmin = await kernel.stageChange({
      branch: 'touch-locked',
      collection: 'locked',
      id: lockedDoc.id,
      data: { title: 'fixed' },
      req: admin,
    })
    check('an admin who CAN update the doc may stage', stagedByAdmin.documentId === lockedDoc.id, '')
    await denied('an unknown field is rejected', () =>
      kernel.stageChange({
        branch: 'feature-x',
        collection: 'posts',
        id: post.id,
        data: { ghost: 1 } as any,
        req: editor,
      }),
    )
    const evil = JSON.parse('{"__proto__": {"polluted": true}}')
    await denied('a JSON __proto__ field is rejected (no pollution)', () =>
      kernel.stageChange({ branch: 'feature-x', collection: 'posts', id: post.id, data: evil, req: editor }),
    )
    check('Object.prototype was not polluted', ({} as any).polluted === undefined, '')

    console.log('\n\x1b[1mBranches — merge is reviewer-gated, applies to live, replays through update\x1b[0m')
    await denied('a viewer (non-reviewer) CANNOT merge', () => kernel.mergeBranch({ branch: 'feature-x', req: viewer }))
    const merge = await kernel.mergeBranch({ branch: 'feature-x', req: editor })
    check(
      'merge reports the merged change id',
      merge.merged.includes(`posts:${post.id}`) && merge.failed.length === 0,
      `merged=${merge.merged.length} failed=${merge.failed.length}`,
    )
    const liveAfterMerge = await kernel.findByID({ collection: 'posts', id: post.id, req: editor })
    check(
      'merge APPLIED the staged values to the live doc',
      liveAfterMerge?.title === 'Staged' && liveAfterMerge?.body === 'staged body',
      `live.title="${liveAfterMerge?.title}"`,
    )
    const merged = (await kernel.listBranches({ req: editor })).find((b: any) => b.name === 'feature-x')
    check('the branch is marked merged', merged?.status === 'merged', `status=${merged?.status}`)
    check(
      'the overlay is gone after merge (diff empty)',
      (await kernel.diffBranch({ branch: 'feature-x', req: editor })).length === 0,
      '',
    )
    // Merge replays through the NORMAL access-checked `update` — proven by the `update` audit
    // entry for the doc (a raw db write would record nothing).
    const updAudit = await (kernel as any).findAuditLog({
      where: { and: [{ action: { equals: 'update' } }, { documentId: { equals: post.id } }] },
    })
    check(
      'merge replayed through the real `update` (audit entry present)',
      (updAudit?.docs ?? []).length > 0,
      `entries=${updAudit?.docs?.length ?? 0}`,
    )
    await denied('a merged branch cannot be staged on (not open)', () =>
      kernel.stageChange({
        branch: 'feature-x',
        collection: 'posts',
        id: post.id,
        data: { title: 'late' },
        req: editor,
      }),
    )

    console.log('\n\x1b[1mBranches — merge respects validation (bad change lands in failed[], live intact)\x1b[0m')
    const valDoc = await kernel.create({
      collection: 'locked',
      data: { title: 'V', contact: 'good@example.com' },
      ...admin,
    })
    await kernel.createBranch({ name: 'bad-merge', req: admin })
    await kernel.stageChange({
      branch: 'bad-merge',
      collection: 'locked',
      id: valDoc.id,
      data: { contact: 'not-an-email' },
      req: admin,
    })
    const badMerge = await kernel.mergeBranch({ branch: 'bad-merge', req: admin })
    check(
      'an invalid staged change lands in failed[] with a reason',
      badMerge.failed.length === 1 && Boolean(badMerge.failed[0]?.reason),
      `failed=${badMerge.failed.length}`,
    )
    const valLive = await kernel.findByID({ collection: 'locked', id: valDoc.id, req: admin })
    check(
      'the failed merge did NOT corrupt the live doc',
      valLive?.contact === 'good@example.com',
      `contact="${valLive?.contact}"`,
    )

    console.log('\n\x1b[1mBranches — discard is reviewer-gated, drops the overlay, live intact\x1b[0m')
    const disPost = await kernel.create({ collection: 'posts', data: { title: 'Keep' }, ...editor })
    await kernel.createBranch({ name: 'abandon', req: editor })
    await kernel.stageChange({
      branch: 'abandon',
      collection: 'posts',
      id: disPost.id,
      data: { title: 'Never' },
      req: editor,
    })
    await denied('a viewer (non-reviewer) CANNOT discard', () =>
      kernel.discardBranch({ branch: 'abandon', req: viewer }),
    )
    await kernel.discardBranch({ branch: 'abandon', req: editor })
    const disLive = await kernel.findByID({ collection: 'posts', id: disPost.id, req: editor })
    check('discard left the live doc UNCHANGED', disLive?.title === 'Keep', `live.title="${disLive?.title}"`)
    check(
      'discard dropped the overlay (diff empty)',
      (await kernel.diffBranch({ branch: 'abandon', req: editor })).length === 0,
      '',
    )
    const discarded = (await kernel.listBranches({ req: editor })).find((b: any) => b.name === 'abandon')
    check('the branch is marked discarded', discarded?.status === 'discarded', `status=${discarded?.status}`)

    console.log('\n\x1b[1mBranches — _branches / _branch_docs are NOT reachable via generic CRUD\x1b[0m')
    await denied('find(_branches) is rejected (system table)', () => kernel.find({ collection: '_branches', ...admin }))
    await denied('find(_branch_docs) is rejected (system table)', () =>
      kernel.find({ collection: '_branch_docs', ...admin }),
    )
    await denied('create(_branches) is rejected (system table)', () =>
      kernel.create({ collection: '_branches', data: { name: 'x' }, overrideAccess: true }),
    )
    await denied('create(_branch_docs) is rejected (system table)', () =>
      kernel.create({ collection: '_branch_docs', data: { branch: 'x' }, overrideAccess: true }),
    )

    console.log('\n\x1b[1mBranches — audit trail\x1b[0m')
    const createAudit = await (kernel as any).findAuditLog({ where: { action: { equals: 'branch.create' } } })
    check(
      'branch.create recorded in audit log',
      (createAudit?.docs ?? []).length > 0,
      `entries=${createAudit?.docs?.length ?? 0}`,
    )
    const mergeAudit = await (kernel as any).findAuditLog({ where: { action: { equals: 'branch.merge' } } })
    check(
      'branch.merge recorded in audit log',
      (mergeAudit?.docs ?? []).length > 0,
      `entries=${mergeAudit?.docs?.length ?? 0}`,
    )
    const discardAudit = await (kernel as any).findAuditLog({ where: { action: { equals: 'branch.discard' } } })
    check(
      'branch.discard recorded in audit log',
      (discardAudit?.docs ?? []).length > 0,
      `entries=${discardAudit?.docs?.length ?? 0}`,
    )
  } finally {
    await kernel.destroy()
    try {
      rmSync(dirname(dbFile), { recursive: true, force: true })
    } catch {
      // best-effort temp cleanup
    }
  }

  console.log(`\n\x1b[1mBranches Result: ${pass} passed, ${fails.length} failed\x1b[0m`)
  if (fails.length) {
    console.log('Failures:\n  ' + fails.join('\n  '))
    process.exit(1)
  }
  process.exit(0)
}
main().catch((e) => {
  console.error('BRANCHES HARNESS ERROR:', e)
  process.exit(2)
})
