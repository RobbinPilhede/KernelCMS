# Migrating from Strapi

Strapi and KernelCMS both model content in repeatable types and auto-generate REST and GraphQL, but they diverge at the foundation: Strapi stores your schema in JSON files that its admin UI rewrites at runtime, while KernelCMS treats `kernel.config.ts` as the single typed source of truth. This guide maps Strapi's content-type model onto KernelCMS collections and globals, walks through importing your existing data via the `@kernel/server` Local API, finds equivalents for the common Strapi plugins, and catalogs the API behaviors that will change for your frontend clients.

## Why teams leave Strapi

The recurring complaints are predictable: schema lives half in code and half in the database, so two environments drift; the typing story is weak because the Content-Type Builder generates loose interfaces after the fact; and the GraphQL/REST shape mutates whenever someone clicks around the admin. KernelCMS inverts all three. The config is the schema, types are inferred end-to-end with zero `any`, and the admin can never produce a shape your code didn't declare. Where Strapi gives you a database-backed schema with a code escape hatch, KernelCMS gives you a code schema with no hidden state.

## Content-type mapping

Strapi's `content-types/*/schema.json` files map cleanly onto KernelCMS collections. A Strapi collection type becomes a `collection`; a single type becomes a `global`. The attribute keys translate to fields, but the field vocabulary is richer and the semantics are stricter.

| Strapi attribute                            | KernelCMS field                                       | Notes                                            |
| ------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------ |
| `string`, `uid`                             | `text`                                                | `uid` becomes `text` with a `slug` validate hook |
| `text`, `blocks`                            | `textarea`, `richText`                                | Strapi Blocks → `@kernel/richtext` block editor  |
| `richtext` (markdown)                       | `richText` or `code`                                  | choose based on whether you keep Markdown        |
| `integer`, `biginteger`, `decimal`, `float` | `number`                                              | `number` carries `min`/`max`/`step`              |
| `boolean`                                   | `boolean`                                             |                                                  |
| `date`, `datetime`, `time`                  | `date`                                                | one field type, format via admin config          |
| `email`                                     | `email`                                               | built-in validation                              |
| `enumeration`                               | `select` or `radio`                                   | options become typed unions                      |
| `json`                                      | `json`                                                |                                                  |
| `media` (single)                            | `upload`                                              | references a `@kernel/storage` adapter           |
| `media` (multiple)                          | `array` of `upload`, or `upload` with `hasMany: true` |                                                  |
| `relation`                                  | `relationship`                                        | `hasMany` / `hasOne` set explicitly              |
| `component` (repeatable)                    | `array`                                               |                                                  |
| `component` (single)                        | `group`                                               |                                                  |
| `dynamiczone`                               | `blocks`                                              | the closest 1:1 mapping in any CMS               |
| `password`                                  | handled by `@kernel/auth`                             | do not model auth in a content collection        |

Strapi's dynamic zones are the standout. They translate directly to KernelCMS `blocks`, which is the same primitive Payload exposes and one Sanity only approximates through arrays of objects. A Strapi article with a dynamic zone becomes:

```ts
// kernel.config.ts
import { defineConfig, collection, fields } from '@kernel/core'

const Article = collection({
  slug: 'articles',
  labels: { singular: 'Article', plural: 'Articles' },
  fields: [
    fields.text({ name: 'title', required: true }),
    fields.text({
      name: 'slug',
      required: true,
      unique: true,
      validate: (v) => /^[a-z0-9-]+$/.test(v) || 'lowercase, hyphens only',
    }),
    fields.relationship({ name: 'author', relationTo: 'authors', hasMany: false }),
    // Strapi dynamic zone → blocks
    fields.blocks({
      name: 'body',
      blocks: [
        { slug: 'hero', fields: [fields.text({ name: 'heading' }), fields.upload({ name: 'image' })] },
        { slug: 'richText', fields: [fields.richText({ name: 'content' })] },
        { slug: 'quote', fields: [fields.textarea({ name: 'text' }), fields.text({ name: 'cite' })] },
      ],
    }),
  ],
})

export default defineConfig({
  collections: [Article /* , Author, ... */],
  db: postgresAdapter({ connectionString: process.env.DATABASE_URL }),
})
```

Two Strapi behaviors need explicit decisions during mapping:

- **i18n.** Strapi localizes at the entry level — a separate row per locale linked by `localizations`. KernelCMS localizes at the **field** level (`localized: true`), so one document holds every locale. This is closer to Payload than to Strapi and almost always reduces row count. See [Localization](../02-data-modeling/09-localization-and-i18n.md) for the field-level model.
- **Draft & Publish.** Strapi's `draftAndPublish` flag becomes `versions: { drafts: true }` on the collection, which additionally unlocks version history and autosave — capabilities Strapi lacks entirely.

```ts
const Article = collection({
  slug: 'articles',
  versions: { drafts: true, autosave: { interval: 800 } },
  fields: [
    /* ... */
  ],
})
```

## Data import

Strapi data lives in your SQL/Mongo database plus an `uploads/` directory and (often) a `strapi export` tarball. Do not write directly to KernelCMS tables — the schema diff, version rows, and relationship join tables are managed by the adapter. Import through the **Local API** so every validation hook, access rule, and version record runs exactly as it would for a live request.

```
┌─────────────┐   strapi export    ┌──────────────┐   getKernel()   ┌──────────────┐
│  Strapi DB  │ ─────────────────► │  export.tar  │ ──────────────► │  @kernel/    │
│  + uploads  │                    │  (entries +  │   .create()     │  server      │
└─────────────┘                    │   media)     │                 │  Local API   │
                                   └──────────────┘                 └──────┬───────┘
                                                                           ▼
                                                              Drizzle adapter → Postgres
```

A representative importer:

```ts
import { getKernel } from '@kernel/server'
import { readExport } from './strapi-export' // your tarball reader

const kernel = await getKernel({ config })

// 1. Media first — relationships will point at the new upload IDs.
const idMap = new Map<number, string>() // strapiId → kernel upload id
for (const file of await readExport('uploads')) {
  const doc = await kernel.create({
    collection: 'media',
    file: { data: file.buffer, name: file.name, mimetype: file.mime },
    overrideAccess: true, // bulk import runs as a privileged operation
  })
  idMap.set(file.strapiId, doc.id)
}

// 2. Entries, rewriting relation + media references.
for (const entry of await readExport('articles')) {
  await kernel.create({
    collection: 'articles',
    data: {
      title: entry.title,
      slug: entry.slug,
      author: idMap.get(entry.author?.id),
      body: mapDynamicZone(entry.body, idMap), // dz components → blocks
      _status: entry.publishedAt ? 'published' : 'draft',
    },
    overrideAccess: true,
    depth: 0,
  })
}
```

Guidance that saves a second pass:

- **Media before entries.** Build the `idMap` first so relation and media fields resolve to real KernelCMS IDs.
- **Preserve publish state.** Map Strapi's `publishedAt` to `_status`. A null `publishedAt` is a draft.
- **i18n collapse.** Group Strapi `localizations` siblings into one document and write each locale into the localized fields rather than creating N documents.
- **Run, don't bypass, validation.** If an import fails a `validate` hook, the source data was already invalid — fix it at the source rather than disabling the check.

For large datasets, batch with `kernel.create` inside a transaction and disable autosave during import. The full operation reference is in [The Local API](../05-api/03-typed-rpc-and-local-api.md).

## Plugin equivalents

Strapi's plugin marketplace covers gaps that KernelCMS fills in core or through first-party `@kernel/*` packages. Most of what teams install in Strapi is already built in.

| Strapi plugin                     | KernelCMS equivalent                            | Where it lives    |
| --------------------------------- | ----------------------------------------------- | ----------------- |
| Users & Permissions               | `@kernel/auth` + access control                 | core, server-side |
| i18n                              | field-level `localized: true`                   | `@kernel/core`    |
| GraphQL                           | `@kernel/graphql`                               | auto-generated    |
| Documentation (REST)              | `@kernel/rest` OpenAPI output                   | auto-generated    |
| Upload providers (S3, Cloudinary) | `@kernel/storage` adapters                      | swappable adapter |
| SEO                               | `group` field + plugin via `@kernel/plugin-sdk` | config-level      |
| Email                             | `@kernel/auth` email + email adapter            | swappable adapter |
| Sentry / monitoring               | KernelCMS Cloud observability or your own       | deployment        |

The architectural difference is the adapter contract. In Strapi, the S3 upload provider is a bespoke plugin with its own config surface; in KernelCMS, **storage** is one of seven swappable concerns (database, storage, email, auth, search, cache, queue), all implementing a uniform Adapter interface. Swapping S3 for R2 is a one-line change, and the same is true for the database — something neither Strapi nor Sanity offers, since Sanity hosts your content store and Strapi couples you to its own database layer.

```ts
import { s3Adapter } from '@kernel/storage'

export default defineConfig({
  storage: s3Adapter({
    bucket: process.env.S3_BUCKET,
    region: process.env.S3_REGION,
    // credentials resolved from the environment — never inline
  }),
})
```

For genuinely custom Strapi plugins (a controller, a service, an admin extension), rebuild them against `@kernel/plugin-sdk`. A plugin can register collections, fields, hooks, admin routes, and access rules. See Writing Plugins.

## API differences

Your frontend clients will need changes. The query language unifies across REST, GraphQL, and RPC in KernelCMS, where Strapi's REST and GraphQL filter syntaxes diverge.

**Filtering.** Strapi's REST uses `filters[field][$operator]=value`. KernelCMS uses a single `where` object with the same operators across every surface:

```
# Strapi
GET /api/articles?filters[title][$contains]=launch&sort=publishedAt:desc

# KernelCMS
GET /api/articles?where[title][contains]=launch&sort=-publishedAt
```

**Population vs. depth.** Strapi requires explicit `populate` to hydrate relations and, before v4 conveniences, would silently drop them. KernelCMS uses `depth`: an integer that controls how many relationship levels to resolve, applied uniformly across REST, GraphQL, and the Local API.

```
GET /api/articles?depth=2     # author and author's avatar resolved
```

**Response envelope.** Strapi wraps everything in `data`/`attributes` with `meta.pagination`. KernelCMS returns documents directly with pagination at the top level:

```jsonc
// Strapi
{ "data": [{ "id": 1, "attributes": { "title": "..." } }], "meta": { "pagination": { /* ... */ } } }

// KernelCMS
{ "docs": [{ "id": "...", "title": "..." }], "totalDocs": 42, "page": 1, "hasNextPage": true }
```

**The typed path Strapi never had.** Strapi gives you REST and GraphQL. KernelCMS adds a third surface: the same operation core called in-process as the Local API, and exposed over the wire as typed RPC through TanStack Start server functions via `@kernel/rpc` and `@kernel/client`. Your admin and your frontend get end-to-end inference with no codegen step and no schema drift.

```ts
import { createClient } from '@kernel/client'

const client = createClient<Config>({ url: process.env.KERNEL_URL })

// Fully typed: `article.body` is the blocks union, not `any`.
const { docs } = await client.find({
  collection: 'articles',
  where: { _status: { equals: 'published' } },
  sort: '-publishedAt',
  depth: 1,
})
```

A full surface-by-surface comparison lives in Query Language, and the REST envelope mapping is in [REST API](../05-api/01-rest-api.md).

## Migration checklist

1. Translate each `schema.json` into a collection/global in `kernel.config.ts`; map dynamic zones to `blocks`.
2. Decide field-level vs. entry-level localization and re-shape i18n accordingly.
3. Run `kernel migrate` to generate schema from the config diff.
4. Import media, then entries, through the Local API with `overrideAccess: true`.
5. Re-point frontend queries to the unified `where`/`sort`/`depth` syntax and new response envelope.
6. Replace Strapi plugins with `@kernel/*` adapters or `@kernel/plugin-sdk` plugins.

## Open questions

- **Automated `schema.json` transpiler.** A `kernel import strapi` command could read `content-types/` and emit a draft config. Worth shipping, but dynamic-zone-to-blocks and component-to-array mapping need a human review pass — should it emit a config plus a TODO report, or refuse on ambiguity?
- **ID preservation.** Strapi uses integer IDs; KernelCMS defaults to opaque string IDs. Whether the importer should offer an integer-ID compatibility mode for clients that hardcode numeric IDs is undecided.
- **Markdown richtext.** Whether to keep legacy Strapi Markdown as `code`/`textarea` or convert it into the `@kernel/richtext` block model on import is a per-project call; a lossy auto-converter may not be worth maintaining.
