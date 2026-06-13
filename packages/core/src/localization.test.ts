import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { defineConfig, deserializeDoc, serializeDoc, validateLocaleRequired, initKernel } from './index'
import type { ConfigField, Kernel } from './index'

// Localized fields are stored as `{ [locale]: value }` JSON maps. These tests pin down
// the three Payload-gap fixes: strict no-fallback reads, per-locale required validation,
// bulk multi-locale writes, `locale:'all'` reads, and translation status.

const postFields: ConfigField[] = [
  { name: 'title', type: 'text', localized: true, required: true },
  { name: 'body', type: 'text', localized: true },
  { name: 'slug', type: 'text' },
]

function config(strict: boolean) {
  return defineConfig({
    secret: 'test-secret',
    db: sqliteAdapter({ url: ':memory:' }),
    localization: { locales: ['en', 'fr', 'de'], defaultLocale: 'en', fallback: true, strict },
    collections: [
      {
        slug: 'posts',
        access: { read: () => true, create: () => true, update: () => true },
        fields: postFields,
      },
    ],
  })
}

describe('resolveLocale (deserialize)', () => {
  const row = { title: { en: 'Hello' }, body: { en: 'Body' }, slug: 'p' }

  it('non-strict falls back to the fallback locale when the requested one is missing', () => {
    const doc = deserializeDoc(postFields, row, { locale: 'fr', fallbackLocale: 'en' })
    expect(doc.title).toBe('Hello')
  })

  it('strict returns null instead of silently falling back', () => {
    const doc = deserializeDoc(postFields, row, { locale: 'fr', fallbackLocale: 'en', strict: true })
    expect(doc.title).toBeNull()
  })

  it('strict still honours an explicit per-request fallback opt-in', () => {
    const doc = deserializeDoc(postFields, row, {
      locale: 'fr',
      fallbackLocale: 'en',
      strict: true,
      strictFallbackOptIn: true,
    })
    expect(doc.title).toBe('Hello')
  })

  it('locale:"all" returns the full per-locale map for localized fields', () => {
    const all = { title: { en: 'Hello', fr: 'Bonjour' }, body: {}, slug: 'p' }
    const doc = deserializeDoc(postFields, all, { locale: 'all', fallbackLocale: 'en', allLocales: true })
    expect(doc.title).toEqual({ en: 'Hello', fr: 'Bonjour' })
    expect(doc.slug).toBe('p')
  })
})

describe('serializeDoc merges locales without clobbering', () => {
  it('writing one locale preserves the others already stored', () => {
    const existing = { title: { en: 'Hello', de: 'Hallo' } }
    const row = serializeDoc(postFields, { title: 'Bonjour' }, { locale: 'fr', existingRow: existing })
    expect(row.title).toEqual({ en: 'Hello', de: 'Hallo', fr: 'Bonjour' })
  })
})

describe('validateLocaleRequired', () => {
  it('flags a locale missing a required localized field', () => {
    const row = { title: { en: 'Hello' } }
    const errors = validateLocaleRequired(postFields, row, ['en', 'fr'])
    expect(errors.map((e) => e.path)).toEqual(['fr.title'])
  })

  it('passes when every written locale has the required field', () => {
    const row = { title: { en: 'Hello', fr: 'Bonjour' } }
    expect(validateLocaleRequired(postFields, row, ['en', 'fr'])).toEqual([])
  })
})

describe('strict-mode kernel reads', () => {
  let kernel: Kernel
  beforeEach(async () => {
    kernel = await initKernel(config(true), { logLevel: 'error' })
    await kernel.migrate()
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('does not mask an untranslated locale as the default (no silent fallback)', async () => {
    const created = await kernel.create({ collection: 'posts', data: { title: 'Hello', slug: 'p' } })
    const fr = await kernel.findByID({ collection: 'posts', id: created.id, req: { locale: 'fr' } })
    expect(fr?.title).toBeNull()
  })

  it('honours an explicit fallbackLocale on the request even under strict', async () => {
    const created = await kernel.create({ collection: 'posts', data: { title: 'Hello', slug: 'p' } })
    const fr = await kernel.findByID({
      collection: 'posts',
      id: created.id,
      req: { locale: 'fr', fallbackLocale: 'en' },
    })
    expect(fr?.title).toBe('Hello')
  })
})

describe('non-strict kernel reads', () => {
  let kernel: Kernel
  beforeEach(async () => {
    kernel = await initKernel(config(false), { logLevel: 'error' })
    await kernel.migrate()
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('falls back to the default locale (legacy behaviour intact)', async () => {
    const created = await kernel.create({ collection: 'posts', data: { title: 'Hello', slug: 'p' } })
    const fr = await kernel.findByID({ collection: 'posts', id: created.id, req: { locale: 'fr' } })
    expect(fr?.title).toBe('Hello')
  })
})

describe('updateLocales', () => {
  let kernel: Kernel
  beforeEach(async () => {
    kernel = await initKernel(config(false), { logLevel: 'error' })
    await kernel.migrate()
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('fills three locales in one call and preserves untouched locales on a later write', async () => {
    const created = await kernel.create({ collection: 'posts', data: { title: 'Hello', slug: 'p' } })
    await kernel.updateLocales({
      collection: 'posts',
      id: created.id,
      locales: { en: { title: 'Hello' }, fr: { title: 'Bonjour' }, de: { title: 'Hallo' } },
    })
    const all = await kernel.findByID({ collection: 'posts', id: created.id, req: { locale: 'all' } })
    expect(all?.title).toEqual({ en: 'Hello', fr: 'Bonjour', de: 'Hallo' })

    // A later single-locale update must not clobber the other locales.
    await kernel.update({ collection: 'posts', id: created.id, data: { title: 'Salut' }, req: { locale: 'fr' } })
    const after = await kernel.findByID({ collection: 'posts', id: created.id, req: { locale: 'all' } })
    expect(after?.title).toEqual({ en: 'Hello', fr: 'Salut', de: 'Hallo' })
  })

  it('rejects an unknown locale code without writing any locale', async () => {
    const created = await kernel.create({ collection: 'posts', data: { title: 'Hello', slug: 'p' } })
    await expect(
      kernel.updateLocales({
        collection: 'posts',
        id: created.id,
        locales: { fr: { title: 'Bonjour' }, zz: { title: 'x' } },
      }),
    ).rejects.toThrow()
    const all = await kernel.findByID({ collection: 'posts', id: created.id, req: { locale: 'all' } })
    expect(all?.title).toEqual({ en: 'Hello' })
  })

  it('rejects a prototype-pollution locale key', async () => {
    const created = await kernel.create({ collection: 'posts', data: { title: 'Hello', slug: 'p' } })
    await expect(
      kernel.updateLocales({
        collection: 'posts',
        id: created.id,
        locales: { ['__proto__']: { title: 'x' } } as never,
      }),
    ).rejects.toThrow()
  })
})

describe('translationStatus', () => {
  let kernel: Kernel
  beforeEach(async () => {
    kernel = await initKernel(config(false), { logLevel: 'error' })
    await kernel.migrate()
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('reports the default locale complete and an untranslated locale incomplete', async () => {
    const created = await kernel.create({ collection: 'posts', data: { title: 'Hello', slug: 'p' } })
    const status = await kernel.translationStatus({ collection: 'posts', id: created.id })
    expect(status.en.complete).toBe(true)
    expect(status.fr.complete).toBe(false)
    expect(status.fr.missingRequired).toEqual(['title'])
  })

  it('aggregates completeness in the dashboard list', async () => {
    const created = await kernel.create({ collection: 'posts', data: { title: 'Hello', slug: 'p' } })
    await kernel.updateLocales({ collection: 'posts', id: created.id, locales: { fr: { title: 'Bonjour' } } })
    const { docs, count } = await kernel.translationStatusList({ collection: 'posts' })
    expect(count).toBe(1)
    expect(docs[0]!.completeLocales.sort()).toEqual(['en', 'fr'])
    expect(docs[0]!.incompleteLocales).toEqual(['de'])
  })
})
