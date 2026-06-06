# Runtime & Server Model

KernelCMS runs as a single operation core wrapped by a thin, runtime-specific host. The same code that powers the Local API in-process powers REST, GraphQL, and typed RPC over the wire — there is no second implementation. This document specifies the server-function model that core exposes, the host adapters that bind it to Node, Bun, and edge runtimes, how request handlers are composed from middleware, and what we do about cold starts. The unifying idea: the host adapter is the *only* runtime-aware code in the stack, and everything above it is a pure function of `(operation, input, context)`.

## The server-function model

Every capability in KernelCMS — `find`, `findByID`, `create`, `update`, `delete`, `count`, plus auth and custom operations — is a server function. A server function is a typed async function that takes a fully-resolved `RequestContext` and returns a typed result. TanStack Start is what turns these into network-callable endpoints; the same function called directly is the Local API.

```ts
// @kernel/server
export interface ServerFunction<TInput, TOutput> {
  operation: OperationName            // 'find' | 'create' | ...
  collection?: string                 // undefined for global/custom ops
  handler: (ctx: RequestContext, input: TInput) => Promise<TOutput>
}

export interface RequestContext {
  config: ResolvedConfig              // from kernel.config.ts
  db: AdapterClient                   // @kernel/db contract
  user: AuthUser | null               // resolved by @kernel/auth
  locale: string
  fallbackLocale: string | null
  transaction: TxHandle | null
  req: KernelRequest                  // runtime-neutral request
  runtime: 'node' | 'bun' | 'edge'
}
```

The Local API and the RPC surface call the *identical* `handler`. The difference is purely how `RequestContext` is assembled and how the result is serialized.

```ts
// In-process: full type inference, no serialization, no HTTP
const posts = await kernel.find({
  collection: 'posts',
  where: { status: { equals: 'published' } },
  depth: 2,
})

// Over the wire: TanStack Start server function, typed via @kernel/client
const posts = await client.posts.find({
  where: { status: { equals: 'published' } },
  depth: 2,
})
```

Both paths return `Post[]` with identical static types. This is where KernelCMS diverges from the field. Payload's Local API is good but the REST and GraphQL layers re-derive their own request handling; Strapi's "services" and "controllers" are separate layers you wire by hand; Sanity's hosted query layer (GROQ) has no in-process equivalent you run yourself. KernelCMS collapses all of this into one set of server functions with one `RequestContext`.

### One query language, every surface

Because every surface calls the same handler, the query language — `where`, `sort`, pagination, and `depth` (relationship population) — is defined once in `@kernel/core` and shared. REST query strings, GraphQL arguments, and RPC payloads all parse into the same internal `Query` object before the handler ever sees them. See Query Language for the grammar.

## Host adapters for Node, Bun, and edge

A **host adapter** is the boundary between a runtime's native server primitives and KernelCMS's runtime-neutral `KernelRequest`/`KernelResponse`. Each adapter does three things: translate the incoming request to `KernelRequest`, invoke the handler pipeline, and serialize `KernelResponse` back to the runtime's native response type. Nothing else in the codebase imports `node:http`, Bun globals, or `Request`/`Response` from a Fetch runtime directly.

```ts
// @kernel/server
export interface HostAdapter {
  name: 'node' | 'bun' | 'edge'
  toKernelRequest(native: unknown): KernelRequest
  fromKernelResponse(res: KernelResponse): unknown
  // Capabilities the runtime supports
  capabilities: {
    streaming: boolean
    fileSystem: boolean
    longRunning: boolean        // background tasks after response
    nativeCrypto: boolean
  }
}
```

The adapter is selected in `kernel.config.ts` or auto-detected. Most users never touch it; you set it when you deploy to a runtime that can't be sniffed reliably.

```ts
// kernel.config.ts
import { defineConfig } from '@kernel/core'
import { postgres } from '@kernel/db-postgres'
import { edge } from '@kernel/server/adapters'

export default defineConfig({
  serverURL: 'https://cms.example.com',
  runtime: edge(),                 // node() | bun() | edge()
  db: postgres({ url: process.env.DATABASE_URL }),
  collections: [Posts, Media, Users],
})
```

The three adapters differ along axes that matter for both correctness and performance:

| Concern | `node()` | `bun()` | `edge()` |
| --- | --- | --- | --- |
| Request primitive | `IncomingMessage` | Fetch `Request` | Fetch `Request` |
| Response streaming | Yes (`Readable`) | Yes (web streams) | Yes (web streams) |
| Filesystem storage | Yes | Yes | No — must use object storage |
| Long-running work after response | Yes | Yes | `waitUntil()` only |
| Native crypto | `node:crypto` | Web Crypto | Web Crypto |
| Driver constraint | Any pg driver | Any pg driver | HTTP/WebSocket driver only |
| Typical cold start | Warm (long-lived) | Warm (long-lived) | 5–50 ms per isolate |

```
                 ┌──────────────────────────────┐
   native req →  │  HostAdapter.toKernelRequest │
                 └──────────────┬───────────────┘
                                ▼
                 ┌──────────────────────────────┐
                 │   Handler pipeline (shared)  │  ← runtime-agnostic
                 │   auth → access → op → hooks │
                 └──────────────┬───────────────┘
                                ▼
                 ┌──────────────────────────────┐
   native res ←  │ HostAdapter.fromKernelResponse│
                 └──────────────────────────────┘
```

The edge adapter carries hard constraints, and KernelCMS surfaces them at config-load time rather than at runtime. If you select `edge()` with `@kernel/db-postgres` configured for a TCP driver, the config validator fails the build with a message telling you to switch to the HTTP/WebSocket driver. Filesystem-backed `@kernel/storage` adapters are rejected the same way. This is the opposite of Strapi, whose Node-only assumptions (local uploads, TCP database connections, `process`-bound plugins) make edge deployment effectively impossible without forking. KernelCMS treats edge as a first-class target and refuses to let you ship a config that can't run there.

### Bun specifics

The Bun adapter uses `Bun.serve` and web-standard `Request`/`Response`, so it shares most of its code path with the edge adapter. The difference is capability flags: Bun reports `fileSystem: true` and `longRunning: true`, so filesystem storage and post-response background jobs work the way they do under Node. We default Bun to the same database drivers as Node.

## Handler composition

A request handler is a composition of middleware around the operation. Middleware is ordered, typed, and each layer can short-circuit. The pipeline is identical regardless of host adapter and regardless of whether the call arrived via REST, GraphQL, or RPC — the only thing that changes upstream is how the `Query` was parsed.

```ts
// @kernel/server
export type Middleware = (
  ctx: RequestContext,
  next: () => Promise<KernelResponse>,
) => Promise<KernelResponse>
```

The default pipeline, in order:

1. **`requestContext`** — builds `RequestContext`, resolves locale and transaction handle.
2. **`authenticate`** — `@kernel/auth` resolves `ctx.user` from cookie/JWT/API key, or `null`.
3. **`rateLimit`** — per-route limits; stricter on auth operations. Returns `429` on breach.
4. **`accessControl`** — evaluates operation-level access *before* touching the database.
5. **`validate`** — parses and validates the `Query` and document payload.
6. **`operation`** — the server function handler runs, populating relationships to `depth`.
7. **`fieldAccess`** — strips fields the user can't read on the way out.
8. **`serialize`** — produces `KernelResponse` for the adapter.

Access control runs at three levels — operation, document, and field — and the pipeline reflects that: operation access gates entry (step 4), document access is enforced inside the operation as `where` constraints merged into the query, and field access filters the response (step 7). This three-level model mirrors Payload's access functions, but KernelCMS evaluates them as ordinary middleware you can inspect, reorder within constraints, and extend.

```ts
// kernel.config.ts — composing custom middleware
import { defineConfig } from '@kernel/core'

export default defineConfig({
  server: {
    middleware: [
      // Runs before the default pipeline's auth step
      { phase: 'before:authenticate', handler: requestIdMiddleware },
      // Runs after access control, before the operation
      { phase: 'after:accessControl', handler: tenantScopeMiddleware },
    ],
  },
})
```

Hooks (`beforeChange`, `afterRead`, `beforeValidate`, and the rest) live *inside* the `operation` step rather than as outer middleware, because they need the resolved document and the open transaction. Middleware wraps the request; hooks wrap the document mutation. Keeping them distinct avoids the Strapi trap where lifecycle hooks and route middleware blur together and ordering becomes folklore.

### Errors

Every layer throws typed errors that extend `KernelError`, never raw `throw new Error()`. The `serialize` middleware maps them to status codes consistently across REST, GraphQL, and RPC, so a `ValidationError` is `422` everywhere and a `ForbiddenError` is `403` everywhere. See Error Model.

## Cold-start considerations

Cold start matters on edge and serverless, where each isolate may be created fresh per request burst. KernelCMS's target is **sub-50 ms cold start to first byte** on edge for a read operation, and we engineer toward it deliberately.

The dominant costs at cold start are: (1) parsing and resolving `kernel.config.ts`, (2) building the GraphQL schema, and (3) opening a database connection. We address each:

- **Config resolution is build-time, not request-time.** `kernel build` compiles `kernel.config.ts` into a serialized `ResolvedConfig` artifact. At runtime the host loads the artifact; it does not re-run user config code. This removes user-land import graphs from the hot path entirely.
- **GraphQL schema is precompiled.** The schema is generated during `kernel build` and shipped as an artifact. The REST and RPC surfaces need no schema build at all — they read directly from `ResolvedConfig`. So an API that only uses REST/RPC pays zero GraphQL cost.
- **Database connections use HTTP/WebSocket drivers on edge**, which avoid TCP handshake-per-isolate cost and pool at the driver/proxy layer. The adapter contract exposes `connect()` lazily, so a request that never hits the database (a cache hit, a `204`) never opens a connection.
- **Lazy operation loading.** Server functions are loaded per-operation on first use within an isolate, not eagerly. A read-only isolate never loads the write path.

```
Cold-start budget (edge, read op, p50 target)
─────────────────────────────────────────────
isolate boot ................ ~5 ms   (runtime)
load ResolvedConfig artifact  ~3 ms
auth (JWT verify, Web Crypto) ~2 ms
db query (HTTP driver) ...... ~15 ms
serialize + respond ......... ~3 ms
─────────────────────────────────────────────
                              ~28 ms to first byte
```

For long-lived Node and Bun hosts, cold start is a non-issue after the first request — the process stays warm and the artifact stays resident. The win there is the same artifact model paying off as low steady-state memory: no config re-evaluation, no schema rebuild on reload. This is a sharp contrast with Strapi, which rebuilds significant server state on boot and is impractical to run in a per-request serverless model. Sanity sidesteps the question by being hosted-only; KernelCMS gives you the hosted option (KernelCMS Cloud) *and* a runtime lean enough to self-host on edge.

## Open questions

- **Streaming responses for large list queries.** All three adapters support streaming, but the serialization layer currently buffers full result sets. Whether to stream `find` results (and how that interacts with `depth` population) is undecided.
- **`waitUntil` abstraction.** Node and Bun can run post-response work freely; edge requires `waitUntil()`. We need a single `ctx.background()` API that maps to all three without leaking the edge constraint — the exact contract (and what happens when a Node host is asked to run "background" work) is still open.
- **Per-operation isolate warming on Cloud.** Whether KernelCMS Cloud should pre-warm write-path isolates for tenants with predictable traffic, or rely purely on lazy loading, is a Cloud-side decision not yet settled.
