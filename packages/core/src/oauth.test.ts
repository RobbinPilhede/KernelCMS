import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { defineConfig, initKernel, oauthProvider } from './index'
import type { Kernel, OAuthProvider } from './index'

const trusted = { overrideAccess: true } as const

// A deterministic provider — no network. Exchange always yields the same profile.
const stub: OAuthProvider = {
  name: 'stub',
  authorizationUrl: ({ redirectUri, state }) => `https://provider.test/auth?redirect_uri=${redirectUri}&state=${state}`,
  exchangeCode: async () => ({ id: 'p1', email: 'oauth@example.com', name: 'OAuth User' }),
}

function buildConfig() {
  return defineConfig({
    secret: 'test-secret',
    db: sqliteAdapter({ url: ':memory:' }),
    oauth: [stub],
    collections: [
      {
        slug: 'users',
        auth: true,
        access: { read: () => true },
        fields: [{ name: 'name', type: 'text' }],
      },
    ],
  })
}

describe('oauthProvider builder', () => {
  it('constructs a standard authorization URL', () => {
    const p = oauthProvider({
      name: 'demo',
      authorizationEndpoint: 'https://demo.test/authorize',
      tokenEndpoint: 'https://demo.test/token',
      clientId: 'cid',
      clientSecret: 'secret',
      scope: 'email',
      profile: async () => ({ id: '1', email: 'a@b.c' }),
    })
    const url = p.authorizationUrl({ redirectUri: 'https://app.test/cb', state: 'xyz' })
    expect(url).toContain('https://demo.test/authorize?')
    expect(url).toContain('client_id=cid')
    expect(url).toContain('redirect_uri=https%3A%2F%2Fapp.test%2Fcb')
    expect(url).toContain('state=xyz')
    expect(url).toContain('response_type=code')
  })
})

describe('loginWithOAuth', () => {
  let kernel: Kernel
  beforeEach(async () => {
    kernel = await initKernel(buildConfig(), { logLevel: 'error' })
    await kernel.migrate()
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('creates the user on first sign-in and issues a token', async () => {
    const result = await kernel.loginWithOAuth({
      collection: 'users',
      provider: 'stub',
      code: 'auth-code',
      redirectUri: 'https://app.test/cb',
    })
    expect(result.token).toBeTypeOf('string')
    expect(result.user.email).toBe('oauth@example.com')

    const users = await kernel.find({ collection: 'users', ...trusted })
    expect(users.totalDocs).toBe(1)
    expect(users.docs[0]!.name).toBe('OAuth User')
    // The authenticated session resolves back to that user.
    const who = await kernel.authenticate(result.token)
    expect(who?.email).toBe('oauth@example.com')
  })

  it('reuses the existing account on subsequent sign-ins', async () => {
    await kernel.loginWithOAuth({ collection: 'users', provider: 'stub', code: 'c1', redirectUri: 'https://app.test/cb' })
    await kernel.loginWithOAuth({ collection: 'users', provider: 'stub', code: 'c2', redirectUri: 'https://app.test/cb' })
    const users = await kernel.find({ collection: 'users', ...trusted })
    expect(users.totalDocs).toBe(1)
  })

  it('rejects an unconfigured provider', async () => {
    await expect(
      kernel.loginWithOAuth({ collection: 'users', provider: 'nope', code: 'c', redirectUri: 'https://app.test/cb' }),
    ).rejects.toThrow()
  })
})
