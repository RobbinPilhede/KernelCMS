# Request Lifecycle

Every read or write in KernelCMS — whether it arrives over REST, GraphQL, typed RPC, or an in-process Local API call — funnels through one operation core. This document traces a request from the wire to a response: how the middleware chain runs on TanStack Start, how authentication and the request `Context` are resolved, how the operation pipeline executes against an adapter, and exactly where hooks fire. The guarantee we make is that all four API surfaces share the same pipeline, so access control, validation, hooks, and persistence behave identically no matter how a caller reaches us. Payload and Strapi re-implement parts of this per surface; we refuse to.

## The shared pipeline at a glance

```
  REST / GraphQL / RPC                 Local API (in-process)
        │                                      │
        ▼                                      │
  TanStack Start server fn                     │
        │                                      │
        ▼                                      ▼
  ┌──────────────────────────────────────────────────┐
  │  Middleware chain (Start middleware)              │
  │  cors → rateLimit → requestId → auth → context    │
  └──────────────────────────────────────────────────┘
        │
        ▼
  ┌──────────────────────────────────────────────────┐
  │  Operation pipeline (@kernel/core)                │
  │  resolveConfig → access(operation) → beforeValidate│
  │  → validate → beforeChange → adapter.exec          │
  │  → access(field) → afterChange → afterRead         │
  └──────────────────────────────────────────────────┘
        │
        ▼
     Adapter (@kernel/db-postgres | -sqlite | -mysql | -mongodb)
```

The wire surfaces in `@kernel/rest`, `@kernel/graphql`, and `@kernel/rpc` are thin. They parse their transport-specific input into a normalized `OperationArgs`, then call into `@kernel/core`. The Local API skips the transport layer entirely and calls the same core functions directly, which is why it returns fully inferred types with zero serialization cost.

## Middleware chain

The chain is built on TanStack Start server-function middleware. Each link receives the request, may mutate or short-circuit it, then calls `next()`. We compose a default chain and let `kernel.config.ts` insert custom links at named positions. Unlike Strapi's Koa middleware (which is HTTP-coupled), our chain runs for RPC server functions too, so the same protections cover every wire surface.

```ts
// @kernel/server
export interface KernelMiddleware {
  name: string
  handler: (req: KernelRequest, next: NextFn) => Promise<KernelResponse>
}
```

The default order is fixed and meaningful:

| Order | Middleware  | Responsibility                                                |
| ----- | ----------- | ------------------------------------------------------------- |
| 1     | `requestId` | Assigns a ULID, attaches it to logs and the response header   |
| 2     | `cors`      | Explicit origin allowlist; never wildcard with credentials    |
| 3     | `rateLimit` | Per-IP and per-token buckets; stricter on `/auth/*`           |
| 4     | `bodyLimit` | Rejects oversized payloads before parsing                     |
| 5     | `auth`      | Resolves the authenticated principal (see below)              |
| 6     | `context`   | Builds the immutable request `Context` passed to the pipeline |
| 7     | `i18n`      | Resolves locale and fallback chain from header or query       |

Custom middleware mounts relative to these anchors so you never guess at numeric priorities:

```ts
// kernel.config.ts
import { defineConfig } from '@kernel/core'
import { tenantResolver } from './middleware/tenant'

export default defineConfig({
  server: {
    middleware: [
      // run after auth so req.user is populated, before context is frozen
      { after: 'auth', use: tenantResolver },
    ],
  },
})
```

A middleware that throws a `KernelError` subclass short-circuits the chain; the error is serialized by the active transport (HTTP status for REST/GraphQL, RPC error envelope for `@kernel/rpc`). Returning early without calling `next()` is the supported way to serve a cached or redirect response.

## Auth and context resolution

The `auth` middleware delegates to the configured `@kernel/auth` strategy — sessions, JWT, API keys, or a custom adapter. Its only job is to produce a `Principal` (or `null` for anonymous). It does **not** make authorization decisions; that happens later, per operation and per field, so the same principal flows through every access rule.

```ts
export interface Principal {
  id: string
  collection: string // e.g. "users" — auth-enabled collections
  roles: readonly string[]
  // strategy-specific claims, never trusted blindly
  claims: Record<string, unknown>
}
```

JWT verification pins the algorithm, checks `exp`, and validates the issuer — we never accept `alg: none` or trust an unverified header. Sessions are looked up server-side against the active store; the cookie is `Secure + HttpOnly + SameSite=Lax`.

Once the principal exists, the `context` middleware assembles the `Context` object. This is the single value threaded through the entire pipeline and into every hook and access function. It is frozen before the pipeline runs, so a hook cannot mutate the locale or principal mid-operation.

```ts
export interface Context {
  readonly req: KernelRequest
  readonly user: Principal | null
  readonly locale: string
  readonly fallbackLocale: string | false
  readonly transaction: Transaction | null // set by the pipeline, not here
  readonly requestId: string
  // typed handle to the Local API for hook-internal calls
  readonly kernel: KernelLocalAPI
}
```

Exposing `ctx.kernel` (the Local API) inside hooks is deliberate. Payload's hooks receive a `req` carrying a payload instance; we go further by handing hooks the same fully-typed operation core the request itself used, so a `beforeChange` hook can read a related document with identical access semantics.

See [Access Control](../06-auth-security/01-authorization-and-access-control.md) for how `ctx.user` is evaluated, and Adapters for the persistence contract.

## The operation pipeline

`@kernel/core` exposes one function per operation: `find`, `findByID`, `create`, `update`, `delete`, and their global equivalents. Each is a fixed sequence of stages. The transport layer never reorders or skips stages — that uniformity is the whole point.

```ts
// @kernel/core — conceptual shape of a write operation
async function create(args: CreateArgs, ctx: Context) {
  const config = resolveCollection(args.collection)

  await enforceAccess('create', { config, ctx }) // operation-level
  let data = await runHooks('beforeValidate', { data: args.data, ctx })
  await validateDocument(config, data, ctx) // sync + async + cross-field
  data = await runHooks('beforeChange', { data, ctx })

  return ctx.kernel.transaction(async (tx) => {
    const row = await config.adapter.create({ data, tx }) // single adapter call
    const withFieldAccess = await applyFieldAccess('read', row, ctx)
    await runHooks('afterChange', { doc: row, ctx, tx })
    return runHooks('afterRead', { doc: withFieldAccess, ctx })
  })
}
```

Stage-by-stage:

1. **Resolve config.** Look up the collection or global from the compiled config. Unknown slugs fail fast.
2. **Operation access.** Evaluate the `access[operation]` rule. A returned `false` is a `403`; a returned `Where` clause is merged into the query as a row filter, which is how we do resource-level authorization without N+1 ownership checks.
3. **Validation.** Field validators run — sync, async, and cross-field. Drafts relax `required` so authors can save incomplete work, matching Sanity's draft ergonomics but enforced server-side.
4. **Persist.** A single adapter method runs inside a transaction. The adapter is the only component that speaks Drizzle or the MongoDB driver; core stays storage-agnostic.
5. **Field access + read shaping.** Fields the principal cannot read are stripped, localization is collapsed to the resolved locale, and `depth` controls relationship population.

The same shared query language (`where` / `sort` / `pagination` / `depth`) is parsed once into a normalized AST and handed to the adapter. REST query strings, GraphQL args, and RPC arguments all reduce to that AST, so a complex filter behaves identically across surfaces — something Strapi cannot promise because its REST and GraphQL filtering diverge.

## Hook execution points

Hooks are registered per collection, per global, or per field in `kernel.config.ts`. Each runs at a precise pipeline stage with a typed payload, and the return value (where applicable) replaces the working value for the next stage.

```ts
// kernel.config.ts
import { defineCollection } from '@kernel/core'

export const Posts = defineCollection({
  slug: 'posts',
  hooks: {
    beforeValidate: [({ data }) => ({ ...data, slug: slugify(data.title) })],
    beforeChange: [
      async ({ data, ctx }) => {
        data.searchVector = await buildVector(data.body, ctx)
        return data
      },
    ],
    afterChange: [
      async ({ doc, ctx }) => {
        await ctx.kernel.queue.enqueue('reindex', { id: doc.id })
      },
    ],
    afterRead: [({ doc }) => doc],
  },
  fields: [
    { name: 'title', type: 'text', required: true },
    { name: 'body', type: 'richText' },
  ],
})
```

| Hook             | Fires                             | Can mutate | Inside tx | Typical use                         |
| ---------------- | --------------------------------- | ---------- | --------- | ----------------------------------- |
| `beforeValidate` | After access, before validate     | data       | no        | Derive/normalize fields             |
| `beforeChange`   | After validate, before persist    | data       | no        | Compute side data, set timestamps   |
| `afterChange`    | After persist, before read        | no         | yes       | Enqueue jobs, revalidate, webhooks  |
| `afterRead`      | After field access, before return | doc        | no        | Shape output, attach computed reads |
| `beforeRead`     | Before adapter read               | query      | no        | Inject filters on `find`/`findByID` |

Two rules keep hooks predictable. First, mutation hooks (`beforeValidate`, `beforeChange`) return the next working value; observer hooks (`afterChange`) do not, which prevents accidental post-commit data drift. Second, `afterChange` runs inside the same transaction as the write, so a throw rolls the operation back — side effects that must survive commit belong in the queue, enqueued from `afterChange` and run after the transaction settles. This is stricter and safer than Payload, where afterChange hooks routinely fire outside the write transaction and can leave half-applied side effects.

Field-level hooks run within the document stage for their field only, in declaration order, and receive the sibling field values for cross-field logic. Errors thrown from any hook are normalized to `KernelError` and propagate up through the transport layer with the originating `requestId` attached.

## Open questions

- **Per-operation middleware overrides.** Should a collection be able to add a middleware link that runs only for its own operations, or does that blur the line between middleware (transport) and hooks (operation)? Leaning toward keeping middleware global and pushing per-collection logic into hooks.
- **Hook concurrency.** Hooks in an array currently run sequentially. Parallelizing independent observer hooks (`afterChange`) could cut latency, but ordering guarantees are easier to reason about serial. Needs a benchmark before deciding.
- **Transaction boundary for batch writes.** For `updateMany`, do we wrap the entire batch in one transaction (atomic, but long-held locks) or chunk it? Likely a configurable strategy per adapter.
