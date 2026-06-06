import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  assertSafeKey,
  generateKey,
  isContentTypeConsistent,
  localStorage,
  memoryStorage,
  sanitizeFilename,
  sniffMimeType,
  type StorageAdapter,
} from './index'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])
const PDF = Buffer.from('%PDF-1.7\n...', 'utf8')
const SCRIPT = Buffer.from('<?php system($_GET["c"]); ?>', 'utf8')

describe('sniffMimeType', () => {
  it('detects real signatures regardless of declared type', () => {
    expect(sniffMimeType(PNG)).toBe('image/png')
    expect(sniffMimeType(JPEG)).toBe('image/jpeg')
    expect(sniffMimeType(PDF)).toBe('application/pdf')
    expect(sniffMimeType(Buffer.concat([Buffer.from('RIFF????'), Buffer.from('WEBP')]))).toBe('image/webp')
  })

  it('returns null for content with no known signature', () => {
    expect(sniffMimeType(SCRIPT)).toBeNull()
  })

  it('flags a php payload masquerading as a png', () => {
    // Declared image/png, but the bytes are a PHP script → inconsistent.
    expect(isContentTypeConsistent('image/png', sniffMimeType(SCRIPT))).toBe(false)
  })

  it('accepts a matching declared/sniffed pair and the jpg/jpeg alias', () => {
    expect(isContentTypeConsistent('image/png', 'image/png')).toBe(true)
    expect(isContentTypeConsistent('image/jpg', 'image/jpeg')).toBe(true)
  })

  it('trusts text/json types that have no binary signature', () => {
    expect(isContentTypeConsistent('text/plain', null)).toBe(true)
    expect(isContentTypeConsistent('application/json', null)).toBe(true)
    expect(isContentTypeConsistent('application/x-httpd-php', null)).toBe(false)
  })
})

describe('key generation', () => {
  it('slugifies filenames and preserves a safe extension', () => {
    expect(sanitizeFilename('My Photo (2).PNG')).toBe('my-photo-2.png')
    expect(sanitizeFilename('noext')).toBe('noext')
    // Path-like or hostile names produce a slug free of slashes and traversal.
    const hostile = sanitizeFilename('../../etc/passwd')
    expect(hostile).not.toMatch(/[/\\]/)
    expect(hostile).not.toContain('..')
  })

  it('produces collision-resistant, prefixed, traversal-free keys', () => {
    const a = generateKey('media/2026', 'hero shot.jpg')
    const b = generateKey('media/2026', 'hero shot.jpg')
    expect(a).not.toBe(b) // random segment
    expect(a).toMatch(/^media\/2026\/hero-shot-[a-f0-9]{8}\.jpg$/)
    expect(() => assertSafeKey(a)).not.toThrow()
  })

  it('rejects unsafe keys', () => {
    expect(() => assertSafeKey('/etc/passwd')).toThrow()
    expect(() => assertSafeKey('a/../../b')).toThrow()
    expect(() => assertSafeKey('a\\b')).toThrow()
  })
})

function adapterContract(name: string, make: () => StorageAdapter) {
  describe(`${name} adapter`, () => {
    it('round-trips put → get → head, and delete is idempotent', async () => {
      const s = make()
      const key = generateKey('test', 'file.png')
      const res = await s.put(key, PNG, { contentType: 'image/png' })
      expect(res.size).toBe(PNG.length)

      const back = await s.get(key)
      expect(back.equals(PNG)).toBe(true)

      const head = await s.head(key)
      expect(head?.size).toBe(PNG.length)

      await s.delete(key)
      expect(await s.head(key)).toBeNull()
      // Deleting again must not throw.
      await expect(s.delete(key)).resolves.toBeUndefined()
    })

    it('resolves a delivery url for a key', async () => {
      const s = make()
      const key = generateKey('test', 'a.png')
      await s.put(key, PNG, { contentType: 'image/png' })
      const url = await s.url(key)
      expect(url).toContain(key)
    })

    it('refuses unsafe keys', async () => {
      const s = make()
      await expect(s.put('../escape.png', PNG, { contentType: 'image/png' })).rejects.toThrow()
    })
  })
}

adapterContract('memory', () => memoryStorage())

describe('local adapter (disk)', () => {
  let dir: string
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kernel-storage-'))
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  adapterContract('local', () => localStorage({ rootDir: dir, servePath: '/files' }))
})
