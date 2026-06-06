import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import type { CacheAdapter, Kernel } from './index'
import { initKernel, memoryCache } from './index'

describe('cache wired through a real kernel', () => {
  let kernel: Kernel
  let cache: CacheAdapter

  beforeEach(async () => {
    cache = memoryCache()
    kernel = await initKernel(
      {
        secret: 'cache-int-test',
        db: sqliteAdapter({ url: ':memory:' }),
        cache,
        collections: [
          {
            slug: 'posts',
            cache: true,
            access: { read: () => true, create: () => true, update: () => true, delete: () => true },
            fields: [{ name: 'title', type: 'text' }],
          },
          {
            slug: 'notes',
            access: { read: () => true, create: () => true },
            fields: [{ name: 'body', type: 'text' }],
          },
        ],
      },
      { logLevel: 'error' },
    )
    await kernel.migrate()
  })

  afterEach(async () => {
    await kernel.destroy()
  })

  it('exposes the cache adapter', () => {
    expect(kernel.cache).toBe(cache)
  })

  it('serves a repeated read from cache (hit recorded)', async () => {
    const created = await kernel.create({ collection: 'posts', data: { title: 'hello' }, overrideAccess: true })
    await kernel.findByID({ collection: 'posts', id: created.id, overrideAccess: true })
    const before = cache.stats().hits
    await kernel.findByID({ collection: 'posts', id: created.id, overrideAccess: true })
    expect(cache.stats().hits).toBeGreaterThan(before)
  })

  it('returns fresh data after an update (invalidation)', async () => {
    const created = await kernel.create({ collection: 'posts', data: { title: 'v1' }, overrideAccess: true })
    await kernel.findByID({ collection: 'posts', id: created.id, overrideAccess: true })
    await kernel.update({ collection: 'posts', id: created.id, data: { title: 'v2' }, overrideAccess: true })
    const after = await kernel.findByID<{ id: string; title: string }>({
      collection: 'posts',
      id: created.id,
      overrideAccess: true,
    })
    expect(after?.title).toBe('v2')
  })

  it('never caches auth collections, even when opted in', async () => {
    const c = memoryCache()
    const k = await initKernel(
      {
        secret: 'cache-auth-test',
        db: sqliteAdapter({ url: ':memory:' }),
        cache: c,
        collections: [
          {
            slug: 'admins',
            auth: true,
            cache: true, // requested, but auth collections are excluded for safety
            access: { read: () => true, create: () => true },
            fields: [{ name: 'name', type: 'text' }],
          },
          {
            slug: 'articles',
            cache: true,
            access: { read: () => true },
            fields: [{ name: 'title', type: 'text' }],
          },
        ],
      },
      { logLevel: 'error' },
    )
    expect(k.config.cacheableSlugs).toContain('articles')
    expect(k.config.cacheableSlugs).not.toContain('admins')
    await k.destroy()
  })

  it('does not cache collections that did not opt in', async () => {
    const created = await kernel.create({ collection: 'notes', data: { body: 'x' }, overrideAccess: true })
    const before = cache.stats().hits
    await kernel.findByID({ collection: 'notes', id: created.id, overrideAccess: true })
    await kernel.findByID({ collection: 'notes', id: created.id, overrideAccess: true })
    expect(cache.stats().hits).toBe(before)
  })
})
