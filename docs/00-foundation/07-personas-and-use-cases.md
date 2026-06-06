# Personas & Use Cases

KernelCMS is built for the people who actually ship content systems: the engineer who models content in code, the editor who lives in the admin panel all day, the agency that resells the same stack to twenty clients, and the founder who needs a backend yesterday. This document names those personas, defines the jobs they hire KernelCMS for, and shows — with real `kernel.config.ts` and `@kernel/*` snippets — how the product serves each one. It also names where we beat Payload, Sanity, and Strapi for that specific buyer, because no CMS wins every persona, and pretending otherwise produces mush.

## The Developer

The developer is the primary persona and the one who chooses KernelCMS. Nobody else evaluates the adapter contract or reads the TanStack Start docs. If we lose the developer, the other personas never see the product.

### What the job is

The developer's job is to turn a content model into a typed, queryable backend without writing CRUD, without hand-rolling an admin, and without getting locked into one database. They want config-as-code so the schema lives in Git, reviews like code, and diffs in a PR. They want end-to-end types so the editor's `richText` field and the frontend's `useQuery` call share one inferred shape — zero `any`, no codegen step that drifts.

```ts
// kernel.config.ts
import { defineConfig } from '@kernel/core'
import { postgres } from '@kernel/db-postgres'
import { s3 } from '@kernel/storage'

export default defineConfig({
  db: postgres({ url: process.env.DATABASE_URL }),
  storage: s3({ bucket: 'media', region: 'eu-west-1' }),
  collections: [
    {
      slug: 'posts',
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'slug', type: 'text', unique: true, index: true },
        { name: 'body', type: 'richText' },
        { name: 'author', type: 'relationship', relationTo: 'users' },
        { name: 'hero', type: 'upload', relationTo: 'media' },
      ],
      versions: { drafts: true, autosave: true },
      access: {
        read: () => true,
        update: ({ req }) => req.user?.role === 'editor',
      },
    },
  ],
})
```

That config generates the database schema, the REST and GraphQL surfaces, the typed Local API, and the admin UI. The developer's inferred client is the payoff:

```ts
import { createClient } from '@kernel/client'
import type { Config } from './kernel.config'

const kernel = createClient<Config>()

// post is fully typed: title: string, body: RichTextNode[], author: User
const post = await kernel.collections.posts.findById('abc', { depth: 2 })
```

### Why a developer picks KernelCMS over the field

Payload also does config-as-code and TypeScript-first, and it is the closest competitor here — but Payload is bound to its own Express/Next runtime and its own data layer abstractions. KernelCMS is **TanStack-native end to end**: the admin and the API host both run on TanStack Start, list views are TanStack Table, edit forms are TanStack Form, and all fetching is TanStack Query. A developer already in that ecosystem gets one mental model instead of two. Sanity is fast to start but pushes you into GROQ and a hosted dataset; you don't own the database, and the schema is JS objects rather than a typed, diffable contract you migrate yourself. Strapi gives you a database but leans on a plugin marketplace and an admin you customize by forking React — its type story is weaker and its query language is per-surface. KernelCMS gives the developer **one shared query language** (`where` / `sort` / pagination / `depth`) across REST, GraphQL, RPC, and the Local API, plus a real Adapter contract so the database is a choice, not a sentence. See Architecture Overview and [The Adapter Contract](../03-persistence/00-persistence-overview-and-adapter-contract.md).

## The Content Editor

The editor never opens `kernel.config.ts`. They live in the admin panel, and their experience is the product's reputation with the people who pay for it. A great editor experience is what turns a developer's tool choice into an organization's standard.

### What the job is

The editor's job is to create, edit, schedule, translate, and publish content quickly and confidently — with drafts they can iterate on, version history they can roll back, and a preview that shows the real page. They care about keyboard speed, an honest autosave, and a rich-text editor that doesn't fight them.

KernelCMS serves this with a config-driven admin built on TanStack Start: collection lists use TanStack Table for sorting, filtering, column sizing, and virtualization; documents render through TanStack Form with per-field binding and validation; long lists and long documents virtualize via TanStack Virtual. The editor gets drafts and publish, version history with autosave, a block-based rich-text editor, a media library, and **live preview with visual editing** — click an element on the page, land on the field.

```
┌──────────────┬────────────────────────────┬───────────────┐
│  Collections │   Document — TanStack Form │  Live Preview │
│  ──────────  │   ───────────────────────  │  ───────────  │
│  Posts    42 │   Title  [___________]     │  ┌─────────┐  │
│  Pages    11 │   Body   [ richText ]      │  │ rendered│  │
│  Media   310 │   Status ● Draft  ⌘S saved │  │  page,  │  │
│              │   Locale  en ▸ da ▸ de     │  │ click → │  │
│  ⌘K palette  │   [ Publish ]  [ History ] │  │  field  │  │
└──────────────┴────────────────────────────┴───────────────┘
```

### Localization and review without leaving the page

Field-level localization is first-class, so a Danish editor edits the `da` locale of a single document instead of cloning it.

```ts
{ name: 'title', type: 'text', localized: true, required: true }
```

Sanity's editorial UX is the bar here, and its real-time multiplayer editing is genuinely excellent. KernelCMS matches Sanity's polish on previews and command-palette speed while keeping the content in _your_ database; TanStack DB powers optional live/offline reactive collections for the cases where editors need real-time co-presence. Strapi's editor is functional but plainer, and its draft/publish and i18n have historically been bolt-ons rather than core. Payload's admin is strong and the closest in spirit, but it is not virtualized to the same degree and not built on a shared TanStack data layer. WCAG 2.2 AA, full RTL, and dark mode are non-negotiable defaults, not settings an editor has to discover. See Admin Panel and [Localization](../02-data-modeling/09-localization-and-i18n.md).

## Agencies & Enterprise

Agencies and enterprises buy KernelCMS for repeatability, governance, and the right to leave. They are the revenue persona — they pay for Cloud, for enterprise add-ons, and for the assurance that they own their data.

### The agency job

An agency builds the same shape of site for many clients and wants to template the stack, white-label the admin, and deploy fast. KernelCMS supports white-label theming and design tokens so each client sees their own brand, and `create-kernel` plus the `kernel` CLI scaffolds a project from an internal preset in one command.

```bash
pnpm create kernel@latest acme-site --preset agency/marketing
```

| Concern           | Agency need                      | KernelCMS answer                                  |
| ----------------- | -------------------------------- | ------------------------------------------------- |
| Branding          | Per-client admin look            | White-label theming + design tokens               |
| Repeatable builds | One stack, many clients          | `create-kernel` presets, config-as-code in Git    |
| Database freedom  | Client mandates Postgres / Mongo | Swap `@kernel/db-postgres` ↔ `@kernel/db-mongodb` |
| Handoff           | Client takes over hosting        | Self-host ↔ Cloud portability, no lock-in         |

### The enterprise job

Enterprise cares about access control, auditability, multi-environment workflows, and SSO. Access control in KernelCMS is evaluated at the **operation, document, and field level**, server-side and on by default — not advisory hints the frontend can ignore.

```ts
access: {
  read: ({ req }) => ({ tenant: { equals: req.user.tenantId } }),
  fields: {
    salary: { read: ({ req }) => req.user.role === 'hr' },
  },
}
```

This is where Strapi historically charged for the enterprise edition to unlock RBAC and SSO, and where Sanity's governance lives behind its hosted plans and a dataset you can't fully self-operate. KernelCMS keeps field-level access in the open-source core and offers managed governance, observability, backups, and billing through **KernelCMS Cloud** — but content and config stay portable between self-host and Cloud, so "we'll move off your platform" is always a credible threat, which is exactly what enterprise procurement wants to hear. See [Access Control](../06-auth-security/01-authorization-and-access-control.md) and [Deployment](../10-cloud-operations/00-deployment-models-self-host-vs-cloud.md).

## Indie & Startup

The indie hacker and the early-stage startup hire KernelCMS to go from zero to a working, typed backend in an afternoon, on infrastructure they can afford, with a clear path to scale.

### What the job is

Speed and cost. They want SQLite locally and on the edge with `@kernel/db-sqlite`, no Docker for day one, and a deploy target that's free or nearly so. They want the same typed Local API that the enterprise persona uses, so they never rewrite when they grow.

```ts
import { sqlite } from '@kernel/db-sqlite'
export default defineConfig({
  db: sqlite({ url: 'file:./dev.db' }), // libSQL/Turso later, same adapter
  collections: [
    /* ... */
  ],
})
```

```
zero ──► create-kernel ──► kernel dev (SQLite) ──► deploy edge/Node ──► swap to Postgres at scale
```

The startup advantage over the field is the **no-rewrite scale path**. Sanity is also fast to start but its pricing steps up sharply and you're renting the data layer. Strapi self-hosts cheaply but you carry the database and the admin maintenance. KernelCMS lets a solo founder start on SQLite at the edge, then change one adapter line to `@kernel/db-postgres` when traffic justifies it — same config, same types, same Local API. Bun, Node, and edge runtimes are all supported targets, so the cheapest credible host wins. See [Quick Start](../01-architecture/adr/0001-tanstack-start-foundation.md).

## Primary Use Cases

The personas map onto a handful of jobs that recur across every evaluation.

| Use case                       | Lead persona        | KernelCMS surfaces used                             |
| ------------------------------ | ------------------- | --------------------------------------------------- |
| Marketing site / blog          | Developer + Editor  | Collections, `richText`, live preview, REST/GraphQL |
| Multi-locale corporate site    | Editor + Enterprise | Field localization, drafts, version history, RTL    |
| Headless commerce content      | Developer           | Relationships, `blocks`, typed Local API, depth     |
| App backend (mobile/web)       | Startup             | Typed RPC via server functions, `@kernel/client`    |
| Multi-tenant SaaS content      | Agency + Enterprise | Document/field access control, Cloud multi-tenancy  |
| Documentation / knowledge base | Developer + Editor  | `blocks`, search adapter, command-palette nav       |

The connective tissue is the shared query language and the Local API. A marketing team's editor publishes a draft; the frontend reads it with one typed call; the same operation core that served the editor serves the request, so access control and validation can't be bypassed by hitting a different surface.

```ts
// Frontend (TanStack Query) — same query language as the editor's admin
const { data } = useQuery({
  queryKey: ['posts', { locale: 'da' }],
  queryFn: () =>
    kernel.collections.posts.find({
      where: { status: { equals: 'published' } },
      sort: '-publishedAt',
      depth: 1,
      locale: 'da',
    }),
})
```

Payload covers most of these use cases well and is the honest comparison for the developer-led ones. Sanity wins on pure editorial polish for content-heavy marketing teams that don't mind a hosted dataset. Strapi wins on "I want a quick self-hosted REST backend and don't care about types." KernelCMS's claim is the **union**: the developer's type safety, the editor's polish, the agency's repeatability, and the startup's cheap scale path — on one TanStack-native stack with swappable adapters and no lock-in.

## Open Questions

- **Persona-targeted presets.** Should `create-kernel` ship official `agency/*`, `startup/*`, and `enterprise/*` presets, or keep the core minimal and let the community own presets? Leaning toward a small set of official presets plus a registry.
- **Editor-developer boundary.** How much schema editing (adding a field, a select option) do we expose to non-developer editors in the admin, given that config-as-code is the single source of truth? A safe, reviewable "propose a schema change" flow is undecided.
- **Cloud-only enterprise features.** Which governance features (audit log retention, SSO, SCIM) belong in the open-source core versus KernelCMS Cloud / enterprise add-ons? The portability guarantee constrains how much we can gate.
