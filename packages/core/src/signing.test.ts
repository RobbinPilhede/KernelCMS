import { describe, expect, it } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { canonicalJSON, contentForHash, hashContent, createSigner, signManifest, verifyManifest } from './signing'
import type { ContentManifest } from './types'

// The crypto core of content credentials: canonical JSON must be deterministic (so a
// hash is stable), HMAC + ed25519 must round-trip, a tampered hash must fail verify,
// and a manifest signed under one key must NOT verify under another.

function ed25519Pair(): { privateKey: string; publicKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  }
}

function manifest(hash: string): ContentManifest {
  return {
    collection: 'posts',
    documentId: 'doc-1',
    contentHash: hash,
    author: { id: 'u1', type: 'user' },
    approver: { id: 'ed', type: 'user' },
    publishedAt: '2026-01-01T00:00:00.000Z',
    versionId: 'v1',
  }
}

describe('canonicalJSON', () => {
  it('sorts object keys deterministically regardless of insertion order', () => {
    const a = canonicalJSON({ b: 1, a: 2, c: { z: 1, y: 2 } })
    const b = canonicalJSON({ c: { y: 2, z: 1 }, a: 2, b: 1 })
    expect(a).toBe(b)
    expect(a).toBe('{"a":2,"b":1,"c":{"y":2,"z":1}}')
  })

  it('preserves array order and renders undefined/function as null in arrays', () => {
    expect(canonicalJSON([3, 1, 2])).toBe('[3,1,2]')
    expect(canonicalJSON([1, undefined, () => 0])).toBe('[1,null,null]')
  })

  it('drops undefined/function object values (matching JSON.stringify)', () => {
    expect(canonicalJSON({ a: 1, b: undefined, c: () => 0 })).toBe('{"a":1}')
  })

  it('is stable across nested key reorderings', () => {
    const doc1 = { title: 'Hi', meta: { tags: ['x', 'y'], author: 'a' }, n: 5 }
    const doc2 = { n: 5, meta: { author: 'a', tags: ['x', 'y'] }, title: 'Hi' }
    expect(hashContent(doc1)).toBe(hashContent(doc2))
  })
})

describe('contentForHash', () => {
  it('excludes volatile/system keys so they do not perturb the hash', () => {
    const a = hashContent({ title: 'A', _status: 'published', updatedAt: '2026-01-01', createdAt: 'x' })
    const b = hashContent({ title: 'A', _status: 'draft', updatedAt: '2030-09-09', createdAt: 'y' })
    expect(a).toBe(b)
    expect(contentForHash({ title: 'A', _status: 'x' })).toEqual({ title: 'A' })
  })

  it('changes when real content changes', () => {
    expect(hashContent({ title: 'A' })).not.toBe(hashContent({ title: 'B' }))
  })
})

describe('HMAC signer', () => {
  it('round-trips a signature', () => {
    const signer = createSigner({ enabled: true, algorithm: 'hmac-sha256', secret: 'a-strong-secret-value' })!
    expect(signer.algorithm).toBe('hmac-sha256')
    const sig = signer.sign('payload')
    expect(signer.verify('payload', sig)).toBe(true)
    expect(signer.verify('tampered', sig)).toBe(false)
  })

  it('rejects a signature produced under a different secret (wrong key)', () => {
    const a = createSigner({ enabled: true, algorithm: 'hmac-sha256', secret: 'secret-aaaaaaaaaaaa' })!
    const b = createSigner({ enabled: true, algorithm: 'hmac-sha256', secret: 'secret-bbbbbbbbbbbb' })!
    const sig = a.sign('payload')
    expect(b.verify('payload', sig)).toBe(false)
  })

  it('rejects a malformed (non-base64 / wrong-length) signature without throwing', () => {
    const signer = createSigner({ enabled: true, algorithm: 'hmac-sha256', secret: 'a-strong-secret-value' })!
    expect(signer.verify('payload', 'not-a-real-signature')).toBe(false)
    expect(signer.verify('payload', '')).toBe(false)
  })
})

describe('ed25519 signer', () => {
  it('round-trips an asymmetric signature', () => {
    const pair = ed25519Pair()
    const signer = createSigner({ enabled: true, algorithm: 'ed25519', ...pair })!
    expect(signer.algorithm).toBe('ed25519')
    const sig = signer.sign('payload')
    expect(signer.verify('payload', sig)).toBe(true)
    expect(signer.verify('payload-2', sig)).toBe(false)
  })

  it('rejects a signature from a different key pair', () => {
    const a = createSigner({ enabled: true, algorithm: 'ed25519', ...ed25519Pair() })!
    const b = createSigner({ enabled: true, algorithm: 'ed25519', ...ed25519Pair() })!
    const sig = a.sign('payload')
    expect(b.verify('payload', sig)).toBe(false)
  })
})

describe('createSigner', () => {
  it('returns null when signing is disabled', () => {
    expect(createSigner(undefined)).toBeNull()
    expect(createSigner({ enabled: false, algorithm: 'hmac-sha256' })).toBeNull()
  })
})

describe('verifyManifest', () => {
  it('returns valid when signature + live content match', () => {
    const signer = createSigner({ enabled: true, algorithm: 'hmac-sha256', secret: 'a-strong-secret-value' })!
    const doc = { title: 'A', body: 'B' }
    const m = manifest(hashContent(doc))
    const sig = signManifest(signer, m)
    expect(verifyManifest(signer, m, sig, doc)).toEqual({ valid: true })
  })

  it('detects tampering: content modified after signing', () => {
    const signer = createSigner({ enabled: true, algorithm: 'hmac-sha256', secret: 'a-strong-secret-value' })!
    const doc = { title: 'A' }
    const m = manifest(hashContent(doc))
    const sig = signManifest(signer, m)
    const res = verifyManifest(signer, m, sig, { title: 'TAMPERED' })
    expect(res.valid).toBe(false)
    expect(res.reason).toMatch(/content hash mismatch|modified/i)
  })

  it('rejects a manifest signed under a different key', () => {
    const signer = createSigner({ enabled: true, algorithm: 'hmac-sha256', secret: 'secret-aaaaaaaaaaaa' })!
    const other = createSigner({ enabled: true, algorithm: 'hmac-sha256', secret: 'secret-bbbbbbbbbbbb' })!
    const doc = { title: 'A' }
    const m = manifest(hashContent(doc))
    const sig = signManifest(signer, m)
    const res = verifyManifest(other, m, sig, doc)
    expect(res.valid).toBe(false)
    expect(res.reason).toMatch(/signature/i)
  })

  it('rejects when the manifest itself was altered (signature no longer covers it)', () => {
    const signer = createSigner({ enabled: true, algorithm: 'hmac-sha256', secret: 'a-strong-secret-value' })!
    const doc = { title: 'A' }
    const m = manifest(hashContent(doc))
    const sig = signManifest(signer, m)
    const altered = { ...m, author: { id: 'attacker', type: 'user' as const } }
    expect(verifyManifest(signer, altered, sig, doc).valid).toBe(false)
  })
})
