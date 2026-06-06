# Rich Text Editor

KernelCMS ships a block-based rich-text editor shipped from `@kernel/richtext`. It is not a string of HTML and it is not Markdown — every document is a typed tree that serializes to a stable JSON schema model. The editor is the admin-side surface for the `richText` field type; the same schema model is validated server-side, queried over REST/GraphQL/RPC, and rendered by your frontend. This document covers how the editor is built, the node/mark/block taxonomy, the toolbar and slash menu, embeds, and the serialization contract that ties it all to the rest of the system.

## Why a typed tree, not HTML

Payload's Lexical editor and Sanity's Portable Text both made the same correct call: store structured JSON, not HTML. Strapi historically stored Markdown (and now ships a Blocks field that is also structured). KernelCMS sides with the structured camp and goes further — the rich-text tree is a first-class part of your `kernel.config.ts` content model, so its allowed nodes, marks, and blocks are declared in config and enforced everywhere.

```ts
// kernel.config.ts
import { defineConfig } from '@kernel/core'
import { richText } from '@kernel/richtext'

export default defineConfig({
  collections: [
    {
      slug: 'posts',
      fields: [
        { name: 'title', type: 'text', required: true },
        {
          name: 'body',
          type: 'richText',
          editor: richText({
            nodes: ['paragraph', 'heading', 'list', 'blockquote', 'codeBlock', 'link'],
            marks: ['bold', 'italic', 'code', 'underline', 'strikethrough'],
            blocks: ['callout', 'mediaEmbed', 'codeSandbox'],
            maxHeadingLevel: 3,
          }),
        },
      ],
    },
  ],
})
```

The `editor` factory returns a `RichTextConfig`. The same object configures the admin editor, the validators, and the auto-generated GraphQL/REST type for the field. There is one source of truth — you never configure the editor in two places.

## Editor architecture

The editor is a ProseMirror document model wrapped in a thin React layer that lives inside the TanStack Form field for the document. We chose ProseMirror's model over building our own because its schema, transaction, and decoration primitives are battle-tested and its position-mapping is correct under concurrent edits — the hard part of any collaborative-capable editor. We do **not** expose ProseMirror APIs to plugin authors; the public surface is `@kernel/richtext`, so we can swap the engine without breaking config.

```
@kernel/richtext
├── schema        ProseMirror schema built from RichTextConfig
├── model         JSON node/mark types (the serialized shape)
├── commands      typed editor commands (toggleMark, insertBlock, …)
├── react         <RichTextEditor> bound to a TanStack Form field
├── toolbar       contextual + fixed toolbar surfaces
├── slash         slash-menu registry + fuzzy matcher
├── embeds        async embed resolution + sandboxed previews
└── serialize     model ⇄ ProseMirror doc, model → HTML/text
```

State flows in one direction. The serialized JSON model is the field value held by TanStack Form. On mount, `serialize.toDoc(value, schema)` hydrates a ProseMirror `EditorState`. Each transaction produces a new doc; a debounced `serialize.toModel(doc)` writes the JSON back into the form field, which feeds drafts, autosave, and version history. The editor never holds authoritative state — TanStack Form does.

```
TanStack Form field value (JSON model)
        │ toDoc()                ▲ toModel() (debounced)
        ▼                        │
   EditorState ──transaction──> EditorState
        │
   decorations (selection, embeds, comments, presence)
```

Selection, validation hints, and presence cursors are rendered as ProseMirror decorations — they are derived view state and never serialized. This keeps the persisted model clean: nothing about a cursor or a transient error ever lands in your database.

Collaborative editing is out of scope for the field model but designed for. Because positions map through ProseMirror's `Mapping`, a future `@kernel/collab` adapter can layer an OT/CRDT transport without touching the schema or serialization. See [Open questions](#open-questions).

## Blocks, marks, and nodes

We use three categories. The distinction is not cosmetic — it determines serialization shape, what the toolbar offers, and how access control applies.

| Concept   | What it is                                                  | Examples                                                                       | Serialized as                                 |
| --------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------- |
| **Node**  | Built-in structural element with text or children           | `paragraph`, `heading`, `list`, `listItem`, `blockquote`, `codeBlock`, `image` | `{ type, attrs?, content? }`                  |
| **Mark**  | Inline annotation on a text run                             | `bold`, `italic`, `code`, `link`, `underline`                                  | `{ type, attrs? }` on a text node's `marks[]` |
| **Block** | User-defined, config-driven embed with its own field schema | `callout`, `mediaEmbed`, `codeSandbox`                                         | `{ type: 'block', blockType, fields }`        |

Nodes and marks are the editor's primitives — fixed in number, enabled or disabled per field via the `nodes`/`marks` arrays. **Blocks** are the extension point and the headline feature: they are the same `blocks` field type used elsewhere in KernelCMS, embedded inline. A block declares fields exactly like a collection does, and KernelCMS renders a sub-form (via TanStack Form) inside the editor for editing it.

```ts
// A custom block, defined once and reusable in any richText field
import { defineBlock } from '@kernel/richtext'

export const callout = defineBlock({
  slug: 'callout',
  label: 'Callout',
  fields: [
    {
      name: 'variant',
      type: 'select',
      options: ['info', 'warning', 'danger'],
      defaultValue: 'info',
    },
    { name: 'body', type: 'richText' }, // blocks nest
  ],
  // Admin preview rendered inside the editor
  Preview: ({ data }) => null,
})
```

This is the key win over Payload, whose Lexical blocks are powerful but bespoke to Lexical, and over Sanity, where custom block content requires hand-written Portable Text serializers and React components per type. In KernelCMS a block reuses the entire field system — validation, localization, access control, and conditional logic all work inside a block with zero extra wiring. A block's `richText` sub-field can itself contain blocks, so nesting is uniform.

Node attributes are validated against the schema on every transaction, so a heading can never exceed `maxHeadingLevel` and a disabled mark can never be applied — even by a paste. Validation rules live alongside the rest of the field's validation.

## Toolbar and slash menu

Two complementary input surfaces, because users expect both.

**Contextual toolbar.** A floating toolbar appears on text selection, offering only the marks and inline actions enabled for that field. It is the fast path for formatting existing text. A second, optional fixed toolbar can be pinned for users who prefer a persistent bar — controlled per field with `toolbar: 'floating' | 'fixed' | 'both'`.

**Slash menu.** Typing `/` on an empty line opens a command palette that mirrors the admin's global [command palette](./11-command-palette-and-keyboard.md) interaction model. It lists every node and block available in the field, fuzzy-matched against the typed query. This is how users insert structure — headings, lists, code blocks, and every custom block — without leaving the keyboard.

```ts
// Slash items are derived from config but can be augmented
import { defineSlashItem } from '@kernel/richtext'

export const insertToday = defineSlashItem({
  id: 'insert-today',
  label: 'Insert today’s date',
  keywords: ['date', 'now'],
  group: 'Inline',
  run: (editor) => editor.insertText(new Date().toISOString().slice(0, 10)),
})
```

```
/ca
┌─────────────────────────────┐
│ BLOCKS                      │
│  ▸ Callout            ⏎     │  ← fuzzy match on "ca"
│  ▸ Code Sandbox             │
│ NODES                       │
│  ▸ Code block               │
└─────────────────────────────┘
```

Items are grouped (`Nodes`, `Blocks`, `Inline`) and ordered by group then relevance. Every item is keyboard-navigable, has an `aria-selected` active row, and announces selection to screen readers — the editor is held to the same WCAG 2.2 AA bar as the rest of the admin. Slash items respect access control: a block a user cannot create is not listed.

The toolbar and slash registries are populated from `RichTextConfig` at build time, then merged with any `defineSlashItem`/`defineToolbarItem` extensions registered by [plugins](../08-extensibility/01-plugin-sdk-and-authoring.md). There is no imperative `editor.registerThing()` call scattered through app code — extensions are declared and collected.

## Embeds

Embeds are blocks whose preview depends on remote data — a tweet, a YouTube video, a Figma frame, an OpenGraph card for a pasted URL. They share the block model but add an async resolution lifecycle so the editor can show a real preview without trusting arbitrary third-party scripts.

```ts
import { defineEmbed } from '@kernel/richtext'

export const mediaEmbed = defineEmbed({
  slug: 'mediaEmbed',
  label: 'Media embed',
  // Auto-trigger when a matching URL is pasted on its own line
  match: /^https?:\/\/(www\.)?(youtube\.com|youtu\.be|vimeo\.com)\//,
  fields: [{ name: 'url', type: 'text', required: true }],
  // Runs as a TanStack Start server function — never in the browser
  resolve: async ({ url, fetchOEmbed }) => {
    const data = await fetchOEmbed(url)
    return { provider: data.provider_name, html: data.html, title: data.title }
  },
})
```

Two rules make embeds safe by default:

1. **Resolution runs server-side.** `resolve` executes as a server function, so secrets (provider API keys) never reach the client and outbound requests are subject to the server's SSRF allowlist. The resolved, sanitized result is stored on the node's `attrs` and cached.
2. **Previews are sandboxed.** Provider HTML renders in a sandboxed `iframe` with a strict CSP. The editor stores only sanitized fields, never raw markup it would later inject into your page.

Pasting a matching URL auto-converts it to the embed via the `match` regex; non-matching URLs become plain `link`-marked text. This mirrors Sanity's approach of treating embeds as typed objects you render yourself, but KernelCMS handles the fetch-and-sanitize lifecycle for you rather than leaving it to a custom input component.

## Serialization to the schema model

The persisted value is JSON, versioned, and engine-agnostic. This is the contract your frontend, your migrations, and the three API surfaces all depend on.

```jsonc
{
  "schemaVersion": 1,
  "type": "doc",
  "content": [
    { "type": "heading", "attrs": { "level": 2 }, "content": [{ "type": "text", "text": "Hello" }] },
    { "type": "paragraph", "content": [{ "type": "text", "text": "world", "marks": [{ "type": "bold" }] }] },
    {
      "type": "block",
      "blockType": "callout",
      "fields": { "variant": "warning", "body": { "type": "doc", "content": [] } },
    },
  ],
}
```

The `serialize` module is the only place that touches both worlds:

| Function               | Direction          | Used by                   |
| ---------------------- | ------------------ | ------------------------- |
| `toModel(doc)`         | ProseMirror → JSON | autosave, drafts, save    |
| `toDoc(model, schema)` | JSON → ProseMirror | editor hydration          |
| `toHTML(model, opts)`  | JSON → HTML string | SSR / non-React frontends |
| `toPlainText(model)`   | JSON → string      | search indexing, excerpts |

`@kernel/richtext` exposes a typed React renderer for the common case, so frontends render the model without hand-writing serializers — the gap Sanity's Portable Text leaves to you:

```tsx
import { RichText, defaultComponents } from '@kernel/richtext/react'
;<RichText value={post.body} components={{ ...defaultComponents, callout: Callout, mediaEmbed: MediaEmbed }} />
```

`schemaVersion` is mandatory and enforced. When you change which nodes or blocks a field allows, KernelCMS detects the diff and generates a content migration alongside the database migration — the same diff-driven flow used for schema migrations. Renaming a block or dropping a mark is a tracked, reversible transform, not a silent data-corruption event. The plain-text projection feeds the search adapter so rich-text fields are full-text searchable without any extra indexing config.

Because the model is plain JSON, the shared query language reaches into it: `where` clauses can target `body.text` (the plain-text projection) for contains/like queries across REST, GraphQL, and the Local/RPC API uniformly.

## Open questions

- **Collaboration transport.** ProseMirror gives us correct position mapping, but choosing Yjs (CRDT) vs. authority-server OT for `@kernel/collab` is unresolved. CRDT eases offline/edge but complicates access-controlled merges.
- **Block schema evolution at scale.** Auto-generated content migrations cover renames and drops; complex field-shape changes inside deeply nested blocks may need an escape-hatch transform API rather than generated code.
- **Markdown shortcuts vs. paste fidelity.** Input rules (`##` → heading) are in; whether to ship a configurable Markdown _paste_ importer or keep paste strictly schema-sanitized is undecided.
