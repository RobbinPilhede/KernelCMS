import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import type { Doc, Kernel, RequestContext } from './index'
import { initKernel, memorySearch } from './index'

describe('memorySearch through a real kernel', () => {
  let kernel: Kernel

  beforeEach(async () => {
    kernel = await initKernel(
      {
        secret: 'search-test',
        db: sqliteAdapter({ url: ':memory:' }),
        search: memorySearch(),
        collections: [
          {
            slug: 'posts',
            search: { fields: ['title', 'body'] },
            access: { read: () => true, create: () => true, update: () => true, delete: () => true },
            fields: [
              { name: 'title', type: 'text' },
              { name: 'body', type: 'text' },
            ],
          },
          {
            // Row-level read scope: a reader only sees their own docs.
            slug: 'secrets',
            search: { fields: ['label'] },
            access: {
              read: (args: { req: RequestContext }) =>
                args.req.user ? { owner: { equals: args.req.user.id } } : false,
              create: () => true,
            },
            fields: [
              { name: 'label', type: 'text' },
              { name: 'owner', type: 'text' },
            ],
          },
        ],
      },
      { logLevel: 'error' },
    )
    await kernel.migrate()
  })

  afterEach(async () => {
    await kernel.destroy()
  })

  it('finds documents by indexed text, ranked by term overlap', async () => {
    await kernel.create({
      collection: 'posts',
      data: { title: 'Coffee brewing guide', body: 'pour over' },
      overrideAccess: true,
    })
    await kernel.create({
      collection: 'posts',
      data: { title: 'Tea steeping', body: 'green tea' },
      overrideAccess: true,
    })
    await kernel.create({
      collection: 'posts',
      data: { title: 'Coffee and tea', body: 'both drinks' },
      overrideAccess: true,
    })

    const { docs } = await kernel.searchDocs<Doc & { title: string }>({
      collection: 'posts',
      query: 'coffee tea',
      overrideAccess: true,
    })
    // The doc matching both terms ranks first.
    expect(docs[0]!.title).toBe('Coffee and tea')
    expect(docs.length).toBe(3)
  })

  it('returns nothing for an empty query', async () => {
    await kernel.create({ collection: 'posts', data: { title: 'hello', body: '' }, overrideAccess: true })
    const { docs } = await kernel.searchDocs({ collection: 'posts', query: '   ', overrideAccess: true })
    expect(docs).toHaveLength(0)
  })

  it('drops a deleted document from the index', async () => {
    const d = await kernel.create({
      collection: 'posts',
      data: { title: 'ephemeral note', body: '' },
      overrideAccess: true,
    })
    expect(
      (await kernel.searchDocs({ collection: 'posts', query: 'ephemeral', overrideAccess: true })).docs,
    ).toHaveLength(1)
    await kernel.delete({ collection: 'posts', id: d.id, overrideAccess: true })
    expect(
      (await kernel.searchDocs({ collection: 'posts', query: 'ephemeral', overrideAccess: true })).docs,
    ).toHaveLength(0)
  })

  it('re-indexes on update', async () => {
    const d = await kernel.create({ collection: 'posts', data: { title: 'aardvark', body: '' }, overrideAccess: true })
    await kernel.update({ collection: 'posts', id: d.id, data: { title: 'zebra' }, overrideAccess: true })
    expect(
      (await kernel.searchDocs({ collection: 'posts', query: 'aardvark', overrideAccess: true })).docs,
    ).toHaveLength(0)
    expect((await kernel.searchDocs({ collection: 'posts', query: 'zebra', overrideAccess: true })).docs).toHaveLength(
      1,
    )
  })

  it('respects read access: hits the caller cannot read are filtered out', async () => {
    await kernel.create({ collection: 'secrets', data: { label: 'alpha plan', owner: 'u1' }, overrideAccess: true })
    await kernel.create({ collection: 'secrets', data: { label: 'alpha plan', owner: 'u2' }, overrideAccess: true })
    // u1 searches "alpha": the index has two matches, but access loading drops u2's.
    const asU1: Partial<RequestContext> = { user: { id: 'u1', collection: 'users' } as never }
    const { docs } = await kernel.searchDocs<Doc & { owner: string }>({
      collection: 'secrets',
      query: 'alpha',
      req: asU1,
    })
    expect(docs).toHaveLength(1)
    expect(docs[0]!.owner).toBe('u1')
  })

  it('throws when the collection has no search configured', async () => {
    await expect(kernel.searchDocs({ collection: 'unknown', query: 'x', overrideAccess: true })).rejects.toThrow()
  })
})
