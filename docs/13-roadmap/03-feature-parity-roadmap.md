# Feature Parity Roadmap

KernelCMS does not need to clone Payload, Sanity, and Strapi feature-for-feature to win. It needs to reach the table-stakes set that makes switching painless, then push hard on the wedge — being TanStack-native and adapter-everything — where the incumbents structurally cannot follow. This document sequences that work: which competitor capabilities we match, in what order we ship them, what we deliberately do beyond parity, and how we measure the gap quarter over quarter without lying to ourselves.

## How we define "parity"

Parity is not "we have a field called X." Parity is "a team evaluating us against Payload can run their real content model through KernelCMS and not hit a wall." We track three states per capability:

| State | Meaning | Counts as parity? |
| --- | --- | --- |
| `missing` | Not implemented | No |
| `partial` | Works for the common path, gaps documented | No (but unblocks eval) |
| `shipped` | Stable API, typed, tested, documented | Yes |

A capability only flips to `shipped` when it has a typed `@kernel/*` surface, a migration path from the relevant competitor, and an entry in our parity matrix (see [Tracking progress](#tracking-progress)). "Demoable" is not "shipped."

## Parity targets by competitor

We benchmark against the thing each competitor is genuinely good at, not their weakest area.

### Payload — the developer-experience and access-control bar

Payload is the closest competitor in philosophy: config-as-code, collections and globals, field-level access control, drafts/versions, a local API. This is the parity set we cannot compromise on, because Payload's audience is exactly ours.

| Payload capability | KernelCMS target | Status target (next 2 quarters) |
| --- | --- | --- |
| Config-as-code collections/globals | `defineCollection` / `defineGlobal` in `kernel.config.ts` | shipped |
| Field-level access control | Operation/document/field access in `@kernel/auth` | shipped |
| Drafts + versions + autosave | Version history in `@kernel/core` | shipped |
| Local API with type inference | `@kernel/client` local mode + typed RPC | shipped |
| Hooks (before/after change, read) | `@kernel/core` lifecycle hooks | shipped |
| Block-based rich text | `@kernel/richtext` block editor | shipped |
| Field-level localization | `localized: true` per field | shipped |

Where we diverge from Payload on purpose: Payload's local API is in-process but its over-the-wire story is REST/GraphQL bolt-on. Ours is the *same* operation core exposed as typed RPC through TanStack Start server functions, so the local call and the network call share one type. Payload's admin is a bespoke React app; ours is TanStack Start end-to-end, which means Router, Query, Table, and Form are the public extension surface, not internal plumbing.

```ts
// kernel.config.ts — the Payload-parity surface, KernelCMS-native
import { defineConfig, defineCollection } from '@kernel/core'
import { postgres } from '@kernel/db-postgres'

export default defineConfig({
  db: postgres({ url: process.env.DATABASE_URL! }),
  collections: [
    defineCollection({
      slug: 'posts',
      access: {
        read: () => true,
        update: ({ req }) => req.user?.role === 'editor',
      },
      versions: { drafts: true, autosave: { interval: 800 } },
      fields: [
        { name: 'title', type: 'text', required: true, localized: true },
        { name: 'body', type: 'richText' },
        { name: 'author', type: 'relationship', relationTo: 'users' },
      ],
    }),
  ],
})
```

### Sanity — the structured-content, real-time, and portability bar

Sanity wins on real-time collaboration, its portable-text model, live preview with visual editing, and content portability. Strapi and Payload trail here. We target the *capabilities*, not Sanity's GROQ or its hosted-only dataset model.

| Sanity capability | KernelCMS target | Notes |
| --- | --- | --- |
| Real-time / live collections | `@kernel/client` + TanStack DB reactive collections | Optional, opt-in per collection |
| Portable rich text | `@kernel/richtext` block JSON (portable, queryable) | Block model, not HTML blobs |
| Live preview + visual editing | Admin live preview pane via TanStack Query subscriptions | Self-host *and* Cloud |
| Content portability / no lock-in | Config-as-code + adapter export/import | Portable between self-host and KernelCMS Cloud |
| Hosted platform | KernelCMS Cloud | Managed, multi-tenant, content CDN |

Where we win on Sanity: Sanity's real-time and hosting are coupled to *their* infrastructure. Our live story rides TanStack DB and works against any adapter you bring, self-hosted or on KernelCMS Cloud, with content always exportable. Sanity makes you write GROQ; we expose one `where`/`sort`/`pagination`/`depth` query language across REST, GraphQL, and RPC, so you learn it once.

### Strapi — the breadth, plugin-ecosystem, and admin-feature bar

Strapi's strength is breadth: media library, i18n, role-based admin, a large plugin marketplace, a no-code content-type builder. We match the runtime breadth and deliberately *do not* match the no-code builder — config-as-code is the source of truth.

| Strapi capability | KernelCMS target | Decision |
| --- | --- | --- |
| Media library | `@kernel/storage` + admin media library | Match |
| i18n + RTL admin | Admin i18n, WCAG 2.2 AA, RTL | Match and exceed |
| Role-based admin access | Field/document/operation access | Match |
| REST + GraphQL auto-gen | `@kernel/rest` + `@kernel/graphql` | Match |
| Plugin ecosystem | `@kernel/plugin-sdk` | Match (typed) |
| No-code content-type builder | — | **Skip on purpose** |

The no-code builder is where Strapi's data model drifts from version control and breaks reproducible deploys. We reject it. Schema lives in `kernel.config.ts`, migrations are generated from schema diffs, and the admin reflects config — never the other way around.

## Sequencing

We sequence by *unblocking evaluation*, not by feature glamour. A capability ships early if it stops a prospect from completing a real migration eval.

```
Phase 1 ──────────► Phase 2 ──────────► Phase 3 ──────────► Phase 4
Core parity         Content depth       Real-time + DX      Beyond parity
(eval unblock)      (Payload parity)    (Sanity parity)     (the wedge)

  defineConfig        versions/drafts     TanStack DB live    visual editing
  collections         localization        live preview        adapter marketplace
  globals             blocks editor       command palette     edge runtimes
  postgres adapter    media library       async validation    KernelCMS Cloud GA
  REST/GraphQL/RPC    access control      i18n/RTL admin       plugin SDK 1.0
  local API           sqlite/mysql/mongo  migration codemods  white-label theming
```

The ordering rule:

1. **Phase 1 (core parity)** — anything required to model content and read it back through all three API surfaces. Without this, no eval starts. `@kernel/core`, `@kernel/db-postgres`, `@kernel/rest`, `@kernel/graphql`, `@kernel/rpc`, `@kernel/client`.
2. **Phase 2 (content depth)** — the Payload/Strapi feature set teams actually rely on day two: versions, drafts, localization, blocks, media, access control, and the remaining database adapters (`@kernel/db-sqlite`, `@kernel/db-mysql`, `@kernel/db-mongodb`).
3. **Phase 3 (real-time + admin DX)** — the Sanity-grade experience: TanStack DB reactive collections, live preview, command-palette UX, async/cross-field validation, full i18n/RTL admin.
4. **Phase 4 (beyond parity)** — the differentiators below.

We do not ship Phase 3 polish while Phase 2 has `missing` rows. Depth before shine. See [the release plan](./02-release-plan-and-versioning.md) and [milestones](./01-milestones-and-phases.md) for dated cuts.

## Differentiators beyond parity

Parity gets us into the evaluation. These get us picked.

### One operation core, every surface

Payload, Sanity, and Strapi each bolt APIs onto a server. KernelCMS has a single operation core; REST, GraphQL, the in-process Local API, and typed RPC are *projections* of it. The same `find`/`create`/`update` with the same `where`/`sort`/`depth` semantics runs in-process and over the wire with identical types.

```ts
import { kernel } from '@kernel/client'

// In-process Local API — full inference, zero network
const local = await kernel.posts.find({
  where: { status: { equals: 'published' } },
  sort: '-publishedAt',
  depth: 1,
})

// Same call, same types, over typed RPC (TanStack Start server function)
const remote = await client.posts.find({ where: { status: { equals: 'published' } } })
```

### Adapter-everything

Database, storage, email, auth, search, cache, and queue are all swappable adapters implementing one contract. No competitor lets you change the database *and* the queue *and* the search backend without leaving the product. This is the "choose everything" wedge — see [the adapter architecture](../03-persistence/00-persistence-overview-and-adapter-contract.md).

```ts
import { defineConfig } from '@kernel/core'
import { mysql } from '@kernel/db-mysql'
import { s3 } from '@kernel/storage'

export default defineConfig({
  db: mysql({ url: process.env.DATABASE_URL! }),
  storage: s3({ bucket: 'media', region: 'eu-west-1' }),
  // swap any of these without touching content config
})
```

### TanStack-native extension surface

Because the admin is TanStack Start, the things you extend are public libraries, not framework internals: a custom list view is a TanStack Table, a custom field is a TanStack Form binding, custom fetching is a TanStack Query hook. Strapi's admin customization means learning Strapi's abstractions; ours means knowing libraries you may already use.

### Portability as a guarantee, not a feature

Content and config move between self-host and KernelCMS Cloud with no transformation. Sanity's portability stops at the edge of their platform. Ours is structural: config-as-code plus an adapter export/import contract means the same `kernel.config.ts` runs anywhere Node, Bun, or an edge runtime runs.

## Tracking progress

We keep an honest, machine-readable parity matrix in the repo and render it into the docs site. Each row is a `(competitor, capability, status, since)` tuple. CI fails the docs build if a row claims `shipped` but the referenced `@kernel/*` export does not exist.

```ts
// parity/matrix.ts — source of truth for the rendered parity table
import { defineParityMatrix } from '@kernel/core/parity'

export default defineParityMatrix({
  payload: [
    { capability: 'field-level-access', status: 'shipped', export: '@kernel/auth#fieldAccess' },
    { capability: 'versions-autosave', status: 'shipped', export: '@kernel/core#versions' },
  ],
  sanity: [
    { capability: 'live-collections', status: 'partial', export: '@kernel/client#live' },
    { capability: 'visual-editing', status: 'missing' },
  ],
  strapi: [
    { capability: 'media-library', status: 'shipped', export: '@kernel/storage#mediaLibrary' },
    { capability: 'nocode-builder', status: 'wontfix', reason: 'config-as-code is the source of truth' },
  ],
})
```

We score parity as a percentage per competitor — `shipped / (total - wontfix)` — and publish it. We also maintain migration evals: a real Payload project, a real Strapi project, and a real Sanity dataset that we attempt to model and import each release. The eval either passes or names the exact missing capability, which becomes a tracked row. A green parity percentage with a failing migration eval is treated as a lie and blocks the release.

## Open questions

- **GROQ-style query interop.** Do we ship a thin GROQ-to-`where` shim to ease Sanity migrations, or hold the line on one query language and provide a codemod instead? The shim lowers migration friction but adds a second mental model.
- **Real-time default.** Should reactive collections via TanStack DB be opt-in per collection (current plan) or opt-in globally with per-collection opt-out? Affects the Sanity-parity story and the cost model on KernelCMS Cloud.
- **`wontfix` visibility.** Do we surface `wontfix` rows (like the no-code builder) in the public parity table as deliberate non-goals, or omit them? Showing them is honest but invites "they're missing X" misreadings.
- **Plugin ecosystem bootstrapping.** Strapi's marketplace is a moat. Open question whether `@kernel/plugin-sdk` ships with a first-party plugin registry at 1.0 or defers to npm conventions initially.
