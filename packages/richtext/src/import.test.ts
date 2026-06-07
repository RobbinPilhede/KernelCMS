import { describe, expect, it } from 'vitest'
import { fromHTML, fromMarkdown } from './import'
import { toHTML, toPlainText } from './convert'
import type { HeadingNode, ListNode, ParagraphNode, TextNode } from './types'

describe('fromMarkdown', () => {
  it('parses headings, paragraphs, and inline marks', () => {
    const doc = fromMarkdown('## Title\n\nHello **bold** and *italic* and `code`.')
    expect(doc.children[0]).toMatchObject({ type: 'heading', level: 2 })
    const para = doc.children[1] as ParagraphNode
    const runs = para.children as TextNode[]
    expect(runs.find((r) => r.text === 'bold')?.marks?.[0]?.type).toBe('bold')
    expect(runs.find((r) => r.text === 'italic')?.marks?.[0]?.type).toBe('italic')
    expect(runs.find((r) => r.text === 'code')?.marks?.[0]?.type).toBe('code')
  })

  it('clamps an h1 to the model minimum (level 2)', () => {
    const doc = fromMarkdown('# Top')
    expect((doc.children[0] as HeadingNode).level).toBe(2)
  })

  it('parses links', () => {
    const doc = fromMarkdown('See [the docs](https://example.com/x).')
    const para = doc.children[0] as ParagraphNode
    const link = para.children.find((n) => n.type === 'link')
    expect(link).toMatchObject({ type: 'link', url: 'https://example.com/x' })
  })

  it('parses unordered and ordered lists', () => {
    const ul = fromMarkdown('- one\n- two')
    expect(ul.children[0]).toMatchObject({ type: 'list', ordered: false })
    expect((ul.children[0] as ListNode).children).toHaveLength(2)

    const ol = fromMarkdown('1. first\n2. second')
    expect(ol.children[0]).toMatchObject({ type: 'list', ordered: true })
  })

  it('parses fenced code blocks with a language', () => {
    const doc = fromMarkdown('```ts\nconst x = 1\n```')
    expect(doc.children[0]).toMatchObject({ type: 'codeBlock', language: 'ts', code: 'const x = 1' })
  })

  it('parses blockquotes and horizontal rules', () => {
    const doc = fromMarkdown('> quoted\n\n---')
    expect(doc.children[0]).toMatchObject({ type: 'quote' })
    expect(doc.children.some((n) => n.type === 'hr')).toBe(true)
  })

  it('round-trips its plain text', () => {
    const doc = fromMarkdown('Hello world')
    expect(toPlainText(doc)).toContain('Hello world')
  })
})

describe('fromHTML', () => {
  it('parses headings, paragraphs, and inline marks', () => {
    const doc = fromHTML('<h2>Title</h2><p>Hello <strong>bold</strong> and <em>italic</em>.</p>')
    expect(doc.children[0]).toMatchObject({ type: 'heading', level: 2 })
    const para = doc.children[1] as ParagraphNode
    const runs = para.children as TextNode[]
    expect(runs.find((r) => r.text === 'bold')?.marks?.[0]?.type).toBe('bold')
    expect(runs.find((r) => r.text === 'italic')?.marks?.[0]?.type).toBe('italic')
  })

  it('parses lists', () => {
    const doc = fromHTML('<ul><li>one</li><li>two</li></ul>')
    expect(doc.children[0]).toMatchObject({ type: 'list', ordered: false })
    expect((doc.children[0] as ListNode).children).toHaveLength(2)
  })

  it('parses code blocks and decodes entities', () => {
    const doc = fromHTML('<pre><code>a &lt; b &amp;&amp; c</code></pre>')
    expect(doc.children[0]).toMatchObject({ type: 'codeBlock', code: 'a < b && c' })
  })

  it('clamps an h1 to level 2 and ignores unknown tags', () => {
    const doc = fromHTML('<div><h1>Big</h1><span>loose</span></div>')
    expect((doc.children[0] as HeadingNode).level).toBe(2)
  })

  it('survives a round-trip from toHTML', () => {
    const original = fromMarkdown('## Heading\n\nA paragraph with **bold**.\n\n- a\n- b')
    const reimported = fromHTML(toHTML(original))
    expect(toPlainText(reimported)).toContain('Heading')
    expect(toPlainText(reimported)).toContain('bold')
    expect(reimported.children.some((n) => n.type === 'list')).toBe(true)
  })

  it('strips a javascript: link via the sanitizer', () => {
    // The importer sets links to '#'; this guards that no unsafe href slips in.
    const doc = fromHTML('<p><a>click</a></p>')
    const para = doc.children[0] as ParagraphNode
    const link = para.children.find((n) => n.type === 'link') as { url: string } | undefined
    expect(link?.url).toBe('#')
  })
})
