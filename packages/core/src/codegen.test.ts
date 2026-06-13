import { describe, expect, it } from 'vitest'
import { generateTypes } from './codegen'
import type { CollectionConfig, GlobalConfig } from './types'

function gen(collections: CollectionConfig[], globals: GlobalConfig[] = []): string {
  return generateTypes({ collections, globals })
}

describe('generateTypes — relationships', () => {
  it('renders a single relationship as Relationship<Related>', () => {
    const out = gen([
      { slug: 'authors', fields: [{ name: 'name', type: 'text', required: true }] },
      { slug: 'posts', fields: [{ name: 'author', type: 'relationship', relationTo: 'authors' }] },
    ])
    expect(out).toContain('export type Relationship<T> = string | T')
    expect(out).toContain('author?: Relationship<Authors> | null')
  })

  it('renders a hasMany relationship as Relationship<Related>[]', () => {
    const out = gen([
      { slug: 'categories', fields: [{ name: 'name', type: 'text', required: true }] },
      {
        slug: 'posts',
        fields: [{ name: 'categories', type: 'relationship', relationTo: 'categories', hasMany: true }],
      },
    ])
    expect(out).toContain('categories?: Relationship<Categories>[] | null')
  })

  it('renders a polymorphic relationship as a union of every target', () => {
    const out = gen([
      { slug: 'authors', fields: [{ name: 'name', type: 'text', required: true }] },
      { slug: 'pages', fields: [{ name: 'title', type: 'text', required: true }] },
      {
        slug: 'comments',
        fields: [{ name: 'on', type: 'relationship', relationTo: ['authors', 'pages'] }],
      },
    ])
    expect(out).toContain('on?: Relationship<Authors | Pages> | null')
  })

  it('renders an upload relationship the same way', () => {
    const out = gen([
      { slug: 'media', upload: true, fields: [{ name: 'alt', type: 'text' }] },
      { slug: 'posts', fields: [{ name: 'hero', type: 'upload', relationTo: 'media' }] },
    ])
    expect(out).toContain('hero?: Relationship<Media> | null')
  })

  it('falls back to a permissive object for an unknown relationship target', () => {
    const out = gen([{ slug: 'posts', fields: [{ name: 'owner', type: 'relationship', relationTo: 'users' }] }])
    expect(out).toContain('owner?: Relationship<Record<string, unknown>> | null')
  })

  it('omits the Relationship helper when no field uses it', () => {
    const out = gen([{ slug: 'authors', fields: [{ name: 'name', type: 'text', required: true }] }])
    expect(out).not.toContain('export type Relationship')
  })
})

describe('generateTypes — blocks (page builder)', () => {
  it('renders a blocks field as a discriminated union keyed on blockType', () => {
    const out = gen([
      {
        slug: 'pages',
        fields: [
          {
            name: 'layout',
            type: 'blocks',
            blocks: [
              { slug: 'hero', fields: [{ name: 'heading', type: 'text', required: true }] },
              {
                slug: 'cta',
                fields: [
                  { name: 'label', type: 'text', required: true },
                  { name: 'href', type: 'text' },
                ],
              },
            ],
          },
        ],
      },
    ])
    // Each variant carries its blockType literal discriminant + its own fields.
    expect(out).toContain('{ blockType: "hero" } &')
    expect(out).toContain('{ blockType: "cta" } &')
    expect(out).toContain('heading: string')
    expect(out).toContain('label: string')
    // Joined into one Array<...> union under the field name.
    expect(out).toMatch(/layout\?: Array<\(.*\) \| \(.*\)> \| null/s)
  })

  it('renders an empty blocks list permissively', () => {
    const out = gen([{ slug: 'pages', fields: [{ name: 'layout', type: 'blocks', blocks: [] }] }])
    expect(out).toContain('layout?: Array<Record<string, unknown>> | null')
  })
})

describe('generateTypes — scalar + container fields stay correct', () => {
  it('keeps selects, arrays, groups, points and richText as before', () => {
    const out = gen([
      {
        slug: 'widgets',
        fields: [
          { name: 'kind', type: 'select', options: ['a', 'b'], required: true },
          { name: 'tags', type: 'select', options: ['x', 'y'], hasMany: true },
          { name: 'rows', type: 'array', fields: [{ name: 'qty', type: 'number', required: true }] },
          { name: 'meta', type: 'group', fields: [{ name: 'note', type: 'text' }] },
          { name: 'loc', type: 'point' },
          { name: 'body', type: 'richText' },
        ],
      },
    ])
    expect(out).toContain('kind: "a" | "b"')
    expect(out).toContain('tags?: Array<"x" | "y"> | null')
    expect(out).toContain('qty: number')
    expect(out).toContain('note?: string | null')
    expect(out).toContain('loc?: [number, number] | null')
    expect(out).toContain("body?: import('kernelcms/richtext').KernelRichText | null")
  })
})
