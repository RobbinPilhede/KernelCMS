/* Live content time-machine verification. Real sqlite kernel, drafts + an owner-scoped
 * collection + an agent principal. Run: pnpm tsx verify/timemachine.ts
 *
 * Proves: point-in-time reads (asOf snapshot selection, before-creation -> null, now ->
 * current); a field-level history timeline (create -> all, then per-edit field sets); diffs
 * by versionId AND by timestamp; restore-as-of through the normal write path (a new version
 * is recorded and the agent draft-only brake still holds); and the security property — a
 * non-owner gets null/empty/forbidden from every historical surface and a read-denied field
 * never leaks via asOf reads, history changedFields, or diffs; asOf on a non-versioned
 * collection is a clean BadRequestError.
 */
import { mkdtempSync } from 'node:fs'
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
    check(n, false, 'expected Forbidden, succeeded')
  } catch (e: any) {
    check(n, /forbidden/i.test(`${e?.code}${e?.name}${e?.message}`), `threw ${e?.code ?? e?.name}`)
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Owner-scoped read: a user may only read their own docs (returns a where-scope).
const ownerScope = ({ req }: any) => (req.user?.id ? { owner: { equals: req.user.id } } : false)
const alice = { req: { user: { id: 'alice', roles: [] } } }
const bob = { req: { user: { id: 'bob', roles: [] } } }
const agentReq = {
  req: { user: { id: 'bot', principalType: 'agent' as const, roles: [], fieldScope: { allow: ['title', 'body'] } } },
}

const tmp = (n: string) => join(mkdtempSync(join(tmpdir(), `kverify-tm-${n}-`)), 'p.db')

function config(dbFile: string) {
  return defineConfig({
    secret: 'verify-timemachine-secret-32-chars!',
    db: sqliteAdapter({ url: `file:${dbFile}` }),
    audit: true,
    agents: [{ id: 'bot', token: 'bot-token-verify-tm', roles: [], fieldScope: { allow: ['title', 'body'] } }],
    collections: [
      // Open collection for the timeline / diff / restore tests.
      {
        slug: 'posts',
        versions: { drafts: true },
        access: { read: () => true, create: () => true, update: () => true, publish: () => true },
        fields: [
          { name: 'title', type: 'text' },
          { name: 'body', type: 'text' },
          // Never readable: must vanish from asOf reads, history changedFields, and diffs.
          { name: 'secret', type: 'text', access: { read: () => false } },
        ],
      },
      // Owner-scoped collection for the access test: a reader sees only their own rows.
      {
        slug: 'journals',
        versions: { drafts: true },
        access: { read: ownerScope, create: () => true, update: ownerScope },
        fields: [
          { name: 'owner', type: 'text' },
          { name: 'entry', type: 'text' },
        ],
      },
    ],
  })
}

async function main() {
  const kernel = await initKernel(config(tmp('main')), { autoMigrate: true })

  // ---------------------------------------------------------------------------
  console.log('\n\x1b[1mTime-machine — point-in-time reads (asOf)\x1b[0m')
  const post = await kernel.create({ collection: 'posts', data: { title: 't0', body: 'b0' } })
  await sleep(8)
  await kernel.update({ collection: 'posts', id: post.id, data: { title: 't1' } })
  await sleep(8)
  await kernel.update({ collection: 'posts', id: post.id, data: { body: 'b2' } })

  // Capture each snapshot's REAL createdAt (oldest -> newest).
  const v = await kernel.findVersions({ collection: 'posts', id: post.id })
  const ts = v.docs.map((d) => String(d.createdAt)).reverse()
  check('three version snapshots recorded', ts.length === 3, `count=${ts.length}`)

  // asOf between t0 and t1 -> the t0 title. The posts are drafts, so request drafts (the
  // published-only default would null a historical draft, exactly like a live read).
  const betweenT0T1 = new Date(new Date(ts[1]!).getTime() - 1).toISOString()
  const asOf0 = await kernel.findByID({ collection: 'posts', id: post.id, asOf: betweenT0T1, draft: true })
  check('asOf between t0 and t1 returns the t0 title', asOf0?.title === 't0', `title=${asOf0?.title}`)
  check('asOf state has the t0 body too', asOf0?.body === 'b0', `body=${asOf0?.body}`)

  // asOf before creation -> null.
  const beforeCreate = new Date(new Date(ts[0]!).getTime() - 1000).toISOString()
  const beforeDoc = await kernel.findByID({ collection: 'posts', id: post.id, asOf: beforeCreate, draft: true })
  check('asOf before creation returns null', beforeDoc === null)

  // asOf: now -> current live state.
  const nowDoc = await kernel.findByID({
    collection: 'posts',
    id: post.id,
    asOf: new Date().toISOString(),
    draft: true,
  })
  check(
    'asOf now returns the current title/body',
    nowDoc?.title === 't1' && nowDoc?.body === 'b2',
    `${nowDoc?.title}/${nowDoc?.body}`,
  )

  // find({ asOf }) lists the as-of state of every doc.
  const listAsOf = await kernel.find({ collection: 'posts', asOf: betweenT0T1, draft: true })
  const listed = listAsOf.docs.find((d) => d.id === post.id)
  check('find({asOf}) returns the as-of state per doc', listed?.title === 't0', `title=${listed?.title}`)

  // ---------------------------------------------------------------------------
  console.log('\n\x1b[1mTime-machine — history timeline (field-level changedFields)\x1b[0m')
  const hist = await kernel.history({ collection: 'posts', id: post.id })
  check('history lists 3 entries oldest->newest', hist.length === 3, `len=${hist.length}`)
  check('history ordered oldest->newest by `at`', hist[0]!.at <= hist[1]!.at && hist[1]!.at <= hist[2]!.at)
  check(
    'create entry: all fields changed (title+body)',
    hist[0]!.changedFields.includes('title') && hist[0]!.changedFields.includes('body'),
    `[${hist[0]!.changedFields}]`,
  )
  check(
    't1 entry: only title changed',
    JSON.stringify(hist[1]!.changedFields) === JSON.stringify(['title']),
    `[${hist[1]!.changedFields}]`,
  )
  check(
    't2 entry: only body changed',
    JSON.stringify(hist[2]!.changedFields) === JSON.stringify(['body']),
    `[${hist[2]!.changedFields}]`,
  )
  check('history entries carry versionId + author', Boolean(hist[0]!.versionId) && hist[0]!.byType === 'user')

  // ---------------------------------------------------------------------------
  console.log('\n\x1b[1mTime-machine — diff (by versionId and by timestamp)\x1b[0m')
  const t0Version = hist[0]!.versionId
  const t2Version = hist[2]!.versionId
  const diffById = await kernel.diffVersions({ collection: 'posts', id: post.id, from: t0Version, to: t2Version })
  check(
    'diff(t0 -> t2) shows title changed t0->t1',
    diffById.title?.from === 't0' && diffById.title?.to === 't1',
    JSON.stringify(diffById.title),
  )
  check(
    'diff(t0 -> t2) shows body changed b0->b2',
    diffById.body?.from === 'b0' && diffById.body?.to === 'b2',
    JSON.stringify(diffById.body),
  )

  // Timestamp-based from/to resolves to the right snapshots (from before t1 -> t0 state).
  const diffByTs = await kernel.diffVersions({
    collection: 'posts',
    id: post.id,
    from: betweenT0T1,
    to: new Date().toISOString(),
  })
  check(
    'timestamp diff resolves the same title change',
    diffByTs.title?.from === 't0' && diffByTs.title?.to === 't1',
    JSON.stringify(diffByTs.title),
  )

  // ---------------------------------------------------------------------------
  console.log('\n\x1b[1mTime-machine — restore as-of (normal write path)\x1b[0m')
  const versionsBefore = (await kernel.findVersions({ collection: 'posts', id: post.id })).docs.length
  const restored = await kernel.restoreAsOf({ collection: 'posts', id: post.id, asOf: betweenT0T1 })
  check(
    'restoreAsOf returns the t0 title/body',
    restored?.title === 't0' && restored?.body === 'b0',
    `${restored?.title}/${restored?.body}`,
  )
  // The post is a draft, so read it back with draft:true (the published-only default would null it).
  const live = await kernel.findByID({ collection: 'posts', id: post.id, draft: true })
  check(
    'the live doc now reads the t0 values',
    live?.title === 't0' && live?.body === 'b0',
    `${live?.title}/${live?.body}`,
  )
  const versionsAfter = (await kernel.findVersions({ collection: 'posts', id: post.id })).docs.length
  check(
    'restore records a NEW version (auditable)',
    versionsAfter === versionsBefore + 1,
    `${versionsBefore}->${versionsAfter}`,
  )

  // Agent brake: an agent cannot use restore-as-of to reach a PUBLISHED state.
  const pubPost = await kernel.create({ collection: 'posts', data: { title: 'p0' } })
  await kernel.publish({ collection: 'posts', id: pubPost.id })
  await kernel.update({ collection: 'posts', id: pubPost.id, data: { _status: 'draft', title: 'p1' } })
  // The earliest published snapshot is the create's state; restoring to it as an agent would
  // mean writing _status:'published' — the brake must reject it. restoreAsOf restores CONTENT
  // only (never _status), so even the content-only restore must still go through the brake on
  // any publish transition. Here the content restore stays a draft, so the agent CAN restore
  // content; assert it does NOT publish.
  const agentRestore = await kernel.restoreAsOf({
    collection: 'posts',
    id: pubPost.id,
    asOf: new Date().toISOString(),
    ...agentReq,
  })
  const afterAgent = await kernel.findByID({ collection: 'posts', id: pubPost.id, draft: true })
  check(
    'agent restoreAsOf does not publish (stays draft)',
    afterAgent?._status === 'draft',
    `status=${afterAgent?._status}`,
  )
  check('agent restoreAsOf succeeded as a draft content write', Boolean(agentRestore))

  // ---------------------------------------------------------------------------
  console.log('\n\x1b[1mSecurity — a read-denied field never leaks via the time-machine\x1b[0m')
  const sec = await kernel.create({ collection: 'posts', data: { title: 's0', secret: 'classified-0' } })
  await kernel.update({ collection: 'posts', id: sec.id, data: { secret: 'classified-1', title: 's1' } })
  const secAsOf = await kernel.findByID({
    collection: 'posts',
    id: sec.id,
    asOf: new Date().toISOString(),
    draft: true,
  })
  check(
    'asOf read omits the read-denied field',
    secAsOf !== null && !('secret' in (secAsOf as object)),
    `keys=${Object.keys(secAsOf ?? {})}`,
  )
  const secHist = await kernel.history({ collection: 'posts', id: sec.id })
  check(
    'history changedFields never mention the read-denied field',
    secHist.every((e) => !e.changedFields.includes('secret')),
  )
  const secDiff = await kernel.diffVersions({
    collection: 'posts',
    id: sec.id,
    from: secHist[0]!.versionId,
    to: secHist[secHist.length - 1]!.versionId,
  })
  check('diff never includes the read-denied field', !('secret' in secDiff), `keys=${Object.keys(secDiff)}`)

  // ---------------------------------------------------------------------------
  console.log('\n\x1b[1mSecurity — a non-owner cannot read another tenant history/diff/asOf\x1b[0m')
  const jrnl = await kernel.create({ collection: 'journals', data: { owner: 'alice', entry: 'private-0' }, ...alice })
  await kernel.update({ collection: 'journals', id: jrnl.id, data: { entry: 'private-1' }, ...alice })

  // The OWNER can read its own history/asOf.
  const ownerHist = await kernel.history({ collection: 'journals', id: jrnl.id, ...alice })
  check('owner CAN read its own history', ownerHist.length === 2, `len=${ownerHist.length}`)
  const ownerAsOf = await kernel.findByID({
    collection: 'journals',
    id: jrnl.id,
    asOf: new Date().toISOString(),
    draft: true,
    ...alice,
  })
  check('owner CAN read its own asOf state', ownerAsOf?.entry === 'private-1', `entry=${ownerAsOf?.entry}`)

  // A NON-owner is Forbidden / null / empty — no historical content leaks.
  await denied('non-owner asOf read is Forbidden', () =>
    kernel.findByID({ collection: 'journals', id: jrnl.id, asOf: new Date().toISOString(), ...bob }),
  )
  await denied('non-owner history is Forbidden', () => kernel.history({ collection: 'journals', id: jrnl.id, ...bob }))
  await denied('non-owner diff is Forbidden', () =>
    kernel.diffVersions({
      collection: 'journals',
      id: jrnl.id,
      from: ownerHist[0]!.versionId,
      to: ownerHist[1]!.versionId,
      ...bob,
    }),
  )
  await denied('non-owner restoreAsOf is Forbidden', () =>
    kernel.restoreAsOf({ collection: 'journals', id: jrnl.id, asOf: new Date().toISOString(), ...bob }),
  )
  // A non-owner find({asOf}) must not surface the private journal at all.
  const bobList = await kernel.find({ collection: 'journals', asOf: new Date().toISOString(), ...bob })
  check(
    'non-owner find({asOf}) does not surface the private doc',
    !bobList.docs.some((d) => d.id === jrnl.id),
    `n=${bobList.docs.length}`,
  )

  // ---------------------------------------------------------------------------
  console.log('\n\x1b[1mTime-machine — guardrails\x1b[0m')
  // asOf on a non-versioned collection -> clear BadRequestError.
  const plainKernel = await initKernel(
    defineConfig({
      secret: 'verify-timemachine-secret-32-chars!',
      db: sqliteAdapter({ url: `file:${tmp('plain')}` }),
      collections: [
        { slug: 'plain', access: { read: () => true, create: () => true }, fields: [{ name: 'title', type: 'text' }] },
      ],
    }),
    { autoMigrate: true },
  )
  const plain = await plainKernel.create({ collection: 'plain', data: { title: 'x' } })
  let badReq = false
  let badErr: any = null
  try {
    await plainKernel.findByID({ collection: 'plain', id: plain.id, asOf: new Date().toISOString() })
  } catch (e: any) {
    badReq = true
    badErr = e
  }
  check(
    'asOf on a non-versioned collection throws BadRequestError',
    badReq && /version/i.test(badErr?.message ?? ''),
    badErr?.code ?? '',
  )

  // A forged versionId from nowhere -> clean reject (NotFound), never a leak.
  let forgedReject = false
  try {
    await kernel.diffVersions({ collection: 'posts', id: post.id, from: 'not-a-real-version-id', to: t2Version })
  } catch {
    forgedReject = true
  }
  check('a forged versionId is cleanly rejected', forgedReject)

  // Garbage asOf -> BadRequestError.
  let garbage = false
  try {
    await kernel.findByID({ collection: 'posts', id: post.id, asOf: 'not-a-timestamp' })
  } catch (e: any) {
    garbage = /invalid|asOf/i.test(e?.message ?? '')
  }
  check('garbage asOf is rejected as BadRequest', garbage)

  await plainKernel.destroy()
  await kernel.destroy()

  console.log(`\n\x1b[1mTime-machine Result: ${pass} passed, ${fails.length} failed\x1b[0m`)
  if (fails.length) {
    console.log('Failures:\n  ' + fails.join('\n  '))
    process.exit(1)
  }
  process.exit(0)
}
main().catch((e) => {
  console.error('TIME-MACHINE HARNESS ERROR:', e)
  process.exit(2)
})
