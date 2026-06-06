# CLI & Scaffolding

KernelCMS ships two binaries: `create-kernel`, the one-shot scaffolder that stands up a new project, and `kernel`, the project-local CLI that runs the dev server, builds for production, drives migrations, generates code, and applies codemods. Both are thin, fast, and config-aware — they read your `kernel.config.ts` and act on the same operation core the runtime uses, so the CLI never drifts from the actual schema. This document specifies what each command does, the flags it accepts, and the design decisions behind them. Where Payload, Sanity, or Strapi solve the same problem differently, we say so.

## create-kernel

`create-kernel` is the entry point for a new project. It is published as a standalone package so it can run with zero install:

```bash
pnpm create kernel@latest my-blog
# or
npx create-kernel@latest my-blog
```

The scaffolder is interactive by default and fully scriptable via flags. The prompt flow is intentionally short — four questions, sensible defaults, and you're in a running dev server in under a minute.

```
create-kernel my-blog
├─ Database adapter?   › postgres · sqlite · mysql · mongodb
├─ Storage adapter?    › local · s3 · r2 · gcs
├─ Auth strategy?      › password · oauth · magic-link · none
└─ Starter template?   › blank · blog · ecommerce · docs
```

Every answer maps to a concrete `@kernel/*` package and a generated block of `kernel.config.ts`. Choosing Postgres wires `@kernel/db-postgres`; choosing R2 storage wires `@kernel/storage` with the R2 driver. This is the "choose everything" wedge made tactile at scaffold time — unlike Strapi, which hard-wires its own admin stack and database layer behind `create-strapi-app`, or Sanity, where the dataset and hosting model are fixed by the platform. KernelCMS writes adapters into config you own.

A scaffolded project looks like this:

```
my-blog/
├─ kernel.config.ts        # single source of truth
├─ src/
│  ├─ collections/         # one file per collection
│  ├─ globals/             # singletons
│  ├─ access/              # shared access-control fns
│  └─ fields/              # custom field types
├─ migrations/             # generated, committed to git
├─ .kernel/                # generated types + artifacts (gitignored)
├─ package.json
└─ tsconfig.json
```

### Non-interactive scaffolding

CI and provisioning scripts need determinism. Every prompt has a flag:

```bash
create-kernel my-blog \
  --db postgres \
  --storage s3 \
  --auth password \
  --template blog \
  --pm pnpm \
  --no-install \
  --no-git
```

| Flag           | Purpose                                | Default    |
| -------------- | -------------------------------------- | ---------- |
| `--db`         | Database adapter                       | prompt     |
| `--storage`    | Storage adapter                        | `local`    |
| `--auth`       | Auth strategy                          | `password` |
| `--template`   | Starter template                       | `blank`    |
| `--pm`         | Package manager (`pnpm`/`npm`/`bun`)   | detected   |
| `--no-install` | Skip dependency install                | install    |
| `--no-git`     | Skip `git init`                        | init       |
| `--use-cloud`  | Pre-wire `@kernel/cloud` deploy target | off        |

`--use-cloud` is the only platform-specific flag: it adds the `@kernel/cloud` provider and a deploy hook so the same project pushes to [KernelCMS Cloud](../10-cloud-operations/00-deployment-models-self-host-vs-cloud.md) without changing any content config. Self-host and Cloud share one config; the flag only adds a deploy target.

## The project CLI: `kernel`

Inside a project, `kernel` is the day-to-day tool. It auto-detects the runtime (Node, Bun, or edge dev shim), loads `kernel.config.ts` through the same loader the server uses, and exposes a stable command surface:

```bash
kernel dev          # dev server + admin, HMR, type/REST/GraphQL gen
kernel build        # production build of API host + admin app
kernel start        # serve a production build
kernel migrate      # run/generate/inspect migrations
kernel generate     # scaffold collections, fields, plugins, types
kernel codemod      # apply automated upgrades
kernel types        # emit @kernel/client + Local API types only
kernel info         # print resolved config, adapters, versions
```

The CLI shares its argument parser and config resolver with [`@kernel/server`](../01-architecture/03-runtime-and-server-model.md), so a flag that exists at runtime exists in the CLI. There is no second config dialect to learn — contrast Strapi, which splits behavior across `config/`, environment files, and CLI flags.

## Generators

`kernel generate` (alias `kernel g`) writes typed source you would otherwise hand-roll. Generators are templates, not magic: they emit ordinary files into your `src/` tree that you then own and edit.

```bash
kernel generate collection Posts \
  --fields "title:text,slug:text,body:richText,author:relationship:Users" \
  --drafts --timestamps

kernel generate global SiteSettings --fields "siteName:text,logo:upload"
kernel generate field ColorPicker          # custom field type scaffold
kernel generate plugin analytics           # @kernel/plugin-sdk skeleton
kernel generate access tenantScoped         # access-control function
```

The collection generator produces idiomatic config you can keep or refactor:

```ts
// src/collections/Posts.ts
import { defineCollection } from '@kernel/core'

export const Posts = defineCollection({
  slug: 'posts',
  admin: { useAsTitle: 'title', defaultColumns: ['title', 'author', 'status'] },
  versions: { drafts: true, autosave: true },
  fields: [
    { name: 'title', type: 'text', required: true },
    { name: 'slug', type: 'text', unique: true, index: true },
    { name: 'body', type: 'richText' },
    { name: 'author', type: 'relationship', relationTo: 'users' },
  ],
})
```

There are two design rules here. First, generated code is **plain config** — no decorators, no annotations, nothing the runtime treats specially. Payload and KernelCMS agree on config-as-code; KernelCMS additionally guarantees that anything a generator can write, you can write by hand and vice versa. Second, generators are **idempotent at the field level**: re-running `generate collection Posts --fields "tags:array"` against an existing file adds the `tags` field through an AST transform rather than clobbering your edits. If a field name already exists, it is skipped and reported, never overwritten.

After any generator runs, the CLI re-runs type generation so `@kernel/client` and the Local API immediately reflect the new shape — `import { Post } from '.kernel/types'` is correct before you switch back to your editor.

## dev, build, and migrate

### `kernel dev`

`kernel dev` boots [TanStack Start](../01-architecture/02-tanstack-stack-integration.md) in dev mode and serves the admin app, the auto-generated REST and GraphQL endpoints, and the typed RPC surface from one process.

```
kernel dev
   │
   ├─ load kernel.config.ts ──► resolve adapters (db, storage, auth…)
   ├─ TanStack Start dev server ──► admin (HMR) + API host
   ├─ watch src/** ──► regenerate types, REST schema, GraphQL SDL
   └─ migrate --dev (optional) ──► sync schema diff to dev DB
```

It runs a watcher that regenerates types and the REST/GraphQL schemas on every config change, so the admin and your editor never lag the source. By default `kernel dev` does **not** mutate your database; pass `--push` to apply schema diffs directly for fast local iteration (the Drizzle "push" workflow), or leave it off and use real migrations. Sanity has no migration concept because the dataset is schemaless; KernelCMS treats the schema as code and the database as something you migrate deliberately.

| Flag         | Effect                                                  |
| ------------ | ------------------------------------------------------- |
| `--port <n>` | Admin/API port (default `3000`)                         |
| `--push`     | Apply schema diff to dev DB without writing a migration |
| `--no-open`  | Don't open the browser                                  |
| `--inspect`  | Enable Node/Bun inspector                               |

### `kernel build`

`kernel build` produces a deployable artifact: the TanStack Start server bundle plus the compiled admin SPA. It type-checks the whole project (zero `any` is enforced — the build fails on type errors), bundles per the detected target (`node`, `bun`, or `edge`), and emits a manifest the [deployment adapters](../10-cloud-operations/00-deployment-models-self-host-vs-cloud.md) consume.

```bash
kernel build --target edge
kernel start            # serve the build locally to smoke-test
```

The build refuses to complete with pending migrations whose schema diverges from the config, which prevents the classic "deployed code expects a column the database doesn't have" failure that bites Strapi upgrades.

### `kernel migrate`

Migrations are generated from schema diffs by Drizzle and committed to `migrations/`. The subcommands:

```bash
kernel migrate generate   # diff config vs DB schema → new SQL migration
kernel migrate up         # apply pending migrations
kernel migrate down       # roll back the last migration
kernel migrate status     # list applied / pending
kernel migrate squash     # collapse a range into one migration
```

`kernel migrate generate` reads the resolved field config, computes the diff against the current schema, and writes a reviewable migration file. The MongoDB adapter is the exception: document collections don't carry SQL DDL, so `migrate` there manages index definitions and data backfill scripts rather than column changes. See [Migrations](../03-persistence/08-migrations-engine.md) for the full diffing model.

## Codemods

Schema and API changes across major versions are handled by `kernel codemod`, not by a changelog asking you to grep your codebase. Codemods are AST transforms shipped with each release that mechanically update config and call sites.

```bash
kernel codemod list                     # available transforms
kernel codemod apply v3-field-api       # run one
kernel codemod apply --all --dry        # preview every applicable transform
```

Each codemod prints a diff, runs against a clean git tree (it refuses on a dirty working directory unless `--force`), and reports files changed and skipped. Example: a transform that migrates the deprecated `localized: true` flag to the `localization` block:

```ts
// before
{ name: 'title', type: 'text', localized: true }
// after  (kernel codemod apply localization-block)
{ name: 'title', type: 'text', localization: { default: true } }
```

This is the discipline Payload and Strapi both lack at the tooling level — their major upgrades lean on hand-edited migration guides. KernelCMS treats breaking changes as something the tool fixes, with the human reviewing a diff. Codemods are versioned, named after the change they perform, and discoverable via `kernel codemod list`, so an upgrade is `pnpm up @kernel/* && kernel codemod apply --all`, then review.

## Open questions

- **Codemod distribution.** Should codemods ship inside `@kernel/cli` (one fetch, larger binary) or as on-demand `@kernel/codemod-*` packages resolved at apply time? Leaning toward on-demand for binary size.
- **`--push` vs migrations in dev.** Whether `kernel dev --push` should be the default for SQLite-only projects, since the iteration speed argument is strongest there and the rollback cost is lowest.
- **Plugin generators.** Whether third-party plugins can register their own `kernel generate <name>` subcommands via [`@kernel/plugin-sdk`](../08-extensibility/01-plugin-sdk-and-authoring.md), or whether generators stay first-party to keep the surface predictable.
