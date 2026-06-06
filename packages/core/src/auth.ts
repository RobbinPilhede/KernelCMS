/**
 * Authentication primitives: password hashing (scrypt) and stateless tokens
 * (HMAC-SHA256, JWT-compatible). Used by auth-enabled collections.
 */
import { createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
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

/**
 * Opaque single-use tokens for password reset / email verification. The raw token
 * goes in the email; only its SHA-256 hash is persisted, so a database read can't
 * be used to impersonate the holder. 256 bits of entropy makes guessing infeasible.
 */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

// ---------------------------------------------------------------------------
// TOTP (RFC 6238) two-factor auth — implemented with node:crypto, no deps.
// ---------------------------------------------------------------------------

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function base32Encode(buf: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    value = (value << 5) | BASE32.indexOf(ch)
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/** A fresh base32 TOTP secret (160-bit). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20))
}

function hotp(secret: string, counter: number): string {
  const key = base32Decode(secret)
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(BigInt(counter))
  const digest = createHmac('sha1', key).update(buf).digest()
  const offset = digest[digest.length - 1]! & 0xf
  const code =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff)
  return String(code % 1_000_000).padStart(6, '0')
}

/** The current 6-digit TOTP code for a secret (30s step). */
export function totpCode(secret: string, timeMs: number = Date.now()): string {
  return hotp(secret, Math.floor(timeMs / 1000 / 30))
}

/**
 * Verify a code within ±`window` 30s steps and return the matched absolute step
 * counter, or null if no step matches. Callers persist the returned step and
 * reject codes whose step is <= the last accepted one, which closes the TOTP
 * replay window (a single code can otherwise be reused for ~90s).
 */
export function verifyTotpStep(secret: string, code: string, timeMs: number = Date.now(), window = 1): number | null {
  const trimmed = String(code ?? '').trim()
  if (!/^\d{6}$/.test(trimmed)) return null
  const counter = Math.floor(timeMs / 1000 / 30)
  let matched: number | null = null
  // Check every step in the window (no early return) for constant-time behaviour.
  for (let i = -window; i <= window; i++) {
    const step = counter + i
    const expected = hotp(secret, step)
    const a = Buffer.from(expected)
    const b = Buffer.from(trimmed)
    if (a.length === b.length && timingSafeEqual(a, b)) matched = step
  }
  return matched
}

/** Verify a code within ±`window` 30s steps (clock-drift tolerance). */
export function verifyTotp(secret: string, code: string, timeMs: number = Date.now(), window = 1): boolean {
  return verifyTotpStep(secret, code, timeMs, window) !== null
}

/** Build the `otpauth://` URI for QR enrolment in an authenticator app. */
export function otpauthURL(secret: string, account: string, issuer = 'KernelCMS'): string {
  const label = encodeURIComponent(`${issuer}:${account}`)
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: '30' })
  return `otpauth://totp/${label}?${params.toString()}`
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
  // Pin the algorithm: only HS256 is ever issued. Rejecting the header up front
  // forecloses any "alg" confusion/downgrade attempt before signature checking.
  try {
    const head = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as { alg?: unknown; typ?: unknown }
    if (head.alg !== 'HS256' || head.typ !== 'JWT') return null
  } catch {
    return null
  }
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
