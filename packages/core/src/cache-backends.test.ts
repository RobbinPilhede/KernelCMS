import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import type { Kernel } from './index'
import { dbCache, initKernel } from './index'

// dbCache stores entries in the kernel's own database. We boot a real kernel so
// the reserved cache table is provisioned and the adapter receives the db.
describe('dbCache (database-backed)', () => {
  let kernel: Kernel

  beforeEach(async () => {
    kernel = await initKernel(
      {
        secret: 'dbcache-test',
        db: sqliteAdapter({ url: ':memory:' }),
        cache: dbCache(),
        collections: [
          {
            slug: 'posts',
            cache: true,
            access: { read: () => true, create: () => true, update: () => true },
            fields: [{ name: 'title', type: 'text' }],
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

  it('stores and resolves a value', async () => {
    await kernel.cache!.set('k', { a: 1 })
    expect(await kernel.cache!.get('k')).toEqual({ a: 1 })
  })

  it('overwrites and deletes', async () => {
    await kernel.cache!.set('k', 1)
    await kernel.cache!.set('k', 2)
    expect(await kernel.cache!.get('k')).toBe(2)
    await kernel.cache!.delete('k')
    expect(await kernel.cache!.get('k')).toBeUndefined()
  })

  it('invalidates by tag', async () => {
    await kernel.cache!.set('a', 1, { tags: ['posts'] })
    await kernel.cache!.set('b', 2, { tags: ['posts'] })
    await kernel.cache!.set('c', 3, { tags: ['users'] })
    await kernel.cache!.deleteByTag('posts')
    expect(await kernel.cache!.get('a')).toBeUndefined()
    expect(await kernel.cache!.get('b')).toBeUndefined()
    expect(await kernel.cache!.get('c')).toBe(3)
  })

  it('expires entries after their TTL', async () => {
    vi.useFakeTimers()
    try {
      await kernel.cache!.set('k', 1, { ttlMs: 1000 })
      expect(await kernel.cache!.get('k')).toBe(1)
      vi.advanceTimersByTime(1001)
      expect(await kernel.cache!.get('k')).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears everything', async () => {
    await kernel.cache!.set('a', 1)
    await kernel.cache!.set('b', 2)
    await kernel.cache!.clear()
    expect(await kernel.cache!.get('a')).toBeUndefined()
    expect(await kernel.cache!.get('b')).toBeUndefined()
  })

  it('serves reads through the database cache and invalidates on write', async () => {
    const created = await kernel.create<{ id: string; title: string }>({
      collection: 'posts',
      data: { title: 'v1' },
      overrideAccess: true,
    })
    await kernel.findByID({ collection: 'posts', id: created.id, overrideAccess: true })
    const before = kernel.cache!.stats().hits
    await kernel.findByID({ collection: 'posts', id: created.id, overrideAccess: true })
    expect(kernel.cache!.stats().hits).toBeGreaterThan(before)

    await kernel.update({ collection: 'posts', id: created.id, data: { title: 'v2' }, overrideAccess: true })
    const after = await kernel.findByID<{ id: string; title: string }>({
      collection: 'posts',
      id: created.id,
      overrideAccess: true,
    })
    expect(after?.title).toBe('v2')
  })
})
