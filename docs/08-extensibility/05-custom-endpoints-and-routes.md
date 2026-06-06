# Custom Endpoints & Routes

KernelCMS auto-generates REST, GraphQL, and typed RPC from your content config, but real applications always need surfaces the generator can't infer: a Stripe webhook receiver, a `/health` probe, a `POST /newsletter/subscribe` that talks to a third-party ESP, a bespoke aggregation that joins three collections. Custom endpoints let you mount your own handlers next to the generated API, inside the same TanStack Start server, sharing the same request context, auth, access control, and Local API. You don't run a sidecar Express app and reverse-proxy it — you register a handler and it becomes a first-class part of the surface.

## Where custom endpoints live

There are two registration scopes, and choosing the right one matters.

| Scope | Mounted at | Use for |
| --- | --- | --- |
| Collection / global endpoints | `/api/:collection/...` | Operations conceptually attached to a content type — `POST /api/orders/:id/refund`, `GET /api/posts/feed.rss` |
| Root endpoints | `/api/...` (or any path) | Cross-cutting concerns — webhooks, health checks, OAuth callbacks, aggregations spanning collections |

Collection-scoped endpoints sit under the collection's base path and inherit its slug, so they read as a natural extension of the generated routes. Root endpoints are free-floating and own their full path. This split mirrors Payload's `endpoints` array on collections plus its top-level `endpoints` config — and we deliberately kept the mental model close, because it's the one piece of Payload's API that developers consistently like. Where we diverge is type safety and context: Payload hands you raw `PayloadRequest` (Express-ish), Strapi makes you wire a route file, a controller, and a policy across three directories, and Sanity doesn't have a server framework at all — you bolt endpoints onto whatever host you deployed (Next.js route handlers, a Lambda). KernelCMS gives you one typed handler signature with the full operation core in scope, regardless of runtime.

```
                 ┌─────────────────────────────────────────┐
  HTTP request   │           TanStack Start host            │
  ───────────►   │                                          │
                 │   ┌───────────────┐   ┌───────────────┐  │
                 │   │  generated     │   │   custom       │ │
                 │   │  REST/GraphQL  │   │   endpoints    │ │
                 │   │  /RPC router   │   │   (yours)      │ │
                 │   └──────┬─────────┘   └──────┬─────────┘ │
                 │          └────────┬───────────┘           │
                 │              KernelContext                │
                 │   (req, user, payload/Local API, db,      │
                 │    access, locale, transaction)           │
                 └─────────────────────────────────────────┘
```

Both kinds of handler receive the same `KernelContext`. That's the whole point: a custom endpoint is not a second-class citizen reaching into internals — it's the same context the generated handlers run on.

## Endpoint registration

Register endpoints in `kernel.config.ts`. Collection endpoints go on the collection; root endpoints go in the top-level `endpoints` array.

```ts
// kernel.config.ts
import { defineConfig, defineCollection } from '@kernel/core'
import { z } from 'zod'

const Orders = defineCollection({
  slug: 'orders',
  fields: [/* … */],
  endpoints: [
    {
      method: 'post',
      path: '/:id/refund',          // → POST /api/orders/:id/refund
      // Optional schema: validated before the handler runs.
      input: z.object({ amount: z.number().int().positive().optional() }),
      handler: async (ctx) => {
        const { id } = ctx.params
        const order = await ctx.local.findByID({
          collection: 'orders',
          id,
          // depth/locale/draft all available
        })
        if (!order) return ctx.notFound()
        // ctx.input is typed as { amount?: number } from the schema above
        const refund = await refundProvider.refund(order.paymentId, ctx.input.amount)
        return ctx.json({ refundId: refund.id }, { status: 202 })
      },
    },
  ],
})

export default defineConfig({
  collections: [Orders],
  endpoints: [
    {
      method: 'get',
      path: '/health',              // → GET /api/health
      auth: false,                  // skip the auth pipeline entirely
      handler: (ctx) => ctx.json({ status: 'ok', uptime: process.uptime() }),
    },
  ],
})
```

The handler signature is a single argument: `(ctx: KernelContext) => Response | Promise<Response>`. We return `Response` (the web standard) rather than a Node `res` object, because TanStack Start runs on Node, Bun, and edge runtimes, and `Response` is the one contract that works everywhere. The `ctx.json()` / `ctx.notFound()` helpers are thin sugar over `Response` so you don't hand-roll headers for the common cases.

### The endpoint descriptor

```ts
interface EndpointDef<TInput = unknown> {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete' | 'options' | 'head'
  path: string                          // path-to-regexp style; ':param' captures
  handler: (ctx: KernelContext<TInput>) => Response | Promise<Response>
  input?: StandardSchemaV1<TInput>      // any Standard Schema validator (Zod, Valibot, ArkType)
  auth?: boolean                        // default true — run auth, populate ctx.user
  rateLimit?: RateLimitRule | false     // override the default public-endpoint limit
  description?: string                   // surfaces in generated OpenAPI / route map
}
```

`input` accepts any [Standard Schema](https://github.com/standard-schema/standard-schema) validator, so you're not married to Zod. When present, the body (or query string for `GET`) is parsed and validated before your handler runs; on failure the request short-circuits with a `422` and a typed error body, and `ctx.input` is inferred as `TInput`. This is the difference from Strapi, where validation lives in a separate, optionally-applied middleware that's easy to forget — here a declared schema is enforced, full stop.

Routes are matched longest-static-prefix first, and an endpoint may not shadow a generated route for the same method and collection; the config loader throws at boot if it detects a collision. Failing loud at startup beats a silently overridden `GET /api/orders/:id`.

## Access to context

`KernelContext` is the object that makes custom endpoints worth using instead of a bare route handler. Everything the generated API has, you have.

| Member | Type | What it gives you |
| --- | --- | --- |
| `ctx.local` | `LocalAPI` | The full in-process operation core — `find`, `findByID`, `create`, `update`, `delete`, `count`. Type-inferred per collection. Respects access control unless you pass `overrideAccess`. |
| `ctx.user` | `AuthUser \| null` | The authenticated principal, populated by the auth pipeline (see below). |
| `ctx.req` | `Request` | The raw web `Request` — headers, URL, method, body stream. |
| `ctx.params` | `Record<string, string>` | Captured path params (`:id` → `ctx.params.id`). |
| `ctx.query` | parsed query | Search params, already decoded. |
| `ctx.input` | `TInput` | Validated body/query when `input` schema is set. |
| `ctx.db` | `Adapter` | The raw database adapter — Drizzle handle for SQL, native driver for MongoDB. Escape hatch for queries the Local API can't express. |
| `ctx.locale` / `ctx.fallbackLocale` | `string` | Resolved from the request, used by `ctx.local` reads. |
| `ctx.transaction` | `<T>(fn) => Promise<T>` | Run multiple operations atomically; the adapter opens a transaction and `ctx.local` calls inside it enlist automatically. |
| `ctx.json`, `ctx.notFound`, `ctx.error`, `ctx.redirect` | helpers | Response constructors. |

Prefer `ctx.local` over `ctx.db`. The Local API enforces access control, runs hooks, applies field-level localization, and returns fully typed documents; dropping to `ctx.db` skips all of that. Reach for `ctx.db` only for genuine aggregations or bulk operations the Local API doesn't model — and when you do, you own the security implications.

```ts
{
  method: 'get',
  path: '/feed',                         // GET /api/posts/feed
  auth: false,
  handler: async (ctx) => {
    // Local API: access control + hooks + typed result
    const { docs } = await ctx.local.find({
      collection: 'posts',
      where: { status: { equals: 'published' } },
      sort: '-publishedAt',
      limit: 20,
      depth: 1,
    })
    return ctx.json({ items: docs.map(toFeedEntry) })
  },
}
```

This is a sharper story than Sanity's. In Sanity you'd write a GROQ query in a serverless function you host yourself, with no shared access layer — the function and the studio don't run in the same process and don't share a security model. Here the feed reads through the exact same operation core the admin and the GraphQL API use, so access rules defined once in [Access Control](../06-auth-security/01-authorization-and-access-control.md) apply uniformly.

## Reusing auth

By default (`auth` defaults to `true`) every custom endpoint runs the standard auth pipeline before your handler: the request's session cookie or `Authorization: Bearer` token is verified by the configured `@kernel/auth` adapter, and `ctx.user` is populated. You don't re-implement token parsing — you read `ctx.user`.

```ts
{
  method: 'post',
  path: '/:id/refund',
  handler: async (ctx) => {
    if (!ctx.user) return ctx.error(401, 'Authentication required')

    // Resource-level authorization — reuse the collection's access rules.
    const can = await ctx.local.canAccess({
      collection: 'orders',
      operation: 'update',
      id: ctx.params.id,
      user: ctx.user,
    })
    if (!can) return ctx.error(403, 'Forbidden')

    // …perform the refund through ctx.local / provider…
    return ctx.json({ ok: true })
  },
}
```

Two distinct gates are at play and it's worth keeping them separate:

- **Authentication** — *who are you.* Handled by the auth pipeline; the result is `ctx.user`. Toggle it off with `auth: false` for public endpoints (webhooks, health, RSS).
- **Authorization** — *are you allowed.* Your responsibility inside the handler, but you reuse the same access functions the generated API uses via `ctx.local.canAccess(...)` or simply by letting `ctx.local` enforce access (omit `overrideAccess`). When you call `ctx.local.update(...)` without `overrideAccess: true`, the collection's `access.update` rule runs exactly as it would for `PATCH /api/orders/:id`.

This is a hard win over Strapi, where a custom route needs a `policies` array referencing a separately-defined policy, and over Payload, where custom endpoints get the request but you still manually call access functions. KernelCMS makes the *default path* the secure one: use `ctx.local` and access control is on; you have to opt out with `overrideAccess: true`, which is greppable in review.

For machine callers that shouldn't carry a user session — a cron job, an internal service — issue a scoped API key through `@kernel/auth` and check it explicitly:

```ts
{
  method: 'post',
  path: '/reindex',
  auth: false,                            // we verify a key, not a user session
  rateLimit: { windowMs: 60_000, max: 2 },
  handler: async (ctx) => {
    const key = ctx.req.headers.get('x-api-key')
    if (!ctx.auth.verifyApiKey(key, { scope: 'search:reindex' })) {
      return ctx.error(401, 'Invalid key')
    }
    await searchAdapter.reindex({ collections: ['posts', 'products'] })
    return ctx.json({ queued: true }, { status: 202 })
  },
}
```

Never compare API keys with `===`. `ctx.auth.verifyApiKey` does a constant-time comparison and looks the key up by hashed value, so a timing side-channel can't leak it.

## Worked examples

### Stripe webhook (public, signature-verified)

Webhooks are unauthenticated in the session sense but must be verified by signature. Disable the auth pipeline, then verify against the raw body — not the parsed one, or the signature check fails.

```ts
// kernel.config.ts → endpoints: [...]
{
  method: 'post',
  path: '/webhooks/stripe',
  auth: false,
  rateLimit: false,                       // Stripe retries; don't throttle it
  handler: async (ctx) => {
    const raw = await ctx.req.text()      // raw body, required for HMAC
    const sig = ctx.req.headers.get('stripe-signature')
    let event: Stripe.Event
    try {
      event = stripe.webhooks.constructEvent(raw, sig!, process.env.STRIPE_WEBHOOK_SECRET!)
    } catch {
      return ctx.error(400, 'Invalid signature')
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object
      await ctx.local.update({
        collection: 'orders',
        where: { stripeSessionId: { equals: session.id } },
        data: { status: 'paid' },
        overrideAccess: true,             // system actor, no user — explicit and reviewable
      })
    }
    return ctx.json({ received: true })
  },
}
```

`overrideAccess: true` is the right call here precisely because there is no user; the signature *is* the authorization. Making that explicit beats Strapi's implicit "the controller runs with full privileges" model.

### Authenticated aggregation with a transaction

A dashboard endpoint that creates an audit record and returns a roll-up atomically.

```ts
{
  method: 'post',
  path: '/close-period',                  // POST /api/invoices/close-period
  handler: async (ctx) => {
    if (!ctx.user || ctx.user.role !== 'finance') {
      return ctx.error(403, 'Finance role required')
    }
    const result = await ctx.transaction(async () => {
      const { docs } = await ctx.local.find({
        collection: 'invoices',
        where: { status: { equals: 'open' } },
        limit: 0,                          // count-only fast path
      })
      await ctx.local.create({
        collection: 'audit-log',
        data: { actor: ctx.user!.id, action: 'period-close', count: docs.length },
      })
      return { closed: docs.length }
    })
    return ctx.json(result)
  },
}
```

If anything inside the callback throws, the adapter rolls the whole thing back — the audit record and any updates vanish together. The same `ctx.transaction` works on Postgres, SQLite, MySQL, and MongoDB (where it maps to a multi-document transaction), because it's defined on the Adapter contract, not on a specific driver.

### Calling your endpoint from the typed client

Custom endpoints are reachable over plain HTTP, but `@kernel/client` can also bind them as typed RPC functions when you export their input/output types, giving the admin and frontends the same end-to-end inference the generated API enjoys. See The Typed Client for how custom endpoint types flow into `createClient`.

## Open questions

- **Endpoint-level OpenAPI/GraphQL surfacing.** Generated routes already produce an OpenAPI document. Should custom endpoints with an `input` schema auto-emit OpenAPI paths (likely yes), and should there be a sanctioned way to extend the generated GraphQL schema from a custom endpoint, or do custom resolvers remain a separate `@kernel/graphql` concern?
- **Per-endpoint middleware composition.** We currently expose `auth`, `input`, and `rateLimit` as declarative flags. Whether to also support an ordered `middleware: []` array (Strapi-style) or keep composition inside the handler is undecided — the risk is reintroducing the multi-file indirection we set out to avoid.
- **Streaming responses.** `Response` supports `ReadableStream`, so SSE and chunked responses work today, but we haven't decided whether to ship first-class helpers (`ctx.stream`, `ctx.sse`) or leave it to the raw web API.
