import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { initKernel } from '@kernel/core'
import type { Kernel } from '@kernel/core'
import { createRequestHandler, toNodeListener } from './index'

let kernel: Kernel

beforeEach(async () => {
  kernel = await initKernel(
    {
      secret: 'sec-hardening-test',
      db: sqliteAdapter({ url: ':memory:' }),
      collections: [{ slug: 'posts', access: { read: () => true }, fields: [{ name: 'title', type: 'text' }] }],
    },
    { logLevel: 'error' },
  )
  await kernel.migrate()
})

afterEach(async () => {
  await kernel.destroy()
})

describe('M1 — admin CSP locks scripts to a hash (no unsafe-inline/eval)', () => {
  it('serves a hash-based script-src and no unsafe directives', async () => {
    const handler = createRequestHandler(kernel, { admin: true })
    const res = await handler(new Request('http://localhost/admin'))
    const csp = res.headers.get('content-security-policy') ?? ''
    const scriptSrc = csp.split(';').find((d) => d.trim().startsWith('script-src')) ?? ''
    expect(scriptSrc).toContain("'self'")
    expect(scriptSrc).toMatch(/'sha256-[A-Za-z0-9+/=]+'/)
    // The whole point of M1: the script directive trusts neither inline nor eval.
    expect(scriptSrc).not.toContain("'unsafe-inline'")
    expect(scriptSrc).not.toContain("'unsafe-eval'")
    expect(csp).toMatch(/object-src 'none'/)
    expect(csp).toMatch(/frame-ancestors 'self'/)
  })

  it('allow-lists an injected external script origin in script-src', async () => {
    const handler = createRequestHandler(kernel, { admin: { scripts: ['https://cdn.example.com/widget.js'] } })
    const res = await handler(new Request('http://localhost/admin'))
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toMatch(/script-src[^;]*https:\/\/cdn\.example\.com/)
  })
})

describe('L1 — OpenAPI/docs can be disabled', () => {
  it('serves the spec by default', async () => {
    const handler = createRequestHandler(kernel, {})
    expect((await handler(new Request('http://localhost/api/openapi'))).status).toBe(200)
  })

  it('returns 404 for /openapi and /docs when openapi:false', async () => {
    const handler = createRequestHandler(kernel, { openapi: false })
    expect((await handler(new Request('http://localhost/api/openapi'))).status).toBe(404)
    expect((await handler(new Request('http://localhost/api/docs'))).status).toBe(404)
  })
})

describe('L2 — unknown where field is a 400, not a 500', () => {
  it('rejects a filter on a field the collection does not have', async () => {
    const handler = createRequestHandler(kernel, {})
    const res = await handler(new Request('http://localhost/api/posts?where[secret][equals]=x'))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('BAD_REQUEST')
  })

  it('still allows a filter on a real field', async () => {
    const handler = createRequestHandler(kernel, {})
    const res = await handler(new Request('http://localhost/api/posts?where[title][equals]=hello'))
    expect(res.status).toBe(200)
  })

  it('rejects an unsupported operator with 400 (not 500)', async () => {
    const handler = createRequestHandler(kernel, {})
    const res = await handler(new Request('http://localhost/api/posts?where[title][regex]=^h'))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('BAD_REQUEST')
  })
})

describe('L3 — forbidden HTTP methods return 405, not 500', () => {
  function runListener(method: string): Promise<{ status: number; allow: string | undefined }> {
    const listener = toNodeListener(createRequestHandler(kernel, {}))
    return new Promise((resolve) => {
      const req = new EventEmitter() as EventEmitter & Record<string, unknown>
      req.method = method
      req.url = '/api/posts'
      req.headers = { host: 'localhost' }
      req.socket = { remoteAddress: '127.0.0.1' }
      req.destroy = () => {}
      const headers: Record<string, string> = {}
      const res = {
        statusCode: 200,
        setHeader: (k: string, v: string) => {
          headers[k.toLowerCase()] = String(v)
        },
        end: () => resolve({ status: res.statusCode, allow: headers['allow'] }),
      }
      listener(req as never, res as never)
      req.emit('end')
    })
  }

  it('answers TRACE with 405 and an Allow header', async () => {
    const { status, allow } = await runListener('TRACE')
    expect(status).toBe(405)
    expect(allow).toContain('GET')
  })

  it('answers CONNECT with 405', async () => {
    expect((await runListener('CONNECT')).status).toBe(405)
  })
})
