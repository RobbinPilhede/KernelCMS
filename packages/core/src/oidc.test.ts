import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { oidcProvider } from './oidc'

// ---------------------------------------------------------------------------
// A tiny in-process OIDC issuer. It serves discovery + JWKS and mints id_tokens
// signed with a test RSA key, so we can exercise the real verifier end to end.
// ---------------------------------------------------------------------------

const CLIENT_ID = 'test-client'
const KID = 'test-key-1'

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

interface MockIssuer {
  server: Server
  issuer: string
  /** Override-able id_token claims for the next token exchange. */
  setClaims(c: Record<string, unknown>): void
  /** Sign a token with a foreign key (to test signature rejection). */
  useWrongKey(on: boolean): void
  /** Emit a header `alg` of `none` with no signature. */
  useAlgNone(on: boolean): void
  /** Forge a header `alg` (e.g. 'HS256') while still returning 3 parts. */
  forceAlg(alg: string | null): void
  close(): Promise<void>
}

function jwkFromPublicKey(pub: KeyObject): Record<string, unknown> {
  const jwk = pub.export({ format: 'jwk' }) as Record<string, unknown>
  return { ...jwk, kid: KID, use: 'sig', alg: 'RS256' }
}

async function startMockIssuer(): Promise<MockIssuer> {
  const real = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const wrong = generateKeyPairSync('rsa', { modulusLength: 2048 })

  let claims: Record<string, unknown> = {}
  let wrongKey = false
  let algNone = false
  let forcedAlg: string | null = null

  const state: { issuer: string } = { issuer: '' }

  function mintIdToken(): string {
    const header = algNone ? { alg: 'none', typ: 'JWT' } : { alg: forcedAlg ?? 'RS256', typ: 'JWT', kid: KID }
    const now = Math.floor(Date.now() / 1000)
    const payload = {
      iss: state.issuer,
      aud: CLIENT_ID,
      sub: 'user-123',
      email: 'sso@example.com',
      email_verified: true,
      name: 'SSO User',
      iat: now,
      exp: now + 300,
      ...claims,
    }
    const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`
    if (algNone) return `${signingInput}.`
    const signer = createSign('RSA-SHA256')
    signer.update(signingInput)
    const sig = signer.sign(wrongKey ? wrong.privateKey : real.privateKey)
    return `${signingInput}.${b64url(sig)}`
  }

  const server = createServer((req, res) => {
    const url = req.url ?? ''
    if (url.startsWith('/.well-known/openid-configuration')) {
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          issuer: state.issuer,
          authorization_endpoint: `${state.issuer}/authorize`,
          token_endpoint: `${state.issuer}/token`,
          jwks_uri: `${state.issuer}/jwks`,
        }),
      )
      return
    }
    if (url.startsWith('/jwks')) {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ keys: [jwkFromPublicKey(real.publicKey)] }))
      return
    }
    if (url.startsWith('/token') && req.method === 'POST') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ access_token: 'at', token_type: 'Bearer', id_token: mintIdToken() }))
      return
    }
    res.statusCode = 404
    res.end('not found')
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (addr === null || typeof addr === 'string') throw new Error('failed to bind mock issuer')
  state.issuer = `http://127.0.0.1:${addr.port}`

  return {
    server,
    get issuer() {
      return state.issuer
    },
    setClaims: (c) => {
      claims = c
    },
    useWrongKey: (on) => {
      wrongKey = on
    },
    useAlgNone: (on) => {
      algNone = on
    },
    forceAlg: (alg) => {
      forcedAlg = alg
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  } as MockIssuer
}

// ---------------------------------------------------------------------------

describe('oidcProvider', () => {
  let mock: MockIssuer

  beforeEach(async () => {
    mock = await startMockIssuer()
  })
  afterEach(async () => {
    await mock.close()
  })

  const NONCE = 'nonce-abc'

  function provider() {
    return oidcProvider({ issuer: mock.issuer, clientId: CLIENT_ID, clientSecret: 'secret' })
  }

  it('verifies a valid id_token and returns the OAuthProfile', async () => {
    mock.setClaims({ nonce: NONCE })
    const profile = await provider().exchangeCode({ code: 'c', redirectUri: 'https://app/cb', nonce: NONCE })
    expect(profile).toEqual({ id: 'user-123', email: 'sso@example.com', emailVerified: true, name: 'SSO User' })
  })

  it('builds an OIDC authorization URL with openid scope, PKCE and nonce', async () => {
    // Allow discovery warming to resolve so the real authorize endpoint is used.
    await provider()
      .exchangeCode({ code: 'c', redirectUri: 'https://app/cb', nonce: NONCE })
      .catch(() => {})
    const p = provider()
    const url = p.authorizationUrl({
      redirectUri: 'https://app/cb',
      state: 'st',
      nonce: NONCE,
      codeChallenge: 'chal',
    })
    expect(url).toContain('response_type=code')
    expect(url).toMatch(/scope=openid(\+|%20|.*email)/)
    expect(url).toContain('nonce=nonce-abc')
    expect(url).toContain('code_challenge=chal')
    expect(url).toContain('code_challenge_method=S256')
    expect(p.needsNonce).toBe(true)
  })

  it('rejects a token signed with the wrong key', async () => {
    mock.setClaims({ nonce: NONCE })
    mock.useWrongKey(true)
    await expect(provider().exchangeCode({ code: 'c', redirectUri: 'https://app/cb', nonce: NONCE })).rejects.toThrow(
      /signature/i,
    )
  })

  it('rejects alg:none', async () => {
    mock.setClaims({ nonce: NONCE })
    mock.useAlgNone(true)
    await expect(provider().exchangeCode({ code: 'c', redirectUri: 'https://app/cb', nonce: NONCE })).rejects.toThrow(
      /not allowed/i,
    )
  })

  it('rejects a wrong audience', async () => {
    mock.setClaims({ nonce: NONCE, aud: 'someone-else' })
    await expect(provider().exchangeCode({ code: 'c', redirectUri: 'https://app/cb', nonce: NONCE })).rejects.toThrow(
      /aud/i,
    )
  })

  it('rejects an expired token', async () => {
    const past = Math.floor(Date.now() / 1000) - 3600
    mock.setClaims({ nonce: NONCE, exp: past, iat: past - 300 })
    await expect(provider().exchangeCode({ code: 'c', redirectUri: 'https://app/cb', nonce: NONCE })).rejects.toThrow(
      /expired/i,
    )
  })

  it('rejects a mismatched nonce', async () => {
    mock.setClaims({ nonce: 'attacker-nonce' })
    await expect(provider().exchangeCode({ code: 'c', redirectUri: 'https://app/cb', nonce: NONCE })).rejects.toThrow(
      /nonce/i,
    )
  })

  it('rejects a wrong issuer', async () => {
    mock.setClaims({ nonce: NONCE, iss: 'https://evil.example' })
    await expect(provider().exchangeCode({ code: 'c', redirectUri: 'https://app/cb', nonce: NONCE })).rejects.toThrow(
      /iss/i,
    )
  })

  it('rejects an HS256 (shared-secret) alg — alg-confusion defence', async () => {
    // The header claims HS256, but the verifier must refuse any HS* alg outright
    // (before even looking at the signature), defeating the classic attack where
    // an RSA public key is abused as an HMAC secret.
    mock.setClaims({ nonce: NONCE })
    mock.forceAlg('HS256')
    await expect(provider().exchangeCode({ code: 'c', redirectUri: 'https://app/cb', nonce: NONCE })).rejects.toThrow(
      /not allowed/i,
    )
  })
})
