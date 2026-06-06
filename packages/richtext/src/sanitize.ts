/**
 * Server-side sanitize + normalize for KernelRichText. Pure and total: never
 * throws, always returns a valid document. This is the security boundary — it
 * runs in `serializeDoc` before persisting and on every importer path, and must
 * be idempotent (sanitize(sanitize(x)) === sanitize(x)). See spec §7.
 */
import type { KernelRichText, LinkNode, Mark, MarkType, RichBlockNode, RichInlineNode, TextNode } from './types'
import { emptyRichText } from './types'
import type { ResolvedRichTextSchema } from './schema'

export interface SanitizeWarning {
  /** Machine-readable reason, e.g. 'dropped-node', 'unsafe-link', 'bad-id'. */
  code: string
  message: string
}

export interface SanitizeResult {
  doc: KernelRichText
  warnings: SanitizeWarning[]
}

const ID_RE = /^[A-Za-z0-9_-]+$/
const SAFE_SCHEME_RE = /^(https?:|mailto:|tel:)/i
// Canonical, stable mark order so equal mark sets serialize identically (diffable).
const MARK_ORDER: MarkType[] = ['bold', 'italic', 'underline', 'strike', 'code', 'sub', 'sup']

export function sanitizeRichText(input: unknown, schema: ResolvedRichTextSchema): SanitizeResult {
  const warnings: SanitizeWarning[] = []
  const warn = (code: string, message: string) => warnings.push({ code, message })

  const doc = input as Partial<KernelRichText> | null | undefined
  if (!doc || doc.type !== 'doc' || !Array.isArray(doc.children)) {
    // A non-document (or legacy string handled upstream) collapses to empty.
    if (doc !== undefined && doc !== null)
      warn('dropped-doc', 'Value was not a rich-text document; replaced with empty.')
    return { doc: emptyRichText(), warnings }
  }

  const children = sanitizeBlocks(doc.children as unknown[], schema, 0, warn)
  if (children.length === 0) children.push({ type: 'paragraph', children: [] })
  return { doc: { v: 1, type: 'doc', children }, warnings }
}

function sanitizeBlocks(
  raw: unknown[],
  schema: ResolvedRichTextSchema,
  depth: number,
  warn: (code: string, message: string) => void,
): RichBlockNode[] {
  const out: RichBlockNode[] = []
  for (const item of raw) {
    const node = sanitizeBlock(item, schema, depth, warn)
    if (node) out.push(node)
  }
  return out
}

function sanitizeBlock(
  item: unknown,
  schema: ResolvedRichTextSchema,
  depth: number,
  warn: (code: string, message: string) => void,
): RichBlockNode | null {
  if (!item || typeof item !== 'object') return null
  const n = item as Record<string, unknown>
  const type = n.type as string

  // 'paragraph' is always allowed; everything else must be in the resolved schema.
  if (type !== 'paragraph' && !schema.nodes.has(type as RichBlockNode['type'])) {
    warn('dropped-node', `Node type "${type}" is not allowed by this field.`)
    return null
  }

  switch (type) {
    case 'paragraph': {
      const children = sanitizeInline(n.children, schema, warn)
      return { type: 'paragraph', children }
    }
    case 'heading': {
      const level = n.level as number
      if (!schema.headingLevels.has(level as 2 | 3 | 4)) {
        warn('dropped-node', `Heading level ${level} is not allowed; converted to paragraph.`)
        return { type: 'paragraph', children: sanitizeInline(n.children, schema, warn) }
      }
      return { type: 'heading', level: level as 2 | 3 | 4, children: sanitizeInline(n.children, schema, warn) }
    }
    case 'quote': {
      if (depth >= schema.maxDepth) {
        warn('depth-cap', 'Max nesting depth reached; quote contents flattened.')
        return { type: 'paragraph', children: [] }
      }
      const children = sanitizeBlocks((n.children as unknown[]) ?? [], schema, depth + 1, warn)
      return { type: 'quote', children: children.length ? children : [{ type: 'paragraph', children: [] }] }
    }
    case 'list': {
      const ordered = Boolean(n.ordered)
      if ((ordered && !schema.lists.ordered) || (!ordered && !schema.lists.unordered)) {
        warn('dropped-node', `${ordered ? 'Ordered' : 'Unordered'} lists are not allowed.`)
        return null
      }
      if (depth >= schema.maxDepth) {
        warn('depth-cap', 'Max nesting depth reached; list dropped.')
        return null
      }
      const items: RichBlockNode[] = []
      for (const li of (n.children as unknown[]) ?? []) {
        if (!li || typeof li !== 'object' || (li as Record<string, unknown>).type !== 'listItem') continue
        const liChildren = sanitizeBlocks(
          ((li as Record<string, unknown>).children as unknown[]) ?? [],
          schema,
          depth + 1,
          warn,
        )
        items.push({
          type: 'listItem',
          children: liChildren.length ? liChildren : [{ type: 'paragraph', children: [] }],
        })
      }
      if (items.length === 0) return null
      return { type: 'list', ordered, children: items as never }
    }
    case 'codeBlock': {
      const code = typeof n.code === 'string' ? n.code : ''
      let language = typeof n.language === 'string' ? n.language : undefined
      if (language && schema.codeLanguages && !schema.codeLanguages.has(language)) {
        warn('dropped-language', `Code language "${language}" is not allowed; dropped.`)
        language = undefined
      }
      return language ? { type: 'codeBlock', language, code } : { type: 'codeBlock', code }
    }
    case 'hr':
      return { type: 'hr' }
    case 'upload': {
      const ref = sanitizeRef(n, schema.uploadCollections, warn)
      if (!ref) return null
      const alt = typeof n.alt === 'string' ? n.alt : undefined
      return alt !== undefined
        ? { type: 'upload', relationTo: ref.relationTo, value: ref.value, alt }
        : { type: 'upload', relationTo: ref.relationTo, value: ref.value }
    }
    case 'block': {
      const blockType = n.blockType as string
      if (!blockType || !schema.blockSlugs.has(blockType)) {
        warn('dropped-node', `Embedded block "${blockType}" is not allowed.`)
        return null
      }
      const data = n.data && typeof n.data === 'object' ? (n.data as Record<string, unknown>) : {}
      return { type: 'block', blockType, data }
    }
    default:
      warn('dropped-node', `Unknown node type "${type}".`)
      return null
  }
}

function sanitizeRef(
  n: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  warn: (code: string, message: string) => void,
): { relationTo: string; value: string } | null {
  const relationTo = n.relationTo as string
  const value = n.value as string
  if (typeof relationTo !== 'string' || !allowed.has(relationTo)) {
    warn('dropped-node', `Reference to collection "${relationTo}" is not allowed.`)
    return null
  }
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    warn('bad-id', `Reference id "${String(value)}" is malformed.`)
    return null
  }
  return { relationTo, value }
}

function sanitizeInline(
  raw: unknown,
  schema: ResolvedRichTextSchema,
  warn: (code: string, message: string) => void,
): RichInlineNode[] {
  if (!Array.isArray(raw)) return []
  const out: RichInlineNode[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const n = item as Record<string, unknown>
    if (n.type === 'text') {
      const text = typeof n.text === 'string' ? n.text : ''
      if (text.length === 0) continue
      const marks = sanitizeMarks(n.marks, schema, warn)
      out.push(marks.length ? { type: 'text', text, marks } : { type: 'text', text })
    } else if (n.type === 'link') {
      const link = sanitizeLink(n, schema, warn)
      if (link) out.push(link)
    } else if (n.type === 'relationship') {
      const ref = sanitizeRef(n, schema.relationshipCollections, warn)
      if (ref) out.push({ type: 'relationship', relationTo: ref.relationTo, value: ref.value })
    } else if (n.type === 'upload') {
      const ref = sanitizeRef(n, schema.uploadCollections, warn)
      if (ref) {
        const alt = typeof n.alt === 'string' ? n.alt : undefined
        out.push(
          alt !== undefined
            ? { type: 'upload', relationTo: ref.relationTo, value: ref.value, alt }
            : { type: 'upload', relationTo: ref.relationTo, value: ref.value },
        )
      }
    } else {
      warn('dropped-node', `Inline node "${String(n.type)}" is not allowed.`)
    }
  }
  return mergeText(out)
}

function sanitizeMarks(
  raw: unknown,
  schema: ResolvedRichTextSchema,
  warn: (code: string, message: string) => void,
): Mark[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<MarkType>()
  for (const m of raw) {
    const t = (m as Record<string, unknown> | null)?.type as MarkType | undefined
    if (!t) continue
    if (!schema.marks.has(t)) {
      warn('dropped-mark', `Mark "${t}" is not allowed.`)
      continue
    }
    seen.add(t)
  }
  return MARK_ORDER.filter((t) => seen.has(t)).map((type) => ({ type }))
}

function sanitizeLink(
  n: Record<string, unknown>,
  schema: ResolvedRichTextSchema,
  warn: (code: string, message: string) => void,
): LinkNode | null {
  if (!schema.link.enabled) {
    warn('dropped-node', 'Links are not allowed by this field.')
    return null
  }
  const children = sanitizeInline(n.children, schema, warn)
  if (children.length === 0) return null

  const link: LinkNode = { type: 'link', url: '#', children }

  // Internal document link takes precedence and is validated against the allow-list.
  const docRef = n.doc as Record<string, unknown> | undefined
  if (docRef && typeof docRef === 'object') {
    const relationTo = docRef.relationTo as string
    const value = docRef.value as string
    if (schema.link.internalCollections.has(relationTo) && typeof value === 'string' && ID_RE.test(value)) {
      link.doc = { relationTo, value }
    } else {
      warn('unsafe-link', `Internal link to "${String(relationTo)}" is not allowed.`)
    }
  }

  if (!link.doc) {
    const url = typeof n.url === 'string' ? n.url.trim() : ''
    // Relative/anchor links are safe; absolute links must use an allow-listed scheme.
    const isAbsolute = /^[a-z][a-z0-9+.-]*:/i.test(url)
    if (url && (!isAbsolute || SAFE_SCHEME_RE.test(url))) {
      link.url = url
    } else if (url) {
      warn('unsafe-link', `Link scheme in "${url}" is not allowed; replaced with "#".`)
    }
  }

  if (schema.link.allowNewTab && n.newTab === true) {
    link.newTab = true
    link.rel = 'noopener noreferrer'
  }
  return link
}

/** Merge adjacent text nodes that carry identical mark sets (normalization §4). */
function mergeText(nodes: RichInlineNode[]): RichInlineNode[] {
  const out: RichInlineNode[] = []
  for (const node of nodes) {
    const prev = out[out.length - 1]
    if (node.type === 'text' && prev && prev.type === 'text' && sameMarks(prev.marks, node.marks)) {
      prev.text += node.text
    } else {
      out.push(node)
    }
  }
  return out
}

function sameMarks(a: Mark[] | undefined, b: Mark[] | undefined): boolean {
  const x = a ?? []
  const y = b ?? []
  if (x.length !== y.length) return false
  return x.every((m, i) => m.type === y[i]!.type)
}

/** Convenience used by `isEmptyRichText` callers and validation. */
export function textNode(text: string, marks?: MarkType[]): TextNode {
  return marks && marks.length ? { type: 'text', text, marks: marks.map((type) => ({ type })) } : { type: 'text', text }
}
