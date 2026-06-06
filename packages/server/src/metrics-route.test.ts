import { beforeEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { initKernel, memoryCache, memorySearch } from '@kernel/core'
import type { AuthUser, Kernel } from '@kernel/core'
import { createRequestHandler } from './index'

let kernel: Kernel

beforeEach(async () => {
  kernel = await initKernel(
    {
      secret: 'metrics-test',
      db: sqliteAdapter({ url: ':memory:' }),
      cache: memoryCache(),
      search: memorySearch(),
      collections: [
        {
          slug: 'posts',
          cache: true,
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

const asAdmin = {
  getUser: (): AuthUser => ({ id: '1', collection: 'users' }) as AuthUser,
  rateLimit: { enabled: false },
}

describe('GET /_admin/metrics', () => {
  it('requires authentication', async () => {
    const handler = createRequestHandler(kernel, { rateLimit: { enabled: false } })
    const res = await handler(new Request('http://localhost/api/_admin/metrics'))
    expect(res.status).toBe(401)
  })

  it('reports adapter health and cache stats for an admin', async () => {
    const handler = createRequestHandler(kernel, asAdmin)
    const res = await handler(new Request('http://localhost/api/_admin/metrics'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      version: string
      db: { name: string; health: { status: string } }
      cache: { name: string; stats: { hits: number; misses: number } } | null
      search: { name: string } | null
    }
    expect(body.version).toBeTruthy()
    expect(body.db.health.status).toBe('ok')
    expect(body.cache?.name).toBe('memory')
    expect(body.search?.name).toBe('memory')
    expect(typeof body.cache?.stats.hits).toBe('number')
  })
})
