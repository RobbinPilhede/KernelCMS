/**
 * Field-level encryption at rest — transparent AES-256-GCM for fields marked
 * `encrypted: true`. The value is encrypted at the write chokepoint (`serializeDoc`) and
 * decrypted at the read chokepoint (`deserializeDoc`), so the plaintext only ever lives in
 * the application layer: the storage column holds authenticated ciphertext.
 *
 * Format: `enc:1:<base64 iv>:<base64 tag>:<base64 ciphertext>`. A fresh random 96-bit IV per
 * value (so the same plaintext encrypts differently each time — no equality leak), and the
 * GCM auth tag makes tampering or a wrong key a hard, detectable failure rather than silent
 * garbage. The 256-bit key is derived from the configured secret via SHA-256, so any
 * sufficiently-random string works as `encryption.key`.
 *
 * Because ciphertext is non-deterministic and opaque, an encrypted field can't be filtered,
 * sorted, made unique, indexed, full-text searched, localized, or personalized — those are
 * rejected at config load.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { KernelError } from './errors'

const PREFIX = 'enc:1:'
const IV_BYTES = 12

export interface FieldCipher {
  /** Encrypt a (JSON-serializable) value to the `enc:1:…` string. `null`/`undefined` pass
   *  through unchanged (a missing value is not ciphertext). */
  encrypt(value: unknown): unknown
  /** Decrypt an `enc:1:…` string back to its value. A non-ciphertext value (legacy plaintext
   *  written before the field was encrypted, or `null`) passes through. A tampered or
   *  wrong-key ciphertext throws — never silently returns garbage. */
  decrypt(stored: unknown): unknown
  /** Whether a stored value is in the encrypted envelope format. */
  isCiphertext(value: unknown): boolean
}

/** Thrown when an `enc:1:…` value fails to decrypt (tampered, or the key changed). */
export class DecryptionError extends KernelError {
  constructor(message = 'Failed to decrypt field (wrong encryption key, or tampered data).') {
    super(message, 'INTERNAL', 500)
    this.name = 'DecryptionError'
  }
}

export function createFieldCipher(secretKey: string): FieldCipher {
  const key = createHash('sha256').update(String(secretKey)).digest() // 32 bytes
  const isCiphertext = (value: unknown): value is string => typeof value === 'string' && value.startsWith(PREFIX)
  return {
    isCiphertext,
    encrypt(value) {
      if (value === null || value === undefined) return value
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const pt = Buffer.from(JSON.stringify(value), 'utf8')
      const ct = Buffer.concat([cipher.update(pt), cipher.final()])
      const tag = cipher.getAuthTag()
      return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`
    },
    decrypt(stored) {
      if (!isCiphertext(stored)) return stored ?? null
      const parts = stored.slice(PREFIX.length).split(':')
      if (parts.length !== 3) throw new DecryptionError()
      const iv = Buffer.from(parts[0]!, 'base64')
      const tag = Buffer.from(parts[1]!, 'base64')
      const ct = Buffer.from(parts[2]!, 'base64')
      if (iv.length !== IV_BYTES || tag.length !== 16) throw new DecryptionError()
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, iv)
        decipher.setAuthTag(tag)
        const pt = Buffer.concat([decipher.update(ct), decipher.final()])
        return JSON.parse(pt.toString('utf8'))
      } catch (err) {
        if (err instanceof DecryptionError) throw err
        throw new DecryptionError()
      }
    },
  }
}
