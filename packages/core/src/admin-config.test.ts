import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { describeConfig, initKernel } from './index'
import type { Doc, Kernel } from './index'

const trusted = { overrideAccess: true } as const

type Item = Doc & { title: string; rank: number }

let kernel: Kernel

beforeEach(async () => {
  kernel = await initKernel(
    {
      secret: 'admin-config-test',
      db: sqliteAdapter({ url: ':memory:' }),
      collections: [
        {
          slug: 'items',
          access: { read: () => true, create: () => true, update: () => true },
          admin: { defaultSort: '-rank' },
          fields: [
            { name: 'title', type: 'text' },
            { name: 'rank', type: 'number' },
          ],
        },
        {
          slug: 'secrets',
          access: { read: () => true },
          admin: { livePreview: false },
          fields: [{ name: 'value', type: 'text' }],
        },
        {
          slug: 'pages',
          access: { read: () => true },
          admin: { livePreview: { url: 'https://example.com/preview' } },
          fields: [{ name: 'title', type: 'text' }],
        },
      ],
    },
    { logLevel: 'error' },
  )
  await kernel.migrate()
  for (const [title, rank] of [
    ['a', 1],
    ['b', 3],
    ['c', 2],
  ] as const) {
    await kernel.create({ collection: 'items', data: { title, rank }, ...trusted })
  }
})

afterEach(async () => {
  await kernel.destroy()
})

describe('collection default sort', () => {
  it('orders find() by admin.defaultSort when no sort is passed', async () => {
    const list = await kernel.find<Item>({ collection: 'items', ...trusted })
    expect(list.docs.map((d) => d.title)).toEqual(['b', 'c', 'a']) // -rank: 3, 2, 1
  })

  it('lets an explicit sort override the default', async () => {
    const list = await kernel.find<Item>({ collection: 'items', sort: 'rank', ...trusted })
    expect(list.docs.map((d) => d.title)).toEqual(['a', 'c', 'b']) // rank asc: 1, 2, 3
  })

  it('surfaces defaultSort in the admin descriptor', async () => {
    const schema = describeConfig(kernel.config)
    const items = schema.collections.find((c) => c.slug === 'items')!
    expect(items.defaultSort).toBe('-rank')
  })
})

describe('live preview opt-out', () => {
  it('passes livePreview: false through the descriptor to disable the pane', () => {
    const schema = describeConfig(kernel.config)
    const secrets = schema.collections.find((c) => c.slug === 'secrets')!
    expect(secrets.livePreview).toBe(false)
  })

  it('passes a custom livePreview url through unchanged', () => {
    const schema = describeConfig(kernel.config)
    const pages = schema.collections.find((c) => c.slug === 'pages')!
    expect(pages.livePreview).toEqual({ url: 'https://example.com/preview' })
  })

  it('omits livePreview entirely when unset (built-in renderer)', () => {
    const schema = describeConfig(kernel.config)
    const items = schema.collections.find((c) => c.slug === 'items')!
    expect('livePreview' in items).toBe(false)
  })
})
