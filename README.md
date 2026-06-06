# KernelCMS

[![CI](https://github.com/RobbinPilhede/KernelCMS/actions/workflows/ci.yml/badge.svg)](https://github.com/RobbinPilhede/KernelCMS/actions/workflows/ci.yml)

**The lightweight, standalone, type-safe headless CMS that does not hijack your framework.**

KernelCMS is a config-as-code, end-to-end TypeScript headless CMS. You model your
content in a single `kernel.config.ts`, and you get a typed content engine, a REST and
GraphQL API, a typed in-process Local API, a polished React admin panel, and a CLI.
Pick your own database, storage, email, image processor, and auth providers through
small adapter contracts. Run it fully self-hosted on a single container.

```bash
npm create kernel@latest my-app
cd my-app && pnpm dev
```

---

## Why KernelCMS

Most modern headless CMSs make you adopt their whole world: a specific framework, a
heavy dependency tree, a particular database, and a build pipeline you do not control.
KernelCMS takes the opposite stance.

| | KernelCMS | Typical heavyweight CMS |
| --- | --- | --- |
| **Framework coupling** | None. A web-standard `Request` to `Response` server that runs on Node, edge, or any container. | Often welded to one framework that then owns your whole app. |
| **Default database** | SQLite via Node's built-in `node:sqlite`. Zero native dependencies. | Mongo or Postgres, with heavier setup. |
| **Install and cold start** | Light and fast. | Large dependency tree, slow boots. |
| **Dev loop** | `npx kernel dev` plus a single inlined admin bundle. | A full framework build pipeline. |
| **Migrations** | Diff-based, risk-classified, deterministic. | Frequently a pain point. |
| **Deploy** | One container, anywhere. | Often tied to one host shape. |
| **Heavy features** | Optional adapters (email, image, OAuth). Core stays tiny. | Batteries baked into the core install. |

The guiding rule of the whole codebase: heavy or opinionated dependencies live behind
optional adapters, never in `@kernel/core`. The lean default is the product.

---

## Quickstart

### Create a new app

```bash
npm create kernel@latest my-app    # or: pnpm create kernel my-app
cd my-app
pnpm dev                            # open the URL it prints
```

The generated app is fully self-contained and seeds a demo blog, so it runs before any
`@kernel/*` packages are even on npm.

### Or run this monorepo

```bash
pnpm install
pnpm example:seed     # creates ./blog.db with demo content and an admin user
pnpm example:dev      # REST and GraphQL API on http://localhost:3000/api
pnpm admin            # the admin UI on http://localhost:5173
```

Sign in with `admin@example.com` / `password123` (from the seed), then hit the API:

```bash
curl http://localhost:3000/api/health
curl "http://localhost:3000/api/posts?where[status][equals]=published&depth=1"
```

---

## A config is all you need

```ts
import { defineConfig } from 'kernelcms'
import { sqliteAdapter } from 'kernelcms/sqlite'
import { localStorage } from 'kernelcms/storage'

export default defineConfig({
  db: sqliteAdapter({ url: 'file:./content.db' }),
  storage: localStorage({ rootDir: './uploads', servePath: '/files' }),
  collections: [
    {
      slug: 'users',
      auth: { forgotPassword: true, twoFactor: true },
      fields: [{ name: 'name', type: 'text' }],
    },
    {
      slug: 'posts',
      versions: { drafts: true },
      access: { read: () => true },
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'body', type: 'richText' },
        { name: 'author', type: 'relationship', relationTo: 'users' },
      ],
    },
  ],
})
```

That gives you typed CRUD, drafts and version history, auth with optional reset and
two-factor, REST and GraphQL endpoints, and a full admin UI for the model above.

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
- A command palette, light and dark themes, and smooth page and content animations.
- Custom field components through a small registration hook.

### Tooling and operations
- A `kernel` CLI: `migrate`, `migrate:status`, `migrate:snapshot`, `seed`, `dev`,
  `start`, `jobs:run`, `generate:types`, `import`, `info`, and `doctor`.
- Diff-based, risk-classified, deterministic schema migrations.
- TypeScript codegen from your content model.
- A background jobs system: define handlers, enqueue work, and drain due jobs from a
  cron with `kernel jobs:run`.
- A typed fetch client for browser, Node, and edge runtimes.
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

| Package | Responsibility |
| --- | --- |
| `kernelcms` | The published meta-package. Re-exports core plus adapters under subpaths. |
| `@kernel/core` | Config, fields, operations, validation, access, auth, jobs, codegen, Local API. |
| `@kernel/db` | The database adapter contract and query AST. |
| `@kernel/db-sqlite` | SQLite adapter built on `node:sqlite`. |
| `@kernel/db-postgres` | Pooled PostgreSQL adapter. |
| `@kernel/server` | Web-standard `Request` to `Response` REST handler plus a Node http adapter. |
| `@kernel/graphql` | GraphQL schema generation and executor. |
| `@kernel/client` | Typed fetch client. |
| `@kernel/cli` | The `kernel` command-line tool. |
| `@kernel/storage` | Storage adapter contract with local, S3 or R2, and memory adapters, plus the image-processor contract. |
| `@kernel/image-sharp` | Optional `sharp`-backed image processor. |
| `@kernel/richtext` | Rich text schema, sanitization, and rendering. |
| `@kernel/admin-app` | The React and TanStack admin panel. |
| `@kernel/plugin-seo` | Example plugin: SEO fields with optional auto-generation. |
| `@kernel/testing` | Test utilities. |
| `@kernel/create-kernel` | The `npm create kernel` scaffolder. |

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
  are never exposed through the API.
- No user-enumeration on the password reset and verification flows.
- Set `KERNEL_SECRET` in any non-local environment. For production CORS, use an explicit
  origin allow-list rather than a wildcard with credentials.

---

## License

MIT for the core.
