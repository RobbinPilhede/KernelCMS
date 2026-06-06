# Positioning & Differentiation

KernelCMS competes in a crowded headless-CMS market against Payload, Sanity, and Strapi. We do not win by being a marginally better config-as-code CMS — that is a feature race we would lose to Payload's head start. We win on a structural wedge those incumbents cannot copy without rewriting their foundations: **the entire stack is TanStack-native, and every infrastructure concern is a swappable adapter**. This document fixes the positioning, names the moat, and draws the line around what we deliberately refuse to build.

## The Wedge: TanStack-Native + Choose-Everything

The wedge is two claims working together. Either alone is a feature; together they are a category.

### TanStack-native end to end

Payload runs on Next.js. Strapi ships a Koa server with a React (legacy Webpack/Vite) admin. Sanity runs a bespoke admin and its own GROQ/dataset backend. None of them treat a single client-server data framework as the spine of the whole product. KernelCMS does. Server and admin are one TanStack Start application, and every layer below uses the matching TanStack primitive:

| Concern | TanStack primitive | What it replaces in a typical CMS |
| --- | --- | --- |
| SSR, routing, server functions | TanStack Start | Next.js app router / Koa + custom RPC |
| Admin routing + search-param state | TanStack Router | React Router + ad-hoc query-string parsing |
| Data fetching / cache / invalidation | TanStack Query | bespoke fetch hooks, manual cache busting |
| Collection list views | TanStack Table | hand-rolled tables, third-party grids |
| Document edit forms | TanStack Form | Formik / RHF / custom field state |
| Reactive admin UI state | TanStack Store | Redux / Zustand / context soup |
| Long lists & long documents | TanStack Virtual | windowing libraries bolted on later |
| Live/offline client collections | TanStack DB | nothing — most CMSes have no answer |

This is not branding. It is a coherence property. Because the admin and the API host share TanStack Start server functions, the Local API and the typed RPC surface are the *same* operation core — one is the in-process call, the other is that call over the wire with identical type inference. A field component written with TanStack Form binds to the same validation that the server runs. The wire format that TanStack Query caches in the admin is the wire format `@kernel/client` consumes in your frontend. Payload achieves some of this inside Next; we achieve it across the whole stack because there is one framework family, not three glued together.

```ts
// kernel.config.ts — config-as-code is the single source of truth
import { defineConfig } from '@kernel/core'
import { postgres } from '@kernel/db-postgres'
import { s3 } from '@kernel/storage'
import { Posts, Media } from './collections'

export default defineConfig({
  db: postgres({ url: process.env.DATABASE_URL }),
  storage: s3({ bucket: 'kernel-media', region: 'eu-north-1' }),
  collections: [Posts, Media],
})
```

```ts
// The Local API and typed RPC are one operation core.
import { getKernel } from '@kernel/server'

const kernel = await getKernel()
// In-process, fully inferred — `post.title` is typed from the Posts config.
const post = await kernel.find('posts', { where: { status: { equals: 'published' } }, depth: 1 })

// Over the wire, identical shape, identical inference:
import { createClient } from '@kernel/client'
const client = createClient({ url: 'https://cms.example.com' })
const same = await client.find('posts', { where: { status: { equals: 'published' } }, depth: 1 })
```

### Choose-everything: adapters all the way down

The second half of the wedge attacks the incumbents' biggest weakness: lock-in by default. Sanity decides your datastore (their hosted dataset). Strapi's plugin ecosystem fights its own core on every storage/auth/search choice. Payload is more flexible but still leans heavily on its own conventions. KernelCMS makes **every** infrastructure concern a swappable `@kernel/*` adapter implementing one `Adapter` contract: database, storage, email, auth, search, cache, and queue.

```
┌──────────────────────── kernel.config.ts ────────────────────────┐
│  collections · globals · access · hooks · localization           │
└───────────────────────────────┬──────────────────────────────────┘
                                 │ one Adapter contract per concern
   ┌──────────┬──────────┬───────┴────┬─────────┬────────┬─────────┐
   ▼          ▼          ▼            ▼         ▼        ▼         ▼
  db        storage     auth        email     search   cache     queue
 postgres    s3        oauth       resend     <swap>   redis    <swap>
 sqlite      local     api-keys    smtp        ...      ...       ...
 mysql       gcs        ...
 mongodb
```

```ts
// Swap Postgres for SQLite locally, libSQL at the edge, MongoDB for
// document workflows — no application code changes, only the adapter.
import { sqlite } from '@kernel/db-sqlite'
import { mongodb } from '@kernel/db-mongodb'

db: process.env.EDGE ? sqlite({ url: 'file:local.db' }) : mongodb({ url: process.env.MONGO_URL })
```

Drizzle is the default SQL ORM across Postgres (default), SQLite/libSQL, and MySQL, with migrations generated from schema diffs; the MongoDB adapter covers document-oriented workflows. The promise is concrete: you are never trapped by a decision we made on your behalf. See [The Adapter Contract](../03-persistence/00-persistence-overview-and-adapter-contract.md) and [Database Adapters](../01-architecture/adr/0002-drizzle-and-pluggable-db.md) for the contract surface.

## Moat & Defensibility

A wedge gets you in the door. The moat keeps competitors out after they notice.

**1. Foundational coupling competitors can't cheaply copy.** Payload would have to abandon its Next.js coupling to match the choose-everything story; Strapi would have to rewrite its admin and server simultaneously to become TanStack-native; Sanity's entire business assumes its hosted dataset. Each incumbent's strength is the thing that blocks them from copying our wedge. That asymmetry is the moat.

**2. Type inference as a compounding asset.** End-to-end type safety with zero `any` from `kernel.config.ts` through Local API, RPC, REST/GraphQL codegen, and `@kernel/client` means every collection you add deepens the inference graph. Competitors with stringly-typed query layers (GROQ, Strapi's REST filters) cannot retrofit this without breaking every existing query.

**3. Portability defeats the usual lock-in moat.** Sanity's moat is its hosted platform; the cost of leaving is the moat. We invert it: content and config are always portable between self-host and KernelCMS Cloud. Our moat is *not* lock-in — it's that the OSS core and the Cloud run identical code, so Cloud is strictly more convenient, never a trap. See [Self-Host vs Cloud](../10-cloud-operations/00-deployment-models-self-host-vs-cloud.md).

**4. One query language across every surface.** A single `where` / `sort` / pagination / `depth` language spans Local API, RPC, REST, and GraphQL. Learn it once; it works everywhere. Strapi makes you learn distinct REST and GraphQL filter dialects; this is a daily-friction moat that grows with team size.

**5. The plugin SDK and ecosystem flywheel.** Because adapters share one contract, a community Redis cache adapter or a Typesense search adapter is a small, well-bounded package built on `@kernel/plugin-sdk`. The more adapters exist, the stronger choose-everything becomes — a network effect Strapi has, but ours is type-safe and contract-bounded rather than convention-bound.

## Tagline & Core Messaging

**Tagline:** *The TanStack-native headless CMS. Choose everything.*

Core messaging pillars, in priority order:

1. **TanStack-native, end to end.** Server and admin on one stack — Start, Router, Query, Table, Form, Store, Virtual, DB. No other CMS is.
2. **Choose everything.** Database, storage, email, auth, search, cache, queue — every concern is a swappable adapter. Nothing is hard-wired.
3. **Own it or host it — your call, no lock-in.** Self-host or KernelCMS Cloud; content and config are always portable.
4. **Typed all the way down.** Config-as-code drives REST, GraphQL, and a fully typed Local/RPC API. Zero `any`.

Message discipline: lead with the wedge, never with a feature checklist. When comparing, name the competitor and the specific tradeoff — "Sanity decides your datastore; KernelCMS lets you pick Postgres, SQLite, MySQL, or MongoDB." Avoid superlatives we can't measure; performance budgets are enforced and measurable, so cite numbers, not adjectives. See Messaging Matrix for per-persona phrasing.

## Where We Deliberately Do Not Compete

Saying no is part of positioning. These are intentional non-goals, not backlog items.

| We do not | Why |
| --- | --- |
| Ship a page builder / website builder | We are a headless CMS. The frontend is yours; Wix/Webflow own no-code site building and we won't chase it. |
| Provide a visual schema designer as the source of truth | Config-as-code is canonical. Strapi's content-type builder writes files behind your back; we refuse the round-trip ambiguity. A visual *viewer* is fine; the editor of record is `kernel.config.ts`. |
| Build a non-TanStack admin or framework adapters for Vue/Svelte/Angular admins | The TanStack-native coupling *is* the wedge. A framework-agnostic admin would dissolve the moat. The delivery API is framework-agnostic; the admin is not. |
| Run a proprietary query language like GROQ | One typed query language across all surfaces beats a powerful-but-siloed DSL. We won't fragment the surface area. |
| Be a general application backend / BaaS | Supabase and Firebase own that. We are content infrastructure with first-class adapters, not a database-with-auth product. |
| Optimize for no-code/non-technical authors as the primary buyer | Our buyer is the engineering team. Editor UX must be excellent (WCAG 2.2 AA, command palette, live preview), but the product is bought by people who write `kernel.config.ts`. |

The discipline behind the table: every "no" protects either the wedge (TanStack-native) or a tenet (config-as-code, end-to-end types, no lock-in). When a feature request threatens one of those, the answer is no even if a competitor ships it.

## Open Questions

- **Cloud-exclusive capabilities.** Which features (if any) may live only in KernelCMS Cloud without violating the portability promise? Observability and billing are obviously Cloud-only; is managed search or a global content CDN allowed to be Cloud-only, or must an OSS equivalent always exist?
- **Adapter certification.** Do we run a "verified adapter" program (tested against the `Adapter` contract suite) and how does that interact with the "choose everything" message if popular adapters are community-maintained and unverified?
- **Edge-runtime parity.** How far do we promise feature parity on edge runtimes (Bun, edge) versus Node, given that some adapters (e.g. certain database drivers) cannot run at the edge? The messaging needs a precise, honest boundary.
