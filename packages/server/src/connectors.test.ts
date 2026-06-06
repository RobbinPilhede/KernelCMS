import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { initKernel } from '@kernel/core'
import type { Kernel } from '@kernel/core'
import { localStorage } from '@kernel/storage'
import { createRequestHandler } from './index'

let kernel: Kernel
const SVC = 'svc-key'

beforeEach(async () => {
  kernel = await initKernel(
    {
      secret: 'connectors-test',
      db: sqliteAdapter({ url: ':memory:' }),
      storage: localStorage({ rootDir: './.cx-test', servePath: '/files' }),
      collections: [{ slug: 'posts', access: { read: () => true }, fields: [{ name: 'title', type: 'text' }] }],
    },
    { logLevel: 'error' },
  )
  await kernel.migrate()
})

afterEach(async () => {
  await kernel.destroy()
})

describe('GET /_admin/connectors', () => {
  it('requires authentication', async () => {
    const handler = createRequestHandler(kernel, {})
    const res = await handler(new Request('http://localhost/api/_admin/connectors'))
    expect(res.status).toBe(401)
  })

  it('reports connector inventory for an authenticated admin', async () => {
    const handler = createRequestHandler(kernel, { apiKey: SVC, graphql: true })
    const res = await handler(
      new Request('http://localhost/api/_admin/connectors', { headers: { Authorization: `Bearer ${SVC}` } }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      db: string
      storage: { configured: boolean }
      email: { configured: boolean }
      oauth: string[]
      graphql: boolean
    }
    expect(body.db).toBe('sqlite')
    expect(body.storage.configured).toBe(true)
    expect(body.email.configured).toBe(false)
    expect(Array.isArray(body.oauth)).toBe(true)
    expect(body.graphql).toBe(true)
  })
})
