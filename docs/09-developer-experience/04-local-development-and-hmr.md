# Local Development & HMR

The inner loop in KernelCMS is one process. `kernel dev` boots the TanStack Start host that serves both the admin app and the API, watches `kernel.config.ts` for content-model changes, regenerates types into a virtual module, and pushes updates to the browser without losing form state. There is no separate type-generation daemon, no detached admin build, and no "restart after editing collections" ritual. This document specifies that loop: the dev server topology, schema and type watching, HMR boundaries for the admin, and the seed/reset workflow that keeps your local database disposable.

## The dev server

`kernel dev` starts a single TanStack Start server. It is the same host you ship in production — the admin route tree, the REST and GraphQL handlers, and the RPC server functions all live in one process — except the bundler runs in dev mode and a development middleware stack is mounted.

```
┌──────────────────────── kernel dev (one Node/Bun process) ─────────────────────┐
│                                                                                │
│  TanStack Start host (Vite dev middleware)                                     │
│   ├── /admin/*        admin app (SSR + client, HMR via Vite)                   │
│   ├── /api/rest/*     @kernel/rest   ── auto-generated from config             │
│   ├── /api/graphql    @kernel/graphql ── auto-generated from config            │
│   └── /_serverFn/*    @kernel/rpc    ── typed Local API over the wire          │
│                                                                                │
│  config watcher ──▶ schema diff ──▶ type emit ──▶ HMR push                     │
│  db adapter (@kernel/db-*) ──▶ dev migration runner                            │
└────────────────────────────────────────────────────────────────────────────────┘
```

Unlike Strapi, which runs an admin webpack/Vite build alongside a Koa server and proxies between them, KernelCMS has no second build. The admin is a route group inside the same TanStack Start app, so a config change can update server handlers and admin UI in one HMR transaction. Unlike a Payload setup where the Next.js admin and the Payload server share a process but the content config still triggers a full Next dev restart on change, KernelCMS treats the config as a hot module — see below.

The CLI flags that matter day to day:

| Flag        | Default                 | Effect                                                            |
| ----------- | ----------------------- | ----------------------------------------------------------------- |
| `--port`    | `3000`                  | Host port for admin + API.                                        |
| `--db`      | from `kernel.config.ts` | Override the adapter URL, e.g. point at an ephemeral SQLite file. |
| `--no-open` | off                     | Don't open the browser.                                           |
| `--seed`    | off                     | Run the seed script after the dev DB is ready.                    |
| `--debug`   | off                     | Verbose adapter, watcher, and RPC logging.                        |
| `--inspect` | off                     | Enable the Node/Bun inspector for the host process.               |

For zero-friction first runs, point the dev server at SQLite even if production is Postgres. The Adapter contract guarantees the same operation semantics across `@kernel/db-sqlite`, `@kernel/db-postgres`, `@kernel/db-mysql`, and `@kernel/db-mongodb`, so collection code written against SQLite locally behaves identically against Postgres in CI. See Database adapters.

```ts
// kernel.config.ts
import { defineConfig } from '@kernel/core'
import { sqlite } from '@kernel/db-sqlite'
import { Posts } from './collections/posts'
import { SiteSettings } from './globals/site-settings'

export default defineConfig({
  db: sqlite({ url: process.env.DATABASE_URL ?? 'file:./.kernel/dev.db' }),
  collections: [Posts],
  globals: [SiteSettings],
})
```

## Schema and type watching

The config watcher is the heart of the loop. KernelCMS does not generate a `.d.ts` file you have to import. It compiles `kernel.config.ts`, derives the typed shape of every collection, global, and field, and emits a **virtual module** — `@kernel/types` — that the TypeScript server and your editor resolve through the Vite/TS plugin. There is no file on disk to stage, commit, or diff, and there is no stale-types failure mode.

```
edit kernel.config.ts
        │
        ▼
 recompile config (esbuild)         ~15–40 ms
        │
        ▼
 diff against last schema graph      structural, field-level
        │
        ├── types changed?  ─▶ re-emit @kernel/types virtual module ─▶ TS server refresh
        │
        └── persistence changed? ─▶ dev migration runner (see below)
```

What the watcher tracks, and what each change triggers:

| Change in config         | Type re-emit |         Dev migration         | Admin HMR |
| ------------------------ | :----------: | :---------------------------: | :-------: |
| Add/remove a field       |     yes      |              yes              |    yes    |
| Change a field type      |     yes      |              yes              |    yes    |
| Rename a collection      |     yes      | yes (rename, not drop+create) |    yes    |
| Edit a `validate` fn     |      no      |              no               |    yes    |
| Edit an access rule      |      no      |              no               |    yes    |
| Add a localized locale   |     yes      |              yes              |    yes    |
| Change admin UI metadata |      no      |              no               |    yes    |

The emitted `@kernel/types` is what makes the Local API fully inferred. Because the same operation core backs RPC, REST, and GraphQL, the types you get in a server function are the exact response shape clients receive:

```ts
import { getPayload } from '@kernel/server'
import type { Post } from '@kernel/types' // virtual, regenerated on save

const kernel = await getPayload()

// `post` is typed as Post — fields, localization, and relationship depth inferred
const post = await kernel.find('posts', {
  where: { status: { equals: 'published' } },
  sort: '-publishedAt',
  depth: 1,
})
```

This is the line where KernelCMS pulls away from Sanity and Strapi. Sanity's schema lives in code but its query results are typed only if you run `sanity typegen` against extracted GROQ queries — a separate, out-of-band step that drifts. Strapi generates types from its content-type builder but the generation is a CLI command developers forget to run. KernelCMS makes the config the type source and the watcher keeps the virtual module in lockstep with every save, so "the types are wrong" is not a state you can reach without a compile error.

### Persistence changes during watch

When a change touches storage — a new field, a widened column, a new locale table — the watcher invokes the dev migration runner. Drizzle generates the migration from the schema diff; in dev the runner applies it immediately against your local database and logs the SQL. This is **dev-apply**, not **commit**. Migrations are written to `./migrations` so you review and commit them deliberately; see [Migrations](../03-persistence/08-migrations-engine.md). For the MongoDB adapter there is no DDL, so the runner only updates indexes and validators.

A guardrail: destructive diffs (dropping a column, narrowing a type) prompt in the terminal before applying, even in dev, so a rename typo doesn't silently destroy local data.

## HMR for the admin

The admin is config-driven: collection list views render with TanStack Table, document forms with TanStack Form, and reactive UI state lives in TanStack Store. That architecture is what makes hot reload meaningful rather than cosmetic. When the config changes, KernelCMS does not reload the page — it re-derives the field tree and patches the live form.

HMR is split into three boundaries, each with a different cost:

```
┌── boundary 1: config/schema ──┐   re-derive field tree, patch TanStack Form,
│   kernel.config.ts            │   preserve entered values where the field survives
├── boundary 2: admin React ────┤   standard Vite React Fast Refresh — component
│   custom field components, UI │   edits keep parent form + router state
└── boundary 3: server modules ─┘   server fns / hooks re-evaluate, RPC client
    access fns, hooks            │   invalidates affected TanStack Query keys
```

The behavior that wins demos: editing `kernel.config.ts` to add a field to a collection updates the open document editor in place. TanStack Form holds field state in a store keyed by field path, so adding `subtitle` inserts the new input without clearing the `title` you were typing. Removing a field drops its input and its state. Renaming is treated as remove-plus-add unless you supply a `previousName`, in which case the value migrates.

```ts
// collections/posts.ts
import { collection } from '@kernel/core'

export const Posts = collection({
  slug: 'posts',
  admin: { useAsTitle: 'title', defaultColumns: ['title', 'status', 'updatedAt'] },
  fields: [
    { name: 'title', type: 'text', required: true },
    // Add this field, hit save: the open editor gains the input,
    // `title`'s in-progress value is untouched.
    { name: 'subtitle', type: 'text' },
    { name: 'status', type: 'select', options: ['draft', 'published'] },
  ],
})
```

Custom field components and admin UI panels participate in standard React Fast Refresh, so editing a `@kernel/ui` component or a custom `Field` swaps the component while the surrounding TanStack Router route and form state survive. When a server-side module changes — an access rule, a `beforeChange` hook, an RPC server function — the host re-evaluates it and the admin's TanStack Query layer invalidates only the query keys whose data could have changed, rather than blowing the whole cache. Payload and Strapi both full-reload the admin when content config changes; KernelCMS's TanStack-native form/query layer is precisely what lets it patch instead of reload.

If HMR can't safely apply a change — a config edit that throws on compile, or a boundary that can't accept the update — the dev overlay shows the error and the last good UI stays interactive. You fix the typo and the overlay clears; no manual refresh.

## Seed and reset workflow

Local data should be disposable. KernelCMS ships first-class seed and reset commands that run through the Local API, so seeds exercise the same validation, access (optionally), and hooks as real writes — they are not raw `INSERT`s that bypass your model the way hand-rolled SQL seeds do.

A seed file is a function over the typed `kernel` instance:

```ts
// seed.ts
import type { SeedContext } from '@kernel/server'

export async function seed({ kernel, reset }: SeedContext) {
  await reset() // truncate all collections + globals for this DB

  await kernel.updateGlobal('site-settings', {
    data: { title: 'KernelCMS Demo', locale: 'en' },
  })

  await kernel.create('posts', {
    data: { title: 'Hello, kernel', status: 'published' },
  })
}
```

The commands:

| Command                  | What it does                                            |
| ------------------------ | ------------------------------------------------------- |
| `kernel seed`            | Run `seed.ts` against the current dev database.         |
| `kernel seed --fresh`    | Reset, run all migrations, then seed — a clean slate.   |
| `kernel db:reset`        | Truncate all collections and globals; keep the schema.  |
| `kernel db:reset --hard` | Drop and recreate the database, then re-run migrations. |
| `kernel dev --seed`      | Boot the dev server and seed once the DB is ready.      |

Because seeds go through the Local API, they respect the adapter contract and run identically on SQLite, Postgres, MySQL, or MongoDB. A common pattern is deterministic factories with a seeded RNG so every `kernel seed --fresh` produces the same fixtures — useful for screenshot tests and reproducible bug reports. Keep seeds idempotent by starting with `reset()`; never let a seed depend on rows a previous run left behind.

For team-shareable fixtures, commit `seed.ts` and a small set of binary assets under `./seeds/`, and gitignore `./.kernel/dev.db`. Each developer runs `kernel seed --fresh` and lands in byte-identical state. Strapi's seeding story is bootstrap scripts and import/export bundles; Sanity uses dataset export/import. KernelCMS's seed-through-Local-API approach means your seeds are typed, validated, and double as a smoke test of the content model.

## Open questions

- **Virtual `@kernel/types` vs. emitted file.** The virtual module avoids drift but is invisible to tools that read `.d.ts` from disk (some monorepo type-checkers, certain editors). We may add `kernel types:emit` to write a snapshot for those consumers while keeping the virtual module canonical in dev.
- **Destructive-diff prompt in dev.** Whether the rename/drop confirmation should be auto-approved behind a `--yes` flag for throwaway databases, or always require interaction, is unresolved.
- **Multi-locale HMR.** Re-emitting types when a locale is added is settled; whether the open editor should hot-add the new locale's field tabs without a route remount still needs a decision.
- **Cross-process watch on edge runtimes.** The single-process model assumes Node or Bun in dev. Edge-runtime dev (Workers, Deno Deploy) may need a thin local proxy; the watcher/HMR transport there is still being designed.
