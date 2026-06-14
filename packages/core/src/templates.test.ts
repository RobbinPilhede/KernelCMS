import { describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { defineConfig } from './index'
import { sanitizeConfig } from './config'
import { mergeTemplateData, sanitizeTemplates, TemplateMergeError } from './templates'
import type { CollectionConfig } from './types'

// Content templates: named document skeletons. These tests pin down the config-validation
// (unique snake_case slug, real non-system collection, plain-object pollution-free `data`,
// frozen/cloned storage + slug index) and the merge semantics (caller-wins deep-merge with a
// hard prototype-pollution guard on the untrusted override).

function noopAssert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const collectionsBySlug: Record<string, CollectionConfig> = {
  posts: { slug: 'posts', fields: [{ name: 'title', type: 'text' }] },
}
const systemSlugs = new Set(['kernel_jobs'])

describe('sanitizeTemplates — config validation', () => {
  it('resolves templates and builds a slug index', () => {
    const { templates, templatesBySlug } = sanitizeTemplates(
      [
        { slug: 'landing', collection: 'posts', name: 'Landing', data: { title: 'Untitled' } },
        { slug: 'note', collection: 'posts', data: { title: 'Quick note' } },
      ],
      collectionsBySlug,
      systemSlugs,
      noopAssert,
    )
    expect(templates).toHaveLength(2)
    expect(Object.keys(templatesBySlug).sort()).toEqual(['landing', 'note'])
    expect(templatesBySlug.landing!.data.title).toBe('Untitled')
  })

  it('deep-freezes the stored template data (callers cannot mutate config)', () => {
    const { templatesBySlug } = sanitizeTemplates(
      [{ slug: 'landing', collection: 'posts', data: { title: 'x', layout: [{ blockType: 'hero' }] } }],
      collectionsBySlug,
      systemSlugs,
      noopAssert,
    )
    const data = templatesBySlug.landing!.data
    expect(Object.isFrozen(data)).toBe(true)
    expect(Object.isFrozen(data.layout)).toBe(true)
    expect(() => {
      ;(data as { title: string }).title = 'mutated'
    }).toThrow()
  })

  it('rejects a non-snake_case slug', () => {
    expect(() =>
      sanitizeTemplates(
        [{ slug: 'Landing-Page', collection: 'posts', data: {} }],
        collectionsBySlug,
        systemSlugs,
        noopAssert,
      ),
    ).toThrow(/snake_case/)
  })

  it('rejects a duplicate slug', () => {
    expect(() =>
      sanitizeTemplates(
        [
          { slug: 'dup', collection: 'posts', data: {} },
          { slug: 'dup', collection: 'posts', data: {} },
        ],
        collectionsBySlug,
        systemSlugs,
        noopAssert,
      ),
    ).toThrow(/duplicate template slug/)
  })

  it('rejects an unknown or system collection', () => {
    expect(() =>
      sanitizeTemplates([{ slug: 't', collection: 'ghosts', data: {} }], collectionsBySlug, systemSlugs, noopAssert),
    ).toThrow(/unknown collection/)
    expect(() =>
      sanitizeTemplates(
        [{ slug: 't', collection: 'kernel_jobs', data: {} }],
        { ...collectionsBySlug, kernel_jobs: { slug: 'kernel_jobs', fields: [] } },
        systemSlugs,
        noopAssert,
      ),
    ).toThrow(/unknown collection/)
  })

  it('rejects non-object data', () => {
    expect(() =>
      sanitizeTemplates(
        [{ slug: 't', collection: 'posts', data: [] as unknown as Record<string, unknown> }],
        collectionsBySlug,
        systemSlugs,
        noopAssert,
      ),
    ).toThrow(/must be a plain object/)
  })

  it('rejects a prototype-pollution key anywhere in data', () => {
    const hostile = JSON.parse('{"layout":[{"__proto__":{"polluted":true}}]}') as Record<string, unknown>
    expect(() =>
      sanitizeTemplates(
        [{ slug: 't', collection: 'posts', data: hostile }],
        collectionsBySlug,
        systemSlugs,
        noopAssert,
      ),
    ).toThrow(/illegal key/)
  })

  it('is empty when no templates are configured', () => {
    expect(sanitizeTemplates(undefined, collectionsBySlug, systemSlugs, noopAssert).templates).toEqual([])
  })
})

describe('mergeTemplateData — caller-wins deep-merge + proto guard', () => {
  it('caller data overrides template defaults', () => {
    const merged = mergeTemplateData({ title: 'Default', status: 'draft' }, { title: 'Custom' })
    expect(merged).toEqual({ title: 'Custom', status: 'draft' })
  })

  it('deep-merges nested objects (caller wins per leaf)', () => {
    const merged = mergeTemplateData({ meta: { a: 1, b: 2 } }, { meta: { b: 3 } })
    expect(merged).toEqual({ meta: { a: 1, b: 3 } })
  })

  it('replaces arrays wholesale (no positional splice)', () => {
    const merged = mergeTemplateData({ layout: [{ blockType: 'hero' }] }, { layout: [{ blockType: 'cta' }] })
    expect(merged).toEqual({ layout: [{ blockType: 'cta' }] })
  })

  it('does not mutate or return the frozen base', () => {
    const base = Object.freeze({ title: 'x', layout: Object.freeze([Object.freeze({ blockType: 'hero' })]) })
    const merged = mergeTemplateData(base, { title: 'y' })
    expect(merged).not.toBe(base)
    expect(base.title).toBe('x')
    expect(Object.isFrozen(merged)).toBe(false)
  })

  it('rejects a prototype-pollution key in the override', () => {
    const hostile = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>
    expect(() => mergeTemplateData({ title: 'x' }, hostile)).toThrow(TemplateMergeError)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe('sanitizeConfig integration', () => {
  it('exposes resolved templates + slug index on the sanitized config', () => {
    const sanitized = sanitizeConfig(
      defineConfig({
        secret: 'test-secret',
        db: sqliteAdapter({ url: ':memory:' }),
        collections: [{ slug: 'posts', fields: [{ name: 'title', type: 'text' }] }],
        templates: [{ slug: 'landing', collection: 'posts', name: 'Landing', data: { title: 'Untitled' } }],
      }),
    )
    expect(sanitized.templates).toHaveLength(1)
    expect(sanitized.templatesBySlug.landing!.collection).toBe('posts')
  })

  it('defaults to no templates when unconfigured', () => {
    const sanitized = sanitizeConfig(
      defineConfig({
        secret: 'test-secret',
        db: sqliteAdapter({ url: ':memory:' }),
        collections: [{ slug: 'posts', fields: [{ name: 'title', type: 'text' }] }],
      }),
    )
    expect(sanitized.templates).toEqual([])
    expect(sanitized.templatesBySlug).toEqual({})
  })
})
