/**
 * Authentication primitives: password hashing (scrypt) and stateless tokens
 * (HMAC-SHA256, JWT-compatible). Used by auth-enabled collections.
 */
import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const SCRYPT_KEYLEN = 64

// Async scrypt keeps password hashing off the event loop. scryptSync would block
// every other request for the full (deliberately slow) KDF duration, turning
// login into a throughput bottleneck and a trivial DoS vector under load.
const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN)
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  const salt = Buffer.from(parts[1]!, 'hex')
  const expected = Buffer.from(parts[2]!, 'hex')
  const derived = await scrypt(password, salt, expected.length)
  return expected.length === derived.length && timingSafeEqual(expected, derived)
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

export interface TokenPayload {
  sub: string
  collection: string
  iat?: number
  exp?: number
  [key: string]: unknown
}

export function signToken(payload: Omit<TokenPayload, 'iat' | 'exp'>, secret: string, expiresInSec = 3600): string {
  const now = nowSeconds()
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify({ ...payload, iat: now, exp: now + expiresInSec })).toString('base64url')
  const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url')
  return `${header}.${body}.${sig}`
}

export function verifyToken(token: string, secret: string): TokenPayload | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [header, body, sig] = parts as [string, string, string]
  const expected = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload
    if (typeof payload.exp === 'number' && payload.exp < nowSeconds()) return null
    return payload
  } catch {
    return null
  }
}
