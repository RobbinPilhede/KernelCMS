import { beforeEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { initKernel, memorySearch } from '@kernel/core'
import type { Kernel } from '@kernel/core'
import { createRequestHandler } from './index'

let kernel: Kernel

beforeEach(async () => {
  kernel = await initKernel(
    {
      secret: 'search-route-test',
      db: sqliteAdapter({ url: ':memory:' }),
      search: memorySearch(),
      collections: [
        {
          slug: 'posts',
          search: { fields: ['title'] },
          access: { read: () => true, create: () => true },
          fields: [{ name: 'title', type: 'text' }],
        },
      ],
    },
    { logLevel: 'error' },
  )
  await kernel.migrate()
})

describe('GET /:collection/search', () => {
  it('returns documents matching the query', async () => {
    await kernel.create({ collection: 'posts', data: { title: 'the quick brown fox' }, overrideAccess: true })
    await kernel.create({ collection: 'posts', data: { title: 'lazy dog' }, overrideAccess: true })
    const handler = createRequestHandler(kernel, { rateLimit: { enabled: false } })
    const res = await handler(new Request('http://localhost/api/posts/search?q=fox'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { docs: { title: string }[] }
    expect(body.docs).toHaveLength(1)
    expect(body.docs[0]!.title).toBe('the quick brown fox')
  })

  it('returns an empty list for a no-match query', async () => {
    await kernel.create({ collection: 'posts', data: { title: 'hello' }, overrideAccess: true })
    const handler = createRequestHandler(kernel, { rateLimit: { enabled: false } })
    const res = await handler(new Request('http://localhost/api/posts/search?q=nonexistent'))
    expect(res.status).toBe(200)
    expect(((await res.json()) as { docs: unknown[] }).docs).toHaveLength(0)
  })
})
