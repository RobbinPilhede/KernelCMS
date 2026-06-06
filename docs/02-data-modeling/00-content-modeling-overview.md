# Content Modeling Overview

In KernelCMS, your content model is TypeScript. You declare collections, globals, and fields in `kernel.config.ts`, and that config is the single source of truth from which the database schema, REST and GraphQL APIs, the typed Local/RPC client, validation, access control, and the admin UI are all derived. There is no separate schema editor, no UI-managed content types, and no drift between "what the database has" and "what the code expects." This document explains the mental model and the three building blocks you compose everything else from: collections, globals, and fields — with relationships called out because they are where most models live or die.

## The Mental Model

KernelCMS treats content modeling as code generation in reverse. You write a declarative config; the runtime compiles it into concrete artifacts. Nothing about your model is implicit, and nothing is stored in a database table that you then have to keep in sync by hand.

```
kernel.config.ts  ──► @kernel/core compiler ──┬─► Drizzle schema  (@kernel/db-*)
   collections                                 ├─► REST routes      (@kernel/rest)
   globals                                     ├─► GraphQL schema   (@kernel/graphql)
   fields                                      ├─► RPC functions    (@kernel/rpc)
                                               ├─► Local API types  (@kernel/client)
                                               └─► Admin UI         (@kernel/admin)
```

This is the same config-as-code philosophy as Payload — and the deliberate opposite of Strapi, where content types are authored through an admin GUI and persisted as JSON in the project, and Sanity, where schemas are JS objects that drive a separate Content Lake with its own GROQ query model. KernelCMS keeps Payload's "your code is the schema" instinct but goes further on type inference: every artifact above is fully typed end-to-end, with zero `any`, and the Local API gives you the *same* operation core in-process that the wire APIs expose remotely.

A minimal config establishes the shape:

```ts
// kernel.config.ts
import { defineConfig } from '@kernel/core'
import { postgres } from '@kernel/db-postgres'

export default defineConfig({
  db: postgres({ url: process.env.DATABASE_URL! }),
  collections: [Posts, Authors, Media],
  globals: [SiteSettings, MainNavigation],
})
```

Three rules govern the mental model:

- **The config is canonical.** Migrations are generated from schema diffs (see [Migrations](../03-persistence/08-migrations-engine.md)). You never edit the database to change the model; you edit the config and generate a migration.
- **Operations are uniform.** `find`, `findByID`, `create`, `update`, `delete` behave identically across collections, and across REST, GraphQL, RPC, and Local. One query language — `where` / `sort` / `pagination` / `depth` — spans all surfaces.
- **Everything has an escape hatch.** Custom field types, custom validation, hooks, and raw adapter access exist so the declarative model never traps you.

## Collections vs. Globals

There are exactly two top-level content structures. Choosing between them is the first modeling decision you make for any piece of content.

A **collection** is a repeatable content type — many documents of the same shape, each with its own ID. Blog posts, products, authors, and uploaded media are collections. A **global** is a singleton — exactly one document, no ID needed at the call site. Site settings, the main navigation menu, the homepage hero, and feature flags are globals.

```
Collection "posts"          Global "siteSettings"
┌────┬────────────────┐     ┌──────────────────────┐
│ id │ title          │     │ siteName             │
├────┼────────────────┤     │ defaultLocale        │
│ 1  │ Hello World    │     │ socialLinks[]        │
│ 2  │ Shipping v2    │     └──────────────────────┘
│ …  │ …              │            (one row, ever)
└────┴────────────────┘
```

The distinction matters because it changes the API surface and the access model:

| Aspect | Collection | Global |
| --- | --- | --- |
| Cardinality | Many documents | Exactly one |
| Identity | Has an `id` | Addressed by `slug` only |
| Local API | `kernel.find('posts')`, `kernel.findByID('posts', id)` | `kernel.findGlobal('siteSettings')` |
| REST | `/api/posts`, `/api/posts/:id` | `/api/globals/site-settings` |
| Typical use | Posts, products, users, media | Settings, navigation, footer, hero |

Definitions are symmetric apart from cardinality:

```ts
import { collection, global, fields as f } from '@kernel/core'

export const Posts = collection({
  slug: 'posts',
  fields: [
    f.text('title', { required: true }),
    f.richText('body'),
    f.relationship('author', { to: 'authors' }),
  ],
  drafts: true,
  versions: { autosave: true },
})

export const SiteSettings = global({
  slug: 'siteSettings',
  fields: [
    f.text('siteName', { required: true, localized: true }),
    f.array('socialLinks', {
      fields: [f.text('platform'), f.text('url')],
    }),
  ],
})
```

Globals still get the full KernelCMS treatment: field-level localization, drafts, version history, and access control all apply. This is a sharper split than Strapi, which models singletons as "single types" but treats them as a second-class GUI mode, and cleaner than Sanity, where singletons are a convention you enforce yourself with document-ID pinning and structure-builder customizations. In KernelCMS a global is a first-class primitive with its own operations.

A useful rule of thumb: if you would ever want to list, paginate, or filter the thing, it is a collection. If there is conceptually one of it for the whole project (or one per locale), it is a global.

## Fields

Fields are the atoms of the model. Both collections and globals are just an ordered array of fields, and the same field types are available in both. KernelCMS ships a broad set so you rarely reach for a workaround:

| Category | Field types |
| --- | --- |
| Scalars | `text`, `textarea`, `number`, `boolean`, `date`, `email`, `json`, `code`, `point` |
| Choice | `select`, `radio`, `checkbox` |
| Relational | `relationship`, `upload` |
| Structural | `array`, `blocks`, `group`, `tabs`, `row` |
| Rich content | `richText` |
| Presentational | `ui` (renders in the admin, stores nothing) |
| Custom | user-defined field types via `@kernel/plugin-sdk` |

Every field carries the same cross-cutting capabilities, which is what makes the model expressive without bolting on special cases:

```ts
f.text('summary', {
  required: true,
  localized: true,                 // per-locale values
  unique: true,                    // DB-level uniqueness
  index: true,                     // generates an index in the Drizzle schema
  defaultValue: '',
  validate: async (value, { req }) => {
    if (value && value.length > 160) return 'Keep summaries under 160 chars'
    return true                    // sync, async, and cross-field validation
  },
  access: {                        // field-level access control
    read: () => true,
    update: ({ req }) => req.user?.role === 'editor',
  },
  admin: {
    description: 'Shown in search results and social cards.',
    position: 'sidebar',
  },
})
```

Three field details deserve emphasis:

- **Structural fields nest.** `group`, `array`, `blocks`, `tabs`, and `row` contain other fields recursively. `tabs` and `row` are purely presentational layout in the admin; `group` namespaces data under a key; `array` is an ordered repeatable list; `blocks` is a discriminated union of named block types — the backbone of the rich-text editor and of flexible page builders. See [Field Types](./04-field-types-catalog.md) for the full catalog.
- **Localization is field-level.** You opt into `localized: true` per field, not per document. This mirrors Payload and beats Strapi's all-or-nothing per-locale entry model, because a post can have a localized `title` and a shared, non-localized `slug` or `author`.
- **`access` is evaluated at three levels** — operation, document, and field — so a field can be readable by anyone but writable only by editors, independent of the document's own access rules. This is enforced server-side, always. See [Access Control](../06-auth-security/01-authorization-and-access-control.md).

The `ui` field stores nothing; it injects custom React into the edit form (a button, a computed preview, a callout). It is the sanctioned escape hatch for admin affordances that are not data.

## Relationships

Relationships connect documents, and they are where modeling decisions compound. KernelCMS exposes two relational field types: `relationship` (a typed pointer to one or more documents in another collection) and `upload` (a specialized relationship to a media/upload collection). Both are first-class and both participate in the shared query language.

```ts
// One-to-one / many-to-one
f.relationship('author', { to: 'authors' })

// Has-many
f.relationship('tags', { to: 'tags', hasMany: true })

// Polymorphic: point at one of several collections
f.relationship('related', { to: ['posts', 'products'], hasMany: true })
```

A polymorphic relationship stores both the target collection and the ID, so a single field can reference heterogeneous content — the modeling capability Strapi lacks without a workaround and that Sanity handles via reference type arrays.

The defining feature for read ergonomics is `depth`. KernelCMS stores only IDs (or `{ relationTo, value }` pairs for polymorphic refs) on disk, then resolves relationships on read up to the requested depth. One parameter, every surface:

```
depth: 0          depth: 1                  depth: 2
post.author       post.author = {           post.author.avatar = {
  = "author-7"      id, name,                 fully-resolved upload doc
                    avatar: "media-3"        }
                  }
```

```ts
// Local API — identical semantics over REST, GraphQL, RPC
const post = await kernel.findByID('posts', id, { depth: 2 })
post.author.name          // string, fully typed
post.author.avatar.url    // resolved upload, fully typed
```

This is the same `depth` mechanism Payload pioneered, and KernelCMS keeps it precisely because it solves the over-/under-fetching problem without forcing GraphQL on REST users. GraphQL clients get nested selection sets for free; REST and RPC clients get `depth`; both hit the same resolver. Sanity solves the same problem with GROQ projections and joins, which are powerful but bespoke to Sanity — KernelCMS keeps one query language across all surfaces instead.

Relationship integrity is handled at the adapter layer. On SQL backends (`@kernel/db-postgres`, `@kernel/db-sqlite`, `@kernel/db-mysql`) relationships generate foreign keys and join tables for `hasMany`, with configurable `onDelete` behavior. On `@kernel/db-mongodb`, references are stored inline and resolved by the same operation core, so your model code does not change when you swap adapters. See Relationships for cascade rules, bi-directional refs, and self-references.

### Modeling guidance

- Prefer `relationship` over duplicating data. Denormalize only behind a `ui` preview or a read hook, never in stored fields.
- Use `hasMany` join semantics for tags/categories; use a join *collection* when the relationship itself needs fields (e.g. `postAuthors` with an `order` column).
- Reach for polymorphic refs sparingly — they trade query simplicity for flexibility. A "related content" rail is a good fit; a core foreign key usually is not.

## Open Questions

- **Default `onDelete` for SQL relationships.** `RESTRICT` is the safe default but breaks ergonomic deletes; `SET NULL` is friendlier but silently orphans. Leaning `RESTRICT` with an opt-in per field — unresolved.
- **Cross-collection unique constraints.** Field-level `unique` is per-collection today. Composite/cross-collection uniqueness (e.g. a slug unique across `posts` *and* `pages`) likely needs a model-level constraint primitive rather than a field flag.
- **Globals per-locale identity.** Whether a localized global is one document with per-locale field values (current plan) or N documents keyed by locale, which would change the `findGlobal` signature.
