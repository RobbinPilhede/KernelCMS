/* Live content-decisions verification: `kernel.decide({ slug, viewerKey?, req?, overrideAccess? })`
 * is a STATELESS delivery op. It looks up a configured decision by slug, fetches a bounded pool of
 * PUBLISHED, access-checked candidates via the normal `find` path (so drafts / private rows /
 * field-restricted content can NEVER leak), narrows by the caller's resolved audience segment when
 * `audienceField` is set (fallback 'default' | 'any' | 'none'), and picks ONE document STICKILY
 * (`idx = fnv1a32(`${slug}:${viewerKey}`) % pool.length`). Proves: an audience match narrows the
 * pool with reason 'audience-match'; a no-match audience falls back per config; a DRAFT candidate is
 * never chosen even when it would win on sort + audience; the same viewerKey is sticky; an unknown
 * slug is null; and a non-public collection yields no decision (access enforced).
 * Run: pnpm tsx verify/decisions.ts */
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
      /forbidden|not.?found|unauthorized|validation|bad.?request|invalid|not allowed/i.test(
        `${e?.code}${e?.name}${e?.message}`,
      ),
      `threw ${e?.code ?? e?.name}`,
    )
  }
}

// An admin seeds and publishes content; an anonymous (req-less) caller decides over public reads.
const admin = { user: { id: 'adm', roles: ['admin'] } } as any

// A deterministic promo factory. `segment` is a hasMany select → its value is ALWAYS an array.
const promo = (segment: string | string[], priority: number) => {
  const segments = Array.isArray(segment) ? segment : [segment]
  return { title: `promo-${segments.join('+')}-${priority}`, segment: segments, priority }
}

async function main() {
  const dbDir = mkdtempSync(join(tmpdir(), 'kverify-decisions-'))
  const dbFile = join(dbDir, 'd.db')
  const config = defineConfig({
    secret: 'verify-secret-32-characters-long!!',
    db: sqliteAdapter({ url: `file:${dbFile}` }),
    audiences: { segments: ['default', 'vip', 'beta'], default: 'default' },
    decisions: [
      { slug: 'hero', collection: 'promos', sort: '-priority', audienceField: 'segment', fallback: 'default' },
    ],
    collections: [
      {
        slug: 'promos',
        versions: { drafts: true },
        access: { read: () => true, create: () => true, update: () => true },
        fields: [
          { name: 'title', type: 'text' },
          { name: 'priority', type: 'number' },
          { name: 'segment', type: 'select', hasMany: true, options: ['default', 'vip', 'beta'] },
        ],
      },
    ],
  })
  const kernel = await initKernel(config, { autoMigrate: true } as any)

  // A SECOND kernel whose `promos` collection is read-closed — a decision must never surface a row.
  const privDir = mkdtempSync(join(tmpdir(), 'kverify-decisions-priv-'))
  const privKernel = await initKernel(
    defineConfig({
      secret: 'verify-secret-32-characters-long!!',
      db: sqliteAdapter({ url: `file:${join(privDir, 'p.db')}` }),
      decisions: [{ slug: 'hero', collection: 'promos' }],
      collections: [
        {
          slug: 'promos',
          access: { read: () => false, create: () => true, update: () => true },
          fields: [{ name: 'title', type: 'text' }],
        },
      ],
    }),
    { autoMigrate: true } as any,
  )

  try {
    console.log('\n\x1b[1mDecide — published-only (a draft candidate never wins)\x1b[0m')
    // A DRAFT vip promo with the HIGHEST priority — would win on sort + audience, but is unpublished.
    await kernel.create({ collection: 'promos', data: promo('vip', 999), req: admin })
    // A PUBLISHED vip promo (lower priority) and a PUBLISHED default promo.
    const liveVip = await kernel.create({ collection: 'promos', data: promo('vip', 1), req: admin })
    await kernel.publish({ collection: 'promos', id: liveVip.id, req: admin })
    const liveDefault = await kernel.create({ collection: 'promos', data: promo('default', 1), req: admin })
    await kernel.publish({ collection: 'promos', id: liveDefault.id, req: admin })

    const vipPick = await kernel.decide({ slug: 'hero', viewerKey: 'v1', req: { audience: 'vip' } as any })
    check('a vip caller gets a decision', vipPick !== null, '')
    check(
      'the DRAFT high-priority vip promo is NOT in the pool (published-only)',
      Boolean(vipPick) && !vipPick!.candidateIds.includes('') && vipPick!.candidateIds.length === 1,
      `candidates=${vipPick?.candidateIds.length}`,
    )
    check(
      'the chosen vip promo is the PUBLISHED one',
      Boolean(vipPick) && vipPick!.chosenId === String(liveVip.id),
      `chosen=${vipPick?.chosenId}`,
    )

    console.log('\n\x1b[1mDecide — audience match narrows the pool\x1b[0m')
    check(
      "a targeted segment yields reason 'audience-match'",
      Boolean(vipPick) && vipPick!.reason === 'audience-match' && vipPick!.audience === 'vip',
      `reason=${vipPick?.reason}`,
    )
    check(
      'the default-segment promo is excluded from a vip pool',
      Boolean(vipPick) && !vipPick!.candidateIds.includes(String(liveDefault.id)),
      '',
    )

    console.log('\n\x1b[1mDecide — fallback when no candidate targets the segment\x1b[0m')
    // 'beta' has no published target → fallback:'default' falls to the default-segment promo.
    const betaPick = await kernel.decide({ slug: 'hero', viewerKey: 'v1', req: { audience: 'beta' } as any })
    check(
      "an unmatched segment falls back with reason 'audience-fallback'",
      Boolean(betaPick) && betaPick!.reason === 'audience-fallback',
      `reason=${betaPick?.reason}`,
    )
    check(
      'the fallback pool is the default-segment promo',
      Boolean(betaPick) && betaPick!.chosenId === String(liveDefault.id),
      `chosen=${betaPick?.chosenId}`,
    )

    console.log('\n\x1b[1mDecide — stickiness (same viewerKey → same document)\x1b[0m')
    // Publish a few more default promos so the pool has several candidates to pick from.
    for (let i = 2; i <= 5; i++) {
      const p = await kernel.create({ collection: 'promos', data: promo('default', i), req: admin })
      await kernel.publish({ collection: 'promos', id: p.id, req: admin })
    }
    const s1 = await kernel.decide({ slug: 'hero', viewerKey: 'sticky', req: { audience: 'default' } as any })
    const s2 = await kernel.decide({ slug: 'hero', viewerKey: 'sticky', req: { audience: 'default' } as any })
    check(
      'the same viewerKey lands on the same document across calls',
      Boolean(s1) && Boolean(s2) && s1!.chosenId === s2!.chosenId,
      `chosen=${s1?.chosenId}`,
    )
    check(
      'the sticky pick is a member of the candidate pool',
      Boolean(s1) && s1!.candidateIds.includes(s1!.chosenId),
      '',
    )

    console.log('\n\x1b[1mDecide — unknown slug → null\x1b[0m')
    const unknown = await kernel.decide({ slug: 'no-such-slot', req: { audience: 'vip' } as any })
    check('an unconfigured slug returns null (no decision)', unknown === null, `result=${unknown}`)

    console.log('\n\x1b[1mDecide — access-checked (non-public collection surfaces nothing)\x1b[0m')
    await privKernel.create({
      collection: 'promos',
      data: { title: 'secret' },
      req: admin,
      overrideAccess: true,
    } as any)
    await denied('a read-closed collection refuses the decision (no leak)', () =>
      privKernel.decide({ slug: 'hero', req: undefined }),
    )
  } finally {
    await kernel.destroy()
    await privKernel.destroy()
    try {
      rmSync(dirname(dbFile), { recursive: true, force: true })
      rmSync(privDir, { recursive: true, force: true })
    } catch {
      // best-effort temp cleanup
    }
  }

  console.log(`\n\x1b[1mDecisions Result: ${pass} passed, ${fails.length} failed\x1b[0m`)
  if (fails.length) {
    console.log('Failures:\n  ' + fails.join('\n  '))
    process.exit(1)
  }
  process.exit(0)
}
main().catch((e) => {
  console.error('DECISIONS HARNESS ERROR:', e)
  process.exit(2)
})
