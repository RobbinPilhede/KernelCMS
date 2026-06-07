import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { initKernel } from '@kernel/core'
import type { Kernel } from '@kernel/core'
import { createRequestHandler } from './index'

let kernel: Kernel

beforeEach(async () => {
  kernel = await initKernel(
    {
      secret: 'cookie-auth-test',
      db: sqliteAdapter({ url: ':memory:' }),
      collections: [{ slug: 'users', auth: true, access: { read: () => true }, fields: [] }],
    },
    { logLevel: 'error' },
  )
  await kernel.migrate()
  await kernel.create({
    collection: 'users',
    data: { email: 'admin@example.com', password: 'password123' },
    overrideAccess: true,
  })
})

afterEach(async () => {
  await kernel.destroy()
})

const loginBody = JSON.stringify({ email: 'admin@example.com', password: 'password123' })

/** The value of the kernel_token cookie from a Set-Cookie header, or null. */
function sessionCookieValue(res: Response): string | null {
  const setCookie = res.headers.get('set-cookie') ?? ''
  const m = setCookie.match(/kernel_token=([^;]*)/)
  return m ? (m[1] ?? null) : null
}

describe('cookie auth (M2 — no token in localStorage)', () => {
  it('sets an HttpOnly, SameSite=Lax session cookie on login', async () => {
    const handler = createRequestHandler(kernel, {})
    const res = await handler(new Request('http://localhost/api/users/login', { method: 'POST', body: loginBody }))
    expect(res.status).toBe(200)
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toMatch(/kernel_token=/)
    expect(setCookie).toMatch(/HttpOnly/i)
    expect(setCookie).toMatch(/SameSite=Lax/i)
  })

  it('authenticates a later request from the cookie alone (no Authorization header)', async () => {
    const handler = createRequestHandler(kernel, {})
    const login = await handler(new Request('http://localhost/api/users/login', { method: 'POST', body: loginBody }))
    const token = sessionCookieValue(login)!
    expect(token).toBeTruthy()

    const meRes = await handler(
      new Request('http://localhost/api/users/me', { headers: { cookie: `kernel_token=${token}` } }),
    )
    expect(meRes.status).toBe(200)
    const body = (await meRes.json()) as { user?: { email?: string } }
    expect(body.user?.email).toBe('admin@example.com')
  })

  it('rejects a cookie-authenticated unsafe request from a foreign origin (CSRF)', async () => {
    const handler = createRequestHandler(kernel, {})
    const login = await handler(new Request('http://localhost/api/users/login', { method: 'POST', body: loginBody }))
    const token = sessionCookieValue(login)!

    const evil = await handler(
      new Request('http://localhost/api/users/logout', {
        method: 'POST',
        headers: { cookie: `kernel_token=${token}`, origin: 'http://evil.example' },
      }),
    )
    expect(evil.status).toBe(403)

    // Same-origin is allowed.
    const ok = await handler(
      new Request('http://localhost/api/users/logout', {
        method: 'POST',
        headers: { cookie: `kernel_token=${token}`, origin: 'http://localhost' },
      }),
    )
    expect(ok.status).toBe(200)
  })

  it('clears the cookie on logout', async () => {
    const handler = createRequestHandler(kernel, {})
    const login = await handler(new Request('http://localhost/api/users/login', { method: 'POST', body: loginBody }))
    const token = sessionCookieValue(login)!
    const res = await handler(
      new Request('http://localhost/api/users/logout', {
        method: 'POST',
        headers: { cookie: `kernel_token=${token}`, origin: 'http://localhost' },
      }),
    )
    expect(res.headers.get('set-cookie') ?? '').toMatch(/kernel_token=;[^]*Max-Age=0/i)
  })

  it('does not set a cookie when cookieAuth is disabled', async () => {
    const handler = createRequestHandler(kernel, { cookieAuth: false })
    const res = await handler(new Request('http://localhost/api/users/login', { method: 'POST', body: loginBody }))
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('a Bearer-token mutation is exempt from the CSRF origin check', async () => {
    const handler = createRequestHandler(kernel, {})
    const login = await handler(new Request('http://localhost/api/users/login', { method: 'POST', body: loginBody }))
    const token = (await login.json()) as { token: string }
    // Bearer can't be sent cross-site, so a foreign Origin must NOT block it.
    const res = await handler(
      new Request('http://localhost/api/users/logout', {
        method: 'POST',
        headers: { authorization: `Bearer ${token.token}`, origin: 'http://evil.example' },
      }),
    )
    expect(res.status).toBe(200)
  })
})
