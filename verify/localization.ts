/* Live localization verification: strict no-fallback reads, bulk multi-locale writes,
 * translation status, the strict publish gate, and untrusted-locale-key guards.
 * Run: pnpm tsx verify/localization.ts */
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
async function rejects(n: string, fn: () => Promise<unknown>) {
  try {
    await fn()
    check(n, false, 'expected a rejection, succeeded')
  } catch (e: any) {
    check(n, true, `threw ${e?.code ?? e?.name}`)
  }
}

function makeConfig(strict: boolean, file: string) {
  return defineConfig({
    secret: 'verify-secret-32-characters-long!!',
    db: sqliteAdapter({ url: `file:${file}` }),
    localization: { locales: ['en', 'fr', 'de'], defaultLocale: 'en', fallback: true, strict },
    collections: [
      {
        slug: 'posts',
        access: { read: () => true, create: () => true, update: () => true },
        fields: [
          { name: 'title', type: 'text', localized: true, required: true },
          { name: 'body', type: 'text', localized: true },
          { name: 'slug', type: 'text' },
        ],
      },
      {
        // Drafts-enabled twin for the strict publish gate.
        slug: 'articles',
        versions: { drafts: true },
        access: { read: () => true, create: () => true, update: () => true, publish: () => true },
        fields: [
          { name: 'title', type: 'text', localized: true, required: true },
          { name: 'slug', type: 'text' },
        ],
      },
    ],
  })
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'kverify-loc-'))
  const nonStrict = await initKernel(makeConfig(false, join(dir, 'a.db')), { autoMigrate: true } as any)
  const strict = await initKernel(makeConfig(true, join(dir, 'b.db')), { autoMigrate: true } as any)

  console.log('\n\x1b[1mLocalization — non-strict fallback (current behaviour intact)\x1b[0m')
  const a = await nonStrict.create({ collection: 'posts', data: { title: 'Hello', slug: 'p1' } })
  const aFr = await nonStrict.findByID({ collection: 'posts', id: a.id, req: { locale: 'fr' } })
  check('non-strict: fr read falls back to en', aFr?.title === 'Hello', `title=${aFr?.title}`)

  console.log('\n\x1b[1mLocalization — strict no silent fallback (the headline fix)\x1b[0m')
  const b = await strict.create({ collection: 'posts', data: { title: 'Hello', slug: 'p1' } })
  const bFr = await strict.findByID({ collection: 'posts', id: b.id, req: { locale: 'fr' } })
  check('strict: fr read returns null (no masking)', bFr?.title === null, `title=${String(bFr?.title)}`)
  const bFrOptIn = await strict.findByID({
    collection: 'posts',
    id: b.id,
    req: { locale: 'fr', fallbackLocale: 'en' },
  })
  check('strict: explicit fallbackLocale opt-in still works', bFrOptIn?.title === 'Hello', `title=${bFrOptIn?.title}`)

  console.log('\n\x1b[1mLocalization — bulk multi-locale write\x1b[0m')
  await nonStrict.updateLocales({
    collection: 'posts',
    id: a.id,
    locales: { en: { title: 'Hello' }, fr: { title: 'Bonjour' }, de: { title: 'Hallo' } },
  })
  const aEn = await nonStrict.findByID({ collection: 'posts', id: a.id, req: { locale: 'en' } })
  const aFr2 = await nonStrict.findByID({ collection: 'posts', id: a.id, req: { locale: 'fr' } })
  const aDe = await nonStrict.findByID({ collection: 'posts', id: a.id, req: { locale: 'de' } })
  check(
    'updateLocales filled three locales in one call',
    aEn?.title === 'Hello' && aFr2?.title === 'Bonjour' && aDe?.title === 'Hallo',
    `en=${aEn?.title} fr=${aFr2?.title} de=${aDe?.title}`,
  )
  // A later single-locale write must not clobber the others.
  await nonStrict.update({ collection: 'posts', id: a.id, data: { title: 'Salut' }, req: { locale: 'fr' } })
  const aAll = (await nonStrict.findByID({ collection: 'posts', id: a.id, req: { locale: 'all' } })) as any
  check(
    'single-locale update preserves untouched locales',
    aAll?.title?.en === 'Hello' && aAll?.title?.fr === 'Salut' && aAll?.title?.de === 'Hallo',
    JSON.stringify(aAll?.title),
  )

  console.log('\n\x1b[1mLocalization — locale:"all" whole-map read\x1b[0m')
  check(
    'locale:"all" returns the full { en, fr, de } map',
    aAll?.title?.en === 'Hello' && aAll?.title?.fr === 'Salut' && aAll?.title?.de === 'Hallo',
    JSON.stringify(aAll?.title),
  )

  console.log('\n\x1b[1mLocalization — translation status\x1b[0m')
  const status = await nonStrict.translationStatus({ collection: 'posts', id: a.id })
  check('status: en complete', status.en?.complete === true, JSON.stringify(status.en))
  // A doc with only en is incomplete for fr with missingRequired: ['title'].
  const c = await nonStrict.create({ collection: 'posts', data: { title: 'Only EN', slug: 'p2' } })
  const cStatus = await nonStrict.translationStatus({ collection: 'posts', id: c.id })
  check(
    'status: untranslated fr is incomplete with missingRequired ["title"]',
    cStatus.fr?.complete === false && JSON.stringify(cStatus.fr?.missingRequired) === JSON.stringify(['title']),
    JSON.stringify(cStatus.fr),
  )
  const list = await nonStrict.translationStatusList({ collection: 'posts' })
  check('statusList aggregates docs', list.count >= 2 && Array.isArray(list.docs), `count=${list.count}`)
  const aItem = list.docs.find((d: any) => d.id === a.id) as any
  check(
    'statusList marks the fully-translated doc complete across all locales',
    aItem && aItem.completeLocales.sort().join(',') === 'de,en,fr',
    aItem ? aItem.completeLocales.join(',') : 'missing',
  )

  console.log('\n\x1b[1mLocalization — strict publish gate (default locale must be complete)\x1b[0m')
  // Seed a draft whose DEFAULT (en) locale is missing the required title but a NON-default
  // locale has it — the exact "primary language unfinished" shape. Written straight to the
  // adapter so we model a pre-existing / migrated row the publish gate must still catch.
  const incompleteId = 'verify-incomplete-1'
  await (strict.db as any).create({
    collection: 'articles',
    data: { id: incompleteId, title: { fr: 'Bonjour' }, slug: 'p3', _status: 'draft' },
  })
  const seeded = await strict.findByID({ collection: 'articles', id: incompleteId, draft: true, req: { locale: 'fr' } })
  check('strict: seeded draft has fr but not en title', seeded?.title === 'Bonjour', `fr title=${seeded?.title}`)
  // Publish from the fr locale: per-locale validation only checks fr (complete), so the
  // DEFAULT-locale publish gate is what must catch the missing en title.
  await rejects('strict: publishing a doc with an empty default-locale required field is rejected', () =>
    strict.publish({ collection: 'articles', id: incompleteId, req: { locale: 'fr' } }),
  )
  // Filling the default locale lets it publish.
  await strict.update({ collection: 'articles', id: incompleteId, data: { title: 'Ready' }, req: { locale: 'en' } })
  const published = await strict.publish({ collection: 'articles', id: incompleteId })
  check(
    'strict: publishing with a complete default locale succeeds',
    published?._status === 'published',
    `status=${published?._status}`,
  )

  console.log('\n\x1b[1mLocalization — untrusted locale keys constrained\x1b[0m')
  await rejects('updateLocales rejects an unknown locale code "zz"', () =>
    nonStrict.updateLocales({ collection: 'posts', id: a.id, locales: { zz: { title: 'x' } } }),
  )
  await rejects('updateLocales rejects a __proto__ key', () =>
    nonStrict.updateLocales({ collection: 'posts', id: a.id, locales: { ['__proto__']: { title: 'x' } } as any }),
  )
  // The rejected writes must not have clobbered the good locales.
  const aAfter = (await nonStrict.findByID({ collection: 'posts', id: a.id, req: { locale: 'all' } })) as any
  check(
    'rejected untrusted writes left existing locales intact',
    aAfter?.title?.en === 'Hello' && aAfter?.title?.fr === 'Salut' && aAfter?.title?.de === 'Hallo',
    JSON.stringify(aAfter?.title),
  )

  await nonStrict.destroy()
  await strict.destroy()

  console.log(`\n\x1b[1mLocalization Result: ${pass} passed, ${fails.length} failed\x1b[0m`)
  if (fails.length) {
    console.log('Failures:\n  ' + fails.join('\n  '))
    process.exit(1)
  }
  process.exit(0)
}
main().catch((e) => {
  console.error('LOCALIZATION HARNESS ERROR:', e)
  process.exit(2)
})
