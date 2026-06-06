# Product Overview

KernelCMS is an open-source, TypeScript-first, TanStack-native headless CMS where you model content in code and run it however you like. You write a single `kernel.config.ts`, and KernelCMS auto-generates a REST API, a GraphQL API, and a fully typed Local/RPC API on top of a database you choose — Postgres, SQLite/libSQL, MySQL, or MongoDB — with storage, auth, email, search, cache, and queue all behind swappable adapters. The admin panel is a React application built on TanStack Start, and the same content and config run unchanged whether you self-host or deploy to KernelCMS Cloud. The wedge against Payload, Sanity, and Strapi is simple: the entire stack is TanStack-native and every infrastructure concern is a choice, not a hard-wired default.

## What KernelCMS Is

KernelCMS treats your content schema as source code. Collections (repeatable content types) and Globals (singletons like site settings) are declared in `kernel.config.ts`, type-checked at build time, and used to derive everything downstream: database tables and migrations, API surfaces, admin UI, and end-to-end client types. There is no schema designer that drifts from your codebase and no GUI that silently mutates production. Config is the single source of truth, committed to git, reviewed in PRs, and deployed like any other code.

```ts
// kernel.config.ts
import { defineConfig } from '@kernel/core'
import { postgres } from '@kernel/db-postgres'
import { s3 } from '@kernel/storage'

export default defineConfig({
  db: postgres({ url: process.env.DATABASE_URL }),
  storage: s3({ bucket: process.env.S3_BUCKET, region: 'eu-north-1' }),
  collections: [
    {
      slug: 'posts',
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'slug', type: 'text', unique: true, index: true },
        { name: 'body', type: 'richText' },
        { name: 'author', type: 'relationship', relationTo: 'users' },
        { name: 'cover', type: 'upload', relationTo: 'media' },
      ],
      versions: { drafts: true, autosave: true },
      access: {
        read: () => true,
        update: ({ req }) => Boolean(req.user),
      },
    },
  ],
  globals: [
    {
      slug: 'settings',
      fields: [{ name: 'siteName', type: 'text', required: true }],
    },
  ],
})
```

That config compiles into a running CMS. Payload pioneered this config-as-code model and KernelCMS owes it the debt, but Payload is bound to its own server runtime and bundler assumptions. Sanity ships an excellent editing experience but pushes you onto its hosted Content Lake — your content lives in their datastore by design. Strapi is plugin-rich but its content-type builder writes JSON schema files through a GUI, blurring the line between config and runtime state. KernelCMS keeps the line sharp: code in, everything out.

## Core Capabilities

The capability surface is deliberately broad because a headless CMS is only useful if it covers the unglamorous middle — versioning, access control, localization — not just CRUD.

| Capability                   | What it does                                                        | How it differs                                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Three API surfaces**       | REST, GraphQL, and a typed Local/RPC API auto-generated from config | One shared query language (`where` / `sort` / pagination / `depth`) spans all three; Local API is the same operation core called in-process |
| **Adapter-everything**       | DB, storage, auth, email, search, cache, queue are swappable        | Payload/Strapi assume a primary stack; KernelCMS makes each a contract you pick                                                             |
| **Field-level localization** | Per-field translations with fallback chains                         | First-class, not a paid add-on as in some Strapi tiers                                                                                      |
| **Drafts + version history** | Autosave, restore, diff between versions                            | Built into the operation core, available on every surface                                                                                   |
| **Access control**           | Evaluated at operation, document, and field level                   | Server-side by default; field-level access is rare among competitors                                                                        |
| **Validation**               | Sync, async, and cross-field                                        | Runs identically in Local API and over the wire                                                                                             |
| **Admin UX**                 | Command palette, dark mode, live preview, media library             | TanStack Table/Form/Virtual under the hood for real scale                                                                                   |

The field-type system is the expressive core: `text`, `textarea`, `number`, `boolean`, `date`, `email`, `json`, `code`, `point`, `select`, `radio`, `checkbox`, `relationship`, `upload`, `array`, `blocks`, `group`, `tabs`, `row`, `richText`, `ui` (presentational), plus custom field types. The structural fields (`array`, `blocks`, `group`, `tabs`, `row`) let you model deeply nested documents without escaping into opaque JSON, and `blocks` powers the block-based rich-text editing that competes directly with Sanity's Portable Text.

Querying is uniform. The same shape works in-process and over HTTP:

```ts
import { getKernel } from '@kernel/client'

const kernel = getKernel()

// Local API — runs in-process, fully type-inferred from config
const { docs } = await kernel.find('posts', {
  where: { status: { equals: 'published' }, author: { equals: userId } },
  sort: '-createdAt',
  depth: 1, // resolve one level of relationships
  limit: 20,
})
```

`docs` is typed from your `posts` collection — no codegen step, no manual interface. Sanity requires GROQ and Strapi gives you a REST/GraphQL split with different filter syntaxes; KernelCMS gives you one query language and infers the result type from config.

## Primary Audiences

KernelCMS serves four overlapping groups, and the design trade-offs are tuned for them in this order.

### Product engineers shipping content-backed apps

Teams already on the TanStack ecosystem (Start, Router, Query) get a CMS that speaks their language. The admin is a TanStack Start app, client fetching is TanStack Query, and the Local API drops into server functions with full inference. For these teams the win is zero impedance mismatch — see TanStack usage.

### Agencies and platform teams

They need to spin up many sites with consistent governance. Config-as-code means a base config can be templated, shared, and white-labeled. The admin supports white-label theming, design tokens, and i18n with RTL out of the box, which Strapi historically gated or required plugins for.

### Enterprises with infrastructure mandates

A bank that must run Postgres on-prem and a startup on edge SQLite should not need different CMSes. Because every backend implements one Adapter contract, the same config runs on either — see [the adapter model](../03-persistence/00-persistence-overview-and-adapter-contract.md).

### Solo developers and OSS users

The MIT core, the `create-kernel` scaffolder, and SQLite-by-default mean you can be running locally in minutes with `npx create-kernel@latest` and the `kernel` CLI, then graduate to Postgres or Cloud without rewrites.

## High-Level Architecture

The architecture is a layered core wrapped by interchangeable edges. Config feeds the operation core; the core talks to infrastructure through adapters; and three API surfaces plus the admin sit on top of that core.

```
            kernel.config.ts  (single source of truth)
                      │
        ┌─────────────┼──────────────┐
        ▼             ▼              ▼
   ┌─────────┐  ┌──────────┐  ┌──────────────┐
   │  REST   │  │ GraphQL  │  │ Local / RPC  │  ← API surfaces
   │ @kernel │  │ @kernel  │  │  @kernel/rpc │    (auto-generated)
   │  /rest  │  │ /graphql │  │  @kernel/client│
   └────┬────┘  └────┬─────┘  └──────┬───────┘
        └────────────┼───────────────┘
                     ▼
            ┌──────────────────┐
            │  Operation Core  │   find / create / update / delete
            │   @kernel/core   │   access · validation · hooks · versions
            └────────┬─────────┘
                     ▼
        ┌────────────────────────────┐
        │      Adapter Contract       │
        ├──────┬──────┬──────┬────────┤
        │  db  │ store│ auth │ email… │  ← swappable
        └──┬───┴──┬───┴──┬───┴────────┘
           ▼      ▼      ▼
      Postgres   S3    OAuth …
      (Drizzle)
```

The operation core in `@kernel/core` owns the lifecycle: access checks, validation (sync/async/cross-field), hooks, version capture, and localization resolution. Every surface — REST (`@kernel/rest`), GraphQL (`@kernel/graphql`), RPC (`@kernel/rpc` exposed via TanStack Start server functions) — is a thin translator into that same core, so business rules cannot diverge between APIs. This is the structural answer to a recurring Strapi pain, where REST and GraphQL controllers can drift.

Persistence sits behind the Adapter contract. `@kernel/db` defines the shape; `@kernel/db-postgres`, `@kernel/db-sqlite`, `@kernel/db-mysql`, and `@kernel/db-mongodb` implement it. SQL backends use Drizzle as the default ORM (Postgres is the default backend), and migrations are generated from schema diffs against `kernel.config.ts`. The admin (`@kernel/admin`, `@kernel/ui`) is the React + TanStack Start application — collection lists on TanStack Table, edit forms on TanStack Form, reactive UI state on TanStack Store, long lists and documents virtualized with TanStack Virtual, and optional live/offline client collections on TanStack DB.

Deployment is the final swappable edge. The same artifact runs self-hosted via Docker, Compose, or Kubernetes on Node, Bun, or edge runtimes — or on KernelCMS Cloud, which adds managed multi-tenant hosting, billing, observability, backups, and a global content CDN. Content and config are portable between the two in both directions; there is no lock-in clause and no proprietary export format. For the deeper treatment, see [the deployment model](../10-cloud-operations/00-deployment-models-self-host-vs-cloud.md) and [the package map](../01-architecture/01-monorepo-and-package-topology.md).

## Open Questions

- **Search adapter default.** Postgres FTS is the obvious zero-dependency default, but whether the out-of-box `create-kernel` template wires it automatically or leaves search opt-in is undecided.
- **TanStack DB scope at GA.** Reactive client-side collections are powerful for live/offline admin, but whether they are GA or behind a flag for the first stable release is still being weighed against the maintenance surface.
- **MongoDB feature parity.** Field-level localization and version diffing map cleanly onto SQL; the exact storage strategy (embedded vs. separate collections) for the MongoDB adapter is not yet locked.
