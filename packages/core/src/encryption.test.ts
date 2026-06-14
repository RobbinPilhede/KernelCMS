import { describe, expect, it } from 'vitest'
import { createFieldCipher, DecryptionError } from './index'
import type { FieldCipher } from './index'

// Pure unit of the field cipher: AES-256-GCM round-trip, the null/legacy passthroughs,
// non-determinism (fresh IV per value), envelope detection, and — the part that matters
// for "encryption at rest" — that a tampered, malformed, or wrong-key envelope is a LOUD
// failure (DecryptionError), never silent garbage.

const KEY_A = 'cipher-unit-key-A-32-characters-long!!'
const KEY_B = 'cipher-unit-key-B-different-but-also-long!!'

const cipher: FieldCipher = createFieldCipher(KEY_A)

describe('createFieldCipher — round-trip', () => {
  it('encrypts then decrypts back to the original value for every JSON shape', () => {
    const cases: unknown[] = [
      'a string',
      42,
      0,
      -3.14,
      true,
      false,
      '',
      { nested: { a: 1, b: ['x', 'y'], c: null } },
      ['array', 1, { k: 'v' }, true],
    ]
    for (const value of cases) {
      const stored = cipher.encrypt(value)
      expect(cipher.isCiphertext(stored)).toBe(true)
      expect(cipher.decrypt(stored)).toEqual(value)
    }
  })

  it('round-trips an empty string distinctly from null', () => {
    const stored = cipher.encrypt('')
    expect(cipher.isCiphertext(stored)).toBe(true)
    expect(cipher.decrypt(stored)).toBe('')
  })
})

describe('createFieldCipher — null / undefined passthrough', () => {
  it('passes null and undefined through encrypt unchanged (not turned into ciphertext)', () => {
    expect(cipher.encrypt(null)).toBeNull()
    expect(cipher.encrypt(undefined)).toBeUndefined()
    expect(cipher.isCiphertext(cipher.encrypt(null))).toBe(false)
  })

  it('decrypt(null) returns null', () => {
    expect(cipher.decrypt(null)).toBeNull()
  })

  it('decrypt(undefined) returns null', () => {
    // A missing column reads as null, never as garbage.
    expect(cipher.decrypt(undefined)).toBeNull()
  })
})

describe('createFieldCipher — non-determinism', () => {
  it('encrypting the same value twice yields different ciphertexts that both decrypt back', () => {
    const value = 'same-plaintext'
    const first = cipher.encrypt(value) as string
    const second = cipher.encrypt(value) as string
    expect(first).not.toBe(second)
    expect(cipher.decrypt(first)).toBe(value)
    expect(cipher.decrypt(second)).toBe(value)
  })
})

describe('createFieldCipher — isCiphertext', () => {
  it('is true only for an enc:1: envelope string', () => {
    expect(cipher.isCiphertext(cipher.encrypt('x'))).toBe(true)
    expect(cipher.isCiphertext('enc:1:aaa:bbb:ccc')).toBe(true)
  })

  it('is false for plaintext, null, undefined, numbers, and objects', () => {
    expect(cipher.isCiphertext('plain text')).toBe(false)
    expect(cipher.isCiphertext('')).toBe(false)
    expect(cipher.isCiphertext(null)).toBe(false)
    expect(cipher.isCiphertext(undefined)).toBe(false)
    expect(cipher.isCiphertext(123)).toBe(false)
    expect(cipher.isCiphertext({ enc: true })).toBe(false)
  })
})

describe('createFieldCipher — authentication (tamper detection)', () => {
  function parts(stored: string): [string, string, string] {
    const p = stored.slice('enc:1:'.length).split(':')
    return [p[0]!, p[1]!, p[2]!]
  }
  // Flip the first base64 char of a segment to a definitely-different one.
  const flip = (s: string): string => (s[0] === 'A' ? 'B' : 'A') + s.slice(1)

  it('flipping a byte in the ciphertext throws DecryptionError', () => {
    const [iv, tag, ct] = parts(cipher.encrypt('secret') as string)
    const tampered = `enc:1:${iv}:${tag}:${flip(ct)}`
    expect(() => cipher.decrypt(tampered)).toThrow(DecryptionError)
  })

  it('flipping a byte in the auth tag throws DecryptionError', () => {
    const [iv, tag, ct] = parts(cipher.encrypt('secret') as string)
    const tampered = `enc:1:${iv}:${flip(tag)}:${ct}`
    expect(() => cipher.decrypt(tampered)).toThrow(DecryptionError)
  })

  it('flipping a byte in the IV throws DecryptionError', () => {
    const [iv, tag, ct] = parts(cipher.encrypt('secret') as string)
    const tampered = `enc:1:${flip(iv)}:${tag}:${ct}`
    expect(() => cipher.decrypt(tampered)).toThrow(DecryptionError)
  })

  it('a malformed envelope (wrong number of parts) throws DecryptionError', () => {
    expect(() => cipher.decrypt('enc:1:onlyonepart')).toThrow(DecryptionError)
    expect(() => cipher.decrypt('enc:1:a:b')).toThrow(DecryptionError)
    expect(() => cipher.decrypt('enc:1:a:b:c:d')).toThrow(DecryptionError)
  })

  it('a short IV or short tag throws DecryptionError (never returns garbage)', () => {
    const [iv, tag, ct] = parts(cipher.encrypt('secret') as string)
    // A 1-byte IV (base64 'AA==' decodes to a single byte) is not the required 12 bytes.
    expect(() => cipher.decrypt(`enc:1:AA==:${tag}:${ct}`)).toThrow(DecryptionError)
    // A short tag (1 byte) is not the required 16 bytes.
    expect(() => cipher.decrypt(`enc:1:${iv}:AA==:${ct}`)).toThrow(DecryptionError)
  })

  it('a non-base64 segment throws DecryptionError, never returns garbage', () => {
    const [, tag, ct] = parts(cipher.encrypt('secret') as string)
    expect(() => cipher.decrypt(`enc:1:!!!not-base64!!!:${tag}:${ct}`)).toThrow(DecryptionError)
  })
})

describe('createFieldCipher — wrong key', () => {
  it('a value encrypted with key A cannot be decrypted with a cipher built from key B', () => {
    const stored = createFieldCipher(KEY_A).encrypt('cross-key secret')
    const other = createFieldCipher(KEY_B)
    expect(() => other.decrypt(stored)).toThrow(DecryptionError)
  })
})

describe('createFieldCipher — legacy plaintext passthrough', () => {
  it('decrypt of a plain (non enc:1:) string returns it unchanged', () => {
    // Supports marking a field encrypted over a column that already holds plaintext.
    expect(cipher.decrypt('pre-existing plaintext')).toBe('pre-existing plaintext')
    expect(cipher.decrypt('enc:0:not-our-version')).toBe('enc:0:not-our-version')
  })
})
