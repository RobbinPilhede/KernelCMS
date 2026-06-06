# Array & Block Fields

KernelCMS gives you two repeatable structures, and the distinction is deliberate. `array` is for homogeneous lists — every row has the same shape. `blocks` is for heterogeneous, schema-tagged content — each row picks one of several named block types, making it a discriminated union at the data layer and a layout builder in the admin. Both are first-class field types defined in `kernel.config.ts`, both flow through the same validation, localization, access-control, and versioning machinery, and both produce fully inferred types end-to-end through `@kernel/core`, `@kernel/client`, and the generated REST/GraphQL/RPC surfaces.

## Array fields

An `array` field is an ordered list of rows where every row conforms to one sub-schema. Think repeatable contact methods, FAQ entries, image galleries with captions, or call-to-action pairs. The sub-schema is just a `fields` array — the full field system recurses, so you can nest `group`, `relationship`, `upload`, even other arrays inside.

```ts
// kernel.config.ts
import { defineCollection } from '@kernel/core'

export const Authors = defineCollection({
  slug: 'authors',
  fields: [
    { name: 'name', type: 'text', required: true },
    {
      name: 'socialLinks',
      type: 'array',
      label: 'Social links',
      minRows: 0,
      maxRows: 8,
      labels: { singular: 'Link', plural: 'Links' },
      // Row summary shown collapsed in the admin
      admin: { rowLabel: ({ data }) => data?.platform ?? 'New link' },
      fields: [
        {
          name: 'platform',
          type: 'select',
          required: true,
          options: ['github', 'x', 'bluesky', 'linkedin', 'website'],
        },
        { name: 'url', type: 'text', required: true, validate: isUrl },
        { name: 'label', type: 'text', localized: true },
      ],
    },
  ],
})
```

The inferred document type is exactly what you'd hand-write:

```ts
type Author = {
  name: string
  socialLinks: {
    id: string
    platform: 'github' | 'x' | 'bluesky' | 'linkedin' | 'website'
    url: string
    label?: string
  }[]
}
```

### Row identity and ordering

Every row gets a stable, server-generated `id` (ULID by default — sortable, collision-resistant). This is the single most important design decision and the one Strapi's older components model got wrong: without per-row identity, reorders and partial updates devolve into delete-and-recreate, which breaks references, drops draft state, and makes diffs unreadable. KernelCMS uses `id` as the React key in the admin, the join key in relational storage, and the merge key for autosave and version diffing. Order is an explicit integer column, not array index, so a drag-reorder writes one `UPDATE` per moved row rather than rewriting the whole list.

### Validation and access on arrays

Array validation runs at two levels. Field-level validators run per row; an array-level validator receives the whole list for cross-row rules (uniqueness, "at least one primary").

```ts
{
  name: 'socialLinks',
  type: 'array',
  validate: (rows) => {
    const platforms = rows.map((r) => r.platform)
    return new Set(platforms).size === platforms.length
      ? true
      : 'Each platform may only appear once'
  },
  access: {
    // Field-level access; see ../03-access-control/02-field-access.md
    update: ({ req }) => req.user?.role === 'editor',
  },
  fields: [/* ... */],
}
```

Localization on an array can be set at the field level (the entire list varies per locale) or at the leaf level (the list is shared but `label` is per-locale, as above). See [Localization](./09-localization-and-i18n.md) for the resolution rules.

## Blocks as discriminated unions

A `blocks` field is the same repeatable list, but each row declares which block type it is via a `blockType` discriminator. You register the allowed blocks; the editor lets authors insert any of them in any order. This is the model Payload calls "blocks" and Sanity expresses through the Portable Text array with custom object types. KernelCMS makes the discriminated union explicit and typed, which is where it pulls ahead of both.

```ts
// kernel.config.ts
import { defineBlock } from '@kernel/core'

const Hero = defineBlock({
  slug: 'hero',
  labels: { singular: 'Hero', plural: 'Heroes' },
  fields: [
    { name: 'heading', type: 'text', required: true, localized: true },
    { name: 'subheading', type: 'textarea', localized: true },
    { name: 'background', type: 'upload', relationTo: 'media' },
  ],
})

const RichTextBlock = defineBlock({
  slug: 'richText',
  fields: [{ name: 'content', type: 'richText', localized: true }],
})

const Gallery = defineBlock({
  slug: 'gallery',
  fields: [
    {
      name: 'images',
      type: 'array',
      fields: [{ name: 'image', type: 'upload', relationTo: 'media', required: true }],
    },
  ],
})

export const Pages = defineCollection({
  slug: 'pages',
  fields: [
    { name: 'title', type: 'text', required: true },
    {
      name: 'layout',
      type: 'blocks',
      minRows: 1,
      blocks: [Hero, RichTextBlock, Gallery],
    },
  ],
})
```

`@kernel/core` infers `layout` as a true discriminated union:

```ts
type PageLayout =
  | { id: string; blockType: 'hero'; heading: string; subheading?: string; background?: string }
  | { id: string; blockType: 'richText'; content: RichTextValue }
  | { id: string; blockType: 'gallery'; images: { id: string; image: string }[] }

type Page = { title: string; layout: PageLayout[] }
```

### Why the discriminated union matters

Because `blockType` is a literal discriminant, downstream rendering is exhaustively checkable. You write a renderer and the compiler forces you to handle every block — add a block to `kernel.config.ts` and every consumer that doesn't handle it fails to typecheck.

```tsx
function renderBlock(block: PageLayout[number]) {
  switch (block.blockType) {
    case 'hero':     return <Hero {...block} />
    case 'richText': return <Prose value={block.content} />
    case 'gallery':  return <Gallery images={block.images} />
    default:         return assertNever(block) // compile error if a case is missing
  }
}
```

This is the concrete win over Strapi's dynamic zones, where the component shape is resolved at runtime and the frontend leans on `any`-typed payloads. It also beats hand-rolled Sanity unions, where you must keep a separate TypeScript type in sync with the GROQ schema by convention. In KernelCMS the config *is* the type.

### Block reuse and a shared registry

Blocks are defined once and shared across collections, globals, and even nested inside other blocks (a `columns` block whose `fields` contain a nested `blocks` field). Define your block library in one module, import it where needed. A block registered in `kernel.config.ts` is available to the REST/GraphQL schema generators and the admin's insert menu without further wiring.

| Concern | `array` | `blocks` |
| --- | --- | --- |
| Row shape | One fixed schema | One of N named schemas |
| Discriminator | none | `blockType` literal |
| Editor UX | repeating row form | insert-menu + layout builder |
| Typical use | galleries, link lists, FAQs | page layouts, flexible content |
| Inferred type | `T[]` | `(A \| B \| C)[]` |
| Nesting | full recursion | full recursion |

## The layout builder UX

The admin renders a `blocks` field as a vertical layout builder. The implementation leans hard on TanStack: row state lives in TanStack Form (each block is a sub-form bound to its registered field schema), long layouts are windowed with TanStack Virtual so a 200-block page edits without jank, and any cross-panel UI state — the open insert menu, the active drag — sits in TanStack Store.

```
┌─ Layout (3 blocks) ─────────────────────────────┐
│  ⠿  ▸ Hero — "Build content in code"      ⋯  ✕  │
│  ⠿  ▾ Rich text                            ⋯  ✕  │
│        [ editor surface … ]                      │
│  ⠿  ▸ Gallery — 6 images                   ⋯  ✕  │
│  ─────────────────────────────────────────────   │
│            [ + Add block ▾ ]                      │
└──────────────────────────────────────────────────┘
   ⠿ drag handle   ▸/▾ collapse   ⋯ duplicate/move
```

Each row collapses to a summary derived from the block's `admin.rowLabel`, so a long page stays scannable. The insert menu groups blocks by category and is fully keyboard-driven and command-palette addressable — `⌘K → Insert → Gallery` — consistent with the rest of the admin's keyboard-first UX. Drag-and-drop reordering, duplicate, and move-to-position all operate on stable row `id`s, so reordering never disturbs draft, autosave, or version state.

Validation surfaces inline per block, and the row badge turns into an error state when a nested field fails — you never have to expand every block to find the one that's broken. Live preview is wired through the same field bindings, so a block edit reflects in the preview pane on the next debounced tick; see [Live Preview](../04-admin-ui/10-live-preview-and-visual-editing.md).

## The storage model

Both fields are logical structures; how they hit disk depends on the adapter. KernelCMS supports two strategies behind the one `Adapter` contract.

### Relational (Drizzle: Postgres, SQLite/libSQL, MySQL)

Arrays and blocks are normalized into child tables, one per array path and one per block type, joined back to the parent by `_parent_id` with an explicit `_order` integer and the row `id`. Block rows carry a `_path` so multiple `blocks` fields in one document don't collide.

```
pages
  id | title | _status
pages_layout_hero
  id | _parent_id → pages.id | _order | _path | heading | subheading | background_id
pages_layout_richText
  id | _parent_id → pages.id | _order | _path | content (jsonb)
pages_layout_gallery
  id | _parent_id → pages.id | _order | _path
pages_layout_gallery_images        ← nested array, recurses the same way
  id | _parent_id → pages_layout_gallery.id | _order | image_id
```

Normalization keeps relationship and upload columns as real foreign keys, so referential integrity, cascade deletes, and `depth`-based population all work uniformly. Migrations are generated from schema diffs — add a field to a block and `kernel db generate` emits the `ALTER`/`CREATE TABLE` for just that block. This mirrors Payload's relational behavior while staying inside Drizzle, so you keep raw SQL as an escape hatch.

### Document (MongoDB)

The MongoDB adapter stores arrays and blocks as embedded sub-documents inline on the parent, preserving order naturally and reading the whole document in one fetch. Each row still carries `id` and `blockType` for parity with the relational path; the operation core never sees the difference.

```jsonc
{ "title": "Home",
  "layout": [
    { "id": "01J…", "blockType": "hero", "heading": "…" },
    { "id": "01J…", "blockType": "gallery", "images": [ /* … */ ] }
  ] }
```

### One query language across both

Regardless of storage, the [shared query language](../05-api/04-query-filtering-sorting-pagination.md) is identical. `where` can target nested block fields by path, `sort` and pagination apply to the parent, and `depth` controls how far nested `relationship`/`upload` references are populated. The adapter compiles the same query to a JOIN plan or an aggregation pipeline; consumers never branch on the backend.

## Open questions

- **Block-level versioning granularity.** Version history currently diffs the whole `blocks` value. Should we expose per-block diffs (move/edit/delete attribution) given the stable row `id`s, or keep document-level diffs to bound storage?
- **Cross-document block library.** Sanity-style shared/referenced blocks (edit once, reflect everywhere) versus today's copy-on-insert. Likely a future `blockRef` field rather than overloading `blocks`.
- **Relational read fan-out.** Deeply nested blocks produce many child tables and JOINs. We're benchmarking a hybrid where leaf-only blocks collapse to `jsonb` while blocks containing relations stay normalized — the threshold is undecided.
