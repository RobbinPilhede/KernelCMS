/* Live concurrency verification: optimistic-concurrency conflict detection, advisory
 * soft locks (steal-prevention + TTL), and lightweight presence (active-set + TTL).
 * Expiry is deterministic via an injected `now` (ms epoch). Run:
 *   pnpm tsx verify/concurrency.ts */
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

// Two human editors editing the same open collection (no access rules to get in the way).
const A = { req: { user: { id: 'editor-a', roles: ['editor'] } } }
const B = { req: { user: { id: 'editor-b', roles: ['editor'] } } }

async function main() {
  const dbFile = join(mkdtempSync(join(tmpdir(), 'kverify-concurrency-')), 'c.db')
  const config = defineConfig({
    secret: 'verify-secret-32-characters-long!!',
    db: sqliteAdapter({ url: `file:${dbFile}` }),
    collections: [
      {
        slug: 'docs',
        access: { read: () => true, create: () => true, update: () => true, delete: () => true },
        fields: [
          { name: 'title', type: 'text' },
          { name: 'body', type: 'text' },
        ],
      },
    ],
  })
  const kernel = await initKernel(config, { logLevel: 'error', autoMigrate: true } as any)

  // -----------------------------------------------------------------------
  console.log('\n\x1b[1mOptimistic concurrency — the hard guarantee\x1b[0m')
  const created = await kernel.create({ collection: 'docs', data: { title: 'v0', body: 'orig' }, ...A })
  const id = created.id
  const v0 = String(created.updatedAt)

  // Both editors loaded the SAME updatedAt (v0). A saves with the matching token → wins.
  const afterA = await kernel.update({
    collection: 'docs',
    id,
    data: { title: 'A wins' },
    expectedUpdatedAt: v0,
    ...A,
  })
  const v1 = String(afterA!.updatedAt)
  check('A updates with the current token → succeeds', afterA?.title === 'A wins', `title=${afterA?.title}`)
  check('updatedAt advances after A’s write', v1 !== v0, `v0=${v0} v1=${v1}`)

  // B still holds the stale v0 token → ConflictError, no write, payload exposes the truth.
  let conflict: any = null
  try {
    await kernel.update({ collection: 'docs', id, data: { title: 'B clobber' }, expectedUpdatedAt: v0, ...B })
  } catch (e: any) {
    conflict = e
  }
  check('B updates with the stale token → ConflictError', conflict?.code === 'CONFLICT', `code=${conflict?.code}`)
  const details = conflict?.details ?? {}
  check(
    'conflict payload exposes the CURRENT updatedAt',
    String(details.currentUpdatedAt) === v1,
    `current=${details.currentUpdatedAt}`,
  )
  check(
    'conflict payload carries the current doc (for diff/merge)',
    details.current?.title === 'A wins',
    `current.title=${details.current?.title}`,
  )
  check(
    'conflict payload lists the conflicting field(s)',
    Array.isArray(details.attemptedFields) && details.attemptedFields.includes('title'),
    `attemptedFields=${JSON.stringify(details.attemptedFields)}`,
  )
  const stillA = await kernel.findByID({ collection: 'docs', id, ...A })
  check(
    'no write happened on conflict (server still reads A’s value)',
    stillA?.title === 'A wins',
    `title=${stillA?.title}`,
  )

  // Backward-compatible: an update WITHOUT a token still wins (opt-in only).
  const noToken = await kernel.update({ collection: 'docs', id, data: { body: 'no-token' }, ...B })
  check('update WITHOUT a token still succeeds (opt-in, backward-compatible)', noToken?.body === 'no-token', '')

  // And the CURRENT token succeeds.
  const v2 = String(noToken!.updatedAt)
  const fresh = await kernel.update({ collection: 'docs', id, data: { title: 'B fresh' }, expectedUpdatedAt: v2, ...B })
  check('update with the CURRENT token → succeeds', fresh?.title === 'B fresh', `title=${fresh?.title}`)

  // -----------------------------------------------------------------------
  console.log('\n\x1b[1mAdvisory soft locks — steal-prevention + TTL\x1b[0m')
  const lockDoc = await kernel.create({ collection: 'docs', data: { title: 'locked doc' }, ...A })
  const lid = lockDoc.id
  const t0 = 1_000_000_000_000 // fixed epoch base for deterministic expiry
  const ttl = 120_000

  const pAcq = await kernel.acquireLock({ collection: 'docs', id: lid, ttlMs: ttl, now: t0, ...A })
  check('P acquires a free lock → heldBy "you"', pAcq.heldBy === 'you', `heldBy=${pAcq.heldBy}`)

  const qAcq = await kernel.acquireLock({ collection: 'docs', id: lid, ttlMs: ttl, now: t0 + 1000, ...B })
  check('Q acquiring an unexpired lock → heldBy "other"', qAcq.heldBy === 'other', `heldBy=${qAcq.heldBy}`)
  check(
    'the held lock reports P as the holder',
    qAcq.lock.principalId === 'editor-a',
    `holder=${qAcq.lock.principalId}`,
  )

  const pRefresh = await kernel.acquireLock({ collection: 'docs', id: lid, ttlMs: ttl, now: t0 + 5000, ...A })
  check(
    'P refreshes (re-acquire extends expiresAt)',
    new Date(pRefresh.lock.expiresAt).getTime() === t0 + 5000 + ttl,
    `expiresAt=${pRefresh.lock.expiresAt}`,
  )

  // Advisory: a writer who ignores the lock STILL writes (access unaffected).
  const ignored = await kernel.update({ collection: 'docs', id: lid, data: { title: 'B wrote anyway' }, ...B })
  check(
    'a writer ignoring the lock STILL writes (advisory, access unaffected)',
    ignored?.title === 'B wrote anyway',
    '',
  )

  // getLock / listLocks only show UNEXPIRED locks.
  const got = await kernel.getLock({ collection: 'docs', id: lid, now: t0 + 6000 })
  check('getLock returns the unexpired lock', got?.principalId === 'editor-a', `holder=${got?.principalId}`)
  const listed = await kernel.listLocks({ now: t0 + 6000 })
  check(
    'listLocks shows the unexpired lock',
    listed.some((l) => l.id === `docs:${lid}`),
    `count=${listed.length}`,
  )

  // Non-holder release is refused; holder release works.
  let releaseDenied: any = null
  try {
    await kernel.releaseLock({ collection: 'docs', id: lid, now: t0 + 6000, ...B })
  } catch (e: any) {
    releaseDenied = e
  }
  check('non-holder release is refused (Forbidden)', releaseDenied?.code === 'FORBIDDEN', `code=${releaseDenied?.code}`)
  const rel = await kernel.releaseLock({ collection: 'docs', id: lid, now: t0 + 6000, ...A })
  check('holder release works', rel.released === true, `released=${rel.released}`)

  // After the TTL elapses, Q can acquire. Re-take it as P first to test expiry.
  await kernel.acquireLock({ collection: 'docs', id: lid, ttlMs: ttl, now: t0 + 10_000, ...A })
  const qBlocked = await kernel.acquireLock({ collection: 'docs', id: lid, ttlMs: ttl, now: t0 + 20_000, ...B })
  check('Q still blocked before P’s lock expires', qBlocked.heldBy === 'other', `heldBy=${qBlocked.heldBy}`)
  const qAfterTtl = await kernel.acquireLock({
    collection: 'docs',
    id: lid,
    ttlMs: ttl,
    now: t0 + 10_000 + ttl + 1,
    ...B,
  })
  check('after TTL elapses, Q can acquire → heldBy "you"', qAfterTtl.heldBy === 'you', `heldBy=${qAfterTtl.heldBy}`)
  const noneExpired = await kernel.getLock({ collection: 'docs', id: lockDoc.id, now: t0 + 10_000 + ttl + 1 + ttl + 1 })
  check('getLock filters an expired lock (returns null)', noneExpired === null, `lock=${noneExpired}`)

  // -----------------------------------------------------------------------
  console.log('\n\x1b[1mPresence — active set + TTL\x1b[0m')
  const presDoc = await kernel.create({ collection: 'docs', data: { title: 'presence doc' }, ...A })
  const pid = presDoc.id
  const pttl = 30_000

  await kernel.heartbeat({ collection: 'docs', id: pid, kind: 'editing', now: t0, ...A })
  await kernel.heartbeat({ collection: 'docs', id: pid, kind: 'viewing', now: t0 + 1000, ...B })
  const both = await kernel.getPresence({ collection: 'docs', id: pid, ttlMs: pttl, now: t0 + 2000 })
  check('P and Q both appear in presence', both.length === 2, `count=${both.length}`)
  const pEntry = both.find((e) => e.principalId === 'editor-a')
  const qEntry = both.find((e) => e.principalId === 'editor-b')
  check(
    'kinds reported correctly (P editing, Q viewing)',
    pEntry?.kind === 'editing' && qEntry?.kind === 'viewing',
    `P=${pEntry?.kind} Q=${qEntry?.kind}`,
  )

  // Advance past the TTL for Q only; P re-heartbeats and stays. Only P remains.
  await kernel.heartbeat({ collection: 'docs', id: pid, kind: 'editing', now: t0 + 40_000, ...A })
  const onlyP = await kernel.getPresence({ collection: 'docs', id: pid, ttlMs: pttl, now: t0 + 45_000 })
  check(
    'after Q goes stale and P re-heartbeats, only P remains',
    onlyP.length === 1 && onlyP[0]?.principalId === 'editor-a',
    `count=${onlyP.length}`,
  )

  // -----------------------------------------------------------------------
  // Security regressions for the presence/lock + conflict access fixes. A second kernel
  // with REAL access rules: `secret` docs are owner-scoped on read (and carry a read-denied
  // `pin` field), so a non-owner must learn nothing — not the doc, not who's editing it.
  console.log('\n\x1b[1mAccess-scoped collaboration — no leaks across read scope\x1b[0m')
  const sFile = join(mkdtempSync(join(tmpdir(), 'kverify-concurrency-sec-')), 's.db')
  const sConfig = defineConfig({
    secret: 'verify-secret-32-characters-long!!',
    db: sqliteAdapter({ url: `file:${sFile}` }),
    collections: [
      {
        slug: 'secret',
        access: {
          // Read is owner-scoped: you can only read rows whose `owner` is your id.
          read: ({ req }) => (req?.user ? { owner: { equals: String(req.user.id) } } : false),
          create: () => true,
          update: ({ req }) => (req?.user ? { owner: { equals: String(req.user.id) } } : false),
          delete: () => true,
        },
        fields: [
          { name: 'owner', type: 'text' },
          { name: 'title', type: 'text' },
          // Read-denied field: never returned to a client, must not leak via conflict payload.
          { name: 'pin', type: 'text', access: { read: () => false } },
        ],
      },
    ],
  })
  const sKernel = await initKernel(sConfig, { logLevel: 'error', autoMigrate: true } as any)

  // A owns the doc (with a read-denied pin); B is a different principal with no read access.
  const owned = await sKernel.create({
    collection: 'secret',
    data: { owner: 'editor-a', title: 'secret v0', pin: '1234' },
    overrideAccess: true,
  })
  const sid = owned.id
  const sv0 = String(owned.updatedAt)

  // CRIT — conflict payload must NOT leak the read-denied `pin`. A bumps the doc, then A
  // retries with the stale token to force a conflict; the payload's `current` is read-stripped.
  await sKernel.update({ collection: 'secret', id: sid, data: { title: 'secret v1' }, ...A })
  let secretConflict: any = null
  try {
    await sKernel.update({
      collection: 'secret',
      id: sid,
      data: { title: 'secret v2', pin: '9999' },
      expectedUpdatedAt: sv0,
      ...A,
    })
  } catch (e: any) {
    secretConflict = e
  }
  check(
    'CRIT: conflict on a read-denied field → ConflictError',
    secretConflict?.code === 'CONFLICT',
    `code=${secretConflict?.code}`,
  )
  check(
    'CRIT: conflict payload does NOT leak the read-denied `pin` value',
    secretConflict?.details?.current && !('pin' in secretConflict.details.current),
    `current keys=${Object.keys(secretConflict?.details?.current ?? {}).join(',')}`,
  )
  check(
    'CRIT: attemptedFields computed against stripped `current` excludes read-denied `pin`',
    Array.isArray(secretConflict?.details?.attemptedFields) && !secretConflict.details.attemptedFields.includes('pin'),
    `attemptedFields=${JSON.stringify(secretConflict?.details?.attemptedFields)}`,
  )

  // HIGH — B cannot read the owner-scoped doc, so collaboration ops 404 (never data).
  const t = 1_000_000_000_000
  let getPresDenied: any = null
  try {
    await sKernel.getPresence({ collection: 'secret', id: sid, ttlMs: 30_000, now: t, ...B })
  } catch (e: any) {
    getPresDenied = e
  }
  check(
    'HIGH: non-reader getPresence → NotFound (not data)',
    getPresDenied?.code === 'NOT_FOUND',
    `code=${getPresDenied?.code}`,
  )

  let getLockDenied: any = null
  try {
    await sKernel.getLock({ collection: 'secret', id: sid, now: t, ...B })
  } catch (e: any) {
    getLockDenied = e
  }
  check(
    'HIGH: non-reader getLock → NotFound (not data)',
    getLockDenied?.code === 'NOT_FOUND',
    `code=${getLockDenied?.code}`,
  )

  let heartbeatDenied: any = null
  try {
    await sKernel.heartbeat({ collection: 'secret', id: sid, kind: 'editing', now: t, ...B })
  } catch (e: any) {
    heartbeatDenied = e
  }
  check(
    'HIGH: non-reader cannot heartbeat → NotFound',
    heartbeatDenied?.code === 'NOT_FOUND',
    `code=${heartbeatDenied?.code}`,
  )

  let acquireDenied: any = null
  try {
    await sKernel.acquireLock({ collection: 'secret', id: sid, ttlMs: 30_000, now: t, ...B })
  } catch (e: any) {
    acquireDenied = e
  }
  check(
    'HIGH: non-reader cannot acquireLock → NotFound',
    acquireDenied?.code === 'NOT_FOUND',
    `code=${acquireDenied?.code}`,
  )

  // HIGH (no regression) — the OWNER reads presence/locks normally.
  await sKernel.heartbeat({ collection: 'secret', id: sid, kind: 'editing', now: t, ...A })
  const ownerPres = await sKernel.getPresence({ collection: 'secret', id: sid, ttlMs: 30_000, now: t + 1000, ...A })
  check(
    'HIGH: the owner still sees presence on their own doc (no regression)',
    ownerPres.length === 1 && ownerPres[0]?.principalId === 'editor-a',
    `count=${ownerPres.length}`,
  )
  await sKernel.acquireLock({ collection: 'secret', id: sid, ttlMs: 30_000, now: t, ...A })
  const ownerLock = await sKernel.getLock({ collection: 'secret', id: sid, now: t + 1000, ...A })
  check(
    'HIGH: the owner still reads their own lock (no regression)',
    ownerLock?.principalId === 'editor-a',
    `holder=${ownerLock?.principalId}`,
  )
  // listLocks filters locks the caller can't read: B sees none, A sees theirs.
  const bLocks = await sKernel.listLocks({ now: t + 1000, ...B })
  check('HIGH: listLocks hides locks on docs the caller can’t read', bLocks.length === 0, `count=${bLocks.length}`)
  const aLocks = await sKernel.listLocks({ now: t + 1000, ...A })
  check(
    'HIGH: listLocks shows the owner their own lock',
    aLocks.some((l) => l.id === `secret:${sid}`),
    `count=${aLocks.length}`,
  )

  // MED — garbage ttlMs must clamp, never throw RangeError (which would be a 500).
  let nanThrew = false
  try {
    const r = await sKernel.acquireLock({ collection: 'secret', id: sid, ttlMs: NaN as number, now: t + 2000, ...A })
    check(
      'MED: acquireLock({ ttlMs: NaN }) clamps to a finite expiry',
      Number.isFinite(new Date(r.lock.expiresAt).getTime()),
      `expiresAt=${r.lock.expiresAt}`,
    )
  } catch {
    nanThrew = true
  }
  check('MED: acquireLock({ ttlMs: NaN }) does NOT throw RangeError', !nanThrew, '')
  let maxThrew = false
  try {
    const r = await sKernel.acquireLock({
      collection: 'secret',
      id: sid,
      ttlMs: Number.MAX_SAFE_INTEGER,
      now: t + 3000,
      ...A,
    })
    check(
      'MED: acquireLock({ ttlMs: MAX_SAFE_INTEGER }) clamps to a finite expiry',
      Number.isFinite(new Date(r.lock.expiresAt).getTime()),
      `expiresAt=${r.lock.expiresAt}`,
    )
  } catch {
    maxThrew = true
  }
  check('MED: acquireLock({ ttlMs: MAX_SAFE_INTEGER }) does NOT throw RangeError', !maxThrew, '')

  await sKernel.destroy()

  // -----------------------------------------------------------------------
  console.log(`\n\x1b[1mConcurrency Result: ${pass} passed, ${fails.length} failed\x1b[0m`)
  await kernel.destroy()
  if (fails.length) {
    console.log('Failures:\n  ' + fails.join('\n  '))
    process.exit(1)
  }
  process.exit(0)
}
main().catch((e) => {
  console.error('CONCURRENCY HARNESS ERROR:', e)
  process.exit(2)
})
