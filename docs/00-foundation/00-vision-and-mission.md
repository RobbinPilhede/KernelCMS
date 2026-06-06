# Vision & Mission

KernelCMS is an open-source, TypeScript-first, TanStack-native headless CMS. Content is modeled in code, every infrastructure concern is a swappable adapter, and the same operation core drives REST, GraphQL, and a fully typed Local/RPC API. This document is the north star: what is broken in today's headless CMS landscape, why a TanStack-native CMS makes sense _now_, where we intend to be in three years, and — just as important — what we are deliberately refusing to build.

## The problem with the current landscape

Headless CMS has converged on three archetypes, and each forces a bad trade.

**Payload** got the developer model right — config-as-code, TypeScript end to end, a Local API — but it owns its stack. The admin is a bespoke React app, the data layer is Payload's own, and the query/state primitives are hand-rolled. You inherit Payload's opinions about caching, forms, tables, and routing whether they fit your app or not. When you want to embed CMS-driven data into a product UI, you re-implement fetching and invalidation by hand.

**Sanity** nailed the hosted experience and real-time editing, but the content lives in _their_ datastore (the Content Lake) and is queried with _their_ language (GROQ). Portability is a migration project. You don't own the database, you can't point it at your existing Postgres, and self-hosting the full editing experience is not a first-class path.

**Strapi** is the most "batteries-included," but it leans on a code-generated, partly-UI-driven schema, a plugin system with weaker type guarantees, and a REST/GraphQL layer that drifts from the admin. Type safety is bolted on, not foundational. Customizing the admin means fighting the framework.

Underneath the branding, the same structural failures repeat:

| Failure                                | What it costs you                                                           |
| -------------------------------------- | --------------------------------------------------------------------------- |
| Bundled, non-swappable infrastructure  | You take their DB/storage/auth/search choices wholesale, or you fork        |
| Type safety as an afterthought         | `any` leaks at the API boundary; refactors break silently at runtime        |
| Bespoke admin internals                | Every data-fetching, form, and table concern is reinvented and under-tested |
| Lock-in by datastore or query language | "Headless" but not portable; leaving is a migration, not a config change    |
| Self-host vs. hosted as a hard fork    | The managed product and the OSS product diverge in capability               |

The market treats "headless" as a content-delivery shape. We treat it as a **portability and ownership guarantee**. A CMS should be a thin, typed orchestration layer over infrastructure _you_ choose — not a walled datastore with a CMS bolted on top.

## Why TanStack, and why now

The wedge is simple: **the entire stack — server and admin — is built on TanStack.** No competitor is. This is not branding; it removes whole categories of bespoke code that Payload, Sanity, and Strapi each maintain by hand.

```
        ┌──────────────────────── Admin (React) ────────────────────────┐
        │  Router (routing+search state) · Query (fetch/cache/invalidate)│
        │  Table (lists) · Form (edit) · Store (UI) · Virtual (long lists)│
        └───────────────────────────────┬───────────────────────────────┘
                                         │  typed RPC (server functions)
        ┌───────────────────────────────▼───────────────────────────────┐
        │                 @kernel/server on TanStack Start               │
        │      operation core → REST · GraphQL · Local API · RPC         │
        └───────────────────────────────┬───────────────────────────────┘
                                         │  one Adapter contract
        ┌──────────┬──────────┬──────────▼─────────┬──────────┬──────────┐
        │ Database │ Storage  │  Auth   │  Search   │  Cache   │  Queue   │
        └──────────┴──────────┴─────────┴───────────┴──────────┴──────────┘
```

Concretely, TanStack does the work that competitors hand-roll:

- **TanStack Start** hosts both the admin SSR app and the API. The Local API is the operation core called in-process; over the wire it's exposed as **typed RPC via server functions**. There is no separate API server to keep in sync.
- **TanStack Router** gives the admin type-safe routes and search-param state — list filters, sort, and pagination live in the URL, typed.
- **TanStack Query** is the single data-fetching, caching, and invalidation layer. When a document saves, invalidation is structural, not ad hoc.
- **TanStack Table** powers collection list views: sorting, filtering, column sizing, virtualization — the exact surface a CMS list needs.
- **TanStack Form** binds document edit forms field-by-field with sync, async, and cross-field validation.
- **TanStack Store** holds lightweight reactive admin UI state; **TanStack Virtual** keeps long lists and long documents fast.
- **TanStack DB** is the optional reactive client-side collection layer for live/offline admin and frontends — the same primitive your product app can use.

Why now: TanStack Start has matured into a production SSR + server-functions framework, and the surrounding libraries are individually battle-tested at scale. The pieces a CMS needs — routing, fetching, tables, forms — finally exist as a coherent, typed family. Building _on_ them means we ship less framework and more CMS, and any engineer who knows TanStack already knows half of KernelCMS.

The second pillar is **choose everything**. Every infrastructure concern is an adapter behind one contract: database, storage, email, auth, search, cache, and queue. Drizzle is the default SQL ORM — Postgres (default), SQLite/libSQL, MySQL — with a MongoDB adapter for document workflows. Migrations are generated from schema diffs. See Architecture Overview and the [Adapter Contract](../03-persistence/00-persistence-overview-and-adapter-contract.md).

```ts
// kernel.config.ts
import { defineConfig } from '@kernel/core'
import { postgres } from '@kernel/db-postgres'
import { s3 } from '@kernel/storage'
import { collections, globals } from './content'

export default defineConfig({
  db: postgres({ url: process.env.DATABASE_URL! }),
  storage: s3({ bucket: 'kernel-media', region: 'eu-north-1' }),
  collections, // repeatable content types
  globals, // singletons: site settings, navigation
  localization: { locales: ['en', 'sv', 'ar'], default: 'en' },
})
```

Swap Postgres for SQLite, or S3 for local disk, by changing two lines — no content rewrite, no query-language migration. That is the portability guarantee Sanity can't make and Payload makes only within its own datastore.

## The three-year vision

Three years out, KernelCMS should be the **default choice for a TypeScript team that wants to own its infrastructure and still get a Sanity-grade editing experience.** Three commitments define that:

**1. Config-as-code is the single source of truth, fully inferred.** Your `kernel.config.ts` produces the database schema, the REST and GraphQL surfaces, the typed Local/RPC client, and the admin UI. There is one model and zero drift.

```ts
import { collection, field } from '@kernel/core'

export const Posts = collection('posts', {
  fields: {
    title: field.text({ required: true, localized: true }),
    body: field.richText(),
    author: field.relationship({ to: 'users' }),
    seo: field.group({ fields: { description: field.textarea() } }),
  },
  versions: { drafts: true, autosave: true },
  access: {
    read: () => true,
    update: ({ req }) => req.user?.role === 'editor',
  },
})
```

```ts
// Local API — same operation core, fully inferred, zero `any`
import { getClient } from '@kernel/client'
const kernel = getClient()
const post = await kernel.collections.posts.findByID({ id, depth: 1 })
//    ^? Post — title/body/author resolved from config
```

**2. One query language across every surface.** `where`, `sort`, pagination, and `depth` mean the same thing in REST, GraphQL, Local, and RPC. Learn it once. No GROQ-vs-REST split, no per-surface dialects.

**3. Self-host and Cloud are the same product.** Content and config are always portable between them. KernelCMS Cloud adds managed multi-tenant hosting, billing, observability, backups, and a global content CDN — but it runs the same core you self-host via Docker, Compose, or Kubernetes on Node, Bun, or edge runtimes. Moving in or out is a config change, never a migration.

Around that core: a block-based rich-text editor, a media library, live preview with visual editing, WCAG 2.2 AA, i18n with RTL, white-label theming, a command-palette UX, and a stable [Plugin SDK](../08-extensibility/01-plugin-sdk-and-authoring.md) (`@kernel/plugin-sdk`) so the ecosystem extends fields, adapters, and admin views without forking.

A rough trajectory:

| Horizon | Focus                                                                                      |
| ------- | ------------------------------------------------------------------------------------------ |
| Year 1  | OSS core: Drizzle adapters, REST/GraphQL/RPC, TanStack admin, drafts + versions, auth      |
| Year 2  | Live preview + visual editing, TanStack DB live collections, mature Plugin SDK, MongoDB GA |
| Year 3  | KernelCMS Cloud GA, edge deploys, content CDN, enterprise auth/audit, ecosystem of plugins |

## Non-goals

Being explicit about what we won't do keeps the core sharp.

- **Not a website builder or page-layout designer.** We model content; we don't ship a drag-and-drop site builder. Blocks are content, not a Webflow canvas.
- **No proprietary datastore or query language.** We will never require a KernelCMS-owned database or a GROQ-style dialect. You bring Postgres/MySQL/SQLite/MongoDB; you query with the one shared language.
- **No hard-wired infrastructure.** We will not bless a single DB, search, or queue as non-swappable. If it can't be an adapter, it doesn't belong in core.
- **Not a visual schema editor.** Schema lives in `kernel.config.ts`, in version control, reviewed in PRs. We reject Strapi's UI-driven, code-generated schema model.
- **Not framework-agnostic on the admin.** The admin is TanStack + React, on purpose. We won't dilute the wedge to chase a Vue/Svelte admin.
- **No runtime `any` at boundaries, ever.** End-to-end type safety is a constraint, not a goal we trade away for convenience.
- **Not an all-in-one app platform.** We are a CMS with escape hatches, not a backend-as-a-service trying to own auth, billing, and compute for your whole product.

## Open questions

- **TanStack DB scope in v1.** Is live/offline client collections a launch feature or a Year-2 capability? It shapes the admin's real-time architecture.
- **MongoDB parity.** How close can the document adapter get to SQL on versions, relationships, and the shared query language before we document hard limits?
- **Cloud-only surface area.** Which features (advanced observability, multi-region CDN) are Cloud-exclusive vs. self-hostable, without violating the portability guarantee?
- **Edge runtime constraints.** How much of the operation core runs unchanged on edge vs. needs a Node/Bun host, and how do we signal that in `kernel.config.ts`?
