/**
 * The KernelRichText document model — a normalized, editor-agnostic tree that is
 * stable to store, safe to render anywhere, and the single source of truth for
 * every converter. See docs/specs/01-rich-text.md §4.
 *
 * Everything here is a plain serializable object with zero runtime dependencies.
 */

/** Inline marks applied to text runs. */
export type MarkType = 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'sub' | 'sup'
export interface Mark {
  type: MarkType
}

export interface TextNode {
  type: 'text'
  text: string
  marks?: Mark[]
}

export interface LinkNode {
  type: 'link'
  /** Sanitized scheme (http/https/mailto/tel) or '#'. */
  url: string
  newTab?: boolean
  rel?: string
  /** Internal links resolve to a document instead of a raw URL. */
  doc?: { relationTo: string; value: string }
  children: RichInlineNode[]
}

export interface RelationshipNode {
  type: 'relationship'
  relationTo: string
  value: string
}

export interface UploadNode {
  type: 'upload'
  relationTo: string
  value: string
  alt?: string
}

export type RichInlineNode = TextNode | LinkNode | RelationshipNode | UploadNode

export interface ParagraphNode {
  type: 'paragraph'
  children: RichInlineNode[]
}
export interface HeadingNode {
  type: 'heading'
  level: 2 | 3 | 4
  children: RichInlineNode[]
}
export interface QuoteNode {
  type: 'quote'
  children: RichBlockNode[]
}
export interface ListNode {
  type: 'list'
  ordered: boolean
  children: ListItemNode[]
}
export interface ListItemNode {
  type: 'listItem'
  children: RichBlockNode[]
}
export interface CodeBlockNode {
  type: 'codeBlock'
  language?: string
  code: string
}
export interface HorizontalRuleNode {
  type: 'hr'
}
/** Blocks-in-rich-text: reuses the page-builder BlockDef. `data` validates against the block schema. */
export interface BlockEmbedNode {
  type: 'block'
  blockType: string
  data: Record<string, unknown>
}

export type RichBlockNode =
  | ParagraphNode
  | HeadingNode
  | QuoteNode
  | ListNode
  | ListItemNode
  | CodeBlockNode
  | HorizontalRuleNode
  | UploadNode
  | BlockEmbedNode

export type RichNode = RichBlockNode | RichInlineNode

export interface KernelRichText {
  /** Model schema version. Bump only on breaking shape changes; migrate on read. */
  v: 1
  type: 'doc'
  children: RichBlockNode[]
}

/** An empty document is a single empty paragraph (normalization invariant §4). */
export function emptyRichText(): KernelRichText {
  return { v: 1, type: 'doc', children: [{ type: 'paragraph', children: [] }] }
}

/** True for a doc that holds no rendered content (used for `required`). */
export function isEmptyRichText(doc: KernelRichText): boolean {
  return toPlainTextLength(doc) === 0
}

function toPlainTextLength(doc: KernelRichText): number {
  let len = 0
  const walk = (nodes: RichNode[]): void => {
    for (const n of nodes) {
      if (n.type === 'text') len += n.text.trim().length
      else if (n.type === 'codeBlock') len += n.code.trim().length
      else if (n.type === 'hr' || n.type === 'upload' || n.type === 'block' || n.type === 'relationship') len += 1
      else if ('children' in n) walk(n.children)
      if (len > 0) return
    }
  }
  walk(doc.children)
  return len
}
