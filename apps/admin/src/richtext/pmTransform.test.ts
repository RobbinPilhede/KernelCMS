import { describe, expect, it } from 'vitest'
import { resolveRichTextSchema, sanitizeRichText, type KernelRichText } from '@kernel/richtext'
import { buildPMSchema } from './pmSchema'
import { kernelToPM, pmToKernel } from './pmTransform'

const fullSchema = resolveRichTextSchema({ preset: 'full' })
const pmSchema = buildPMSchema(fullSchema)

/** kernel → PM → kernel, then sanitize (mirrors what the editor emits). */
function roundTrip(doc: KernelRichText): KernelRichText {
  return sanitizeRichText(pmToKernel(kernelToPM(doc, pmSchema)), fullSchema).doc
}

function doc(...children: KernelRichText['children']): KernelRichText {
  return { v: 1, type: 'doc', children }
}

describe('kernelToPM / pmToKernel round-trip', () => {
  it('preserves a plain paragraph', () => {
    const input = doc({ type: 'paragraph', children: [{ type: 'text', text: 'hello world' }] })
    expect(roundTrip(input)).toEqual(input)
  })

  it('preserves all heading levels', () => {
    for (const level of [2, 3, 4] as const) {
      const input = doc({ type: 'heading', level, children: [{ type: 'text', text: `H${level}` }] })
      expect(roundTrip(input)).toEqual(input)
    }
  })

  it('preserves each mark independently', () => {
    for (const mark of ['bold', 'italic', 'underline', 'strike', 'code', 'sub', 'sup'] as const) {
      const input = doc({
        type: 'paragraph',
        children: [{ type: 'text', text: 'x', marks: [{ type: mark }] }],
      })
      expect(roundTrip(input)).toEqual(input)
    }
  })

  it('preserves multiple stacked marks on one run', () => {
    const input = doc({
      type: 'paragraph',
      children: [{ type: 'text', text: 'strong+em', marks: [{ type: 'bold' }, { type: 'italic' }] }],
    })
    const out = roundTrip(input)
    const run = (out.children[0] as { children: { marks?: { type: string }[] }[] }).children[0]
    expect(new Set(run.marks?.map((m) => m.type))).toEqual(new Set(['bold', 'italic']))
  })

  it('preserves adjacent runs with differing marks', () => {
    const input = doc({
      type: 'paragraph',
      children: [
        { type: 'text', text: 'plain ' },
        { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
        { type: 'text', text: ' tail' },
      ],
    })
    expect(roundTrip(input)).toEqual(input)
  })

  it('preserves an unordered list', () => {
    const input = doc({
      type: 'list',
      ordered: false,
      children: [
        { type: 'listItem', children: [{ type: 'paragraph', children: [{ type: 'text', text: 'one' }] }] },
        { type: 'listItem', children: [{ type: 'paragraph', children: [{ type: 'text', text: 'two' }] }] },
      ],
    })
    expect(roundTrip(input)).toEqual(input)
  })

  it('preserves an ordered list', () => {
    const input = doc({
      type: 'list',
      ordered: true,
      children: [{ type: 'listItem', children: [{ type: 'paragraph', children: [{ type: 'text', text: 'first' }] }] }],
    })
    expect(roundTrip(input)).toEqual(input)
  })

  it('preserves a nested list', () => {
    const input = doc({
      type: 'list',
      ordered: false,
      children: [
        {
          type: 'listItem',
          children: [
            { type: 'paragraph', children: [{ type: 'text', text: 'outer' }] },
            {
              type: 'list',
              ordered: true,
              children: [
                {
                  type: 'listItem',
                  children: [{ type: 'paragraph', children: [{ type: 'text', text: 'inner' }] }],
                },
              ],
            },
          ],
        },
      ],
    })
    expect(roundTrip(input)).toEqual(input)
  })

  it('preserves a quote with nested blocks', () => {
    const input = doc({
      type: 'quote',
      children: [{ type: 'paragraph', children: [{ type: 'text', text: 'quoted' }] }],
    })
    expect(roundTrip(input)).toEqual(input)
  })

  it('preserves a code block', () => {
    const input = doc({ type: 'codeBlock', code: 'const x = 1\nconst y = 2' })
    expect(roundTrip(input)).toEqual(input)
  })

  it('preserves a horizontal rule between paragraphs', () => {
    const input = doc(
      { type: 'paragraph', children: [{ type: 'text', text: 'above' }] },
      { type: 'hr' },
      { type: 'paragraph', children: [{ type: 'text', text: 'below' }] },
    )
    expect(roundTrip(input)).toEqual(input)
  })

  it('preserves a link', () => {
    const input = doc({
      type: 'paragraph',
      children: [
        { type: 'text', text: 'see ' },
        { type: 'link', url: 'https://example.com', children: [{ type: 'text', text: 'here' }] },
      ],
    })
    expect(roundTrip(input)).toEqual(input)
  })

  it('preserves an internal-doc link across kernel → PM → kernel', () => {
    // Internal links need a schema whose link allow-list includes the collection.
    const internalSchema = resolveRichTextSchema({
      features: [
        { kind: 'marks', allow: ['bold'] },
        { kind: 'link', internal: { collections: ['pages'] } },
      ],
    })
    const pm = buildPMSchema(internalSchema)
    const input = doc({
      type: 'paragraph',
      children: [
        { type: 'text', text: 'go ' },
        {
          type: 'link',
          url: '#',
          doc: { relationTo: 'pages', value: '507f1f77bcf86cd799439011' },
          children: [{ type: 'text', text: 'home' }],
        },
      ],
    })
    const out = sanitizeRichText(pmToKernel(kernelToPM(input, pm)), internalSchema).doc
    const link = (out.children[0] as { children: { type: string; doc?: { relationTo: string; value: string } }[] })
      .children[1]
    expect(link).toMatchObject({
      type: 'link',
      doc: { relationTo: 'pages', value: '507f1f77bcf86cd799439011' },
    })
  })

  it('preserves a new-tab link (sanitizer adds rel)', () => {
    const input = doc({
      type: 'paragraph',
      children: [{ type: 'link', url: 'https://example.com', newTab: true, children: [{ type: 'text', text: 'x' }] }],
    })
    const link = (roundTrip(input).children[0] as { children: { type: string; url?: string; newTab?: boolean }[] })
      .children[0]
    expect(link).toMatchObject({ type: 'link', url: 'https://example.com', newTab: true })
  })

  it('is idempotent across two round-trips', () => {
    const input = doc(
      { type: 'heading', level: 2, children: [{ type: 'text', text: 'Title' }] },
      {
        type: 'paragraph',
        children: [{ type: 'text', text: 'mixed', marks: [{ type: 'bold' }, { type: 'italic' }] }],
      },
      {
        type: 'list',
        ordered: false,
        children: [{ type: 'listItem', children: [{ type: 'paragraph', children: [{ type: 'text', text: 'li' }] }] }],
      },
    )
    const once = roundTrip(input)
    expect(roundTrip(once)).toEqual(once)
  })
})

describe('buildPMSchema honors the allow-list', () => {
  it('omits disabled marks and nodes for the minimal preset', () => {
    const minimal = buildPMSchema(resolveRichTextSchema({ preset: 'minimal' }))
    expect(minimal.marks.strong).toBeDefined()
    expect(minimal.marks.em).toBeDefined()
    expect(minimal.marks.underline).toBeUndefined()
    expect(minimal.marks.code).toBeUndefined()
    expect(minimal.marks.link).toBeUndefined()
    expect(minimal.nodes.heading).toBeUndefined()
    expect(minimal.nodes.bullet_list).toBeUndefined()
    expect(minimal.nodes.blockquote).toBeUndefined()
    expect(minimal.nodes.code_block).toBeUndefined()
    expect(minimal.nodes.horizontal_rule).toBeUndefined()
  })

  it('includes only the enabled heading levels', () => {
    const schema = buildPMSchema(resolveRichTextSchema({ features: [{ kind: 'headings', levels: [3] }] }))
    const heading = schema.nodes.heading
    expect(heading).toBeDefined()
    expect(heading.spec.attrs?.level.default).toBe(3)
  })

  it('omits ordered_list when only unordered lists are enabled', () => {
    const schema = buildPMSchema(
      resolveRichTextSchema({ features: [{ kind: 'lists', unordered: true, ordered: false }] }),
    )
    expect(schema.nodes.bullet_list).toBeDefined()
    expect(schema.nodes.ordered_list).toBeUndefined()
  })

  it('includes link only when enabled', () => {
    const withLink = buildPMSchema(resolveRichTextSchema({ features: [{ kind: 'link' }] }))
    expect(withLink.marks.link).toBeDefined()
  })
})
