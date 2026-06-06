/**
 * Additional cache backends beyond the in-memory default.
 *
 * - `dbCache()`  — stores entries in the kernel's own database (a reserved
 *   `kernel_cache` table). No extra infrastructure: the database you already run
 *   is the cache. Survives restarts; shared across processes that share the db.
 * - `redisCache()` — a Redis backend for multi-node deployments (lazy-loads the
 *   optional `ioredis` dependency).
 */
import type { AdapterContext, CacheAdapter, CacheSetOptions, CacheStats, DatabaseAdapter, Row } from '@kernel/db'
import { CACHE_SLUG } from './config'

const CACHE_CONTRACT_VERSION = '1.0' as const

function tagsToCsv(tags: string[]): string {
  if (tags.length === 0) return ''
  return `,${tags.join(',')},`
}

// ---------------------------------------------------------------------------
// Database-backed cache
// ---------------------------------------------------------------------------

export interface DbCacheOptions {
  /** Default TTL (ms) when `set` is called without one. Default 0 (no expiry). */
  defaultTtlMs?: number
}

/**
 * A cache stored in the kernel's database. Requires no extra services. The
 * kernel injects a reserved `kernel_cache` table and passes the db to `init`.
 * Invalidation by tag scans rows whose comma-delimited tag list contains the
 * tag; cache tables stay small, but for very high write rates prefer `redisCache`.
 */
export function dbCache(options: DbCacheOptions = {}): CacheAdapter {
  const defaultTtlMs = options.defaultTtlMs ?? 0
  let db: DatabaseAdapter | null = null
  let hits = 0
  let misses = 0
  const evictions = 0

  const requireDb = (): DatabaseAdapter => {
    if (!db) throw new Error('[KernelCMS] dbCache was not initialized with a database.')
    return db
  }
  const now = (): number => Date.now()

  const adapter: CacheAdapter & { __needsTable: string } = {
    kind: 'cache',
    name: 'database',
    contractVersion: CACHE_CONTRACT_VERSION,
    __needsTable: CACHE_SLUG,
    async init(ctx: AdapterContext): Promise<void> {
      if (!ctx.db) throw new Error('[KernelCMS] dbCache requires the kernel database (ctx.db).')
      db = ctx.db
    },
    async health() {
      return { status: 'ok' as const }
    },
    async destroy(): Promise<void> {
      db = null
    },
    async get<T = unknown>(key: string): Promise<T | undefined> {
      const row = await requireDb().findByID({ collection: CACHE_SLUG, id: key })
      if (!row) {
        misses++
        return undefined
      }
      const expiresAt = Number(row.expires_at ?? 0)
      if (expiresAt > 0 && expiresAt <= now()) {
        await requireDb().delete({ collection: CACHE_SLUG, id: key })
        misses++
        return undefined
      }
      hits++
      return row.value as T
    },
    async set(key: string, value: unknown, opts?: CacheSetOptions): Promise<void> {
      const ttl = opts?.ttlMs ?? defaultTtlMs
      const data: Row = {
        value,
        expires_at: ttl > 0 ? now() + ttl : 0,
        tags_csv: tagsToCsv(opts?.tags ?? []),
      }
      const existing = await requireDb().findByID({ collection: CACHE_SLUG, id: key })
      if (existing) await requireDb().update({ collection: CACHE_SLUG, id: key, data })
      else await requireDb().create({ collection: CACHE_SLUG, data: { id: key, ...data } })
    },
    async delete(key: string): Promise<void> {
      await requireDb().delete({ collection: CACHE_SLUG, id: key })
    },
    async deleteByTag(tag: string): Promise<void> {
      const matches = await requireDb().find({
        collection: CACHE_SLUG,
        where: { tags_csv: { contains: `,${tag},` } },
        limit: 100_000,
        page: 1,
      })
      for (const row of matches.docs) await requireDb().delete({ collection: CACHE_SLUG, id: String(row.id) })
    },
    async clear(): Promise<void> {
      // Page through and delete; the cache table is bounded.
      for (;;) {
        const page = await requireDb().find({ collection: CACHE_SLUG, limit: 1000, page: 1 })
        if (page.docs.length === 0) break
        for (const row of page.docs) await requireDb().delete({ collection: CACHE_SLUG, id: String(row.id) })
        if (page.docs.length < 1000) break
      }
    },
    stats(): CacheStats {
      return { hits, misses, evictions }
    },
  }
  return adapter
}

// ---------------------------------------------------------------------------
// Redis-backed cache
// ---------------------------------------------------------------------------

export interface RedisCacheOptions {
  /** Redis connection string, e.g. redis://localhost:6379. Defaults to REDIS_URL. */
  url?: string
  /** Key prefix isolating this cache in a shared Redis. Default "kc:". */
  prefix?: string
  /** Default TTL (ms) when `set` is called without one. Default 0 (no expiry). */
  defaultTtlMs?: number
}

// Minimal structural type for the slice of ioredis we use (avoids a hard dep type).
interface RedisLike {
  get(key: string): Promise<string | null>
  set(key: string, value: string, mode?: string, ttl?: number): Promise<unknown>
  del(...keys: string[]): Promise<number>
  sadd(key: string, ...members: string[]): Promise<number>
  smembers(key: string): Promise<string[]>
  scan(cursor: string, ...args: (string | number)[]): Promise<[string, string[]]>
  quit(): Promise<unknown>
}

/**
 * A Redis-backed cache for multi-node deployments. Lazy-loads `ioredis` (declare
 * it as a dependency in your project). Tags are tracked as Redis sets so
 * `deleteByTag` can drop every key in a group.
 */
export function redisCache(options: RedisCacheOptions = {}): CacheAdapter {
  const prefix = options.prefix ?? 'kc:'
  const defaultTtlMs = options.defaultTtlMs ?? 0
  let client: RedisLike | null = null
  let hits = 0
  let misses = 0
  const evictions = 0

  const k = (key: string): string => `${prefix}${key}`
  const tagKey = (tag: string): string => `${prefix}tag:${tag}`
  const require = (): RedisLike => {
    if (!client) throw new Error('[KernelCMS] redisCache was not initialized.')
    return client
  }

  return {
    kind: 'cache',
    name: 'redis',
    contractVersion: CACHE_CONTRACT_VERSION,
    async init(_ctx: AdapterContext): Promise<void> {
      const url = options.url ?? process.env.REDIS_URL
      if (!url) throw new Error('[KernelCMS] redisCache needs a url (or REDIS_URL).')
      let Redis: new (url: string) => RedisLike
      try {
        // Computed specifier so the optional dependency is resolved only at runtime
        // (it is not a build/typecheck dependency of KernelCMS).
        const specifier = 'ioredis'
        const mod = (await import(specifier)) as unknown as { default: new (url: string) => RedisLike }
        Redis = mod.default
      } catch {
        throw new Error('[KernelCMS] redisCache requires the "ioredis" package. Install it: npm i ioredis')
      }
      client = new Redis(url)
    },
    async health() {
      return { status: client ? ('ok' as const) : ('down' as const) }
    },
    async destroy(): Promise<void> {
      if (client) await client.quit()
      client = null
    },
    async get<T = unknown>(key: string): Promise<T | undefined> {
      const raw = await require().get(k(key))
      if (raw == null) {
        misses++
        return undefined
      }
      hits++
      return JSON.parse(raw) as T
    },
    async set(key: string, value: unknown, opts?: CacheSetOptions): Promise<void> {
      const ttl = opts?.ttlMs ?? defaultTtlMs
      const payload = JSON.stringify(value)
      if (ttl > 0) await require().set(k(key), payload, 'PX', ttl)
      else await require().set(k(key), payload)
      for (const tag of opts?.tags ?? []) await require().sadd(tagKey(tag), k(key))
    },
    async delete(key: string): Promise<void> {
      await require().del(k(key))
    },
    async deleteByTag(tag: string): Promise<void> {
      const members = await require().smembers(tagKey(tag))
      if (members.length > 0) await require().del(...members)
      await require().del(tagKey(tag))
    },
    async clear(): Promise<void> {
      let cursor = '0'
      do {
        const [next, keys] = await require().scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500)
        cursor = next
        if (keys.length > 0) await require().del(...keys)
      } while (cursor !== '0')
    },
    stats(): CacheStats {
      return { hits, misses, evictions }
    },
  }
}
