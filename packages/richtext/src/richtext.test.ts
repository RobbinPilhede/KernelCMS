import { describe, expect, it } from 'vitest'
import {
  emptyRichText,
  isEmptyRichText,
  presetFeatures,
  renderNodes,
  resolveRichTextSchema,
  sanitizeRichText,
  textNode,
  toHTML,
  toPlainText,
  type CreateElement,
  type KernelRichText,
  type RichInlineNode,
} from './index'

// A serializable fake element so the renderer can be unit-tested without React.
interface FakeEl {
  tag: string
  props: Record<string, unknown>
  children: (FakeEl | string)[]
}
const h: CreateElement<FakeEl> = (tag, props, ...children) => ({
  tag,
  props: props ?? {},
  children: children.filter((c) => c !== null && c !== undefined),
})

const standard = resolveRichTextSchema({ preset: 'standard' })
const full = resolveRichTextSchema({
  preset: 'full',
  features: [
    ...presetFeatures('full'),
    { kind: 'link', allowNewTab: true, internal: { collections: ['pages'] } },
    { kind: 'upload', collections: ['media'] },
    { kind: 'relationship', collections: ['authors'] },
    { kind: 'blocks', blocks: ['callout'] },
  ],
})

const doc = (...children: KernelRichText['children']): KernelRichText => ({ v: 1, type: 'doc', children })
const p = (...kids: RichInlineNode[]) => ({ type: 'paragraph' as const, children: kids })

describe('model', () => {
  it('an empty doc is a single empty paragraph and reads as empty', () => {
    const e = emptyRichText()
    expect(e.children).toEqual([{ type: 'paragraph', children: [] }])
    expect(isEmptyRichText(e)).toBe(true)
  })

  it('a doc with text is not empty', () => {
    expect(isEmptyRichText(doc(p(textNode('hello'))))).toBe(false)
  })
})

describe('schema resolution', () => {
  it('the standard preset enables marks, headings 2/3, lists, quote, hr, links', () => {
    expect(standard.marks.has('bold')).toBe(true)
    expect(standard.headingLevels.has(2)).toBe(true)
    expect(standard.headingLevels.has(4)).toBe(false)
    expect(standard.nodes.has('list')).toBe(true)
    expect(standard.link.enabled).toBe(true)
    expect(standard.nodes.has('codeBlock')).toBe(false)
  })
})

describe('sanitize — normalization', () => {
  it('drops empty text nodes and merges adjacent runs with identical marks', () => {
    const input = doc({
      type: 'paragraph',
      children: [textNode(''), textNode('foo', ['bold']), textNode('bar', ['bold']), textNode('baz')],
    })
    const { doc: out } = sanitizeRichText(input, standard)
    const para = out.children[0] as { children: unknown[] }
    expect(para.children).toEqual([
      { type: 'text', text: 'foobar', marks: [{ type: 'bold' }] },
      { type: 'text', text: 'baz' },
    ])
  })

  it('stores marks in canonical order regardless of input order', () => {
    const input = doc({ type: 'paragraph', children: [textNode('x', ['italic', 'bold'])] })
    const { doc: out } = sanitizeRichText(input, standard)
    const t = (out.children[0] as { children: { marks: { type: string }[] }[] }).children[0]
    expect(t.marks.map((m) => m.type)).toEqual(['bold', 'italic'])
  })

  it('a non-document collapses to an empty paragraph', () => {
    expect(sanitizeRichText('legacy string', standard).doc).toEqual(emptyRichText())
    expect(sanitizeRichText(null, standard).doc).toEqual(emptyRichText())
    expect(sanitizeRichText({ foo: 1 }, standard).doc).toEqual(emptyRichText())
  })

  it('is idempotent — sanitize(sanitize(x)) === sanitize(x)', () => {
    const input = doc(
      { type: 'heading', level: 2, children: [textNode('Title')] },
      { type: 'paragraph', children: [textNode('a', ['bold']), textNode('b', ['bold'])] },
    )
    const once = sanitizeRichText(input, standard).doc
    const twice = sanitizeRichText(once, standard).doc
    expect(twice).toEqual(once)
  })
})

describe('sanitize — security & allow-list', () => {
  it('strips marks that are not in the schema', () => {
    const minimal = resolveRichTextSchema({ preset: 'minimal' }) // bold/italic only
    const { doc: out, warnings } = sanitizeRichText(
      doc({ type: 'paragraph', children: [textNode('x', ['code'])] }),
      minimal,
    )
    const t = (out.children[0] as { children: { marks?: unknown }[] }).children[0]
    expect(t.marks).toBeUndefined()
    expect(warnings.some((w) => w.code === 'dropped-mark')).toBe(true)
  })

  it('drops disallowed node types', () => {
    const { doc: out, warnings } = sanitizeRichText(
      doc({ type: 'codeBlock', code: 'rm -rf /' } as never),
      standard, // standard has no codeBlock
    )
    expect(out.children).toEqual([{ type: 'paragraph', children: [] }])
    expect(warnings.some((w) => w.code === 'dropped-node')).toBe(true)
  })

  it('rejects javascript: and data: link schemes, coercing to #', () => {
    const make = (url: string) =>
      doc({ type: 'paragraph', children: [{ type: 'link', url, children: [textNode('click')] }] })
    for (const url of ['javascript:alert(1)', 'data:text/html,<script>', 'vbscript:msgbox']) {
      const { doc: out, warnings } = sanitizeRichText(make(url), standard)
      const link = (out.children[0] as { children: { url: string }[] }).children[0]
      expect(link.url).toBe('#')
      expect(warnings.some((w) => w.code === 'unsafe-link')).toBe(true)
    }
  })

  it('keeps safe link schemes and relative links', () => {
    const make = (url: string) =>
      doc({ type: 'paragraph', children: [{ type: 'link', url, children: [textNode('x')] }] })
    for (const url of ['https://example.com', 'mailto:a@b.c', 'tel:+1', '/about', '#anchor']) {
      const link = (sanitizeRichText(make(url), standard).doc.children[0] as { children: { url: string }[] })
        .children[0]
      expect(link.url).toBe(url)
    }
  })

  it('enforces id shape on inline relationship references', () => {
    const bad = doc(p({ type: 'relationship', relationTo: 'authors', value: '../etc/passwd' }))
    const { doc: out, warnings } = sanitizeRichText(bad, full)
    expect((out.children[0] as { children: unknown[] }).children).toEqual([])
    expect(warnings.some((w) => w.code === 'bad-id')).toBe(true)

    const good = doc(p({ type: 'relationship', relationTo: 'authors', value: 'abc-123_X' }))
    expect((sanitizeRichText(good, full).doc.children[0] as { children: unknown[] }).children).toEqual([
      { type: 'relationship', relationTo: 'authors', value: 'abc-123_X' },
    ])
  })

  it('rejects references to collections not on the allow-list', () => {
    const input = doc({ type: 'upload', relationTo: 'secrets', value: 'x1' } as never)
    const { warnings } = sanitizeRichText(input, full)
    expect(warnings.some((w) => w.code === 'dropped-node')).toBe(true)
  })

  it('caps nesting depth to bound payload size', () => {
    // Build quotes nested deeper than maxDepth (default 6).
    let node: KernelRichText['children'][number] = { type: 'paragraph', children: [textNode('deep')] }
    for (let i = 0; i < 10; i++) node = { type: 'quote', children: [node] }
    const { warnings } = sanitizeRichText(doc(node), full)
    expect(warnings.some((w) => w.code === 'depth-cap')).toBe(true)
  })

  it('drops embedded blocks whose slug is not allowed', () => {
    const input = doc({ type: 'block', blockType: 'evil', data: {} } as never)
    const { warnings } = sanitizeRichText(input, full)
    expect(warnings.some((w) => w.code === 'dropped-node')).toBe(true)
    const ok = doc({ type: 'block', blockType: 'callout', data: { text: 'hi' } } as never)
    expect(sanitizeRichText(ok, full).doc.children[0]).toEqual({
      type: 'block',
      blockType: 'callout',
      data: { text: 'hi' },
    })
  })
})

describe('toPlainText', () => {
  it('flattens headings, paragraphs, and lists to lines', () => {
    const d = doc(
      { type: 'heading', level: 2, children: [textNode('Title')] },
      { type: 'paragraph', children: [textNode('Body '), textNode('text', ['bold'])] },
    )
    expect(toPlainText(d)).toBe('Title\nBody text')
  })
})

describe('toHTML', () => {
  it('escapes text to prevent XSS injection through content', () => {
    const d = doc({ type: 'paragraph', children: [textNode('<script>alert(1)</script>')] })
    expect(toHTML(d)).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>')
  })

  it('wraps marks inner→outer in canonical order', () => {
    const { doc: clean } = sanitizeRichText(
      doc({ type: 'paragraph', children: [textNode('x', ['italic', 'bold'])] }),
      standard,
    )
    expect(toHTML(clean)).toBe('<p><strong><em>x</em></strong></p>')
  })

  it('renders headings, lists, quotes, hr, and code blocks', () => {
    const d = doc(
      { type: 'heading', level: 3, children: [textNode('H')] },
      {
        type: 'list',
        ordered: true,
        children: [{ type: 'listItem', children: [{ type: 'paragraph', children: [textNode('one')] }] }],
      },
      { type: 'hr' },
      { type: 'codeBlock', language: 'ts', code: 'const x = 1 < 2' },
    )
    expect(toHTML(d)).toBe(
      '<h3>H</h3><ol><li><p>one</p></li></ol><hr/><pre><code class="language-ts">const x = 1 &lt; 2</code></pre>',
    )
  })

  it('renders nested marks inner→outer via an injected createElement', () => {
    const { doc: clean } = sanitizeRichText(
      doc({ type: 'paragraph', children: [textNode('x', ['italic', 'bold'])] }),
      standard,
    )
    const [p] = renderNodes(clean, { createElement: h })
    // <p><strong><em>x</em></strong></p>
    expect(p!.tag).toBe('p')
    const strong = p!.children[0] as { tag: string; children: unknown[] }
    expect(strong.tag).toBe('strong')
    const em = strong.children[0] as { tag: string; children: unknown[] }
    expect(em.tag).toBe('em')
    expect(em.children[0]).toBe('x')
  })

  it('renders embedded blocks/uploads via host resolvers and skips them otherwise', () => {
    const d = doc({ type: 'block', blockType: 'callout', data: { text: 'hi' } } as never, {
      type: 'paragraph',
      children: [textNode('after')],
    })
    const withResolver = renderNodes(d, {
      createElement: h,
      resolvers: { block: (n) => h('div', { 'data-block': n.blockType }) },
    })
    expect(withResolver.map((e) => (e as FakeEl).tag)).toEqual(['div', 'p'])
    // Without a resolver the block is skipped (host supplies real markup).
    const noResolver = renderNodes(d, { createElement: h })
    expect(noResolver.map((e) => (e as FakeEl).tag)).toEqual(['p'])
  })

  it('adds target/rel for new-tab links and resolves internal links via resolveHref', () => {
    const { doc: clean } = sanitizeRichText(
      doc({
        type: 'paragraph',
        children: [
          {
            type: 'link',
            url: '#',
            newTab: true,
            doc: { relationTo: 'pages', value: 'home' },
            children: [textNode('Home')],
          },
        ],
      }),
      full,
    )
    const html = toHTML(clean, { resolveHref: (ref) => `/${ref.relationTo}/${ref.value}` })
    expect(html).toBe('<p><a href="/pages/home" target="_blank" rel="noopener noreferrer">Home</a></p>')
  })

  it('neutralizes a javascript: href returned by a host resolveHref', () => {
    const { doc: clean } = sanitizeRichText(
      doc({
        type: 'paragraph',
        children: [{ type: 'link', url: '#', doc: { relationTo: 'pages', value: 'x' }, children: [textNode('Click')] }],
      }),
      full,
    )
    // A hostile resolver must not be able to emit a clickable javascript: URL.
    const html = toHTML(clean, { resolveHref: () => 'javascript:alert(document.cookie)' })
    expect(html).toBe('<p><a href="#">Click</a></p>')
  })
})
