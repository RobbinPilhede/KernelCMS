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
      { slug: 'posts', access: { read: () => true }, fields: [{ name: 'title', type: 'text' }] },
      { slug: 'pages', access: { read: () => true }, fields: [{ name: 'heading', type: 'text' }] },
      {
        slug: 'comments',
        access: { read: () => true, create: () => true },
        fields: [
          { name: 'body', type: 'text' },
          // Polymorphic: may point at a post OR a page.
          { name: 'subject', type: 'relationship', relationTo: ['posts', 'pages'] },
          { name: 'mentions', type: 'relationship', relationTo: ['posts', 'pages'], hasMany: true },
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

describe('polymorphic relationships', () => {
  it('stores and populates a ref against the right collection', async () => {
    const post = await kernel.create({ collection: 'posts', data: { title: 'A Post' }, ...trusted })
    const comment = await kernel.create({
      collection: 'comments',
      data: { body: 'nice', subject: { relationTo: 'posts', value: post.id } },
      ...trusted,
    })

    const populated = await kernel.findByID({ collection: 'comments', id: comment.id, depth: 1, ...trusted })
    const subject = populated?.subject as { relationTo: string; value: Doc }
    expect(subject.relationTo).toBe('posts')
    expect(subject.value.title).toBe('A Post')
  })

  it('resolves each ref from its own collection (truly polymorphic)', async () => {
    const page = await kernel.create({ collection: 'pages', data: { heading: 'Home' }, ...trusted })
    const comment = await kernel.create({
      collection: 'comments',
      data: { body: 'on a page', subject: { relationTo: 'pages', value: page.id } },
      ...trusted,
    })

    const populated = await kernel.findByID({ collection: 'comments', id: comment.id, depth: 1, ...trusted })
    const subject = populated?.subject as { relationTo: string; value: Doc }
    expect(subject.relationTo).toBe('pages')
    expect(subject.value.heading).toBe('Home')
  })

  it('leaves refs unpopulated at depth 0', async () => {
    const post = await kernel.create({ collection: 'posts', data: { title: 'Raw' }, ...trusted })
    const comment = await kernel.create({
      collection: 'comments',
      data: { subject: { relationTo: 'posts', value: post.id } },
      ...trusted,
    })
    const raw = await kernel.findByID({ collection: 'comments', id: comment.id, depth: 0, ...trusted })
    expect(raw?.subject).toEqual({ relationTo: 'posts', value: post.id })
  })

  it('populates a hasMany polymorphic list across collections', async () => {
    const post = await kernel.create({ collection: 'posts', data: { title: 'P1' }, ...trusted })
    const page = await kernel.create({ collection: 'pages', data: { heading: 'PG1' }, ...trusted })
    const comment = await kernel.create({
      collection: 'comments',
      data: {
        mentions: [
          { relationTo: 'posts', value: post.id },
          { relationTo: 'pages', value: page.id },
        ],
      },
      ...trusted,
    })

    const populated = await kernel.findByID({ collection: 'comments', id: comment.id, depth: 1, ...trusted })
    const mentions = populated?.mentions as Array<{ relationTo: string; value: Doc }>
    expect(mentions).toHaveLength(2)
    expect(mentions[0]!.value.title).toBe('P1')
    expect(mentions[1]!.value.heading).toBe('PG1')
  })
})
