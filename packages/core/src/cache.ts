/**
 * Caching: a default in-memory `CacheAdapter` and a read-through wrapper that
 * memoizes database reads and invalidates by collection on writes.
 *
 * Safety model: the wrapper caches at the database read layer. The cache key
 * includes the full query (which, for non-trusted reads, already carries the
 * access-merged `where`), so entries are never shared across viewers with
 * different access scopes. Access control, field stripping, and populate still
 * run on every call in `@kernel/core` operations — the cache only saves the
 * round-trip to the database. Writes to a collection drop that collection's tag.
 */
import type {
  AdapterContext,
  CacheAdapter,
  CacheSetOptions,
  CacheStats,
  DatabaseAdapter,
  FindArgs,
  HealthStatus,
  PaginatedResult,
  Row,
  Where,
} from '@kernel/db'

const CACHE_CONTRACT_VERSION = '1.0' as const

interface Entry {
  value: unknown
  /** Epoch ms when this entry expires, or 0 for no expiry. */
  expiresAt: number
  tags: string[]
}

export interface MemoryCacheOptions {
  /** Hard cap on entries; oldest are evicted first (LRU on access). Default 5000. */
  maxEntries?: number
  /** Default TTL applied when `set` is called without one. Default 0 (no expiry). */
  defaultTtlMs?: number
}

/**
 * In-memory cache. Per-process and single-node by design — adequate for one
 * instance; use `redisCache`/`dbCache` for multi-node. Backed by a Map (which
 * preserves insertion order) for a simple LRU.
 */
export function memoryCache(options: MemoryCacheOptions = {}): CacheAdapter {
  const maxEntries = Math.max(1, options.maxEntries ?? 5000)
  const defaultTtlMs = options.defaultTtlMs ?? 0
  const store = new Map<string, Entry>()
  // tag -> set of keys carrying that tag, for O(1) grouped invalidation.
  const tagIndex = new Map<string, Set<string>>()
  let hits = 0
  let misses = 0
  let evictions = 0

  function indexTags(key: string, tags: string[]): void {
    for (const tag of tags) {
      let set = tagIndex.get(tag)
      if (!set) {
        set = new Set()
        tagIndex.set(tag, set)
      }
      set.add(key)
    }
  }

  function deindex(key: string, tags: string[]): void {
    for (const tag of tags) {
      const set = tagIndex.get(tag)
      if (!set) continue
      set.delete(key)
      if (set.size === 0) tagIndex.delete(tag)
    }
  }

  function drop(key: string): void {
    const entry = store.get(key)
    if (!entry) return
    store.delete(key)
    deindex(key, entry.tags)
  }

  function isExpired(entry: Entry): boolean {
    return entry.expiresAt !== 0 && entry.expiresAt <= Date.now()
  }

  return {
    kind: 'cache',
    name: 'memory',
    contractVersion: CACHE_CONTRACT_VERSION,
    async init(_ctx: AdapterContext): Promise<void> {},
    async health(): Promise<HealthStatus> {
      return { status: 'ok', detail: `${store.size} entries` }
    },
    async destroy(): Promise<void> {
      store.clear()
      tagIndex.clear()
    },
    async get<T = unknown>(key: string): Promise<T | undefined> {
      const entry = store.get(key)
      if (!entry) {
        misses++
        return undefined
      }
      if (isExpired(entry)) {
        drop(key)
        misses++
        return undefined
      }
      // LRU touch: re-insert to move to the most-recent end.
      store.delete(key)
      store.set(key, entry)
      hits++
      return entry.value as T
    },
    async set(key: string, value: unknown, opts?: CacheSetOptions): Promise<void> {
      // Replacing an existing key: clear its old tag links first.
      const prev = store.get(key)
      if (prev) deindex(key, prev.tags)
      const ttl = opts?.ttlMs ?? defaultTtlMs
      const tags = opts?.tags ?? []
      store.set(key, { value, expiresAt: ttl > 0 ? Date.now() + ttl : 0, tags })
      indexTags(key, tags)
      // Evict oldest while over the cap.
      while (store.size > maxEntries) {
        const oldest = store.keys().next().value
        if (oldest === undefined) break
        drop(oldest)
        evictions++
      }
    },
    async delete(key: string): Promise<void> {
      drop(key)
    },
    async deleteByTag(tag: string): Promise<void> {
      const set = tagIndex.get(tag)
      if (!set) return
      for (const key of [...set]) drop(key)
    },
    async clear(): Promise<void> {
      store.clear()
      tagIndex.clear()
    },
    stats(): CacheStats {
      return { hits, misses, evictions, size: store.size }
    },
  }
}

// ---------------------------------------------------------------------------
// Read-through database wrapper
// ---------------------------------------------------------------------------

/** Deterministic JSON: object keys sorted recursively, so equal queries hash equal. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

export interface CachedDbOptions {
  /** Only these collection slugs are cached; everything else passes through. */
  cacheableSlugs: ReadonlySet<string>
  /** Default TTL (ms) per cached read. */
  ttlMs?: number
  /** Per-slug TTL override. */
  ttlBySlug?: Readonly<Record<string, number>>
}

/**
 * Wrap a `DatabaseAdapter` with a read-through cache. find/findByID/count for
 * opt-in collections are memoized; create/update/delete invalidate the affected
 * collection's tag. Reads inside a transaction bypass the cache (to see
 * uncommitted state) and the touched collections are invalidated after commit.
 */
export function createCachedDb(db: DatabaseAdapter, cache: CacheAdapter, opts: CachedDbOptions): DatabaseAdapter {
  const { cacheableSlugs } = opts
  const ttlFor = (slug: string): number => opts.ttlBySlug?.[slug] ?? opts.ttlMs ?? 0
  const cacheable = (slug: string): boolean => cacheableSlugs.has(slug)
  const keyFor = (op: string, slug: string, args: unknown): string => `db:${op}:${slug}:${stableStringify(args)}`

  async function readThrough<T>(op: string, slug: string, args: unknown, run: () => Promise<T>): Promise<T> {
    if (!cacheable(slug)) return run()
    const key = keyFor(op, slug, args)
    const hit = await cache.get<T>(key)
    if (hit !== undefined) return hit
    const value = await run()
    // Do not cache a null/absent findByID forever; still useful, short-circuit with the same TTL.
    await cache.set(key, value, { ttlMs: ttlFor(slug), tags: [slug] })
    return value
  }

  const wrapped: DatabaseAdapter = {
    kind: 'db',
    get name() {
      return db.name
    },
    get contractVersion() {
      return db.contractVersion
    },
    get capabilities() {
      return db.capabilities
    },
    init: (ctx) => db.init(ctx),
    health: () => db.health(),
    destroy: () => db.destroy(),
    ...(db.register ? { register: (schema) => db.register!(schema) } : {}),
    migrate: (schema, opts) => db.migrate(schema, opts),
    ...(db.rollback ? { rollback: (entries, opts) => db.rollback!(entries, opts) } : {}),

    find: (args: FindArgs): Promise<PaginatedResult<Row>> =>
      readThrough(
        'find',
        args.collection,
        { where: args.where, sort: args.sort, limit: args.limit, page: args.page },
        () => db.find(args),
      ),
    findByID: (args) => readThrough('findByID', args.collection, { id: args.id }, () => db.findByID(args)),
    count: (args: { collection: string; where?: Where }) =>
      readThrough('count', args.collection, { where: args.where }, () => db.count(args)),

    async create(args) {
      const row = await db.create(args)
      if (cacheable(args.collection)) await cache.deleteByTag(args.collection)
      return row
    },
    async update(args) {
      const row = await db.update(args)
      if (cacheable(args.collection)) await cache.deleteByTag(args.collection)
      return row
    },
    async delete(args) {
      const row = await db.delete(args)
      if (cacheable(args.collection)) await cache.deleteByTag(args.collection)
      return row
    },

    async transaction<R>(fn: (tx: DatabaseAdapter) => Promise<R>): Promise<R> {
      const touched = new Set<string>()
      const result = await db.transaction(async (tx) => {
        // Inside a transaction: reads must see uncommitted writes, so bypass the
        // cache entirely; record touched collections for post-commit invalidation.
        const txTracker: DatabaseAdapter = {
          ...tx,
          kind: 'db',
          find: (a) => tx.find(a),
          findByID: (a) => tx.findByID(a),
          count: (a) => tx.count(a),
          async create(a) {
            touched.add(a.collection)
            return tx.create(a)
          },
          async update(a) {
            touched.add(a.collection)
            return tx.update(a)
          },
          async delete(a) {
            touched.add(a.collection)
            return tx.delete(a)
          },
          transaction: (inner) => tx.transaction(inner),
        }
        return fn(txTracker)
      })
      for (const slug of touched) if (cacheable(slug)) await cache.deleteByTag(slug)
      return result
    },
  }
  return wrapped
}
