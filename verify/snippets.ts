/* Live content-snippets / reusable-blocks verification: a `snippet: true` collection is a
 * library of reusable fragments; a `snippet`-typed field on another collection references a
 * fragment and TRANSCLUDES its live content on read (edit the fragment once → every
 * referencing document reflects it). Proves: transclusion on read (depth:1 inlines the
 * fragment, depth:0 keeps the raw id); edit-once-update-everywhere (live, not a copy);
 * hasMany resolves an ordered list of fragments; the access-checked fallback (a fragment the
 * caller cannot read → raw id, never the content); cycle/depth safety (A→B→A read with a high
 * depth is bounded by MAX_POPULATE_DEPTH and does not hang); and the two config guards
 * (unknown target + non-snippet target → throw at initKernel).
 * Run: pnpm tsx verify/snippets.ts */
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
      /forbidden|not.?found|unauthorized|validation|bad.?request|invalid/i.test(`${e?.code}${e?.name}${e?.message}`),
      `threw ${e?.code ?? e?.name}`,
    )
  }
}
// A config guard fires at initKernel as a plain `KernelCMS config error: …` — assert the
// throw AND that the message points at the offending snippet field.
async function configDenied(n: string, fn: () => Promise<unknown>, needle: RegExp) {
  try {
    await fn()
    check(n, false, 'expected a config error, succeeded')
  } catch (e: any) {
    const msg = `${e?.message}`
    check(n, /config error/i.test(msg) && needle.test(msg), `threw "${msg}"`)
  }
}

// Two human users and an admin. The principal lives on `req` — operations resolve access
// from `opts.req.user`.
const alice = { req: { user: { id: 'alice', roles: ['viewer'] } } } as any
const bob = { req: { user: { id: 'bob', roles: ['viewer'] } } } as any
const admin = { req: { user: { id: 'adm', roles: ['admin'] } } } as any
const trusted = { overrideAccess: true } as const

// Owner-scoped read: a fragment is only readable by its owner (or an admin).
const ownerRead = ({ req }: any) => {
  if (req.user?.roles?.includes('admin')) return true
  return { owner: { equals: req.user?.id ?? '__none__' } }
}

async function main() {
  const dbDir = mkdtempSync(join(tmpdir(), 'kverify-snippets-'))
  const dbFile = join(dbDir, 's.db')
  const config = defineConfig({
    secret: 'verify-secret-32-characters-long!!',
    db: sqliteAdapter({ url: `file:${dbFile}` }),
    collections: [
      // A snippet library: reusable fragments referenced + transcluded elsewhere.
      {
        slug: 'snippets',
        snippet: true,
        access: { read: () => true, create: () => true, update: () => true },
        fields: [
          { name: 'label', type: 'text' },
          { name: 'body', type: 'text' },
        ],
      },
      // References a single fragment (and, on page_lists, an ordered list).
      {
        slug: 'pages',
        access: { read: () => true, create: () => true, update: () => true },
        fields: [
          { name: 'title', type: 'text' },
          { name: 'cta', type: 'snippet', snippet: 'snippets' },
        ],
      },
      {
        slug: 'page_lists',
        access: { read: () => true, create: () => true, update: () => true },
        fields: [
          { name: 'title', type: 'text' },
          { name: 'ctas', type: 'snippet', snippet: 'snippets', hasMany: true },
        ],
      },
      // An access-gated snippet library + a collection referencing it.
      {
        slug: 'secret_snippets',
        snippet: true,
        access: { read: ownerRead, create: () => true, update: () => true },
        fields: [
          { name: 'owner', type: 'text' },
          { name: 'body', type: 'text' },
        ],
      },
      {
        slug: 'pages2',
        access: { read: () => true, create: () => true, update: () => true },
        fields: [
          { name: 'title', type: 'text' },
          { name: 'secret', type: 'snippet', snippet: 'secret_snippets' },
        ],
      },
      // A self-referential snippet library, for cycle/depth safety.
      {
        slug: 'chain',
        snippet: true,
        access: { read: () => true, create: () => true, update: () => true },
        fields: [
          { name: 'body', type: 'text' },
          { name: 'next', type: 'snippet', snippet: 'chain' },
        ],
      },
    ],
  })
  const kernel = await initKernel(config, { autoMigrate: true } as any)

  try {
    console.log('\n\x1b[1mSnippets — transclusion on read (depth:1 inlines, depth:0 raw id)\x1b[0m')
    const frag = await kernel.create({ collection: 'snippets', data: { label: 'CTA', body: 'Buy now' }, ...trusted })
    const page = await kernel.create({ collection: 'pages', data: { title: 'Home', cta: frag.id }, ...trusted })
    const deep = await kernel.findByID({ collection: 'pages', id: page.id, depth: 1, ...trusted })
    const cta = deep?.cta as any
    check(
      'depth:1 inlines the FULL fragment doc',
      cta && typeof cta === 'object' && cta.id === frag.id,
      `cta=${cta?.id}`,
    )
    check('the transcluded fragment carries its body', cta?.body === 'Buy now', `body="${cta?.body}"`)
    const shallow = await kernel.findByID({ collection: 'pages', id: page.id, depth: 0, ...trusted })
    check('depth:0 keeps the raw fragment id', shallow?.cta === frag.id, `cta=${shallow?.cta}`)
    const noDepth = await kernel.findByID({ collection: 'pages', id: page.id, ...trusted })
    check('no depth keeps the raw fragment id', noDepth?.cta === frag.id, `cta=${noDepth?.cta}`)

    console.log('\n\x1b[1mSnippets — edit once, update everywhere (live, not a copy)\x1b[0m')
    const shared = await kernel.create({ collection: 'snippets', data: { label: 'S', body: 'v1' }, ...trusted })
    const pA = await kernel.create({ collection: 'pages', data: { title: 'A', cta: shared.id }, ...trusted })
    const pB = await kernel.create({ collection: 'pages', data: { title: 'B', cta: shared.id }, ...trusted })
    await kernel.update({ collection: 'snippets', id: shared.id, data: { body: 'v2' }, ...trusted })
    const reA = await kernel.findByID({ collection: 'pages', id: pA.id, depth: 1, ...trusted })
    const reB = await kernel.findByID({ collection: 'pages', id: pB.id, depth: 1, ...trusted })
    check('page A transcludes the EDITED body', (reA?.cta as any)?.body === 'v2', `body="${(reA?.cta as any)?.body}"`)
    check('page B transcludes the EDITED body', (reB?.cta as any)?.body === 'v2', `body="${(reB?.cta as any)?.body}"`)

    console.log('\n\x1b[1mSnippets — hasMany resolves an ordered list of fragments\x1b[0m')
    const f1 = await kernel.create({ collection: 'snippets', data: { label: 'one', body: '1' }, ...trusted })
    const f2 = await kernel.create({ collection: 'snippets', data: { label: 'two', body: '2' }, ...trusted })
    const f3 = await kernel.create({ collection: 'snippets', data: { label: 'three', body: '3' }, ...trusted })
    const list = await kernel.create({
      collection: 'page_lists',
      data: { title: 'L', ctas: [f3.id, f1.id, f2.id] },
      ...trusted,
    })
    const deepList = await kernel.findByID({ collection: 'page_lists', id: list.id, depth: 1, ...trusted })
    const ctas = (deepList?.ctas ?? []) as any[]
    check(
      'hasMany resolves docs in stored order',
      Array.isArray(ctas) && ctas.map((c) => c?.id).join(',') === [f3.id, f1.id, f2.id].join(','),
      `order=${ctas.map((c) => c?.body).join(',')}`,
    )
    check(
      'each list entry is the full fragment doc',
      ctas.every((c) => c && typeof c === 'object' && 'body' in c),
      '',
    )

    console.log('\n\x1b[1mSnippets — access-checked transclusion (non-readable → raw id, not content)\x1b[0m')
    const secret = await kernel.create({
      collection: 'secret_snippets',
      data: { owner: 'alice', body: 'top secret' },
      ...trusted,
    })
    const page2 = await kernel.create({ collection: 'pages2', data: { title: 'P', secret: secret.id }, ...trusted })
    const asBob = await kernel.findByID({ collection: 'pages2', id: page2.id, depth: 1, ...bob })
    check(
      'bob (cannot read the fragment) gets the raw id, NOT the content',
      asBob?.secret === secret.id && typeof asBob?.secret !== 'object',
      `secret=${asBob?.secret}`,
    )
    const asAlice = await kernel.findByID({ collection: 'pages2', id: page2.id, depth: 1, ...alice })
    check('the owner gets the full transcluded fragment', (asAlice?.secret as any)?.body === 'top secret', '')
    const asAdmin = await kernel.findByID({ collection: 'pages2', id: page2.id, depth: 1, ...admin })
    check('an admin gets the full transcluded fragment', (asAdmin?.secret as any)?.body === 'top secret', '')

    console.log('\n\x1b[1mSnippets — cycle / depth safety (A→B→A, high depth, bounded, no hang)\x1b[0m')
    const a = await kernel.create({ collection: 'chain', data: { body: 'A' }, ...trusted })
    const b = await kernel.create({ collection: 'chain', data: { body: 'B', next: a.id }, ...trusted })
    await kernel.update({ collection: 'chain', id: a.id, data: { next: b.id }, ...trusted })
    const started = Date.now()
    const cyclic = await kernel.findByID({ collection: 'chain', id: a.id, depth: 10, ...trusted })
    const elapsed = Date.now() - started
    check('a cyclic snippet chain read RETURNS (bounded, not infinite)', cyclic?.id === a.id, `id=${cyclic?.id}`)
    check('it finishes well under a second (depth-bounded)', elapsed < 1000, `elapsed=${elapsed}ms`)
    check('the first hop inlines fragment B', (cyclic?.next as any)?.id === b.id, `next=${(cyclic?.next as any)?.id}`)

    console.log('\n\x1b[1mSnippets — config guards (throw at initKernel)\x1b[0m')
    await configDenied(
      'a snippet field referencing an UNKNOWN collection is rejected at init',
      () =>
        initKernel(
          defineConfig({
            secret: 'verify-secret-32-characters-long!!',
            db: sqliteAdapter({ url: ':memory:' }),
            collections: [
              {
                slug: 'pages',
                access: { read: () => true },
                fields: [{ name: 'cta', type: 'snippet', snippet: 'does_not_exist' }],
              },
            ],
          }),
          { logLevel: 'error' } as any,
        ),
      /references unknown collection/i,
    )
    await configDenied(
      'a snippet field referencing a NON-snippet collection is rejected at init',
      () =>
        initKernel(
          defineConfig({
            secret: 'verify-secret-32-characters-long!!',
            db: sqliteAdapter({ url: ':memory:' }),
            collections: [
              { slug: 'blocks', access: { read: () => true }, fields: [{ name: 'body', type: 'text' }] },
              {
                slug: 'pages',
                access: { read: () => true },
                fields: [{ name: 'cta', type: 'snippet', snippet: 'blocks' }],
              },
            ],
          }),
          { logLevel: 'error' } as any,
        ),
      /must reference a .*snippet/i,
    )

    console.log('\n\x1b[1mSnippets — write validation\x1b[0m')
    const okFrag = await kernel.create({ collection: 'snippets', data: { label: 'x', body: 'y' }, ...trusted })
    const okPage = await kernel.create({ collection: 'pages', data: { title: 'Valid', cta: okFrag.id }, ...trusted })
    check('a string snippet id is accepted', okPage.cta === okFrag.id, `cta=${okPage.cta}`)
    await denied('a boolean snippet value is rejected (must be an id)', () =>
      kernel.create({ collection: 'pages', data: { title: 'Bad', cta: true } as any, ...trusted }),
    )
  } finally {
    await kernel.destroy()
    try {
      rmSync(dirname(dbFile), { recursive: true, force: true })
    } catch {
      // best-effort temp cleanup
    }
  }

  console.log(`\n\x1b[1mSnippets Result: ${pass} passed, ${fails.length} failed\x1b[0m`)
  if (fails.length) {
    console.log('Failures:\n  ' + fails.join('\n  '))
    process.exit(1)
  }
  process.exit(0)
}
main().catch((e) => {
  console.error('SNIPPETS HARNESS ERROR:', e)
  process.exit(2)
})
