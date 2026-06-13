/**
 * Content credentials — tamper-evident provenance signatures (a C2PA-style claim).
 * Dependency-free, built on `node:crypto`. The headline guarantee: SIGN on publish,
 * DETECT tampering on verify.
 *
 * The scheme:
 *  - A canonical JSON serialization (recursively sorted keys, no insignificant
 *    whitespace) makes the byte stream that gets hashed/signed DETERMINISTIC — the
 *    same logical object always yields the same bytes, so a hash is stable across
 *    runs/processes and a signature reproducibly re-verifies.
 *  - `contentHash` is `sha256(canonicalJSON(published doc, system/volatile keys
 *    stripped))`. The signed `manifest` embeds that hash plus who/what/when claims.
 *  - The `signature` covers `canonicalJSON(manifest)`. HMAC-SHA256 with a shared
 *    secret, or an asymmetric signature (ed25519) over the same bytes.
 *
 * SECURITY (re-audited):
 *  - Secret/private key material NEVER appears in a manifest, credential row, error,
 *    or log — only the public `algorithm` label and the resulting signature do.
 *  - HMAC verification uses `timingSafeEqual` (constant-time) so a forged signature
 *    can't be discovered byte-by-byte via timing.
 *  - A manifest signed under one key MUST NOT verify under a different key (the whole
 *    point) — both HMAC and ed25519 paths reject a wrong-key signature.
 */
import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  timingSafeEqual,
  type KeyObject,
} from 'node:crypto'
import type { ContentManifest } from './types'

export type { ContentManifest }

/** Hard cap on canonical-JSON nesting depth, mirroring the populate depth cap. A doc
 *  nested past this is treated as malformed rather than recursing into a stack overflow. */
const MAX_SERIALIZE_DEPTH = 100

/** Thrown when {@link canonicalJSON} hits {@link MAX_SERIALIZE_DEPTH}. Typed so callers
 *  (verify paths) can distinguish an over-deep document from other failures and downgrade
 *  to `valid:false` instead of crashing. */
export class CanonicalDepthError extends Error {
  constructor(depth: number) {
    super(`canonicalJSON exceeded maximum nesting depth of ${depth}`)
    this.name = 'CanonicalDepthError'
  }
}

/** The signing algorithm recorded on a credential. `hmac-sha256` is a shared-secret
 *  MAC; `ed25519` is an asymmetric signature. */
export type SigningAlgorithm = 'hmac-sha256' | 'ed25519'

/** The resolved signer used by the publish chokepoint. Holds the (server-only) key
 *  material in its closure; NOTHING here is ever serialized into output. */
export interface Signer {
  readonly algorithm: SigningAlgorithm
  /** Produce a base64 signature over the UTF-8 bytes of `payload`. */
  sign(payload: string): string
  /** Constant-time / cryptographic verify of a base64 `signature` over `payload`. */
  verify(payload: string, signature: string): boolean
}

// The signed claim set ({@link ContentManifest}) lives in `./types` so the manifest
// shape has a single source of truth shared with the public Kernel surface.

// ---------------------------------------------------------------------------
// Canonical JSON — deterministic, recursively key-sorted serialization.
// ---------------------------------------------------------------------------

/**
 * Serialize `value` to a canonical JSON string: object keys are emitted in sorted
 * order at every depth, arrays keep their order, and `undefined`/functions are
 * dropped (object) or rendered `null` (array) exactly as `JSON.stringify` would.
 * The output has no insignificant whitespace, so the byte stream is stable for
 * hashing and signing regardless of the input's key insertion order.
 */
export function canonicalJSON(value: unknown): string {
  return serialize(value, 0)
}

function serialize(value: unknown, depth: number): string {
  // Depth guard: a pathologically nested doc would otherwise recurse until the JS engine
  // throws "Maximum call stack size exceeded". Cap it with a typed, catchable error so the
  // verify path can report `valid:false` instead of an uncaught stack overflow.
  if (depth > MAX_SERIALIZE_DEPTH) throw new CanonicalDepthError(MAX_SERIALIZE_DEPTH)
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'bigint') return JSON.stringify(value.toString())
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined || typeof v === 'function' ? 'null' : serialize(v, depth + 1))).join(',')}]`
  }
  if (typeof value === 'object') {
    // Dates serialize to their ISO string (matching JSON.stringify) for determinism.
    if (value instanceof Date) return JSON.stringify(value.toISOString())
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj)
      .filter((k) => {
        const v = obj[k]
        return v !== undefined && typeof v !== 'function'
      })
      .sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${serialize(obj[k], depth + 1)}`).join(',')}}`
  }
  // undefined / function at the top level — JSON.stringify yields undefined; emit null.
  return 'null'
}

// ---------------------------------------------------------------------------
// Content hashing.
// ---------------------------------------------------------------------------

/** System/volatile keys excluded from the content hash. These move independently of
 *  the editorial content (status, timestamps, schedule) so hashing them would make a
 *  signature spuriously break on an unrelated touch, and `id` is constant per doc. */
const CONTENT_HASH_SKIP = new Set(['_status', '_scheduled_at', 'createdAt', 'updatedAt'])

/** The stable editorial content of a document, with system/volatile keys removed.
 *  Used both at sign time and verify time, so both hash exactly the same surface. */
export function contentForHash(doc: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(doc)) {
    if (CONTENT_HASH_SKIP.has(key)) continue
    out[key] = doc[key]
  }
  return out
}

/** `sha256(canonicalJSON(contentForHash(doc)))`, hex. Deterministic per content. */
export function hashContent(doc: Record<string, unknown>): string {
  return createHash('sha256')
    .update(canonicalJSON(contentForHash(doc)))
    .digest('hex')
}

// ---------------------------------------------------------------------------
// Signer construction.
// ---------------------------------------------------------------------------

/** Resolved signing material — the enabled flag plus the key objects, never logged. */
export interface SanitizedSigning {
  enabled: boolean
  algorithm: SigningAlgorithm
  /** HMAC secret (utf-8), when using the shared-secret scheme. */
  secret?: string
  /** PEM/DER private + public keys, when using the asymmetric scheme. */
  privateKey?: string
  publicKey?: string
}

/** Build the runtime {@link Signer} from sanitized signing material. Returns null
 *  when signing is disabled. The key material lives only in the returned closure. */
export function createSigner(signing: SanitizedSigning | undefined): Signer | null {
  if (!signing || !signing.enabled) return null
  if (signing.algorithm === 'hmac-sha256') {
    const secret = signing.secret
    if (!secret) return null
    return {
      algorithm: 'hmac-sha256',
      sign(payload: string): string {
        return createHmac('sha256', secret).update(payload, 'utf8').digest('base64')
      },
      verify(payload: string, signature: string): boolean {
        const expected = createHmac('sha256', secret).update(payload, 'utf8').digest()
        let given: Buffer
        try {
          given = Buffer.from(signature, 'base64')
        } catch {
          return false
        }
        // Constant-time: equal-length compare only (timingSafeEqual throws on a length
        // mismatch, which would itself be an early-out), so check length first.
        if (given.length !== expected.length) return false
        return timingSafeEqual(given, expected)
      },
    }
  }
  // ed25519: asymmetric. The private key signs; the public key verifies. A signature
  // produced under a different private key fails `cryptoVerify` against this public key.
  let priv: KeyObject
  let pub: KeyObject
  try {
    priv = createPrivateKey(signing.privateKey as string)
    pub = createPublicKey(signing.publicKey as string)
  } catch {
    // A bad key pair disables signing rather than crashing the publish path; the
    // sanitize step already validated shape, so this is defensive only.
    return null
  }
  return {
    algorithm: 'ed25519',
    sign(payload: string): string {
      // ed25519 takes no separate digest algorithm — pass null.
      return cryptoSign(null, Buffer.from(payload, 'utf8'), priv).toString('base64')
    },
    verify(payload: string, signature: string): boolean {
      let sig: Buffer
      try {
        sig = Buffer.from(signature, 'base64')
      } catch {
        return false
      }
      try {
        return cryptoVerify(null, Buffer.from(payload, 'utf8'), pub, sig)
      } catch {
        return false
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Manifest signing / verification.
// ---------------------------------------------------------------------------

/** Sign a manifest: the signature covers `canonicalJSON(manifest)`. */
export function signManifest(signer: Signer, manifest: ContentManifest): string {
  return signer.sign(canonicalJSON(manifest))
}

/** Verify a stored manifest's signature, then (when a fresh doc is supplied) confirm
 *  the CURRENT content still hashes to the manifest's `contentHash`. Returns a reason
 *  on the first failing check so the caller can surface "tampered" vs "bad signature".
 */
export function verifyManifest(
  signer: Signer,
  manifest: ContentManifest,
  signature: string,
  currentDoc?: Record<string, unknown>,
): { valid: boolean; reason?: string } {
  // 1) Signature integrity: the manifest itself must be authentic (signed by THIS key).
  //    A manifest signed under a different secret/key fails here.
  if (!signer.verify(canonicalJSON(manifest), signature)) {
    return { valid: false, reason: 'signature does not verify (wrong key or altered manifest)' }
  }
  // 2) Tamper check: the live content must still match the signed hash. A direct edit
  //    to the published row after signing changes the hash → mismatch → tampering.
  //    Hashing a malformed / pathologically-deep stored row can throw (depth guard);
  //    treat that as a failed verification, never an uncaught crash.
  if (currentDoc) {
    let liveHash: string
    try {
      liveHash = hashContent(currentDoc)
    } catch (err) {
      const reason =
        err instanceof CanonicalDepthError
          ? 'stored document too deeply nested to hash'
          : 'stored document could not be hashed'
      return { valid: false, reason }
    }
    if (liveHash !== manifest.contentHash) {
      return { valid: false, reason: 'content hash mismatch (document modified after signing)' }
    }
  }
  return { valid: true }
}
