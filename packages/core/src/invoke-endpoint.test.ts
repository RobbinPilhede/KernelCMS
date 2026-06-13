import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { defineEndpoint, initKernel, invokeEndpoint } from './index'
import type { EndpointConfig, Kernel, Parser, RequestContext } from './index'

// invokeEndpoint is the transport-agnostic core that non-HTTP callers (e.g. the MCP
// server) use to drive a user's defineEndpoint logic in-process. It must enforce the
// SAME access + validation pipeline as the HTTP path, with no Request/Response.

// A minimal Zod-compatible validator: throws a `.issues`-shaped error so the pipeline
// maps it to a ValidationError, exactly like a real Zod schema.
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

const anonReq = (): RequestContext => ({ user: null, locale: 'en', fallbackLocale: false, context: {} })
const userReq = (): RequestContext => ({
  user: { id: 'u1', roles: ['editor'], collection: 'users' },
  locale: 'en',
  fallbackLocale: false,
  context: {},
})

let kernel: Kernel
const endpointsByPath = new Map<string, EndpointConfig>()

beforeEach(async () => {
  const endpoints: EndpointConfig[] = [
    // Authenticated-only via explicit rule; validates body.title; uses ctx.local.
    defineEndpoint({
      method: 'POST',
      path: '/notes',
      input: { body: requireString('title') },
      access: ({ req }) => Boolean(req.user),
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
  ]
  for (const ep of endpoints) endpointsByPath.set(ep.path, ep)
  kernel = await initKernel(
    {
      secret: 'invoke-endpoint-test',
      db: sqliteAdapter({ url: ':memory:' }),
      collections: [
        {
          slug: 'notes',
          access: { read: () => true, create: () => true },
          fields: [{ name: 'title', type: 'text', required: true }],
        },
      ],
      endpoints,
    },
    { logLevel: 'error' },
  )
  await kernel.migrate()
})

afterEach(async () => {
  await kernel.destroy()
})

const get = (path: string): EndpointConfig => {
  const ep = endpointsByPath.get(path)
  if (!ep) throw new Error(`no endpoint ${path}`)
  return ep
}

describe('invokeEndpoint', () => {
  it('runs the handler in-process with valid input and an authorized principal', async () => {
    const result = (await invokeEndpoint(kernel, get('/notes'), {
      input: { body: { title: 'Hello' } },
      req: userReq(),
    })) as { id: string; title: string }
    expect(result.title).toBe('Hello')
    expect(result.id).toBeTypeOf('string')
  })

  it('throws ForbiddenError when the access rule denies an authenticated caller', async () => {
    const denied = defineEndpoint({
      method: 'GET',
      path: '/denied',
      access: () => false,
      handler: () => ({ ok: true }),
    })
    await expect(
      invokeEndpoint(kernel, denied, { req: userReq() }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 })
  })

  it('throws UnauthorizedError (secure-by-default) for an anonymous caller', async () => {
    await expect(
      invokeEndpoint(kernel, get('/secret'), { req: anonReq() }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED', status: 401 })
  })

  it('throws a ValidationError with the HTTP error shape on invalid input', async () => {
    await expect(
      invokeEndpoint(kernel, get('/notes'), { input: { body: {} }, req: userReq() }),
    ).rejects.toMatchObject({
      code: 'VALIDATION',
      status: 400,
      errors: [{ path: 'body.title', message: 'Required' }],
    })
  })
})
