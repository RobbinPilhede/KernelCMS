/**
 * Centralized object-key generation so every backend stores the same layout.
 * Keys are opaque, forward-slash-only, and free of traversal sequences.
 */
import { randomUUID } from 'node:crypto'

/** Slugify a filename's base while preserving a safe extension. */
export function sanitizeFilename(name: string): string {
  const lastDot = name.lastIndexOf('.')
  const base = (lastDot > 0 ? name.slice(0, lastDot) : name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  const ext = (lastDot > 0 ? name.slice(lastDot + 1) : '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 8)
  const safeBase = base || 'file'
  return ext ? `${safeBase}.${ext}` : safeBase
}

/**
 * Build a collision-resistant key under `prefix`. A short random segment keeps
 * same-named uploads from clobbering each other while staying human-readable.
 */
export function generateKey(prefix: string, filename: string): string {
  const safePrefix = prefix.replace(/^\/+|\/+$/g, '').replace(/\.\.+/g, '')
  const id = randomUUID().slice(0, 8)
  const file = sanitizeFilename(filename)
  const lastDot = file.lastIndexOf('.')
  const keyed = lastDot > 0 ? `${file.slice(0, lastDot)}-${id}${file.slice(lastDot)}` : `${file}-${id}`
  return safePrefix ? `${safePrefix}/${keyed}` : keyed
}

/** Reject keys that could escape the storage root. */
export function assertSafeKey(key: string): void {
  if (key.startsWith('/') || key.includes('\\') || key.includes('..') || key.includes('\0')) {
    throw new Error(`Unsafe storage key: ${JSON.stringify(key)}`)
  }
}
