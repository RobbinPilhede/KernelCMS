# Multi-Tenancy & Isolation

KernelCMS Cloud runs many tenants on shared infrastructure while guaranteeing that no tenant can read, mutate, or starve another. This document specifies the three isolation models KernelCMS supports, the tenant-context middleware that resolves and pins identity on every request, the noisy-neighbor controls that bound resource consumption, and the per-tenant configuration layer that lets a single deployment present different behavior to different customers. Self-hosters get the same primitives — multi-tenancy is a first-class feature of `@kernel/server`, not a Cloud-only bolt-on.

Most CMSes punt on this. Sanity is multi-tenant only because it is fully hosted — you never see the isolation boundary, and you cannot self-host it. Strapi is fundamentally single-tenant: one deployment, one database, one customer; "multi-tenancy" means running N copies. Payload added a `@payloadcms/plugin-multi-tenant` that does row-level scoping via a `tenant` field, but it stops at the row model and leaves context resolution, noisy-neighbor protection, and schema/database isolation to you. KernelCMS treats all three isolation models as swappable strategies behind one contract, and the tenant boundary is enforced server-side in the operation core — the same place [access control](../06-auth-security/01-authorization-and-access-control.md) lives — so it cannot be bypassed from REST, GraphQL, or RPC.

## Isolation models

A tenant is identified by a stable `tenantId`. How that ID maps to physical storage is the isolation model. KernelCMS ships three, selected per deployment (and, on Cloud, per plan tier):

| Model        | Boundary                     | Blast radius  | Cost / tenant | Best for                           |
| ------------ | ---------------------------- | ------------- | ------------- | ---------------------------------- |
| **Row**      | `tenant_id` column + RLS     | Logical only  | Lowest        | Free/low tiers, high tenant count  |
| **Schema**   | Postgres schema per tenant   | Schema-scoped | Medium        | Mid-tier, regulated-but-shared     |
| **Database** | Separate database/connection | Physical      | Highest       | Enterprise, data-residency, BYO-DB |

The model is configured on the tenancy adapter. The rest of the system — collections, fields, the query language — is identical regardless of which one you pick.

```ts
// kernel.config.ts
import { defineConfig } from '@kernel/core'
import { postgres } from '@kernel/db-postgres'
import { tenancy } from '@kernel/server'

export default defineConfig({
  db: postgres({ url: env.DATABASE_URL }),
  tenancy: tenancy({
    enabled: true,
    isolation: 'schema', // 'row' | 'schema' | 'database'
    resolve: 'subdomain', // how a request maps to a tenantId
    // For 'database', a resolver returns a connection per tenant:
    connectionFor: async (tenantId) => env[`DB_URL_${tenantId.toUpperCase()}`],
  }),
})
```

### Row isolation

Every tenant-scoped table carries a non-null `tenant_id`. KernelCMS appends a `tenant_id = $current` predicate to every generated query, but the column is _not_ the security boundary — the database is. The Drizzle schema diff that produces a tenant-aware table also emits Postgres Row-Level Security so a leaked or buggy query cannot cross tenants:

```sql
ALTER TABLE posts ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON posts
  USING (tenant_id = current_setting('kernel.tenant_id')::uuid);
```

`@kernel/db-postgres` sets `kernel.tenant_id` via `SET LOCAL` inside the transaction that wraps each operation, so the policy is bound to the resolved tenant for the lifetime of that request and nothing else. This is the same mechanism Payload's plugin relies on conceptually, but here it is generated from config and enforced at the database, not assembled in application code. SQLite and MySQL adapters fall back to query-level scoping plus a defense-in-depth assertion (described under [Tenant context middleware](#tenant-context-middleware)) since they lack first-class RLS.

```
┌─────────────────────────── one database ───────────────────────────┐
│  posts                                                              │
│  ┌───────────┬─────────┬──────────────┐                            │
│  │ tenant_id │  id     │  title       │   RLS policy filters every  │
│  ├───────────┼─────────┼──────────────┤   row by current_setting()  │
│  │ acme      │  …      │  …           │                            │
│  │ globex    │  …      │  …           │ ← invisible to acme         │
│  └───────────┴─────────┴──────────────┘                            │
└────────────────────────────────────────────────────────────────────┘
```

### Schema isolation

Each tenant gets a dedicated Postgres schema (`tenant_acme.posts`, `tenant_globex.posts`). The connection's `search_path` is set per request. Tables are physically separate, so a missing predicate cannot leak across tenants, and per-tenant operations like `pg_dump`, restore, or drop are trivial. Migrations run once per schema; the migration runner in `@kernel/server` iterates the tenant registry and applies the same generated diff to each. The trade-off is catalog bloat: thousands of schemas slow `pg_catalog` lookups and connection setup, so this model is for hundreds-to-low-thousands of tenants, not millions.

### Database isolation

Each tenant has its own database (or its own cluster, or its own provider — including a customer's BYO connection string). This is the only model that satisfies hard data-residency and per-tenant encryption-key requirements, and it is what KernelCMS Cloud offers on enterprise plans and what self-hosters use when a customer demands "our data never shares a process with anyone else's." The cost is a connection pool per tenant; the connection management layer lazily opens, caps, and evicts pools so a long tail of idle tenants does not exhaust file descriptors.

## Tenant context middleware

Isolation only holds if the right `tenantId` is pinned for the entire request and never reset mid-flight. KernelCMS resolves tenancy in a TanStack Start middleware that runs before any server function, REST handler, or GraphQL resolver, and stores the result in `AsyncLocalStorage` so every downstream call — including async validation and access hooks — sees the same tenant without threading it through arguments.

Resolution strategies are configurable and composable:

| Strategy    | Source                     | Typical use         |
| ----------- | -------------------------- | ------------------- |
| `subdomain` | `acme.app.com`             | SaaS dashboards     |
| `header`    | `X-Kernel-Tenant`          | API gateways, RPC   |
| `path`      | `/t/acme/...`              | single-domain admin |
| `domain`    | full custom domain map     | white-label sites   |
| `jwt`       | claim in the session token | authenticated APIs  |

```ts
// Conceptual shape of the resolved context (read-only, server-side only)
interface TenantContext {
  readonly tenantId: string
  readonly isolation: 'row' | 'schema' | 'database'
  readonly limits: TenantLimits
  readonly config: ResolvedTenantConfig
}

// Access it anywhere in an operation, hook, or server function:
import { getTenant } from '@kernel/server'

export const beforeChange = async (args) => {
  const { tenantId } = getTenant()
  // tenantId is guaranteed present; operations that need a tenant
  // throw TenantNotResolvedError before touching the DB.
}
```

The middleware does three things in order:

1. **Resolve** the `tenantId` from the configured strategy. If it cannot, the request is rejected with `TenantNotResolvedError` — there is no implicit "default tenant," which is how cross-tenant leaks usually start.
2. **Bind** the database session: open the right transaction (row), set `search_path` (schema), or select the pool (database), and `SET LOCAL kernel.tenant_id`.
3. **Assert** defense-in-depth: every write passes through a guard that re-checks the row's `tenant_id` matches the context before commit. On SQLite/MySQL this guard is the primary boundary; on Postgres with RLS it is a redundant second check that turns a silent leak into a logged, failing error.

Because the tenant lives in `AsyncLocalStorage`, the in-process Local API and the over-the-wire [typed RPC](../05-api/03-typed-rpc-and-local-api.md) share identical enforcement — calling `kernel.find('posts')` from a server function is scoped exactly as a REST `GET /api/posts` would be. Unlike Payload's plugin, where you must remember to filter by the tenant field in custom endpoints, the boundary in KernelCMS is impossible to forget because it is below the API surface.

## Noisy-neighbor controls

Shared infrastructure fails when one tenant's traffic, query weight, or storage growth degrades everyone else. KernelCMS enforces budgets at three layers, all configurable per tenant and surfaced as metrics for [observability](./05-observability-logging-metrics-tracing.md).

**Request-rate and concurrency.** Every tenant has a token-bucket rate limit and a max-concurrency cap. The limiter is an adapter (`@kernel/cache`-backed, e.g. Redis) so limits are correct across horizontally scaled nodes. Exhaustion returns `429` with `Retry-After`; it never blocks the event loop or another tenant.

**Query cost.** Operations carry a computed cost (depth, page size, relationship joins). A per-tenant cost budget rejects pathological queries — `depth: 10` against deeply nested relationships, or a 10k-row export — before they pin a connection. This is enforced in the operation core, so it applies uniformly across REST, GraphQL, and RPC.

**Connection and storage quotas.** In database isolation, each tenant pool is capped so one tenant cannot drain shared file descriptors. Upload volume and document count are metered against the tenant's plan and feed [billing](./04-billing-metering-and-plans.md).

```ts
tenancy({
  enabled: true,
  isolation: 'row',
  limits: {
    default: {
      requestsPerMinute: 600,
      maxConcurrency: 20,
      maxQueryCost: 5_000,
      maxUploadMb: 50,
    },
    perTenant: {
      // overrides; usually sourced from the plan, not hardcoded
      'enterprise-acme': { requestsPerMinute: 6_000, maxConcurrency: 100 },
    },
  },
})
```

```
request ─▶ [rate limit] ─▶ [concurrency gate] ─▶ [query-cost check] ─▶ op
              │ 429            │ 429                 │ 422
              ▼                ▼                     ▼
           per-tenant token bucket / semaphore / cost budget (shared cache)
```

## Per-tenant config

A multi-tenant deployment must present different behavior to different customers without redeploying. KernelCMS layers a per-tenant config object over the base `kernel.config.ts`. The base config defines the schema and capabilities; the tenant layer overrides a bounded, validated allowlist — branding, locales, feature flags, plan limits, custom domains, and white-label theme tokens for the admin panel.

```ts
tenancy({
  enabled: true,
  isolation: 'schema',
  configFor: async (tenantId): Promise<TenantConfig> => {
    const t = await loadTenant(tenantId) // from the control-plane store
    return {
      locales: t.locales, // affects field localization
      features: t.features, // gate optional collections/plugins
      theme: t.theme, // @kernel/ui design tokens, dark mode
      limits: t.plan.limits, // feeds noisy-neighbor controls
    }
  },
})
```

Tenant config is loaded once per request by the middleware, cached with the tenant's own cache namespace, and exposed read-only via `getTenant().config`. It cannot alter collection definitions or access rules — those stay code-as-config in the base file and are reviewed, versioned, and migrated like any other code. This is deliberately narrower than letting tenants edit arbitrary config: it preserves a single, auditable source of truth for the security-relevant surface while still giving each tenant a tailored experience. Sanity gives each project its own dataset and studio config but no shared base to enforce invariants across tenants; KernelCMS keeps the invariants central and the variations bounded.

## Open questions

- **Cross-tenant queries for platform operators.** Support staff sometimes need read access spanning tenants. The clean answer is a separate, audited "operator" context that bypasses RLS with explicit logging — but whether that lives in `@kernel/server` or only in `@kernel/cloud` is undecided.
- **Per-tenant migrations at scale.** Schema isolation makes migrations O(tenants). For low-thousands this is fine; beyond that we may need batched, resumable migration runs and a per-tenant schema-version table. Not yet specified.
- **Mixed isolation in one deployment.** Allowing some tenants on row and others on database within a single deployment is appealing for "upgrade to dedicated DB" flows, but complicates the migration runner and connection layer. Likely a v2 concern.
- **Tenant config hot-reload.** Whether config changes propagate via cache invalidation push or short TTL polling affects how fast a plan upgrade takes effect. Leaning toward push, pending the cache adapter contract.
