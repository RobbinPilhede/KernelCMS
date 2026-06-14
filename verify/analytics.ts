/* Live content-analytics & insights verification against a real sqlite kernel.
 *
 * Boots a kernel with `analytics: { enabled: true, autoCapture: true }`, a `posts`
 * collection with semantic search and an A/B experiment, and a DETERMINISTIC embedder
 * (like verify/semantic.ts) so retrieval is reproducible without any external API.
 *
 * Proves: explicit capture + top_content / top_queries ranking; AUTO-CAPTURE of
 * ai_retrieval from semanticSearch (the AI-retrieval leaderboard) and variant_impression
 * from assignVariant (variant_performance + a conversion rate); NO PII at rest (a meta
 * carrying userId/email/ip/__proto__ is stripped, and Object.prototype stays clean);
 * `track` can ONLY write `_analytics` (a collection value can't redirect the write);
 * retention trims; and resilience (a forced analytics-write failure never breaks a view
 * or a content op).
 * Run: pnpm tsx verify/analytics.ts */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig, initKernel, type Doc } from '@kernel/core'
import { ANALYTICS_TABLE } from '@kernel/core'
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
const section = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`)

const DIM = 64
/** Deterministic bag-of-words embedder (shared vocabulary -> high cosine; no API). */
function deterministicEmbed(texts: string[]): Promise<number[][]> {
  return Promise.resolve(
    texts.map((text) => {
      const vec = new Array<number>(DIM).fill(0)
      for (const tok of text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean)) {
        let h = 2166136261
        for (let i = 0; i < tok.length; i++) {
          h ^= tok.charCodeAt(i)
          h = Math.imul(h, 16777619)
        }
        vec[Math.abs(h) % DIM] += 1
      }
      return vec
    }),
  )
}

const open = { read: () => true, create: () => true, update: () => true, delete: () => true }

async function main() {
  const dbFile = join(mkdtempSync(join(tmpdir(), 'kverify-analytics-')), 'a.db')
  const kernel = await initKernel(
    defineConfig({
      secret: 'verify-analytics-secret-32-characters!',
      db: sqliteAdapter({ url: `file:${dbFile}` }),
      embeddings: { embed: deterministicEmbed, dimensions: DIM },
      analytics: { enabled: true, autoCapture: true, retain: 100_000 },
      audiences: { segments: ['control', 'variant_b'], default: 'control' },
      experiments: [{ slug: 'cta_test', variants: ['control', 'variant_b'] }],
      collections: [
        {
          slug: 'posts',
          search: { fields: ['title', 'body'], semantic: true },
          access: open,
          fields: [
            { name: 'title', type: 'text' },
            { name: 'body', type: 'text' },
          ],
        },
      ],
    }),
    { autoMigrate: true, logLevel: 'error' },
  )

  // -------------------------------------------------------------------------
  section('Explicit capture — top_content ranks the most-viewed doc')
  for (let i = 0; i < 3; i++) await kernel.track({ type: 'view', collection: 'posts', documentId: 'pricing' })
  await kernel.track({ type: 'view', collection: 'posts', documentId: 'about' })
  const topContent = await kernel.insights({ metric: 'top_content', type: 'view', overrideAccess: true })
  check(
    'most-viewed doc ranks first with the correct count',
    (topContent.rows[0] as any)?.documentId === 'pricing' && (topContent.rows[0] as any)?.count === 3,
    JSON.stringify(topContent.rows[0]),
  )

  // -------------------------------------------------------------------------
  section('Search capture — top_queries counts the search TERMS')
  await kernel.track({ type: 'search', query: 'pricing' })
  await kernel.track({ type: 'search', query: 'pricing' })
  await kernel.track({ type: 'search', query: 'security' })
  const topQueries = await kernel.insights({ metric: 'top_queries', overrideAccess: true })
  const pricing = topQueries.rows.find((r: any) => r.query === 'pricing') as any
  check('top query "pricing" returned with its count', pricing?.count === 2, JSON.stringify(pricing))

  // -------------------------------------------------------------------------
  section('Auto-capture — semanticSearch emits ai_retrieval per returned doc')
  await kernel.create({
    collection: 'posts',
    data: { title: 'Espresso extraction', body: 'pressure crema brewing grind tamp' },
    overrideAccess: true,
  })
  await kernel.create({
    collection: 'posts',
    data: { title: 'Knitting patterns', body: 'wool yarn needle stitch' },
    overrideAccess: true,
  })
  const sem = await kernel.semanticSearch<Doc & { title: string }>({
    collection: 'posts',
    query: 'grind tamp crema brewing pressure',
    overrideAccess: true,
  })
  check(
    'semanticSearch returned the espresso doc',
    sem.docs.some((d) => d.title === 'Espresso extraction'),
  )
  // Auto-capture fires best-effort (not awaited inside search) — let the microtasks drain.
  await new Promise((r) => setTimeout(r, 50))
  const leaderboard = await kernel.insights({ metric: 'ai_retrieval_leaderboard', overrideAccess: true })
  const retrievedIds = leaderboard.rows.map((r: any) => r.documentId)
  check(
    'ai_retrieval_leaderboard shows the auto-captured retrieved doc(s)',
    sem.docs.length > 0 && sem.docs.every((d) => retrievedIds.includes(d.id)),
    `leaderboard=${retrievedIds.length}`,
  )

  // -------------------------------------------------------------------------
  section('Auto-capture — assignVariant emits a variant_impression')
  const assigned = kernel.assignVariant({ experiment: 'cta_test', key: 'visitor-abc' })
  check('assignVariant returned a variant', Boolean(assigned.variant), assigned.variant)
  // Record a conversion for that variant so the rate is computable.
  await kernel.track({ type: 'conversion', experiment: 'cta_test', variant: assigned.variant })
  await new Promise((r) => setTimeout(r, 50))
  const variantPerf = await kernel.insights({ metric: 'variant_performance', overrideAccess: true })
  const perfRow = variantPerf.rows.find((r: any) => r.variant === assigned.variant) as any
  check('variant_performance shows the impression', perfRow?.impressions >= 1, `impressions=${perfRow?.impressions}`)
  check(
    'variant_performance computes a conversion rate from impressions + conversions',
    perfRow?.conversions >= 1 && typeof perfRow?.rate === 'number',
    `conversions=${perfRow?.conversions} rate=${perfRow?.rate}`,
  )

  // -------------------------------------------------------------------------
  section('NO PII — a meta with userId/email/ip/__proto__ is stripped at rest')
  await kernel.track({
    type: 'view',
    collection: 'posts',
    documentId: 'privacy',
    meta: JSON.parse(
      '{"userId":"u-secret","email":"a@b.com","ip":"1.2.3.4","sessionToken":"t","__proto__":{"polluted":true},"source":"rag","position":2}',
    ),
  })
  const raw = await kernel.db.find({
    collection: ANALYTICS_TABLE,
    where: { documentId: { equals: 'privacy' } },
    limit: 1,
    page: 1,
  })
  const row = raw.docs[0] as any
  const meta = row?.meta ?? {}
  check(
    'PII-ish meta keys are stripped (only non-PII dimensions stored)',
    JSON.stringify(meta) === JSON.stringify({ source: 'rag', position: 2 }),
    JSON.stringify(meta),
  )
  check(
    'no principal/PII column exists on the stored row',
    !('principalId' in (row ?? {})) && !('userId' in (row ?? {})),
  )
  check(
    'Object.prototype is not polluted',
    ({} as any).polluted === undefined && !Object.prototype.hasOwnProperty('polluted'),
  )

  // -------------------------------------------------------------------------
  section('Isolation — track can ONLY write _analytics, never a content collection')
  const postsBefore = await kernel.count({ collection: 'posts', overrideAccess: true })
  await kernel.track({ type: 'view', collection: 'posts', documentId: 'no-write' })
  const postsAfter = await kernel.count({ collection: 'posts', overrideAccess: true })
  check(
    'a track({collection:"posts"}) did NOT create a posts row',
    postsAfter === postsBefore,
    `before=${postsBefore} after=${postsAfter}`,
  )

  // -------------------------------------------------------------------------
  section('Retention — a small `retain` trims the oldest events')
  const trimFile = join(mkdtempSync(join(tmpdir(), 'kverify-analytics-trim-')), 't.db')
  const trimKernel = await initKernel(
    defineConfig({
      secret: 'verify-analytics-secret-32-characters!',
      db: sqliteAdapter({ url: `file:${trimFile}` }),
      analytics: { enabled: true, retain: 3 },
      collections: [{ slug: 'posts', access: open, fields: [{ name: 'title', type: 'text' }] }],
    }),
    { autoMigrate: true, logLevel: 'error' },
  )
  for (let i = 0; i < 7; i++) await trimKernel.track({ type: 'view', collection: 'posts', documentId: `d${i}` })
  const trimmed = await trimKernel.db.count({ collection: ANALYTICS_TABLE })
  check('retention trims to the configured cap', trimmed === 3, `rows=${trimmed}`)
  const survivors = await trimKernel.insights({ metric: 'top_content', overrideAccess: true })
  const ids = survivors.rows.map((r: any) => r.documentId).sort()
  check(
    'the survivors are the NEWEST events',
    JSON.stringify(ids) === JSON.stringify(['d4', 'd5', 'd6']),
    ids.join(','),
  )
  await trimKernel.destroy()

  // -------------------------------------------------------------------------
  section('Resilience — a forced analytics-write failure never breaks a content op')
  const brokenFile = join(mkdtempSync(join(tmpdir(), 'kverify-analytics-broken-')), 'b.db')
  const broken = await initKernel(
    defineConfig({
      secret: 'verify-analytics-secret-32-characters!',
      db: sqliteAdapter({ url: `file:${brokenFile}` }),
      analytics: { enabled: true },
      collections: [{ slug: 'posts', access: open, fields: [{ name: 'title', type: 'text' }] }],
    }),
    { autoMigrate: true, logLevel: 'error' },
  )
  // Force the underlying analytics write to throw by monkey-patching db.create for the
  // analytics table only. A track() must swallow it; a content create() must still work.
  const realCreate = broken.db.create.bind(broken.db)
  ;(broken.db as any).create = (args: any) => {
    if (args.collection === ANALYTICS_TABLE) throw new Error('forced analytics failure')
    return realCreate(args)
  }
  let trackThrew = false
  try {
    await broken.track({ type: 'view', collection: 'posts', documentId: 'x' })
  } catch {
    trackThrew = true
  }
  check('track swallows a write failure (never throws into the caller)', !trackThrew)
  let created: Doc | null = null
  let createThrew = false
  try {
    created = await broken.create({ collection: 'posts', data: { title: 'still works' }, overrideAccess: true })
  } catch {
    createThrew = true
  }
  check(
    'a content create still succeeds despite the broken analytics writer',
    !createThrew && Boolean(created?.id),
    `id=${created?.id}`,
  )
  await broken.destroy()

  await kernel.destroy()

  console.log(`\n${fails.length === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fails.length} failed\x1b[0m`)
  if (fails.length > 0) {
    console.log('Failures:\n  - ' + fails.join('\n  - '))
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('ANALYTICS HARNESS ERROR:', err)
  process.exit(1)
})
