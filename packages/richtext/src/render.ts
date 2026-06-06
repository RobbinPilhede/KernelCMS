/**
 * Framework-agnostic renderer for KernelRichText. The host injects a
 * `createElement` (React.createElement, Preact's h, etc.) so this file stays
 * zero-dependency and unit-testable with a fake factory. `toReact` is a thin
 * wrapper consumers call with React's createElement. See spec §8.
 */
import type { KernelRichText, LinkNode, Mark, RichBlockNode, RichInlineNode, TextNode } from './types'
import { safeHref } from './sanitize'

/** Minimal createElement signature (compatible with React.createElement). */
export type CreateElement<E> = (type: string, props: Record<string, unknown> | null, ...children: (E | string)[]) => E

export interface RenderResolvers<E> {
  /** Render an embedded block with the host's real component. */
  block?: (node: { blockType: string; data: Record<string, unknown> }) => E | null
  /** Render an upload (image) node. */
  upload?: (node: { relationTo: string; value: string; alt?: string }) => E | null
  /** Render an inline relationship node. */
  relationship?: (node: { relationTo: string; value: string }) => E | null
  /** Resolve an internal document link to an href. */
  resolveHref?: (ref: { relationTo: string; value: string }) => string
}

export interface RenderOptions<E> {
  createElement: CreateElement<E>
  resolvers?: RenderResolvers<E>
}

const MARK_TAG: Record<Mark['type'], string> = {
  bold: 'strong',
  italic: 'em',
  underline: 'u',
  strike: 's',
  code: 'code',
  sub: 'sub',
  sup: 'sup',
}

let keySeq = 0

/** Render a document to an array of host elements. */
export function renderNodes<E>(doc: KernelRichText, opts: RenderOptions<E>): E[] {
  keySeq = 0
  return doc.children.map((n) => renderBlock(n, opts)).filter((n): n is E => n !== null)
}

/** React-flavored convenience: `toReact(doc, { createElement: React.createElement, resolvers })`. */
export function toReact<E>(doc: KernelRichText, opts: RenderOptions<E>): E[] {
  return renderNodes(doc, opts)
}

function k(): string {
  return `rt-${keySeq++}`
}

function renderBlock<E>(node: RichBlockNode, opts: RenderOptions<E>): E | null {
  const h = opts.createElement
  switch (node.type) {
    case 'paragraph':
      return h('p', { key: k() }, ...renderInline(node.children, opts))
    case 'heading':
      return h(`h${node.level}`, { key: k() }, ...renderInline(node.children, opts))
    case 'quote':
      return h('blockquote', { key: k() }, ...node.children.map((n) => renderBlock(n, opts)).filter(notNull))
    case 'list':
      return h(
        node.ordered ? 'ol' : 'ul',
        { key: k() },
        ...node.children.map((n) => renderBlock(n, opts)).filter(notNull),
      )
    case 'listItem':
      return h('li', { key: k() }, ...node.children.map((n) => renderBlock(n, opts)).filter(notNull))
    case 'codeBlock':
      return h(
        'pre',
        { key: k() },
        h('code', node.language ? { className: `language-${node.language}` } : null, node.code),
      )
    case 'hr':
      return h('hr', { key: k() })
    case 'upload':
      return opts.resolvers?.upload?.(node) ?? null
    case 'block':
      return opts.resolvers?.block?.(node) ?? null
    default:
      return assertNever(node)
  }
}

function renderInline<E>(nodes: RichInlineNode[], opts: RenderOptions<E>): (E | string)[] {
  return nodes.map((n) => renderInlineNode(n, opts)).filter((n): n is E | string => n !== null)
}

function renderInlineNode<E>(node: RichInlineNode, opts: RenderOptions<E>): E | string | null {
  const h = opts.createElement
  switch (node.type) {
    case 'text':
      return renderText(node, h)
    case 'link': {
      const rawHref = node.doc ? (opts.resolvers?.resolveHref?.(node.doc) ?? '#') : (node.url ?? '#')
      const href = safeHref(String(rawHref))
      const props: Record<string, unknown> = { key: k(), href }
      if (node.newTab) {
        props.target = '_blank'
        props.rel = node.rel ?? 'noopener noreferrer'
      }
      return h('a', props, ...renderInline((node as LinkNode).children, opts))
    }
    case 'relationship':
      return opts.resolvers?.relationship?.(node) ?? null
    case 'upload':
      return opts.resolvers?.upload?.(node) ?? null
    default:
      return assertNever(node)
  }
}

function renderText<E>(node: TextNode, h: CreateElement<E>): E | string {
  if (!node.marks || node.marks.length === 0) return node.text
  // Wrap inner→outer so the canonical mark order produces stable nesting.
  let el: E | string = node.text
  for (let i = node.marks.length - 1; i >= 0; i--) {
    el = h(MARK_TAG[node.marks[i]!.type], { key: k() }, el)
  }
  return el
}

function notNull<T>(v: T | null): v is T {
  return v !== null
}

function assertNever(x: never): never {
  throw new Error(`Unhandled rich-text node: ${JSON.stringify(x)}`)
}
