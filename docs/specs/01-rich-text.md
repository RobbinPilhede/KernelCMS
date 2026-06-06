# Spec 01 — Rich Text (`richText` field)

Status: Draft · Owner: core · Track: C (Content Modeling) · Priority: P0 · Effort: XL
Depends on: field pipeline (`@kernel/core/fields`), describe/codegen, admin field renderer.
Supersedes: the current textarea stand-in for `type: 'richText'`.

---

## 1. Context & problem

`richText` today persists a raw string and renders a `<textarea>`. That is the
single largest credibility gap versus Payload, whose Lexical editor supports
headings, lists, links, inline marks, embedded uploads/relationships, and
**blocks inside rich text**, plus converters to HTML/JSX/Markdown.

We will not ship a textarea-with-a-toolbar. We will ship a **structured document
model** that is (a) editor-library-agnostic at the storage layer, (b) safe to
render on any frontend, and (c) extensible via the same block definitions used by
the page builder. The editor implementation is an admin concern; the **document
model and converters are engine concerns** and are the contract everything else
depends on.

## 2. Goals / Non-goals

**Goals**

- A versioned, normalized, JSON document model (`KernelRichText`) that is stable,
  diffable, and decoupled from any editor library.
- A feature/extension system so a `richText` field declares exactly which nodes,
  marks, and embedded blocks it allows — security and UX flow from that allow-list.
- First-class **embedded blocks** (reuse `BlockDef`) and **inline relationships/
  uploads** as typed nodes, populated through the normal operation pipeline.
- Deterministic converters: `toHTML`, `toPlainText`, `toReact` (frontend), and
  importers `fromHTML`, `fromMarkdown` for pasting/migration.
- Server-side validation + sanitization that never trusts client HTML.
- Accessibility (AA), keyboard-first authoring, paste hygiene, and large-document
  performance.

**Non-goals (v1)**

- Real-time multiplayer co-editing (CRDT). We design the model to _not preclude_ it
  (see §13) but ship single-writer with document locking (Spec: admin doc-locking).
- A bespoke editor engine. We wrap a proven editor core and own the data model +
  converters around it.

## 3. Architecture decision: editor core

We separate **model** (engine, permanent) from **editor** (admin, replaceable).

- **Model & converters:** owned by `@kernel/core` (and a tiny `@kernel/richtext`
  package for shared, dependency-free node/mark types + converters usable by both
  the admin and customer frontends). Zero runtime deps; pure functions.
- **Editor core (admin only):** wrap **ProseMirror** (recommended) behind an
  adapter. Rationale:
  - ProseMirror has an explicit, schema-driven document model that maps cleanly to
    our `KernelRichText` (nodes/marks), strong selection/transaction primitives,
    and battle-tested paste handling — minimizing the "translation tax" between
    editor state and our stored model.
  - Trade-off vs Lexical: Lexical is lighter and React-friendly but its node model
    is less directly serializable to a stable external schema; we'd own more glue.
  - Trade-off vs Slate: Slate's model is JSON-native (attractive) but historically
    weaker on input-method/paste edge cases and large-doc perf.
  - **Decision:** ProseMirror core + a thin React binding in `@kernel/admin-app`,
    with an `EditorAdapter` interface so the core can be swapped without touching
    the field API, the model, or converters.

The editor adapter boundary:

```ts
interface EditorAdapter {
  mount(el: HTMLElement, opts: EditorMountOptions): EditorHandle
}
interface EditorMountOptions {
  schema: ResolvedRichTextSchema // from the field's features (§5)
  value: KernelRichText // initial doc
  readOnly?: boolean
  onChange(doc: KernelRichText): void // debounced, normalized
  resolvers: NodeResolvers // fetch labels for relationship/upload nodes
}
interface EditorHandle {
  focus(): void
  destroy(): void
  getDoc(): KernelRichText
}
```

## 4. The document model — `KernelRichText`

A normalized tree. The root is a document; children are block nodes; block nodes
contain block or inline nodes; inline text carries marks. Everything is a plain
serializable object. **`v` is the schema version** for forward migration.

```ts
export interface KernelRichText {
  /** Model schema version. Bump only on breaking shape changes; migrate on read. */
  v: 1
  type: 'doc'
  children: RichBlockNode[]
}

type RichBlockNode =
  | ParagraphNode
  | HeadingNode
  | ListNode
  | ListItemNode
  | QuoteNode
  | CodeBlockNode
  | HorizontalRuleNode
  | UploadNode
  | BlockEmbedNode // void / atom blocks
type RichInlineNode = TextNode | LinkNode | RelationshipNode

interface BaseNode {
  type: string /* node-specific props below */
}

interface ParagraphNode {
  type: 'paragraph'
  children: RichInlineNode[]
}
interface HeadingNode {
  type: 'heading'
  level: 2 | 3 | 4
  children: RichInlineNode[]
}
interface QuoteNode {
  type: 'quote'
  children: RichBlockNode[]
}
interface ListNode {
  type: 'list'
  ordered: boolean
  children: ListItemNode[]
}
interface ListItemNode {
  type: 'listItem'
  children: RichBlockNode[]
}
interface CodeBlockNode {
  type: 'codeBlock'
  language?: string
  code: string
}
interface HorizontalRuleNode {
  type: 'hr'
}

interface TextNode {
  type: 'text'
  text: string
  marks?: Mark[]
}
type Mark =
  | { type: 'bold' }
  | { type: 'italic' }
  | { type: 'underline' }
  | { type: 'strike' }
  | { type: 'code' }
  | { type: 'sub' }
  | { type: 'sup' }

interface LinkNode {
  type: 'link'
  url: string // sanitized scheme (http/https/mailto/tel only)
  newTab?: boolean
  rel?: string
  /** Internal links resolve to a document instead of a raw URL. */
  doc?: { relationTo: string; value: string }
  children: RichInlineNode[] // link text (inline only)
}

interface RelationshipNode {
  type: 'relationship'
  relationTo: string
  value: string
}
interface UploadNode {
  type: 'upload'
  relationTo: string
  value: string
  alt?: string
  caption?: KernelRichText | undefined
}

/** Blocks-in-rich-text: reuses BlockDef. `data` validates against the block schema. */
interface BlockEmbedNode {
  type: 'block'
  blockType: string
  data: Record<string, unknown>
}
```

**Normalization invariants** (enforced on write, see §7):

- No empty text nodes; adjacent text nodes with identical marks are merged.
- Marks are deduped and stored in a stable, canonical order.
- A `doc` always has ≥1 block child (empty doc = single empty paragraph).
- Void nodes (`hr`, `upload`, `block`) carry no `children`.
- `link`/`relationship`/`upload` `value`s are sanitized ids (`[A-Za-z0-9_-]`).
- Unknown node/mark types are dropped (not errored) during sanitize, with a
  structured warning — resilient to schema drift and malicious payloads.

**Why a custom model (not store ProseMirror/Lexical JSON):** storage must outlive
the editor choice, be safe to render anywhere, diff cleanly for version history
(Spec 02), and be the converter source of truth. Editor-native JSON couples all of
that to a library.

## 5. Config / feature system (the field API)

The field declares an allow-list of **features**. Features are the unit of
capability, validation, and security — if a feature isn't enabled, its nodes/marks
are stripped on input and rejected on save.

```ts
export interface RichTextField extends FieldBase {
  type: 'richText'
  /** Ordered feature set. Omit for the sensible default preset. */
  features?: RichTextFeature[]
  /** Convenience presets: 'minimal' | 'standard' | 'full'. */
  preset?: RichTextPreset
  admin?: FieldAdmin & { rows?: number /* min editor height */ }
}

type RichTextFeature =
  | { kind: 'marks'; allow: Mark['type'][] }
  | { kind: 'headings'; levels: (2 | 3 | 4)[] }
  | { kind: 'lists'; ordered?: boolean; unordered?: boolean }
  | { kind: 'quote' }
  | { kind: 'codeBlock'; languages?: string[] }
  | { kind: 'hr' }
  | { kind: 'link'; internal?: { collections: string[] }; allowNewTab?: boolean }
  | { kind: 'relationship'; collections: string[] }
  | { kind: 'upload'; collections: string[]; captions?: boolean }
  | { kind: 'blocks'; blocks: BlockDef[] } // embedded page-builder blocks
```

`preset: 'standard'` ≈ marks(bold/italic/link/code), headings(2,3), lists,
quote, hr. `'full'` adds codeBlock, upload, relationship, blocks. Presets compile
to explicit feature lists so `/_config` is always concrete.

`resolveSchema(field) -> ResolvedRichTextSchema` flattens features into: allowed
node types, allowed marks, link scheme rules, allowed embedded block slugs, and
the relationship/upload target collections. This single resolved object drives the
editor schema, the sanitizer, and validation — one source of truth.

## 6. Engine integration

| Concern                    | Behavior                                                                                                                                                                                                                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storageTypeForField`      | `'json'` (already routed for `richText`). Stored as the `KernelRichText` object.                                                                                                                                                                                                   |
| `validateFieldType`        | value must be a `KernelRichText` (`type==='doc'`, `v===1`, `children` array). `required` ⇒ non-empty (more than a single empty paragraph).                                                                                                                                         |
| `validateFields` (recurse) | walk the tree; for each `block` node, look up its `BlockDef` from the field's `blocks` feature and run `validateFields(def.fields, node.data, …)` with path `${path}.<index>` so nested-required errors surface (`body.2.heading`). Reject nodes/marks not in the resolved schema. |
| `serializeDoc`             | run **sanitize+normalize** (§7) before persisting. Localized rich text stores a per-locale `KernelRichText`.                                                                                                                                                                       |
| `deserializeDoc`           | return the stored object as-is (resolve locale).                                                                                                                                                                                                                                   |
| `populate`                 | with `depth>0`, replace `relationship`/`upload` `value` with the populated doc (bounded by depth, cycle-safe via the existing `safeFindByID`). Embedded `block` relationship sub-fields populate through the normal field walk.                                                    |
| `describe` (`/_config`)    | emit the resolved schema: `{ features, marks, nodes, blocks: AdminBlock[], link, upload, relationship }` so the admin builds the right editor without hardcoding.                                                                                                                  |
| codegen                    | generate a precise TS type per field from its features (e.g. a union of allowed node types), exported alongside the collection interface.                                                                                                                                          |

**Access control inside rich text:** embedded `block` data is subject to
field-level access via the existing `applyFieldAccess` walk extended to traverse
rich-text block nodes (write-side now, read-side with Spec for read access).

## 7. Sanitization & normalization (security-critical)

A pure function `sanitizeRichText(doc, schema): { doc, warnings }` runs **on the
server** in `serializeDoc` and is also exposed for importers. Rules:

- Drop any node/mark whose type isn't in `schema`. Drop void-node children.
- **Links:** reject schemes outside `http|https|mailto|tel`; coerce to `#` and warn.
  Internal `doc` links validated against allowed collections + id shape.
- **Ids** (`relationship`/`upload`/internal link): must match `^[A-Za-z0-9_-]+$`.
- **Code blocks:** `language` must be in the allow-list or dropped.
- Enforce the normalization invariants (§4): merge/trim text, canonical mark order,
  ≥1 block, depth caps (configurable max nesting, default 6) to bound payloads.
- Never run an HTML parser on stored content at render time — we render from the
  typed model, eliminating the XSS surface that `dangerouslySetInnerHTML` of raw
  CMS HTML creates.

`fromHTML(html, schema)` (paste/import) uses a tolerant parser → maps to model →
runs the same sanitizer. Unknown tags become paragraphs/plain text; disallowed
attributes are dropped.

## 8. Converters (`@kernel/richtext`)

Pure, dependency-free, deterministic, tree-shakeable:

- `toPlainText(doc): string` — for search indexing, previews, SEO descriptions.
- `toHTML(doc, opts): string` — SSR/email; escapes text; resolves internal links
  via a provided `resolveHref`. No editor dependency.
- `toReact(doc, { renderers }): ReactNode` — the frontend renderer; consumers
  override node/mark/block renderers (e.g., render a `block` with their real
  component, an `upload` with `<Image>`). Default renderers provided.
- `fromHTML`, `fromMarkdown` — import paths; route through sanitize.
- All converters are exhaustively switched over node/mark types with a
  `default: assertNever` so adding a node type is a compile error until handled.

Frontend usage example:

```tsx
import { toReact } from '@kernel/richtext'
;<>
  {toReact(page.body, {
    renderers: {
      block: ({ blockType, data }) => <Section type={blockType} {...data} />,
      upload: ({ value }) => <Img id={value} />,
      link: ({ url, doc, children }) => <Link href={doc ? hrefFor(doc) : url}>{children}</Link>,
    },
  })}
</>
```

## 9. Admin editor UX

- **Surface:** inline editor in the field (min `rows` height, grows), not a modal.
- **Formatting:** floating selection toolbar (marks, link, turn-into) + a slash
  menu (`/`) for block insertions (heading, list, quote, code, hr, upload,
  relationship, embedded block). Markdown input rules (`## `, `- `, `> `, ``` ).
- **Embedded blocks:** insert via slash/“Add block”; render the block's nested
  fields in a contained card using the existing `NestedFields`; same validation +
  error surfacing (banner names `body › #2 › heading`).
- **Links:** popover to set URL or pick an internal document (relationship picker),
  new-tab toggle.
- **Uploads/relationships:** open the media/relationship picker (Spec 03 / existing).
- **Keyboard-first:** every action has a shortcut; `:focus-visible` rings; ESC
  closes menus; full screen-reader labeling. Respect `prefers-reduced-motion`.
- **States:** read-only mode (locked docs/no-access), loading skeleton, paste
  cleanup feedback, and a character/word count.
- **Performance:** virtualize/segment very large docs; debounce `onChange`
  (≤120ms) and normalize off the keystroke path.

## 10. API behavior

- **REST/Local:** rich-text fields are JSON in/out. Create/update validate +
  sanitize server-side; `depth` controls relationship/upload population inside the
  doc. `select`/projection (future) can request `toPlainText` excerpts.
- **GraphQL (future):** expose the JSON plus a `*_html` resolver via `toHTML`.

## 11. Performance budgets

- Editor mount < 50ms for a 5k-word doc; keystroke→render < 16ms (one frame).
- Sanitize+normalize of a 5k-word doc < 5ms server-side.
- `toReact`/`toHTML` of a 5k-word doc < 8ms.
- Stored payload bounded by depth cap + node count cap (configurable; warn→reject).

## 12. Accessibility (AA)

- Editor is a labeled `textbox` with `aria-multiline`; toolbar buttons have names +
  pressed state; slash menu is an `aria-activedescendant` listbox; link popover is a
  focus-trapped dialog. Contrast ≥4.5. Reduced-motion honored.

## 13. Migration & forward-compat

- Existing `richText` values are plain strings. On read, a shim wraps a string as
  `{ v:1, type:'doc', children:[paragraph(text)] }`; on next save it persists the
  model. A CLI `kernel migrate:richtext <collection.field>` bulk-converts.
- `v` enables future breaking changes via `migrateRichText(doc): KernelRichText`
  run on read; converters always operate on the latest `v`.
- Multiplayer-ready: the normalized tree + transaction model don't preclude a later
  CRDT/OT layer; selection/identity are editor-local in v1.

## 14. Testing strategy

- **Model/converters (unit, exhaustive):** round-trip `model → HTML → model`
  stability; `toPlainText`/`toReact` snapshots; `assertNever` coverage proves every
  node/mark is handled.
- **Sanitizer (security):** javascript:/data: link rejection, disallowed
  node/mark stripping, id-shape enforcement, depth-cap enforcement, malicious paste
  fixtures; property-based fuzzing that sanitize is idempotent and total.
- **Engine:** validation of embedded-block required fields with correct nested
  paths; population at depth; localized rich text per-locale; field access on
  embedded block data.
- **Editor (integration):** input rules, paste cleanup, slash/link flows, read-only,
  keyboard/a11y; large-doc perf benchmark gate.
- Coverage gate 80/70; security tests are required, not optional.

## 15. Rollout / phasing

1. `@kernel/richtext` model + sanitize + `toPlainText`/`toHTML`/`toReact` + tests.
2. Engine integration (validate/serialize/populate/describe/codegen) + string shim.
3. Admin editor: marks/headings/lists/quote/hr/link + slash menu + input rules.
4. Embedded uploads/relationships (after Spec 03 media) + internal links.
5. Embedded **blocks-in-rich-text** (reuse BlockDef) — the differentiator.
6. Importers (`fromHTML`/`fromMarkdown`) + bulk migration CLI.

## 16. Acceptance criteria

- [ ] A `richText` field with `preset:'standard'` edits, saves, reloads losslessly.
- [ ] Disallowed nodes/marks/link-schemes are stripped server-side; verified by tests.
- [ ] Embedded block with a missing required field fails save with path
      `field › #n › subfield` shown in the editor.
- [ ] `depth=1` populates an embedded `upload`/`relationship` inside the doc.
- [ ] `toReact` renders the doc 1:1 with consumer-provided block/upload renderers.
- [ ] Legacy string values render and upgrade to the model on next save.
- [ ] AA a11y pass; large-doc perf within budgets; ✦ no-AI-feel craft review passed.

## 17. Open questions

- Ship our own ProseMirror binding vs. evaluate Lexical for bundle size? (Spike, 2 days.)
- Caption model for uploads: nested `KernelRichText` vs plain text in v1? (Lean plain text v1.)
- Do we expose a stable `marks` extension point for custom marks in v1 or v2? (v2.)
