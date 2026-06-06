import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import {
  emptyRichText,
  sanitizeRichText,
  toHTML,
  type KernelRichText,
  type Mark,
  type MarkType,
  type ResolvedRichTextSchema,
  type RichBlockNode,
  type RichInlineNode,
} from '@kernel/richtext'
import type { AdminRichTextSchema } from './api'

// The model boundary is deliberately clean: the DOM is parsed back to
// KernelRichText and re-sanitized on every change, so the contentEditable surface
// can be swapped for ProseMirror later without touching the stored shape.

/** Rebuild a ResolvedRichTextSchema from the serialized /_config descriptor. */
function toResolvedSchema(meta: AdminRichTextSchema): ResolvedRichTextSchema {
  return {
    marks: new Set(meta.marks as MarkType[]),
    nodes: new Set(meta.nodes as RichBlockNode['type'][]),
    headingLevels: new Set(meta.headingLevels as (2 | 3 | 4)[]),
    lists: meta.lists,
    codeLanguages: null,
    link: {
      enabled: meta.link.enabled,
      allowNewTab: meta.link.allowNewTab,
      internalCollections: new Set(meta.link.internalCollections),
    },
    relationshipCollections: new Set(meta.relationshipCollections),
    uploadCollections: new Set(meta.uploadCollections),
    blockSlugs: new Set(meta.blockSlugs),
    maxDepth: 6,
  }
}

function asDoc(value: unknown): KernelRichText {
  if (value && typeof value === 'object' && (value as KernelRichText).type === 'doc') return value as KernelRichText
  if (typeof value === 'string' && value.trim()) {
    return { v: 1, type: 'doc', children: [{ type: 'paragraph', children: [{ type: 'text', text: value }] }] }
  }
  return emptyRichText()
}

// ── DOM → model ────────────────────────────────────────────────────────────────

const TAG_MARK: Record<string, MarkType> = {
  STRONG: 'bold',
  B: 'bold',
  EM: 'italic',
  I: 'italic',
  U: 'underline',
  S: 'strike',
  STRIKE: 'strike',
  DEL: 'strike',
  CODE: 'code',
  SUB: 'sub',
  SUP: 'sup',
}

function marksFromStyle(el: HTMLElement): MarkType[] {
  const out: MarkType[] = []
  const s = el.style
  if (s.fontWeight === 'bold' || Number(s.fontWeight) >= 600) out.push('bold')
  if (s.fontStyle === 'italic') out.push('italic')
  if (s.textDecoration.includes('underline') || s.textDecorationLine?.includes('underline')) out.push('underline')
  if (s.textDecoration.includes('line-through') || s.textDecorationLine?.includes('line-through')) out.push('strike')
  return out
}

function withMark(marks: MarkType[], extra: MarkType[]): MarkType[] {
  const set = new Set(marks)
  for (const m of extra) set.add(m)
  return [...set]
}

function parseInline(node: Node, marks: MarkType[], out: RichInlineNode[]): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? ''
    if (text) out.push(toText(text, marks))
    return
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return
  const el = node as HTMLElement
  if (el.tagName === 'BR') {
    out.push(toText(' ', marks))
    return
  }
  if (el.tagName === 'A') {
    const children: RichInlineNode[] = []
    el.childNodes.forEach((c) => parseInline(c, marks, children))
    const href = el.getAttribute('href') ?? '#'
    out.push({ type: 'link', url: href, children })
    return
  }
  const next = withMark(marks, [...(TAG_MARK[el.tagName] ? [TAG_MARK[el.tagName]!] : []), ...marksFromStyle(el)])
  el.childNodes.forEach((c) => parseInline(c, next, out))
}

function toText(text: string, marks: MarkType[]): RichInlineNode {
  return marks.length ? { type: 'text', text, marks: marks.map((type): Mark => ({ type })) } : { type: 'text', text }
}

function inlineChildren(el: Node): RichInlineNode[] {
  const out: RichInlineNode[] = []
  el.childNodes.forEach((c) => parseInline(c, [], out))
  return out
}

const BLOCK_TAGS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'UL', 'OL', 'PRE', 'HR'])

function parseBlockElement(el: HTMLElement): RichBlockNode[] {
  switch (el.tagName) {
    case 'H1':
    case 'H2':
      return [{ type: 'heading', level: 2, children: inlineChildren(el) }]
    case 'H3':
      return [{ type: 'heading', level: 3, children: inlineChildren(el) }]
    case 'H4':
    case 'H5':
    case 'H6':
      return [{ type: 'heading', level: 4, children: inlineChildren(el) }]
    case 'BLOCKQUOTE':
      return [{ type: 'quote', children: parseBlocks(el) }]
    case 'UL':
    case 'OL': {
      const items: RichBlockNode[] = []
      el.querySelectorAll(':scope > li').forEach((li) => {
        items.push({ type: 'listItem', children: parseBlocks(li as HTMLElement) })
      })
      return [{ type: 'list', ordered: el.tagName === 'OL', children: items as never }]
    }
    case 'PRE':
      return [{ type: 'codeBlock', code: el.textContent ?? '' }]
    case 'HR':
      return [{ type: 'hr' }]
    default:
      // P / DIV → paragraph.
      return [{ type: 'paragraph', children: inlineChildren(el) }]
  }
}

function parseBlocks(root: HTMLElement): RichBlockNode[] {
  const out: RichBlockNode[] = []
  let inlineBuf: RichInlineNode[] = []
  const flush = () => {
    if (inlineBuf.length) {
      out.push({ type: 'paragraph', children: inlineBuf })
      inlineBuf = []
    }
  }
  root.childNodes.forEach((node) => {
    if (node.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has((node as HTMLElement).tagName)) {
      flush()
      out.push(...parseBlockElement(node as HTMLElement))
    } else {
      parseInline(node, [], inlineBuf)
    }
  })
  flush()
  return out
}

function domToDoc(root: HTMLElement, schema: ResolvedRichTextSchema): KernelRichText {
  return sanitizeRichText({ v: 1, type: 'doc', children: parseBlocks(root) }, schema).doc
}

// ── Editor component ─────────────────────────────────────────────────────────

interface Props {
  meta: AdminRichTextSchema
  value: unknown
  onChange: (value: KernelRichText) => void
  readOnly?: boolean
}

interface SlashCommand {
  id: string
  label: string
  hint: string
  keywords: string
  run: () => void
}

interface BubbleState {
  visible: boolean
  top: number
  left: number
}
interface SlashState {
  open: boolean
  query: string
  index: number
  top: number
  left: number
}

const SLASH_CLOSED: SlashState = { open: false, query: '', index: 0, top: 0, left: 0 }

export function RichTextEditor({ meta, value, onChange, readOnly }: Props) {
  const schema = useMemo(() => toResolvedSchema(meta), [meta])
  const ref = useRef<HTMLDivElement>(null)
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Guard so external value changes (initial load) set innerHTML, but our own
  // keystroke-driven onChange does not stomp the caret.
  const lastEmitted = useRef<string | null>(null)
  const [bubble, setBubble] = useState<BubbleState>({ visible: false, top: 0, left: 0 })
  const [slash, setSlash] = useState<SlashState>(SLASH_CLOSED)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const html = toHTML(asDoc(value))
    const incoming = JSON.stringify(value ?? null)
    if (incoming !== lastEmitted.current) {
      el.innerHTML = html || '<p></p>'
      lastEmitted.current = incoming
    }
  }, [value])

  const emit = () => {
    const el = ref.current
    if (!el) return
    const doc = domToDoc(el, schema)
    lastEmitted.current = JSON.stringify(doc)
    onChange(doc)
  }

  const handleInput = () => {
    detectSlash()
    if (debounce.current) clearTimeout(debounce.current)
    debounce.current = setTimeout(emit, 150)
  }

  const exec = (command: string, arg?: string) => {
    ref.current?.focus()
    document.execCommand(command, false, arg)
    emit()
  }

  const setBlock = (tag: string) => exec('formatBlock', tag)

  const addLink = () => {
    const url = window.prompt('Link URL')
    if (url) exec('createLink', url)
  }

  const has = (m: MarkType) => schema.marks.has(m)
  const node = (t: RichBlockNode['type']) => schema.nodes.has(t)

  // ── Slash command palette ────────────────────────────────────────────────
  const allCommands = useMemo<SlashCommand[]>(() => {
    const cmds: SlashCommand[] = []
    for (const level of [2, 3, 4] as const) {
      if (meta.headingLevels.includes(level)) {
        cmds.push({
          id: `h${level}`,
          label: `Heading ${level}`,
          hint: `H${level}`,
          keywords: `heading h${level} title`,
          run: () => setBlock(`<h${level}>`),
        })
      }
    }
    if (meta.lists.unordered)
      cmds.push({
        id: 'ul',
        label: 'Bulleted list',
        hint: '•',
        keywords: 'bullet unordered list ul',
        run: () => exec('insertUnorderedList'),
      })
    if (meta.lists.ordered)
      cmds.push({
        id: 'ol',
        label: 'Numbered list',
        hint: '1.',
        keywords: 'number ordered list ol',
        run: () => exec('insertOrderedList'),
      })
    if (node('quote'))
      cmds.push({
        id: 'quote',
        label: 'Quote',
        hint: '❝',
        keywords: 'quote blockquote',
        run: () => setBlock('<blockquote>'),
      })
    if (node('hr'))
      cmds.push({
        id: 'hr',
        label: 'Divider',
        hint: '—',
        keywords: 'divider hr horizontal rule line',
        run: () => exec('insertHorizontalRule'),
      })
    return cmds
    // exec/setBlock are stable enough for this menu; deps on schema shape only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta])

  const filtered = useMemo(() => {
    const q = slash.query.toLowerCase()
    if (!q) return allCommands
    return allCommands.filter((c) => c.keywords.includes(q))
  }, [allCommands, slash.query])

  const detectSlash = () => {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed || !ref.current) return setSlash(SLASH_CLOSED)
    const range = sel.getRangeAt(0)
    if (!ref.current.contains(range.startContainer)) return setSlash(SLASH_CLOSED)
    const container = range.startContainer
    const textBefore = (container.textContent ?? '').slice(0, range.startOffset)
    // A slash at the start of the block, or after whitespace, opens the palette.
    const m = /(?:^|\s)\/([a-z0-9]*)$/i.exec(textBefore)
    if (!m) return setSlash(SLASH_CLOSED)
    const rect = range.getBoundingClientRect()
    setSlash((prev) => ({
      open: true,
      query: m[1] ?? '',
      index: prev.open ? Math.min(prev.index, 99) : 0,
      top: rect.bottom || rect.top,
      left: rect.left,
    }))
  }

  const closeSlash = () => setSlash(SLASH_CLOSED)

  const applySlash = (cmd: SlashCommand) => {
    // Remove the typed "/query" trigger, then run the block command.
    const remove = slash.query.length + 1
    ref.current?.focus()
    for (let i = 0; i < remove; i++) document.execCommand('delete', false)
    cmd.run()
    closeSlash()
  }

  const handleKeyDown = (e: ReactKeyboardEvent) => {
    if (!slash.open || filtered.length === 0) {
      if (e.key === 'Escape') closeSlash()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSlash((s) => ({ ...s, index: (s.index + 1) % filtered.length }))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSlash((s) => ({ ...s, index: (s.index - 1 + filtered.length) % filtered.length }))
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      applySlash(filtered[Math.min(slash.index, filtered.length - 1)]!)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      closeSlash()
    }
  }

  // ── Floating selection (bubble) toolbar ──────────────────────────────────
  useEffect(() => {
    const onSelectionChange = () => {
      const el = ref.current
      const sel = window.getSelection()
      if (!el || !sel || sel.rangeCount === 0 || sel.isCollapsed)
        return setBubble((b) => (b.visible ? { ...b, visible: false } : b))
      const range = sel.getRangeAt(0)
      if (!el.contains(range.commonAncestorContainer))
        return setBubble((b) => (b.visible ? { ...b, visible: false } : b))
      const rect = range.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) return
      setBubble({ visible: true, top: rect.top, left: rect.left + rect.width / 2 })
    }
    document.addEventListener('selectionchange', onSelectionChange)
    return () => document.removeEventListener('selectionchange', onSelectionChange)
  }, [])

  return (
    <div className="rte">
      <div className="rte-toolbar" role="toolbar" aria-label="Formatting">
        {has('bold') && <ToolButton label="Bold" mono="B" onClick={() => exec('bold')} />}
        {has('italic') && <ToolButton label="Italic" mono="I" italic onClick={() => exec('italic')} />}
        {has('underline') && <ToolButton label="Underline" mono="U" underline onClick={() => exec('underline')} />}
        {has('strike') && <ToolButton label="Strikethrough" mono="S" strike onClick={() => exec('strikeThrough')} />}
        {(has('bold') || has('italic')) && node('heading') && <span className="rte-sep" />}
        {meta.headingLevels.includes(2) && <ToolButton label="Heading 2" mono="H2" onClick={() => setBlock('<h2>')} />}
        {meta.headingLevels.includes(3) && <ToolButton label="Heading 3" mono="H3" onClick={() => setBlock('<h3>')} />}
        {meta.headingLevels.includes(4) && <ToolButton label="Heading 4" mono="H4" onClick={() => setBlock('<h4>')} />}
        <ToolButton label="Paragraph" mono="¶" onClick={() => setBlock('<p>')} />
        {(node('list') || node('quote')) && <span className="rte-sep" />}
        {meta.lists.unordered && (
          <ToolButton label="Bulleted list" mono="•—" onClick={() => exec('insertUnorderedList')} />
        )}
        {meta.lists.ordered && <ToolButton label="Numbered list" mono="1." onClick={() => exec('insertOrderedList')} />}
        {node('quote') && <ToolButton label="Quote" mono="❝" onClick={() => setBlock('<blockquote>')} />}
        {node('hr') && <ToolButton label="Divider" mono="—" onClick={() => exec('insertHorizontalRule')} />}
        {meta.link.enabled && (
          <>
            <span className="rte-sep" />
            <ToolButton label="Link" mono="🔗" onClick={addLink} />
          </>
        )}
        <span className="rte-hint" aria-hidden>
          Type <kbd>/</kbd> for commands
        </span>
      </div>

      {bubble.visible && (
        <div
          className="rte-bubble"
          role="toolbar"
          aria-label="Selection formatting"
          style={{ top: bubble.top, left: bubble.left }}
        >
          {has('bold') && <ToolButton label="Bold" mono="B" onClick={() => exec('bold')} />}
          {has('italic') && <ToolButton label="Italic" mono="I" italic onClick={() => exec('italic')} />}
          {has('underline') && <ToolButton label="Underline" mono="U" underline onClick={() => exec('underline')} />}
          {has('strike') && <ToolButton label="Strikethrough" mono="S" strike onClick={() => exec('strikeThrough')} />}
          {meta.link.enabled && <ToolButton label="Link" mono="🔗" onClick={addLink} />}
        </div>
      )}

      {slash.open && filtered.length > 0 && (
        <ul className="rte-slash" role="listbox" aria-label="Insert block" style={{ top: slash.top, left: slash.left }}>
          {filtered.map((cmd, i) => (
            <li
              key={cmd.id}
              role="option"
              aria-selected={i === slash.index}
              className={i === slash.index ? 'rte-slash-item active' : 'rte-slash-item'}
              onMouseEnter={() => setSlash((s) => ({ ...s, index: i }))}
              onMouseDown={(e) => {
                e.preventDefault()
                applySlash(cmd)
              }}
            >
              <span className="rte-slash-hint" aria-hidden>
                {cmd.hint}
              </span>
              <span>{cmd.label}</span>
            </li>
          ))}
        </ul>
      )}

      <div
        ref={ref}
        className="rte-surface input"
        contentEditable={!readOnly}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          // Defer so a mousedown on a menu item still registers before close.
          setTimeout(() => {
            closeSlash()
            setBubble((b) => (b.visible ? { ...b, visible: false } : b))
          }, 150)
          emit()
        }}
      />
    </div>
  )
}

function ToolButton({
  label,
  mono,
  onClick,
  italic,
  underline,
  strike,
}: {
  label: string
  mono: string
  onClick: () => void
  italic?: boolean
  underline?: boolean
  strike?: boolean
}) {
  // Use onMouseDown + preventDefault so the editor keeps its selection.
  const style = italic
    ? { fontStyle: 'italic' as const }
    : underline
      ? { textDecoration: 'underline' as const }
      : strike
        ? { textDecoration: 'line-through' as const }
        : undefined
  return (
    <button
      type="button"
      className="rte-btn"
      title={label}
      aria-label={label}
      style={style}
      onMouseDown={(e) => {
        e.preventDefault()
        onClick()
      }}
    >
      {mono}
    </button>
  )
}
