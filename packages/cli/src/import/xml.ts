// A tiny, dependency-free XML reader, targeted at WordPress WXR exports — not a general
// XML parser. WXR is a flat-ish RSS document: a <channel> with repeated <item> elements,
// each a bag of text/CDATA leaf elements plus repeated <category>/<wp:postmeta>. We need
// exactly: element nesting, text/CDATA content, and attributes. We deliberately do NOT
// support namespaces-as-semantics, DTDs, entities beyond the basic five, or processing
// instructions — a real export never needs them and a hand-rolled subset keeps us at zero
// runtime deps (the constraint) while staying readable.

/** A parsed XML element. `name` keeps the raw tag (incl. any `wp:` prefix, which WXR
 *  uses as a plain name). `text` is the concatenated direct text/CDATA. Children are in
 *  document order so repeated tags (multiple <category>) are preserved. */
export interface XmlNode {
  name: string
  attrs: Record<string, string>
  children: XmlNode[]
  text: string
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
}

/** Decode the five predefined XML entities plus numeric character references. Unknown
 *  named entities are left verbatim (a WXR export only emits the predefined set + numeric). */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&[a-zA-Z]+;/g, (m) => ENTITIES[m] ?? m)
}

/** Parse an XML document into a tree. Throws on a malformed document (unbalanced tags),
 *  which the adapter turns into a clear "not a valid export" error rather than bad data. */
export function parseXml(input: string): XmlNode {
  const root: XmlNode = { name: '#root', attrs: {}, children: [], text: '' }
  const stack: XmlNode[] = [root]
  let i = 0
  const n = input.length

  // Skip a leading BOM and the XML declaration if present.
  if (input.charCodeAt(0) === 0xfeff) i = 1

  while (i < n) {
    const lt = input.indexOf('<', i)
    if (lt === -1) {
      appendText(stack[stack.length - 1]!, decodeEntities(input.slice(i)))
      break
    }
    if (lt > i) appendText(stack[stack.length - 1]!, decodeEntities(input.slice(i, lt)))

    // CDATA — copied verbatim, no entity decoding (this is how WXR carries post HTML).
    if (input.startsWith('<![CDATA[', lt)) {
      const end = input.indexOf(']]>', lt)
      if (end === -1) throw new Error('Unterminated CDATA section.')
      appendText(stack[stack.length - 1]!, input.slice(lt + 9, end))
      i = end + 3
      continue
    }
    // Comment / declaration / processing instruction — skipped.
    if (input.startsWith('<!--', lt)) {
      const end = input.indexOf('-->', lt)
      if (end === -1) throw new Error('Unterminated comment.')
      i = end + 3
      continue
    }
    if (input.startsWith('<?', lt) || input.startsWith('<!', lt)) {
      const end = input.indexOf('>', lt)
      if (end === -1) throw new Error('Unterminated declaration.')
      i = end + 1
      continue
    }

    const gt = input.indexOf('>', lt)
    if (gt === -1) throw new Error('Unterminated tag.')
    let tag = input.slice(lt + 1, gt).trim()

    if (tag.startsWith('/')) {
      // Closing tag — pop, verifying it matches the open element.
      const name = tag.slice(1).trim()
      const top = stack[stack.length - 1]
      if (!top || top.name !== name) throw new Error(`Mismatched closing tag </${name}>.`)
      stack.pop()
      i = gt + 1
      continue
    }

    const selfClosing = tag.endsWith('/')
    if (selfClosing) tag = tag.slice(0, -1).trim()
    const { name, attrs } = parseTag(tag)
    const node: XmlNode = { name, attrs, children: [], text: '' }
    stack[stack.length - 1]!.children.push(node)
    if (!selfClosing) stack.push(node)
    i = gt + 1
  }

  if (stack.length !== 1) throw new Error('Unbalanced XML document.')
  return root
}

function appendText(node: XmlNode, text: string): void {
  node.text += text
}

/** Split a start-tag's interior into a name + attribute map. */
function parseTag(tag: string): { name: string; attrs: Record<string, string> } {
  const match = /^([^\s]+)\s*(.*)$/s.exec(tag)
  if (!match) return { name: tag, attrs: {} }
  const name = match[1]!
  const attrs: Record<string, string> = {}
  const attrRe = /([^\s=]+)\s*=\s*"([^"]*)"|([^\s=]+)\s*=\s*'([^']*)'/g
  let m: RegExpExecArray | null
  while ((m = attrRe.exec(match[2]!)) !== null) {
    const key = m[1] ?? m[3]!
    const val = m[2] ?? m[4]!
    attrs[key] = decodeEntities(val)
  }
  return { name, attrs }
}

/** First direct child element with the given (prefixed) name, or undefined. */
export function child(node: XmlNode, name: string): XmlNode | undefined {
  return node.children.find((c) => c.name === name)
}

/** All direct child elements with the given name, in document order. */
export function children(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((c) => c.name === name)
}

/** The trimmed text of a named direct child, or '' when absent. */
export function text(node: XmlNode, name: string): string {
  return child(node, name)?.text.trim() ?? ''
}
