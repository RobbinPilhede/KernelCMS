/* Live content-releases verification: a real sqlite kernel with `releases:true`, a
 * drafts-enabled `posts` collection (`access.publish: isEditor`), a blocking eval, audit,
 * and an agent. Proves the bundle publish, the all-or-nothing pre-flight, the per-doc
 * publish gate + agent brake, scheduling + drain, and open-only editability.
 * Run: pnpm tsx verify/releases.ts */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig, initKernel } from '@kernel/core'
import type { EvalRule } from '@kernel/core'
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

const isEditor = ({ req }: any) => Boolean(req.user?.roles?.includes('editor'))
const editor = { req: { user: { id: 'ed', roles: ['editor'] } } } as any
const viewer = { req: { user: { id: 'vw', roles: ['viewer'] } } } as any
const agent = { req: { user: { id: 'bot', principalType: 'agent' as const, roles: [] } } } as any

const noBanned: EvalRule = {
  name: 'no-banned',
  run: ({ doc }) =>
    typeof doc.title === 'string' && doc.title.toLowerCase().includes('banned')
      ? [{ ok: false, severity: 'error', message: 'banned content' }]
      : [{ ok: true, severity: 'info', message: 'clean' }],
}

async function main() {
  const dbFile = join(mkdtempSync(join(tmpdir(), 'kverify-releases-')), 'r.db')
  const config = defineConfig({
    secret: 'verify-secret-32-characters-long!!',
    db: sqliteAdapter({ url: `file:${dbFile}` }),
    audit: true,
    releases: true,
    evals: [noBanned],
    agents: [{ id: 'bot', token: 'bot-token-releases-verify', roles: [] }],
    collections: [
      {
        slug: 'posts',
        versions: { drafts: true },
        access: { read: () => true, create: () => true, update: () => true, publish: isEditor },
        fields: [{ name: 'title', type: 'text' }],
      },
    ],
  })
  const kernel = await initKernel(config, { autoMigrate: true } as any)
  const k = kernel as any
  const draft = async (title: string) => (await kernel.create({ collection: 'posts', data: { title }, ...editor })).id
  const status = async (id: string) => (await kernel.findByID({ collection: 'posts', id, draft: true }))?._status

  console.log('\n\x1b[1mReleases — create, add, preview in draft state\x1b[0m')
  const r1 = await k.createRelease({ name: 'Launch', ...editor })
  check('createRelease yields an open release', r1.status === 'open', `status=${r1.status}`)
  const ids = [await draft('Alpha'), await draft('Beta'), await draft('Gamma')]
  for (const id of ids) await k.addToRelease({ release: r1.id, collection: 'posts', id, ...editor })
  const preview = await k.previewRelease({ release: r1.id, ...editor })
  check('previewRelease returns all three members', preview.items.length === 3, `n=${preview.items.length}`)
  check(
    'preview shows them in DRAFT state',
    preview.items.every((i: any) => i.doc._status === 'draft'),
    '',
  )

  console.log('\n\x1b[1mReleases — editor publishes the bundle as a unit\x1b[0m')
  const pub = await k.publishRelease({ release: r1.id, ...editor })
  check('publishRelease status=published', pub.status === 'published', `status=${pub.status}`)
  check('all three members published together', pub.published.length === 3, `n=${pub.published.length}`)
  const live = await Promise.all(ids.map((id) => kernel.findByID({ collection: 'posts', id })))
  check(
    'each member is _status:published and queryable',
    live.every((d) => d?._status === 'published'),
    '',
  )
  const got = await k.getRelease({ release: r1.id, ...editor })
  check(
    'release published + publishedAt set',
    got.status === 'published' && Boolean(got.publishedAt),
    `at=${got.publishedAt}`,
  )
  const audit = await k.findAuditLog({ where: { action: { equals: 'release.publish' } } })
  check(
    'release publish is audited',
    (audit?.docs ?? []).some((d: any) => d.documentId === r1.id),
    '',
  )

  console.log('\n\x1b[1mReleases — all-or-nothing pre-flight (blocking eval)\x1b[0m')
  const r2 = await k.createRelease({ name: 'Mixed', ...editor })
  const good = await draft('Good post')
  const bad = await draft('banned post')
  await k.addToRelease({ release: r2.id, collection: 'posts', id: good, ...editor })
  await k.addToRelease({ release: r2.id, collection: 'posts', id: bad, ...editor })
  const mixed = await k.publishRelease({ release: r2.id, ...editor })
  check(
    'mixed release publishes NONE',
    mixed.status === 'open' && mixed.published.length === 0,
    `status=${mixed.status}`,
  )
  check(
    'the banned member is reported failed',
    mixed.failed.some((f: any) => f.id === bad),
    '',
  )
  check(
    'the GOOD member is still a draft (no half go-live)',
    (await status(good)) === 'draft',
    `s=${await status(good)}`,
  )
  check('release stays open', (await k.getRelease({ release: r2.id, ...editor })).status === 'open', '')

  console.log('\n\x1b[1mReleases — access: non-editor + agent cannot publish\x1b[0m')
  const r3 = await k.createRelease({ name: 'Access', ...editor })
  const a3 = await draft('A')
  await k.addToRelease({ release: r3.id, collection: 'posts', id: a3, ...editor })
  const byViewer = await k.publishRelease({ release: r3.id, ...viewer })
  check('viewer (no publish) publishes NONE', byViewer.status === 'open' && byViewer.published.length === 0, '')
  check('member still draft after viewer attempt', (await status(a3)) === 'draft', '')
  const byAgent = await k.publishRelease({ release: r3.id, ...agent })
  check('agent CANNOT publish (per-doc brake)', byAgent.status === 'open' && byAgent.published.length === 0, '')
  check('member still draft after agent attempt', (await status(a3)) === 'draft', '')

  console.log('\n\x1b[1mReleases — schedule + drain\x1b[0m')
  const r4 = await k.createRelease({ name: 'Scheduled', ...editor })
  const sIds = [await draft('S1'), await draft('S2')]
  for (const id of sIds) await k.addToRelease({ release: r4.id, collection: 'posts', id, ...editor })
  const at = new Date(Date.now() + 60_000).toISOString()
  const sched = await k.scheduleRelease({ release: r4.id, at, ...editor })
  check('scheduleRelease status=scheduled', sched.status === 'scheduled', `status=${sched.status}`)
  await k.processScheduledReleases({ now: Date.now() })
  check('before due: members still drafts', (await status(sIds[0]!)) === 'draft', '')
  const drain = await k.processScheduledReleases({ now: Date.now() + 120_000 })
  check('drain publishes the due release', drain.published.includes(r4.id), `pub=${drain.published.join(',')}`)
  const sLive = await Promise.all(sIds.map((id) => kernel.findByID({ collection: 'posts', id })))
  check(
    'scheduled members went live',
    sLive.every((d) => d?._status === 'published'),
    '',
  )

  console.log('\n\x1b[1mReleases — only open releases are editable\x1b[0m')
  let threw = false
  try {
    await k.addToRelease({ release: r1.id, collection: 'posts', id: await draft('late'), ...editor })
  } catch {
    threw = true
  }
  check('cannot add to a published release', threw, '')

  console.log(`\n\x1b[1mReleases Result: ${pass} passed, ${fails.length} failed\x1b[0m`)
  if (fails.length) {
    console.log('Failures:\n  ' + fails.join('\n  '))
    process.exit(1)
  }
  process.exit(0)
}
main().catch((e) => {
  console.error('RELEASES HARNESS ERROR:', e)
  process.exit(2)
})
