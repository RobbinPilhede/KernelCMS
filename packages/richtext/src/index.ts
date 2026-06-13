/** @kernel/richtext — editor-agnostic document model, schema, sanitizer, and converters. */
export type {
  KernelRichText,
  RichNode,
  RichBlockNode,
  RichInlineNode,
  ParagraphNode,
  HeadingNode,
  QuoteNode,
  ListNode,
  ListItemNode,
  CodeBlockNode,
  HorizontalRuleNode,
  UploadNode,
  BlockEmbedNode,
  TextNode,
  LinkNode,
  RelationshipNode,
  Mark,
  MarkType,
} from './types'
export { emptyRichText, isEmptyRichText } from './types'

export type { RichTextFeature, RichTextPreset, ResolvedRichTextSchema, ResolveOptions, HeadingLevel } from './schema'
export { resolveRichTextSchema, presetFeatures } from './schema'

export type { SanitizeResult, SanitizeWarning } from './sanitize'
export { sanitizeRichText, textNode, safeHref } from './sanitize'

export type { ToHTMLOptions, ToMarkdownOptions } from './convert'
export { toPlainText, toHTML, toMarkdown, escapeHtml } from './convert'

export type { CreateElement, RenderResolvers, RenderOptions } from './render'
export { renderNodes, toReact } from './render'

export type { ImportOptions } from './import'
export { fromMarkdown, fromHTML } from './import'
