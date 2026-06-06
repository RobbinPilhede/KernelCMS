import { afterEach, describe, expect, it } from 'vitest'
import { ValidationError } from '@kernel/core'
import { asSystem, createTestKernel, expectRejection, seed, type TestKernel } from './index'

let kernel: TestKernel
afterEach(async () => {
  await kernel?.destroy()
})

describe('createTestKernel', () => {
  it('boots a migrated in-memory kernel with sensible defaults', async () => {
    kernel = await createTestKernel({
      collections: [
        { slug: 'posts', access: { read: () => true }, fields: [{ name: 'title', type: 'text', required: true }] },
      ],
    })
    const doc = await kernel.create({ collection: 'posts', data: { title: 'Hi' }, ...asSystem })
    expect(doc.title).toBe('Hi')
  })
})

describe('seed', () => {
  it('inserts fixtures keyed by slug, in order', async () => {
    kernel = await createTestKernel({
      collections: [
        { slug: 'authors', access: { read: () => true }, fields: [{ name: 'name', type: 'text', required: true }] },
        { slug: 'posts', access: { read: () => true }, fields: [{ name: 'title', type: 'text', required: true }] },
      ],
    })
    const { authors, posts } = await kernel.seed({
      authors: [{ name: 'Ada' }, { name: 'Linus' }],
      posts: [{ title: 'First' }],
    })
    expect(authors.map((a) => a.name)).toEqual(['Ada', 'Linus'])
    expect(posts).toHaveLength(1)
    const all = await kernel.find({ collection: 'authors', ...asSystem })
    expect(all.totalDocs).toBe(2)
  })

  it('the standalone seed() helper works against any kernel', async () => {
    kernel = await createTestKernel({
      collections: [{ slug: 'tags', access: { read: () => true }, fields: [{ name: 'name', type: 'text' }] }],
    })
    const { tags } = await seed(kernel, { tags: [{ name: 'x' }] })
    expect(tags[0]!.name).toBe('x')
  })
})

describe('expectRejection', () => {
  it('captures a rejection and matches the error class', async () => {
    kernel = await createTestKernel({
      collections: [
        { slug: 'posts', access: { read: () => true }, fields: [{ name: 'title', type: 'text', required: true }] },
      ],
    })
    const err = await expectRejection(kernel.create({ collection: 'posts', data: {}, ...asSystem }), ValidationError)
    expect(err).toBeInstanceOf(ValidationError)
  })

  it('throws when the promise unexpectedly resolves', async () => {
    await expect(expectRejection(Promise.resolve('ok'))).rejects.toThrow(/expected the promise to reject/i)
  })
})
