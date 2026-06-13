/* Live OIDC verification: stands up an in-process mock OIDC issuer (discovery +
 * JWKS from a test RSA key + token endpoint minting signed id_tokens) and runs
 * oidcProvider(...).exchangeCode(...) end to end, proving valid tokens pass and
 * every attack variant is rejected. Run: pnpm tsx verify/oidc.ts */
import { createServer, type Server } from 'node:http'
import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { oidcProvider } from '@kernel/core'

let pass = 0
const fails: string[] = []
const check = (n: string, c: boolean, e = '') => {
  if (c) {
    pass++
    console.log(`  \x1b[32mPASS\x1b[0m ${n}${e ? ` — ${e}` : ''}`)
  } else {
    fails.push(n)
    console.log(`  \x1b[31mFAIL\x1b[0m ${n}${e ? ` — ${e}` : ''}`)
  }
}
async function rejects(n: string, re: RegExp, fn: () => Promise<unknown>) {
  try {
    await fn()
    check(n, false, 'expected rejection, resolved')
  } catch (e: any) {
    check(n, re.test(`${e?.message}`), `threw "${e?.message}"`)
  }
}

const CLIENT_ID = 'verify-client'
const KID = 'verify-key'
const NONCE = 'verify-nonce'
const b64url = (i: Buffer | string) => Buffer.from(i).toString('base64url')

function jwk(pub: KeyObject) {
  return { ...(pub.export({ format: 'jwk' }) as Record<string, unknown>), kid: KID, use: 'sig', alg: 'RS256' }
}

interface Mock {
  server: Server
  issuer: string
  set(c: Record<string, unknown>): void
  wrongKey(on: boolean): void
  algNone(on: boolean): void
  forceAlg(a: string | null): void
}

async function mockIssuer(): Promise<Mock> {
  const real = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const wrong = generateKeyPairSync('rsa', { modulusLength: 2048 })
  let claims: Record<string, unknown> = {}
  let useWrong = false
  let none = false
  let forced: string | null = null
  const s = { issuer: '' }

  const mint = () => {
    const header = none ? { alg: 'none', typ: 'JWT' } : { alg: forced ?? 'RS256', typ: 'JWT', kid: KID }
    const now = Math.floor(Date.now() / 1000)
    const payload = {
      iss: s.issuer,
      aud: CLIENT_ID,
      sub: 'user-9',
      email: 'workforce@example.com',
      email_verified: true,
      name: 'Workforce User',
      iat: now,
      exp: now + 300,
      ...claims,
    }
    const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`
    if (none) return `${input}.`
    const signer = createSign('RSA-SHA256')
    signer.update(input)
    return `${input}.${b64url(signer.sign(useWrong ? wrong.privateKey : real.privateKey))}`
  }

  const server = createServer((req, res) => {
    const u = req.url ?? ''
    res.setHeader('content-type', 'application/json')
    if (u.startsWith('/.well-known/openid-configuration')) {
      return res.end(
        JSON.stringify({
          issuer: s.issuer,
          authorization_endpoint: `${s.issuer}/authorize`,
          token_endpoint: `${s.issuer}/token`,
          jwks_uri: `${s.issuer}/jwks`,
        }),
      )
    }
    if (u.startsWith('/jwks')) return res.end(JSON.stringify({ keys: [jwk(real.publicKey)] }))
    if (u.startsWith('/token') && req.method === 'POST')
      return res.end(JSON.stringify({ access_token: 'at', id_token: mint() }))
    res.statusCode = 404
    res.end('nf')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  if (addr === null || typeof addr === 'string') throw new Error('bind failed')
  s.issuer = `http://127.0.0.1:${addr.port}`
  return {
    server,
    get issuer() {
      return s.issuer
    },
    set: (c) => {
      claims = c
    },
    wrongKey: (on) => {
      useWrong = on
    },
    algNone: (on) => {
      none = on
    },
    forceAlg: (a) => {
      forced = a
    },
  }
}

async function main() {
  const mock = await mockIssuer()
  const provider = () => oidcProvider({ issuer: mock.issuer, clientId: CLIENT_ID, clientSecret: 'secret' })
  const exch = () => provider().exchangeCode({ code: 'c', redirectUri: 'https://app/cb', nonce: NONCE })

  console.log('\n\x1b[1mOIDC — strict id_token verification\x1b[0m')

  mock.set({ nonce: NONCE })
  const profile = await exch()
  check(
    'valid id_token -> correct OAuthProfile (sub/email/email_verified)',
    profile.id === 'user-9' && profile.email === 'workforce@example.com' && profile.emailVerified === true,
    JSON.stringify(profile),
  )

  // authorizationUrl reflects OIDC: openid scope, PKCE, nonce.
  const url = provider().authorizationUrl({
    redirectUri: 'https://app/cb',
    state: 'st',
    nonce: NONCE,
    codeChallenge: 'chal',
  })
  check(
    'authorizationUrl includes openid scope + PKCE S256 + nonce',
    /scope=openid/.test(url) &&
      url.includes('code_challenge=chal') &&
      url.includes('code_challenge_method=S256') &&
      url.includes('nonce=verify-nonce'),
    '',
  )

  mock.set({ nonce: NONCE })
  mock.wrongKey(true)
  await rejects('token signed with WRONG key -> rejected', /signature/i, exch)
  mock.wrongKey(false)

  mock.algNone(true)
  await rejects('alg:none -> rejected', /not allowed/i, exch)
  mock.algNone(false)

  mock.forceAlg('HS256')
  await rejects('HS256 shared-secret alg -> rejected (alg-confusion)', /not allowed/i, exch)
  mock.forceAlg(null)

  mock.set({ nonce: NONCE, aud: 'other-client' })
  await rejects('wrong aud -> rejected', /aud/i, exch)

  mock.set({ nonce: NONCE, exp: Math.floor(Date.now() / 1000) - 3600 })
  await rejects('expired token -> rejected', /expired/i, exch)

  mock.set({ nonce: 'attacker' })
  await rejects('wrong nonce -> rejected', /nonce/i, exch)

  mock.set({ nonce: NONCE, iss: 'https://evil.example' })
  await rejects('wrong iss -> rejected', /iss/i, exch)

  await new Promise<void>((r) => mock.server.close(() => r()))

  console.log(`\n\x1b[1mOIDC Result: ${pass} passed, ${fails.length} failed\x1b[0m`)
  if (fails.length) {
    console.log('Failures:\n  ' + fails.join('\n  '))
    process.exitCode = 1
  }
  // Let the event loop drain naturally (no hard process.exit) so the closed
  // http server unwinds cleanly on Windows.
}
main().catch((e) => {
  console.error('OIDC HARNESS ERROR:', e)
  process.exitCode = 2
})
