import { describe, expect, it } from 'vitest'
import { toMarkdown, toHTML, toPlainText } from './convert'
import type { KernelRichText, RichBlockNode, RichInlineNode, MarkType } from './types'

const doc = (...children: RichBlockNode[]): KernelRichText => ({ v: 1, type: 'doc', children })
const t = (text: string, marks?: MarkType[]): RichInlineNode => ({
  type: 'text',
  text,
  ...(marks ? { marks: marks.map((m) => ({ type: m })) } : {}),
})
const p = (...kids: RichInlineNode[]): RichBlockNode => ({ type: 'paragraph', children: kids })

describe('toMarkdown', () => {
  it('renders headings at the right level', () => {
    expect(toMarkdown(doc({ type: 'heading', level: 2, children: [t('Title')] }))).toBe('## Title')
    expect(toMarkdown(doc({ type: 'heading', level: 4, children: [t('Deep')] }))).toBe('#### Deep')
  })

  it('renders bold, italic, strike, and inline code marks', () => {
    expect(toMarkdown(doc(p(t('a', ['bold']))))).toBe('**a**')
    expect(toMarkdown(doc(p(t('b', ['italic']))))).toBe('_b_')
    expect(toMarkdown(doc(p(t('c', ['strike']))))).toBe('~~c~~')
    expect(toMarkdown(doc(p(t('d', ['code']))))).toBe('`d`')
  })

  it('wraps nested marks inner→outer in canonical order', () => {
    expect(toMarkdown(doc(p(t('x', ['bold', 'italic']))))).toBe('**_x_**')
  })

  it('renders links as [label](url)', () => {
    const md = toMarkdown(doc(p({ type: 'link', url: 'https://example.com/p', children: [t('here')] })))
    expect(md).toBe('[here](https://example.com/p)')
  })

  it('escapes a draft link URL so parentheses cannot break the markdown', () => {
    const md = toMarkdown(doc(p({ type: 'link', url: 'https://x.test/a(b)', children: [t('link')] })))
    expect(md).not.toContain('(b)')
    expect(md).toContain('%28b%29')
  })

  it('renders unordered and ordered lists', () => {
    const ul = doc({
      type: 'list',
      ordered: false,
      children: [
        { type: 'listItem', children: [p(t('one'))] },
        { type: 'listItem', children: [p(t('two'))] },
      ],
    })
    expect(toMarkdown(ul)).toBe('- one\n- two')

    const ol = doc({
      type: 'list',
      ordered: true,
      children: [
        { type: 'listItem', children: [p(t('first'))] },
        { type: 'listItem', children: [p(t('second'))] },
      ],
    })
    expect(toMarkdown(ol)).toBe('1. first\n2. second')
  })

  it('renders blockquotes with > prefixes', () => {
    const q = doc({ type: 'quote', children: [p(t('quoted'))] })
    expect(toMarkdown(q)).toBe('> quoted')
  })

  it('renders code blocks with the language fence', () => {
    const c = doc({ type: 'codeBlock', language: 'ts', code: 'const x = 1' })
    expect(toMarkdown(c)).toBe('```ts\nconst x = 1\n```')
  })

  it('renders a horizontal rule', () => {
    expect(toMarkdown(doc({ type: 'hr' }))).toBe('---')
  })

  it('escapes structural markdown characters in plain text', () => {
    // A literal asterisk in prose must be escaped so it is not read as emphasis.
    expect(toMarkdown(doc(p(t('5 * 3 = 15'))))).toBe('5 \\* 3 = 15')
  })

  it('does not escape the contents of an inline code run', () => {
    expect(toMarkdown(doc(p(t('a*b', ['code']))))).toBe('`a*b`')
  })

  it('separates blocks with a single blank line', () => {
    const d = doc({ type: 'heading', level: 2, children: [t('H')] }, p(t('body')))
    expect(toMarkdown(d)).toBe('## H\n\nbody')
  })

  it('is consistent with toPlainText/toHTML on the same document (no crash, real content)', () => {
    const d = doc({ type: 'heading', level: 2, children: [t('Title')] }, p(t('Hello '), t('world', ['bold'])))
    expect(toPlainText(d)).toContain('Title')
    expect(toHTML(d)).toContain('<strong>world</strong>')
    expect(toMarkdown(d)).toBe('## Title\n\nHello **world**')
  })
})
