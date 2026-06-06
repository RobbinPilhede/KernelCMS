# KernelCMS — Night Roadmap (ballpark)

Written 2026-06-06 for review. This is a **survey + ballpark**, not a file-by-file plan.
Goal: agree on what we're missing and pick one ~6-hour track to run autonomously.

---

## 1. Where KernelCMS stands today (so we don't rebuild what exists)

Confirmed present in the codebase right now:

- **Engine:** config-as-code, adapter-based pipeline (defaults → access → hooks → validate
  → serialize → adapter → populate). Local API + REST + GraphQL + typed client.
- **Field types are already broad:** text, number, boolean, date, email, richText, upload,
  relationship, array, blocks, group, row, tabs, join, slug, ui. (Payload-grade coverage.)
- **Content localization already exists** (`field.localized`, per-locale storage, fallback
  locale resolution in `packages/core/src/fields.ts`). Not a gap.
- **Background jobs already exist and are DB-backed**: a reserved hidden jobs collection +
  `kernel.enqueue()` / `runDueJobs()` / `kernel jobs:run`. So durable jobs already work
  through whatever DB you run.
- **Migrations** (diff-based, risk-classified), **versions/drafts**, **uploads + image
  sizes**, **OAuth (Google/GitHub)**, **email adapters**, **storage adapters (local/S3/R2)**,
  **modules system** (defineEndpoint/defineModule), **OpenAPI + Scalar docs**,
  **computed/virtual fields**, **admin SPA** (TanStack), **first-run wizard + connectors UI**.
- **Login-path rate limiting exists in-memory** (operations.ts), and there's TOTP 2FA,
  forgot-password, email verification.

**The architecture already reserves adapter kinds we haven't built:**
`AdapterKind = 'db' | 'storage' | 'auth' | 'email' | 'search' | 'cache' | 'queue'`
→ `search`, `cache`, and a pluggable `queue` are **declared but unimplemented**. The config
type accepts `db` / `storage` / `email` only.

---

## 2. What we're missing (gap analysis, prioritized)

**Tier 1 — high value, architecture already expects it**
1. **Cache layer.** No `CacheAdapter` implementation; the `'cache'` slot is empty. Every read
   re-runs populate/joins. This is the thing you flagged. (Detail in §3.)
2. **Real Redis / Postgres-cache.** The Redis connector we just shipped is a stub
   (`requiresAdapter`). A cache layer makes it real and closes that honesty gap.
3. **Pluggable durable queue (`'queue'` slot).** Jobs work via DB-poll today; a Redis/Postgres
   queue adapter gives distributed workers + lower latency. Architecture already anticipates it.

**Tier 2 — credibility / production-readiness**
4. **A real MySQL adapter.** Relational, so it can mirror `@kernel/db-postgres`. Most feasible
   of the three stubbed DBs. (MongoDB is a much bigger semantic project; defer.)
5. **Adapter conformance test suite.** One shared spec every db/cache/queue adapter must pass.
   This is the multiplier that makes building MySQL/Mongo/cache/queue safe and fast.
6. **General HTTP rate limiting + security headers/CSP** at the server (only login is limited
   today; our own global rules require rate-limiting public endpoints).
7. **Full-text search adapter (`'search'` slot).** Postgres FTS / SQLite FTS5 first; the slot
   exists.

**Tier 3 — polish / breadth**
8. **Outbound webhooks** on create/update/delete (afterChange → signed HTTP).
9. **Admin UX:** bulk edit, document locking, saved views/filters, drag-reorder for arrays.
10. **Realtime** (SSE/websocket) admin updates + live preview push.
11. **Observability:** `/metrics`, structured request logs surfaced, slow-query log.
12. **Docs site** + more end-to-end examples.

---

## 3. Evaluating the seamlr "Postgres cache" idea

**What seamlr actually does:** denormalized **Postgres views/materialized views**
(`activeBookingsView`, `jobMetricView`, `userMetricsView`, …) as precomputed read models,
plus **PGMQ** (a Postgres-backed message queue) for background work. Driver: Drizzle on Bun.
It is **deeply Postgres-specific** (materialized views, `tstzrange` overlap, PostGIS,
trigram, `json_agg`). The *philosophy* is the takeaway: **use the database you already have
as your cache and queue — don't make Redis a hard dependency.**

**How that maps to KernelCMS (two distinct ideas):**

- **(A) Portable result cache — RECOMMENDED.** Implement the empty `'cache'` slot as a
  `CacheAdapter` contract with multiple backends:
  - `memoryCache()` — default, dev, single-node.
  - `dbCache()` — **the seamlr-inspired "no extra infra" option**: cache entries live in a
    reserved table in your existing Postgres/SQLite, with TTL + tag invalidation. Survives
    restarts, zero new services. This is the honest default for "Postgres cache."
  - `redisCache()` — makes the Redis connector real for multi-node.
  Wire it into the read pipeline (findByID/find + populate) with per-collection opt-in
  (`cache: { ttl, tags }`), automatic **tag-based invalidation on writes** (afterChange/
  afterDelete hooks), and a **request-scoped dataloader** to dedupe identical reads within
  one request. This is portable across every db adapter — the right fit for an adapter-based CMS.

- **(B) Denormalized views / "computed collections" — Postgres-only stretch.** A literal
  seamlr clone: let a collection be backed by a (materialized) SQL view, refreshed on write
  or on a schedule. Very powerful for heavy joins, but **adapter-locked to Postgres** and a
  bigger design. Note it loudly if we build it; keep it out of the core contract.

**Recommendation:** build (A) now (it fills a declared gap, is portable, and makes Redis +
"Postgres cache" both real). Treat (B) as a future Postgres-adapter feature, clearly labeled.

---

## 4. Proposed 6-hour autonomous track (recommended): **Cache + conformance**

Coherent, shippable, closes the Redis-stub honesty gap, and uses slots the engine already declares.

- **P1 — Contract & conformance (foundation).** Define `CacheAdapter`
  (`get/set/delete/deleteByTag/clear`, TTL). Add `cache?` to `KernelConfig` and `kernel.cache`.
  Write a **shared conformance test suite** any cache adapter must pass.
- **P2 — `memoryCache()`** (default) passing conformance. Request-scoped dataloader for
  read dedupe within a request.
- **P3 — `dbCache()`** — reserved cache table in the active db (Postgres + SQLite), TTL sweep,
  tag index. The "use your own database" option. Passes conformance.
- **P4 — `redisCache()`** — real Redis backend (ioredis), passes conformance. Flip the Redis
  connector from stub → real ("connected" when `REDIS_URL` is set + adapter configured).
- **P5 — Wire into reads + invalidation.** Per-collection `cache: { ttl, tags }`; cache
  findByID/find; invalidate by tag on create/update/delete via hooks. Make it safe under
  access control (never serve a doc past a read-access check — cache *post*-access or key by
  viewer scope).
- **P6 — Connectors UI + docs + tests.** Add a "Postgres cache (no extra infra)" connector
  alongside Redis; both become real. README + a short caching guide. Full unit + e2e.
- **Stretch:** pluggable `'queue'` adapter (Redis or Postgres) for jobs; or HTTP rate-limit
  middleware.

**Overlook / risks to watch (the "be careful here" list):**
- **Cache vs. access control** is the sharp edge: a result cache must not leak docs across
  users/permissions. Either cache only post-access-filtered results, or include the access
  scope in the cache key. Get this wrong = security bug. (Loops back to our security gate:
  Saga + Loki must review the cache layer before it ships.)
- **Invalidation correctness** > hit rate. Prefer tag-based, write-through invalidation; when
  unsure, evict. Stale auth/permission data is the dangerous kind.
- **Localization + drafts** interact with cache keys (locale, draft flag, depth must be in the key).
- **Single-node vs multi-node:** memory cache is per-process; say so. dbCache/redisCache are shared.
- **Don't cache writes or authenticated mutations.** Reads only, opt-in per collection.

**Verification:** conformance suite green for all three adapters; existing 277 unit + 12 e2e
stay green; new integration tests prove invalidation + access-safety; typecheck/lint/format clean;
manual smoke on the demo. Security sweep (Saga + Loki) on the cache layer before delivery.

---

## 5. Alternative tracks (if you'd rather aim elsewhere)

- **B. Real MySQL adapter + conformance suite.** Build the conformance spec, then a genuine
  `@kernel/db-mysql` (mysql2) mirroring the Postgres adapter. Makes one of the stubbed DBs real.
- **C. Security & ops.** Global HTTP rate limiting, CSP/security headers, signed outbound
  webhooks, `/metrics`. Aligns with our always-on security rules.
- **D. Admin UX.** Bulk edit, document locking, saved views, array drag-reorder, realtime.

---

## 6. My recommendation

Run **Track A (Cache + conformance)** tonight. It fills a slot the engine already declares,
makes the Redis + "Postgres cache" connectors honest, follows the seamlr "use your own DB"
philosophy in a portable way, and the conformance suite it produces is the reusable foundation
that also de-risks MySQL/Mongo/queue/search later.

**I did not start coding** — you said to evaluate first. Reply with a track letter (A/B/C/D)
and I'll run it autonomously and have it ready, green and pushed, when you're up.
