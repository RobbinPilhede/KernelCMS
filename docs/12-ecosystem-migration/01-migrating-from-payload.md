# Migrating from Payload

Payload and KernelCMS share a worldview: content modeled in code, a typed Local API, auto-generated REST and GraphQL, and a React admin. That overlap makes migration mechanical rather than a rewrite — most of your `payload.config.ts` maps field-for-field onto `kernel.config.ts`. The friction is concentrated in four places: how config is structured, how the database is shaped (Payload's Drizzle/Mongoose layer vs. KernelCMS adapters), how the admin and APIs are wired through TanStack Start, and a handful of behavioral gotchas around hooks, access control, and rich text. This playbook walks each of them with the exact transforms.

## Config mapping

Both CMSs define collections, globals, and fields as plain objects. The top-level shape is the first thing to translate. Payload exports a `buildConfig({...})` call; KernelCMS exports `defineConfig({...})` from `@kernel/core`. The biggest structural difference: Payload couples the database adapter into config via `db: postgresAdapter(...)`, and KernelCMS does the same but with the swappable `@kernel/db-*` packages.

```ts
// kernel.config.ts
import { defineConfig } from '@kernel/core'
import { postgres } from '@kernel/db-postgres'

export default defineConfig({
  db: postgres({ url: process.env.DATABASE_URL }),
  collections: [Posts, Media, Users],
  globals: [SiteSettings],
  admin: { user: 'users' },
})
```

Field definitions are where the migration earns its keep. The vocabulary is nearly identical; the differences are naming and a few consolidations.

| Payload field | KernelCMS field | Notes |
| --- | --- | --- |
| `text`, `textarea`, `number`, `email`, `date`, `checkbox` | same | Drop-in. `checkbox` → `boolean` is also accepted. |
| `select`, `radio` | `select`, `radio` | `options` shape identical (`{ label, value }`). |
| `relationship` | `relationship` | `relationTo` and `hasMany` carry over unchanged. |
| `upload` | `upload` | Points at an upload-enabled collection, as in Payload. |
| `array`, `blocks`, `group`, `tabs`, `row` | same | Block `slug` → `name`; field arrays nest identically. |
| `richText` | `richText` | Editor backend differs — see Gotchas. |
| `point`, `json`, `code`, `ui` | same | `point` is GeoJSON in both. |
| `collapsible` | `group` with `admin.collapsed` | KernelCMS folds collapsible into `group`. |

A representative collection translates cleanly:

```ts
// collections/Posts.ts
import { defineCollection } from '@kernel/core'

export const Posts = defineCollection({
  slug: 'posts',
  admin: { useAsTitle: 'title', defaultColumns: ['title', 'status', 'updatedAt'] },
  versions: { drafts: true, autosave: { interval: 800 } },
  access: {
    read: ({ req }) => req.user ? true : { status: { equals: 'published' } },
    update: ({ req }) => Boolean(req.user),
  },
  fields: [
    { name: 'title', type: 'text', required: true },
    { name: 'slug', type: 'text', unique: true, localized: true },
    { name: 'hero', type: 'upload', relationTo: 'media' },
    { name: 'author', type: 'relationship', relationTo: 'users' },
    { name: 'body', type: 'richText' },
  ],
})
```

Three naming deltas to script with find-and-replace: Payload's `useAsTitle` lives under `admin` in both, but KernelCMS uses `versions.drafts: true` where Payload uses `versions: { drafts: true }` — equivalent. Payload's `defaultValue` functions and `hooks` arrays survive; Payload's `endpoints` on a collection become route handlers in `@kernel/server` (covered in [API differences](#api-differences)). For the mechanical 80%, write a codemod: parse the Payload config AST, rename `slug`→`name` on blocks, wrap the root in `defineConfig`, and emit. See Codemods and tooling for the starter script.

## Data migration

Payload on Postgres uses Drizzle under the hood, and so does KernelCMS via `@kernel/db-postgres` — but the table layouts are not byte-compatible. Payload generates its own relation tables (`_rels`), localization tables (`_locales`), and version tables (`_v`). KernelCMS generates its schema from your config diff and owns its own naming. Do not point KernelCMS at a live Payload database and expect it to adopt the tables. Migrate the data, not the schema.

```
┌─────────────┐   read via Local API    ┌──────────────┐   write via Local API   ┌──────────────┐
│ Payload DB  │ ──────────────────────► │  ETL script  │ ──────────────────────► │ KernelCMS DB │
│ (any adapter)│   payload.find()       │ (transform)  │   kernel.create()       │ (any adapter)│
└─────────────┘                         └──────────────┘                         └──────────────┘
```

Drive both ends through each CMS's typed Local API rather than raw SQL. This sidesteps every schema discrepancy — relations, localization, versions — because both systems serialize documents to the same logical JSON shape.

```ts
// migrate.ts — run once, idempotent on slug/unique keys
import { getKernel } from '@kernel/core'
import { getPayload } from 'payload'

const payload = await getPayload({ config })
const kernel = await getKernel({ config: kernelConfig })

for (const collection of ['posts', 'media', 'users']) {
  let page = 1
  while (true) {
    const { docs, hasNextPage } = await payload.find({
      collection, page, limit: 200, depth: 0, locale: 'all',
    })
    for (const doc of docs) {
      await kernel.create({
        collection,
        data: transform(collection, doc), // map ids, rich text, uploads
        // preserve drafts/published state explicitly:
        draft: doc._status === 'draft',
      })
    }
    if (!hasNextPage) break
    page++
  }
}
```

Three transform concerns dominate:

- **Relationship IDs.** Payload IDs (serial ints or UUIDs) won't match KernelCMS's new IDs. Migrate in dependency order (users → media → posts), build an `oldId → newId` map per collection, and rewrite `relationship`/`upload` references during `transform()`. For circular relations, do a two-pass: insert with nulls, then patch.
- **Localized fields.** Fetch Payload with `locale: 'all'` so each localized field arrives as `{ en: ..., de: ... }`, then feed it to `kernel.create` per-locale or as a localized payload. KernelCMS localization is field-level, matching Payload's model exactly.
- **Uploads.** Copy the binaries through `@kernel/storage` rather than re-uploading by URL. Stream from Payload's storage adapter into your configured KernelCMS storage adapter (S3, local, etc.), then write the media document with the new key. See [Storage adapters](../07-media-files/01-storage-adapters.md).

For versions and autosave history: Payload's `_v` rows rarely need to survive a migration. If they must, replay them oldest-first as additional `kernel.update({ draft: true })` calls so KernelCMS rebuilds its own version chain. Don't copy `_v` tables directly.

## API differences

Both CMSs expose REST, GraphQL, and an in-process API. The query language is close enough that most client code changes are imports, not logic. The shared KernelCMS query vocabulary — `where`, `sort`, `limit`/`page`, and `depth` — mirrors Payload's almost one-to-one.

| Concern | Payload | KernelCMS |
| --- | --- | --- |
| In-process | `payload.find/create/update/delete` | `kernel.find/create/update/delete` via `@kernel/core` |
| Over the wire | REST + GraphQL + custom express endpoints | REST (`@kernel/rest`), GraphQL (`@kernel/graphql`), typed RPC (`@kernel/rpc`) |
| Typed remote calls | generated SDK / fetch | `@kernel/client` over TanStack Start server functions |
| Admin data layer | React + Payload providers | React + **TanStack Query**, routed by **TanStack Router** |
| Server runtime | Express / Next | **TanStack Start** server functions |

The headline difference is the RPC surface. Payload's Local API is in-process only; to call it from a separate frontend you hit REST/GraphQL and lose end-to-end types at the boundary. KernelCMS exposes the same operation core as **typed RPC via `@kernel/rpc`**, surfaced through `@kernel/client` over TanStack Start server functions — so a separate frontend keeps full inference without code generation.

```ts
// frontend — fully typed, no generated SDK
import { createClient } from '@kernel/client'

const kernel = createClient({ url: process.env.KERNEL_URL })

const { docs } = await kernel.collection('posts').find({
  where: { status: { equals: 'published' } },
  sort: '-publishedAt',
  depth: 1,
  limit: 10,
})
// docs is Post[] — inferred from kernel.config.ts, not hand-written types
```

REST routes map predictably: Payload's `GET /api/posts?where[status][equals]=published` becomes `GET /api/posts?where[status][equals]=published` under `@kernel/rest` — the bracket query syntax is preserved deliberately to ease migration. GraphQL schemas regenerate from your config; query names follow the same singular/plural conventions Payload uses. Custom Payload `endpoints` arrays move to TanStack Start server functions or `@kernel/server` route handlers; there is no Express `req/res` — you return values and throw typed errors. See [REST API](../05-api/01-rest-api.md) and [RPC and the typed client](../05-api/03-typed-rpc-and-local-api.md).

## Common gotchas

- **Rich text is not portable as-is.** Payload's Lexical (or legacy Slate) JSON does not match the `@kernel/richtext` block model. Run the included Lexical → KernelCMS converter during `transform()`; it maps standard nodes (headings, lists, links, uploads, relationships) and emits unmapped nodes as a `raw` block you can fix-forward. Budget review time for embedded blocks and custom Lexical features. Detailed mapping table in Rich text migration.
- **Hooks signatures changed.** Payload hooks receive `{ req, operation, data, ... }`; KernelCMS hooks receive a typed context with `req`, `operation`, and the document, but `req` is not an Express request — it's a framework-neutral request object. Mutating-by-return is the contract in both, so logic ports, but anything reaching into `req.payload` becomes `req.kernel` / the injected `kernel` instance.
- **Access control return shape.** Both support boolean and query-constraint returns from access functions. Payload's `where`-returning access maps directly onto KernelCMS's, but KernelCMS evaluates access at operation, document, **and field** level — audit any Payload field-level `access` and confirm it carried over; field access is on by default and server-side.
- **`depth` defaults differ.** Payload defaults to `depth: 2` on REST. KernelCMS defaults to `depth: 0` to keep payloads lean and predictable. Set `depth` explicitly on any query that relied on auto-population, or you'll get IDs where you expected populated relations.
- **Admin customization.** Payload custom components register via config paths to React files. KernelCMS uses the same config-driven slots but components are wired through `@kernel/admin` and `@kernel/ui` with TanStack Router/Query context available. Custom field components need light rewrites to use TanStack Form bindings instead of Payload's `useField`.
- **Drafts vs. published on read.** Payload's draft access depends on the `draft` query flag plus access functions; replicate it explicitly during migration by setting `draft` per document (shown above) rather than assuming KernelCMS infers status from a field.

## Open questions

- Whether to ship the Lexical converter inside `@kernel/richtext` or as a standalone `@kernel/migrate-payload` package — the converter has a heavier dependency footprint than the core editor warrants.
- Whether to offer an optional "shadow read" adapter that reads a live Payload Postgres schema directly (skipping the ETL) for very large datasets, accepting the maintenance cost of tracking Payload's internal table layout across its versions.
- Whether to preserve Payload's `_v` version history natively or always rebuild the KernelCMS version chain via replay — replay is cleaner but loses original timestamps unless we expose a `versionCreatedAt` override on `kernel.update`.
