# Design Principles & Tenets

KernelCMS is built around five non-negotiable tenets: end-to-end type safety, config-as-code as the single source of truth, escape hatches at every layer, progressive disclosure of complexity, and enforced performance budgets. These are not aspirations on a marketing page — they are constraints that shape every API signature, every adapter contract, and every admin component. When two design options conflict, these tenets break the tie. This document explains what each one means in practice, what it costs, and how it makes KernelCMS different from Payload, Sanity, and Strapi.

## Type-Safety End to End

A field defined in `kernel.config.ts` must produce a fully inferred TypeScript type that flows, unchanged, through the Local API, REST, GraphQL, RPC, and the admin forms. No codegen step is required for the in-process path; types are derived directly from the config object.

```ts
// kernel.config.ts
import { defineConfig, collection, fields } from '@kernel/core'

const posts = collection({
  slug: 'posts',
  fields: {
    title: fields.text({ required: true }),
    status: fields.select({ options: ['draft', 'published'] as const }),
    author: fields.relationship({ to: 'users' }),
    body: fields.richText(),
  },
})

export default defineConfig({ collections: { posts } })
```

```ts
// Anywhere in your server code — zero codegen, zero `any`.
import { kernel } from '@kernel/server'

const post = await kernel.find('posts', { where: { status: { equals: 'published' } } })
//    ^? { id: string; title: string; status: 'draft' | 'published';
//         author: string | User; body: RichTextNode[] }
```

The `status` field narrows to the literal union `'draft' | 'published'` because the options were declared `as const`. The `where` clause is itself typed against the collection schema, so `status: { equals: 'archived' }` is a compile error. This is the bar: if a query can be written that the schema forbids, the type system has failed.

How this differs from the competition:

| Surface | Payload | Sanity | Strapi | KernelCMS |
|---|---|---|---|---|
| Local API types | Generated `payload-types.ts` | None (GROQ is untyped) | Loose, mostly `any` | Inferred from config, no codegen |
| Query `where` typing | Partial | Untyped GROQ strings | Untyped | Fully typed against schema |
| REST/GraphQL response | Generated SDK optional | Typegen plugin | Manual | Shared inferred types |

Payload gets close but relies on a generated `payload-types.ts` file that drifts the moment you edit config without re-running typegen. Sanity's GROQ is a string language with no compile-time guarantees unless you bolt on `groq-codegen`. KernelCMS treats the config object as the type source, so the editor knows your schema the instant you save the file. For the wire protocols, `@kernel/client` exposes the same inferred types via TanStack Query so the frontend never hand-writes a response interface. See the type system overview and the query language spec.

The cost: config must be statically analyzable. You cannot build a collection's field list from a runtime database call and still get inference. That constraint is deliberate and connects directly to the next tenet.

## Config-as-Code

`kernel.config.ts` is the single source of truth. Content models, access control, hooks, localization, and adapter wiring all live in code, in version control, reviewable in a pull request. There is no admin UI that mutates the schema behind your back.

```ts
export default defineConfig({
  db: postgresAdapter({ url: process.env.DATABASE_URL! }),
  storage: s3Adapter({ bucket: 'media' }),
  collections: { posts, users, media },
  globals: { siteSettings },
  localization: { locales: ['en', 'da', 'ar'], defaultLocale: 'en' },
})
```

This is the sharpest line between KernelCMS and Strapi. Strapi's content-type builder writes schema changes from a UI into JSON files, which means the canonical model is split between a database, a UI, and files that the UI rewrites — making schema review and environment promotion error-prone. Sanity models in code (`schemaTypes`) which is closer to our stance, but its hosted dataset still holds the live truth. KernelCMS guarantees that what is in Git is what runs.

```
kernel.config.ts ──diff──▶ migration ──apply──▶ database
      ▲                                              │
      └──────────── never the reverse ──────────────┘
```

Migrations flow one direction: schema diffs are generated from config changes and applied to the database via the active [adapter](../03-persistence/00-persistence-overview-and-adapter-contract.md). The database is never the authority. This is what makes content and config portable between self-host and KernelCMS Cloud — the same config file produces the same model in either environment, with no lock-in.

The discipline this buys: every model change is a reviewable diff, branch-deployable, and reproducible. The discipline it demands: editors cannot "just add a field" in production. That is a feature. Schema is engineering, and engineering belongs in code review.

## Escape Hatches Everywhere

Opinionated defaults are worthless if they trap you. Every abstraction in KernelCMS exposes the layer beneath it. You should never have to fork the CMS to do something it did not anticipate.

The escape-hatch ladder, from highest to lowest level:

| Layer | Default | Escape hatch |
|---|---|---|
| Collection ops | `kernel.find()` / `kernel.update()` | `hooks` to intercept any operation |
| Query language | `where` / `sort` / `depth` | Raw Drizzle query via `db.drizzle` |
| Database | Drizzle adapter | Implement the `Adapter` contract yourself |
| Admin field UI | Generated input component | Custom field component slot |
| API routing | Auto-generated REST/GraphQL | Custom TanStack Start server functions |
| Rich text | `@kernel/richtext` blocks | Register custom block + serializer |

```ts
const posts = collection({
  slug: 'posts',
  fields: { /* ... */ },
  hooks: {
    beforeChange: [async ({ data, req }) => {
      data.slug ??= slugify(data.title)
      return data
    }],
  },
  admin: {
    components: {
      // Swap the generated editor for your own — still typed against the field.
      fields: { body: () => import('./MyEditor') },
    },
  },
})
```

When the query language can't express what you need, drop to Drizzle directly — `kernel.db.drizzle` hands you the underlying query builder with the same connection pool. When a storage backend doesn't exist, implement `@kernel/storage`'s `StorageAdapter` interface; it's the same contract our first-party S3 and local-disk adapters use. This is where KernelCMS beats Sanity Studio, whose customization stops at the React layer and cannot reach the dataset's query execution, and Payload, whose lower layers are reachable but undocumented. Every escape hatch here is a published, supported contract — see extensibility.

## Progressive Disclosure

A new user should write five lines and get a working CMS. A power user should be able to reach every knob. These are the same product, and complexity is revealed only when asked for.

The minimal config is genuinely minimal — sensible defaults for `db` (Postgres), `auth`, `storage` (local disk), and admin. As requirements grow, you opt into surface area:

```
Level 0  collection({ slug, fields })                    // it just works
Level 1  + access, hooks, validation                     // business rules
Level 2  + admin.components, custom field types          // UI control
Level 3  + custom Adapter, server functions, plugins     // own the stack
```

```ts
// Level 0 — a complete, queryable collection.
collection({ slug: 'tags', fields: { name: fields.text() } })
```

The TanStack-native admin embodies this too. The default list view is a `@kernel/admin` TanStack Table with sorting, filtering, and virtualization configured for you; you only touch column definitions when the defaults don't fit. Forms are TanStack Form bound automatically to fields; per-field validation is opt-in. Strapi and Payload both front-load configuration — you confront access control and lifecycle hooks early. KernelCMS keeps those concepts present but dormant until the field, collection, or operation actually needs them. The principle: defaults that are correct, not defaults that are absent. See the admin architecture.

## Enforced Performance Budgets

Performance is a measured contract, not a hope. Budgets are defined in config, checked in CI, and fail the build when exceeded.

```ts
export default defineConfig({
  performance: {
    budgets: {
      adminBundleKb: 220,        // initial admin JS, gzipped
      apiP95Ms: 80,             // Local API p95 per operation
      queryDepthMax: 4,         // default relationship resolution depth
      listResponseMs: 150,      // collection list endpoint p95
    },
  },
})
```

| Budget | Target | Enforced by |
|---|---|---|
| Admin initial bundle | <= 220 KB gzip | `kernel build --check-budgets` in CI |
| Local API operation p95 | <= 80 ms | Benchmark suite in CI |
| List view render | virtualized, O(visible rows) | TanStack Virtual + Table |
| Relationship depth | bounded by `depth` param | Query planner |

The admin's use of TanStack Virtual means a 50,000-row collection renders only the visible window; memory and paint cost stay flat as data grows. Relationship resolution is bounded by an explicit `depth` parameter so a single query can never trigger unbounded join fan-out — a class of accidental N+1 that Strapi's `populate` and Sanity's deep GROQ projections make easy to hit. The CLI's `kernel build --check-budgets` compares the produced admin bundle and benchmark results against the declared budgets and exits non-zero on regression, so a slow change fails review rather than shipping. See [performance](../10-cloud-operations/07-scaling-and-performance-operations.md).

The cost is real: contributors cannot merge a feature that bloats the bundle or slows the hot path without either staying under budget or explicitly raising it in a reviewed config change. Raising a budget is allowed — silently blowing past it is not.

## Open Questions

- **Budget granularity per plugin.** Should third-party plugins declare their own bundle budgets that compose into the global `adminBundleKb`, or should the host app own the total? Per-plugin budgets aid debugging but complicate the merge.
- **Runtime schema for multi-tenant Cloud.** Config-as-code assumes a build step. KernelCMS Cloud tenants who want UI-driven field additions break that assumption. We are evaluating a constrained "tenant overlay" that layers additive fields on a code-defined base without making the database authoritative.
- **Inference ceiling.** Extremely large configs (hundreds of collections) can slow `tsserver`. We may need a typegen fallback for the wire types while keeping the Local API fully inferred. The trigger threshold is undecided.
