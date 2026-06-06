import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { defineEndpoint, initKernel } from '@kernel/core'
import type { Kernel } from '@kernel/core'
import { createRequestHandler } from './index'

let kernel: Kernel
let handler: (req: Request) => Promise<Response>

beforeEach(async () => {
  kernel = await initKernel(
    {
      secret: 'openapi-test',
      db: sqliteAdapter({ url: ':memory:' }),
      collections: [
        {
          slug: 'posts',
          access: { read: () => true },
          fields: [
            { name: 'title', type: 'text', required: true },
            { name: 'views', type: 'number' },
            { name: 'published', type: 'boolean' },
          ],
        },
      ],
      globals: [{ slug: 'settings', fields: [{ name: 'site_name', type: 'text' }] }],
      endpoints: [
        defineEndpoint({
          method: 'POST',
          path: '/comments/:postId',
          input: { body: { parse: (v) => v } },
          access: () => true,
          summary: 'Add a comment',
          tags: ['Comments'],
          handler: () => ({ ok: true }),
        }),
      ],
    },
    { logLevel: 'error' },
  )
  await kernel.migrate()
  handler = createRequestHandler(kernel, {})
})

afterEach(async () => {
  await kernel.destroy()
})

describe('OpenAPI', () => {
  it('serves a 3.0 spec covering collection CRUD', async () => {
    const res = await handler(new Request('http://localhost/api/openapi'))
    expect(res.status).toBe(200)
    const spec = (await res.json()) as {
      openapi: string
      paths: Record<string, Record<string, unknown>>
      components: { schemas: Record<string, { properties?: Record<string, unknown> }> }
    }
    expect(spec.openapi).toBe('3.0.3')
    expect(spec.paths['/posts']?.get).toBeTruthy()
    expect(spec.paths['/posts']?.post).toBeTruthy()
    expect(spec.paths['/posts/{id}']?.patch).toBeTruthy()
    expect(spec.paths['/globals/settings']?.get).toBeTruthy()
    // The collection schema reflects the real fields with mapped types.
    const posts = spec.components.schemas.posts!.properties!
    expect((posts.title as { type: string }).type).toBe('string')
    expect((posts.views as { type: string }).type).toBe('number')
    expect((posts.published as { type: string }).type).toBe('boolean')
    expect(posts.id).toBeTruthy()
  })

  it('documents custom endpoints with converted path params', async () => {
    const res = await handler(new Request('http://localhost/api/openapi'))
    const spec = (await res.json()) as {
      paths: Record<string, Record<string, { summary?: string; parameters?: { name: string }[] }>>
    }
    const op = spec.paths['/comments/{postId}']?.post
    expect(op).toBeTruthy()
    expect(op?.summary).toBe('Add a comment')
    expect(op?.parameters?.[0]?.name).toBe('postId')
  })

  it('serves the Scalar docs UI', async () => {
    const res = await handler(new Request('http://localhost/api/docs'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const body = await res.text()
    expect(body).toContain('@scalar/api-reference')
    expect(body).toContain('/api/openapi')
  })

  it('can be disabled via options', async () => {
    const off = createRequestHandler(kernel, { openapi: false })
    const res = await off(new Request('http://localhost/api/openapi'))
    // With docs off, `/openapi` is no longer reserved; it falls through to normal
    // routing (an unknown collection), so it is never the spec.
    expect(res.status).not.toBe(200)
    const docs = await off(new Request('http://localhost/api/docs'))
    expect(docs.status).not.toBe(200)
  })
})
