# Context & Dependency Injection

KernelCMS resolves every dependency a request might touch — the active database adapter, the storage driver, the authenticated user, the access-control evaluator, the localization state — through a single, explicitly-constructed **request context**. There is no ambient global, no module-level singleton holding a live database connection, and no service locator reaching into a hidden registry. Every operation, hook, validation function, and field resolver receives its `KernelContext` as an argument. This document specifies the shape of that context, the container that builds it, how scoping and lifetimes work across self-host and Cloud, and why the design makes the operation core trivially testable.

## The request context object

`KernelContext` is the object threaded through the entire operation core. The Local API, REST handlers, GraphQL resolvers, and RPC server functions all converge on the same context type, so a hook written once behaves identically regardless of the surface that triggered it.

```ts
// @kernel/core
export interface KernelContext {
  /** The fully resolved config, frozen at boot. */
  readonly config: ResolvedConfig
  /** The active database adapter (Drizzle SQL or MongoDB). */
  readonly db: DatabaseAdapter
  /** Storage driver for uploads (S3, GCS, local disk, ...). */
  readonly storage: StorageAdapter
  /** Authenticated principal, or null for anonymous requests. */
  readonly user: AuthUser | null
  /** Access-control evaluator, pre-bound to this user. */
  readonly access: AccessEvaluator
  /** Active locale + fallback chain for this request. */
  readonly locale: LocaleState
  /** Structured logger with request-scoped correlation id. */
  readonly logger: Logger
  /** Per-request memoization + dataloader cache. */
  readonly cache: RequestCache
  /** Re-enter the operation core with this same context. */
  readonly local: LocalAPI
  /** Transaction handle when inside `db.transaction(...)`. */
  readonly tx?: TransactionScope
  /** Cooperative cancellation for long operations. */
  readonly signal: AbortSignal
}
```

Two properties carry most of the design weight. `context.local` lets a hook re-enter the operation core — `await context.local.find({ collection: 'media', where, depth: 0 })` — without re-deriving auth or locale, so nested reads inherit the caller's identity and transaction. And `context.access` is **already bound to the user**: hooks never re-implement permission checks, they ask the evaluator. Payload threads a comparable `req` object into hooks, but its `req` is a decorated Express request — fundamentally a transport artifact. KernelCMS's context is transport-agnostic, which is what allows the Local API to run in-process with full type inference and zero HTTP overhead. See [Operations & the Local API](../05-api/03-typed-rpc-and-local-api.md) for the call surface and [Access Control](../06-auth-security/01-authorization-and-access-control.md) for the evaluator contract.

The context is **immutable from the operation's point of view**. Hooks cannot reassign `context.user` to escalate privileges; producing a different identity requires constructing a new derived context through `context.with({ user })`, which re-runs access binding. This closes the most common server-side authorization mistake — mutating the request object mid-flight.

## The service container

Long-lived dependencies — adapters, the auth provider, the search and queue clients, registered plugins — are constructed exactly once at boot and held in the **service container**. The container is the application root; the per-request context is a thin, cheap projection of it.

```ts
// @kernel/server
export interface Container {
  resolve<K extends keyof ServiceMap>(token: K): ServiceMap[K]
  /** Build a request-scoped context from this root container. */
  createContext(req: IncomingRequest): Promise<KernelContext>
  /** Graceful shutdown: drains queues, closes pools. */
  dispose(): Promise<void>
}
```

Services register declaratively. Every adapter in `kernel.config.ts` is a factory, and the factory's return type _is_ the registration — there is no separate DI annotation layer, no decorators, no reflect-metadata. The config is the wiring.

```ts
// kernel.config.ts
import { defineConfig } from '@kernel/core'
import { postgresAdapter } from '@kernel/db-postgres'
import { s3Storage } from '@kernel/storage'
import { authPlugin } from '@kernel/auth'

export default defineConfig({
  db: postgresAdapter({ url: process.env.DATABASE_URL }),
  storage: s3Storage({ bucket: 'kernel-media', region: 'eu-north-1' }),
  auth: authPlugin({ strategies: ['password', 'oauth'] }),
  collections: [Posts, Media, Users],
  globals: [SiteSettings],
})
```

At boot, `@kernel/server` walks this config, resolves each factory, and validates the dependency graph. A storage driver that needs a queue, or a plugin that needs the search adapter, declares it and receives it — resolution is topologically ordered, and a missing or cyclic dependency fails the build, not the first request.

```
              ┌─────────────────────────────┐
              │   Container (app root)       │
              │   db · storage · auth ·      │
              │   search · queue · plugins   │
              └──────────────┬──────────────┘
                             │ createContext(req)
        ┌────────────────────┼────────────────────┐
        ▼                    ▼                    ▼
  KernelContext A      KernelContext B      KernelContext C
  user=alice           user=bob             user=null
  locale=en            locale=sv            locale=en
  (shares db pool, storage, plugins by reference)
```

This is the inverse of Strapi's `strapi.service('...')` global and Sanity's reliance on the hosted runtime to supply backend services. In KernelCMS, the wiring is in your repository, type-checked, and identical between self-host and Cloud — Cloud simply swaps the adapter _implementations_ (managed Postgres, the global media CDN) behind the same tokens. Nothing in your collection config or hooks changes when you move.

### Resolution rules

| Concern          | Rule                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------- |
| Singletons       | Adapters and plugin services resolve once at boot, shared by reference across all contexts.             |
| Request services | `access`, `locale`, `cache`, `logger` are constructed per request in `createContext`.                   |
| Lazy plugins     | A plugin may register a factory that resolves on first use, then memoizes for the container lifetime.   |
| Overrides        | Tests and Cloud inject alternate factories at boot; resolution is by token, so call sites never change. |
| Cycles           | Detected at boot via topological sort; a cycle is a hard build error.                                   |

## Scoping and lifetimes

Three lifetimes, no more, and each is explicit.

**Application (singleton).** Connection pools, the storage client, compiled GraphQL schema, plugin instances. Created once in `Container`, disposed on shutdown. These are expensive and stateful and must be shared — never rebuilt per request.

**Request.** A `KernelContext` per inbound REST/GraphQL/RPC call or per Local API entry point. Holds the user, locale, logger correlation id, and a `RequestCache` that backs dataloaders for relationship resolution. Garbage-collected when the request resolves; nothing leaks between requests because nothing request-scoped is stored on the container.

**Transaction.** A nested scope created by `db.transaction`. The transactional context shares everything with its parent but swaps `tx` for a live handle. Writes inside the callback see each other; a thrown error rolls back the whole tree.

```ts
await context.db.transaction(async (txContext) => {
  const order = await txContext.local.create({
    collection: 'orders',
    data: { total },
  })
  // Nested writes and afterChange hooks all share txContext.tx.
  await txContext.local.update({
    collection: 'inventory',
    id: skuId,
    data: { reserved: { decrement: order.qty } },
  })
}) // commits on success, rolls back on throw
```

The lifetime boundaries are also where cleanup hooks fire. The request scope tears down dataloaders and flushes the logger; the transaction scope commits or rolls back; the application scope drains in-flight queue jobs before closing pools. `context.signal` propagates cancellation downward — abort the request and every in-flight `db` and `storage` call observing the signal stops.

```
app boot ──────────────────────────────────────── shutdown
   │  singletons live the whole process              │
   │   ┌── request ──┐   ┌── request ──┐              │
   │   │  ctx + cache│   │  ┌── tx ──┐ │              │
   │   │             │   │  └────────┘ │              │
   │   └─────────────┘   └─────────────┘              │
```

## Testability

Because every dependency arrives through the context and every service resolves by token, the operation core has no hidden inputs — which is the whole point. A unit test constructs a container with whatever adapters it wants and never touches HTTP, the admin app, or a real network.

```ts
import { createTestContainer } from '@kernel/server/testing'
import { sqliteAdapter } from '@kernel/db-sqlite'

const container = await createTestContainer({
  config,
  db: sqliteAdapter({ url: ':memory:' }), // real DB, in-memory
  storage: memoryStorage(),
  user: { id: 'u1', roles: ['editor'] }, // seed the principal
})

const ctx = await container.createContext(anonReq())

test('editors cannot publish', async () => {
  await expect(ctx.local.update({ collection: 'posts', id, data: { _status: 'published' } })).rejects.toThrow(
    ForbiddenError,
  )
})
```

Note the in-memory SQLite adapter: per our testing tenets we prefer a real dependency over a mock, and the Adapter contract makes that cheap — swap `@kernel/db-postgres` for `@kernel/db-sqlite` at the token, and the operation core can't tell. Access control, validation, localization fallback, and hook ordering are all exercised against real persistence, not stubs.

For the rare case where a real service is impractical (a paid email provider, a flaky third-party search), inject a fake factory at the token:

```ts
const container = await createTestContainer({
  config,
  email: fakeEmail(), // captures sends for assertion
  search: inMemorySearch(),
})
expect(fakeEmail().sent).toContainEqual({ to: 'a@b.com', template: 'welcome' })
```

This is a sharper testing story than Payload's `payload.init()` (which still bootstraps a near-full server) or Strapi (where `strapi` is a global you stub by mutation). KernelCMS tests build the smallest container that satisfies the code under test, with zero global state to reset between cases. Combined with the request-scoped `cache`, tests are deterministic and isolated by construction — no shared mutable state, exactly as the testing rules require. See Testing the operation core for fixtures and factory helpers.

## Open questions

- **Plugin service visibility.** Should plugins resolve arbitrary tokens from the container, or only a curated capability subset? Full access is ergonomic but widens the blast radius of a malicious plugin. Leaning toward a declared-capabilities allowlist in the plugin manifest, enforced by `@kernel/plugin-sdk`.
- **AsyncLocalStorage fallback.** The context is passed explicitly everywhere, but third-party libraries (rich-text serializers, image pipelines) sometimes need it without a parameter. Do we expose an opt-in `AsyncLocalStorage` bridge, accepting its edge-runtime caveats, or hold the line on explicit passing?
- **Per-tenant container vs. per-tenant context in Cloud.** Multi-tenant Cloud could give each tenant its own container (strong isolation, higher memory) or share singletons and scope tenancy into the context (cheaper, relies on adapter-level row isolation). The tradeoff interacts with connection-pool sizing and warrants a benchmark before we commit.
