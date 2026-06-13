import { describe, expect, it } from 'vitest'
import { a11yEval, seoEval, policyEval, brandEval, runEvals } from './evals'
import type { ConfigField, EvalRule } from './types'

// The pre-publish eval engine + built-in rules. Pin: blocking vs warn semantics, the
// applies-to scoping, a thrown rule becoming a blocking error, and each built-in's
// happy + unhappy paths.

const fields: ConfigField[] = [
  { name: 'title', type: 'text' },
  { name: 'description', type: 'textarea' },
  { name: 'body', type: 'richText' },
  { name: 'hero', type: 'upload', relationTo: 'media' },
]

const richText = (children: unknown[]) => ({ v: 1, type: 'doc', children })

describe('runEvals', () => {
  it('collects findings and flags blocking error failures', async () => {
    const rules: EvalRule[] = [
      { name: 'r1', run: () => [{ ok: false, severity: 'error', message: 'boom' }] },
      { name: 'r2', blocking: false, run: () => [{ ok: false, severity: 'error', message: 'soft' }] },
      { name: 'r3', run: () => [{ ok: false, severity: 'warn', message: 'meh' }] },
    ]
    const { results, blocking } = await runEvals(rules, { doc: {}, collection: 'posts', req: {} })
    expect(results).toHaveLength(3)
    // Only the blocking + error + failed finding blocks.
    expect(blocking).toHaveLength(1)
    expect(blocking[0]!.rule).toBe('r1')
  })

  it('scopes rules with appliesTo to the matching collection', async () => {
    const rules: EvalRule[] = [
      { name: 'only-posts', appliesTo: ['posts'], run: () => [{ ok: false, severity: 'error', message: 'x' }] },
    ]
    expect((await runEvals(rules, { doc: {}, collection: 'pages', req: {} })).blocking).toHaveLength(0)
    expect((await runEvals(rules, { doc: {}, collection: 'posts', req: {} })).blocking).toHaveLength(1)
  })

  it('turns a thrown rule into a blocking error (fails closed)', async () => {
    const rules: EvalRule[] = [
      {
        name: 'crasher',
        run: () => {
          throw new Error('kaboom')
        },
      },
    ]
    const { blocking } = await runEvals(rules, { doc: {}, collection: 'posts', req: {} })
    expect(blocking).toHaveLength(1)
    expect(blocking[0]!.message).toMatch(/kaboom/)
  })

  it('is a no-op with no rules', async () => {
    expect(await runEvals(undefined, { doc: {}, collection: 'posts', req: {} })).toEqual({ results: [], blocking: [] })
  })
})

describe('seoEval', () => {
  const seo = seoEval({ titleField: 'title', minTitle: 5, maxTitle: 20, descriptionField: 'description' })

  it('passes a well-formed title', async () => {
    const { blocking } = await runEvals([seo], { doc: { title: 'A good title' }, collection: 'p', req: {} })
    expect(blocking).toHaveLength(0)
  })

  it('blocks a title that is too long', async () => {
    const { blocking } = await runEvals([seo], {
      doc: { title: 'x'.repeat(40) },
      collection: 'p',
      req: {},
    })
    expect(blocking).toHaveLength(1)
    expect(blocking[0]!.message).toMatch(/too long/)
  })

  it('blocks a missing title but only warns on a missing description', async () => {
    const { results, blocking } = await runEvals([seo], { doc: {}, collection: 'p', req: {} })
    expect(blocking.some((b) => b.field === 'title')).toBe(true)
    expect(results.some((r) => r.severity === 'warn' && r.field === 'description')).toBe(true)
  })
})

describe('policyEval', () => {
  const policy = policyEval({ bannedTerms: ['forbidden', 'secret-sauce'] })

  it('blocks a banned term in a string field', async () => {
    const { blocking } = await runEvals([policy], {
      doc: { title: 'This is FORBIDDEN content' },
      collection: 'p',
      req: {},
      fields,
    })
    expect(blocking).toHaveLength(1)
    expect(blocking[0]!.message).toMatch(/banned term/i)
  })

  it('blocks a banned term inside richText', async () => {
    const doc = { body: richText([{ type: 'paragraph', children: [{ type: 'text', text: 'the secret-sauce' }] }]) }
    const { blocking } = await runEvals([policy], { doc, collection: 'p', req: {}, fields })
    expect(blocking).toHaveLength(1)
  })

  it('passes clean content', async () => {
    const { blocking } = await runEvals([policy], { doc: { title: 'all good here' }, collection: 'p', req: {}, fields })
    expect(blocking).toHaveLength(0)
  })
})

describe('a11yEval', () => {
  const a11y = a11yEval()

  it('blocks an embedded image with no alt text', async () => {
    const doc = {
      body: richText([{ type: 'upload', relationTo: 'media', value: 'm1' }]),
    }
    const { blocking } = await runEvals([a11y], { doc, collection: 'p', req: {}, fields })
    expect(blocking.some((b) => /alt text/i.test(b.message))).toBe(true)
  })

  it('passes an embedded image that has alt text', async () => {
    const doc = {
      body: richText([{ type: 'upload', relationTo: 'media', value: 'm1', alt: 'A cat' }]),
    }
    const { blocking } = await runEvals([a11y], { doc, collection: 'p', req: {}, fields })
    expect(blocking).toHaveLength(0)
  })

  it('blocks a heading-level skip', async () => {
    const doc = {
      body: richText([
        { type: 'heading', level: 2, children: [{ type: 'text', text: 'H2' }] },
        { type: 'heading', level: 4, children: [{ type: 'text', text: 'H4 (skipped 3)' }] },
      ]),
    }
    const { blocking } = await runEvals([a11y], { doc, collection: 'p', req: {}, fields })
    expect(blocking.some((b) => /heading level jumps/i.test(b.message))).toBe(true)
  })
})

describe('brandEval', () => {
  it('blocks when a required disclaimer is missing', async () => {
    const brand = brandEval({ requiredDisclaimers: ['© Acme Corp'] })
    const { blocking } = await runEvals([brand], { doc: { body: 'no disclaimer here' }, collection: 'p', req: {} })
    expect(blocking).toHaveLength(1)
  })

  it('passes when the disclaimer is present (case-insensitive)', async () => {
    const brand = brandEval({ requiredDisclaimers: ['© Acme Corp'] })
    const { blocking } = await runEvals([brand], {
      doc: { body: 'footer: © acme corp, all rights reserved' },
      collection: 'p',
      req: {},
    })
    expect(blocking).toHaveLength(0)
  })

  it('is a no-op with no disclaimers configured', async () => {
    const { blocking } = await runEvals([brandEval()], { doc: {}, collection: 'p', req: {} })
    expect(blocking).toHaveLength(0)
  })
})
