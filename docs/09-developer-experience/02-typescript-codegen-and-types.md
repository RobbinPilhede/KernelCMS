# TypeScript Codegen & Types

KernelCMS treats your `kernel.config.ts` as the single source of truth and derives every type you touch — `Post`, `WhereInput<'posts'>`, the typed RPC client, the GraphQL schema — from that one file. Most of the time this is pure inference: no build step, no `.d.ts` artifacts, no drift. A thin codegen layer exists only where inference cannot reach: the GraphQL SDL, the OpenAPI spec, and a few `.ts` shims for editors that choke on deep conditional types. This document specifies what is generated, where inference ends and codegen begins, how the two stay in sync, and how you consume the result in apps, plugins, and tests.

## Generated types output

There are two categories of output. The first is _inferred-at-source_: types that exist the moment you import from `@kernel/client` or call `kernel.collections.posts`, with nothing written to disk. The second is _materialized_: artifacts the `kernel codegen` command writes for consumers that live outside the TypeScript graph (other services, GraphQL clients, non-TS languages).

The materialized outputs:

| Artifact                  | Command                  | Path (default)           | Consumed by                   |
| ------------------------- | ------------------------ | ------------------------ | ----------------------------- |
| Collection & global types | `kernel codegen types`   | `.kernel/types.ts`       | App code, plugins, tests      |
| GraphQL SDL               | `kernel codegen graphql` | `.kernel/schema.graphql` | GraphQL Codegen, Apollo, urql |
| OpenAPI 3.1 spec          | `kernel codegen rest`    | `.kernel/openapi.json`   | REST clients, Postman, SDKs   |
| Drizzle schema            | `kernel codegen db`      | `.kernel/db/schema.ts`   | Migrations (`@kernel/db`)     |
| Zod validators            | `kernel codegen zod`     | `.kernel/validators.ts`  | Edge functions, form libs     |

The `.kernel/` directory is build output. Commit it or `.gitignore` it — both are valid (see [Keeping types in sync](#keeping-types-in-sync)). The canonical `types.ts` is a flat module of named exports, one per collection and global, plus the supporting query types:

```ts
// .kernel/types.ts  (generated — do not edit)
export interface Post {
  id: string
  title: string
  slug: string
  status: 'draft' | 'published'
  author: string | User // relationship, resolved by `depth`
  hero?: string | Media
  body: RichTextNode[]
  publishedAt?: string
  createdAt: string
  updatedAt: string
}

export interface User {
  /* … */
}
export interface SiteSettings {
  /* a global */
}

export interface CollectionMap {
  posts: Post
  users: User
  media: Media
}
export interface GlobalMap {
  'site-settings': SiteSettings
}
```

Relationships are typed as a union of the foreign key (`string`) and the resolved document (`User`), because `depth` decides at runtime which one you get. Localized fields, when localization is enabled, widen to a `Localized<T>` record keyed by locale. Draft-only fields become optional. None of this is hand-maintained; it is a projection of the field definitions in your config.

## Inference versus codegen

This is the line that separates KernelCMS from the rest of the field. **Payload** and **Strapi** are codegen-first: you change a collection, run `payload generate:types` or `strapi ts:generate-types`, and a `.d.ts` file is rewritten. If you forget, your editor lies to you. **Sanity** infers nothing from its schema by default — you reach for `sanity typegen` plus typed GROQ to get anything close. KernelCMS inverts the priority: **inference is the default, codegen is the fallback.**

The mechanism is that the operation core is generic over your config. When you do this:

```ts
// kernel.config.ts
import { defineConfig, collection, text, richText, relationship } from '@kernel/core'

export default defineConfig({
  collections: [
    collection('posts', {
      fields: {
        title: text({ required: true }),
        body: richText(),
        author: relationship({ to: 'users' }),
      },
    }),
  ],
})
```

…the `defineConfig` return type carries the full shape. The Local API and the RPC client read it straight off `typeof config`:

```ts
import { getKernel } from '@kernel/server'
import config from './kernel.config'

const kernel = getKernel(config)

// `post` is inferred as Post — no import from .kernel/types.ts, no build step
const post = await kernel.collections.posts.findById('abc', { depth: 1 })
//    ^? { id: string; title: string; author: User; … }
```

Inference covers everything that _runs inside the TypeScript program_: the Local API, the typed RPC client over TanStack Start server functions, [TanStack Query](../05-admin/...) hooks, [TanStack Form](../05-admin/...) field binding, and `where`/`sort`/`select` query inputs. Here is the boundary, drawn as a diagram:

```
        kernel.config.ts  (source of truth)
                 │
        ┌────────┴─────────┐
        │  typeof config   │  ← compiler reads this directly
        └────────┬─────────┘
   inference     │            codegen
 (zero output)   │       (writes .kernel/*)
        ┌────────┴────────┐   ┌──────────────────┐
        │ Local API       │   │ GraphQL SDL      │ → other runtimes
        │ RPC client      │   │ OpenAPI JSON     │ → REST consumers
        │ Query/Form types│   │ Drizzle schema   │ → migrations
        │ where/sort/depth│   │ Zod validators   │ → edge/validation
        └─────────────────┘   └──────────────────┘
```

Codegen is required when the consumer cannot see `typeof config`:

- **GraphQL** is a string schema by contract. A GraphQL client in another repo needs SDL, not TypeScript.
- **REST** consumers need OpenAPI to generate their own clients.
- **Migrations** need a serialized Drizzle schema to diff against the database.
- **Editor performance** degrades on very large configs (200+ collections) because deep conditional types are expensive to evaluate on every keystroke. For those, `kernel codegen types` materializes a flat `types.ts`, and you import the concrete `Post` instead of paying the inference cost repeatedly.

The rule: **if it runs in your TS program, infer; if it crosses a process or language boundary, generate.** You never run codegen to make your own app compile.

## Keeping types in sync

Drift is the failure mode codegen-first CMSs ship with. Our defense is layered.

**Inference can't drift** — it is recomputed from `typeof config` on every compile. The risk is confined to the materialized artifacts, and we treat a stale artifact as a build failure, not a warning.

**Dev watcher.** `kernel dev` watches `kernel.config.ts` and every imported field module. On change it regenerates the materialized set incrementally (only the affected collections) and writes to `.kernel/`. Typical regen is sub-100ms because we diff the config AST and skip unchanged collections.

**CI drift check.** The same generator runs in check mode and fails if output differs from what's committed:

```bash
kernel codegen --check    # exits 1 if .kernel/* is stale
```

Wire this into CI before the type check. It is the equivalent of `prettier --check` for your types.

**The commit-vs-ignore decision.** Two supported strategies:

| Strategy      | `.kernel/` is | Pro                                                           | Con                                              |
| ------------- | ------------- | ------------------------------------------------------------- | ------------------------------------------------ |
| **Committed** | tracked       | PRs show schema diffs; consumers in other repos pin a version | larger diffs; must run `--check` in CI           |
| **Generated** | gitignored    | clean history                                                 | every `pnpm install`/build must regenerate first |

We recommend **committed** for the GraphQL SDL and OpenAPI spec (downstream consumers need a stable, reviewable contract) and **gitignored** for `types.ts` and the Drizzle schema (internal, regenerated on `postinstall`). A `postinstall` hook keeps the gitignored set fresh:

```jsonc
// package.json
{
  "scripts": {
    "postinstall": "kernel codegen types db",
    "check:types": "kernel codegen --check && tsc --noEmit",
  },
}
```

**Migrations are the one hard sync point.** Changing a field type changes both the generated TS _and_ the database schema. KernelCMS generates the Drizzle schema and then a migration from the schema diff — the type and the migration come from the same source, so they can't disagree. See [Migrations](../04-persistence/...) for the diff-and-apply flow. This is a categorical improvement over Strapi, where the content-type schema, the generated types, and the database are three separate sources that can fall out of step.

## Consuming generated types

**In your frontend / external app**, use `@kernel/client`. It is typed by importing your config's _type_ (not its runtime value, so no server code is bundled):

```ts
import { createClient } from '@kernel/client'
import type config from '../cms/kernel.config'

const cms = createClient<typeof config>({ url: process.env.CMS_URL! })

const { docs } = await cms.collections.posts.find({
  where: { status: { equals: 'published' } }, // ← `status` autocompletes; bad values error
  sort: '-publishedAt',
  depth: 1,
  limit: 10,
})
//    ^? Post[] with `author: User`
```

For a separate repo with no source access, point the same client at the generated `types.ts` instead of `typeof config`:

```ts
import { createClient } from '@kernel/client'
import type { CollectionMap } from '@acme/cms-types' // published from .kernel/types.ts

const cms = createClient<{ collections: CollectionMap }>({ url })
```

**In plugins**, never hand-write document types. `@kernel/plugin-sdk` exposes helpers that resolve against the host config at the call site, so a plugin authored against the generic `CollectionSlug` specializes to the user's real slugs when installed:

```ts
import type { DocumentOf, CollectionSlug } from '@kernel/plugin-sdk'

export function afterChange<S extends CollectionSlug>(slug: S, doc: DocumentOf<S>) {
  // doc is fully typed for whatever collection the host registered
}
```

**In the admin**, you rarely import types at all — TanStack Query hooks and TanStack Form fields infer from the same config the server uses, so a field renamed in `kernel.config.ts` immediately red-squiggles the form that referenced it.

**For GraphQL consumers**, run `kernel codegen graphql`, then feed `.kernel/schema.graphql` into GraphQL Code Generator exactly as you would any SDL — KernelCMS deliberately emits standard SDL so the entire GraphQL tooling ecosystem works unchanged, unlike Sanity's GROQ, which needs Sanity-specific typegen.

A useful path alias keeps imports stable whether the artifact is committed or generated:

```jsonc
// tsconfig.json
{ "compilerOptions": { "paths": { "@cms/types": ["./.kernel/types.ts"] } } }
```

## Open questions

- **Branded ID types.** Should `id` be `string` or a branded `Id<'posts'>` to prevent passing a post id where a user id is expected? Branding adds safety but leaks into every consumer's type signatures and complicates the RPC boundary.
- **Default `.kernel/` commit policy.** The recommendation above is split per-artifact; `create-kernel` must still pick one default for the scaffold. Leaning toward gitignored-everything plus a mandatory CI `--check`, but that punishes consumers who clone without running codegen.
- **Inference budget.** At what collection count do we auto-switch the admin from live inference to materialized `types.ts`? We need a measured threshold, not a guess, before wiring it into `kernel dev`.
