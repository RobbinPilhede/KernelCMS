# KernelCMS — Autonomous Build Plan (overnight, 6h+)

Source of truth for the autonomous run. Check items off as they ship. Commit per phase.
Re-evaluate at the end of every track and append new tracks (§Z). Never stop while work remains.

Principles: production-grade, no AI fingerprints, zero em-dashes, security gate (Saga+Loki)
on anything touching access/auth/input. Each phase ends green: typecheck + lint + prettier +
unit + e2e, then commit + push. Admin changes require rebuild + embed.

Design note (cache safety): cache at the **DB read layer** (memoize find/findByID/count by
args; args already include the access-merged `where`), invalidate by collection tag on writes.
Access control + field strip still run every call. Never cache post-access docs across viewers.

---

## TRACK A — Caching layer (fills the declared `'cache'` adapter slot)

### A1. Contract
- [ ] A1.1 Add `CacheAdapter` interface to `@kernel/db` (kind:'cache', get/set/delete/deleteByTag/clear, getMany optional).
- [ ] A1.2 Add `CacheSetOptions { ttlMs?, tags? }`, `CacheAdapterFactory`, `CacheStats`.
- [ ] A1.3 Export cache types from `@kernel/db` index; re-export through `kernelcms`.
- [ ] A1.4 Add `contractVersion` constant for cache adapters.

### A2. memoryCache (default)
- [ ] A2.1 `memoryCache()` in `@kernel/core/cache.ts`: Map store, per-key expiry, tag→keys index.
- [ ] A2.2 TTL expiry on read (lazy) + optional periodic sweep with unref timer.
- [ ] A2.3 maxEntries LRU cap (evict oldest) to bound memory.
- [ ] A2.4 `clear()` + `deleteByTag()` maintain the tag index correctly.
- [ ] A2.5 Stats counters (hits/misses/evictions) for observability.

### A3. Read-through DB wrapper
- [ ] A3.1 `createCachedDb(db, cache, { cacheableSlugs, ttlMs })` implementing `DatabaseAdapter`.
- [ ] A3.2 find/findByID/count: stable key from (op, collection, JSON args); read-through.
- [ ] A3.3 create/update/delete: passthrough then `deleteByTag(collection)`.
- [ ] A3.4 transaction: invalidate touched collections after commit (wrap tx db too).
- [ ] A3.5 migrate/init/health/destroy/capabilities passthrough.
- [ ] A3.6 Only cache opt-in slugs; everything else passthrough (jobs/versions excluded).
- [ ] A3.7 Key hashing stable + collision-safe (sorted JSON).

### A4. Config + wiring
- [ ] A4.1 `KernelConfig.cache?: CacheAdapter`; `SanitizedConfig.cache?`.
- [ ] A4.2 `CollectionConfig.cache?: boolean | { ttl?: number }`; `KernelConfig.cacheDefaults?`.
- [ ] A4.3 sanitizeConfig passes cache + resolves per-collection cache flags + cacheableSlugs.
- [ ] A4.4 kernel.ts: `cache.init()`, build cachedDb when cache present, pass to operations.
- [ ] A4.5 Expose `kernel.cache` + include cache in `destroy()` + `health()`.
- [ ] A4.6 Guard: cache never wraps writes/auth lookups that must be fresh (login reads bypass).

### A5. Request-scoped dedupe
- [ ] A5.1 Per-request memo for findByID within one operation tree (populate dedupe).
- [ ] A5.2 Wire through `req.context` without leaking across requests.

### A6. dbCache (the seamlr "use your own database" option)
- [ ] A6.1 Reserved hidden `_cache` table injected like JOBS_SLUG (key pk, value json, expires_at, tags json).
- [ ] A6.2 `dbCache()` uses the kernel db; get/set/delete/deleteByTag/clear via the table.
- [ ] A6.3 TTL sweep query; tag match via stored tags array.
- [ ] A6.4 Passes the cache conformance suite. Document single-table contention caveats.

### A7. redisCache (multi-node)
- [ ] A7.1 `redisCache({ url })` lazy-imports ioredis (optional dep); SET PX, tag sets, DEL.
- [ ] A7.2 deleteByTag via a per-tag Redis set of keys; clear via prefix scan.
- [ ] A7.3 Passes conformance. Graceful degrade if Redis down (fail-open to db, log).

### A8. Conformance + tests
- [ ] A8.1 Shared `cacheConformance(makeAdapter)` suite (get/set/ttl/tags/clear/overwrite).
- [ ] A8.2 Run suite for memory (+ db, + redis behind env guard / skip if absent).
- [ ] A8.3 Integration: second read served from cache (spy db call count); write invalidates.
- [ ] A8.4 Access-safety test: two users with different scopes never share a cache entry.
- [ ] A8.5 Localization/draft keys differ (locale, draft flag in key).

### A9. Connectors UI made real
- [ ] A9.1 "Postgres cache (no extra infra)" connector → dbCache; flips real.
- [ ] A9.2 Redis connector → redisCache; "connected" reflects configured cache kind.
- [ ] A9.3 connectorStatus reports cache kind; runtime exposes it.
- [ ] A9.4 e2e: cache connectors render + switch.

### A10. Docs + security gate
- [ ] A10.1 README + a caching guide (when to use, safety model, backends).
- [ ] A10.2 generate:types / info / doctor mention cache.
- [ ] A10.3 Security sweep (Saga audit + Loki red-team) on the cache layer; fix HIGH/CRIT.
- [ ] A10.4 Full verify; commit + push.

---

## TRACK B — Durable / pluggable queue (`'queue'` slot)

- [ ] B1 `QueueAdapter` contract in @kernel/db (enqueue/reserve/ack/fail/size, visibility timeout).
- [ ] B2 `dbQueue()` over the existing jobs collection (default; what works today, formalized).
- [ ] B3 `redisQueue()` (lists + reliable queue pattern, lazy ioredis).
- [ ] B4 Wire `enqueue`/`runDueJobs` through the queue adapter when configured.
- [ ] B5 Worker loop helper + `kernel jobs:work` (long-poll) alongside `jobs:run` (cron).
- [ ] B6 Backoff strategy (exponential) + dead-letter on max attempts.
- [ ] B7 Conformance suite for queue adapters; tests; concurrency safety (claim once).
- [ ] B8 Docs + connectors UI (Redis queue) + security gate + ship.

---

## TRACK C — Full-text search (`'search'` slot)

- [ ] C1 `SearchAdapter` contract (index/remove/search/reindex) in @kernel/db.
- [ ] C2 `sqliteSearch()` using FTS5 virtual tables.
- [ ] C3 `postgresSearch()` using tsvector + GIN.
- [ ] C4 Per-collection `search: { fields }` opt-in; sync on afterChange/afterDelete hooks.
- [ ] C5 `kernel.search({ collection, query })` + REST `/api/:collection/search`.
- [ ] C6 Admin: global search palette hits the search adapter when present.
- [ ] C7 Conformance + tests + reindex CLI + docs + security gate + ship.

---

## TRACK D — Real MySQL adapter + db conformance suite

- [ ] D1 Extract a shared `dbConformance(makeAdapter)` suite from existing sqlite/postgres tests.
- [ ] D2 Run it against sqlite + postgres to prove parity (baseline).
- [ ] D3 `@kernel/db-mysql` package scaffold (mysql2), exports `mysqlAdapter`.
- [ ] D4 Schema migrate (create/alter), type mapping, identifier quoting, parameterization.
- [ ] D5 find/findByID/create/update/delete/count/transaction; JSON columns; returning emulation.
- [ ] D6 Where-AST → SQL (reuse postgres builder where possible); sort/limit/page.
- [ ] D7 Passes db conformance; wire `kernelcms/mysql` subpath; connector flips real.
- [ ] D8 Docker-based integration test (skip if no MySQL) + docs + security gate + ship.

---

## TRACK E — Security & ops hardening

- [ ] E1 General HTTP rate limiter middleware (token-bucket; per-IP + per-route; stricter on auth).
- [ ] E2 Pluggable limiter store (memory default; redis when cache/redis present).
- [ ] E3 Security headers + configurable CSP (no unsafe-inline in prod); HSTS; nosniff; frame-deny.
- [ ] E4 Signed outbound webhooks on afterChange/afterDelete (HMAC, retries via queue).
- [ ] E5 CORS allowlist hardening + credentials rules.
- [ ] E6 `/metrics` (request counts, latency, cache hit rate, queue depth) + slow-op log.
- [ ] E7 Tests for each; security gate; ship.

---

## TRACK F — Admin UX

- [ ] F1 Bulk edit selected rows (set field across selection) with access checks.
- [ ] F2 Document locking (advisory lock + presence) to avoid clobbering.
- [ ] F3 Saved views/filters per collection (persisted to a prefs global).
- [ ] F4 Array/blocks drag-reorder in the editor.
- [ ] F5 Cache + queue + search status surfaced in the dashboard widgets.
- [ ] F6 e2e for each; ship.

---

## TRACK G — Observability & docs

- [ ] G1 Structured request logging surfaced + request id propagation.
- [ ] G2 `kernel doctor` checks cache/queue/search health.
- [ ] G3 Docs site pass: caching, queue, search, adapters, security.
- [ ] G4 Example app exercising cache + search + queue end to end.

---

## Z — Re-evaluation log (append after each track; research, then add tracks)
- [ ] Z1 After Track A: re-survey gaps, append Track(s) as needed.
- [ ] Z2 After Track B/C/D: re-survey; research Payload/Strapi/Directus parity gaps.
- [ ] Z3 Keep appending until the 6h window is covered; never idle.

---

## Progress log
- (append one line per shipped phase with commit hash)
