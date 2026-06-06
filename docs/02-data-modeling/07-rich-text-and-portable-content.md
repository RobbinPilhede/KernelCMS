# Rich Text & Portable Content

KernelCMS treats rich text as structured data, not markup. A `richText` field stores a typed, validated JSON document tree — never an HTML string — so the same content renders to HTML, Markdown, JSX, React Native, email, or plain text without a parser in sight. This document specifies the `@kernel/richtext` model, contrasts it with Sanity's Portable Text and Payload's Lexical, and details the serializer pipeline, embeds, and custom nodes that make content genuinely portable across frontends.

## Why structured, not markup

Storing HTML couples your content to one renderer, one set of allowed tags, and one escaping strategy. The moment you need an RSS feed, an LLM summary, a native mobile app, or a redesign that changes how a blockquote looks, you are regex-parsing HTML in production. Sanity solved this with [Portable Text](https://github.com/portabletext/portabletext); Payload moved from Slate to [Lexical](https://lexical.dev/) and stores Lexical's editor state. Strapi, by contrast, historically shipped a Markdown string in its default rich-text field and only later added a structured blocks field — which is why Strapi content has been the hardest of the three to render outside its own admin.

KernelCMS picks a side: the canonical representation is a normalized JSON tree, the editor is an implementation detail, and serialization is a pure, deterministic function of the tree. The tree is the contract. Everything else — the editor, the renderers, the validation — is replaceable.

```
  ┌──────────────┐   stored as    ┌───────────────┐
  │  Admin editor│ ─────────────▶ │  RichTextNode │
  │ (@kernel/ui) │   JSON tree    │     tree      │
  └──────────────┘                └───────┬───────┘
                                          │  pure serializers
              ┌───────────────┬───────────┼───────────┬───────────────┐
              ▼               ▼           ▼           ▼               ▼
            HTML          Markdown       JSX     React Native      plain text
```

## The structured JSON model

A `richText` value is a `RichTextDocument`: a root node holding an array of block-level children. Every node is a discriminated union on `type`. Text lives in leaf `text` nodes carrying `marks` (inline formatting) rather than nested formatting elements, which keeps the tree shallow and diffs cheap for version history and autosave.

```ts
// @kernel/richtext
export interface RichTextDocument {
  type: 'root'
  version: 1
  children: BlockNode[]
}

export type BlockNode =
  | ParagraphNode
  | HeadingNode
  | ListNode
  | BlockquoteNode
  | CodeBlockNode
  | EmbedNode
  | CustomBlockNode

export interface ParagraphNode {
  type: 'paragraph'
  children: InlineNode[]
}

export type InlineNode = TextNode | LinkNode | CustomInlineNode

export interface TextNode {
  type: 'text'
  text: string
  marks?: Mark[] // e.g. ['bold', 'code']
}

export type Mark = 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'subscript' | 'superscript'
```

Three deliberate constraints distinguish this from a raw editor dump:

1. **Marks are a flat string set, not nested elements.** `bold` + `italic` is `marks: ['bold', 'italic']` on one text node, never `<strong><em>`. This is the Portable Text approach and it makes serialization order-independent.
2. **A `version` discriminator on the root.** Migrations between tree shapes are explicit and runnable, the same way [schema migrations](../03-persistence/08-migrations-engine.md) are generated from diffs. Lexical's editor state has no stable, versioned on-disk contract — it tracks the editor, not your data.
3. **Links are inline nodes, not marks.** Because a link carries structured fields (`href`, `rel`, an optional internal `relationship` to another document), it is a node with children, so an internal link can be resolved at render time instead of being baked into a URL.

You configure the field in `kernel.config.ts` and constrain exactly what authors may produce. Disallowed nodes are stripped server-side on write, not merely hidden in the toolbar.

```ts
// kernel.config.ts
import { defineCollection } from '@kernel/core'
import { richText, lexicalCompatPreset } from '@kernel/richtext'

export const Posts = defineCollection({
  slug: 'posts',
  fields: [
    richText('body', {
      // Allow-list of node + mark types; everything else is rejected on write.
      nodes: ['paragraph', 'heading', 'list', 'blockquote', 'code', 'embed'],
      marks: ['bold', 'italic', 'code', 'strike'],
      headingLevels: [2, 3, 4],
      embeds: ['media', 'callout', 'productCard'], // custom node names, see below
      maxDepth: 6,
      localized: true, // per-locale trees; see field-level localization
    }),
  ],
})
```

Because the allow-list is part of config-as-code, it doubles as the validation schema. The same definition powers the editor toolbar, the write-path sanitizer, and the generated GraphQL/REST types — there is no second source of truth, which is the recurring tax in Strapi setups where the admin and the API can disagree about what a field may contain.

## Comparison to Portable Text and Lexical

| Concern                  | KernelCMS `@kernel/richtext`       | Sanity Portable Text                    | Payload Lexical                         |
| ------------------------ | ---------------------------------- | --------------------------------------- | --------------------------------------- |
| On-disk shape            | Versioned `RichTextDocument` tree  | Flat array of blocks + spans            | Lexical editor state JSON               |
| Inline formatting        | Flat `marks` set                   | `marks` + `markDefs`                    | Nested format bitmasks                  |
| Editor coupling          | None — editor is swappable         | None — Portable Text is editor-agnostic | Tight — state mirrors Lexical internals |
| Custom blocks            | `embeds` referencing field configs | `_type` + schema                        | Custom Lexical nodes (+ converters)     |
| Serializers shipped      | HTML, Markdown, JSX, RN, text      | Community renderers per framework       | HTML/JSX converters                     |
| Internal link resolution | First-class `relationship` node    | Via `markDefs` + GROQ                   | Via custom node + populate              |

The honest summary: KernelCMS borrows Portable Text's editor-agnostic, span-and-marks philosophy because it has aged well, and rejects Lexical's "serialize the editor state" approach because it leaks editor internals into your database. Payload users have been burned by Lexical state shape changing across versions; our `version` field and migration runner exist precisely so a tree written in 2025 deserializes deterministically in 2030.

We ship `lexicalCompatPreset` and a Portable Text importer in `@kernel/richtext` so teams migrating off Payload or Sanity can ingest existing content. The importer is a one-way transform into the canonical tree; we do not store foreign formats.

## Serializers to HTML, Markdown, and JSX

A serializer is a pure function `(RichTextDocument, Options) => Output`. Each node type maps to a render function; unknown types fall through to a configurable handler instead of throwing, so a forward-compatible reader never crashes on a node it predates.

```ts
import { serializeHTML, serializeMarkdown, serializeJSX } from '@kernel/richtext'

const html = serializeHTML(doc, {
  // Override or extend per node type.
  nodes: {
    heading: (node, render) => `<h${node.level} class="prose-h">${render(node.children)}</h${node.level}>`,
  },
  // Resolve internal links via the typed client.
  resolveLink: (node) => resolveInternal(node.relationship),
})

const md = serializeMarkdown(doc) // GFM by default
```

`serializeHTML` runs server-side and escapes text content by default; raw HTML never enters the tree, so there is no XSS surface from stored content — output is encoded for the HTML context per the security baseline. For React frontends, `serializeJSX` returns a component, not a string, which avoids `dangerouslySetInnerHTML` entirely:

```tsx
import { RichText } from '@kernel/client/react'

export function PostBody({ doc }: { doc: RichTextDocument }) {
  return (
    <RichText
      value={doc}
      components={{
        heading: ({ node, children }) => <Heading level={node.level}>{children}</Heading>,
        embed: { productCard: ProductCard, callout: Callout },
        link: ({ node, children }) => <Link to={node.relationship}>{children}</Link>,
      }}
    />
  )
}
```

The Markdown serializer targets GFM and round-trips through the importer, which matters for AI workflows and for git-backed content. Where a node has no clean Markdown representation (a `productCard` embed), the serializer emits an HTML fragment or a configurable shortcode rather than silently dropping content. This is a strict improvement over Strapi's old Markdown field, where structure that didn't fit Markdown simply could not exist.

## Embeds and custom nodes

An embed is a block node whose `data` conforms to a named field config — effectively a block embedded inside flowing text. You register embeds in the same place you register blocks, and the rich-text field references them by name.

```ts
// kernel.config.ts
import { defineEmbed } from '@kernel/richtext'
import { upload, relationship, select } from '@kernel/core'

export const Callout = defineEmbed({
  name: 'callout',
  fields: [
    select('variant', { options: ['info', 'warn', 'danger'] }),
    richText('body', { nodes: ['paragraph'], marks: ['bold', 'code'] }), // nested, depth-limited
  ],
})

export const ProductCard = defineEmbed({
  name: 'productCard',
  fields: [relationship('product', { to: 'products' })], // resolved at query depth
})
```

On the wire an embed is just a node:

```jsonc
{
  "type": "embed",
  "embed": "productCard",
  "data": { "product": "prod_8f12" }, // relationship id, populated per `depth`
}
```

Three properties fall out of modeling embeds as first-class nodes:

- **Depth-aware population.** A `productCard`'s relationship participates in the same `depth` parameter as the rest of the query language, so the [REST](../05-api/01-rest-api.md), [GraphQL](../05-api/02-graphql-api.md), and RPC surfaces return the populated product inline without a second round trip.
- **Field-level access control.** Each embed field is governed by the same operation/document/field access rules as top-level fields, so a draft-only `callout` is filtered out for unauthenticated readers automatically.
- **Validation and localization** apply recursively. A nested `richText` inside a `callout` is validated and localized like any other tree, with `maxDepth` preventing pathological nesting.

Custom inline nodes (mentions, footnote references, math spans) follow the same pattern with `defineInlineNode`, the difference being they live in an `InlineNode[]` and must serialize within a text run. Every embed and custom node must declare serializers for every target format it supports; a missing serializer is a build-time error, not a runtime surprise — the type system forces you to answer "how does this render to Markdown?" before you ship the node.

```ts
defineEmbed({
  name: 'callout',
  fields: [
    /* ... */
  ],
  serialize: {
    html: (data, render) => `<aside data-variant="${data.variant}">${render(data.body)}</aside>`,
    markdown: (data, render) => `> ${render(data.body)}`,
    jsx: Callout, // component reference
  },
})
```

## Open questions

- **Collaborative editing model.** The version-history/autosave path is settled, but whether multiplayer editing uses a CRDT over the tree or OT against `@kernel/rpc` server functions is undecided. A CRDT changes the on-disk merge semantics and may warrant a `version: 2` shape.
- **Footnotes and cross-references** are currently expressible as custom inline nodes, but a built-in, serializer-aware footnote system (with automatic numbering across HTML/Markdown/JSX) may deserve to be canonical rather than user-defined.
- **Portable Text export.** We import Portable Text; whether we also ship a lossy _export_ serializer (for teams migrating _to_ Sanity) is a maintenance-cost question we have not resolved.
