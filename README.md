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

KernelCMS is a config-as-code, end-to-end TypeScript headless CMS. You model your
content in a single `kernel.config.ts`, and you get a typed content engine, a REST and
GraphQL API, a typed in-process Local API, a polished React admin panel, and a CLI.
Pick your own database, storage, email, image processor, and auth providers through
small adapter contracts. Run it fully self-hosted on a single container.

And when the built-in CRUD is not enough, you build your own: typed custom endpoints,
computed fields, and whole feature **modules** (collection + endpoints + jobs in one
unit). Everything is type-safe, access-controlled, and auto-documented with a built-in
OpenAPI spec and an interactive API reference.

```bash
npm install kernelcms     # then add a kernel.config.ts and run: npx kernel dev
```

---

## Why KernelCMS

Most modern headless CMSs make you adopt their whole world: a specific framework, a
heavy dependency tree, a particular database, and a build pipeline you do not control.
KernelCMS takes the opposite stance.

|                            | KernelCMS                                                                                      | Typical heavyweight CMS                                      |
| -------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **Framework coupling**     | None. A web-standard `Request` to `Response` server that runs on Node, edge, or any container. | Often welded to one framework that then owns your whole app. |
| **Default database**       | SQLite via Node's built-in `node:sqlite`. Zero native dependencies.                            | Mongo or Postgres, with heavier setup.                       |
| **Install and cold start** | Light and fast.                                                                                | Large dependency tree, slow boots.                           |
| **Dev loop**               | `npx kernel dev` plus a single inlined admin bundle.                                           | A full framework build pipeline.                             |
| **Migrations**             | Diff-based, risk-classified, deterministic.                                                    | Frequently a pain point.                                     |
| **Deploy**                 | One container, anywhere.                                                                       | Often tied to one host shape.                                |
| **Heavy features**         | Optional adapters (email, image, OAuth). Core stays tiny.                                      | Batteries baked into the core install.                       |

The guiding rule of the whole codebase: heavy or opinionated dependencies live behind
optional adapters, never in `@kernel/core`. The lean default is the product.

---

## Quickstart

A working CMS, an admin panel, and a typed REST + GraphQL API in three steps.

### 1. Install

```bash
npm install kernelcms
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
- **Postgres:** swap `sqliteAdapter` for `postgresAdapter()` and set `DATABASE_URL` (or pick it in the first-run Connectors step). Configs scaffolded by `npx kernel init` are already env-driven: set `DATABASE_URL` and they use Postgres, otherwise a local SQLite file.
- **Caching:** add `cache: memoryCache()` (or `dbCache()` / `redisCache()`) and mark a collection `cache: true`. Reads are served read-through and invalidated automatically on write. See [Caching](docs/03-persistence/caching.md).
- **Search:** add `search: memorySearch()` and give a collection `search: { fields: ['title', 'body'] }`, then `kernel.searchDocs({ collection, query })`. Hits are loaded through the access-checked read path, so search never surfaces a document the caller cannot read.
- **Webhooks + rate limiting:** `webhooks: [{ url, secret }]` fires signed HTTP POSTs on change; the server rate-limits every endpoint (stricter on auth) and sends HSTS / Permissions-Policy headers.
- **Hooks, access rules, localization, background jobs, plugins:** all configured the same way.

See [What is in the box](#what-is-in-the-box) for the full list.

---

## Build anything: modules & custom endpoints

Collections give you typed CRUD for free. When you need real behavior, add **custom
endpoints** with typed input/output, declarative access, validation through the same
error pipeline as core routes, and automatic inclusion in the OpenAPI docs and typed
client:

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

**Computed (virtual) fields** derive a value on read without storing it, so business
logic lives in one place and stays read-only in the admin:

```ts
{ name: 'word_count', type: 'number', virtual: true,
  compute: ({ doc }) => countWords(doc.body) }
```

---

## What is in the box

### Content modeling

- Collections and singleton globals, defined as code with full type inference.
- A rich field set: text, textarea, email, slug, code, number, boolean, checkbox,
  date, select, radio, json, point, group, array, blocks (a page builder), rich text,
  relationship, and upload.
- Reverse relationships through a virtual `join` field, plus polymorphic
  relationships with `relationTo: ['a', 'b']`.
- Presentational layout containers: rows, tabs, and UI slots.
- Computed (virtual) fields: `virtual: true` + `compute({ doc, req })`, derived on read,
  never stored, read-only in the admin.
- Per-field localization with a configurable locale set and fallbacks.
- Conditional fields, default values, validation, read-only and hidden flags, and
  sidebar field positioning.

### Data and APIs

- Collection-level and field-level access control that returns a boolean or a row-level
  filter, with role-based rules.
- Lifecycle hooks: `beforeChange`, `afterChange`, `afterRead`, `beforeDelete`, and
  `afterDelete`.
- Auto-generated REST API with filtering, sorting, pagination, relationship depth, and
  bulk operations.
- An auto-generated GraphQL endpoint.
- Custom typed endpoints (`defineEndpoint`) and feature modules (`defineModule`) that
  bundle a collection + endpoints + jobs as one conflict-checked unit.
- A generated OpenAPI spec at `/api/openapi` and an interactive API reference at
  `/api/docs`, covering collections, globals, and your custom endpoints.
- Localized, structured error responses (`{ error: { code, message } }`) rendered for
  the request's locale at the boundary.
- A fully typed in-process Local API with the exact same operations.
- Versions and drafts, including a draft and publish lifecycle and scheduled publishing.

### Auth

- Scrypt password hashing and stateless, JWT-compatible tokens.
- Per-document API keys for machine clients.
- Brute-force protection on login.
- Email-based password reset and email verification, powered by a pluggable email
  adapter (console, memory, or HTTP, all dependency-free).
- TOTP two-factor auth, implemented on `node:crypto` with no extra dependencies.
- OAuth sign-in through a small provider adapter, with Google and GitHub presets.

### Media

- Uploads with local disk and S3 or R2 storage adapters.
- Optional image transforms (multiple sizes, focal point, format re-encode) through the
  `@kernel/image-sharp` adapter. Install it only if you need it; the core stays
  native-dependency-free.

### Admin panel

- A React app on TanStack Router, Query, and Table.
- A welcoming dashboard, list views with search, a filter builder, bulk actions, and
  column visibility, plus a config-driven editor for every field type.
- A rich text editor with a slash menu and a floating selection toolbar.
- Live preview with a built-in renderer, or point it at your own frontend.
- A guided first-run welcome with a Connectors step: choose your database,
  storage, email, or sign-in provider during setup. Pick PostgreSQL, paste a
  connection string, and KernelCMS writes `DATABASE_URL` to your `.env`; restart
  to apply it through the env-driven config. A Connectors panel in the sidebar
  lets you review and add connectors anytime.
- A command palette, light and dark themes, and smooth page and content animations.
- Extensible through `window.KernelCMS` registries: custom field components, list-cell
  renderers, and dashboard widgets.

### Tooling and operations

- A `kernel` CLI: `init`, `generate:module`, `generate:types`, `migrate`,
  `migrate:status`, `migrate:snapshot`, `seed`, `dev`, `start`, `jobs:run`, `import`,
  `info`, and `doctor`.
- Diff-based, risk-classified, deterministic schema migrations.
- TypeScript codegen from your content model.
- A background jobs system: define handlers, enqueue work, and drain due jobs from a
  cron with `kernel jobs:run`.
- A typed fetch client for browser, Node, and edge runtimes, including a
  `client.endpoint(...)` call for your custom endpoints.
- A plugin system that transforms config in dependency order, with an SEO plugin
  included as an example.

---

## Architecture in one line

`kernel.config.ts` (config as code) goes into `@kernel/core`, which compiles a schema
and runs every operation through defaults, access, hooks, validation, serialize,
adapter, and populate. That pipeline is exposed in-process as the Local API and over
HTTP by `@kernel/server`, consumed by the typed client and the TanStack admin. The core
depends only on contracts and never on a driver, which is what makes the database,
storage, email, image processor, and auth all swappable adapters.

---

## Packages

| Package                 | Responsibility                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `kernelcms`             | The published meta-package. Re-exports core plus adapters under subpaths.                              |
| `@kernel/core`          | Config, fields, operations, validation, access, auth, jobs, codegen, Local API.                        |
| `@kernel/db`            | The database adapter contract and query AST.                                                           |
| `@kernel/db-sqlite`     | SQLite adapter built on `node:sqlite`.                                                                 |
| `@kernel/db-postgres`   | Pooled PostgreSQL adapter.                                                                             |
| `@kernel/server`        | Web-standard `Request` to `Response` REST handler plus a Node http adapter.                            |
| `@kernel/graphql`       | GraphQL schema generation and executor.                                                                |
| `@kernel/client`        | Typed fetch client.                                                                                    |
| `@kernel/cli`           | The `kernel` command-line tool.                                                                        |
| `@kernel/storage`       | Storage adapter contract with local, S3 or R2, and memory adapters, plus the image-processor contract. |
| `@kernel/image-sharp`   | Optional `sharp`-backed image processor.                                                               |
| `@kernel/richtext`      | Rich text schema, sanitization, and rendering.                                                         |
| `@kernel/admin-app`     | The React and TanStack admin panel.                                                                    |
| `@kernel/plugin-seo`    | Example plugin: SEO fields with optional auto-generation.                                              |
| `@kernel/testing`       | Test utilities.                                                                                        |
| `@kernel/create-kernel` | The `npm create kernel` scaffolder.                                                                    |

---

## Develop

```bash
pnpm typecheck                        # tsc across all packages
pnpm test                             # vitest: engine, HTTP API, adapters
pnpm --filter @kernel/admin-app build # bundle the admin
pnpm kernel -- --help                 # the CLI
```

---

## Security notes

- Secure by default: writes require authentication unless a collection opts into public
  access.
- SQL identifiers are validated and all values are parameterized.
- Passwords are scrypt-hashed and never returned. Reset, verification, and TOTP secrets
  are never exposed through the API, and their field names are kept out of the OpenAPI
  spec and config descriptor.
- No user-enumeration on the password reset and verification flows.
- Custom endpoints are secure by default (authenticated only) until you set an `access`
  rule, share the same validation and error pipeline, and cannot shadow built-in auth
  or system routes.
- Computed fields are evaluated after field-read access is applied, so they cannot leak
  a value the caller is not allowed to read.
- Set `KERNEL_SECRET` in any non-local environment. For production CORS, use an explicit
  origin allow-list rather than a wildcard with credentials.

---

## License

MIT for the core.
