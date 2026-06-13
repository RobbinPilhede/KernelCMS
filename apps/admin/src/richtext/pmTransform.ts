import { Fragment, Mark as PMMark, Node as PMNode, type Schema } from 'prosemirror-model'
import type { KernelRichText, Mark, RichBlockNode, RichInlineNode } from '@kernel/richtext'
import { KERNEL_MARK_TO_PM, PM_MARK_TO_KERNEL } from './pmSchema'

// The model boundary. kernelToPM / pmToKernel must round-trip every supported
// node and mark idempotently; the caller re-sanitizes after pmToKernel, so these
// stay structural — no allow-list logic here.

// ── KernelRichText → ProseMirror ──────────────────────────────────────────────

function inlineToPM(schema: Schema, node: RichInlineNode, parentMarks: readonly PMMark[]): PMNode[] {
  if (node.type === 'text') {
    if (!node.text) return []
    const marks = [...parentMarks, ...kernelMarksToPM(schema, node.marks)]
    return [schema.text(node.text, marks)]
  }
  if (node.type === 'link' && schema.marks.link) {
    // Internal links carry `doc`; href is a placeholder the renderer resolves.
    const attrs = { href: node.url, target: node.newTab ? '_blank' : null, doc: node.doc ?? null }
    const linkMark = schema.marks.link.create(attrs)
    const marks = [...parentMarks, linkMark]
    return node.children.flatMap((child) => inlineToPM(schema, child, marks))
  }
  // relationship/upload inline nodes have no PM counterpart in this schema; the
  // sanitizer would drop them anyway when their collections aren't enabled.
  return []
}

function kernelMarksToPM(schema: Schema, marks: Mark[] | undefined): PMMark[] {
  if (!marks) return []
  const out: PMMark[] = []
  for (const mark of marks) {
    const spec = schema.marks[KERNEL_MARK_TO_PM[mark.type]]
    if (spec) out.push(spec.create())
  }
  return out
}

function inlineFragment(schema: Schema, children: RichInlineNode[]): Fragment {
  return Fragment.fromArray(children.flatMap((child) => inlineToPM(schema, child, [])))
}

function blockToPM(schema: Schema, node: RichBlockNode): PMNode | null {
  switch (node.type) {
    case 'paragraph':
      return schema.nodes.paragraph.create(null, inlineFragment(schema, node.children))
    case 'heading': {
      const heading = schema.nodes.heading
      if (!heading) return paragraphFallback(schema, node.children)
      return heading.create({ level: node.level }, inlineFragment(schema, node.children))
    }
    case 'quote': {
      const blockquote = schema.nodes.blockquote
      if (!blockquote) return null
      const content = blocksToPM(schema, node.children)
      return blockquote.create(null, content.length ? content : [emptyParagraph(schema)])
    }
    case 'list': {
      const listType = node.ordered ? schema.nodes.ordered_list : schema.nodes.bullet_list
      const itemType = schema.nodes.list_item
      if (!listType || !itemType) return null
      const items = node.children
        .map((item) => listItemToPM(schema, item))
        .filter((item): item is PMNode => item !== null)
      if (!items.length) return null
      return listType.create(null, items)
    }
    case 'listItem':
      // Bare listItem outside a list is invalid; lift its blocks to the top level.
      return null
    case 'codeBlock': {
      const codeBlock = schema.nodes.code_block
      if (!codeBlock) return null
      return codeBlock.create(null, node.code ? schema.text(node.code) : undefined)
    }
    case 'hr': {
      const hr = schema.nodes.horizontal_rule
      return hr ? hr.create() : null
    }
    default:
      // upload / block embeds have no inline PM editing surface here.
      return null
  }
}

function listItemToPM(schema: Schema, item: { type: 'listItem'; children: RichBlockNode[] }): PMNode | null {
  const itemType = schema.nodes.list_item
  const blocks = blocksToPM(schema, item.children)
  // list_item content must lead with a paragraph (schema invariant).
  const content =
    blocks.length && blocks[0].type === schema.nodes.paragraph ? blocks : [emptyParagraph(schema), ...blocks]
  return itemType.create(null, content)
}

function blocksToPM(schema: Schema, nodes: RichBlockNode[]): PMNode[] {
  return nodes.map((node) => blockToPM(schema, node)).filter((node): node is PMNode => node !== null)
}

function paragraphFallback(schema: Schema, children: RichInlineNode[]): PMNode {
  return schema.nodes.paragraph.create(null, inlineFragment(schema, children))
}

function emptyParagraph(schema: Schema): PMNode {
  return schema.nodes.paragraph.create()
}

export function kernelToPM(doc: KernelRichText, schema: Schema): PMNode {
  const blocks = blocksToPM(schema, doc.children)
  return schema.nodes.doc.create(null, blocks.length ? blocks : [emptyParagraph(schema)])
}

// ── ProseMirror → KernelRichText ──────────────────────────────────────────────

function pmMarksToKernel(marks: readonly PMMark[]): Mark[] | undefined {
  const out: Mark[] = []
  for (const mark of marks) {
    if (mark.type.name === 'link') continue
    const type = PM_MARK_TO_KERNEL[mark.type.name]
    if (type) out.push({ type })
  }
  return out.length ? out : undefined
}

function pmInlineToKernel(node: PMNode): RichInlineNode[] {
  if (node.isText) {
    const text = node.text ?? ''
    if (!text) return []
    const link = node.marks.find((mark) => mark.type.name === 'link')
    const marks = pmMarksToKernel(node.marks)
    const textNode: RichInlineNode = marks ? { type: 'text', text, marks } : { type: 'text', text }
    if (link) {
      const newTab = link.attrs.target === '_blank'
      const url = (link.attrs.href as string) ?? '#'
      const doc = link.attrs.doc as { relationTo: string; value: string } | null
      if (doc) {
        // Internal link: preserve the doc ref; sanitizer rebuilds href/rel.
        return [
          newTab
            ? { type: 'link', doc, url, newTab, children: [textNode] }
            : { type: 'link', doc, url, children: [textNode] },
        ]
      }
      return [
        newTab
          ? { type: 'link', url, newTab, children: [textNode] }
          : { type: 'link', url, children: [textNode] },
      ]
    }
    return [textNode]
  }
  return []
}

function pmInlineChildren(node: PMNode): RichInlineNode[] {
  const out: RichInlineNode[] = []
  node.forEach((child) => out.push(...pmInlineToKernel(child)))
  return mergeAdjacentLinks(out)
}

type DocRef = { relationTo: string; value: string } | undefined

function sameDocRef(a: DocRef, b: DocRef): boolean {
  if (!a || !b) return !a && !b
  return a.relationTo === b.relationTo && a.value === b.value
}

// Sibling text runs that share an identical link collapse into one LinkNode, so
// "ab" split across two PM text leaves round-trips to a single stored link.
function mergeAdjacentLinks(nodes: RichInlineNode[]): RichInlineNode[] {
  const out: RichInlineNode[] = []
  for (const node of nodes) {
    const prev = out[out.length - 1]
    if (
      node.type === 'link' &&
      prev &&
      prev.type === 'link' &&
      prev.url === node.url &&
      Boolean(prev.newTab) === Boolean(node.newTab) &&
      sameDocRef(prev.doc, node.doc)
    ) {
      prev.children.push(...node.children)
      continue
    }
    out.push(node)
  }
  return out
}

function pmBlockToKernel(node: PMNode): RichBlockNode[] {
  switch (node.type.name) {
    case 'paragraph':
      return [{ type: 'paragraph', children: pmInlineChildren(node) }]
    case 'heading':
      return [{ type: 'heading', level: node.attrs.level as 2 | 3 | 4, children: pmInlineChildren(node) }]
    case 'blockquote':
      return [{ type: 'quote', children: pmBlocksToKernel(node) }]
    case 'bullet_list':
    case 'ordered_list': {
      const children = pmListItemsToKernel(node)
      return [{ type: 'list', ordered: node.type.name === 'ordered_list', children }]
    }
    case 'code_block':
      return [{ type: 'codeBlock', code: node.textContent }]
    case 'horizontal_rule':
      return [{ type: 'hr' }]
    default:
      return []
  }
}

function pmListItemsToKernel(list: PMNode): { type: 'listItem'; children: RichBlockNode[] }[] {
  const items: { type: 'listItem'; children: RichBlockNode[] }[] = []
  list.forEach((item) => {
    if (item.type.name === 'list_item') items.push({ type: 'listItem', children: pmBlocksToKernel(item) })
  })
  return items
}

function pmBlocksToKernel(node: PMNode): RichBlockNode[] {
  const out: RichBlockNode[] = []
  node.forEach((child) => out.push(...pmBlockToKernel(child)))
  return out
}

export function pmToKernel(pmDoc: PMNode): KernelRichText {
  return { v: 1, type: 'doc', children: pmBlocksToKernel(pmDoc) }
}
