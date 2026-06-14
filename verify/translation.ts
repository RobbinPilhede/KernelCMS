/* Live AI-assisted translation verification: a pluggable provider auto-fills untranslated
 * locales of localized fields THROUGH the normal access-checked update — so access, strict
 * per-locale validation, and the agent draft-only brake all apply, a provider failure never
 * corrupts the doc or leaks its inputs, and untrusted locale keys are rejected.
 * Run: pnpm tsx verify/translation.ts */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig, initKernel } from '@kernel/core'
import type { TranslateFn } from '@kernel/core'
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
async function rejects(n: string, fn: () => Promise<unknown>, match?: RegExp) {
  try {
    await fn()
    check(n, false, 'expected a rejection, succeeded')
  } catch (e: any) {
    const blob = `${e?.code ?? ''}${e?.name ?? ''}${e?.message ?? ''}`
    check(n, match ? match.test(blob) : true, `threw ${e?.code ?? e?.name}`)
  }
}

// A deterministic, reproducible mock provider: prefix each source string with `[<to>] `.
// Records the texts it received so we can assert the engine never sent it a read-denied field.
const seenTexts: string[] = []
const mockTranslate: TranslateFn = async ({ texts, to }) => {
  for (const t of texts) seenTexts.push(t)
  return texts.map((t) => `[${to}] ${t}`)
}

// A SECRET an exploding provider closes over — the wrapped error must NEVER surface it.
const FAKE_API_KEY = 'sk-fake-secret-key-DO-NOT-LEAK'

function makeConfig(file: string, translate: TranslateFn, strict = false) {
  return defineConfig({
    secret: 'verify-secret-32-characters-long!!',
    db: sqliteAdapter({ url: `file:${file}` }),
    localization: { locales: ['en', 'es', 'fr'], defaultLocale: 'en', fallback: false, strict },
    translation: { translate },
    collections: [
      {
        slug: 'posts',
        access: { read: () => true, create: () => true, update: () => true },
        fields: [
          { name: 'title', type: 'text', localized: true, required: true },
          { name: 'body', type: 'text', localized: true },
          // A localized field the caller can NEVER read — it must never reach the provider.
          { name: 'secret_note', type: 'text', localized: true, access: { read: () => false } },
          { name: 'slug', type: 'text' },
        ],
      },
    ],
  })
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'kverify-translation-'))

  // -------------------------------------------------------------------------
  console.log('\n\x1b[1mTranslation — fills the target locale; source untouched (merge)\x1b[0m')
  const kernel = await initKernel(makeConfig(join(dir, 'a.db'), mockTranslate), { autoMigrate: true } as any)

  const post = await kernel.create({
    collection: 'posts',
    data: { title: 'Hello', body: 'World', secret_note: 'classified', slug: 'p1' },
    req: { locale: 'en' },
  })
  await kernel.translateDocument({ collection: 'posts', id: post.id, from: 'en', to: 'es' })

  const es = await kernel.findByID({ collection: 'posts', id: post.id, req: { locale: 'es' } })
  check('es title is the provider output', es?.title === '[es] Hello', `title=${es?.title}`)
  check('es body is the provider output', es?.body === '[es] World', `body=${es?.body}`)
  const en = await kernel.findByID({ collection: 'posts', id: post.id, req: { locale: 'en' } })
  check('en title is UNTOUCHED (merge, not clobber)', en?.title === 'Hello', `title=${en?.title}`)
  check('en body is UNTOUCHED', en?.body === 'World', `body=${en?.body}`)
  check(
    'read-denied field NEVER sent to the provider',
    !seenTexts.includes('classified'),
    `seen=${JSON.stringify(seenTexts)}`,
  )

  // -------------------------------------------------------------------------
  console.log('\n\x1b[1mTranslation — only MISSING filled by default; overwrite replaces\x1b[0m')
  // Manually set a real es title, then translate again WITHOUT overwrite: it must stay.
  await kernel.updateLocales({ collection: 'posts', id: post.id, locales: { es: { title: 'Hola humano' } } })
  await kernel.translateDocument({ collection: 'posts', id: post.id, from: 'en', to: 'es' })
  const es2 = await kernel.findByID({ collection: 'posts', id: post.id, req: { locale: 'es' } })
  check('existing es title preserved (only-missing default)', es2?.title === 'Hola humano', `title=${es2?.title}`)
  // With overwrite, the existing es title is replaced by the provider output.
  await kernel.translateDocument({ collection: 'posts', id: post.id, from: 'en', to: 'es', overwrite: true })
  const es3 = await kernel.findByID({ collection: 'posts', id: post.id, req: { locale: 'es' } })
  check('overwrite replaces the existing es title', es3?.title === '[es] Hello', `title=${es3?.title}`)

  // -------------------------------------------------------------------------
  console.log('\n\x1b[1mtranslateMissing — bounded batch, reports translated/skipped\x1b[0m')
  // post (above) has no fr yet. Add two more, one of which has NO source text for fr fields.
  const post2 = await kernel.create({ collection: 'posts', data: { title: 'Cat', slug: 'p2' }, req: { locale: 'en' } })
  const post3 = await kernel.create({ collection: 'posts', data: { title: 'Dog', slug: 'p3' }, req: { locale: 'en' } })
  const res = await kernel.translateMissing({ collection: 'posts', to: 'fr', limit: 2 })
  check('translateMissing bounded by limit (<=2 considered)', res.translated.length + res.skipped.length <= 2, '')
  check('translateMissing reports translated ids', res.translated.length >= 1, `translated=${res.translated.length}`)
  const fr = await kernel.findByID({ collection: 'posts', id: post2.id, req: { locale: 'fr' } })
  // post2 may or may not be in the first batch page; assert the fr fill works for whatever was translated.
  const someFr = await kernel.findByID({
    collection: 'posts',
    id: res.translated[0] ?? post2.id,
    req: { locale: 'fr' },
  })
  check(
    'a translated doc has its fr title filled',
    typeof someFr?.title === 'string' && someFr.title.startsWith('[fr] '),
    `title=${someFr?.title}`,
  )
  void post3
  void fr

  // -------------------------------------------------------------------------
  console.log('\n\x1b[1mLocale-key guards — unknown / __proto__ rejected, no pollution\x1b[0m')
  await rejects('unknown `to` locale rejected', () =>
    kernel.translateDocument({ collection: 'posts', id: post.id, from: 'en', to: 'zz' }),
  )
  await rejects('unknown `from` locale rejected', () =>
    kernel.translateDocument({ collection: 'posts', id: post.id, from: 'zz', to: 'es' }),
  )
  await rejects('__proto__ as `to` rejected', () =>
    kernel.translateDocument({ collection: 'posts', id: post.id, from: 'en', to: '__proto__' }),
  )
  await rejects('from === to rejected', () =>
    kernel.translateDocument({ collection: 'posts', id: post.id, from: 'es', to: 'es' }),
  )
  check('no prototype pollution from a hostile locale key', ({} as any).polluted === undefined, '')

  // -------------------------------------------------------------------------
  console.log('\n\x1b[1mProvider failure — doc unchanged, no leak of source text / API key\x1b[0m')
  const boomTranslate: TranslateFn = async () => {
    throw new Error(`provider exploded with ${FAKE_API_KEY} on text "Hello"`)
  }
  const k2 = await initKernel(makeConfig(join(dir, 'b.db'), boomTranslate), { autoMigrate: true } as any)
  const bp = await k2.create({
    collection: 'posts',
    data: { title: 'Hello', body: 'World', slug: 'b1' },
    req: { locale: 'en' },
  })
  let leaked = ''
  await rejects(
    'a throwing provider surfaces a GENERIC error',
    async () => {
      try {
        await k2.translateDocument({ collection: 'posts', id: bp.id, from: 'en', to: 'es' })
      } catch (e: any) {
        leaked = `${e?.message ?? ''}`
        throw e
      }
    },
    /Translation provider failed/,
  )
  check('error does not leak the fake API key', !leaked.includes(FAKE_API_KEY), `msg=${leaked}`)
  check('error does not leak the source text', !leaked.includes('Hello'), `msg=${leaked}`)
  const bes = await k2.findByID({ collection: 'posts', id: bp.id, req: { locale: 'es' } })
  check('doc unchanged after provider failure (no partial write)', bes?.title === null, `es.title=${bes?.title}`)

  // -------------------------------------------------------------------------
  console.log('\n\x1b[1mAccess — a doc the caller cannot update is not written\x1b[0m')
  const guarded = defineConfig({
    secret: 'verify-secret-32-characters-long!!',
    db: sqliteAdapter({ url: `file:${join(dir, 'c.db')}` }),
    localization: { locales: ['en', 'es', 'fr'], defaultLocale: 'en', fallback: false },
    translation: { translate: mockTranslate },
    collections: [
      {
        slug: 'posts',
        // Anyone may read+create; only an admin may UPDATE.
        access: {
          read: () => true,
          create: () => true,
          update: ({ req }) => Boolean(req.user?.roles?.includes('admin')),
        },
        fields: [
          { name: 'title', type: 'text', localized: true, required: true },
          { name: 'body', type: 'text', localized: true },
        ],
      },
    ],
  })
  const k3 = await initKernel(guarded, { autoMigrate: true } as any)
  const gp = await k3.create({ collection: 'posts', data: { title: 'Hi', body: 'There' }, req: { locale: 'en' } })
  await rejects('non-admin translate is Forbidden (write access enforced)', () =>
    k3.translateDocument({
      collection: 'posts',
      id: gp.id,
      from: 'en',
      to: 'es',
      req: { user: { id: 'u1', roles: ['member'] } },
    }),
  )
  const gesBefore = await k3.findByID({ collection: 'posts', id: gp.id, req: { locale: 'es' } })
  check('forbidden doc was NOT written', gesBefore?.title === null, `es.title=${gesBefore?.title}`)
  // An admin CAN translate it.
  await k3.translateDocument({
    collection: 'posts',
    id: gp.id,
    from: 'en',
    to: 'es',
    req: { user: { id: 'a1', roles: ['admin'] } },
  })
  const gesAfter = await k3.findByID({ collection: 'posts', id: gp.id, req: { locale: 'es' } })
  check('admin translate writes es', gesAfter?.title === '[es] Hi', `es.title=${gesAfter?.title}`)

  // -------------------------------------------------------------------------
  console.log('\n\x1b[1mStrict mode + agent brake — required validation applies, agents stay drafts\x1b[0m')
  const kStrict = await initKernel(makeConfig(join(dir, 'd.db'), mockTranslate, true), { autoMigrate: true } as any)
  const sp = await kStrict.create({
    collection: 'posts',
    data: { title: 'Strict', body: 'Body' },
    req: { locale: 'en' },
  })
  await kStrict.translateDocument({ collection: 'posts', id: sp.id, from: 'en', to: 'es' })
  const ses = await kStrict.findByID({ collection: 'posts', id: sp.id, req: { locale: 'es' } })
  check('strict: translated es satisfies required title', ses?.title === '[es] Strict', `es.title=${ses?.title}`)

  // -------------------------------------------------------------------------
  console.log('\n\x1b[1mAgent brake — an agent can translate a draft but it stays a draft\x1b[0m')
  const agentCfg = defineConfig({
    secret: 'verify-secret-32-characters-long!!',
    db: sqliteAdapter({ url: `file:${join(dir, 'e.db')}` }),
    localization: { locales: ['en', 'es', 'fr'], defaultLocale: 'en', fallback: false },
    translation: { translate: mockTranslate },
    agents: [{ id: 'bot', token: 'bot-token-verify', fieldScope: { allow: ['title', 'body'] } }],
    collections: [
      {
        slug: 'posts',
        versions: { drafts: true },
        access: { read: () => true, create: () => true, update: () => true, publish: () => true },
        fields: [
          { name: 'title', type: 'text', localized: true, required: true },
          { name: 'body', type: 'text', localized: true },
        ],
      },
    ],
  })
  const k4 = await initKernel(agentCfg, { autoMigrate: true } as any)
  const agentReq = { user: { id: 'bot', principalType: 'agent' as const, fieldScope: { allow: ['title', 'body'] } } }
  // The agent creates a DRAFT, then translates it to es — the translation write must stay a draft.
  const dp = await k4.create({
    collection: 'posts',
    data: { title: 'Draft', body: 'Body', _status: 'draft' },
    req: { ...agentReq, locale: 'en' },
  })
  await k4.translateDocument({ collection: 'posts', id: dp.id, from: 'en', to: 'es', req: agentReq })
  const dDraft = await k4.findByID({ collection: 'posts', id: dp.id, draft: true, overrideAccess: true })
  check(
    'agent translation never auto-publishes (stays draft)',
    dDraft?._status === 'draft',
    `_status=${dDraft?._status}`,
  )
  const dEs = await k4.findByID({ collection: 'posts', id: dp.id, draft: true, req: { ...agentReq, locale: 'es' } })
  check('agent translation filled the es locale on the draft', dEs?.title === '[es] Draft', `es.title=${dEs?.title}`)

  console.log(`\n\x1b[1mTranslation Result: ${pass} passed, ${fails.length} failed\x1b[0m`)
  if (fails.length) {
    console.log('Failures:\n  ' + fails.join('\n  '))
    process.exit(1)
  }
  process.exit(0)
}
main().catch((e) => {
  console.error('TRANSLATION HARNESS ERROR:', e)
  process.exit(2)
})
