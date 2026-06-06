# Developer Experience Overview

KernelCMS is judged in the first five minutes. A developer runs `pnpm create kernel@latest`, opens `kernel.config.ts`, defines a `Post` collection, and either feels the system get out of the way — typed end to end, scaffolded sensibly, errors that read like a colleague wrote them — or they bounce back to Payload. This document is the DX north star: what "great" feels like, the four pillars we measure it by, and the non-negotiable defaults every package in the workspace inherits. DX here is not polish applied at the end; it is the spec the `@kernel/*` API surface is designed against.

## What "great" feels like

Great DX is the absence of friction at four specific moments: the first content you create, the type you didn't have to write, the constraint you needed to break, and the error you had to debug. Each of those maps to a pillar below. We hold ourselves to a measurable bar on all four, because the competition is concrete: Payload's config-as-code and TypeScript story is the closest, Sanity owns the live-editing and GROQ ergonomics, and Strapi owns the click-to-model admin. KernelCMS wins by being the only stack where the admin, the API host, the client, and the data layer share one TanStack-native type graph.

```
 create-kernel ──▶ kernel.config.ts ──▶ kernel dev ──▶ typed admin + REST + GraphQL + RPC
      30s              your model           <5s             all generated, all typed
```

## Time-to-first-content

The headline metric is **time-to-first-content (TTFC)**: minutes from an empty directory to a published document visible over the API. Our budget is **under five minutes on a clean machine, zero config edits required to reach a running admin.**

`create-kernel` scaffolds a project with SQLite/libSQL as the default adapter precisely so the first run needs no database container. Compare Strapi, which provisions SQLite too but couples you to its generated admin and REST shape; or Payload, which defaults to MongoDB or Postgres and expects a connection string before `dev` succeeds. KernelCMS boots on a file.

```bash
pnpm create kernel@latest my-cms   # scaffold + install
cd my-cms
pnpm kernel dev                    # admin on :3000, API live, SQLite file created
```

The scaffolded `kernel.config.ts` is intentionally complete but tiny:

```ts
import { defineConfig } from '@kernel/core'
import { sqlite } from '@kernel/db-sqlite'

export default defineConfig({
  db: sqlite({ url: 'file:./kernel.db' }),
  collections: [
    {
      slug: 'posts',
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'body', type: 'richText' },
        { name: 'publishedAt', type: 'date' },
      ],
    },
  ],
})
```

On `kernel dev`, the schema diff is generated and applied automatically in development, the admin renders the `posts` list (TanStack Table) and edit form (TanStack Form), and REST, GraphQL, and RPC surfaces come up together. Creating and publishing a document through the admin or the Local API both count as first content.

| Step | Budget | Why it holds |
| --- | --- | --- |
| Scaffold + install | < 60s | pnpm workspace cache, no native db driver |
| First `kernel dev` boot | < 5s | SQLite, lazy adapter init |
| Define a field → see it in admin | < 2s | HMR on config, no codegen step blocking the UI |
| First published doc over REST | < 5 min total | auto-migrate in dev, generated routes |

The TTFC budget is enforced in CI as a smoke test, not aspirational copy. See Getting Started and [Adapters: Database](../01-architecture/adr/0002-drizzle-and-pluggable-db.md) for the swap from SQLite to Postgres when the project graduates.

## Type-safety everywhere

The pillar that separates KernelCMS from every competitor: **your config is the single source of types, and those types flow unbroken from the database row to the admin form to the client SDK.** Zero `any`. No hand-written interfaces that drift from the schema. No codegen step you have to remember to run before the types are correct.

`defineConfig` infers the document shape from the field definitions. The Local API — the same operation core the REST and GraphQL layers call — returns those inferred types directly:

```ts
import { getKernel } from '@kernel/server'

const kernel = await getKernel()

const post = await kernel.find({
  collection: 'posts',
  where: { publishedAt: { exists: true } },
  depth: 1,
})
// post.docs[0].title    -> string
// post.docs[0].body     -> RichTextValue
// post.docs[0].author   -> User (resolved by depth:1, fully typed)
```

Over the wire, the same operations are exposed as typed RPC through TanStack Start server functions, and `@kernel/client` consumes them with the identical inferred types — no schema duplication, no `graphql-codegen` round trip:

```ts
import { createClient } from '@kernel/client'
import type config from './kernel.config'

const client = createClient<typeof config>({ url: '/api' })

const { docs } = await client.collections.posts.find({
  where: { title: { contains: 'launch' } },
})
docs[0].title // string, inferred from the same config
```

This is where we beat the field. Sanity gives you typed results only after running `sanity typegen` against your GROQ queries — a separate artifact that can fall out of sync. Strapi's typed client is generated from the running server and lags the model. Payload comes closest with generated types, but still leans on a `payload-types.ts` codegen file you regenerate; KernelCMS infers from the live `typeof config`, so the types are correct the instant you save.

```
config (typeof)
   │  inference, no codegen
   ├──▶ Local API     (@kernel/server)  in-process, typed
   ├──▶ RPC           (@kernel/rpc)     server functions, typed
   ├──▶ REST/GraphQL  (@kernel/rest, @kernel/graphql)  generated
   └──▶ Client        (@kernel/client)  typeof config, typed
```

The query language — `where` / `sort` / pagination / `depth` — is one shared, typed grammar across all surfaces, so learning it once in the Local API means you know it in the client and in GraphQL variables. Details in [Type Inference](../01-architecture/07-content-schema-and-type-generation.md) and the [Local API reference](../05-api/03-typed-rpc-and-local-api.md).

## Escape hatches

A tenet: **always provide an escape hatch.** Config-as-code is the happy path, but the moment a framework's abstraction can't be bypassed, it becomes a liability. Every layer of KernelCMS exposes the primitive beneath it.

- **Custom field types** sit beside the built-ins (`text`, `richText`, `relationship`, `blocks`, …). You register a field with its own validation, storage shape, and admin component. You are never limited to the field catalog the way Strapi's content-type builder limits you.
- **Custom endpoints** mount raw TanStack Start server functions alongside the generated REST/GraphQL/RPC, with access to the same `kernel` operation core.
- **Raw adapter access.** When the Drizzle-backed query builder can't express a query, drop to the underlying Drizzle instance (or the MongoDB driver) directly. Payload hides its database behind its own query layer; we expose ours.
- **Hooks** at the operation, document, and field level let you intercept and rewrite behavior without forking.

```ts
import { defineConfig } from '@kernel/core'
import { postgres } from '@kernel/db-postgres'

export default defineConfig({
  db: postgres({ url: process.env.DATABASE_URL! }),
  collections: [
    {
      slug: 'posts',
      fields: [{ name: 'title', type: 'text', required: true }],
      hooks: {
        beforeChange: [({ data }) => ({ ...data, slug: slugify(data.title) })],
      },
    },
  ],
  endpoints: [
    {
      method: 'GET',
      path: '/posts/trending',
      handler: async ({ kernel, db }) => {
        // db is the raw Drizzle instance — full SQL escape hatch
        const rows = await db.execute(/* sql */`select * from posts ...`)
        return Response.json(rows)
      },
    },
  ],
})
```

The rule we enforce in review: no abstraction ships without its escape hatch documented in the same PR. See Custom Fields and [Hooks](../08-extensibility/02-hooks-and-lifecycle.md).

## Error message quality

The fourth pillar is the one most frameworks treat as an afterthought. **An error message is a documentation surface.** Ours follow a fixed contract: what failed, where (config path, file, line), why, and the fix — with a stable error code that links to docs.

Every thrown error extends a typed base (`KernelError`) — never a raw `throw new Error()` — so errors are catchable by code, serializable across the RPC boundary, and renderable in the admin with the same structure they have on the server.

```
✖ KERNEL_E_FIELD_INVALID_RELATION

  Collection "posts" → field "author" references collection "users",
  but no collection with slug "users" is defined.

  kernel.config.ts:14:9

  Fix: add a "users" collection, or change relationTo to an existing
       slug. Defined slugs: posts, media, categories.

  Docs: https://kernelcms.dev/errors/E_FIELD_INVALID_RELATION
```

Contrast the baseline: Strapi and Payload surface schema mistakes as stack traces or terse validation strings that don't point at the config line. We validate the entire config at boot with Zod-backed schemas and report **all** problems at once, sorted by file position, rather than failing on the first one — so a developer fixes a batch, not one error per restart.

| Error class | When | Carries |
| --- | --- | --- |
| `ConfigError` | boot-time config validation | config path, line, suggested fix |
| `ValidationError` | document write fails field rules | per-field messages, field paths |
| `AccessError` | access control denies an operation | operation, collection, doc id |
| `AdapterError` | database/storage layer fails | adapter name, wrapped cause |

Async, cross-field, and access-control failures all flow through the same typed shape, which means the admin can render a `ValidationError` inline on the exact TanStack Form field that produced it without bespoke mapping. More in [Error Reference](../01-architecture/09-error-model-and-result-types.md) and Validation.

## Open questions

- **TTFC and richText.** Should the default scaffold ship the full block-based editor or a minimal richText config to keep first boot under 5s? Leaning minimal-by-default with a one-line upgrade.
- **Inference at scale.** Very large configs (200+ collections) may strain `tsc` inference time. We may need an opt-in precompiled-types mode (`kernel types --emit`) as a performance escape hatch — undecided whether it stays opt-in or auto-engages past a threshold.
- **Error code stability guarantee.** Are `KERNEL_E_*` codes part of semver (breaking to rename) or documentation-only? Tentatively: codes are stable API, messages are not.
