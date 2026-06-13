/**
 * Pure, deterministic converters from KernelRichText. No editor dependency, no
 * DOM. Text is always escaped; HTML is built from the typed model, so there is no
 * `dangerouslySetInnerHTML`-of-raw-CMS-HTML surface. See spec §8.
 *
 * Every switch is exhaustive with `assertNever`, so adding a node/mark type is a
 * compile error until handled here.
 */
import type { KernelRichText, LinkNode, Mark, RichBlockNode, RichInlineNode, TextNode } from './types'
import { safeHref } from './sanitize'

function assertNever(x: never): never {
  throw new Error(`Unhandled rich-text node: ${JSON.stringify(x)}`)
}

// ── toPlainText ───────────────────────────────────────────────────────────────

/** Flatten to text for search indexing, SEO descriptions, and previews. */
export function toPlainText(doc: KernelRichText): string {
  return doc.children
    .map(blockText)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function blockText(node: RichBlockNode): string {
  switch (node.type) {
    case 'paragraph':
    case 'heading':
      return node.children.map(inlineText).join('')
    case 'quote':
      return node.children.map(blockText).join('\n')
    case 'list':
      return node.children.map(blockText).join('\n')
    case 'listItem':
      return node.children.map(blockText).join('\n')
    case 'codeBlock':
      return node.code
    case 'hr':
      return ''
    case 'upload':
      return node.alt ?? ''
    case 'block':
      return ''
    default:
      return assertNever(node)
  }
}

function inlineText(node: RichInlineNode): string {
  switch (node.type) {
    case 'text':
      return node.text
    case 'link':
      return node.children.map(inlineText).join('')
    case 'relationship':
      return ''
    case 'upload':
      return node.alt ?? ''
    default:
      return assertNever(node)
  }
}

// ── toHTML ────────────────────────────────────────────────────────────────────

export interface ToHTMLOptions {
  /** Resolve an internal document link to an href. Defaults to `#`. */
  resolveHref?: (ref: { relationTo: string; value: string }) => string
  /** Render an upload node. Defaults to a semantic placeholder comment. */
  renderUpload?: (node: { relationTo: string; value: string; alt?: string }) => string
  /** Render an embedded block. Defaults to an empty string (host supplies real markup). */
  renderBlock?: (node: { blockType: string; data: Record<string, unknown> }) => string
  /** Render an inline relationship. Defaults to empty. */
  renderRelationship?: (node: { relationTo: string; value: string }) => string
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const MARK_TAGS: Record<Mark['type'], [open: string, close: string]> = {
  bold: ['<strong>', '</strong>'],
  italic: ['<em>', '</em>'],
  underline: ['<u>', '</u>'],
  strike: ['<s>', '</s>'],
  code: ['<code>', '</code>'],
  sub: ['<sub>', '</sub>'],
  sup: ['<sup>', '</sup>'],
}

export function toHTML(doc: KernelRichText, opts: ToHTMLOptions = {}): string {
  return doc.children.map((n) => blockHtml(n, opts)).join('')
}

function blockHtml(node: RichBlockNode, opts: ToHTMLOptions): string {
  switch (node.type) {
    case 'paragraph':
      return `<p>${inlineHtml(node.children, opts)}</p>`
    case 'heading':
      return `<h${node.level}>${inlineHtml(node.children, opts)}</h${node.level}>`
    case 'quote':
      return `<blockquote>${node.children.map((n) => blockHtml(n, opts)).join('')}</blockquote>`
    case 'list': {
      const tag = node.ordered ? 'ol' : 'ul'
      return `<${tag}>${node.children.map((n) => blockHtml(n, opts)).join('')}</${tag}>`
    }
    case 'listItem':
      return `<li>${node.children.map((n) => blockHtml(n, opts)).join('')}</li>`
    case 'codeBlock': {
      const cls = node.language ? ` class="language-${escapeHtml(node.language)}"` : ''
      return `<pre><code${cls}>${escapeHtml(node.code)}</code></pre>`
    }
    case 'hr':
      return '<hr/>'
    case 'upload':
      return opts.renderUpload?.(node) ?? `<!-- upload:${escapeHtml(node.relationTo)}:${escapeHtml(node.value)} -->`
    case 'block':
      return opts.renderBlock?.(node) ?? ''
    default:
      return assertNever(node)
  }
}

function inlineHtml(nodes: RichInlineNode[], opts: ToHTMLOptions): string {
  return nodes.map((n) => inlineNodeHtml(n, opts)).join('')
}

function inlineNodeHtml(node: RichInlineNode, opts: ToHTMLOptions): string {
  switch (node.type) {
    case 'text':
      return wrapMarks(node)
    case 'link':
      return linkHtml(node, opts)
    case 'relationship':
      return opts.renderRelationship?.(node) ?? ''
    case 'upload':
      return opts.renderUpload?.(node) ?? ''
    default:
      return assertNever(node)
  }
}

function wrapMarks(node: TextNode): string {
  let html = escapeHtml(node.text)
  // Marks are stored in canonical order; wrap inner→outer so output is stable.
  for (let i = (node.marks?.length ?? 0) - 1; i >= 0; i--) {
    const [open, close] = MARK_TAGS[node.marks![i]!.type]
    html = `${open}${html}${close}`
  }
  return html
}

function linkHtml(node: LinkNode, opts: ToHTMLOptions): string {
  const raw = node.doc ? (opts.resolveHref?.(node.doc) ?? '#') : (node.url ?? '#')
  const href = safeHref(String(raw))
  const attrs = [`href="${escapeHtml(href)}"`]
  if (node.newTab) attrs.push('target="_blank"', `rel="${escapeHtml(node.rel ?? 'noopener noreferrer')}"`)
  return `<a ${attrs.join(' ')}>${inlineHtml(node.children, opts)}</a>`
}

// ── toMarkdown ──────────────────────────────────────────────────────────────
//
// KernelRichText → clean CommonMark, the inverse of `fromMarkdown`. Mirrors
// `toHTML`'s node handling node-for-node (same exhaustive switch + assertNever),
// so a new node/mark type is a compile error until handled here too. Used by the
// AI-discoverability layer (llms-full.txt, geoDocument) where models ingest
// markdown. Pure + deterministic; no DOM, no editor dependency.

export interface ToMarkdownOptions {
  /** Resolve an internal document link to a URL. Defaults to `#`. */
  resolveHref?: (ref: { relationTo: string; value: string }) => string
}

/** Marks wrap inner→outer as `[open, close]`, mirroring `MARK_TAGS`. Underline,
 *  sub, and sup have no portable markdown form, so they pass through verbatim
 *  (the text is preserved; only the styling is dropped). */
const MARK_MD: Record<Mark['type'], [open: string, close: string]> = {
  bold: ['**', '**'],
  italic: ['_', '_'],
  strike: ['~~', '~~'],
  code: ['`', '`'],
  underline: ['', ''],
  sub: ['', ''],
  sup: ['', ''],
}

/** Escape the characters that would otherwise be parsed as markdown syntax in a
 *  text run. Conservative on purpose: only the structural metacharacters, so
 *  ordinary prose stays readable. */
function escapeMarkdown(s: string): string {
  return s.replace(/([\\`*_{}\[\]()#+\-!>])/g, '\\$1')
}

/** Escape link/image label text: only `[` and `]` can break the `[label]` span. */
function escapeMarkdownLabel(s: string): string {
  return s.replace(/([\\\[\]])/g, '\\$1')
}

/** Escape a URL placed inside `(...)`: parentheses and whitespace would break the
 *  `(url)` span. `encodeURIComponent` leaves `(` `)` untouched (they're unreserved),
 *  so percent-encode them explicitly. */
function escapeMarkdownUrl(s: string): string {
  return s.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\s/g, '%20')
}

export function toMarkdown(doc: KernelRichText, opts: ToMarkdownOptions = {}): string {
  return doc.children
    .map((n) => blockMd(n, opts))
    .filter((s) => s.length > 0)
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function blockMd(node: RichBlockNode, opts: ToMarkdownOptions): string {
  switch (node.type) {
    case 'paragraph':
      return inlineMd(node.children, opts)
    case 'heading':
      return `${'#'.repeat(node.level)} ${inlineMd(node.children, opts)}`
    case 'quote':
      return node.children
        .map((n) => blockMd(n, opts))
        .filter((s) => s.length > 0)
        .join('\n\n')
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')
    case 'list':
      return listMd(node, opts)
    case 'listItem':
      // A bare listItem (outside a list) renders as a single bullet line.
      return `- ${itemBody(node, opts)}`
    case 'codeBlock':
      return `\`\`\`${node.language ?? ''}\n${node.code}\n\`\`\``
    case 'hr':
      return '---'
    case 'upload':
      return node.alt ? `![${escapeMarkdownLabel(node.alt)}]()` : ''
    case 'block':
      return ''
    default:
      return assertNever(node)
  }
}

function listMd(node: { ordered: boolean; children: RichBlockNode[] }, opts: ToMarkdownOptions): string {
  return node.children
    .map((item, i) => {
      const marker = node.ordered ? `${i + 1}.` : '-'
      const body = item.type === 'listItem' ? itemBody(item, opts) : blockMd(item, opts)
      // Continuation lines (multi-block items) are indented to align under the marker.
      const indented = body.split('\n').join(`\n${' '.repeat(marker.length + 1)}`)
      return `${marker} ${indented}`
    })
    .join('\n')
}

/** Render a listItem's children to inline-ish markdown (paragraphs joined by blank
 *  lines, nested lists/blocks rendered then indented by the caller). */
function itemBody(node: { children: RichBlockNode[] }, opts: ToMarkdownOptions): string {
  return node.children
    .map((n) => blockMd(n, opts))
    .filter((s) => s.length > 0)
    .join('\n\n')
}

function inlineMd(nodes: RichInlineNode[], opts: ToMarkdownOptions): string {
  return nodes.map((n) => inlineNodeMd(n, opts)).join('')
}

function inlineNodeMd(node: RichInlineNode, opts: ToMarkdownOptions): string {
  switch (node.type) {
    case 'text':
      return wrapMarksMd(node)
    case 'link':
      return linkMd(node, opts)
    case 'relationship':
      return ''
    case 'upload':
      return node.alt ? `![${escapeMarkdownLabel(node.alt)}]()` : ''
    default:
      return assertNever(node)
  }
}

function wrapMarksMd(node: TextNode): string {
  // A code mark escapes nothing inside the backticks; other marks wrap escaped text.
  const isCode = node.marks?.some((m) => m.type === 'code') ?? false
  let md = isCode ? node.text : escapeMarkdown(node.text)
  for (let i = (node.marks?.length ?? 0) - 1; i >= 0; i--) {
    const [open, close] = MARK_MD[node.marks![i]!.type]
    md = `${open}${md}${close}`
  }
  return md
}

function linkMd(node: LinkNode, opts: ToMarkdownOptions): string {
  const raw = node.doc ? (opts.resolveHref?.(node.doc) ?? '#') : (node.url ?? '#')
  const href = safeHref(String(raw))
  const label = inlineMd(node.children, opts)
  return `[${label}](${escapeMarkdownUrl(href)})`
}
