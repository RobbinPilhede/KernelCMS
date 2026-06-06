# Content Schema & Type Generation

In KernelCMS, `kernel.config.ts` is the only thing you author. Everything downstream — the runtime validation schema, the database tables and migrations, the REST/GraphQL surface, and the TypeScript types you import in your editor — is *derived* from that config, never hand-maintained alongside it. This document specifies the compilation pipeline: how a collection definition becomes an internal schema (the IR), how that IR is projected onto Postgres/SQLite/MySQL/MongoDB tables via the Adapter contract, how it generates `.d.ts` output, and why we treat the config as one indivisible source of truth rather than three loosely-coupled ones.

## The compilation pipeline

The flow is a single forward function. There is no point where you edit the output of an earlier stage and feed it back in — that is the failure mode KernelCMS is designed to avoid.

```
kernel.config.ts
      │  define collections, globals, fields
      ▼
@kernel/core  ──►  Internal Schema (IR)
      │              normalized, validated, deterministic
      ├──────────────┬──────────────┬──────────────┐
      ▼              ▼              ▼              ▼
  @kernel/db     @kernel/rest   @kernel/graphql  @kernel/client
  tables +       OpenAPI +      SDL +            generated
  migrations     handlers       resolvers        TypeScript types
```

Compare the prevailing approaches. Payload compiles config to a Mongoose/Drizzle schema and generates types, which is close to our model, but its type generation runs as a separate `payload generate:types` step that drifts the moment someone forgets it. Sanity stores its schema in the Studio and resolves types through a separate `sanity typegen` pass against GROQ queries. Strapi persists content types as JSON files the admin UI edits at runtime, then reconciles the database on boot — which means the "source of truth" is mutable application state, not code under review. KernelCMS keeps the config canonical and makes every other artifact a pure function of it.

## Config to internal schema

The first stage takes the ergonomic, author-facing config and lowers it into a normalized **internal schema** (the IR) that the rest of the system consumes. The IR is deterministic: the same config always produces the same IR, byte for byte, which is what makes migration diffing and type-hash caching reliable.

A realistic config:

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
        { name: 'slug', type: 'text', required: true, unique: true, index: true },
        { name: 'status', type: 'select', options: ['draft', 'published'], defaultValue: 'draft' },
        { name: 'author', type: 'relationship', relationTo: 'users', hasMany: false },
        { name: 'tags', type: 'relationship', relationTo: 'tags', hasMany: true },
        { name: 'hero', type: 'upload', relationTo: 'media' },
        { name: 'body', type: 'richText' },
        {
          name: 'seo',
          type: 'group',
          fields: [
            { name: 'metaTitle', type: 'text' },
            { name: 'metaDescription', type: 'textarea' },
          ],
        },
      ],
      versions: { drafts: true, autosave: true },
    },
  ],
})
```

The `defineConfig` call does no I/O. It validates structure (every `relationship.relationTo` must resolve to a known collection, every `name` must be a valid identifier, no duplicate slugs) and produces a typed config object. The compiler in `@kernel/core` then walks that object and normalizes it:

- **Field flattening.** Nested `group`, `row`, `tabs`, and `collapsible` containers are presentational in the config but are flattened into dotted paths in the IR (`seo.metaTitle`). `row` and `ui` fields carry no data and are dropped from the persistence projection entirely.
- **Implicit fields.** Every collection gains `id`, `createdAt`, `updatedAt`. Enabling `versions` adds `_status` and provisions the version-history shadow table. Enabling localization provisions the `_locales` projection.
- **Constraint extraction.** `required`, `unique`, `index`, `defaultValue`, and `min`/`max` are pulled out as schema-level constraints rather than left as field metadata, so they can drive both DB DDL and runtime validation from one place.

The resulting IR node is roughly:

```ts
interface SchemaField {
  path: string                 // 'seo.metaTitle'
  type: FieldType
  storage: 'column' | 'relation' | 'jsonb' | 'virtual'
  required: boolean
  unique: boolean
  indexed: boolean
  localized: boolean
  relationTo?: string | string[]
  hasMany?: boolean
}

interface CollectionSchema {
  slug: string
  fields: SchemaField[]
  versions: VersionConfig
  hash: string                 // stable digest of the normalized shape
}
```

That `hash` is the linchpin of the dev-time feedback loop: when it changes, KernelCMS knows the table shape, the API surface, and the generated types all need regeneration, and it can skip work for collections whose hash is unchanged.

## Schema to database tables

The IR is database-agnostic. Turning it into physical tables is the job of the active adapter, which implements the single `Adapter` contract regardless of engine. For SQL targets, `@kernel/db` builds a Drizzle schema from the IR; for MongoDB, `@kernel/db-mongodb` builds collection shapes and indexes. The mapping from field type to storage is fixed and predictable:

| Field type | Postgres | SQLite | MySQL | MongoDB |
| --- | --- | --- | --- | --- |
| `text`, `email`, `slug` | `text` / `varchar` | `text` | `varchar(255)` | `string` |
| `number` | `numeric` | `real` | `decimal` | `number` |
| `boolean` | `boolean` | `integer` (0/1) | `tinyint(1)` | `bool` |
| `date` | `timestamptz` | `text` (ISO) | `datetime` | `date` |
| `json`, `code`, `richText` | `jsonb` | `text` (JSON) | `json` | embedded doc |
| `point` | `geometry`/`point` | two `real` cols | `point` | GeoJSON |
| `select`, `radio` | `text` + check | `text` | `enum` | `string` |
| `relationship` (one) | FK column | FK column | FK column | `ObjectId` ref |
| `relationship` (many) | junction table | junction table | junction table | array of refs |
| `array`, `blocks` | child table | child table | child table | embedded array |
| `upload` | FK to media | FK to media | FK to media | `ObjectId` ref |

A few design decisions worth stating explicitly:

- **Relational by default on SQL.** `array` and `blocks` fields become normalized child tables (`posts_body_blocks`) with an `_order` column and a parent FK, not a denormalized JSON blob. This keeps them queryable and indexable. Strapi and Payload both lean toward join tables here; Sanity, being document-first, stores everything as one document. KernelCMS follows the SQL grain on SQL and the document grain on Mongo — the adapter, not the field, decides.
- **Localization as a projection, not duplicated columns.** Localized fields are stored in a per-locale row in a `_locales` table keyed by `(parentId, locale)`, so adding a locale is a data operation, not a schema migration. Payload uses a similar locale-row strategy; we make it the default and uniform across adapters.
- **Versions in a shadow table.** With `versions.drafts` enabled, the live row holds the published state and a `posts_versions` table holds the autosaved draft and history, each row carrying the full snapshot plus `version`, `createdAt`, and `_status`.

### Migrations from schema diffs

Migrations are generated, never hand-written for routine changes. The CLI diffs the IR against the last-applied snapshot stored in `_kernel_migrations` and emits forward/back SQL:

```bash
kernel migrate:create        # diff IR vs. snapshot, write a timestamped migration
kernel migrate               # apply pending migrations
kernel migrate:status        # show applied vs. pending
```

Because the diff runs against the deterministic IR — not against the prettier source config — renaming a field in a `group` produces a clean `RENAME COLUMN` when we can match it by stable field id, rather than a destructive drop-and-add. See [Migrations & Schema Evolution](../02-data-modeling/11-data-migrations-and-schema-evolution.md) for the diff algorithm and rename-detection heuristics.

## Schema to generated types

Type generation reads the same IR and emits a `.d.ts` barrel into `@kernel/client`. There is no separate query-driven typegen pass as in Sanity; types fall out of the schema directly, which is why the Local API can be fully inferred without you writing a single generic.

```ts
// .kernel/types.ts  (generated — do not edit)
export interface Post {
  id: string
  title: string                          // required ⇒ non-optional
  slug: string
  status: 'draft' | 'published'          // select ⇒ union, not string
  author: string | User                  // depth-dependent; resolved when populated
  tags: (string | Tag)[]
  hero?: string | Media
  body?: RichTextNode[]
  seo?: { metaTitle?: string; metaDescription?: string }
  createdAt: string
  updatedAt: string
  _status: 'draft' | 'published'
}

export interface KernelCollections {
  posts: Post
  users: User
  tags: Tag
  media: Media
}
```

The generator encodes the rules that make the types *true*, not merely plausible:

- `required: true` produces a non-optional property; everything else is optional, matching what the validation layer actually enforces.
- `select`/`radio` options become string-literal unions, so a typo against an option is a compile error.
- Relationship fields are typed `string | RelatedDoc` and resolve based on the `depth` parameter at the call site — the Local API's return type narrows accordingly.
- Localized fields surface as `LocalizedField<T>` when you opt into the all-locales view, and as plain `T` in single-locale mode.

These types feed the entire system. `@kernel/client` consumes `KernelCollections` for the typed REST/RPC client; the [Local & RPC API](../05-api/03-typed-rpc-and-local-api.md) infers operation signatures from it; `@kernel/admin` uses them for TanStack Form field binding and TanStack Table column typing. One regeneration updates server, admin, and external consumers simultaneously.

## One single source of truth

The reason all of this hangs together is a hard rule: **the config is the only writable artifact; everything else is regenerated and treated as build output.** Generated types live under `.kernel/` and are gitignore-able. Migrations are committed (they are history), but they are produced from the config, not authored against it.

```
        ┌─────────────────────────────┐
        │      kernel.config.ts       │  ← the only thing humans edit
        └──────────────┬──────────────┘
                       │  compile (pure, deterministic)
              ┌────────┴────────┐
              ▼                 ▼
        Internal Schema ── hash ──► change detection
              │
   ┌──────────┼──────────┬───────────┐
   ▼          ▼          ▼           ▼
 tables     types     REST/GraphQL  validation
 (DB)      (.d.ts)     (surface)     (runtime)
```

This is the structural advantage over the competition. Strapi's content types are runtime-mutable JSON, so the "truth" can change in production outside code review, and types are reconstructed after the fact. Sanity splits authority between the Studio schema and GROQ query shapes, requiring a typegen pass to reconcile them. KernelCMS collapses these into one input and guarantees by construction that the database, the API, the validators, and the types can never disagree — because they are all the same function applied to the same argument. If the config compiles, the system is internally consistent; if it does not, nothing downstream is generated.

The escape hatch, per our engineering tenets, is that you can drop to a custom field type with its own storage projection and type emitter, or post-process the generated `.d.ts`. But the default path keeps you in the single-source model, and that is where it wants you to stay.

## Open questions

- **Generated type location.** `.kernel/` committed vs. gitignored — committing improves cold-clone DX and CI diffs, but invites stale hand-edits. Leaning toward gitignored with a `kernel generate` pre-build hook.
- **Cross-adapter `point` and `richText` portability.** SQLite has no native geometry or `jsonb`; the fidelity guarantees when migrating Postgres → SQLite for those types are not yet pinned.
- **Rename detection ceiling.** Field-id-based rename matching is reliable within a collection; cross-collection moves (e.g. extracting a `group` into a shared block) may still surface as drop/add until the diff engine grows structural matching.
