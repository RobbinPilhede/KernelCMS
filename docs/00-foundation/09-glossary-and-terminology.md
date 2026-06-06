# Glossary & Terminology

This is the canonical reference for every core noun in KernelCMS. When a term appears in the docs, the CLI, the type definitions, or a `kernel.config.ts` file, it means exactly what is written here — no more, no less. Where Payload, Sanity, or Strapi use a similar word for a different thing, the distinction is called out so you don't carry over stale mental models. Read this once; reach for it whenever a name feels ambiguous.

The terms are grouped by the layer they belong to: the content model (collections, globals, fields), the infrastructure layer (adapters), the runtime behavior layer (hooks and lifecycle), the editorial layer (draft and version), and the multi-instance layer (tenant and project).

## Content model: collections, globals, fields

These three nouns define _what content exists_. They are declared in code in `kernel.config.ts` and are the single source of truth — the database schema, REST routes, GraphQL types, RPC functions, and admin UI are all derived from them. This is config-as-code, the same stance Payload takes and the opposite of Strapi, where the content model lives in a database-backed admin UI and your code reacts to it.

### Collection

A **collection** is a repeatable content type: a table of documents that share one schema. `posts`, `pages`, `authors`, and `media` are collections. Each collection has a stable `slug` (its identifier across every API surface), a `fields` array, and optional configuration for access control, hooks, localization, drafts, and admin presentation.

```ts
import { defineCollection } from '@kernel/core'

export const Posts = defineCollection({
  slug: 'posts',
  labels: { singular: 'Post', plural: 'Posts' },
  admin: { useAsTitle: 'title', defaultColumns: ['title', 'status', 'updatedAt'] },
  versions: { drafts: true, maxPerDocument: 50 },
  access: {
    read: () => true,
    update: ({ req }) => Boolean(req.user),
  },
  fields: [
    { name: 'title', type: 'text', required: true },
    { name: 'slug', type: 'text', unique: true, index: true },
    { name: 'author', type: 'relationship', relationTo: 'authors' },
    { name: 'body', type: 'richText' },
  ],
})
```

A collection maps to one table in the SQL adapters (plus side tables for arrays, blocks, localized fields, and versions) or one collection in the MongoDB adapter. The list view in the admin is a TanStack Table bound to that collection; the edit view is a TanStack Form. Terminology note: Payload and KernelCMS both say "collection"; Sanity calls the equivalent a _document type_; Strapi calls it a _collection type_. They are the same concept.

### Global

A **global** is a singleton — a single document with no list, no IDs to enumerate, exactly one instance per project (or per tenant; see below). Use globals for site settings, primary navigation, footer content, feature flags, and anything where "there is exactly one of these." Globals support the same fields, hooks, access control, localization, drafts, and versions as collections; they simply lack the repeatable dimension.

```ts
import { defineGlobal } from '@kernel/core'

export const Navigation = defineGlobal({
  slug: 'navigation',
  access: { read: () => true },
  fields: [
    {
      name: 'items',
      type: 'array',
      fields: [
        { name: 'label', type: 'text', required: true },
        { name: 'href', type: 'text', required: true },
      ],
    },
  ],
})
```

Payload uses "global" identically. Sanity models singletons as a normal document with a fixed, well-known `_id` and a structure-builder convention — there is no first-class singleton primitive. Strapi calls these _single types_. KernelCMS makes the global a real first-class object so access control and the API shape are explicit rather than conventional.

### Field

A **field** is one typed unit of content inside a collection or global. Fields are the atoms of the content model. Every field has a `type`; most have a `name` (the key it serializes to). The full set of built-in types:

| Category       | Types                                                                             |
| -------------- | --------------------------------------------------------------------------------- |
| Scalars        | `text`, `textarea`, `number`, `boolean`, `date`, `email`, `json`, `code`, `point` |
| Choice         | `select`, `radio`, `checkbox`                                                     |
| References     | `relationship`, `upload`                                                          |
| Composite      | `array`, `blocks`, `group`, `tabs`, `row`                                         |
| Rich content   | `richText`                                                                        |
| Presentational | `ui`                                                                              |

Composite fields nest other fields, so the model is a tree, not a flat row. `array` is an ordered list of a fixed sub-schema; `blocks` is an ordered list where each entry picks from a set of named block schemas (the backbone of page-builder layouts); `group` namespaces fields under one key; `tabs` and `row` are layout-only in the admin and don't change the data shape. `ui` renders a custom admin component (a banner, a computed read-out) and stores nothing. Fields carry their own validation (sync, async, cross-field), access control (`field.access.read` / `update`), localization (`localized: true`), default values, and admin hints. You can register **custom field types** through `@kernel/plugin-sdk` when the built-ins aren't enough.

The field set is deliberately close to Payload's, because that vocabulary is well-proven. Sanity's schema types overlap but its `block`/portable-text model differs from the `blocks`/`richText` split here. Strapi has a smaller, flatter field set and no true nested `blocks` page-builder primitive.

See [03-content-modeling/01-collections.md](../02-data-modeling/01-collections.md) and 03-content-modeling/03-fields.md for the deep dives.

## Adapters

An **adapter** is a swappable implementation of one infrastructure concern behind a fixed contract. Adapters are the mechanism behind the "choose everything" positioning: database, storage, email, auth, search, cache, and queue are all adapters. KernelCMS ships several per concern; you pick one in `kernel.config.ts`, and the core never knows or cares which.

```ts
import { defineConfig } from '@kernel/core'
import { postgresAdapter } from '@kernel/db-postgres'
import { s3Storage } from '@kernel/storage'

export default defineConfig({
  collections: [Posts],
  globals: [Navigation],
  db: postgresAdapter({ connectionString: process.env.DATABASE_URL }),
  storage: s3Storage({ bucket: 'kernel-media', region: 'eu-west-1' }),
})
```

The database adapter is the load-bearing one. Every backend — `@kernel/db-postgres`, `@kernel/db-sqlite`, `@kernel/db-mysql`, `@kernel/db-mongodb` — implements a single **Adapter contract**: CRUD, the shared query language (`where` / `sort` / pagination / `depth`), transactions, and migration generation. The SQL adapters use Drizzle under the hood; Postgres is the default. Migrations are generated from schema diffs, not hand-written.

```
config (collections + globals)
        │  schema derivation
        ▼
   Adapter contract ── where / sort / page / depth / tx / migrate
        │
   ┌────┼────┬─────────┐
   ▼    ▼    ▼         ▼
 postgres sqlite mysql mongodb
```

This is where KernelCMS diverges hardest from the field. Sanity has no database adapter at all — content lives in Sanity's hosted Content Lake, full stop. Strapi nominally supports several SQL databases but leaks SQL-specific behavior and isn't pluggable beyond that fixed list. Payload supports Postgres, SQLite, and MongoDB but the adapter surface isn't a published contract you can implement cleanly for an arbitrary backend. In KernelCMS the contract is the product: implement it, and any datastore becomes a first-class backend. The same swappable model applies to the non-database concerns through `@kernel/storage`, `@kernel/auth`, and the search/cache/queue adapters.

See 05-adapters/01-overview.md and [05-adapters/02-database.md](../01-architecture/adr/0002-drizzle-and-pluggable-db.md).

## Hooks and lifecycle

A **hook** is a function you register that runs at a defined point in an operation. The **lifecycle** is the ordered sequence of those points for a given operation (create, read, update, delete, login). Hooks are your escape hatch and your integration seam: validate, transform, enrich, cascade, emit events, sync to external systems.

Hooks fire at three scopes — operation, collection/global, and field — and at defined phases within the lifecycle:

| Phase                          | Fires                          | Typical use                            |
| ------------------------------ | ------------------------------ | -------------------------------------- |
| `beforeValidate`               | before field validation        | normalize, coerce, set computed inputs |
| `beforeChange`                 | after validation, before write | enforce invariants, derive fields      |
| `afterChange`                  | after a successful write       | webhooks, cache bust, search reindex   |
| `beforeRead`                   | before a doc leaves the server | redact, shape per-user                 |
| `afterRead`                    | after read, before response    | join external data, format             |
| `beforeDelete` / `afterDelete` | around deletes                 | cascade, cleanup storage               |

```ts
import { defineCollection } from '@kernel/core'

export const Posts = defineCollection({
  slug: 'posts',
  hooks: {
    beforeChange: [({ data }) => ({ ...data, slug: data.slug ?? slugify(data.title) })],
    afterChange: [
      async ({ doc, operation, req }) => {
        if (operation === 'create') await req.queue.enqueue('index-post', { id: doc.id })
      },
    ],
  },
  fields: [
    /* ... */
  ],
})
```

Hooks run identically whether the operation came in over REST, GraphQL, RPC, or the in-process Local API — the lifecycle is owned by the operation core in `@kernel/server`, not by any transport. That single-core guarantee is the point: there is no way to "go around" a hook by choosing a different API surface, which is a real failure mode in setups where each surface has its own pipeline.

Payload's hook model is the closest analogue and the vocabulary is intentionally aligned. Sanity has no server-side document lifecycle hooks of this kind — its equivalent is GROQ-driven functions and webhooks, which run _after_ the fact rather than _in_ the write path. Strapi has lifecycle hooks but they sit at the ORM layer and don't span all API surfaces uniformly. See 04-operations/03-hooks.md.

## Draft and version

These two terms describe editorial state over time. They are related but distinct, and conflating them causes bugs.

A **version** is an immutable snapshot of a document at a point in time. Every save can produce a version; autosave produces them continuously while editing. Version history lets editors compare, audit, and restore. Versions are stored in a side table (`_<slug>_versions`) or sub-collection and are governed per collection via `versions: { maxPerDocument, autosave }`.

A **draft** is a _non-published_ version. When drafts are enabled, every document has a publish status. Saving creates or updates the draft; **publishing** promotes the current draft to the live, public document. Public read operations return the published version by default; editors fetch the draft explicitly with `draft: true`.

```
edit ─▶ draft v5 ─┐
edit ─▶ draft v6 ─┤  (autosave snapshots accumulate)
edit ─▶ draft v7 ─┘
                  └─▶ publish ─▶ published = v7  ◀── public reads land here
                  restore v3 ──▶ new draft from v3
```

```ts
versions: {
  drafts: true,
  maxPerDocument: 50,
  autosave: { interval: 800 }, // ms of idle before snapshot
}
```

So: every draft is a version, but not every version is a draft (a published snapshot is also a version). Payload uses exactly this drafts-plus-versions model and the vocabulary matches. Sanity expresses the same idea structurally — a draft is a document whose `_id` is prefixed `drafts.`, and publishing moves it to the canonical `_id`; there is no separate version table, history is event-sourced. Strapi added draft-and-publish later and its versioning is more limited. KernelCMS treats versions as first-class rows with autosave on by default for drafted collections. See [06-editorial/02-drafts-and-versions.md](../02-data-modeling/10-versioning-drafts-and-autosave.md).

## Tenant and project

These are the two units of isolation, and they live at different altitudes.

A **project** is one KernelCMS instance: one `kernel.config.ts`, one set of collections and globals, one database, one admin panel. When you self-host, you run a project. It is the boundary of a content model and its data. Most teams have one project per application (a marketing site, a docs site, a product catalog) and deploy each independently via Docker, Compose, or Kubernetes.

A **tenant** is an isolated slice of data _within a deployment that serves many customers_ — the multi-tenancy unit used primarily by KernelCMS Cloud. Cloud is multi-tenant hosting: many customers' projects run on shared infrastructure, and the tenant is what keeps customer A's documents, media, and users invisible to customer B. Isolation is enforced server-side at the operation core, below the API surface, so it cannot be bypassed by crafting a query.

```
KernelCMS Cloud (multi-tenant deployment)
├── tenant: acme         ├── tenant: globex
│   └── project: site    │   └── project: store
│       └── collections  │       └── collections
└── tenant: initech
    └── projects: [docs, blog]
```

The mental model: **a project is what you model and deploy; a tenant is who owns a project on shared infrastructure.** Self-hosting, you mostly think in projects and may never touch tenancy. On Cloud, tenancy is the billing, quota, and isolation boundary wrapped around your projects. Because content and config are portable, the same project moves between self-host and Cloud unchanged — only the surrounding tenancy and infra differ. Strapi and Payload are project-centric and treat multi-tenancy as an application-level concern you build yourself; Sanity's _project_ + _dataset_ model is the closest hosted analogue, where a dataset roughly maps to our project boundary and the Sanity project/organization maps to our tenant. See [09-cloud/02-multi-tenancy.md](../10-cloud-operations/03-multi-tenancy-and-isolation.md).

## Open questions

- **Field-level versioning granularity.** Versions are document-level snapshots today. Whether to expose per-field diffs as a first-class API (vs. computing them client-side from snapshots) is undecided.
- **Tenant nesting.** Whether a tenant may contain sub-tenants (agency → client → site) on Cloud, or whether that hierarchy should be modeled purely with projects, is still open.
- **Custom adapter certification.** What the conformance test suite must cover before a community-authored adapter can be labeled "compliant with the Adapter contract" is not yet finalized.
