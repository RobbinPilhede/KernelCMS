# System Architecture Overview

KernelCMS is organized as four cooperating layers — **core**, **server**, **admin**, and **cloud** — that share one operation core and one type graph end to end. Content is modeled in code via `kernel.config.ts`, the config compiles into a runtime schema, and every API surface (REST, GraphQL, Local, and typed RPC) is generated from that single source. This document describes the layer boundaries, the responsibilities each subsystem owns, and how a request flows from a TanStack admin form down to a Drizzle write and back. Where Payload, Sanity, and Strapi made a structural choice we deliberately diverge from, that contrast is called out inline.

## Layer diagram

The stack reads bottom-up: infrastructure adapters at the floor, a pure operation core above them, transport surfaces wrapping the core, and the admin/client/cloud consumers on top.

```
┌──────────────────────────────────────────────────────────────┐
│  CONSUMERS                                                     │
│  @kernel/admin (TanStack Start app) · @kernel/client · Cloud  │
└───────────────┬──────────────────────────────────┬───────────┘
                │  typed RPC / REST / GraphQL        │
┌───────────────▼──────────────────────────────────▼───────────┐
│  SERVER (@kernel/server)                                      │
│  TanStack Start host · @kernel/rest · @kernel/graphql ·       │
│  @kernel/rpc · auth middleware · access-control evaluation    │
└───────────────────────────┬──────────────────────────────────┘
                            │  Local API (in-process operations)
┌───────────────────────────▼──────────────────────────────────┐
│  CORE (@kernel/core)                                          │
│  config compiler · field registry · validation · hooks ·     │
│  query language (where/sort/pagination/depth) · versions     │
└───────────────────────────┬──────────────────────────────────┘
                            │  Adapter contract
┌───────────────────────────▼──────────────────────────────────┐
│  ADAPTERS (swappable)                                         │
│  db · storage · auth · email · search · cache · queue        │
│  @kernel/db-postgres │ -sqlite │ -mysql │ -mongodb · ...     │
└──────────────────────────────────────────────────────────────┘
```

The rule that makes this tractable: **dependencies point downward only.** `@kernel/core` knows nothing about HTTP, React, or Drizzle. The server layer knows about transports but not React. The admin knows about transports and React but never reaches an adapter directly. This is the inversion Strapi blurs — its controllers, services, and the database layer are entangled enough that swapping the ORM is a fork, not a config change. In KernelCMS the only thing that touches an adapter is the core, through one contract.

See [the adapter contract](../03-persistence/00-persistence-overview-and-adapter-contract.md) and the query language reference for the two interfaces that anchor this diagram.

## The core layer (`@kernel/core`)

The core is a pure, transport-agnostic library. Given a compiled config and an adapter, it exposes the **Local API** — the canonical set of operations every other surface delegates to:

```ts
import { createKernel } from '@kernel/core'
import config from './kernel.config'

const kernel = await createKernel(config)

// The same function the REST route, GraphQL resolver, and RPC handler all call.
const post = await kernel.create({
  collection: 'posts',
  data: { title: 'Hello', status: 'draft' },
  locale: 'en',
  user, // drives access control + field filtering
})

const results = await kernel.find({
  collection: 'posts',
  where: { and: [{ status: { equals: 'published' } }, { author: { equals: user.id } }] },
  sort: '-publishedAt',
  depth: 2,
  pagination: { limit: 20, page: 1 },
})
```

`createKernel` does the expensive work once: it compiles `kernel.config.ts` into a runtime schema, builds the **field registry** (resolving every field type — including `blocks`, `array`, `relationship`, `richText`, and custom types — into validators, serializers, and storage shapes), wires the **hook pipeline**, and binds the **query language** compiler. The config is the single source of truth; nothing downstream may invent fields the core hasn't registered.

Core responsibilities:

| Concern            | What the core owns                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Config compilation | `kernel.config.ts` → runtime schema + generated TS types                                                           |
| Operations         | `find`, `findByID`, `create`, `update`, `delete`, `count` for collections; `findGlobal`/`updateGlobal` for globals |
| Validation         | sync, async, and cross-field validators per field type                                                             |
| Access control     | operation-, document-, and field-level checks, evaluated centrally                                                 |
| Hooks              | `beforeValidate`, `beforeChange`, `afterChange`, `beforeRead`, `afterRead`, `afterDelete`                          |
| Versions & drafts  | autosave snapshots, draft/published split, version history                                                         |
| Localization       | per-field locale resolution and fallback                                                                           |
| Query language     | one `where`/`sort`/`pagination`/`depth` shape, compiled per adapter                                                |

Because the core is in-process, the Local API has **zero serialization cost and full type inference** — calling `kernel.find` returns `Post[]`, not `unknown`. This is the same idea Payload's Local API exposes, but in KernelCMS the Local API is not a parallel path bolted beside REST; it _is_ the path. REST, GraphQL, and RPC are thin shells over it, so there is exactly one place where access control and validation run. Sanity, by contrast, centralizes logic in a hosted dataset with GROQ; you do not get an in-process, fully typed operation core you can call from a server function.

## The server layer (`@kernel/server`)

The server hosts the core inside **TanStack Start** and exposes it over the wire. It owns transports, request authentication, and the translation between an HTTP request and a Local API call.

```ts
// kernel.config.ts (excerpt) — the server reads this to mount surfaces
import { defineConfig } from '@kernel/core'
import { postgresAdapter } from '@kernel/db-postgres'
import { s3Storage } from '@kernel/storage'

export default defineConfig({
  db: postgresAdapter({ url: process.env.DATABASE_URL! }),
  storage: s3Storage({ bucket: 'media' }),
  collections: [Posts, Media, Users],
  globals: [SiteSettings],
  server: {
    rest: { enabled: true, prefix: '/api' },
    graphql: { enabled: true, path: '/graphql' },
    rpc: { enabled: true }, // TanStack Start server functions
  },
})
```

Three packages render the surfaces, all backed by the identical core operations:

- **`@kernel/rest`** generates resource routes (`GET /api/posts`, `POST /api/posts`, `PATCH /api/posts/:id`) with the shared query language passed as search params.
- **`@kernel/graphql`** generates a schema and resolvers from the same config; each resolver is a one-liner that forwards to `kernel.find`/`kernel.create`.
- **`@kernel/rpc`** exposes the Local API as **typed RPC via TanStack Start server functions**, so the admin and `@kernel/client` call operations with the exact input/output types the core inferred — no codegen drift, no hand-written DTOs.

Auth (`@kernel/auth`) runs as server middleware: it resolves the request into a `user`, and that `user` is threaded into every core call so access control evaluates server-side, on by default. This is a hard line — the admin never decides authorization; it only renders what the server returns after field-level filtering. Strapi’s role/permission plugin lives at the route layer and can be bypassed if you write a custom controller that forgets the policy. KernelCMS evaluates access in the core, so _every_ surface inherits it for free.

## The admin layer (`@kernel/admin`)

The admin is a **React application on TanStack Start**, config-driven end to end. It never imports an adapter or the core directly; it talks to the server over typed RPC (and uses REST/GraphQL only for external consumers). Each TanStack library maps to a concrete admin job:

| Library          | Admin responsibility                                               |
| ---------------- | ------------------------------------------------------------------ |
| TanStack Start   | SSR, server functions, routing for the admin host                  |
| TanStack Router  | type-safe routes + search-param state for list filters             |
| TanStack Query   | all fetching, caching, and invalidation against RPC                |
| TanStack Table   | collection list views: sort, filter, column sizing, virtualization |
| TanStack Form    | document edit forms, per-field binding and validation              |
| TanStack Store   | lightweight reactive UI state (palette, panels, theme)             |
| TanStack Virtual | virtualized long lists and long documents                          |
| TanStack DB      | optional reactive client collections for live/offline editing      |

The field registry built in the core has a UI mirror in `@kernel/ui`: each field type ships a renderer, so the edit form is assembled from config, not hand-coded per collection. Validation is shared — the same validator definition runs client-side in TanStack Form for instant feedback and server-side in the core as the authority. Payload also drives its admin from config; KernelCMS’s wedge is that the _entire_ admin runtime is TanStack, so list virtualization, form state, routing, and cache invalidation are one coherent system rather than a grab-bag of libraries.

## The cloud layer (`@kernel/cloud`)

`@kernel/cloud` packages the same server for **KernelCMS Cloud**, the managed multi-tenant platform. It does not replace the core — it wraps it with tenant isolation, billing, observability, backups, and a global content CDN. The critical guarantee is **portability**: because content and config live in `kernel.config.ts` plus adapter-owned data, a project moves between self-host and Cloud with no rewrite. This is the anti-lock-in answer to Sanity, where your data lives in their hosted datasets and leaving means an export-and-reimplement migration.

```
self-host:  kernel.config.ts ──► @kernel/server ──► your Postgres/S3
cloud:      kernel.config.ts ──► @kernel/cloud  ──► managed multi-tenant + CDN
                  ▲ same config, same operations, portable both directions
```

## End-to-end data flow

A draft save from the admin, traced through every layer:

```
[Admin] TanStack Form onSubmit
   └─► TanStack Query mutation
        └─► typed RPC (TanStack Start server function)  ── @kernel/rpc
             └─► auth middleware resolves `user`        ── @kernel/auth
                  └─► kernel.update({ collection, id, data, user })  ── @kernel/core
                       ├─ access control (operation + document + field)
                       ├─ beforeValidate → validate → beforeChange hooks
                       ├─ version snapshot (autosave) written
                       └─► Adapter.update(...)           ── @kernel/db-postgres → Drizzle
                            └─ SQL via parameterized query
                  ◄── afterChange + afterRead hooks, field-level read filtering
        ◄── typed result (Post)
   ◄── TanStack Query invalidates list + document keys; UI re-renders
```

The same path serves a public REST read — only the entry shell differs (`@kernel/rest` instead of `@kernel/rpc`); the core operation, access checks, and adapter call are byte-for-byte identical. That single-core property is what keeps REST, GraphQL, Local, and RPC from drifting in behavior, which is the failure mode where a CMS’s REST and GraphQL endpoints disagree about what a user is allowed to read.

## Subsystem responsibilities at a glance

| Subsystem  | Package                                          | Owns                                                  | Must not                                   |
| ---------- | ------------------------------------------------ | ----------------------------------------------------- | ------------------------------------------ |
| Core       | `@kernel/core`                                   | operations, validation, access, hooks, query language | touch HTTP, React, or a concrete DB driver |
| Transports | `@kernel/rest`, `@kernel/graphql`, `@kernel/rpc` | request ↔ operation translation                       | re-implement access control                |
| Auth       | `@kernel/auth`                                   | resolve `user`, sessions, strategies                  | be consulted client-side as the authority  |
| Adapters   | `@kernel/db-*`, `@kernel/storage`, …             | persistence, blobs, queues, search                    | leak driver types into the core API        |
| Admin      | `@kernel/admin`, `@kernel/ui`                    | config-driven UI, rendering, UX                       | call adapters or run authorization         |
| Client     | `@kernel/client`                                 | typed fetch for frontends                             | bypass access control                      |
| Cloud      | `@kernel/cloud`                                  | multi-tenant hosting, billing, CDN                    | break config/data portability              |

For the persistence contract every `@kernel/db-*` package implements, see [the adapter contract](../03-persistence/00-persistence-overview-and-adapter-contract.md). For how generated types flow from config to client, see [config-as-code](./adr/0003-config-as-code.md).

## Open questions

- **Hook execution model under RPC batching** — whether `afterChange` hooks that enqueue work (`@kernel/queue`) should run inline or be deferred to a queue worker by default is still undecided; the trade-off is latency vs. delivery guarantees.
- **TanStack DB sync boundary** — for live/offline admin, where the authoritative access-control re-check happens when a client-side collection reconciles is open: re-validate every mutation server-side on flush (safe, chatty) vs. trust a signed delta (fast, riskier).
- **GraphQL depth vs. `depth` query param** — reconciling GraphQL’s native selection-set depth with the core’s `depth` relationship-resolution parameter needs a single defined precedence rule before 1.0.
