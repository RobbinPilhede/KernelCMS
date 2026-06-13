import { useEffect, useMemo, useRef, useState } from 'react'
import { baseKeymap, chainCommands, setBlockType, toggleMark, wrapIn } from 'prosemirror-commands'
import { redo, history, undo } from 'prosemirror-history'
import { keymap } from 'prosemirror-keymap'
import type { Schema } from 'prosemirror-model'
import { liftListItem, sinkListItem, splitListItem, wrapInList } from 'prosemirror-schema-list'
import { EditorState, type Command, type Transaction } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import 'prosemirror-view/style/prosemirror.css'
import {
  emptyRichText,
  sanitizeRichText,
  type KernelRichText,
  type MarkType,
  type ResolvedRichTextSchema,
  type RichBlockNode,
} from '@kernel/richtext'
import type { AdminRichTextSchema } from './api'
import { buildPMSchema } from './richtext/pmSchema'
import { kernelToPM, pmToKernel } from './richtext/pmTransform'

// The model boundary is deliberately clean: ProseMirror edits an in-memory doc
// that is converted back to KernelRichText and re-sanitized on every change, so
// the editor surface never leaks PM-specific shape into the stored model.

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
  const pmSchema = useMemo<Schema>(() => buildPMSchema(schema), [schema])

  const mount = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Guard so external value changes (initial load / doc switch) reset the doc,
  // but our own keystroke-driven onChange does not stomp the caret.
  const lastEmitted = useRef<string | null>(null)
  const readOnlyRef = useRef(Boolean(readOnly))
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const [bubble, setBubble] = useState<BubbleState>({ visible: false, top: 0, left: 0 })
  const [slash, setSlash] = useState<SlashState>(SLASH_CLOSED)
  // Force re-derivation of toolbar disabled-state when selection/state changes.
  const [, bumpState] = useState(0)

  // ── PM commands ───────────────────────────────────────────────────────────
  const dispatch = (command: Command) => {
    const view = viewRef.current
    if (!view) return
    command(view.state, view.dispatch, view)
    view.focus()
  }

  const toggleMarkCmd = (name: MarkType) => {
    const markType = pmSchema.marks[markPM(name)]
    if (markType) dispatch(toggleMark(markType))
  }

  const setHeading = (level: 2 | 3 | 4) => {
    const heading = pmSchema.nodes.heading
    if (heading) dispatch(setBlockType(heading, { level }))
  }

  const setParagraph = () => dispatch(setBlockType(pmSchema.nodes.paragraph))

  const toggleList = (ordered: boolean) => {
    const listType = ordered ? pmSchema.nodes.ordered_list : pmSchema.nodes.bullet_list
    if (listType) dispatch(wrapInList(listType))
  }

  const insertQuote = () => {
    if (pmSchema.nodes.blockquote) dispatch(wrapIn(pmSchema.nodes.blockquote))
  }

  const insertCodeBlock = () => {
    if (pmSchema.nodes.code_block) dispatch(setBlockType(pmSchema.nodes.code_block))
  }

  const insertHr = () => {
    const hr = pmSchema.nodes.horizontal_rule
    if (!hr) return
    dispatch((state, dispatchFn) => {
      dispatchFn?.(state.tr.replaceSelectionWith(hr.create()).scrollIntoView())
      return true
    })
  }

  const addLink = () => {
    const linkType = pmSchema.marks.link
    const view = viewRef.current
    if (!linkType || !view) return
    const url = window.prompt('Link URL')
    if (!url) return
    // Reject unsafe schemes before the href ever touches the DOM; the emit-time
    // sanitizer is a backstop, not the only guard. Allow http(s)/mailto/tel and
    // relative/anchor URLs only.
    if (!isSafeLinkUrl(url)) return
    const { from, to, empty } = view.state.selection
    if (empty) return
    view.dispatch(view.state.tr.addMark(from, to, linkType.create({ href: url.trim(), target: null })))
    view.focus()
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
          run: () => setHeading(level),
        })
      }
    }
    if (meta.lists.unordered)
      cmds.push({
        id: 'ul',
        label: 'Bulleted list',
        hint: '•',
        keywords: 'bullet unordered list ul',
        run: () => toggleList(false),
      })
    if (meta.lists.ordered)
      cmds.push({
        id: 'ol',
        label: 'Numbered list',
        hint: '1.',
        keywords: 'number ordered list ol',
        run: () => toggleList(true),
      })
    if (node('quote'))
      cmds.push({ id: 'quote', label: 'Quote', hint: '❝', keywords: 'quote blockquote', run: insertQuote })
    if (node('codeBlock'))
      cmds.push({ id: 'code', label: 'Code block', hint: '</>', keywords: 'code pre snippet', run: insertCodeBlock })
    if (node('hr'))
      cmds.push({ id: 'hr', label: 'Divider', hint: '—', keywords: 'divider hr horizontal rule line', run: insertHr })
    return cmds
    // Commands close over stable refs; menu shape depends only on the schema.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta])

  const filtered = useMemo(() => {
    const q = slash.query.toLowerCase()
    if (!q) return allCommands
    return allCommands.filter((c) => c.keywords.includes(q))
  }, [allCommands, slash.query])

  // Keep the live menu/state in refs so the PM keydown handler (bound once) reads
  // current values without re-binding the EditorView on every render.
  const slashRef = useRef(slash)
  slashRef.current = slash
  const filteredRef = useRef(filtered)
  filteredRef.current = filtered

  const closeSlash = () => setSlash(SLASH_CLOSED)

  const detectSlash = (view: EditorView) => {
    const { selection } = view.state
    if (!selection.empty) return setSlash(SLASH_CLOSED)
    const { $from } = selection
    const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼')
    // A slash at block start, or after whitespace, opens the palette.
    const m = /(?:^|\s)\/([a-z0-9]*)$/i.exec(textBefore)
    if (!m) return setSlash(SLASH_CLOSED)
    const coords = view.coordsAtPos(selection.from)
    setSlash((prev) => ({
      open: true,
      query: m[1] ?? '',
      index: prev.open ? prev.index : 0,
      top: coords.bottom,
      left: coords.left,
    }))
  }

  const applySlash = (cmd: SlashCommand) => {
    const view = viewRef.current
    if (!view) return
    // Strip the typed "/query" trigger before running the block command.
    const { selection } = view.state
    const remove = slashRef.current.query.length + 1
    const from = selection.from - remove
    if (from >= 0) view.dispatch(view.state.tr.delete(from, selection.from))
    view.focus()
    cmd.run()
    closeSlash()
  }

  // Menu navigation runs ahead of PM; returns true to swallow the key.
  const handleSlashKey = (event: KeyboardEvent): boolean => {
    const s = slashRef.current
    const items = filteredRef.current
    if (!s.open || items.length === 0) {
      if (event.key === 'Escape' && s.open) {
        closeSlash()
        return true
      }
      return false
    }
    if (event.key === 'ArrowDown') {
      setSlash((prev) => ({ ...prev, index: (prev.index + 1) % items.length }))
      return true
    }
    if (event.key === 'ArrowUp') {
      setSlash((prev) => ({ ...prev, index: (prev.index - 1 + items.length) % items.length }))
      return true
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      applySlash(items[Math.min(s.index, items.length - 1)]!)
      return true
    }
    if (event.key === 'Escape') {
      closeSlash()
      return true
    }
    return false
  }

  // ── Floating selection (bubble) toolbar ──────────────────────────────────
  const updateBubble = (view: EditorView) => {
    const { selection } = view.state
    if (selection.empty || readOnlyRef.current || !view.hasFocus()) {
      return setBubble((b) => (b.visible ? { ...b, visible: false } : b))
    }
    const start = view.coordsAtPos(selection.from)
    const end = view.coordsAtPos(selection.to)
    setBubble({ visible: true, top: Math.min(start.top, end.top), left: (start.left + end.right) / 2 })
  }

  // ── Mount / teardown ──────────────────────────────────────────────────────
  useEffect(() => {
    const el = mount.current
    if (!el) return

    const pmKeymap = buildKeymap(pmSchema)
    const state = EditorState.create({
      doc: kernelToPM(asDoc(value), pmSchema),
      plugins: [history(), keymap(pmKeymap), keymap(baseKeymap)],
    })

    // Reads the live view.state.doc; the lastEmitted guard makes it idempotent so
    // a teardown/blur flush after an already-emitted state won't double-fire.
    const emit = (view: EditorView) => {
      const doc = sanitizeRichText(pmToKernel(view.state.doc), schema).doc
      const serialized = JSON.stringify(doc)
      if (serialized === lastEmitted.current) return
      lastEmitted.current = serialized
      onChangeRef.current(doc)
    }

    // Flush any pending debounced edit immediately (teardown / blur).
    const flush = (view: EditorView) => {
      if (!debounce.current) return
      clearTimeout(debounce.current)
      debounce.current = null
      emit(view)
    }

    const view = new EditorView(el, {
      state,
      editable: () => !readOnlyRef.current,
      handleKeyDown: (_view, event) => handleSlashKey(event),
      // Blur emits immediately rather than waiting out the debounce window.
      handleDOMEvents: { blur: (view) => (flush(view), false) },
      dispatchTransaction(transaction: Transaction) {
        const next = view.state.apply(transaction)
        view.updateState(next)
        bumpState((n) => n + 1)
        detectSlash(view)
        updateBubble(view)
        if (transaction.docChanged) {
          if (debounce.current) clearTimeout(debounce.current)
          debounce.current = setTimeout(() => emit(view), 150)
        }
      },
    })
    viewRef.current = view
    // Seed the guard so the initial value doesn't trigger a redundant reset.
    lastEmitted.current = JSON.stringify(sanitizeRichText(pmToKernel(view.state.doc), schema).doc)

    return () => {
      // Flush pending keystrokes BEFORE destroy so the last edits aren't lost on
      // save / navigate / doc-switch.
      flush(view)
      view.destroy()
      viewRef.current = null
    }
    // Rebuild only when the schema identity changes (field switch); value sync is
    // handled separately below to preserve the caret while typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pmSchema])

  // Reflect readOnly without remounting.
  useEffect(() => {
    readOnlyRef.current = Boolean(readOnly)
    viewRef.current?.setProps({ editable: () => !Boolean(readOnly) })
  }, [readOnly])

  // External value sync: reset the doc only when the incoming value is genuinely
  // external (initial load / doc switch), never echoing our own debounced emit.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const incoming = JSON.stringify(sanitizeRichText(asDoc(value), schema).doc)
    if (incoming === lastEmitted.current) return
    lastEmitted.current = incoming
    const next = view.state.apply(
      view.state.tr.replaceWith(0, view.state.doc.content.size, kernelToPM(asDoc(value), pmSchema).content),
    )
    view.updateState(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  return (
    <div className="rte">
      <div className="rte-toolbar" role="toolbar" aria-label="Formatting">
        {has('bold') && <ToolButton label="Bold" mono="B" onClick={() => toggleMarkCmd('bold')} />}
        {has('italic') && <ToolButton label="Italic" mono="I" italic onClick={() => toggleMarkCmd('italic')} />}
        {has('underline') && (
          <ToolButton label="Underline" mono="U" underline onClick={() => toggleMarkCmd('underline')} />
        )}
        {has('strike') && <ToolButton label="Strikethrough" mono="S" strike onClick={() => toggleMarkCmd('strike')} />}
        {has('code') && <ToolButton label="Code" mono="</>" onClick={() => toggleMarkCmd('code')} />}
        {(has('bold') || has('italic')) && node('heading') && <span className="rte-sep" />}
        {meta.headingLevels.includes(2) && <ToolButton label="Heading 2" mono="H2" onClick={() => setHeading(2)} />}
        {meta.headingLevels.includes(3) && <ToolButton label="Heading 3" mono="H3" onClick={() => setHeading(3)} />}
        {meta.headingLevels.includes(4) && <ToolButton label="Heading 4" mono="H4" onClick={() => setHeading(4)} />}
        <ToolButton label="Paragraph" mono="¶" onClick={setParagraph} />
        {(node('list') || node('quote') || node('codeBlock')) && <span className="rte-sep" />}
        {meta.lists.unordered && <ToolButton label="Bulleted list" mono="•—" onClick={() => toggleList(false)} />}
        {meta.lists.ordered && <ToolButton label="Numbered list" mono="1." onClick={() => toggleList(true)} />}
        {node('quote') && <ToolButton label="Quote" mono="❝" onClick={insertQuote} />}
        {node('codeBlock') && <ToolButton label="Code block" mono="{}" onClick={insertCodeBlock} />}
        {node('hr') && <ToolButton label="Divider" mono="—" onClick={insertHr} />}
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
          {has('bold') && <ToolButton label="Bold" mono="B" onClick={() => toggleMarkCmd('bold')} />}
          {has('italic') && <ToolButton label="Italic" mono="I" italic onClick={() => toggleMarkCmd('italic')} />}
          {has('underline') && (
            <ToolButton label="Underline" mono="U" underline onClick={() => toggleMarkCmd('underline')} />
          )}
          {has('strike') && (
            <ToolButton label="Strikethrough" mono="S" strike onClick={() => toggleMarkCmd('strike')} />
          )}
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

      <div ref={mount} className="rte-surface input" />
    </div>
  )
}

/** Allow http(s)/mailto/tel + relative/anchor URLs; reject javascript:/data:/etc. */
function isSafeLinkUrl(raw: string): boolean {
  // Strip control chars browsers ignore inside a scheme (e.g. "java\tscript:").
  let url = ''
  for (const ch of raw.trim()) if (ch.codePointAt(0)! > 0x20) url += ch
  if (!url) return false
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)
  if (!scheme) return /^[/#.]/.test(url) // relative / anchor / dot-path
  return ['http', 'https', 'mailto', 'tel'].includes(scheme[1]!.toLowerCase())
}

/** KernelRichText MarkType → its PM mark name (strong/em differ from kernel). */
function markPM(name: MarkType): string {
  return name === 'bold' ? 'strong' : name === 'italic' ? 'em' : name
}

/** Editing keymap: marks, list editing, history. baseKeymap handles the rest. */
function buildKeymap(pmSchema: Schema): Record<string, Command> {
  const keys: Record<string, Command> = {
    'Mod-z': undo,
    'Mod-y': redo,
    'Shift-Mod-z': redo,
  }
  const bind = (key: string, command: Command) => {
    keys[key] = keys[key] ? chainCommands(keys[key]!, command) : command
  }

  if (pmSchema.marks.strong) bind('Mod-b', toggleMark(pmSchema.marks.strong))
  if (pmSchema.marks.em) bind('Mod-i', toggleMark(pmSchema.marks.em))
  if (pmSchema.marks.underline) bind('Mod-u', toggleMark(pmSchema.marks.underline))

  if (pmSchema.nodes.list_item) {
    bind('Enter', splitListItem(pmSchema.nodes.list_item))
    bind('Tab', sinkListItem(pmSchema.nodes.list_item))
    bind('Shift-Tab', liftListItem(pmSchema.nodes.list_item))
  }
  return keys
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
