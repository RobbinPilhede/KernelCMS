import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CacheAdapter,
  DatabaseAdapter,
  DatabaseCapabilities,
  FindArgs,
  MigrationReport,
  PaginatedResult,
  Row,
  Where,
} from '@kernel/db'
import { createCachedDb, memoryCache } from './cache'

// ---------------------------------------------------------------------------
// Shared conformance suite — any CacheAdapter must satisfy this.
// ---------------------------------------------------------------------------

export function cacheConformance(name: string, make: () => CacheAdapter): void {
  describe(`cache conformance: ${name}`, () => {
    let cache: CacheAdapter
    beforeEach(async () => {
      cache = make()
      await cache.init({ logger: { debug() {}, info() {}, warn() {}, error() {} } })
    })
    afterEach(async () => {
      await cache.destroy()
    })

    it('returns undefined on a miss', async () => {
      expect(await cache.get('nope')).toBeUndefined()
    })

    it('stores and resolves a value', async () => {
      await cache.set('k', { a: 1 })
      expect(await cache.get('k')).toEqual({ a: 1 })
    })

    it('overwrites an existing key', async () => {
      await cache.set('k', 1)
      await cache.set('k', 2)
      expect(await cache.get('k')).toBe(2)
    })

    it('deletes a single key', async () => {
      await cache.set('k', 1)
      await cache.delete('k')
      expect(await cache.get('k')).toBeUndefined()
    })

    it('invalidates every key under a tag', async () => {
      await cache.set('a', 1, { tags: ['posts'] })
      await cache.set('b', 2, { tags: ['posts'] })
      await cache.set('c', 3, { tags: ['users'] })
      await cache.deleteByTag('posts')
      expect(await cache.get('a')).toBeUndefined()
      expect(await cache.get('b')).toBeUndefined()
      expect(await cache.get('c')).toBe(3)
    })

    it('clears everything', async () => {
      await cache.set('a', 1)
      await cache.set('b', 2)
      await cache.clear()
      expect(await cache.get('a')).toBeUndefined()
      expect(await cache.get('b')).toBeUndefined()
    })

    it('expires entries after their TTL', async () => {
      vi.useFakeTimers()
      try {
        await cache.set('k', 1, { ttlMs: 1000 })
        expect(await cache.get('k')).toBe(1)
        vi.advanceTimersByTime(1001)
        expect(await cache.get('k')).toBeUndefined()
      } finally {
        vi.useRealTimers()
      }
    })
  })
}

cacheConformance('memory', () => memoryCache())

describe('memoryCache specifics', () => {
  it('evicts the oldest entry past maxEntries', async () => {
    const cache = memoryCache({ maxEntries: 2 })
    await cache.set('a', 1)
    await cache.set('b', 2)
    await cache.set('c', 3) // evicts 'a'
    expect(await cache.get('a')).toBeUndefined()
    expect(await cache.get('b')).toBe(2)
    expect(await cache.get('c')).toBe(3)
  })

  it('counts hits and misses', async () => {
    const cache = memoryCache()
    await cache.set('a', 1)
    await cache.get('a')
    await cache.get('missing')
    const s = cache.stats()
    expect(s.hits).toBe(1)
    expect(s.misses).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Read-through wrapper integration — backed by a counting fake adapter.
// ---------------------------------------------------------------------------

function emptyPage(): PaginatedResult<Row> {
  return {
    docs: [],
    totalDocs: 0,
    limit: 10,
    page: 1,
    totalPages: 0,
    hasNextPage: false,
    hasPrevPage: false,
    prevPage: null,
    nextPage: null,
    pagingCounter: 0,
  }
}

interface Counts {
  find: number
  findByID: number
  count: number
}

function fakeDb(counts: Counts): DatabaseAdapter {
  const caps: DatabaseCapabilities = {
    transactions: true,
    joins: 'application',
    jsonQuery: false,
    fullTextSearch: false,
    returning: true,
  }
  const self: DatabaseAdapter = {
    kind: 'db',
    name: 'fake',
    contractVersion: '1.0',
    capabilities: caps,
    async init() {},
    async health() {
      return { status: 'ok' }
    },
    async destroy() {},
    async migrate(): Promise<MigrationReport> {
      return { createdTables: [], addedColumns: [], statements: [] }
    },
    async find(args: FindArgs) {
      counts.find++
      return { ...emptyPage(), docs: [{ id: '1', q: JSON.stringify(args.where ?? null) }] }
    },
    async findByID(args) {
      counts.findByID++
      return { id: args.id, n: counts.findByID }
    },
    async create(args) {
      return { id: 'new', ...args.data }
    },
    async update(args) {
      return { id: args.id, ...args.data }
    },
    async delete(args) {
      return { id: args.id }
    },
    async count(_args: { collection: string; where?: Where }) {
      counts.count++
      return 0
    },
    async transaction(fn) {
      return fn(self)
    },
  }
  return self
}

describe('createCachedDb read-through', () => {
  it('serves a repeat findByID from cache (one db call)', async () => {
    const counts: Counts = { find: 0, findByID: 0, count: 0 }
    const db = createCachedDb(fakeDb(counts), memoryCache(), { cacheableSlugs: new Set(['posts']) })
    const a = await db.findByID({ collection: 'posts', id: '1' })
    const b = await db.findByID({ collection: 'posts', id: '1' })
    expect(a).toEqual(b)
    expect(counts.findByID).toBe(1)
  })

  it('does not cache collections that did not opt in', async () => {
    const counts: Counts = { find: 0, findByID: 0, count: 0 }
    const db = createCachedDb(fakeDb(counts), memoryCache(), { cacheableSlugs: new Set(['posts']) })
    await db.findByID({ collection: 'users', id: '1' })
    await db.findByID({ collection: 'users', id: '1' })
    expect(counts.findByID).toBe(2)
  })

  it('invalidates the collection on write', async () => {
    const counts: Counts = { find: 0, findByID: 0, count: 0 }
    const db = createCachedDb(fakeDb(counts), memoryCache(), { cacheableSlugs: new Set(['posts']) })
    await db.findByID({ collection: 'posts', id: '1' })
    await db.update({ collection: 'posts', id: '1', data: { title: 'x' } })
    await db.findByID({ collection: 'posts', id: '1' })
    expect(counts.findByID).toBe(2)
  })

  it('keys reads by query, so different access scopes never share an entry', async () => {
    const counts: Counts = { find: 0, findByID: 0, count: 0 }
    const db = createCachedDb(fakeDb(counts), memoryCache(), { cacheableSlugs: new Set(['posts']) })
    // Two readers with different access-merged where clauses.
    await db.find({ collection: 'posts', where: { owner: { equals: 'u1' } }, limit: 10, page: 1 })
    await db.find({ collection: 'posts', where: { owner: { equals: 'u2' } }, limit: 10, page: 1 })
    // Distinct queries -> distinct keys -> two real db calls (no cross-viewer leak).
    expect(counts.find).toBe(2)
    // ...and each is independently cached on repeat.
    await db.find({ collection: 'posts', where: { owner: { equals: 'u1' } }, limit: 10, page: 1 })
    expect(counts.find).toBe(2)
  })

  it('invalidates touched collections after a transaction commits', async () => {
    const counts: Counts = { find: 0, findByID: 0, count: 0 }
    const db = createCachedDb(fakeDb(counts), memoryCache(), { cacheableSlugs: new Set(['posts']) })
    await db.findByID({ collection: 'posts', id: '1' })
    await db.transaction(async (tx) => {
      await tx.update({ collection: 'posts', id: '1', data: { title: 'y' } })
    })
    await db.findByID({ collection: 'posts', id: '1' })
    expect(counts.findByID).toBe(2)
  })
})
