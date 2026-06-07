import { afterEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { assertProductionSecret, initKernel, sanitizeConfig } from './index'

const db = () => sqliteAdapter({ url: ':memory:' })
const ok = 'a-sufficiently-long-secret-value'

const originalEnv = process.env.NODE_ENV
afterEach(() => {
  process.env.NODE_ENV = originalEnv
})

describe('production secret hardening (embed path)', () => {
  it('rejects a missing secret in production', () => {
    process.env.NODE_ENV = 'production'
    delete process.env.KERNEL_SECRET
    expect(() => sanitizeConfig({ db: db(), collections: [] })).toThrow(/secret/i)
  })

  it('rejects a weak (short) secret in production', () => {
    process.env.NODE_ENV = 'production'
    expect(() => sanitizeConfig({ secret: 'dev-only-secret', db: db(), collections: [] })).toThrow(/too short/i)
  })

  it('accepts a strong secret in production', () => {
    process.env.NODE_ENV = 'production'
    expect(() => sanitizeConfig({ secret: ok, db: db(), collections: [] })).not.toThrow()
  })

  it('allows a short secret outside production', () => {
    process.env.NODE_ENV = 'development'
    expect(() => sanitizeConfig({ secret: 'short', db: db(), collections: [] })).not.toThrow()
  })

  it('exposes assertProductionSecret as a reusable guard', () => {
    process.env.NODE_ENV = 'production'
    delete process.env.KERNEL_SECRET
    expect(() => assertProductionSecret({ secret: undefined })).toThrow(/secret/i)
    expect(() => assertProductionSecret({ secret: ok })).not.toThrow()
    process.env.NODE_ENV = 'development'
    expect(() => assertProductionSecret({ secret: undefined })).not.toThrow()
  })

  it('initKernel (the embed path) fails closed in production with no secret', async () => {
    process.env.NODE_ENV = 'production'
    delete process.env.KERNEL_SECRET
    await expect(initKernel({ db: db(), collections: [] })).rejects.toThrow(/secret/i)
  })
})

describe('naming validation', () => {
  it('validates global field names (not just the slug)', () => {
    expect(() =>
      sanitizeConfig({
        secret: ok,
        db: db(),
        collections: [],
        globals: [{ slug: 'site', fields: [{ name: 'siteTitle', type: 'text' }] }],
      }),
    ).toThrow(/site\.siteTitle/)
  })

  it('validates nested group/array fields inside a global', () => {
    expect(() =>
      sanitizeConfig({
        secret: ok,
        db: db(),
        collections: [],
        globals: [
          {
            slug: 'site',
            fields: [{ name: 'seo', type: 'group', fields: [{ name: 'metaTitle', type: 'text' }] }],
          },
        ],
      }),
    ).toThrow(/site\.seo\.metaTitle/)
  })

  it('reports a nested (group) field-name violation with its path', () => {
    expect(() =>
      sanitizeConfig({
        secret: ok,
        db: db(),
        collections: [
          {
            slug: 'posts',
            access: { read: () => true },
            fields: [{ name: 'meta', type: 'group', fields: [{ name: 'badName', type: 'text' }] }],
          },
        ],
      }),
    ).toThrow(/posts\.meta\.badName/)
  })

  it('reports every violation in one error', () => {
    let message = ''
    try {
      sanitizeConfig({
        secret: ok,
        db: db(),
        collections: [{ slug: 'Posts', access: { read: () => true }, fields: [{ name: 'badOne', type: 'text' }] }],
        globals: [{ slug: 'siteSettings', fields: [{ name: 'okName', type: 'text' }] }],
      })
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    // Collection slug + its bad field + the global slug all listed together.
    expect(message).toMatch(/Posts/)
    expect(message).toMatch(/badOne/)
    expect(message).toMatch(/siteSettings/)
  })

  it('passes a fully snake_case config', () => {
    expect(() =>
      sanitizeConfig({
        secret: ok,
        db: db(),
        collections: [{ slug: 'posts', access: { read: () => true }, fields: [{ name: 'title', type: 'text' }] }],
        globals: [{ slug: 'site_settings', fields: [{ name: 'site_title', type: 'text' }] }],
      }),
    ).not.toThrow()
  })
})
