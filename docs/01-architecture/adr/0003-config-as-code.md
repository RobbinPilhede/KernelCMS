# ADR 0003: Config-as-Code over a UI Schema Builder

KernelCMS models content in TypeScript — collections, globals, and fields are declared in `kernel.config.ts`, type-checked at build time, and versioned in Git. We deliberately reject the database-backed visual schema builder that Strapi popularized. This ADR records why the schema is code, what that buys us across the REST, GraphQL, and Local/RPC surfaces, what it costs, and how we compare to Strapi's content-type builder, Payload, and Sanity.

## Status

Accepted. Supersedes nothing. Constrains every adapter and API package downstream; see [ADR 0001: Adapter Contract](../../03-persistence/00-persistence-overview-and-adapter-contract.md) and [ADR 0002: Local API as the Operation Core](../../05-api/03-typed-rpc-and-local-api.md).

## Context

A headless CMS has to answer one question before anything else: **where does the schema live?** Two answers dominate the market.

1. **Database-backed UI builder (Strapi, Directus).** An admin clicks through a UI to add a "content type," drags fields in, and the server writes that definition into the database (and, for Strapi, also emits schema JSON to disk). The running app reads the schema from a store at boot.
2. **Config-as-code (Payload, KernelCMS; Sanity for schema, with its own studio runtime).** The schema is source code. There is no "create a field" button that mutates production. You edit a file, the type system reacts immediately, and the change ships through the same pipeline as any other code.

KernelCMS is TanStack-native and end-to-end typed. Both of those tenets collapse the decision. TanStack Form needs to know a document's field shape to bind inputs and run validation. TanStack Table needs typed columns for the collection list. TanStack Query needs typed payloads for cache keys and invalidation. The Local API promises *full type inference in-process* — you call `payload.find({ collection: 'posts' })` and get back `Post[]`, not `any[]`. None of that is achievable if the schema is a runtime row in a database that the compiler has never seen.

A UI builder makes the schema a **runtime value**. Config-as-code makes it a **compile-time fact**. Everything we want to ship — typed clients, generated GraphQL SDL, migration diffs, code review of model changes — depends on the schema being a fact the compiler can read.

```
UI Builder (Strapi/Directus)          Config-as-Code (KernelCMS)
──────────────────────────            ──────────────────────────
   admin clicks field                    edit kernel.config.ts
          │                                      │
          ▼                                      ▼
   write to DB / schema.json            tsc type-checks the model
          │                                      │
          ▼                                      ▼
   reload server, infer types          types flow to admin + client + APIs
          │                                      │
   types lag the data ───────X         migration generated from diff
```

## Decision

**The content model is TypeScript code in `kernel.config.ts`, resolved once at build/boot, and is the single source of truth.** There is no admin-panel affordance that creates or alters a field. Schema changes are code changes: edited in an editor, reviewed in a pull request, type-checked by `tsc`, and applied via generated migrations.

A representative config:

```ts
// kernel.config.ts
import { defineConfig } from '@kernel/core'
import { postgres } from '@kernel/db-postgres'

export default defineConfig({
  db: postgres({ url: process.env.DATABASE_URL }),
  collections: [
    {
      slug: 'posts',
      fields: [
        { name: 'title', type: 'text', required: true, localized: true },
        { name: 'slug', type: 'text', required: true, unique: true },
        { name: 'body', type: 'richText' },
        {
          name: 'author',
          type: 'relationship',
          relationTo: 'users',
          required: true,
        },
        { name: 'status', type: 'select', options: ['draft', 'published'] },
      ],
      access: {
        read: ({ doc }) => doc.status === 'published',
        update: ({ req }) => req.user?.role === 'editor',
      },
      versions: { drafts: true, autosave: true },
    },
  ],
  globals: [
    {
      slug: 'site-settings',
      fields: [
        { name: 'siteName', type: 'text', required: true },
        { name: 'nav', type: 'array', fields: [
          { name: 'label', type: 'text' },
          { name: 'href', type: 'text' },
        ]},
      ],
    },
  ],
})
```

The same config object is consumed by every package:

| Consumer | What it derives from config |
| --- | --- |
| `@kernel/db` + adapter | Table/collection schema, indexes, migration diffs |
| `@kernel/rest` | Auto-generated REST routes and OpenAPI document |
| `@kernel/graphql` | Generated SDL, resolvers, input types |
| `@kernel/rpc` | Typed TanStack Start server functions |
| `@kernel/client` | A typed SDK — `Post`, `Global<'site-settings'>` |
| `@kernel/admin` | TanStack Form field map, TanStack Table columns |

Types are inferred from the literal config, not hand-written alongside it. `defineConfig` is generic over its input, so `@kernel/client` exposes `client.collections.posts.find()` returning a `Post` whose shape is the field array — no codegen step, no `as` casts, no drift between the model and its types.

```ts
import { createClient } from '@kernel/client'
import type config from './kernel.config'

const client = createClient<typeof config>({ url: '/api' })

const { docs } = await client.collections.posts.find({
  where: { status: { equals: 'published' } },
  sort: '-createdAt',
  depth: 1,
})
// docs: Post[] — title, slug, body, author (populated), status
```

Schema resolution happens **once**, at process start (or build, on edge runtimes). After that the model is immutable for the lifetime of the process. There is no API to register a field at runtime — plugins extend the model through the config pipeline before resolution, via the `@kernel/plugin-sdk`, not by mutating a live store.

## Consequences

**Type safety is free and total.** Because the model is a compile-time fact, the type that flows to TanStack Form, the `@kernel/client` SDK, and the GraphQL layer is the *same* type, derived from the *same* literal. Rename a field and `tsc` lights up every call site. This is the central payoff and the reason the decision is non-negotiable given our "zero `any`" tenet.

**Schema changes get code review.** A model change is a diff. Reviewers see that `posts.author` became `required`, that a `unique` constraint was added, that an access rule changed. With a UI builder, an admin can reshape production content types with no review, no PR, and no audit trail beyond a database row. Config-as-code makes the model a first-class engineering artifact governed by the same controls as any other code.

**Environments are reproducible.** Dev, staging, and production run the *same* `kernel.config.ts` from the *same* commit. There is no "but the schema in staging has an extra field someone added in the UI" class of bug. This is also what makes content and config portable between self-host and KernelCMS Cloud — the model travels in Git, not in a vendor's database. Promotion between environments is `git` plus `kernel migrate`, not a manual schema sync.

**Migrations are deterministic diffs.** Because the desired schema is known statically, `@kernel/db` diffs it against the database's current state and emits a migration. See Migrations.

```bash
$ kernel generate:migration add_post_slug
  ~ posts.slug  text  +unique +not_null
  → migrations/20260530_add_post_slug.ts
```

**The cost: non-developers can no longer change the model.** A marketer cannot add a field by clicking. This is a real loss for the "ops person spins up a content type in five minutes" workflow, and we own it. Our answer is twofold: editing content (the day-to-day job) remains fully no-code in the admin panel; editing the *model* (an architectural act) is a developer task by design. For teams that genuinely need runtime model edits, that is a non-goal we are choosing against — the same way Payload does.

**A build/deploy step is required to change the model.** You cannot reshape content types on a running box without shipping code. For the model-iteration loop, `kernel dev` watches `kernel.config.ts` and hot-reloads the schema, the admin UI, and the typed client in the same pass, so the inner loop stays fast even though production changes go through deploy.

## Tradeoff Versus the Strapi Content-Type Builder

Strapi's content-type builder is its signature feature and its signature constraint. An admin opens the builder, defines types in the browser, and Strapi writes both database structure and `schema.json` files to disk, then triggers a server restart to pick them up. It is genuinely fast for getting started and genuinely friendly to non-developers.

It also creates the exact problems config-as-code exists to avoid:

| Dimension | Strapi content-type builder | KernelCMS config-as-code |
| --- | --- | --- |
| Source of truth | DB + emitted `schema.json`, edited via UI | `kernel.config.ts`, edited in an editor |
| Type inference | Codegen (`strapi ts:generate-types`), can drift | Inferred from the literal config, cannot drift |
| Change in production | Builder is disabled in prod; edits happen in dev then redeploy | Always a code change through CI |
| Review / audit | None unless you diff committed `schema.json` | Native PR diff and review |
| Env reproducibility | Manual sync of schema files across envs | Same commit = same model everywhere |
| Non-dev model edits | Yes, in dev | No, by design |

The decisive point is the one Strapi itself enforces: **the content-type builder is disabled in production.** Strapi's own guidance is to model in development and deploy, because letting the UI rewrite a production schema is dangerous. Once you accept that the model must change through deploy anyway, the visual builder is just a less-typed, less-reviewable way to author the same file. KernelCMS removes the builder and keeps the file.

Compared to **Payload**, we are closely aligned — Payload is also config-first TypeScript with no production schema UI. The difference is downstream: KernelCMS wires the resolved config straight into TanStack Form, Table, and Query, so the same inferred type is what binds the edit form, the list columns, and the cache. Compared to **Sanity**, schemas are also code (`defineType`/`defineField`), but Sanity pairs them with a hosted document store and the GROQ query language; KernelCMS keeps one `where`/`sort`/pagination/`depth` query language across REST, GraphQL, and the Local API, and lets you choose your own database adapter rather than committing to a vendor datastore.

What we give up is real and we name it plainly: the five-minute, no-developer-needed "add a content type in the browser" demo. We are betting that for the teams KernelCMS targets — ones that already run CI, code review, and multiple environments — a typed, reviewable, reproducible model is worth more than a builder UI that has to be turned off before it reaches production anyway.

## Open Questions

- **Sandboxed model preview in the admin.** Should the admin panel offer a *read-only, generated* view of the resolved model (fields, access summary, relationships) without making it editable? Likely yes — a "schema inspector" that reads the resolved config, sourced from Admin Internals.
- **Plugin field registration timing.** The `@kernel/plugin-sdk` extends the model pre-resolution. We have not finalized whether plugins may add fields conditionally based on *other* plugins' contributions, which would require a second resolution pass. Tracked against Plugin SDK.
- **Cloud-side guided modeling.** KernelCMS Cloud could offer a guided model editor that emits a `kernel.config.ts` diff as a PR against the user's repo — config-as-code preserved, but with a friendlier authoring surface. Undecided whether this lives in core or stays a Cloud-only convenience.
