import { Schema, type MarkSpec, type NodeSpec } from 'prosemirror-model'
import { safeHref, type MarkType, type ResolvedRichTextSchema } from '@kernel/richtext'

// A ProseMirror Schema built dynamically from the resolved allow-list, so the
// editor can only ever produce nodes/marks the field permits. The stored model
// stays KernelRichText — see pmTransform for the boundary.

// Marks that map 1:1 to a KernelRichText MarkType. Order here is the order
// stored marks are applied; ProseMirror normalizes regardless.
const MARK_SPECS: Record<Exclude<MarkType, never>, MarkSpec> = {
  bold: { parseDOM: [{ tag: 'strong' }, { tag: 'b' }, { style: 'font-weight=bold' }], toDOM: () => ['strong', 0] },
  italic: { parseDOM: [{ tag: 'em' }, { tag: 'i' }, { style: 'font-style=italic' }], toDOM: () => ['em', 0] },
  underline: { parseDOM: [{ tag: 'u' }, { style: 'text-decoration=underline' }], toDOM: () => ['u', 0] },
  strike: { parseDOM: [{ tag: 's' }, { tag: 'strike' }, { tag: 'del' }], toDOM: () => ['s', 0] },
  code: { parseDOM: [{ tag: 'code' }], toDOM: () => ['code', 0] },
  sub: { parseDOM: [{ tag: 'sub' }], toDOM: () => ['sub', 0] },
  sup: { parseDOM: [{ tag: 'sup' }], toDOM: () => ['sup', 0] },
}

/** PM mark name → KernelRichText MarkType. `strong`/`em` are PM's canonical names. */
export const PM_MARK_TO_KERNEL: Record<string, MarkType> = {
  strong: 'bold',
  em: 'italic',
  underline: 'underline',
  strike: 'strike',
  code: 'code',
  sub: 'sub',
  sup: 'sup',
}

/** KernelRichText MarkType → PM mark name. Inverse of PM_MARK_TO_KERNEL. */
export const KERNEL_MARK_TO_PM: Record<MarkType, string> = {
  bold: 'strong',
  italic: 'em',
  underline: 'underline',
  strike: 'strike',
  code: 'code',
  sub: 'sub',
  sup: 'sup',
}

export function buildPMSchema(schema: ResolvedRichTextSchema): Schema {
  const nodes: Record<string, NodeSpec> = {
    doc: { content: 'block+' },
    paragraph: {
      group: 'block',
      content: 'inline*',
      parseDOM: [{ tag: 'p' }],
      toDOM: () => ['p', 0],
    },
    text: { group: 'inline' },
  }

  if (schema.nodes.has('heading') && schema.headingLevels.size) {
    const levels = [...schema.headingLevels].sort((a, b) => a - b)
    nodes.heading = {
      group: 'block',
      content: 'inline*',
      attrs: { level: { default: levels[0] } },
      defining: true,
      parseDOM: levels.map((level) => ({ tag: `h${level}`, attrs: { level } })),
      toDOM: (node) => [`h${node.attrs.level as number}`, 0],
    }
  }

  if (schema.nodes.has('quote')) {
    nodes.blockquote = {
      group: 'block',
      content: 'block+',
      defining: true,
      parseDOM: [{ tag: 'blockquote' }],
      toDOM: () => ['blockquote', 0],
    }
  }

  if (schema.nodes.has('list')) {
    // list_item content allows nested lists for arbitrary nesting depth.
    nodes.list_item = {
      content: 'paragraph block*',
      defining: true,
      parseDOM: [{ tag: 'li' }],
      toDOM: () => ['li', 0],
    }
    if (schema.lists.unordered) {
      nodes.bullet_list = {
        group: 'block',
        content: 'list_item+',
        parseDOM: [{ tag: 'ul' }],
        toDOM: () => ['ul', 0],
      }
    }
    if (schema.lists.ordered) {
      nodes.ordered_list = {
        group: 'block',
        content: 'list_item+',
        attrs: { order: { default: 1 } },
        parseDOM: [
          {
            tag: 'ol',
            getAttrs: (dom) => ({
              order: (dom as HTMLElement).hasAttribute('start') ? +(dom as HTMLElement).getAttribute('start')! : 1,
            }),
          },
        ],
        toDOM: (node) =>
          (node.attrs.order as number) === 1 ? ['ol', 0] : ['ol', { start: node.attrs.order as number }, 0],
      }
    }
  }

  if (schema.nodes.has('codeBlock')) {
    nodes.code_block = {
      group: 'block',
      content: 'text*',
      marks: '',
      code: true,
      defining: true,
      parseDOM: [{ tag: 'pre', preserveWhitespace: 'full' }],
      toDOM: () => ['pre', ['code', 0]],
    }
  }

  if (schema.nodes.has('hr')) {
    nodes.horizontal_rule = {
      group: 'block',
      parseDOM: [{ tag: 'hr' }],
      toDOM: () => ['hr'],
    }
  }

  const marks: Record<string, MarkSpec> = {}
  for (const mark of schema.marks) {
    marks[KERNEL_MARK_TO_PM[mark]] = MARK_SPECS[mark]
  }

  if (schema.link.enabled) {
    // `doc` carries an internal-link ref ({ relationTo, value }) so it survives the
    // PM round-trip; external links leave it null and rely on href.
    marks.link = {
      attrs: { href: {}, target: { default: null }, doc: { default: null } },
      inclusive: false,
      parseDOM: [
        {
          tag: 'a[href]',
          // Neutralize hostile schemes at the paste boundary — the toolbar guards
          // its own input, but pasted HTML reaches the live editor DOM directly.
          getAttrs: (dom) => ({
            href: safeHref((dom as HTMLElement).getAttribute('href')),
            target: (dom as HTMLElement).getAttribute('target'),
          }),
        },
      ],
      toDOM: (node) => {
        const href = safeHref(node.attrs.href)
        const target = node.attrs.target as string | null
        // rel on new-tab links closes reverse-tabnabbing in the editing surface too.
        return ['a', target ? { href, target, rel: 'noopener noreferrer' } : { href }, 0]
      },
    }
  }

  return new Schema({ nodes, marks })
}
