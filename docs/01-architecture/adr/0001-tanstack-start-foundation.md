# ADR 0001: TanStack Start as the Foundation

**Status:** Accepted · **Date:** 2026-05-30 · **Deciders:** Core architecture group

KernelCMS builds its entire runtime — the API host and the admin application — on TanStack Start. This ADR records why we picked Start over Next.js and Remix, what that buys us, and what it costs us. The short version: Start is the only framework whose primitives (server functions, type-safe routing, a first-party data/cache layer) line up one-to-one with the surfaces a headless CMS must expose, so we can deliver end-to-end type safety from `kernel.config.ts` to a rendered admin field without bolting on a second framework or a code-generation step.

## Context

A headless CMS is two products wearing one repository:

1. **An API host.** It serves REST, GraphQL, and a typed RPC surface generated from content config, plus auth, file handling, and webhooks. It runs on Node, Bun, or an edge runtime.
2. **An admin application.** A React SPA-with-SSR that renders collection list views, document edit forms, a media library, and live preview — all driven by the same config.

Payload couples these with a custom Express/Fastify server and a Next.js admin mounted at a route. Strapi runs a bespoke Koa server with a separately bundled React admin. Sanity splits the hosted Content Lake API from a Vite-built Studio. In every case the server framework and the admin framework are different stacks glued at the seam, and the type contract between them is reconstructed by codegen (Payload's generated types, Sanity's typegen) rather than inferred.

KernelCMS's wedge is the opposite bet: **one stack, end to end, with types that flow rather than regenerate.** For that to hold, the framework under both halves must natively provide:

- Server-side rendering and routing for the admin SPA.
- A server-function mechanism that is callable in-process *and* over the wire with the same signature — this is how the Local API and the typed RPC surface stay identical (see [the Local API and RPC design](../../05-api/03-typed-rpc-and-local-api.md)).
- Type-safe routing and search-param state for deep-linkable admin URLs.
- A data-fetching and cache layer good enough to run the whole admin without a bespoke client.

```
                    ┌──────────────────── TanStack Start ────────────────────┐
   kernel.config.ts │   server functions   ·   router   ·   SSR / streaming   │
   (collections,    │                                                         │
    globals,        │   ┌── API host ──────────┐    ┌── admin app ─────────┐  │
    adapters)  ───►  │   │ REST · GraphQL · RPC │    │ Table · Form · Query │  │
                    │   │ auth · uploads · hooks│    │ Router · Store · …   │  │
                    │   └──────────┬───────────┘    └──────────┬───────────┘  │
                    └──────────────┼───────────────────────────┼─────────────┘
                                   └────── @kernel/core ────────┘
                                      (one operation core)
```

The framework choice constrains everything downstream — the deployment story, the type-safety guarantees in [the type-safety tenet](../07-content-schema-and-type-generation.md), and whether a plugin author writes one set of route conventions or two. It is the highest-leverage decision in the project, which is why it is ADR 0001.

## Decision

**Adopt TanStack Start as the single foundation for both `@kernel/server` and `@kernel/admin`.** Concretely:

| Concern | TanStack primitive | KernelCMS usage |
|---|---|---|
| SSR, streaming, routing host | **TanStack Start** | Boots the admin app and the API host from one server |
| Admin routing, search-param state | **TanStack Router** | Type-safe `/collections/$slug` routes, filter state in the URL |
| Server ↔ client calls | **Start server functions** | The RPC transport for the Local API |
| Data fetching, cache, invalidation | **TanStack Query** | Every admin and `@kernel/client` read/write |
| List views | **TanStack Table** | Collection lists: sort, filter, column sizing, virtualization |
| Edit forms | **TanStack Form** | Document forms, per-field binding and validation |
| Reactive UI state | **TanStack Store** | Command palette, selection, dirty-tracking |
| Long lists / documents | **TanStack Virtual** | Virtualized tables and block editor |
| Live/offline collections | **TanStack DB** | Optional reactive client collections |

The operation core lives in `@kernel/core` and is framework-agnostic. Start is the *delivery mechanism*, not the home of business logic — every operation (`find`, `findByID`, `create`, `update`, `delete`) is a plain function over the Adapter contract. The same function is exposed three ways:

```ts
// @kernel/core — one operation, transport-agnostic
export async function find<T extends CollectionSlug>(
  args: FindArgs<T>,
  ctx: OperationContext,
): Promise<PaginatedDocs<DataFromSlug<T>>> { /* … */ }
```

```ts
// @kernel/rpc — wrapped as a Start server function. In-process when SSR,
// a typed fetch when called from the browser. Identical signature both ways.
import { createServerFn } from '@tanstack/react-start'
import { find } from '@kernel/core'

export const findFn = createServerFn({ method: 'POST' })
  .validator((args: FindArgs<CollectionSlug>) => args)
  .handler(({ data, context }) => find(data, context.kernel))
```

A realistic `kernel.config.ts` shows where the config-as-code source of truth meets the Start runtime:

```ts
import { defineConfig } from '@kernel/core'
import { postgresAdapter } from '@kernel/db-postgres'
import { s3Storage } from '@kernel/storage'
import { Posts } from './collections/Posts'
import { Settings } from './globals/Settings'

export default defineConfig({
  serverURL: process.env.KERNEL_SERVER_URL,
  db: postgresAdapter({ connectionString: process.env.DATABASE_URL! }),
  storage: s3Storage({ bucket: 'media', region: 'eu-north-1' }),
  collections: [Posts],
  globals: [Settings],
  admin: { livePreview: { enabled: true } },
  // `@kernel/server` mounts this config onto a TanStack Start handler.
})
```

`@kernel/server` reads this config and registers the Start route tree: server functions for RPC, a REST handler tree, and a single GraphQL endpoint — all from one config object, no second build step. The admin (`@kernel/admin`) is the same Start app's route tree under `/admin`, consuming those server functions through TanStack Query.

## Consequences

**Positive.**

- **One type graph, zero codegen for RPC.** Because the RPC layer *is* Start server functions, the type returned by `find` in `@kernel/core` is the type the admin receives — inference, not generation. Payload and Sanity both ship a typegen step that drifts the moment config changes ahead of a rebuild; we delete that whole failure mode.
- **The Local API is free.** "Local API" in Payload/Strapi means a separate in-process client. For us it is the same `@kernel/core` function the server function wraps. Calling it during SSR is a normal function call; calling it from the browser routes through the Start transport. No `unstable_` flags, no second SDK.
- **Shared conventions for plugins.** A `@kernel/plugin-sdk` author learns one router model, one server-function model, one Query model. Compare Strapi, where a plugin spans a Koa backend and a Vite admin with separate conventions.
- **Coherent deployment.** A single Start build targets Node, Bun, or edge, so the [deployment matrix](../../10-cloud-operations/00-deployment-models-self-host-vs-cloud.md) describes one artifact, not "server here, admin there."

**Negative / accepted risk.**

- **Maturity.** TanStack Start reached 1.0 more recently than Next.js or Remix. We accept a thinner ecosystem of recipes and hosting presets in exchange for the architectural fit. Mitigation: we own the server entry and pin Start versions per release.
- **Smaller hiring pool.** Fewer engineers have shipped Start than Next.js. Mitigation: the React, Query, Table, and Form APIs are widely known; only the Start-specific glue is new, and it is small.
- **We co-evolve with TanStack.** If Start's server-function API changes, our RPC transport changes. We treat `@kernel/rpc` as the single adapter seam so a Start API shift is contained to one package, not sprayed across the admin.

**Neutral.**

- React-only for the admin. Acceptable — the admin is opinionated by design and not a general SDK. The delivered content via REST/GraphQL/RPC is framework-agnostic for *consumers*.

## Alternatives Considered

### Next.js (App Router)

Next.js is Payload's admin host and the default mental model for React SSR, so it was the obvious candidate.

| Criterion | Next.js | Why it lost |
|---|---|---|
| Typed RPC | Server Actions are POST-only, untyped at the boundary, mutation-flavored | We need typed reads *and* writes with inferred return types — the heart of the Local API |
| Routing types | Type-safe routing is opt-in and partial | Start + Router gives fully typed routes and search params out of the box |
| Data layer | None first-party; pair with React Query anyway | We standardize on TanStack Query regardless, so Next adds a framework without removing one |
| Runtime coupling | App Router leans on the React Server Components/Webpack-Turbopack model | Heavier, more opinionated runtime than a CMS server needs |

Server Actions are the closest analog to what we want, but they are designed for form mutations, not a typed query API spanning `find`, `findByID`, and aggregations. We would end up reimplementing typed RPC on top of Actions — exactly the bespoke layer Start lets us avoid. Next.js remains a fully supported *consumer* runtime via `@kernel/client`; it is just not our foundation.

### Remix

Remix (now folded into the React Router lineage) has the cleanest server/loader story of the three and was the strongest contender.

- **Loaders/actions are not typed RPC.** They are route-scoped data conventions keyed to a URL, not callable functions with inferred signatures. Our admin needs to call `find` from a command palette, a relationship field, and a live-preview iframe — none of which map cleanly to a route loader.
- **No first-party Table/Form/Virtual.** We use TanStack Table, Form, and Virtual heavily; with Remix they are external, whereas with Start they are siblings sharing release cadence and types.
- **Search-param state.** Start + Router model filter/sort/pagination as typed search params natively — exactly the shape of our shared query language (`where`/`sort`/pagination/`depth`). Remix leaves this to hand-rolled `URLSearchParams` parsing.

Remix would have worked for the API host. It would have left the admin assembling the same TanStack libraries we get natively with Start, plus a loader model that fights our config-driven, non-route-bound data access.

### Why not split the stack (Sanity/Strapi model)

We explicitly rejected "best server framework + best admin framework, glued." That is the status quo we are competing against. The glue is where type safety dies and where plugin authors learn two of everything. A single stack is the product thesis, not an implementation convenience.

## Open Questions

- **Edge server functions.** Start server functions on edge runtimes need validation against adapters that assume a long-lived connection pool (`@kernel/db-postgres`). We may restrict edge to read replicas plus HTTP-driver Postgres until pooling on edge is settled.
- **RSC adoption.** Whether to lean into React Server Components inside the admin for heavy read-only views (large list pages) or keep the admin uniformly client-rendered under SSR. Leaning toward uniform client rendering for live-preview consistency; revisit after the performance budget work.
- **Versioning policy with TanStack.** Do we pin Start to exact versions per KernelCMS minor, or track a compatible range? Leaning exact-pin to keep the `@kernel/rpc` seam predictable.
