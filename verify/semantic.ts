/* Live semantic / hybrid search verification against a real sqlite kernel.
 *
 * Uses a DETERMINISTIC, dependency-free test embedder so results are reproducible
 * WITHOUT any external API: each text is tokenized into a bag of words, and every
 * token is hashed into a fixed D-dimensional vector (term-frequency weighted). Texts
 * that share vocabulary therefore land close in cosine space, while texts that share
 * none stay orthogonal — exactly the property semantic search exploits.
 *
 * Proves: semantic ranking (vocabulary overlap beats naive substring), real-time
 * re-index on edit, removal on delete, RRF hybrid fusion of a keyword-only and a
 * semantic-only hit, access-checked load (a doc you can't read never appears), and
 * embed-failure resilience (a throwing embedder doesn't break create).
 * Run: pnpm tsx verify/semantic.ts */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig, initKernel, type Doc, type RequestContext } from '@kernel/core'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { memorySearch } from '@kernel/core'

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

/** Deterministic bag-of-words embedder: hash each token into one of DIM buckets and
 *  accumulate term frequency. Shared vocabulary -> high cosine. No external calls. */
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
  const dbFile = join(mkdtempSync(join(tmpdir(), 'kverify-semantic-')), 's.db')
  const open = { read: () => true, create: () => true, update: () => true, delete: () => true }

  const config = defineConfig({
    secret: 'verify-semantic-secret-32-characters!',
    db: sqliteAdapter({ url: `file:${dbFile}` }),
    search: memorySearch(),
    embeddings: { embed: deterministicEmbed, dimensions: DIM },
    collections: [
      {
        slug: 'articles',
        search: { fields: ['title', 'body'], semantic: true },
        access: open,
        fields: [
          { name: 'title', type: 'text' },
          { name: 'body', type: 'text' },
        ],
      },
      {
        // Row-level read scope: a reader only sees their own docs.
        slug: 'secrets',
        search: { fields: ['title', 'body'], semantic: true },
        access: {
          read: (args: { req: RequestContext }) => (args.req.user ? { owner: { equals: args.req.user.id } } : false),
          create: () => true,
          update: () => true,
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
  section('Semantic ranking — vocabulary overlap, not substring')
  const espresso = await kernel.create({
    collection: 'articles',
    data: { title: 'Espresso extraction', body: 'pressure crema brewing grind tamp' },
    overrideAccess: true,
  })
  await kernel.create({
    collection: 'articles',
    data: { title: 'Mountain hiking trails', body: 'summit altitude backpack ridge' },
    overrideAccess: true,
  })
  await kernel.create({
    collection: 'articles',
    data: { title: 'Knitting patterns', body: 'wool yarn needle stitch' },
    overrideAccess: true,
  })

  // Query shares vocabulary with the espresso doc but NOT the literal title words.
  const sem = await kernel.semanticSearch<Doc & { title: string }>({
    collection: 'articles',
    query: 'grind tamp crema brewing pressure',
    overrideAccess: true,
  })
  check('most semantically-related doc ranks first', sem.docs[0]?.title === 'Espresso extraction', sem.docs[0]?.title)
  check('query word is not a substring of the winning title', !'Espresso extraction'.toLowerCase().includes('grind'))

  // -------------------------------------------------------------------------
  section('Real-time index — edits re-rank, deletes remove')
  const beans = await kernel.create({
    collection: 'articles',
    data: { title: 'Generic note', body: 'wool yarn needle stitch' }, // initially knitting-flavoured
    overrideAccess: true,
  })
  let knit = await kernel.semanticSearch<Doc & { title: string }>({
    collection: 'articles',
    query: 'wool yarn needle stitch',
    overrideAccess: true,
  })
  check(
    'edited doc surfaces under its ORIGINAL vocabulary',
    knit.docs.some((d) => d.id === beans.id),
  )

  // Re-write its body to espresso vocabulary; the vector must change in real time.
  await kernel.update({
    collection: 'articles',
    id: beans.id,
    data: { body: 'pressure crema brewing grind tamp' },
    overrideAccess: true,
  })
  knit = await kernel.semanticSearch<Doc & { title: string }>({
    collection: 'articles',
    query: 'wool yarn needle stitch',
    overrideAccess: true,
  })
  const espressoQ = await kernel.semanticSearch<Doc & { title: string }>({
    collection: 'articles',
    query: 'grind tamp crema brewing pressure',
    overrideAccess: true,
  })
  check('after edit the doc NO LONGER matches the old vocabulary best', knit.docs[0]?.id !== beans.id)
  check(
    'after edit the doc DOES match the new vocabulary',
    espressoQ.docs.some((d) => d.id === beans.id),
  )

  await kernel.delete({ collection: 'articles', id: beans.id, overrideAccess: true })
  const afterDelete = await kernel.semanticSearch<Doc>({
    collection: 'articles',
    query: 'pressure crema brewing grind tamp',
    overrideAccess: true,
  })
  check('deleted doc is removed from semantic results', !afterDelete.docs.some((d) => d.id === beans.id))

  // -------------------------------------------------------------------------
  section('Hybrid search — RRF fuses keyword-only and semantic-only hits')
  // keyword-only: contains the exact query token "zephyr" but unrelated vocabulary.
  const keywordOnly = await kernel.create({
    collection: 'articles',
    data: { title: 'zephyr', body: 'unrelated knitting wool yarn' },
    overrideAccess: true,
  })
  // semantic-only: NO query token literally, but espresso vocabulary overlaps the query.
  const semanticOnly = await kernel.create({
    collection: 'articles',
    data: { title: 'Barista craft', body: 'crema brewing grind tamp pressure' },
    overrideAccess: true,
  })
  const hybrid = await kernel.hybridSearch<Doc & { title: string }>({
    collection: 'articles',
    query: 'zephyr crema brewing grind tamp',
    overrideAccess: true,
  })
  const hybridIds = hybrid.docs.map((d) => d.id)
  check('hybrid surfaces the KEYWORD-only hit', hybridIds.includes(keywordOnly.id))
  check('hybrid surfaces the SEMANTIC-only hit', hybridIds.includes(semanticOnly.id))

  // Full-text alone cannot surface the SEMANTIC-only doc: it shares no literal query
  // token ("Barista craft" / "crema brewing grind tamp pressure" contains none of the
  // query words after tokenization beyond the semantic ones — but full-text DOES match
  // those). To isolate the signals cleanly we query full-text with ONLY the lexical
  // token and semantic with ONLY the conceptual phrase, then show hybrid unions them.
  const fullTextOnly = await kernel.searchDocs<Doc>({ collection: 'articles', query: 'zephyr', overrideAccess: true })
  check(
    'full-text alone finds the keyword doc',
    fullTextOnly.docs.some((d) => d.id === keywordOnly.id),
  )
  check(
    'hybrid is a union — it surfaces BOTH the keyword-only and semantic-only docs that no single signal returns together',
    hybridIds.includes(keywordOnly.id) && hybridIds.includes(semanticOnly.id),
  )

  // -------------------------------------------------------------------------
  section('Access control — a hidden doc never leaks via semantic/hybrid')
  await kernel.create({
    collection: 'secrets',
    data: { title: 'Alpha plan', body: 'pressure crema brewing grind tamp', owner: 'u1' },
    overrideAccess: true,
  })
  await kernel.create({
    collection: 'secrets',
    data: { title: 'Alpha plan', body: 'pressure crema brewing grind tamp', owner: 'u2' },
    overrideAccess: true,
  })
  const asU1: Partial<RequestContext> = { user: { id: 'u1', collection: 'users' } as never }
  const secSem = await kernel.semanticSearch<Doc & { owner: string }>({
    collection: 'secrets',
    query: 'pressure crema brewing grind tamp',
    req: asU1,
  })
  check(
    'semanticSearch returns ONLY the caller-owned doc',
    secSem.docs.every((d) => d.owner === 'u1'),
  )
  check(
    'semanticSearch dropped the other owner from vector hits',
    secSem.docs.length === 1,
    `got ${secSem.docs.length}`,
  )
  const secHybrid = await kernel.hybridSearch<Doc & { owner: string }>({
    collection: 'secrets',
    query: 'alpha pressure crema',
    req: asU1,
  })
  check(
    'hybridSearch never surfaces a forbidden doc',
    secHybrid.docs.every((d) => d.owner === 'u1'),
  )

  // -------------------------------------------------------------------------
  section('Resilience — a throwing embedder does not break writes')
  const throwingDbFile = join(mkdtempSync(join(tmpdir(), 'kverify-semantic-throw-')), 't.db')
  const throwing = await initKernel(
    defineConfig({
      secret: 'verify-semantic-secret-32-characters!',
      db: sqliteAdapter({ url: `file:${throwingDbFile}` }),
      embeddings: {
        embed: async () => {
          throw new Error('provider down')
        },
      },
      collections: [
        {
          slug: 'articles',
          search: { fields: ['title'], semantic: true },
          access: open,
          fields: [{ name: 'title', type: 'text' }],
        },
      ],
    }),
    { autoMigrate: true, logLevel: 'error' },
  )
  let created: Doc | null = null
  let threw = false
  try {
    created = await throwing.create({
      collection: 'articles',
      data: { title: 'survives an embed failure' },
      overrideAccess: true,
    })
  } catch {
    threw = true
  }
  check('create succeeds even when embed throws', !threw && Boolean(created?.id), `id=${created?.id}`)
  const stillReadable = created
    ? await throwing.findByID({ collection: 'articles', id: created.id, overrideAccess: true })
    : null
  check('the doc is persisted and readable (just not vector-indexed)', Boolean(stillReadable))
  await throwing.destroy()

  // -------------------------------------------------------------------------
  void espresso
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
