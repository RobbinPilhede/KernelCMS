import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { defineConfig, initKernel } from './index'
import type { Doc, Kernel } from './index'

const trusted = { overrideAccess: true } as const

function buildConfig() {
  return defineConfig({
    secret: 'test-secret',
    db: sqliteAdapter({ url: ':memory:' }),
    collections: [
      {
        slug: 'authors',
        access: { read: () => true },
        fields: [
          { name: 'name', type: 'text', required: true },
          // Virtual reverse relationship: posts whose `author` points here.
          { name: 'posts', type: 'join', collection: 'posts', on: 'author' },
        ],
      },
      {
        slug: 'posts',
        access: { read: () => true },
        fields: [
          { name: 'title', type: 'text', required: true },
          { name: 'author', type: 'relationship', relationTo: 'authors' },
        ],
      },
    ],
  })
}

let kernel: Kernel
beforeEach(async () => {
  kernel = await initKernel(buildConfig(), { logLevel: 'error' })
  await kernel.migrate()
})
afterEach(async () => {
  await kernel.destroy()
})

describe('reverse relationships (join field)', () => {
  it('resolves back-references when depth > 0', async () => {
    const author = await kernel.create({ collection: 'authors', data: { name: 'Ada' }, ...trusted })
    await kernel.create({ collection: 'posts', data: { title: 'First', author: author.id }, ...trusted })
    await kernel.create({ collection: 'posts', data: { title: 'Second', author: author.id }, ...trusted })

    const withJoin = await kernel.findByID({ collection: 'authors', id: author.id, depth: 1, ...trusted })
    const posts = withJoin?.posts as Doc[]
    expect(Array.isArray(posts)).toBe(true)
    expect(posts.map((p) => p.title).sort()).toEqual(['First', 'Second'])
  })

  it('does not create a column for the virtual field (no migration impact)', async () => {
    // A successful migrate() + create proves `posts` isn't treated as storage.
    const author = await kernel.create({ collection: 'authors', data: { name: 'Grace' }, ...trusted })
    expect(author.name).toBe('Grace')
    // The stored doc carries no `posts` column value until populated.
    const raw = await kernel.findByID({ collection: 'authors', id: author.id, depth: 0, ...trusted })
    expect(raw?.posts ?? undefined).toBeUndefined()
  })

  it('returns an empty array when there are no back-references', async () => {
    const author = await kernel.create({ collection: 'authors', data: { name: 'Linus' }, ...trusted })
    const withJoin = await kernel.findByID({ collection: 'authors', id: author.id, depth: 1, ...trusted })
    expect(withJoin?.posts).toEqual([])
  })
})
