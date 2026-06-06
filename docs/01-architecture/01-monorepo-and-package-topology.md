# Monorepo & Package Topology

KernelCMS ships as a single pnpm workspace orchestrated by Turborepo. Every published surface — the operation core, the server host, the React admin, the field UI kit, each database adapter, and the wire APIs — is a separate `@kernel/*` package with explicit boundaries and a one-directional dependency graph. This document specifies the workspace layout, the canonical package list and what each one owns, the import rules that keep the graph acyclic, and the Turborepo pipeline that builds, types, lints, and tests the whole thing with content-hashed caching.

## Why a monorepo at all

Payload publishes a near-monolithic `payload` package plus a handful of adapters; Strapi splits into dozens of `@strapi/*` packages but couples them tightly through a runtime plugin registry; Sanity's core is a large multi-package repo where the studio and the content backend are not cleanly separable. KernelCMS takes the position that **every infrastructure concern is a swappable adapter**, and a monorepo with hard package boundaries is the only way to enforce that at compile time. If `@kernel/core` can import `@kernel/db-postgres`, the "choose everything" promise is already dead. The boundary rules below are what make the adapter model real rather than aspirational.

## pnpm workspace layout

The repo uses pnpm because its content-addressable store and strict, non-flat `node_modules` catch phantom dependencies — a package can only import what it declares. That strictness is a feature here: it is the first line of defense for the boundary rules.

```
kernelcms/
├── pnpm-workspace.yaml
├── turbo.json
├── package.json            # root: scripts, devDeps, no runtime deps
├── tsconfig.base.json      # shared compiler options, path-less
├── packages/               # all publishable @kernel/* packages
│   ├── core/
│   ├── server/
│   ├── admin/
│   ├── ui/
│   ├── db/
│   ├── db-postgres/
│   ├── db-sqlite/
│   ├── db-mysql/
│   ├── db-mongodb/
│   ├── storage/
│   ├── auth/
│   ├── graphql/
│   ├── rest/
│   ├── rpc/
│   ├── richtext/
│   ├── cli/
│   ├── client/
│   ├── plugin-sdk/
│   └── cloud/
├── apps/                   # non-published runnable apps
│   ├── create-kernel/      # the scaffolder (ships as create-kernel)
│   ├── docs/               # this documentation site
│   └── playground/         # internal dev harness, never published
└── examples/               # reference kernel.config.ts projects
    ├── blog-postgres/
    ├── ecommerce-mongodb/
    └── edge-sqlite/
```

```yaml
# pnpm-workspace.yaml
packages:
  - "packages/*"
  - "apps/*"
  - "examples/*"
```

Internal dependencies are declared with the `workspace:` protocol so they resolve to local source during development and to exact versions on publish:

```jsonc
// packages/server/package.json
{
  "name": "@kernel/server",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@kernel/core": "workspace:*",
    "@kernel/rest": "workspace:*",
    "@kernel/graphql": "workspace:*",
    "@kernel/rpc": "workspace:*"
  }
}
```

We publish from TypeScript source-first packages that build to `dist/` with `tsup`. During local dev, `exports` points at `./src/index.ts` so Turborepo never has to rebuild a dependency before the admin app can consume it — type checking is global and incremental instead.

## The @kernel/* package list

The graph has a strict spine: a dependency-free **core**, **adapter contracts**, **adapter implementations**, **API generators**, and **consumers** (server, admin, client). Nothing below ever points back up.

| Package | Layer | Owns | May depend on |
| --- | --- | --- | --- |
| `@kernel/core` | Core | Collection/global/field config types, the operation core (`create/read/update/delete/find`), the shared query language (`where`/`sort`/pagination/`depth`), validation, access-control evaluation, hooks | nothing internal |
| `@kernel/db` | Contract | The `Adapter` interface, migration diff types, transaction contract | `@kernel/core` |
| `@kernel/db-postgres` | Adapter | Drizzle Postgres implementation of `Adapter` (default) | `@kernel/db`, `@kernel/core` |
| `@kernel/db-sqlite` | Adapter | Drizzle SQLite/libSQL implementation | `@kernel/db`, `@kernel/core` |
| `@kernel/db-mysql` | Adapter | Drizzle MySQL implementation | `@kernel/db`, `@kernel/core` |
| `@kernel/db-mongodb` | Adapter | Document-oriented implementation of `Adapter` | `@kernel/db`, `@kernel/core` |
| `@kernel/storage` | Adapter | File storage contract + built-in disk/S3 drivers | `@kernel/core` |
| `@kernel/auth` | Adapter | Auth strategy contract, session/JWT, password hashing | `@kernel/core` |
| `@kernel/rest` | API gen | REST router generated from content config | `@kernel/core` |
| `@kernel/graphql` | API gen | GraphQL schema + resolvers from content config | `@kernel/core` |
| `@kernel/rpc` | API gen | Typed RPC over TanStack Start server functions | `@kernel/core` |
| `@kernel/richtext` | Feature | Block-based rich-text document model + serializers | `@kernel/core` |
| `@kernel/server` | Consumer | TanStack Start host wiring adapters + API generators | core, db, storage, auth, rest, graphql, rpc |
| `@kernel/ui` | UI kit | Field components, design tokens, primitives (no data) | `@kernel/core` (types only) |
| `@kernel/admin` | Consumer | React admin on TanStack Start/Router/Query/Table/Form/Store/Virtual | core, ui, client, richtext |
| `@kernel/client` | Consumer | Typed fetch client over REST/RPC, optional TanStack DB collections | `@kernel/core` (types only) |
| `@kernel/plugin-sdk` | SDK | Plugin authoring contract, lifecycle hooks, typed extension points | `@kernel/core` |
| `@kernel/cli` | Tooling | The `kernel` binary: migrate, generate, dev, build | core, db, server |
| `@kernel/cloud` | Consumer | KernelCMS Cloud control plane glue (multi-tenant, billing hooks) | server, core |

A representative `kernel.config.ts` shows how the packages compose at the application layer — the user picks adapters; the core never names them:

```ts
import { defineConfig } from "@kernel/core";
import { postgresAdapter } from "@kernel/db-postgres";
import { s3Storage } from "@kernel/storage";
import { jwtAuth } from "@kernel/auth";
import { Posts } from "./collections/Posts";
import { SiteSettings } from "./globals/SiteSettings";

export default defineConfig({
  db: postgresAdapter({ url: process.env.DATABASE_URL! }),
  storage: s3Storage({ bucket: "media", region: "eu-north-1" }),
  auth: jwtAuth({ secret: process.env.AUTH_SECRET! }),
  collections: [Posts],
  globals: [SiteSettings],
});
```

`defineConfig` lives in `@kernel/core` and is the single source of truth (see [Config-as-Code](./adr/0003-config-as-code.md)). `postgresAdapter` satisfies the `Adapter` contract from `@kernel/db` (see [Database Adapters](../03-persistence/00-persistence-overview-and-adapter-contract.md)). Swapping to `@kernel/db-mongodb` is a one-line change with zero edits elsewhere — the whole point.

## Dependency boundary rules

The rules are mechanically enforced, not documented-and-hoped-for. Three mechanisms stack:

1. **Declared deps only.** pnpm's strict layout means an undeclared import fails at runtime in dev and at build immediately. There is no hoisting to lean on.
2. **`eslint-plugin-boundaries`.** Every package is tagged with its layer; forbidden edges are lint errors in CI.
3. **`dependency-cruiser` graph check.** A `pnpm graph:check` task asserts the DAG is acyclic and that no banned edge exists, and renders the graph for review.

The canonical rules:

```text
core  ──►  (nothing internal)            # the root; pure types + operations
db, storage, auth, rest, graphql, rpc, richtext, ui, client, plugin-sdk
      ──►  core only
db-{postgres,sqlite,mysql,mongodb}
      ──►  db, core
server ──►  core, db, storage, auth, rest, graphql, rpc
admin  ──►  core, ui, client, richtext
cli    ──►  core, db, server
cloud  ──►  server, core
```

Hard prohibitions, each a CI failure:

- **Core imports no adapter.** `@kernel/core` must never reference `@kernel/db-postgres`, `@kernel/storage`, or any concrete backend. If core needs a capability, it defines a contract and receives an implementation through `defineConfig`. This is exactly where Strapi leaks — its core reaches into specific providers — and where KernelCMS holds the line.
- **Adapters don't import each other.** `@kernel/db-postgres` cannot see `@kernel/db-mysql`. Shared logic goes up into `@kernel/db`.
- **`@kernel/ui` is data-blind.** It imports config *types* from core but never the operation core, never `@kernel/client`, never a query. Components receive values and callbacks as props so the kit stays portable and Storybook-able. Contrast Sanity, where studio input components are wired into the content store.
- **No `apps/*` or `examples/*` is a dependency of any `packages/*`.** The arrow only points from apps into packages.
- **Type-only edges are explicit.** Where a package needs core's types but none of its runtime, it uses `import type` and declares the dep so the boundary remains visible.

```text
        ┌──────────────────────────────────────────────┐
        │                 @kernel/core                  │
        │   config types · operation core · query DSL   │
        └───▲───────▲───────▲───────▲───────▲──────▲────┘
            │       │       │       │       │      │
        ┌───┴──┐ ┌──┴──┐ ┌──┴──┐ ┌──┴──┐ ┌──┴──┐ ┌─┴────┐
        │  db  │ │ rest│ │graph│ │ rpc │ │ auth│ │  ui  │
        └───▲──┘ └──┬──┘ └──┬──┘ └──┬──┘ └──┬──┘ └─┬────┘
   db-postgres      │       │       │       │      │
   db-sqlite   ┌────┴───────┴───────┴───────┴──┐  admin
   db-mysql    │          @kernel/server        │
   db-mongodb  └────────────────▲───────────────┘
                                │
                          @kernel/cli, @kernel/cloud
```

## Turborepo build pipeline

Turborepo handles task scheduling and caching across the graph. Tasks are defined once and run in dependency order with content-hash-based caching, so a change in `@kernel/core` invalidates exactly its dependents and nothing else.

```jsonc
// turbo.json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "inputs": ["src/**", "tsconfig.json", "package.json"],
      "outputs": ["dist/**"]
    },
    "typecheck": {
      "dependsOn": ["^build"],
      "inputs": ["src/**", "tsconfig.json", "../../tsconfig.base.json"],
      "outputs": []
    },
    "lint": { "outputs": [] },
    "test": {
      "dependsOn": ["^build"],
      "inputs": ["src/**", "test/**"],
      "outputs": ["coverage/**"]
    },
    "graph:check": { "cache": false }
  }
}
```

The `^build` upstream dependency is what makes the topology pay off: `pnpm turbo run typecheck` builds every dependency once, then type-checks consumers against fresh declaration output, fanning out to the maximum safe parallelism. Local runs hit the local cache; CI shares a remote cache keyed by the same content hashes, so a PR that only touches `@kernel/admin` reuses cached `core`, `db`, and adapter artifacts and runs in seconds.

Common entry points:

| Command | Effect |
| --- | --- |
| `pnpm turbo run build` | Build all packages in topo order |
| `pnpm turbo run typecheck --filter=@kernel/admin...` | Type-check admin and everything it depends on |
| `pnpm turbo run test --filter=...[origin/main]` | Test only packages changed since `main` |
| `pnpm turbo run graph:check` | Assert the DAG is acyclic, render the graph |
| `pnpm --filter @kernel/cli dev` | Run a single package in watch mode |

CI runs `build`, `typecheck`, `lint`, `test`, and `graph:check` as a single `turbo run` invocation. Because `graph:check` is `cache: false`, the boundary rules are re-verified on every run even when everything else is a cache hit — the topology can never silently rot.

## Open questions

- **Adapter versioning across the `Adapter` contract.** Should `@kernel/db` use a single lockstep version with all adapters, or independent semver with a declared peer range? Lockstep is simpler for the default install; independent versions matter once third-party adapters exist.
- **Where `@kernel/cloud` draws its boundary.** It currently depends on `@kernel/server`. If Cloud needs to run the operation core without the full TanStack Start host (e.g. in edge functions), some of that wiring may need to move down into a thinner `@kernel/server-core`.
- **Splitting `@kernel/ui`.** As the field component set grows, primitives vs. field-specific components may warrant separation (`@kernel/ui` + `@kernel/fields`) to keep white-label theming tractable.
