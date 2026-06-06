# Caching

KernelCMS has an optional read-through cache. It sits in front of the database:
reads for opt-in collections are memoized, and any write to a collection drops
that collection's cached entries. It is off until you configure a cache adapter.

## Enable it

```ts
import { defineConfig, memoryCache } from 'kernelcms'
import { sqliteAdapter } from 'kernelcms/sqlite'

export default defineConfig({
  db: sqliteAdapter({ url: 'file:./content.db' }),
  cache: memoryCache(), // or dbCache() / redisCache()
  cacheDefaults: { ttl: 0 }, // ms; 0 = live until invalidated by a write
  collections: [
    {
      slug: 'posts',
      cache: true, // or { ttl: 60_000 } to override the default TTL
      fields: [{ name: 'title', type: 'text' }],
    },
  ],
})
```

Only collections with `cache` set are cached. Everything else (and the jobs
queue) reads straight from the database.

## Backends

- **`memoryCache()`** — in-process, single-node. Zero setup, great default for a
  single instance. LRU eviction (`maxEntries`, default 5000) plus TTL.
- **`dbCache()`** — stores entries in your own database (a reserved
  `kernel_cache` table is provisioned for you). No extra infrastructure: the
  database you already run is the cache. Survives restarts and is shared by every
  process pointed at the same database. Best when you do not want to run Redis.
- **`redisCache({ url })`** — a Redis backend for multi-node deployments. Reads
  `REDIS_URL` when no `url` is passed. Requires the optional `ioredis` package
  (`npm i ioredis`).

All three satisfy the same `CacheAdapter` contract and pass the same conformance
suite, so you can switch backends without touching collection config.

## How invalidation works

The cache keys a read by its full query, then tags the entry with the collection
slug. A `create`, `update`, or `delete` on that collection calls `deleteByTag`,
dropping every cached read for it. Inside a transaction, reads bypass the cache
(so they see uncommitted state) and the touched collections are invalidated once
the transaction commits.

This favours correctness over hit rate: a write always invalidates, so you never
serve stale data after a change.

## Safety model (important)

Caching happens at the **database read layer**, never at the access-decision
layer. The cache key includes the full query, and for non-trusted reads that
query already carries the access-merged `where` clause. So:

- Two users with different access scopes produce different queries, different
  keys, and never share a cache entry.
- Access control, field-level read stripping, and relationship population still
  run on every call. The cache only saves the round-trip to the database.

Because of this, the cache cannot leak a document to a viewer who would not
otherwise be allowed to read it.

**Auth collections are never cached**, even if you set `cache: true` on them.
Session invalidation (the token epoch) and TOTP replay defence depend on fresh
reads, so the cache deliberately excludes any collection with `auth`.

## Choosing a backend

| Backend       | Infra          | Scope       | Survives restart | Use when                           |
| ------------- | -------------- | ----------- | ---------------- | ---------------------------------- |
| `memoryCache` | none           | one process | no               | single instance, simplest setup    |
| `dbCache`     | none (your db) | shared db   | yes              | want sharing without running Redis |
| `redisCache`  | Redis          | multi-node  | yes              | horizontally scaled deployments    |

## Notes

- TTL is in milliseconds. `0` means an entry lives until a write invalidates it.
- `kernel.cache` exposes the adapter (e.g. `kernel.cache.stats()` for hit/miss
  counters). `connectorStatus(kernel)` and the admin Connectors panel report the
  configured cache kind.
- The cache is read-only acceleration: writes always hit the database first.
