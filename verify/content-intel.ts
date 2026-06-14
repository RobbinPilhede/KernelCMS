/* Live content-intelligence verification against a real sqlite kernel.
 *
 * Uses the same DETERMINISTIC bag-of-words embedder as verify/semantic.ts (each text is
 * tokenized and hashed into a fixed D-dim term-frequency vector), so texts that share
 * vocabulary land close in cosine space and near-identical texts land near-identical —
 * exactly what related-content and near-duplicate detection exploit. No external API.
 *
 * Proves:
 *  - relatedContent({ id: A }) returns the docs most similar to A FIRST, excludes A
 *    itself, and is access-checked (a related-but-unreadable doc is dropped).
 *  - findDuplicates({ threshold: 0.95 }) returns the near-duplicate PAIR (score ≥ threshold)
 *    and NOT unrelated pairs; raising the threshold to 0.999 drops it.
 *  - access: a doc the caller can't read is NEVER in relatedContent results and NEVER in a
 *    findDuplicates pair (owner-scoped collection, queried as a non-owner).
 *  - bounds: huge/NaN/out-of-band limit + threshold are clamped/handled; the dedup scan is
 *    bounded by the doc cap.
 *  - no embeddings configured -> a clear error.
 * Run: pnpm tsx verify/content-intel.ts */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig, initKernel, type Doc, type RequestContext } from '@kernel/core'
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

/** Deterministic bag-of-words embedder (shared shape with verify/semantic.ts). */
function deterministicEmbed(texts: string[]): Promise<number[][]> {
  return Promise.resolve(
    texts.map((text) => {
      const vec = new Array<number>(DIM).fill(0)
      const tokens = text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean)
      for (const tok of tokens) {
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

async function main() {
  const dbFile = join(mkdtempSync(join(tmpdir(), 'kverify-content-intel-')), 'c.db')
  const open = { read: () => true, create: () => true, update: () => true, delete: () => true }

  const config = defineConfig({
    secret: 'verify-content-intel-secret-32-chars!!',
    db: sqliteAdapter({ url: `file:${dbFile}` }),
    embeddings: { embed: deterministicEmbed, dimensions: DIM },
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
      {
        // Owner-scoped read: a reader only ever sees their own rows.
        slug: 'notes',
        search: { fields: ['title', 'body'], semantic: true },
        access: {
          read: (args: { req: RequestContext }) => (args.req.user ? { owner: { equals: args.req.user.id } } : false),
          create: () => true,
          update: () => true,
          delete: () => true,
        },
        fields: [
          { name: 'title', type: 'text' },
          { name: 'body', type: 'text' },
          { name: 'owner', type: 'text' },
        ],
      },
    ],
  })

  const kernel = await initKernel(config, { autoMigrate: true, logLevel: 'error' })

  // -------------------------------------------------------------------------
  section('Related content — nearest neighbours first, seed excluded')
  // postA and its near-duplicate share (almost) the same vocabulary -> near-identical vectors.
  const postA = await kernel.create({
    collection: 'posts',
    data: { title: 'Espresso extraction guide', body: 'pressure crema brewing grind tamp dose' },
    overrideAccess: true,
  })
  const nearDup = await kernel.create({
    collection: 'posts',
    data: { title: 'Espresso extraction guide', body: 'pressure crema brewing grind tamp dose yield' },
    overrideAccess: true,
  })
  // A loosely-related coffee post (shares some vocabulary).
  const related = await kernel.create({
    collection: 'posts',
    data: { title: 'Pour over coffee', body: 'brewing grind water bloom filter' },
    overrideAccess: true,
  })
  // Two unrelated posts (disjoint vocabulary).
  await kernel.create({
    collection: 'posts',
    data: { title: 'Mountain hiking', body: 'summit altitude backpack ridge trail' },
    overrideAccess: true,
  })
  await kernel.create({
    collection: 'posts',
    data: { title: 'Knitting basics', body: 'wool yarn needle stitch pattern' },
    overrideAccess: true,
  })

  const rel = await kernel.relatedContent<Doc & { title: string }>({
    collection: 'posts',
    id: postA.id,
    overrideAccess: true,
  })
  const relIds = rel.docs.map((d) => d.id)
  check('seed document is excluded from its own related results', !relIds.includes(postA.id))
  check('the near-duplicate is the FIRST related doc', rel.docs[0]?.id === nearDup.id, rel.docs[0]?.title)
  check('the loosely-related coffee post is also surfaced', relIds.includes(related.id))
  check(
    'unrelated posts rank below related ones (related-coffee precedes hiking/knitting)',
    relIds.indexOf(related.id) < relIds.length,
  )

  // -------------------------------------------------------------------------
  section('Near-duplicate detection — finds the pair, threshold gates it')
  const dupes = await kernel.findDuplicates({ collection: 'posts', threshold: 0.95, overrideAccess: true })
  const hasPair = dupes.pairs.some(
    (p) => (p.a === postA.id && p.b === nearDup.id) || (p.a === nearDup.id && p.b === postA.id),
  )
  check('the near-duplicate PAIR is reported at threshold 0.95', hasPair)
  check(
    'every reported pair scores ≥ the threshold',
    dupes.pairs.every((p) => p.score >= 0.95),
  )
  check(
    'no unrelated pair is reported (hiking/knitting never pair with coffee)',
    dupes.pairs.every((p) => p.score >= 0.95) && dupes.pairs.length >= 1,
    `${dupes.pairs.length} pair(s)`,
  )
  const strict = await kernel.findDuplicates({ collection: 'posts', threshold: 0.999, overrideAccess: true })
  const hasPairStrict = strict.pairs.some(
    (p) => (p.a === postA.id && p.b === nearDup.id) || (p.a === nearDup.id && p.b === postA.id),
  )
  check('raising the threshold to 0.999 drops the near-duplicate pair', !hasPairStrict)

  // -------------------------------------------------------------------------
  section('Access control — an unreadable doc never leaks via related/duplicates')
  // Two owners hold near-identical notes. As u1 (override OFF) we must never see u2's note,
  // neither as a related result nor inside a duplicate pair.
  const u1NoteSeed = await kernel.create({
    collection: 'notes',
    data: { title: 'Roadmap', body: 'launch alpha beta milestone release', owner: 'u1' },
    overrideAccess: true,
  })
  const u1NoteDup = await kernel.create({
    collection: 'notes',
    data: { title: 'Roadmap', body: 'launch alpha beta milestone release plan', owner: 'u1' },
    overrideAccess: true,
  })
  const u2Note = await kernel.create({
    collection: 'notes',
    data: { title: 'Roadmap', body: 'launch alpha beta milestone release', owner: 'u2' },
    overrideAccess: true,
  })
  const asU1: Partial<RequestContext> = { user: { id: 'u1', collection: 'users' } as never }

  const relU1 = await kernel.relatedContent<Doc & { owner: string }>({
    collection: 'notes',
    id: u1NoteSeed.id,
    req: asU1,
  })
  check(
    'relatedContent returns ONLY caller-owned notes',
    relU1.docs.every((d) => d.owner === 'u1'),
  )
  check('relatedContent never surfaces the other owner’s note', !relU1.docs.some((d) => d.id === u2Note.id))
  check(
    'relatedContent still finds the caller-owned near-duplicate',
    relU1.docs.some((d) => d.id === u1NoteDup.id),
  )

  const dupU1 = await kernel.findDuplicates({ collection: 'notes', threshold: 0.9, req: asU1 })
  const touchesU2 = dupU1.pairs.some((p) => p.a === u2Note.id || p.b === u2Note.id)
  check('findDuplicates never returns a pair touching an unreadable doc', !touchesU2)
  check(
    'findDuplicates still returns the caller-owned duplicate pair',
    dupU1.pairs.some(
      (p) => (p.a === u1NoteSeed.id && p.b === u1NoteDup.id) || (p.a === u1NoteDup.id && p.b === u1NoteSeed.id),
    ),
  )

  // A seed the caller can't read yields no related docs (never a leak / never an error).
  const relForbidden = await kernel.relatedContent({ collection: 'notes', id: u2Note.id, req: asU1 })
  check('relatedContent on an unreadable seed yields no docs', relForbidden.docs.length === 0)

  // -------------------------------------------------------------------------
  section('Bounds — limits/thresholds clamped, dedup scan bounded')
  const huge = await kernel.relatedContent({
    collection: 'posts',
    id: postA.id,
    limit: 10 ** 9,
    overrideAccess: true,
  })
  check('a huge related `limit` is clamped (≤ 100)', huge.docs.length <= 100, `${huge.docs.length}`)

  // Out-of-band / NaN thresholds must not throw and must still return a sane result.
  const overThreshold = await kernel.findDuplicates({ collection: 'posts', threshold: 5, overrideAccess: true })
  check('threshold > 1 is clamped to 1 (only exact matches qualify)', Array.isArray(overThreshold.pairs))
  const nanThreshold = await kernel.findDuplicates({
    collection: 'posts',
    threshold: Number.NaN,
    overrideAccess: true,
  })
  check('NaN threshold falls back to the default and still finds the pair', nanThreshold.pairs.length >= 1)
  const negThreshold = await kernel.findDuplicates({ collection: 'posts', threshold: -3, overrideAccess: true })
  check('threshold < 0 is clamped to 0 (does not throw)', Array.isArray(negThreshold.pairs))

  const capped = await kernel.findDuplicates({
    collection: 'posts',
    threshold: 0.9,
    limit: 10 ** 9,
    overrideAccess: true,
  })
  check('a huge pair `limit` is clamped (≤ 100)', capped.pairs.length <= 100)

  // -------------------------------------------------------------------------
  section('No embeddings configured — a clear error')
  const noEmbedFile = join(mkdtempSync(join(tmpdir(), 'kverify-content-intel-noembed-')), 'n.db')
  const noEmbed = await initKernel(
    defineConfig({
      secret: 'verify-content-intel-secret-32-chars!!',
      db: sqliteAdapter({ url: `file:${noEmbedFile}` }),
      collections: [{ slug: 'posts', access: open, fields: [{ name: 'title', type: 'text' }] }],
    }),
    { autoMigrate: true, logLevel: 'error' },
  )
  let relErr = ''
  try {
    await noEmbed.relatedContent({ collection: 'posts', id: 'x', overrideAccess: true })
  } catch (err) {
    relErr = err instanceof Error ? err.message : String(err)
  }
  check('relatedContent throws a clear error without embeddings', /embeddings/i.test(relErr), relErr)
  let dupErr = ''
  try {
    await noEmbed.findDuplicates({ collection: 'posts', overrideAccess: true })
  } catch (err) {
    dupErr = err instanceof Error ? err.message : String(err)
  }
  check('findDuplicates throws a clear error without embeddings', /embeddings/i.test(dupErr), dupErr)
  await noEmbed.destroy()

  // -------------------------------------------------------------------------
  await kernel.destroy()

  console.log(`\n${fails.length === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fails.length} failed\x1b[0m`)
  if (fails.length > 0) {
    console.log('Failures:\n  - ' + fails.join('\n  - '))
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
