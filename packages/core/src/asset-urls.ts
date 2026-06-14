/**
 * Signed, expiring asset URLs — capability links for private uploads.
 *
 * A normal file URL is access-checked per request against the caller's session (see the
 * server's file route). A *signed* URL is a bearer capability instead: it carries an expiry
 * and an HMAC over `key + exp`, so anyone holding the link can fetch that one file until it
 * expires — without a session. Use it to email a private download, embed a time-limited
 * image, or hand a file to a service that can't authenticate.
 *
 * The signature is keyed by the server-only `config.secret`, covers BOTH the storage key and
 * the expiry (so neither can be swapped or extended), and is compared in constant time. The
 * secret itself never appears in the URL.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

/** The HMAC-SHA256 signature (base64url) over a storage key + expiry, keyed by the secret. */
export function signAssetUrl(secret: string, key: string, expSeconds: number): string {
  return createHmac('sha256', secret).update(`${key}\n${expSeconds}`).digest('base64url')
}

/**
 * Verify a signed-asset query (`exp` + `sig`) for a storage key. Returns `valid` (the HMAC
 * matches, constant-time) and `expired` (the expiry has passed). Both must be checked: a
 * valid-but-expired link is rejected. Malformed inputs are treated as invalid, never thrown.
 */
export function verifyAssetUrl(
  secret: string,
  key: string,
  exp: string | null,
  sig: string | null,
  nowSeconds: number,
): { valid: boolean; expired: boolean } {
  if (!exp || !sig || !/^\d{1,15}$/.test(exp)) return { valid: false, expired: false }
  const expected = signAssetUrl(secret, key, Number(exp))
  let valid = false
  try {
    const a = Buffer.from(sig)
    const b = Buffer.from(expected)
    valid = a.length === b.length && timingSafeEqual(a, b)
  } catch {
    valid = false
  }
  return { valid, expired: Number(exp) <= nowSeconds }
}
