import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { defineConfig, initKernel } from './index'
import type { Kernel, TranslateFn } from './index'

// AI-assisted translation builds over the localization layer: a pluggable provider maps
// source strings to a target locale, and the results are written through the NORMAL
// access-checked update (merge — other locales preserved). These tests pin down
// fill-missing vs overwrite, locale validation, provider-error no-write, and batch bounds.

const passthrough: TranslateFn = async ({ texts, to }) => texts.map((t) => `[${to}] ${t}`)

function makeKernel(translate: TranslateFn, opts: { strict?: boolean } = {}): Promise<Kernel> {
  return initKernel(
    defineConfig({
      secret: 'test-secret-32-characters-long!!',
      db: sqliteAdapter({ url: ':memory:' }),
      localization: { locales: ['en', 'es', 'fr'], defaultLocale: 'en', fallback: false, strict: opts.strict },
      translation: { translate },
      collections: [
        {
          slug: 'posts',
          access: { read: () => true, create: () => true, update: () => true },
          fields: [
            { name: 'title', type: 'text', localized: true, required: true },
            { name: 'body', type: 'text', localized: true },
            { name: 'secret_note', type: 'text', localized: true, access: { read: () => false } },
            { name: 'slug', type: 'text' },
          ],
        },
      ],
    }),
    { autoMigrate: true } as never,
  )
}

describe('translateDocument', () => {
  let kernel: Kernel

  beforeEach(async () => {
    kernel = await makeKernel(passthrough)
  })

  it('fills the target locale and leaves the source locale untouched', async () => {
    const post = await kernel.create({
      collection: 'posts',
      data: { title: 'Hello', body: 'World', slug: 'p' },
      req: { locale: 'en' },
    })
    await kernel.translateDocument({ collection: 'posts', id: post.id, from: 'en', to: 'es' })

    const es = await kernel.findByID({ collection: 'posts', id: post.id, req: { locale: 'es' } })
    expect(es?.title).toBe('[es] Hello')
    expect(es?.body).toBe('[es] World')

    const en = await kernel.findByID({ collection: 'posts', id: post.id, req: { locale: 'en' } })
    expect(en?.title).toBe('Hello')
    expect(en?.body).toBe('World')
  })

  it('only fills missing translations by default and replaces with overwrite', async () => {
    const post = await kernel.create({
      collection: 'posts',
      data: { title: 'Hello', body: 'World' },
      req: { locale: 'en' },
    })
    await kernel.updateLocales({ collection: 'posts', id: post.id, locales: { es: { title: 'Hola' } } })

    await kernel.translateDocument({ collection: 'posts', id: post.id, from: 'en', to: 'es' })
    const afterDefault = await kernel.findByID({ collection: 'posts', id: post.id, req: { locale: 'es' } })
    expect(afterDefault?.title).toBe('Hola') // preserved
    expect(afterDefault?.body).toBe('[es] World') // missing body filled

    await kernel.translateDocument({ collection: 'posts', id: post.id, from: 'en', to: 'es', overwrite: true })
    const afterOverwrite = await kernel.findByID({ collection: 'posts', id: post.id, req: { locale: 'es' } })
    expect(afterOverwrite?.title).toBe('[es] Hello')
  })

  it('never sends a read-denied localized field to the provider', async () => {
    const spy = vi.fn(passthrough)
    const k = await makeKernel(spy)
    const post = await k.create({
      collection: 'posts',
      data: { title: 'Hello', secret_note: 'classified' },
      req: { locale: 'en' },
    })
    await k.translateDocument({ collection: 'posts', id: post.id, from: 'en', to: 'es' })
    const sentTexts = spy.mock.calls.flatMap((c) => c[0].texts)
    expect(sentTexts).toContain('Hello')
    expect(sentTexts).not.toContain('classified')
  })

  it('rejects unknown and prototype-pollution locale keys', async () => {
    const post = await kernel.create({ collection: 'posts', data: { title: 'Hi' }, req: { locale: 'en' } })
    await expect(kernel.translateDocument({ collection: 'posts', id: post.id, from: 'en', to: 'zz' })).rejects.toThrow()
    await expect(kernel.translateDocument({ collection: 'posts', id: post.id, from: 'zz', to: 'es' })).rejects.toThrow()
    await expect(
      kernel.translateDocument({ collection: 'posts', id: post.id, from: 'en', to: '__proto__' }),
    ).rejects.toThrow()
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('rejects a from === to translation', async () => {
    const post = await kernel.create({ collection: 'posts', data: { title: 'Hi' }, req: { locale: 'en' } })
    await expect(kernel.translateDocument({ collection: 'posts', id: post.id, from: 'es', to: 'es' })).rejects.toThrow()
  })

  it('does not write or leak when the provider throws', async () => {
    const FAKE_KEY = 'sk-secret-leak'
    const k = await makeKernel(async () => {
      throw new Error(`boom ${FAKE_KEY} for "Hello"`)
    })
    const post = await k.create({ collection: 'posts', data: { title: 'Hello' }, req: { locale: 'en' } })

    let message = ''
    try {
      await k.translateDocument({ collection: 'posts', id: post.id, from: 'en', to: 'es' })
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toMatch(/Translation provider failed/)
    expect(message).not.toContain(FAKE_KEY)
    expect(message).not.toContain('Hello')

    const es = await k.findByID({ collection: 'posts', id: post.id, req: { locale: 'es' } })
    expect(es?.title).toBeNull()
  })

  it('throws a generic error when the provider returns the wrong number of results', async () => {
    const k = await makeKernel(async () => ['only', 'one'])
    const post = await k.create({ collection: 'posts', data: { title: 'A', body: 'B' }, req: { locale: 'en' } })
    // 'A','B' (2 inputs) but provider returns 2 here — make a mismatch with a single field.
    const post2 = await k.create({ collection: 'posts', data: { title: 'Solo' }, req: { locale: 'en' } })
    await expect(k.translateDocument({ collection: 'posts', id: post2.id, from: 'en', to: 'es' })).rejects.toThrow(
      /unexpected result/,
    )
    void post
  })
})

describe('translateMissing', () => {
  it('fills docs missing the target locale, bounded by limit, reporting translated/skipped', async () => {
    const kernel = await makeKernel(passthrough)
    await kernel.create({ collection: 'posts', data: { title: 'One' }, req: { locale: 'en' } })
    await kernel.create({ collection: 'posts', data: { title: 'Two' }, req: { locale: 'en' } })
    await kernel.create({ collection: 'posts', data: { title: 'Three' }, req: { locale: 'en' } })

    const res = await kernel.translateMissing({ collection: 'posts', to: 'es', limit: 2 })
    expect(res.translated.length + res.skipped.length).toBeLessThanOrEqual(2)
    expect(res.translated.length).toBeGreaterThanOrEqual(1)

    const first = await kernel.findByID({ collection: 'posts', id: res.translated[0]!, req: { locale: 'es' } })
    expect(typeof first?.title).toBe('string')
    expect(first?.title as string).toMatch(/^\[es\] /)
  })

  it('skips docs that already have a complete target locale', async () => {
    const kernel = await makeKernel(passthrough)
    const post = await kernel.create({ collection: 'posts', data: { title: 'Done' }, req: { locale: 'en' } })
    await kernel.updateLocales({ collection: 'posts', id: post.id, locales: { es: { title: 'Hecho' } } })

    const res = await kernel.translateMissing({ collection: 'posts', to: 'es' })
    expect(res.translated).not.toContain(post.id)
    expect(res.skipped).toContain(post.id)
  })

  it('defaults the source locale to the configured default locale', async () => {
    const spy = vi.fn(passthrough)
    const kernel = await makeKernel(spy)
    await kernel.create({ collection: 'posts', data: { title: 'Hi' }, req: { locale: 'en' } })
    await kernel.translateMissing({ collection: 'posts', to: 'fr' })
    expect(spy.mock.calls.some((c) => c[0].from === 'en' && c[0].to === 'fr')).toBe(true)
  })
})

describe('translation config', () => {
  it('rejects config.translation without localization', async () => {
    await expect(
      initKernel(
        defineConfig({
          secret: 'test-secret-32-characters-long!!',
          db: sqliteAdapter({ url: ':memory:' }),
          translation: { translate: passthrough },
          collections: [{ slug: 'posts', fields: [{ name: 'title', type: 'text' }] }],
        }),
        { autoMigrate: true } as never,
      ),
    ).rejects.toThrow(/requires `localization`/)
  })

  it('rejects a non-function translate provider', async () => {
    await expect(
      initKernel(
        defineConfig({
          secret: 'test-secret-32-characters-long!!',
          db: sqliteAdapter({ url: ':memory:' }),
          localization: { locales: ['en', 'es'], defaultLocale: 'en' },
          translation: { translate: 'nope' as unknown as TranslateFn },
          collections: [{ slug: 'posts', fields: [{ name: 'title', type: 'text', localized: true }] }],
        }),
        { autoMigrate: true } as never,
      ),
    ).rejects.toThrow(/must be a function/)
  })

  it('throws a clean error when translation is not configured', async () => {
    const kernel = await initKernel(
      defineConfig({
        secret: 'test-secret-32-characters-long!!',
        db: sqliteAdapter({ url: ':memory:' }),
        localization: { locales: ['en', 'es'], defaultLocale: 'en' },
        collections: [
          {
            slug: 'posts',
            access: { read: () => true, create: () => true, update: () => true },
            fields: [{ name: 'title', type: 'text', localized: true, required: true }],
          },
        ],
      }),
      { autoMigrate: true } as never,
    )
    const post = await kernel.create({ collection: 'posts', data: { title: 'Hi' }, req: { locale: 'en' } })
    await expect(kernel.translateDocument({ collection: 'posts', id: post.id, from: 'en', to: 'es' })).rejects.toThrow(
      /Translation is not enabled/,
    )
  })
})
