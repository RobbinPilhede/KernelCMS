import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initKernel, describeConfig } from '@kernel/core'
import type { Kernel } from '@kernel/core'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { seoPlugin } from './index'

let kernel: Kernel
const admin = { overrideAccess: true }

beforeEach(async () => {
  kernel = await initKernel(
    {
      secret: 'seo-test',
      db: sqliteAdapter({ url: ':memory:' }),
      collections: [
        {
          slug: 'posts',
          access: { read: () => true },
          fields: [
            { name: 'title', type: 'text', required: true },
            { name: 'excerpt', type: 'textarea' },
          ],
        },
      ],
      plugins: [seoPlugin({ collections: ['posts'], generateTitleFrom: 'title', generateDescriptionFrom: 'excerpt' })],
    },
    { logLevel: 'error' },
  )
  await kernel.migrate()
})
afterEach(async () => {
  await kernel.destroy()
})

describe('seoPlugin', () => {
  it('injects meta_title and meta_description fields into the target collection', () => {
    const schema = describeConfig(kernel.config)
    const posts = schema.collections.find((c) => c.slug === 'posts')!
    const names = posts.fields.map((f) => f.name)
    expect(names).toContain('meta_title')
    expect(names).toContain('meta_description')
  })

  it('auto-fills meta fields from the configured source fields when blank', async () => {
    const post = await kernel.create({
      collection: 'posts',
      data: { title: 'Launch Day', excerpt: 'Everything you need to know.' },
      ...admin,
    })
    expect(post.meta_title).toBe('Launch Day')
    expect(post.meta_description).toBe('Everything you need to know.')
  })

  it('respects an explicit meta_title over the generated one', async () => {
    const post = await kernel.create({
      collection: 'posts',
      data: { title: 'Launch Day', meta_title: 'Custom SEO Title' },
      ...admin,
    })
    expect(post.meta_title).toBe('Custom SEO Title')
  })
})
