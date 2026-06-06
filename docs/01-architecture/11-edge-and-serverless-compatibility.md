# Edge & Serverless Compatibility

KernelCMS runs the same operation core on three deployment shapes: long-lived Node/Bun servers, ephemeral serverless functions, and globally-distributed edge runtimes. This document specifies what "edge-compatible" actually means in KernelCMS terms — which APIs the core may touch, which runtime constraints we design against, which database adapters survive a V8-isolate environment, and how we keep cold starts and connection counts under control. The short version: `@kernel/core`, `@kernel/server`, `@kernel/rpc`, `@kernel/rest`, and `@kernel/graphql` are written to the WinterCG Minimum Common Web Platform API, and the database adapter is the one component that decides whether a given deployment can run at the edge.

## The compatibility model

KernelCMS draws a hard line between **portable** packages and **host-bound** packages. Portable packages may only use web-standard globals. Host-bound packages may reach for Node built-ins, but they are never imported by the request path of an edge build.

```
            portable (edge-safe)                 host-bound (Node/Bun only)
  ┌──────────────────────────────────────┐   ┌──────────────────────────────┐
  │ @kernel/core   @kernel/rpc            │   │ @kernel/db-postgres (node-pg) │
  │ @kernel/rest   @kernel/graphql        │   │ @kernel/storage (fs adapter)  │
  │ @kernel/client @kernel/richtext       │   │ sharp image pipeline          │
  │ @kernel/server (request layer)        │   │ local migration runner        │
  └──────────────────────────────────────┘   └──────────────────────────────┘
                    │                                       │
                    └──────────── adapters bridge ──────────┘
```

This is the structural difference from Strapi, whose Koa-based server assumes a Node process, a writable filesystem, and a persistent event loop — it does not run on Cloudflare Workers or Vercel Edge without a rewrite. Payload is closer to us (it ships a Next.js-hosted admin and is increasingly serverless-friendly), but its database layer is still effectively Node-only because it leans on `pg` and `mongoose`. Sanity sidesteps the problem by being a hosted document store you query over HTTP — you never run _their_ server. KernelCMS gives you Sanity-style portability while letting you actually own and run the server, including at the edge.

## Web-standard APIs

Portable packages target the [WinterCG Minimum Common Web Platform API](https://common-min-api.proposal.wintercg.org/). Concretely, the only globals `@kernel/core` and the API surfaces are allowed to reference are: `fetch`, `Request`, `Response`, `Headers`, `URL`, `URLSearchParams`, `ReadableStream`/`WritableStream`/`TransformStream`, `TextEncoder`/`TextDecoder`, `structuredClone`, `crypto`/`crypto.subtle`, `atob`/`btoa`, and the timer functions. TanStack Start's server functions already speak this dialect, so RPC over the wire is web-standard by construction.

The request path never sees a Node `IncomingMessage`. Every handler is `(req: Request) => Promise<Response>`:

```ts
// @kernel/server — the only request contract that exists
import { createHandler } from '@kernel/server'
import config from './kernel.config'

export const handler = createHandler(config)
//    (req: Request) => Promise<Response>

// Cloudflare Workers
export default { fetch: handler }

// Vercel / Netlify Edge
export const GET = handler
export const POST = handler

// Node — the same handler, wrapped by the platform adapter
import { toNodeListener } from '@kernel/server/node'
createServer(toNodeListener(handler)).listen(3000)
```

Three rules enforce this. First, **crypto is Web Crypto**. Password hashing in `@kernel/auth` uses Argon2id/bcrypt through a WASM build at the edge (`crypto.subtle` has no password-hash primitive), and session tokens are signed with `crypto.subtle.sign` HMAC — never Node's `crypto.createHmac`. Second, **no `Buffer` on the request path**; upload bodies are `ReadableStream<Uint8Array>` and `@kernel/storage` adapters consume streams, so a 2 GB upload never materializes in isolate memory. Third, **a lint gate**: `@kernel/eslint-config/edge` bans `node:` imports and the `Buffer`/`process`/`__dirname` globals in portable packages, so a regression fails CI rather than production.

```ts
// kernel.config.ts — declare the runtime so the build can validate
import { defineConfig } from '@kernel/core'

export default defineConfig({
  runtime: {
    target: 'edge', // 'node' | 'bun' | 'edge'
    // build fails if any reachable code touches a Node built-in
    strictWebStandard: true,
  },
})
```

## Runtime constraints

Edge isolates are not small Node servers; they are a different execution model with hard limits. We design `@kernel/core` against the strictest common denominator (Cloudflare Workers) so a build that runs there runs everywhere.

| Constraint                     | Node server | AWS Lambda         | Vercel/Netlify Edge    | Cloudflare Workers   |
| ------------------------------ | ----------- | ------------------ | ---------------------- | -------------------- |
| Filesystem                     | read/write  | read-only + `/tmp` | none                   | none                 |
| Long-lived sockets             | yes         | per-invocation     | no (HTTP/fetch only)   | no (HTTP/fetch only) |
| CPU per request                | unbounded   | up to 15 min       | ~50 ms wall, sub-burst | 5–30 s CPU (plan)    |
| Memory                         | host RAM    | up to 10 GB        | 128 MB                 | 128 MB               |
| Background work after response | yes         | no                 | `waitUntil`            | `waitUntil`          |
| Native addons (`.node`)        | yes         | yes                | no                     | no                   |

The design consequences are concrete:

- **No filesystem.** The default `@kernel/storage` `fs` adapter is host-bound. Edge builds must select an HTTP-based adapter (S3, R2, or a Cloud-managed bucket). The config validator rejects `storage: fsAdapter()` when `runtime.target === 'edge'` with an actionable error.
- **No native addons.** `sharp` (image transforms) and `argon2` native bindings don't load in an isolate. `@kernel/storage` defers transforms to a deferred queue job or an on-the-fly image-resizing CDN, and `@kernel/auth` uses the WASM hashers.
- **Bounded CPU.** Schema-diff migrations, bulk import, and version-history compaction are explicitly **not** request-path operations. They run via `@kernel/cli` (`kernel migrate`) or a queue adapter, never inside a Worker.
- **Deferred work.** Post-response side effects — webhooks, search indexing, cache purges — are scheduled with the platform's `waitUntil` so the `Response` flushes immediately. `@kernel/server` exposes this through `ctx.defer()`, which maps to `waitUntil` at the edge and to a microtask-after-flush on Node.

```ts
afterChange: [
  async ({ doc, ctx }) => {
    ctx.defer(() => searchAdapter.index('posts', doc)) // off the hot path
  },
],
```

## Database driver compatibility

This is the decision that determines whether you can deploy to the edge at all. The blocker is the wire protocol: classic Postgres and MySQL drivers (`pg`, `mysql2`) open raw TCP sockets and assume a persistent connection — neither exists in a V8 isolate. KernelCMS solves this the way the modern ecosystem does, by routing the same Drizzle queries through HTTP/WebSocket drivers, behind one unchanged `Adapter` contract.

| Adapter               | Driver                                       | Node | Edge | Notes                                 |
| --------------------- | -------------------------------------------- | ---- | ---- | ------------------------------------- |
| `@kernel/db-postgres` | `pg` (node-postgres)                         | ✅   | ❌   | TCP; default for self-host            |
| `@kernel/db-postgres` | Neon serverless (`@neondatabase/serverless`) | ✅   | ✅   | HTTP + WebSocket                      |
| `@kernel/db-postgres` | Vercel Postgres / Supabase pooler            | ✅   | ✅   | HTTP fetch driver                     |
| `@kernel/db-sqlite`   | Turso/libSQL (`@libsql/client`)              | ✅   | ✅   | HTTP; ideal for edge-replicated reads |
| `@kernel/db-mysql`    | PlanetScale (`@planetscale/database`)        | ✅   | ✅   | HTTP fetch driver                     |
| `@kernel/db-mysql`    | `mysql2`                                     | ✅   | ❌   | TCP                                   |
| `@kernel/db-mongodb`  | MongoDB driver                               | ✅   | ❌   | TCP; use Atlas Data API at edge       |

Because the SQL adapters are all Drizzle underneath, switching drivers is a config change, not a query rewrite. The same `where`/`sort`/`pagination`/`depth` query language compiles to the same SQL regardless of transport.

```ts
// kernel.config.ts — Postgres over HTTP for the edge
import { defineConfig } from '@kernel/core'
import { postgresAdapter } from '@kernel/db-postgres'
import { neon } from '@neondatabase/serverless'

export default defineConfig({
  runtime: { target: 'edge' },
  db: postgresAdapter({
    // an http/ws driver instance, not a TCP pool
    client: neon(process.env.DATABASE_URL!),
  }),
})
```

The honest trade-off, stated plainly: HTTP drivers add per-query round-trip latency and most do not support interactive multi-statement transactions across requests. KernelCMS handles transactional writes (a document plus its localized rows plus a version-history entry) by batching them into a single round trip where the driver allows it, and by keeping the write graph shallow. This is also where Turso/libSQL with embedded replicas wins for read-heavy edge frontends — reads hit a local replica, writes go to the primary. See [Database Adapters](./adr/0002-drizzle-and-pluggable-db.md) and Query Language for the full contract.

## Cold start and connection pooling

Two failure modes dominate serverless CMS deployments: slow cold starts, and connection-pool exhaustion when hundreds of concurrent function instances each grab a Postgres connection. KernelCMS addresses both at the architecture level.

**Cold start.** The portable packages are tree-shakeable ESM with no top-level side effects, so a typical edge bundle of `@kernel/core` + adapters stays small enough to keep isolate startup in the low single-digit milliseconds. Config is compiled to a static manifest at build time — `kernel build` resolves collections, fields, access functions, and the generated REST/GraphQL schema into a serializable artifact, so there is **no config evaluation at cold start**. This is a real edge over Strapi, which boots a plugin system and content-type registry on every cold start and is consequently painful in serverless.

```
cold start budget (edge bundle)
  parse + instantiate  ~1–3 ms   isolate spins up module
  load static manifest ~0 ms     precompiled at build, no eval
  first DB query       ~RTT      HTTP driver, no handshake
  ────────────────────────────
  first byte           dominated by DB round trip, not framework
```

**Connection pooling.** On a long-lived Node/Bun host, `@kernel/db-postgres` keeps an in-process pool sized to the instance — standard and correct. In serverless, that model is actively harmful: N function instances × M pool size will exhaust Postgres. The rule KernelCMS enforces is:

- **Edge / serverless → external pooler or HTTP driver.** Point at PgBouncer/Neon/Supabase in transaction-pooling mode, or use a driver that is itself stateless over HTTP. The in-process pool size is pinned to 1.
- **Node host → in-process pool**, sized via config.

```ts
db: postgresAdapter({
  client: neon(process.env.DATABASE_URL!),
  pool: {
    // honored only on node target; ignored for http drivers
    max: process.env.NODE_ENV === 'production' ? 10 : 2,
    // serverless guard: refuse to open a TCP pool at the edge
    serverlessSafe: true,
  },
})
```

When `runtime.target` is `edge` or `serverless` and an adapter is configured with a TCP driver and `max > 1`, the config validator fails the build with a pointer to the pooler docs rather than letting you discover the limit under production load. KernelCMS Cloud removes this entirely: its managed Postgres fronts every tenant with a connection proxy, so the connection-count math is handled for you and edge functions scale without touching pool configuration. See [Deployment Targets](../10-cloud-operations/00-deployment-models-self-host-vs-cloud.md) and KernelCMS Cloud.

## Open questions

- **WASM Argon2 at the edge:** Argon2id's memory cost (64 MB+) can approach a Worker's 128 MB ceiling under concurrency. We may cap edge memory parameters and document a recommendation to terminate auth at a Node tier when high-cost hashing is required.
- **Interactive transactions over HTTP:** whether to ship a server-side transaction-broker shim so HTTP drivers get multi-statement transactions, versus restricting edge writes to the batched single-round-trip path.
- **`@kernel/db-mongodb` at the edge:** whether to build a first-class Atlas Data API adapter or treat MongoDB as Node-only and steer edge users to a SQL adapter.
- **Per-route runtime targeting:** allowing read endpoints to run at the edge while write/admin routes run on Node within a single deployment, and how the config and type system express that split cleanly.
