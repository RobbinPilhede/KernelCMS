# Templates, Starters & Examples

KernelCMS ships three tiers of ready-to-run code: **starters** (minimal, opinionated foundations you build on), **example apps** (complete, deployable reference projects), and **use-case templates** (domain-specific schemas you drop into an existing project). All of them are first-class, versioned artifacts maintained in the monorepo against the same CI that gates the core packages — not stale gists that rot two minors behind `@kernel/core`. Everything is reachable through one command, `create-kernel`, which clones, renames, installs, and wires the chosen adapters in a single pass.

```bash
pnpm create kernel@latest my-app --starter blog-postgres
# or pick interactively
pnpm create kernel@latest
```

## The Starter Catalog

Starters answer one question: *what is the smallest correct project that compiles, persists, authenticates, and serves an API?* Each one pins a database adapter, a storage adapter, an auth strategy, and a deployment target. They are deliberately thin — a `kernel.config.ts`, one or two collections, a `globals` singleton, and a runnable admin app. You delete what you don't need rather than hunting for what's missing.

| Starter | DB adapter | Storage | Auth | Runtime / deploy target |
| --- | --- | --- | --- | --- |
| `blank` | `@kernel/db-sqlite` | local disk | cookie session | Node + Docker |
| `blog-postgres` | `@kernel/db-postgres` | S3 | cookie session | Node + Docker Compose |
| `commerce-postgres` | `@kernel/db-postgres` | S3 | session + API keys | Node + Kubernetes |
| `edge-sqlite` | `@kernel/db-sqlite` (libSQL) | R2 | JWT | Bun / Cloudflare edge |
| `mongo-docs` | `@kernel/db-mongodb` | local disk | cookie session | Node + Docker |
| `cloud` | managed | managed CDN | managed | KernelCMS Cloud |

The `--db`, `--storage`, and `--auth` flags override any starter's defaults, because adapters are swappable by design — this is the "choose everything" tenet expressed at scaffold time. Picking `blog-postgres --db sqlite` is valid and produces a coherent project; the scaffolder rewrites the adapter import, the `kernel.config.ts` block, and the generated `docker-compose.yml`.

Every starter's config follows the same shape so the catalog reads consistently:

```ts
// kernel.config.ts (blog-postgres)
import { defineConfig } from '@kernel/core'
import { postgresAdapter } from '@kernel/db-postgres'
import { s3Storage } from '@kernel/storage'
import { cookieSession } from '@kernel/auth'
import { Posts } from './collections/Posts'
import { Media } from './collections/Media'
import { Settings } from './globals/Settings'

export default defineConfig({
  db: postgresAdapter({ url: process.env.DATABASE_URL }),
  storage: s3Storage({ bucket: process.env.S3_BUCKET }),
  auth: cookieSession({ secret: process.env.AUTH_SECRET }),
  collections: [Posts, Media],
  globals: [Settings],
  admin: { user: 'users', meta: { titleSuffix: '— Blog' } },
})
```

Contrast with the field: Payload's `create-payload-app` gives you templates but couples you to its bundled Mongo/Postgres choices and Express/Next host; Strapi's `create-strapi-app` scaffolds a monolith with a fixed admin build pipeline; Sanity's `sanity init` is studio-first and assumes Sanity's hosted Content Lake — there is no self-host parity. KernelCMS starters keep the *infrastructure decision in your hands* and keep the admin and API host on the same TanStack Start app, so a starter is genuinely a starting point and not a framework you have to grow out of.

### How starters stay minimal

A starter is held to a hard ceiling: under ~200 lines of project code excluding generated files, no commented-out blocks, no "TODO: configure this." If a feature needs more than that to demonstrate, it belongs in an example app, not a starter. This boundary is what keeps the catalog usable.

## Example Apps

Example apps are complete, opinionated projects that demonstrate KernelCMS *integrated with a real frontend and real infrastructure*. Where a starter shows the CMS in isolation, an example shows the whole picture: a Next.js or TanStack Start frontend consuming the typed `@kernel/client`, live preview wired through the admin, seeded content, and a deploy script.

```
examples/
├── nextjs-blog/          # @kernel/client + REST, ISR, live preview
├── tanstack-storefront/  # TanStack Start frontend + @kernel/rpc, TanStack DB
├── astro-marketing/      # static export via GraphQL, content CDN
├── docs-site/            # blocks-driven docs with versioning + drafts
└── multi-tenant-saas/    # @kernel/cloud-style tenancy on self-host
```

The flagship is `tanstack-storefront`, which exercises the full TanStack-native stack end to end:

```
┌─────────────────────────────────────────────┐
│  Browser (TanStack Start frontend)           │
│  ─ TanStack Query  → read cache              │
│  ─ TanStack DB     → live/offline product    │
│                       collections            │
└───────────────┬─────────────────────────────┘
                │ typed RPC (server functions)
┌───────────────▼─────────────────────────────┐
│  @kernel/server (TanStack Start API host)    │
│  ─ @kernel/rpc → Local API operation core    │
│  ─ @kernel/db-postgres (Drizzle)             │
└─────────────────────────────────────────────┘
```

The frontend talks to the CMS through the generated client, so types flow from `kernel.config.ts` to the React component with zero hand-written interfaces:

```ts
// examples/tanstack-storefront/src/lib/cms.ts
import { createClient } from '@kernel/client'
import type { Config } from '../../kernel.config'

export const cms = createClient<Config>({
  url: import.meta.env.VITE_CMS_URL,
})

// Fully inferred: `product` is Product, `where`/`sort`/`depth` are typed.
const { docs } = await cms.collections.products.find({
  where: { status: { equals: 'published' } },
  sort: '-updatedAt',
  depth: 1,
})
```

Each example carries a `README.md` with a one-command bootstrap, a `seed.ts` that populates demo content through the Local API (never raw SQL), and an `e2e/` Playwright suite that the CI runs on every PR. That last point is the differentiator: Sanity and Strapi publish many example repos, but a large share are community-owned and untested against current releases. KernelCMS examples are CI-gated, so "it runs" is a guarantee, not a hope.

### What every example must demonstrate

- A real frontend consuming `@kernel/client` over REST, GraphQL, *or* RPC — the example name says which.
- At least one cross-cutting feature: drafts/publish, localization, version history, or access control.
- A working **live preview** + visual editing loop, since that is the feature buyers compare against Sanity's Presentation tool and Storyblok.
- Seed data and a `Dockerfile` or deploy config matching the starter it extends.

See [Live Preview & Visual Editing](../04-admin-ui/10-live-preview-and-visual-editing.md) and The Typed Client for the APIs these examples lean on.

## Use-Case Templates

Templates are not whole projects — they are **schema modules** you compose into an existing config. Each exports collections, globals, fields, and access rules for a domain, so you can assemble a project from parts. Think of them as the content-model equivalent of npm packages.

```ts
// kernel.config.ts — composing two templates
import { defineConfig } from '@kernel/core'
import { postgresAdapter } from '@kernel/db-postgres'
import blog from '@kernel/template-blog'
import ecommerce from '@kernel/template-ecommerce'

export default defineConfig({
  db: postgresAdapter({ url: process.env.DATABASE_URL }),
  collections: [...blog.collections, ...ecommerce.collections],
  globals: [...blog.globals, ...ecommerce.globals],
})
```

A template is a plain object validated by `@kernel/core`, so it composes predictably and can be overridden field-by-field:

```ts
import blog from '@kernel/template-blog'
import { extendCollection } from '@kernel/core'

// Add an SEO group to the template's Posts without forking it.
const Posts = extendCollection(blog.collections.Posts, {
  fields: (f) => [...f, { name: 'seo', type: 'group', fields: seoFields }],
})
```

| Template package | Provides | Notable features used |
| --- | --- | --- |
| `@kernel/template-blog` | Posts, Authors, Categories, Tags | drafts, richText blocks, relationship |
| `@kernel/template-ecommerce` | Products, Variants, Orders, Inventory | access control, async validation |
| `@kernel/template-docs` | Docs, Versions, Navigation global | version history, localization |
| `@kernel/template-marketing` | Pages, blocks library, Redirects | blocks, live preview, i18n + RTL |
| `@kernel/template-portfolio` | Projects, Media, About global | upload, point (geo), tabs |

This composable model is the sharpest contrast with the competition. Strapi's "content-type templates" are project-scoped JSON you import once; Payload has no published template ecosystem beyond example repos; Sanity's schema is reusable but bound to the Studio. Because KernelCMS content is **config-as-code** and a template is just a typed module, templates version independently, publish to npm, and stay portable between self-host and KernelCMS Cloud with no migration step.

## Maintenance Strategy

The whole value proposition collapses if any of this drifts behind core, so maintenance is engineered, not aspirational.

**Monorepo residency.** Starters, examples, and templates live in the same pnpm workspace as `@kernel/*`, build through the same Turborepo pipeline, and depend on `workspace:*` versions. A breaking change in `@kernel/core` fails the example builds in the *same PR* that introduces it, which forces the author to update both at once.

**Version pinning and release coupling.** On every release, a `changeset`-driven job rewrites each scaffold target's published `package.json` to the exact released `@kernel/*` version and tags the example repos `vX.Y.Z`. `create-kernel --version 2.3.0` always reconstructs a project that matches that release.

```
core PR merged ──► Turborepo build (all packages + examples + templates)
              ──► e2e suites (Playwright) on every example
              ──► changeset version bump ──► npm publish + git tags
              ──► nightly: scaffold each starter from registry, build, smoke-test
```

**Nightly scaffold-and-build.** A scheduled job runs `create-kernel` against every starter and template *from the published registry* (not the local workspace), boots the admin, hits a health endpoint, and runs migrations. This catches packaging bugs that a workspace build hides.

**Ownership and tiers.** Every starter and example has a `CODEOWNERS` entry and a support tier: **Tier 1** (core team owns; blocks releases) covers `blank`, `blog-postgres`, `tanstack-storefront`, and the five `@kernel/template-*` packages; **Tier 2** (community-maintained, CI-gated but non-blocking) covers the rest. The tier is printed in each README so users know what they're adopting — a clarity Strapi and Sanity's sprawling example lists never offer.

**Deprecation policy.** A template or example is supported for the current major plus one. When a starter is retired, `create-kernel` still resolves it for pinned versions but prints a migration note pointing at the replacement, so existing pinned projects never break silently.

## Open Questions

- Should `@kernel/template-*` packages declare a **peer-dependency range** on `@kernel/core`, or hard-pin? Ranges ease upgrades but risk a template loading against an incompatible core; hard-pinning is safe but noisy on every release.
- Do we publish a **registry-backed template index** (so `create-kernel` can list community templates) or keep the catalog curated and in-repo only? The former grows reach, the latter protects the "it always builds" guarantee.
- For KernelCMS Cloud, should selecting a use-case template at signup **pre-provision** the matching adapters and CDN config, or stay schema-only to preserve exact self-host parity?
