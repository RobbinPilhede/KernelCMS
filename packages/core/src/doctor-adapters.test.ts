import { describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { memoryStorage, localStorage } from '@kernel/storage'
import { memoryCache, memorySearch, runDoctor, sanitizeConfig } from './index'

const codes = (cfg: Parameters<typeof sanitizeConfig>[0]) =>
  runDoctor(sanitizeConfig(cfg)).diagnostics.map((d) => d.code)

const codesIn = (env: string, cfg: Parameters<typeof sanitizeConfig>[0]) =>
  runDoctor(sanitizeConfig(cfg), { env }).diagnostics

describe('doctor: cache/search/webhook diagnostics', () => {
  it('warns when a collection sets cache but no adapter is configured', () => {
    const c = codes({
      secret: 'x'.repeat(20),
      db: sqliteAdapter({ url: ':memory:' }),
      collections: [{ slug: 'posts', cache: true, access: { read: () => true }, fields: [] }],
    })
    expect(c).toContain('cache-no-adapter')
  })

  it('warns when a cache adapter is configured but unused', () => {
    const c = codes({
      secret: 'x'.repeat(20),
      db: sqliteAdapter({ url: ':memory:' }),
      cache: memoryCache(),
      collections: [{ slug: 'posts', access: { read: () => true }, fields: [] }],
    })
    expect(c).toContain('cache-unused')
  })

  it('warns when a collection sets search but no adapter is configured', () => {
    const c = codes({
      secret: 'x'.repeat(20),
      db: sqliteAdapter({ url: ':memory:' }),
      collections: [
        {
          slug: 'posts',
          search: { fields: ['title'] },
          access: { read: () => true },
          fields: [{ name: 'title', type: 'text' }],
        },
      ],
    })
    expect(c).toContain('search-no-adapter')
  })

  it('flags plaintext and unsigned webhooks', () => {
    const c = codes({
      secret: 'x'.repeat(20),
      db: sqliteAdapter({ url: ':memory:' }),
      webhooks: [{ url: 'http://insecure.example/hook' }],
      collections: [{ slug: 'posts', access: { read: () => true }, fields: [] }],
    })
    expect(c).toContain('webhook-insecure')
    expect(c).toContain('webhook-unsigned')
  })

  it('warns that in-memory upload storage is ephemeral', () => {
    const c = codes({
      secret: 'x'.repeat(20),
      db: sqliteAdapter({ url: ':memory:' }),
      storage: memoryStorage(),
      collections: [{ slug: 'media', upload: true, access: { read: () => true }, fields: [] }],
    })
    expect(c).toContain('ephemeral-storage')
  })

  it('escalates ephemeral upload storage to an error in production', () => {
    const diags = codesIn('production', {
      secret: 'x'.repeat(20),
      db: sqliteAdapter({ url: ':memory:' }),
      storage: memoryStorage(),
      collections: [{ slug: 'media', upload: true, access: { read: () => true }, fields: [] }],
    })
    const ephemeral = diags.find((d) => d.code === 'ephemeral-storage')
    expect(ephemeral?.level).toBe('error')
  })

  it('does not flag durable storage (localStorage) as ephemeral', () => {
    const c = codes({
      secret: 'x'.repeat(20),
      db: sqliteAdapter({ url: ':memory:' }),
      storage: localStorage({ rootDir: './.uploads' }),
      collections: [{ slug: 'media', upload: true, access: { read: () => true }, fields: [] }],
    })
    expect(c).not.toContain('ephemeral-storage')
  })

  it('is quiet when everything is wired correctly', () => {
    const c = codes({
      secret: 'x'.repeat(20),
      db: sqliteAdapter({ url: ':memory:' }),
      cache: memoryCache(),
      search: memorySearch(),
      webhooks: [{ url: 'https://secure.example/hook', secret: 'shh' }],
      collections: [
        {
          slug: 'posts',
          cache: true,
          search: { fields: ['title'] },
          auth: false,
          access: { read: () => true },
          fields: [{ name: 'title', type: 'text' }],
        },
        { slug: 'users', auth: true, access: { read: () => true }, fields: [] },
      ],
    })
    expect(c).not.toContain('cache-no-adapter')
    expect(c).not.toContain('cache-unused')
    expect(c).not.toContain('search-no-adapter')
    expect(c).not.toContain('search-unused')
    expect(c).not.toContain('webhook-insecure')
  })
})
