import { describe, expect, it } from 'vitest'
import { signAssetUrl, verifyAssetUrl } from './asset-urls'

// Pure unit coverage of the HMAC capability primitives. The signature covers BOTH the
// storage key and the expiry, is keyed by the server-only secret, and is compared in
// constant time. Malformed inputs are rejected, never thrown.

const SECRET = 'asset-url-test-secret-32-chars!!!'
const KEY = 'media/2026/hero-shot-deadbeef.jpg'

describe('signAssetUrl', () => {
  it('is deterministic for the same secret/key/exp and base64url-encoded', () => {
    const a = signAssetUrl(SECRET, KEY, 1_900_000_000)
    const b = signAssetUrl(SECRET, KEY, 1_900_000_000)
    expect(a).toBe(b)
    // base64url alphabet only — no +, /, or = padding.
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})

describe('verifyAssetUrl — valid signatures', () => {
  it('verifies a signature produced by signAssetUrl (valid, not expired)', () => {
    const exp = 1_900_000_000
    const now = exp - 60
    const sig = signAssetUrl(SECRET, KEY, exp)
    expect(verifyAssetUrl(SECRET, KEY, String(exp), sig, now)).toEqual({ valid: true, expired: false })
  })
})

describe('verifyAssetUrl — the signature binds key, exp, and secret', () => {
  const exp = 1_900_000_000
  const now = exp - 60
  const sig = signAssetUrl(SECRET, KEY, exp)

  it('rejects a different storage key (key cannot be swapped)', () => {
    const r = verifyAssetUrl(SECRET, 'media/2026/other-file-cafebabe.jpg', String(exp), sig, now)
    expect(r.valid).toBe(false)
  })

  it('rejects a different expiry (link cannot be extended without re-signing)', () => {
    const r = verifyAssetUrl(SECRET, KEY, String(exp + 1), sig, now)
    expect(r.valid).toBe(false)
  })

  it('rejects a signature made with a different secret', () => {
    const otherSig = signAssetUrl('a-completely-different-secret-key', KEY, exp)
    const r = verifyAssetUrl(SECRET, KEY, String(exp), otherSig, now)
    expect(r.valid).toBe(false)
  })
})

describe('verifyAssetUrl — expiry', () => {
  it('flags expired:true when exp <= now, even for a valid signature', () => {
    const exp = 1_900_000_000
    const sig = signAssetUrl(SECRET, KEY, exp)
    // now == exp → expired (boundary is inclusive: exp <= now).
    expect(verifyAssetUrl(SECRET, KEY, String(exp), sig, exp)).toEqual({ valid: true, expired: true })
    // now past exp → expired.
    expect(verifyAssetUrl(SECRET, KEY, String(exp), sig, exp + 1).expired).toBe(true)
  })

  it('is not expired one second before exp', () => {
    const exp = 1_900_000_000
    const sig = signAssetUrl(SECRET, KEY, exp)
    expect(verifyAssetUrl(SECRET, KEY, String(exp), sig, exp - 1).expired).toBe(false)
  })
})

describe('verifyAssetUrl — malformed inputs are invalid, never thrown', () => {
  const exp = 1_900_000_000
  const now = exp - 60
  const goodSig = signAssetUrl(SECRET, KEY, exp)

  it('rejects a tampered signature of the same length', () => {
    // Flip the first character to a different base64url symbol, preserving length.
    const flipped = (goodSig[0] === 'A' ? 'B' : 'A') + goodSig.slice(1)
    const r = verifyAssetUrl(SECRET, KEY, String(exp), flipped, now)
    expect(r.valid).toBe(false)
  })

  it('rejects an empty signature', () => {
    expect(verifyAssetUrl(SECRET, KEY, String(exp), '', now)).toEqual({ valid: false, expired: false })
  })

  it('rejects a null/empty exp', () => {
    expect(verifyAssetUrl(SECRET, KEY, '', goodSig, now)).toEqual({ valid: false, expired: false })
    expect(verifyAssetUrl(SECRET, KEY, null, goodSig, now)).toEqual({ valid: false, expired: false })
  })

  it('rejects a null signature', () => {
    expect(verifyAssetUrl(SECRET, KEY, String(exp), null, now)).toEqual({ valid: false, expired: false })
  })

  it('rejects a non-numeric exp', () => {
    expect(verifyAssetUrl(SECRET, KEY, 'notanumber', goodSig, now).valid).toBe(false)
    expect(verifyAssetUrl(SECRET, KEY, '12e9', goodSig, now).valid).toBe(false)
    expect(verifyAssetUrl(SECRET, KEY, '-1', goodSig, now).valid).toBe(false)
    expect(verifyAssetUrl(SECRET, KEY, '3.14', goodSig, now).valid).toBe(false)
  })

  it('rejects an absurdly long exp (>15 digits) without throwing', () => {
    const huge = '9'.repeat(40)
    expect(() => verifyAssetUrl(SECRET, KEY, huge, goodSig, now)).not.toThrow()
    expect(verifyAssetUrl(SECRET, KEY, huge, goodSig, now).valid).toBe(false)
  })

  it('rejects a wrong-LENGTH signature without throwing (timingSafeEqual length guard)', () => {
    // A shorter and a longer candidate both fail the constant-time length check.
    expect(() => verifyAssetUrl(SECRET, KEY, String(exp), 'short', now)).not.toThrow()
    expect(verifyAssetUrl(SECRET, KEY, String(exp), 'short', now).valid).toBe(false)
    expect(verifyAssetUrl(SECRET, KEY, String(exp), goodSig + 'extra', now).valid).toBe(false)
  })
})
