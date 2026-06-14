<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/kernelcms-logo-dark.svg" />
    <img alt="KernelCMS" src="brand/kernelcms-logo.svg" width="380" />
  </picture>
</p>

<p align="center">
  <a href="https://github.com/RobbinPilhede/KernelCMS/actions/workflows/ci.yml">
    <img alt="CI" src="https://github.com/RobbinPilhede/KernelCMS/actions/workflows/ci.yml/badge.svg" />
  </a>
</p>

<p align="center"><strong>The lightweight, standalone, type-safe headless CMS that does not hijack your framework.</strong></p>

<p align="center">
  <a href="https://kernelcms.com">Website</a> ·
  <a href="https://kernelcms.com/docs/introduction">Documentation</a> ·
  <a href="#features">Features</a> ·
  <a href="https://github.com/RobbinPilhede/KernelCMS">GitHub</a>
</p>

KernelCMS is a config-as-code, end-to-end TypeScript headless CMS. You model your content
in a single `kernel.config.ts` and get a typed content engine, a REST and GraphQL API, a
typed in-process Local API, a polished React admin panel, and a CLI. Pick your own
database, storage, email, image processor, and auth providers through small adapter
contracts, and run it fully self-hosted on a single container.

```bash
npm install kernelcms     # then add a kernel.config.ts and run: npx kernel dev
```

---

## Why KernelCMS

Most modern headless CMSs make you adopt their whole world: a specific framework, a heavy
dependency tree, a particular database, and a build pipeline you do not control. KernelCMS
takes the opposite stance.

|                            | KernelCMS                                                                                      | Typical heavyweight CMS                                      |
| -------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **Framework coupling**     | None. A web-standard `Request` to `Response` server that runs on Node, edge, or any container. | Often welded to one framework that then owns your whole app. |
| **Default database**       | SQLite via Node's built-in `node:sqlite`. Zero native dependencies.                            | Mongo or Postgres, with heavier setup.                       |
| **Install and cold start** | Light and fast. No required runtime dependencies.                                              | Large dependency tree, slow boots.                           |
| **Dev loop**               | `npx kernel dev` plus a single inlined admin bundle.                                           | A full framework build pipeline.                             |
| **Migrations**             | Diff-based, risk-classified, deterministic.                                                    | Frequently a pain point.                                     |
| **Deploy**                 | One container, anywhere.                                                                       | Often tied to one host shape.                                |
| **Heavy features**         | Optional adapters (Postgres, S3, image, OAuth, GraphQL, MCP). Core stays tiny.                 | Batteries baked into the core install.                       |

The guiding rule of the whole codebase: heavy or opinionated dependencies live behind
optional adapters, never in `@kernel/core`. The lean default is the product — and the same
access-checked engine powers everything on top of it, from RAG-native semantic search to
multi-tenant isolation. See **[Features](#features)** for the full list.

---

## Quickstart

A working CMS, an admin panel, and a typed REST + GraphQL API in three steps.

### 1. Install

```bash
npm install kernelcms
```

The base install is lean: it ships **no required runtime dependencies**. The heavy
integrations are **optional peer dependencies** you add only when you use them — so a
SQLite + local-file + REST deployment never pulls them in:

```bash
npm install pg                                              # only for the Postgres adapter
npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner # only for the S3/R2 storage adapter
npm install graphql                                        # only for the GraphQL endpoint
npm install @modelcontextprotocol/sdk                      # only for the MCP server
```

### 2. Add a `kernel.config.ts`

```ts
import { defineConfig } from 'kernelcms'
import { sqliteAdapter } from 'kernelcms/sqlite'

export default defineConfig({
  // Set KERNEL_SECRET in production; anything works locally.
  secret: process.env.KERNEL_SECRET ?? 'dev-only-secret',
  db: sqliteAdapter({ url: 'file:./content.db' }),
  collections: [
    {
      slug: 'users',
      auth: true, // email + password sign-in, included
      fields: [{ name: 'name', type: 'text' }],
    },
    {
      slug: 'posts',
      access: { read: () => true }, // public reads
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'body', type: 'richText' },
        { name: 'author', type: 'relationship', relationTo: 'users' },
      ],
    },
  ],
})
```

### 3. Run it

```bash
npx kernel dev
```

That creates the database tables, starts the server, and gives you:

- **Admin panel** at http://localhost:3000/admin (the first visit asks you to create your admin account)
- **REST API** at http://localhost:3000/api/posts
- **GraphQL** at http://localhost:3000/api/graphql
- **API reference** at http://localhost:3000/api/docs (OpenAPI spec at `/api/openapi`)

> Prefer a head start? `npx kernel init` scaffolds this `kernel.config.ts` for you.

Edit `kernel.config.ts`, refresh, and the admin and APIs update with it. That is the whole setup.

```bash
# try the API
curl http://localhost:3000/api/health
curl "http://localhost:3000/api/posts?where[title][like]=hello&depth=1"
```

> Needs Node 22.18+ or 24 (it runs your TypeScript config directly, no build step).

---

## Go further

Everything is opt-in on the same config. A few one-liners unlock a lot:

```ts
{
  slug: 'posts',
  versions: { drafts: true }, // drafts, version history, scheduled publish
  fields: [
    { name: 'cover', type: 'upload', relationTo: 'media' },
    // polymorphic relationship to more than one collection
    { name: 'related', type: 'relationship', relationTo: ['posts', 'pages'], hasMany: true },
  ],
}
```

- **Auth:** `auth: { forgotPassword: true, twoFactor: true }` adds email password reset and TOTP two-factor.
- **Uploads + images:** add `storage: localStorage(...)` (or S3 / R2) and `imageSizes` for auto-resized variants.
- **Postgres:** swap `sqliteAdapter` for `postgresAdapter()` and set `DATABASE_URL`. Configs scaffolded by `npx kernel init` are env-driven: set `DATABASE_URL` and they use Postgres, otherwise a local SQLite file.
- **Caching:** add `cache: memoryCache()` (or `dbCache()` / `redisCache()`) and mark a collection `cache: true`. Reads are served read-through and invalidated automatically on write.
- **Search & RAG:** add `search` for full-text, or set `embeddings: { embed }` and mark a collection's search `semantic: true` for semantic / hybrid retrieval — see [Search](#search--ai).
- **AI agents (MCP):** register `agents: [{ id, token, roles, fieldScope }]` and serve your kernel over the Model Context Protocol — `npx kernel mcp`. Agents are scoped, draft-only principals on the same access pipeline as a human.
- **Referential integrity:** give a relationship `onDelete: 'setNull' | 'cascade' | 'restrict'` to clean up references when a document is deleted.
- **Hooks, access rules, localization, background jobs, plugins:** all configured the same way.

For everything else, jump to **[Features](#features)**.

---

## Guides

The full documentation lives at **[kernelcms.com/docs](https://kernelcms.com/docs/introduction)**.
A few guides are also kept alongside the source:

- **[Embedding in Next.js](docs/embedding-nextjs.md)** — mount the full CMS (REST, GraphQL,
  admin) inside a Next.js app: the kernel singleton, the Node.js runtime, external native
  packages, and rate limiting behind a platform proxy.
- **[Conventions & defaults](docs/conventions.md)** — the small non-obvious rules:
  deny-by-default access, `overrideAccess`, drafts→publish, stored vs. virtual computed
  fields, `defaultSort`, the seed convention, env vars, CLI flags, and the `.ts`
  type-stripping requirements for config files.

---

## Build anything: modules & custom endpoints

Collections give you typed CRUD for free. When you need real behavior, add **custom
endpoints** with typed input/output, declarative access, validation through the same error
pipeline as core routes, and automatic inclusion in the OpenAPI docs and typed client:

```ts
import { defineEndpoint } from 'kernelcms'

defineEndpoint({
  method: 'POST',
  path: '/posts/:id/publish',
  access: ({ req }) => Boolean(req.user), // secure by default (authenticated only)
  handler: async ({ input, ctx }) =>
    // ctx = { req, user, local (the typed Local API), logger, request }
    ctx.local.update({ collection: 'posts', id: input.params.id, data: { _status: 'published' } }),
})
```

Bundle a whole feature (collection + endpoints + jobs) into one installable,
conflict-checked **module**:

```ts
import { defineModule, defineEndpoint, defineConfig } from 'kernelcms'

export const comments = defineModule({
  name: 'comments',
  version: '1.0.0',
  collections: [{ slug: 'comments', access: { read: () => true }, fields: [/* … */] }],
  endpoints: [defineEndpoint({ method: 'POST', path: '/comments/:postId', access, handler })],
  jobs: [{ slug: 'moderate-comments', handler: async () => {/* … */} }],
})

export default defineConfig({ /* … */, plugins: [comments] })
```

Scaffold one with `npx kernel generate:module comments`. Input validation accepts any
Zod-compatible schema (`{ parse }`); no Zod dependency is forced on the core.

**Computed fields** derive a value from a single `compute` function. A `virtual` field is
derived on read and not stored; drop `virtual` for a **stored** computed field that is
persisted at write time and therefore sortable and filterable:

```ts
// virtual: derived on read, not stored (not sortable)
{ name: 'word_count', type: 'number', virtual: true,
  compute: ({ doc }) => countWords(doc.body) }

// stored: derived on write, persisted to a real column (sortable/filterable)
{ name: 'sort_key', type: 'number', index: true,
  compute: ({ doc }) => new Date(doc.starts_at).getTime() }
```

---

## What is in the box

The fundamentals ship in the core. Each bullet group below is the always-there baseline;
the opt-in capabilities that build on it are indexed under [Features](#features).

### Content modeling

- Collections and singleton globals, defined as code with full type inference.
- A rich field set: text, textarea, email, slug, code, number, boolean, checkbox, date,
  select, radio, json, point, group, array, blocks (a page builder), rich text,
  relationship, and upload.
- Reverse relationships through a virtual `join` field, plus polymorphic relationships
  with `relationTo: ['a', 'b']`.
- Referential integrity per relationship/upload field: `onDelete: 'setNull' | 'cascade' |
  'restrict'` (with cycle protection).
- Presentational layout containers: rows, tabs, and UI slots.
- Computed (virtual) fields, per-field localization with fallbacks, and per-field
  personalization (audience variants + A/B).
- Conditional fields, default values, validation, read-only/hidden flags, and sidebar
  field positioning.

### Data and APIs

- Collection-level and field-level access control returning a boolean or a row-level
  filter, with role-based rules.
- Lifecycle hooks: `beforeChange`, `afterChange`, `afterRead`, `beforeDelete`, `afterDelete`.
- Auto-generated REST API with filtering, sorting, pagination, relationship depth, and bulk
  operations, plus an auto-generated GraphQL endpoint.
- Custom typed endpoints (`defineEndpoint`) and feature modules (`defineModule`).
- A generated OpenAPI spec at `/api/openapi` and an interactive API reference at `/api/docs`.
- A fully typed in-process Local API with the exact same operations.
- Versions and drafts with a draft → publish lifecycle and scheduled publishing. Publishing
  is a distinct, access-controlled transition (`access.publish`).

### Auth

- Scrypt password hashing and stateless, JWT-compatible tokens.
- Per-document API keys for machine clients and brute-force protection on login.
- Authority fields (`roles`, `permissions`, …) on auth collections are admin-write by
  default, so self-service privilege escalation is blocked out of the box.
- Email-based password reset and verification through a pluggable email adapter, TOTP
  two-factor on `node:crypto`, and OAuth sign-in (Google and GitHub presets).
- AI agents as first-class, access-controlled, draft-only principals, served over the
  Model Context Protocol (`@kernel/mcp`).

### Media

- Uploads with local disk and S3 or R2 storage adapters.
- Optional image transforms (multiple sizes, focal point, format re-encode) through the
  `@kernel/image-sharp` adapter — install it only if you need it.
- [Signed asset URLs](docs/signed-asset-urls.md) — bearer-capability links for private files.

### Admin panel

- A React app on TanStack Router, Query, and Table: dashboard, list views with search, a
  filter builder, bulk actions, column visibility, and a config-driven editor for every
  field type.
- A rich text editor with a slash menu and floating selection toolbar, live preview, a
  command palette, light/dark themes, and a guided first-run **Connectors** step.
- Extensible through `window.KernelCMS` registries: custom field components, list-cell
  renderers, and dashboard widgets.

### Tooling and operations

- A `kernel` CLI: `init`, `generate:module`, `generate:types`, `migrate`, `migrate:status`,
  `migrate:snapshot`, `seed`, `dev`, `start`, `jobs:run`, `import`, `info`, and `doctor`.
- Diff-based, risk-classified, deterministic schema migrations and TypeScript codegen.
- A background jobs system, a typed fetch client for browser/Node/edge, and a plugin system
  that transforms config in dependency order (SEO plugin included as an example).

---

## Features

Every capability below builds on the same access-checked engine — a read never surfaces a
document or field the caller can't see, on any surface. Each links to its guide.

### Content & editing

| Feature                                            | What it does                                                                  |
| -------------------------------------------------- | ----------------------------------------------------------------------------- |
| [Templates](docs/content-templates.md)             | Reusable document skeletons; "New from template" pre-fills via normal create. |
| [Snippets](docs/content-snippets.md)               | Reusable content fragments, transcluded on read (access-checked).             |
| [Editorial comments](docs/content-comments.md)     | Threaded review annotations, gated by document read access.                   |
| [Saved views](docs/saved-views.md)                 | Smart collections: stored filter / sort / column presets.                     |
| [Field encryption](docs/field-encryption.md)       | AES-256-GCM at rest with no plaintext leak surfaces.                          |
| [Content QA & linting](docs/content-qa.md)         | On-demand, eval-based content quality checks.                                 |

### Versioning & publishing

| Feature                                          | What it does                                                                 |
| ------------------------------------------------ | ---------------------------------------------------------------------------- |
| [Time-machine](docs/time-machine.md)             | Point-in-time reads (`asOf`), field-by-field diff, one-call restore.         |
| [Activity timeline](docs/activity-timeline.md)   | One feed from versions + comments + reviews + audit.                         |
| [Releases](docs/releases.md)                     | Atomic, schedulable publishing bundles with all-or-nothing pre-flight.       |
| [Branches](docs/content-branches.md)             | Copy-on-write staged overlays, merged via the access-checked update.         |
| [Federation](docs/content-federation.md)         | Portable export + access-checked sync between environments.                  |
| [Lifecycle](docs/content-lifecycle.md)           | Auto-expire, archive, or delete on a schedule.                               |

### Search & AI

| Feature                                              | What it does                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------ |
| [Search](docs/semantic-search.md)                    | Full-text, semantic, and hybrid (Reciprocal Rank Fusion), access-checked.      |
| [Knowledge graph & GraphRAG](docs/knowledge-graph.md)| Typed relationships as edges; graph-expanded retrieval context.                |
| [Content intelligence](docs/content-intelligence.md) | Related-content ("more like this") and near-duplicate detection.               |
| [AI discoverability](docs/ai-discoverability.md)     | `llms.txt`, GEO markdown, and retrieval chunks — published content only.       |
| [Structured data](docs/structured-data.md)           | schema.org JSON-LD generated from your typed model.                            |
| [Agentic workflows](docs/agentic-workflows.md)       | Governed autonomous content pipelines (draft → eval gate → human review).      |
| [AI translation](docs/ai-translation.md)             | Auto-fill missing locales via a pluggable provider, as access-checked writes.  |

### Delivery & operations

| Feature                                            | What it does                                                                  |
| -------------------------------------------------- | ----------------------------------------------------------------------------- |
| [Real-time](docs/realtime.md)                      | Access-filtered change feed: CDC pull + live SSE push.                        |
| [Webhooks](docs/webhooks.md)                       | Signed outbound POSTs with durable, at-least-once delivery + SSRF guard.      |
| [Saved-search alerts](docs/saved-search-alerts.md) | Standing queries delivered to a webhook when matching content changes.        |
| [Edge delivery](docs/edge-delivery.md)             | Cache tags (`Surrogate-Key`) + change-driven CDN purge feed.                  |
| [Analytics](docs/analytics.md)                     | Privacy-first content + AI-retrieval insights, no PII at rest.                |
| [Personalization & A/B](docs/personalization.md)   | Audience variants + deterministic sticky experiments.                         |
| [Content decisions](docs/content-decisions.md)     | Audience-targeted, sticky, published-only delivery endpoint.                  |
| [Multi-tenancy](docs/multi-tenancy.md)             | One instance, many tenants, principal-derived airtight isolation.             |

---

## Architecture in one line

`kernel.config.ts` (config as code) goes into `@kernel/core`, which compiles a schema and
runs every operation through defaults, access, hooks, validation, serialize, adapter, and
populate. That pipeline is exposed in-process as the Local API and over HTTP by
`@kernel/server`, consumed by the typed client and the TanStack admin. The core depends only
on contracts and never on a driver, which is what makes the database, storage, email, image
processor, and auth all swappable adapters.

---

## Packages

| Package                 | Responsibility                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `kernelcms`             | The published meta-package. Re-exports core plus adapters under subpaths.                               |
| `@kernel/core`          | Config, fields, operations, validation, access, auth, jobs, codegen, Local API.                        |
| `@kernel/db`            | The database adapter contract and query AST.                                                            |
| `@kernel/db-sqlite`     | SQLite adapter built on `node:sqlite`.                                                                  |
| `@kernel/db-postgres`   | Pooled PostgreSQL adapter.                                                                              |
| `@kernel/server`        | Web-standard `Request` to `Response` REST handler plus a Node http adapter.                             |
| `@kernel/graphql`       | GraphQL schema generation and executor.                                                                |
| `@kernel/mcp`           | MCP server: agent-safe, access-gated tools auto-generated from your model.                              |
| `@kernel/client`        | Typed fetch client.                                                                                     |
| `@kernel/cli`           | The `kernel` command-line tool.                                                                         |
| `@kernel/storage`       | Storage adapter contract with local, S3 or R2, and memory adapters, plus the image-processor contract. |
| `@kernel/image-sharp`   | Optional `sharp`-backed image processor.                                                                |
| `@kernel/richtext`      | Rich text schema, sanitization, and rendering.                                                          |
| `@kernel/admin-app`     | The React and TanStack admin panel.                                                                     |
| `@kernel/plugin-seo`    | Example plugin: SEO fields with optional auto-generation.                                               |
| `@kernel/testing`       | Test utilities.                                                                                         |
| `@kernel/create-kernel` | The `npm create kernel` scaffolder.                                                                     |

---

## Develop

```bash
pnpm typecheck                        # tsc across all packages
pnpm test                             # vitest: engine, HTTP API, adapters
pnpm --filter @kernel/admin-app build # bundle the admin
pnpm kernel -- --help                 # the CLI
```

See **[CONTRIBUTING.md](./CONTRIBUTING.md)** to get set up.

---

## Stability & versioning

KernelCMS follows [Semantic Versioning](https://semver.org/). It is pre-1.0: on the `0.x`
line a **minor** can carry a documented breaking change (with a migration note and, for
stable APIs, a deprecation first), while a **patch** never breaks the public API. What
counts as the public API, which features are still **experimental**, the deprecation policy,
and the road to 1.0 are all in **[STABILITY.md](./STABILITY.md)**. Pin the version you
deploy and skim the changelog before bumping across a minor.

---

## Security notes

- Secure by default: writes require authentication unless a collection opts into public access.
- No accidental privilege escalation: on an auth collection, authority fields (`roles`,
  `role`, `permissions`, `is_admin`, `is_staff`, `is_superuser`) are admin-write by default,
  so even a user who can update their own record cannot promote themselves. An explicit
  field-level `access` rule overrides the default; trusted server paths (seed, first-admin
  setup, OAuth provisioning) still set them.
- SQL identifiers are validated and all values are parameterized.
- Passwords are scrypt-hashed and never returned. Reset, verification, and TOTP secrets are
  never exposed through the API, and their field names are kept out of the OpenAPI spec.
- No user-enumeration on the password reset and verification flows.
- Custom endpoints are secure by default (authenticated only) until you set an `access` rule,
  share the same validation and error pipeline, and cannot shadow built-in auth or system routes.
- Computed fields are evaluated after field-read access is applied, so they cannot leak a
  value the caller is not allowed to read.
- AI agents are scoped, draft-only principals on the same access pipeline: every call runs
  the collection's access rules with the agent's `fieldScope`, never sets `overrideAccess`,
  and cannot publish. The guarantees live in `@kernel/core`, not the MCP layer.
- Set `KERNEL_SECRET` in any non-local environment. For production CORS, use an explicit
  origin allow-list rather than a wildcard with credentials.

Reporting a vulnerability and the operator hardening checklist are in **[SECURITY.md](./SECURITY.md)**.

---

## License

MIT for the core. See [LICENSE](./LICENSE).
