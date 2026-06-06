# Migrating from Sanity

Sanity models content with the Studio's schema files, stores it in a hosted content lake, and reads it back through GROQ. KernelCMS keeps the parts that made Sanity productive — schema-in-code, a typed query layer, portable content — but replaces the proprietary content lake and GROQ runtime with a database you own (Postgres, SQLite, MySQL, or MongoDB through the `@kernel/db-*` adapters) and a query language that runs identically over REST, GraphQL, and the typed Local/RPC API. This guide maps Sanity's primitives onto KernelCMS, converts GROQ to KernelCMS queries, moves a dataset export into your adapter, and translates Portable Text into the KernelCMS `richText` field.

The shape of the migration is mechanical once you accept one inversion: Sanity is reference-first and weakly typed at rest; KernelCMS is collection-first with a relational schema and full type inference end to end. That inversion is the work.

## Schema mapping

A Sanity schema is a flat array of document and object types registered with the Studio. There is no enforced separation between repeatable documents and singletons — you fake singletons with a structure-builder hack and a fixed `_id`. KernelCMS makes that distinction first-class: **Collections** are repeatable content types, **Globals** are singletons. Map every `type: 'document'` to a collection unless it is logically a single record (site settings, navigation), which becomes a global.

```ts
// kernel.config.ts
import { defineConfig } from '@kernel/core'
import { postgres } from '@kernel/db-postgres'

export default defineConfig({
  db: postgres({ connectionString: process.env.DATABASE_URL }),
  collections: [
    {
      slug: 'post',
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'slug', type: 'text', unique: true, index: true },
        { name: 'publishedAt', type: 'date' },
        { name: 'author', type: 'relationship', relationTo: 'author' },
        { name: 'categories', type: 'relationship', relationTo: 'category', hasMany: true },
        { name: 'coverImage', type: 'upload', relationTo: 'media' },
        { name: 'body', type: 'richText' },
      ],
      versions: { drafts: true, autosave: true },
    },
  ],
  globals: [
    {
      slug: 'siteSettings',
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'mainNav', type: 'array', fields: [
          { name: 'label', type: 'text' },
          { name: 'href', type: 'text' },
        ]},
      ],
    },
  ],
})
```

The field-type translation is direct for most cases. The table below is the canonical mapping — keep it open while you port a schema.

| Sanity type | KernelCMS field | Notes |
| --- | --- | --- |
| `string` | `text` | Add `validate` for length/regex that Sanity put in `validation`. |
| `text` | `textarea` | Multi-line plain text. |
| `number` | `number` | `min`/`max` move from `validation` to field `min`/`max`. |
| `boolean` | `boolean` | — |
| `datetime` / `date` | `date` | Store ISO 8601; the admin picker handles both granularities. |
| `slug` | `text` with `unique: true` | Sanity's `slug.current` flattens to a plain indexed string. |
| `url` | `text` with URL `validate` | No dedicated field; validate the format. |
| `image` | `upload` | Targets a media collection; see [media-library](../04-admin-ui/09-media-library-ui.md). |
| `file` | `upload` | Same, non-image MIME. |
| `reference` | `relationship` | `to: [{ type }]` becomes `relationTo`; arrays become `hasMany: true`. |
| `array` of objects | `array` | Named subfields; positional and reorderable. |
| `array` of typed blocks | `blocks` | Each Sanity object type becomes a named block. |
| `object` | `group` | Inline named subfields, single instance. |
| `block` (Portable Text) | `richText` | Converted, not copied — see below. |
| `geopoint` | `point` | `{ lat, lng }` maps to KernelCMS `point`. |
| custom input component | custom field type | Register through `@kernel/plugin-sdk`. |

Two structural differences deserve attention.

**Localization.** Sanity has no built-in i18n; teams reach for `@sanity/document-internationalization` (document-per-locale) or field-level plugins (object-per-field). KernelCMS makes localization a field flag — `localized: true` — and the adapter stores per-locale values in one document. Pick the field-level model on the way in; it survives publish, version history, and the API's `?locale=` param without document duplication. See [localization](../02-data-modeling/09-localization-and-i18n.md).

**References vs relationships.** Sanity references are untyped at rest (`_ref` is a string `_id`); integrity is advisory. KernelCMS `relationship` fields are real foreign keys on SQL adapters, so a dangling reference fails on write. During import you must topologically order inserts (authors before posts) or defer constraint checks. The MongoDB adapter relaxes this, matching Sanity's looser model if you need it.

## GROQ to KernelCMS queries

GROQ is expressive and proprietary. KernelCMS does not reimplement it; it ships **one query language** — `where` / `sort` / pagination / `depth` — that runs over REST, GraphQL, and the Local API. The mental shift: GROQ projections that *join and shape* in the query are replaced by `depth` (relationship population) plus `select` (field projection). Filtering moves into a structured `where` object instead of a string DSL.

```
GROQ:   *[_type == "post" && publishedAt < now()] | order(publishedAt desc) [0...10] { title, "author": author->name }

         ┌── filter ──┐ ┌── sort ──┐ ┌slice┐ ┌─ projection + join ─┐
```

That single GROQ line becomes:

```ts
import { getPayload } from '@kernel/server'

const kernel = await getPayload()

const { docs } = await kernel.find({
  collection: 'post',
  where: {
    publishedAt: { less_than: new Date().toISOString() },
  },
  sort: '-publishedAt',
  limit: 10,
  depth: 1,                 // populates author -> { name, ... }
  select: { title: true, author: true },
})
```

Operator translation covers the common GROQ idioms:

| GROQ | KernelCMS `where` |
| --- | --- |
| `field == value` | `{ field: { equals: value } }` |
| `field != value` | `{ field: { not_equals: value } }` |
| `field in [a, b]` | `{ field: { in: [a, b] } }` |
| `field match "term*"` | `{ field: { like: 'term' } }` |
| `count(tags) > 0` | `{ tags: { exists: true } }` |
| `a && b` | `{ and: [a, b] }` |
| `a \|\| b` | `{ or: [a, b] }` |
| `references($id)` | `{ relField: { equals: id } }` |
| `field->sub == x` (join filter) | `{ 'field.sub': { equals: x } }` |

Two GROQ features have no direct equal. **Arbitrary projections** (computing fields, renaming, deep reshaping inside the query) are deliberately not in the query language — do that shaping in a server function or a TanStack Query `select`, where it is typed. **Multi-document joins in a single GROQ expression** become either nested `depth` population or an explicit second `find`; KernelCMS favors predictable SQL over one opaque query, which is the same trade Payload makes against Sanity. For the full grammar see query-language. On the frontend, the same query runs through `@kernel/client` and is cached by TanStack Query:

```ts
import { createClient } from '@kernel/client'
const client = createClient({ url: process.env.KERNEL_URL })

const posts = await client.find('post', {
  where: { status: { equals: 'published' } },
  sort: '-publishedAt',
  depth: 1,
})
```

## Dataset export and import

Sanity exports are NDJSON — one document per line — plus an `assets/` tarball, produced by `sanity dataset export`. The migration is a streamed transform: read NDJSON, reshape each document to its target collection, rewrite asset references, and write through the KernelCMS Local API so that hooks, validation, and version history all fire.

```
sanity dataset export prod data.tar.gz
        │
        ├── data.ndjson      ──►  transform ──►  kernel.create(...)   (Local API)
        └── assets/*         ──►  upload     ──►  @kernel/storage adapter
```

```ts
// scripts/import-sanity.ts
import { getPayload } from '@kernel/server'
import { readNdjson } from './ndjson'
import { toRichText } from './portable-text'

const kernel = await getPayload()
const typeToCollection: Record<string, string> = {
  post: 'post', author: 'author', category: 'category',
}

for await (const doc of readNdjson('data.ndjson')) {
  if (doc._type.startsWith('sanity.')) continue        // skip system docs
  const collection = typeToCollection[doc._type]
  if (!collection) continue

  await kernel.create({
    collection,
    data: {
      ...mapFields(doc),
      body: doc.body ? toRichText(doc.body) : undefined,
    },
    // preserve original IDs so references resolve; depth handled in pass 2
    overrideId: doc._id.replace(/^drafts\./, ''),
    draft: doc._id.startsWith('drafts.'),
  })
}
```

Ordering and integrity rules that bite if ignored:

- **Two passes.** Pass one creates every document with scalar fields only and original IDs preserved. Pass two patches `relationship` fields once all targets exist. This sidesteps the topological-ordering problem on SQL adapters and matches how you would seed any relational store.
- **Drafts.** Sanity encodes drafts as `drafts.<id>`. Route those into KernelCMS draft versions (`draft: true`) so published/draft state survives — drafts and version history are native here, unlike Strapi's bolt-on draft system.
- **Assets.** Each `image`/`file` references `image-<hash>-<dims>-<ext>`. Resolve the binary from `assets/`, push it through `@kernel/storage`, and store the returned upload ID on the `upload` field. Do not hotlink Sanity's CDN — that recreates the lock-in you are leaving.
- **Validation.** Run the import against a SQLite adapter first (`@kernel/db-sqlite`) to surface every validation failure cheaply before touching Postgres. Migrations are generated from the schema diff, so the target tables already exist.

For large datasets, batch `create` calls and disable autosave during import, then re-enable it. See seeding-and-import.

## Portable Text conversion

Portable Text is Sanity's serialized rich text: an array of `block` and custom objects, each block carrying `children` (spans with `marks`) and a `markDefs` array that resolves mark keys to annotations (links, footnotes). KernelCMS `richText` stores a structured document of the same family — a typed node tree edited by the block-based editor in `@kernel/richtext` — so conversion is a tree transform, not a reparse.

| Portable Text | KernelCMS `richText` node |
| --- | --- |
| `block.style: 'normal'` | `paragraph` |
| `block.style: 'h2'…'h4'` | `heading` with `level` |
| `block.style: 'blockquote'` | `blockquote` |
| `block.listItem: 'bullet'` | `list` (`unordered`) item |
| `span.marks: ['strong']` | text node with `bold` format |
| `span.marks: ['em']` | text node with `italic` format |
| mark key → `markDefs[].link` | `link` node with `url` |
| custom `image` object | `upload` node (resolved to media ID) |
| custom block object | named `blocks` node |

```ts
import type { RichTextNode } from '@kernel/richtext'

export function toRichText(blocks: PortableTextBlock[]): RichTextNode {
  return {
    type: 'root',
    children: blocks.map((b) => {
      if (b._type !== 'block') return convertCustom(b)   // images, embeds
      const markDefs = Object.fromEntries((b.markDefs ?? []).map((m) => [m._key, m]))
      return {
        type: b.listItem ? 'listitem' : blockType(b.style),
        ...(b.style?.match(/^h\d$/) && { level: Number(b.style[1]) }),
        children: b.children.map((span) => applyMarks(span, markDefs)),
      }
    }),
  }
}
```

The sharp edges:

- **`markDefs` are local to each block.** Resolve link/annotation keys per block before flattening, or annotations attach to the wrong span.
- **Custom inline objects** (`image`, `code`, embeds) become first-class `richText` nodes, not escaped HTML. Map each Sanity object `_type` to a KernelCMS block so live preview and visual editing keep working — the same surface Sanity's Presentation tool offers, but rendered by `@kernel/admin`.
- **Round-trip, don't lossy-flatten.** Resist converting Portable Text to HTML or Markdown as an intermediate; you lose annotations and custom blocks. The node-to-node transform above is reversible, which matters if you run KernelCMS and Sanity in parallel during a phased cutover.

Validate converted documents by rendering a sample through the editor in a headless test before bulk import; a malformed node tree fails silently in some renderers.

## Open questions

- **GROQ compatibility shim.** Whether `@kernel/client` should ship an optional GROQ-subset parser that compiles to the KernelCMS `where`/`select` form, easing teams with thousands of embedded GROQ strings, or whether a one-time codemod is the cleaner answer.
- **Asset hash mapping.** The exact strategy for mapping Sanity's `image-<hash>` IDs to `@kernel/storage` keys while preserving CDN cache headers and the image pipeline (crop/hotspot) metadata that Sanity stores inline.
- **Hotspot/crop semantics.** Whether to translate Sanity's image hotspot/crop into a KernelCMS focal-point field on `upload`, or drop it and rely on per-request transforms.
