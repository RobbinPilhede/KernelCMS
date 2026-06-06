import { beforeEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { initKernel } from '@kernel/core'
import type { Kernel } from '@kernel/core'
import { createRequestHandler } from './index'
import { HEADER_REMOTE_ADDR, isAuthRoute, memoryRateLimitStore, rateLimitCheck, resolveRateLimit } from './rate-limit'

let kernel: Kernel

beforeEach(async () => {
  kernel = await initKernel(
    {
      secret: 'rl-test',
      db: sqliteAdapter({ url: ':memory:' }),
      collections: [
        { slug: 'posts', access: { read: () => true }, fields: [{ name: 'title', type: 'text' }] },
        { slug: 'users', auth: true, access: { read: () => true }, fields: [] },
      ],
    },
    { logLevel: 'error' },
  )
  await kernel.migrate()
})

describe('rate limit unit', () => {
  it('classifies auth routes by action segment', () => {
    expect(isAuthRoute('/api/users/login', '/api')).toBe(true)
    expect(isAuthRoute('/api/users/reset-password', '/api')).toBe(true)
    expect(isAuthRoute('/api/users/oauth/google', '/api')).toBe(true)
    expect(isAuthRoute('/api/posts', '/api')).toBe(false)
    expect(isAuthRoute('/api/posts/123', '/api')).toBe(false)
  })

  it('allows up to the limit then blocks with a retry-after', async () => {
    const cfg = resolveRateLimit({ windowMs: 60_000, max: 3, store: memoryRateLimitStore() })
    const req = new Request('http://localhost/api/posts', { headers: { [HEADER_REMOTE_ADDR]: '1.2.3.4' } })
    expect((await rateLimitCheck(cfg, req, '/api')).allowed).toBe(true)
    expect((await rateLimitCheck(cfg, req, '/api')).allowed).toBe(true)
    expect((await rateLimitCheck(cfg, req, '/api')).allowed).toBe(true)
    const blocked = await rateLimitCheck(cfg, req, '/api')
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfter).toBeGreaterThan(0)
  })

  it('keys by client, so a different IP has its own budget', async () => {
    const cfg = resolveRateLimit({ windowMs: 60_000, max: 1, store: memoryRateLimitStore() })
    const a = new Request('http://localhost/api/posts', { headers: { [HEADER_REMOTE_ADDR]: '1.1.1.1' } })
    const b = new Request('http://localhost/api/posts', { headers: { [HEADER_REMOTE_ADDR]: '2.2.2.2' } })
    expect((await rateLimitCheck(cfg, a, '/api')).allowed).toBe(true)
    expect((await rateLimitCheck(cfg, a, '/api')).allowed).toBe(false)
    expect((await rateLimitCheck(cfg, b, '/api')).allowed).toBe(true)
  })

  it('applies a separate, stricter budget to auth routes', async () => {
    const cfg = resolveRateLimit({ windowMs: 60_000, max: 100, authMax: 1, store: memoryRateLimitStore() })
    const ip = { [HEADER_REMOTE_ADDR]: '9.9.9.9' }
    const login = new Request('http://localhost/api/users/login', { method: 'POST', headers: ip })
    expect((await rateLimitCheck(cfg, login, '/api')).allowed).toBe(true)
    expect((await rateLimitCheck(cfg, login, '/api')).allowed).toBe(false)
    // The general budget is independent and still open.
    const read = new Request('http://localhost/api/posts', { headers: ip })
    expect((await rateLimitCheck(cfg, read, '/api')).allowed).toBe(true)
  })

  it('ignores x-forwarded-for unless trustProxy is set', async () => {
    const cfg = resolveRateLimit({ max: 1, store: memoryRateLimitStore() })
    // Same socket addr, different spoofed XFF: still the same bucket (XFF ignored).
    const r1 = new Request('http://localhost/api/posts', {
      headers: { [HEADER_REMOTE_ADDR]: '5.5.5.5', 'x-forwarded-for': '10.0.0.1' },
    })
    const r2 = new Request('http://localhost/api/posts', {
      headers: { [HEADER_REMOTE_ADDR]: '5.5.5.5', 'x-forwarded-for': '10.0.0.2' },
    })
    expect((await rateLimitCheck(cfg, r1, '/api')).allowed).toBe(true)
    expect((await rateLimitCheck(cfg, r2, '/api')).allowed).toBe(false)
  })
})

describe('rate limit through the handler', () => {
  it('returns 429 with Retry-After once the window is exhausted', async () => {
    const handler = createRequestHandler(kernel, { rateLimit: { max: 2, windowMs: 60_000 } })
    const make = () => new Request('http://localhost/api/health', { headers: { [HEADER_REMOTE_ADDR]: '7.7.7.7' } })
    expect((await handler(make())).status).not.toBe(429)
    expect((await handler(make())).status).not.toBe(429)
    const limited = await handler(make())
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBeTruthy()
  })

  it('can be disabled', async () => {
    const handler = createRequestHandler(kernel, { rateLimit: { enabled: false } })
    const make = () => new Request('http://localhost/api/health', { headers: { [HEADER_REMOTE_ADDR]: '8.8.8.8' } })
    for (let i = 0; i < 50; i++) expect((await handler(make())).status).not.toBe(429)
  })

  it('emits hardening headers (HSTS, permissions-policy)', async () => {
    const handler = createRequestHandler(kernel, {})
    const res = await handler(
      new Request('http://localhost/api/health', { headers: { [HEADER_REMOTE_ADDR]: '3.3.3.3' } }),
    )
    expect(res.headers.get('strict-transport-security')).toContain('max-age=')
    expect(res.headers.get('permissions-policy')).toContain('geolocation=()')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })
})
