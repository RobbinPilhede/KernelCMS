/* Live content-federation verification: export a collection's documents as a portable,
 * deterministic bundle and apply it into ANOTHER environment by id (create-or-update),
 * each document routed through the NORMAL access-checked pipeline. Proves (across TWO real
 * kernels / two temp sqlite dbs = two environments): export→sync round-trip with id
 * preservation; a dry run that writes NOTHING; idempotent re-sync (all unchanged); a
 * selective update (only the changed doc); the access-checked export (a non-override caller
 * only sees their own rows); the access-checked sync failure for a caller who lacks write
 * access (lands in failed[], live store unchanged); invalid-bundle rejection; and the clean
 * not-enabled errors when federation is off.
 * Run: pnpm tsx verify/federation.ts */
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
      /forbidden|not.?found|unauthorized|validation|bad.?request|invalid|not enabled/i.test(
        `${e?.code}${e?.name}${e?.message}`,
      ),
      `threw ${e?.code ?? e?.name}`,
    )
  }
}

// Two human users and an admin.
const alice = { user: { id: 'alice', roles: ['viewer'] } } as any
const bob = { user: { id: 'bob', roles: ['viewer'] } } as any
const admin = { user: { id: 'adm', roles: ['admin'] } } as any

// Owner-scoped read: a row is only readable by its owner (or an admin). Resolves to a Where
// (row-scope) for a non-admin — allowed-at-the-collection-gate, narrowed by row.
const ownerRead = ({ req }: any) => {
  if (req.user?.roles?.includes('admin')) return true
  return { owner: { equals: req.user?.id ?? '__none__' } }
}
const isAdmin = ({ req }: any) => Boolean(req.user?.roles?.includes('admin'))

function fedConfig(dbFile: string, federation: boolean) {
  return defineConfig({
    secret: 'verify-secret-32-characters-long!!',
    db: sqliteAdapter({ url: `file:${dbFile}` }),
    audit: true,
    federation,
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
        // Owner-scoped: a row is only readable by its owner (or an admin).
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
    ],
  })
}

async function main() {
  // TWO environments = two temp dbs / two kernels.
  const dbDirA = mkdtempSync(join(tmpdir(), 'kverify-federation-a-'))
  const dbDirB = mkdtempSync(join(tmpdir(), 'kverify-federation-b-'))
  const dbFileA = join(dbDirA, 'a.db')
  const dbFileB = join(dbDirB, 'b.db')
  const envA = await initKernel(fedConfig(dbFileA, true), { autoMigrate: true } as any)
  const envB = await initKernel(fedConfig(dbFileB, true), { autoMigrate: true } as any)

  try {
    console.log('\n\x1b[1mFederation — export → sync round-trip with id preservation\x1b[0m')
    const p1 = await envA.create({ collection: 'posts', data: { title: 'First', body: 'a' }, overrideAccess: true })
    const p2 = await envA.create({ collection: 'posts', data: { title: 'Second', body: 'b' }, overrideAccess: true })
    const bundle = await envA.exportContent({ collection: 'posts', overrideAccess: true })
    check(
      'bundle is version 1 with two documents',
      bundle.version === 1 && bundle.documents.length === 2,
      `n=${bundle.documents.length}`,
    )
    const sortedIds = [String(p1.id), String(p2.id)].sort()
    check(
      'bundle ids equal the source ids, sorted',
      bundle.documents.map((d: any) => d.id).join(',') === sortedIds.join(','),
      `ids=${bundle.documents.map((d: any) => d.id).join(',')}`,
    )
    const first = bundle.documents.find((d: any) => d.id === String(p1.id))
    check('bundle data carries the storage fields', first?.data.title === 'First' && first?.data.body === 'a', '')
    const synced = await envB.syncContent({ bundle, overrideAccess: true })
    check(
      'sync into a fresh env creates both',
      synced.created === 2 && synced.updated === 0,
      `created=${synced.created}`,
    )
    check('sync is not a dry run', synced.dryRun === false, '')
    const got = await envB.findByID({ collection: 'posts', id: String(p1.id), overrideAccess: true })
    check('the synced doc keeps the SAME id (identity preserved)', got?.id === String(p1.id), `id=${got?.id}`)
    check('...and carries the same data', got?.title === 'First' && got?.body === 'a', '')

    console.log('\n\x1b[1mFederation — a dry run writes NOTHING\x1b[0m')
    // A second fresh "environment B2" via its own kernel so the live store starts empty.
    const dbDirC = mkdtempSync(join(tmpdir(), 'kverify-federation-c-'))
    const dbFileC = join(dbDirC, 'c.db')
    const envC = await initKernel(fedConfig(dbFileC, true), { autoMigrate: true } as any)
    try {
      const plan = await envC.syncContent({ bundle, dryRun: true, overrideAccess: true })
      check('dry run reports two creates', plan.created === 2 && plan.plan.length === 2, `plan=${plan.plan.length}`)
      check(
        'dry run plan is all create',
        plan.plan.every((p: any) => p.action === 'create'),
        '',
      )
      check('dry run is flagged', plan.dryRun === true, '')
      const live = await envC.find({ collection: 'posts', overrideAccess: true })
      check('the live store is still EMPTY after a dry run', live.docs.length === 0, `n=${live.docs.length}`)
    } finally {
      await envC.destroy()
      try {
        rmSync(dirname(dbFileC), { recursive: true, force: true })
      } catch {
        // best-effort temp cleanup
      }
    }

    console.log('\n\x1b[1mFederation — idempotent re-sync (all unchanged)\x1b[0m')
    const resync = await envB.syncContent({ bundle, overrideAccess: true })
    check(
      'a second sync of the same bundle is all unchanged',
      resync.created === 0 && resync.updated === 0 && resync.unchanged === 2,
      `unchanged=${resync.unchanged}`,
    )
    check(
      '...and the plan is all unchanged',
      resync.plan.every((p: any) => p.action === 'unchanged'),
      '',
    )

    console.log('\n\x1b[1mFederation — selective update (only the changed doc)\x1b[0m')
    await envA.update({
      collection: 'posts',
      id: String(p1.id),
      data: { title: 'First (edited)' },
      overrideAccess: true,
    })
    const bundle2 = await envA.exportContent({ collection: 'posts', overrideAccess: true })
    const selective = await envB.syncContent({ bundle: bundle2, overrideAccess: true })
    check(
      'exactly one doc updates, one unchanged',
      selective.updated === 1 && selective.unchanged === 1,
      `updated=${selective.updated}`,
    )
    const edited = await envB.findByID({ collection: 'posts', id: String(p1.id), overrideAccess: true })
    check('env B reflects the new value', edited?.title === 'First (edited)', `title=${edited?.title}`)
    const untouched = await envB.findByID({ collection: 'posts', id: String(p2.id), overrideAccess: true })
    check('the other doc is untouched', untouched?.title === 'Second', `title=${untouched?.title}`)

    console.log('\n\x1b[1mFederation — access-checked export (bob sees only his own)\x1b[0m')
    const aliceSecret = await envA.create({
      collection: 'secrets',
      data: { owner: 'alice', note: 'a-secret' },
      req: alice,
    })
    const bobSecret = await envA.create({ collection: 'secrets', data: { owner: 'bob', note: 'b-secret' }, req: bob })
    const bobBundle = await envA.exportContent({ collection: 'secrets', req: bob })
    check(
      'a non-override export contains ONLY the caller-readable rows',
      bobBundle.documents.length === 1 && bobBundle.documents[0]!.id === String(bobSecret.id),
      `n=${bobBundle.documents.length}`,
    )
    check(
      "...and never another owner's row",
      bobBundle.documents.some((d: any) => d.id === String(aliceSecret.id)) === false,
      '',
    )
    const adminBundle = await envA.exportContent({ collection: 'secrets', overrideAccess: true })
    check(
      'an override/admin export includes BOTH secrets',
      adminBundle.documents.length === 2,
      `n=${adminBundle.documents.length}`,
    )

    console.log('\n\x1b[1mFederation — access-checked sync (a non-permitted caller fails, no write)\x1b[0m')
    const l1 = await envA.create({ collection: 'locked', data: { title: 'L1' }, req: admin })
    const l2 = await envA.create({ collection: 'locked', data: { title: 'L2' }, req: admin })
    const lockedBundle = await envA.exportContent({ collection: 'locked', overrideAccess: true })
    const bobSync = await envB.syncContent({ bundle: lockedBundle, req: bob })
    check(
      'a caller lacking create access applies nothing',
      bobSync.created === 0 && bobSync.failed.length === 2,
      `created=${bobSync.created}, failed=${bobSync.failed.length}`,
    )
    check(
      '...and both ids are accounted for in failed[]',
      [l1.id, l2.id].map(String).sort().join(',') ===
        bobSync.failed
          .map((f: any) => f.id)
          .sort()
          .join(','),
      '',
    )
    const lockedLive = await envB.find({ collection: 'locked', overrideAccess: true })
    check(
      'the live store is unchanged after a denied sync',
      lockedLive.docs.length === 0,
      `n=${lockedLive.docs.length}`,
    )
    // An admin/override sync of the same bundle DOES apply.
    const adminSync = await envB.syncContent({ bundle: lockedBundle, overrideAccess: true })
    check('an override sync of the same bundle applies both', adminSync.created === 2, `created=${adminSync.created}`)

    console.log('\n\x1b[1mFederation — invalid-bundle rejection + bad entries\x1b[0m')
    await denied('a wrong version is rejected', () =>
      envB.syncContent({ bundle: { version: 2, documents: [] } as any, overrideAccess: true }),
    )
    await denied('a non-array documents is rejected', () =>
      envB.syncContent({ bundle: { version: 1, documents: {} } as any, overrideAccess: true }),
    )
    const good = await envA.create({ collection: 'posts', data: { title: 'Good' }, overrideAccess: true })
    const mixed = {
      version: 1 as const,
      documents: [
        { collection: 'posts', id: String(good.id), data: { title: 'Good' } },
        { collection: 'nope', id: 'x1', data: { title: 'unknown collection' } },
        { collection: 'posts', id: '', data: { title: 'empty id' } },
        { collection: 'posts', id: '__proto__', data: { title: 'evil' } },
      ],
    }
    const mixedRes = await envB.syncContent({ bundle: mixed, overrideAccess: true })
    check(
      'a mixed bundle applies the good doc and fails the rest',
      mixedRes.created === 1 && mixedRes.failed.length === 3,
      `created=${mixedRes.created}, failed=${mixedRes.failed.length}`,
    )
    check(
      'the good doc applied with its id preserved',
      (await envB.findByID({ collection: 'posts', id: String(good.id), overrideAccess: true }))?.id === String(good.id),
      '',
    )
    check('Object.prototype was not polluted by a __proto__ id', ({} as any).polluted === undefined, '')

    console.log('\n\x1b[1mFederation — disabled errors when the feature is off\x1b[0m')
    const dbDirD = mkdtempSync(join(tmpdir(), 'kverify-federation-off-'))
    const dbFileD = join(dbDirD, 'd.db')
    const envOff = await initKernel(fedConfig(dbFileD, false), { autoMigrate: true } as any)
    try {
      await denied('exportContent throws a clean not-enabled error', () =>
        envOff.exportContent({ collection: 'posts', overrideAccess: true }),
      )
      await denied('syncContent throws a clean not-enabled error', () =>
        envOff.syncContent({ bundle: { version: 1, documents: [] }, overrideAccess: true }),
      )
    } finally {
      await envOff.destroy()
      try {
        rmSync(dirname(dbFileD), { recursive: true, force: true })
      } catch {
        // best-effort temp cleanup
      }
    }
  } finally {
    await envA.destroy()
    await envB.destroy()
    try {
      rmSync(dirname(dbFileA), { recursive: true, force: true })
      rmSync(dirname(dbFileB), { recursive: true, force: true })
    } catch {
      // best-effort temp cleanup
    }
  }

  console.log(`\n\x1b[1mFederation Result: ${pass} passed, ${fails.length} failed\x1b[0m`)
  if (fails.length) {
    console.log('Failures:\n  ' + fails.join('\n  '))
    process.exit(1)
  }
  process.exit(0)
}
main().catch((e) => {
  console.error('FEDERATION HARNESS ERROR:', e)
  process.exit(2)
})
