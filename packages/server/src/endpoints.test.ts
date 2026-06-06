import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { defineEndpoint, initKernel } from '@kernel/core'
import type { Kernel, Parser } from '@kernel/core'
import { createRequestHandler } from './index'

// A minimal Zod-compatible validator: throws a `.issues`-shaped error so the
// endpoint pipeline maps it to a ValidationError, exactly like a real Zod schema.
function requireString<K extends string>(key: K): Parser<Record<K, string>> {
  return {
    parse: (value) => {
      const obj = (value ?? {}) as Record<string, unknown>
      if (typeof obj[key] !== 'string' || (obj[key] as string).length === 0) {
        throw { issues: [{ path: [key], message: 'Required' }] }
      }
      return { [key]: obj[key] } as Record<K, string>
    },
  }
}

let kernel: Kernel
let handler: (req: Request) => Promise<Response>

beforeEach(async () => {
  kernel = await initKernel(
    {
      secret: 'endpoints-test',
      db: sqliteAdapter({ url: ':memory:' }),
      collections: [
        { slug: 'posts', access: { read: () => true }, fields: [{ name: 'title', type: 'text' }] },
        {
          slug: 'notes',
          access: { read: () => true, create: () => true },
          fields: [{ name: 'title', type: 'text', required: true }],
        },
      ],
      endpoints: [
        defineEndpoint({
          method: 'GET',
          path: '/echo/:name',
          input: { params: requireString('name') },
          access: () => true,
          handler: ({ input }) => ({ hello: input.params.name }),
        }),
        defineEndpoint({
          method: 'GET',
          path: '/stats',
          access: () => true,
          handler: async ({ ctx }) => ({ posts: await ctx.local.count({ collection: 'posts' }) }),
        }),
        defineEndpoint({
          method: 'POST',
          path: '/notes',
          input: { body: requireString('title') },
          access: () => true,
          handler: async ({ input, ctx }) => {
            const doc = await ctx.local.create({
              collection: 'notes',
              data: { title: input.body.title },
              overrideAccess: true,
            })
            return { id: doc.id, title: doc.title }
          },
        }),
        // No access rule → secure by default (authenticated only).
        defineEndpoint({ method: 'GET', path: '/secret', handler: () => ({ ok: true }) }),
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

describe('custom endpoints', () => {
  it('matches a :param route and returns the handler result', async () => {
    const res = await handler(new Request('http://localhost/api/echo/world'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ hello: 'world' })
  })

  it('gives the handler the Local API via ctx.local', async () => {
    await kernel.create({ collection: 'posts', data: { title: 'a' }, overrideAccess: true })
    await kernel.create({ collection: 'posts', data: { title: 'b' }, overrideAccess: true })
    const res = await handler(new Request('http://localhost/api/stats'))
    expect(await res.json()).toEqual({ posts: 2 })
  })

  it('validates the body and runs the handler on success', async () => {
    const res = await handler(
      new Request('http://localhost/api/notes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Hello' }),
      }),
    )
    expect(res.status).toBe(200)
    const doc = (await res.json()) as { id: string; title: string }
    expect(doc.title).toBe('Hello')
    expect(doc.id).toBeTypeOf('string')
  })

  it('rejects an invalid body through the standard error envelope', async () => {
    const res = await handler(
      new Request('http://localhost/api/notes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; details?: { path: string }[] } }
    expect(body.error.code).toBe('VALIDATION')
    expect(body.error.details?.[0]?.path).toBe('body.title')
  })

  it('is secure by default: an endpoint with no access rule rejects anonymous callers', async () => {
    const res = await handler(new Request('http://localhost/api/secret'))
    expect(res.status).toBe(401)
  })

  it('takes precedence over generic collection routing', async () => {
    // /api/stats would otherwise be a find on a (non-existent) "stats" collection.
    const res = await handler(new Request('http://localhost/api/stats'))
    expect(res.status).toBe(200)
    expect(await res.json()).toHaveProperty('posts')
  })

  it('rejects an oversized custom-endpoint body (DoS guard)', async () => {
    const big = JSON.stringify({ title: 'x'.repeat(2_100_000) }) // > 2 MB
    const res = await handler(
      new Request('http://localhost/api/notes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: big,
      }),
    )
    expect(res.status).toBe(413)
  })
})

describe('custom endpoint route-collision guard', () => {
  it('rejects an endpoint that shadows a built-in auth route', async () => {
    await expect(
      initKernel(
        {
          secret: 'collide',
          db: sqliteAdapter({ url: ':memory:' }),
          collections: [{ slug: 'users', auth: true, fields: [] }],
          endpoints: [
            defineEndpoint({ method: 'POST', path: '/users/login', access: () => true, handler: () => ({}) }),
          ],
        },
        { logLevel: 'error' },
      ),
    ).rejects.toThrow(/auth route/)
  })

  it('rejects an endpoint on a reserved system path', async () => {
    await expect(
      initKernel(
        {
          secret: 'collide',
          db: sqliteAdapter({ url: ':memory:' }),
          collections: [{ slug: 'posts', access: { read: () => true }, fields: [{ name: 'title', type: 'text' }] }],
          endpoints: [defineEndpoint({ method: 'GET', path: '/openapi', access: () => true, handler: () => ({}) })],
        },
        { logLevel: 'error' },
      ),
    ).rejects.toThrow(/reserved/)
  })
})
