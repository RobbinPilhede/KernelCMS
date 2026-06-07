/**
 * Importers that build a `KernelRichText` document from Markdown or HTML — the
 * inverse of `toHTML`/`toPlainText`. They make seeding and migrating (`kernel
 * import`) far easier than hand-building node trees. Both cover the common subset
 * the model represents (paragraphs, headings, lists, quotes, code, hr, and the
 * bold/italic/underline/strike/code/link inline marks) and run the result through
 * `sanitizeRichText`, so output is always normalized and safe regardless of input.
 *
 * Zero runtime dependencies — a small, self-contained HTML tokenizer and a
 * line-based Markdown parser. Anything unrecognized degrades to text/paragraphs.
 */
import type {
  HeadingNode,
  KernelRichText,
  ListItemNode,
  ListNode,
  Mark,
  MarkType,
  ParagraphNode,
  RichBlockNode,
  RichInlineNode,
  TextNode,
} from './types'
import { resolveRichTextSchema, type ResolvedRichTextSchema } from './schema'
import { sanitizeRichText } from './sanitize'

export interface ImportOptions {
  /** Schema to normalize against. Defaults to the `full` preset (all features). */
  schema?: ResolvedRichTextSchema
}

function normalize(children: RichBlockNode[], opts: ImportOptions): KernelRichText {
  const schema = opts.schema ?? resolveRichTextSchema({ preset: 'full' })
  return sanitizeRichText({ v: 1, type: 'doc', children }, schema).doc
}

function clampHeading(level: number): 2 | 3 | 4 {
  if (level <= 2) return 2
  if (level === 3) return 3
  return 4
}

function text(value: string, marks?: MarkType[]): TextNode {
  const node: TextNode = { type: 'text', text: value }
  if (marks && marks.length) node.marks = marks.map((m): Mark => ({ type: m }))
  return node
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

/** Parse inline Markdown (`**b**`, `*i*`, `` `code` ``, `[t](url)`) into runs. */
function parseInlineMarkdown(input: string): RichInlineNode[] {
  const out: RichInlineNode[] = []
  let i = 0
  let plain = ''
  const flush = (marks?: MarkType[]) => {
    if (plain) out.push(text(plain, marks))
    plain = ''
  }
  while (i < input.length) {
    const rest = input.slice(i)
    // Link: [text](url)
    const link = /^\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest)
    if (link) {
      flush()
      out.push({ type: 'link', url: link[2]!, children: parseInlineMarkdown(link[1]!) })
      i += link[0].length
      continue
    }
    // Inline code: `code`
    const code = /^`([^`]+)`/.exec(rest)
    if (code) {
      flush()
      out.push(text(code[1]!, ['code']))
      i += code[0].length
      continue
    }
    // Bold: **text** or __text__
    const bold = /^(\*\*|__)(.+?)\1/.exec(rest)
    if (bold) {
      flush()
      for (const n of parseInlineMarkdown(bold[2]!)) out.push(addMark(n, 'bold'))
      i += bold[0].length
      continue
    }
    // Italic: *text* or _text_
    const italic = /^(\*|_)(.+?)\1/.exec(rest)
    if (italic) {
      flush()
      for (const n of parseInlineMarkdown(italic[2]!)) out.push(addMark(n, 'italic'))
      i += italic[0].length
      continue
    }
    plain += input[i]
    i += 1
  }
  flush()
  return out
}

/** Apply a mark to an inline node (text/link), preserving existing marks. */
function addMark(node: RichInlineNode, mark: MarkType): RichInlineNode {
  if (node.type !== 'text') return node
  const marks = new Set<MarkType>((node.marks ?? []).map((m) => m.type))
  marks.add(mark)
  return text(node.text, [...marks])
}

/** Build a KernelRichText document from a Markdown string. */
export function fromMarkdown(md: string, opts: ImportOptions = {}): KernelRichText {
  const lines = md.replace(/\r\n?/g, '\n').split('\n')
  const blocks: RichBlockNode[] = []
  let i = 0

  const listMarker = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
  while (i < lines.length) {
    const line = lines[i]!
    // Fenced code block.
    const fence = /^```(\w+)?\s*$/.exec(line)
    if (fence) {
      const lang = fence[1]
      const code: string[] = []
      i += 1
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) code.push(lines[i++]!)
      i += 1 // closing fence
      blocks.push({ type: 'codeBlock', code: code.join('\n'), ...(lang ? { language: lang } : {}) })
      continue
    }
    // Blank line.
    if (/^\s*$/.test(line)) {
      i += 1
      continue
    }
    // Horizontal rule.
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ type: 'hr' })
      i += 1
      continue
    }
    // Heading.
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      const node: HeadingNode = {
        type: 'heading',
        level: clampHeading(heading[1]!.length),
        children: parseInlineMarkdown(heading[2]!.trim()),
      }
      blocks.push(node)
      i += 1
      continue
    }
    // Blockquote: consecutive `>` lines, parsed recursively.
    if (/^\s*>\s?/.test(line)) {
      const quoted: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i]!)) quoted.push(lines[i++]!.replace(/^\s*>\s?/, ''))
      blocks.push({ type: 'quote', children: fromMarkdown(quoted.join('\n'), opts).children })
      continue
    }
    // List: consecutive item lines of the same ordering.
    const item = listMarker.exec(line)
    if (item) {
      const ordered = /\d/.test(item[2]!)
      const items: ListItemNode[] = []
      while (i < lines.length) {
        const m = listMarker.exec(lines[i]!)
        if (!m || /\d/.test(m[2]!) !== ordered) break
        items.push({ type: 'listItem', children: [{ type: 'paragraph', children: parseInlineMarkdown(m[3]!) }] })
        i += 1
      }
      const list: ListNode = { type: 'list', ordered, children: items }
      blocks.push(list)
      continue
    }
    // Paragraph: gather consecutive plain lines until a blank or block starter.
    const para: string[] = []
    while (i < lines.length && !/^\s*$/.test(lines[i]!) && !isBlockStart(lines[i]!, listMarker)) {
      para.push(lines[i++]!)
    }
    const p: ParagraphNode = { type: 'paragraph', children: parseInlineMarkdown(para.join(' ')) }
    blocks.push(p)
  }
  return normalize(blocks, opts)
}

function isBlockStart(line: string, listMarker: RegExp): boolean {
  return (
    /^```/.test(line) ||
    /^#{1,6}\s/.test(line) ||
    /^\s*>\s?/.test(line) ||
    /^\s*([-*_])(\s*\1){2,}\s*$/.test(line) ||
    listMarker.test(line)
  )
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

interface Tag {
  kind: 'open' | 'close'
  name: string
}
type Token = { type: 'text'; value: string } | ({ type: 'tag' } & Tag)

/** Tokenize HTML into text + tag tokens (comments/doctype/attrs are discarded). */
function tokenizeHtml(html: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < html.length) {
    if (html[i] === '<') {
      // Skip comments.
      if (html.startsWith('<!--', i)) {
        const end = html.indexOf('-->', i + 4)
        i = end === -1 ? html.length : end + 3
        continue
      }
      const close = html.indexOf('>', i)
      if (close === -1) {
        tokens.push({ type: 'text', value: html.slice(i) })
        break
      }
      const raw = html.slice(i + 1, close).trim()
      i = close + 1
      if (!raw || raw.startsWith('!')) continue
      const isClose = raw.startsWith('/')
      const name = raw
        .replace(/^\//, '')
        .split(/[\s/>]/)[0]!
        .toLowerCase()
      if (name) tokens.push({ type: 'tag', kind: isClose ? 'close' : 'open', name })
    } else {
      const next = html.indexOf('<', i)
      const end = next === -1 ? html.length : next
      tokens.push({ type: 'text', value: html.slice(i, end) })
      i = end
    }
  }
  return tokens
}

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
}
function decodeEntities(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39);/g, (m) => HTML_ENTITIES[m] ?? m)
}

const INLINE_MARK: Record<string, MarkType> = {
  strong: 'bold',
  b: 'bold',
  em: 'italic',
  i: 'italic',
  u: 'underline',
  s: 'strike',
  strike: 'strike',
  del: 'strike',
  code: 'code',
  sub: 'sub',
  sup: 'sup',
}
const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'hr', 'br'])

/** Build a KernelRichText document from an HTML string (the common tag subset). */
export function fromHTML(html: string, opts: ImportOptions = {}): KernelRichText {
  const tokens = tokenizeHtml(html)
  const blocks: RichBlockNode[] = []
  let idx = 0

  // Collect inline runs until a matching close tag (or a block boundary).
  const readInline = (stopTags: Set<string>, marks: MarkType[]): RichInlineNode[] => {
    const out: RichInlineNode[] = []
    while (idx < tokens.length) {
      const tok = tokens[idx]!
      if (tok.type === 'text') {
        const value = decodeEntities(tok.value).replace(/\s+/g, ' ')
        if (value) out.push(text(value, marks))
        idx += 1
        continue
      }
      if (tok.kind === 'close' && stopTags.has(tok.name)) return out
      if (tok.kind === 'open' && INLINE_MARK[tok.name]) {
        idx += 1
        out.push(...readInline(new Set([tok.name, ...stopTags]), [...marks, INLINE_MARK[tok.name]!]))
        continue
      }
      if (tok.kind === 'open' && tok.name === 'a') {
        idx += 1
        out.push({ type: 'link', url: '#', children: readInline(new Set(['a', ...stopTags]), marks) })
        continue
      }
      if (tok.kind === 'open' && tok.name === 'br') {
        idx += 1
        continue
      }
      // A block tag or unknown close ends the inline run.
      if (tok.kind === 'close' && tok.name === 'a') {
        idx += 1
        return out
      }
      if (BLOCK_TAGS.has(tok.name)) return out
      idx += 1
    }
    return out
  }

  const readListItems = (listTag: string): ListItemNode[] => {
    const items: ListItemNode[] = []
    while (idx < tokens.length) {
      const tok = tokens[idx]!
      if (tok.type === 'tag' && tok.kind === 'close' && tok.name === listTag) {
        idx += 1
        break
      }
      if (tok.type === 'tag' && tok.kind === 'open' && tok.name === 'li') {
        idx += 1
        items.push({ type: 'listItem', children: [{ type: 'paragraph', children: readInline(new Set(['li']), []) }] })
        if (tokens[idx]?.type === 'tag' && (tokens[idx] as Tag).kind === 'close') idx += 1
        continue
      }
      idx += 1
    }
    return items
  }

  while (idx < tokens.length) {
    const tok = tokens[idx]!
    if (tok.type === 'text') {
      const value = decodeEntities(tok.value).trim()
      if (value) blocks.push({ type: 'paragraph', children: [text(value)] })
      idx += 1
      continue
    }
    if (tok.kind === 'close') {
      idx += 1
      continue
    }
    const name = tok.name
    if (name === 'hr') {
      blocks.push({ type: 'hr' })
      idx += 1
      continue
    }
    if (name === 'pre') {
      idx += 1
      // Inner is usually <code>…</code>; gather raw text until </pre>.
      let code = ''
      while (idx < tokens.length && !(tokens[idx]!.type === 'tag' && (tokens[idx] as Tag).name === 'pre')) {
        const t = tokens[idx]!
        if (t.type === 'text') code += decodeEntities(t.value)
        idx += 1
      }
      idx += 1 // </pre>
      blocks.push({ type: 'codeBlock', code: code.replace(/^\n+|\n+$/g, '') })
      continue
    }
    if (/^h[1-6]$/.test(name)) {
      idx += 1
      blocks.push({ type: 'heading', level: clampHeading(Number(name[1])), children: readInline(new Set([name]), []) })
      continue
    }
    if (name === 'p') {
      idx += 1
      blocks.push({ type: 'paragraph', children: readInline(new Set(['p']), []) })
      continue
    }
    if (name === 'blockquote') {
      idx += 1
      blocks.push({
        type: 'quote',
        children: [{ type: 'paragraph', children: readInline(new Set(['blockquote']), []) }],
      })
      continue
    }
    if (name === 'ul' || name === 'ol') {
      idx += 1
      blocks.push({ type: 'list', ordered: name === 'ol', children: readListItems(name) })
      continue
    }
    if (INLINE_MARK[name] || name === 'a') {
      // Bare inline content at the top level → wrap in a paragraph.
      blocks.push({ type: 'paragraph', children: readInline(new Set(), []) })
      continue
    }
    idx += 1
  }
  return normalize(blocks, opts)
}
