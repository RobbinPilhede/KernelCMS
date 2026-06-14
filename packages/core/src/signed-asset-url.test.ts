import { createHmac } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { localStorage } from '@kernel/storage'
import { BadRequestError, ForbiddenError, NotFoundError, defineConfig, initKernel, verifyAssetUrl } from './index'
import type { Kernel } from './index'

const SECRET = 'signed-asset-url-test-secret-32!!'
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

const admin = { req: { user: { id: 'adm', roles: ['admin'] } } }
const anon = { req: {} }

let dir: string
let kernel: Kernel

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kernel-signed-asset-'))
  const config = defineConfig({
    secret: SECRET,
    db: sqliteAdapter({ url: ':memory:' }),
    storage: localStorage({ rootDir: dir, servePath: '/files' }),
    collections: [
      {
        slug: 'public_media',
        access: { read: () => true },
        upload: true,
        fields: [{ name: 'alt', type: 'text' }],
      },
      {
        slug: 'secure_media',
        // Readable only by an authenticated principal.
        access: { read: ({ req }) => Boolean(req.user) },
        upload: true,
        fields: [{ name: 'alt', type: 'text' }],
      },
      {
        slug: 'articles',
        access: { read: () => true },
        fields: [{ name: 'title', type: 'text' }],
      },
    ],
  })
  kernel = await initKernel(config, { autoMigrate: true } as any)
})

afterAll(async () => {
  await kernel?.destroy()
  await rm(dir, { recursive: true, force: true })
})

/** Pull the raw storage_key for an upload doc (the value the HMAC actually covers). */
async function storageKey(collection: string, id: string): Promise<string> {
  const raw = await (kernel as any).config.db.findByID({ collection, id })
  return raw.storage_key as string
}

function parse(url: string): { path: string; exp: string | null; sig: string | null } {
  const q = url.indexOf('?')
  const path = q === -1 ? url : url.slice(0, q)
  const params = new URLSearchParams(q === -1 ? '' : url.slice(q + 1))
  return { path, exp: params.get('exp'), sig: params.get('sig') }
}

describe('signedAssetUrl — minting for a readable upload doc', () => {
  it('returns a URL embedding the storage key path plus a verifiable exp+sig', async () => {
    const doc = await kernel.upload({
      collection: 'public_media',
      file: { data: PNG, name: 'hero.png', mimeType: 'image/png' },
      ...admin,
    })
    const key = await storageKey('public_media', doc.id)
    const url = await kernel.signedAssetUrl({ collection: 'public_media', id: doc.id, ...admin })
    const { path, exp, sig } = parse(url)

    expect(path.startsWith('/files/')).toBe(true)
    // Each key segment is percent-encoded in the path; the raw key drives the signature.
    expect(path).toBe('/files/' + key.split('/').map(encodeURIComponent).join('/'))
    expect(exp).toMatch(/^\d+$/)
    expect(sig).toBeTruthy()

    const now = Math.floor(Date.now() / 1000)
    expect(verifyAssetUrl(SECRET, key, exp, sig, now)).toEqual({ valid: true, expired: false })
    // Independent recompute of the HMAC over key + exp matches the embedded sig.
    const recomputed = createHmac('sha256', SECRET).update(`${key}\n${exp}`).digest('base64url')
    expect(sig).toBe(recomputed)
  })
})

describe('signedAssetUrl — ttl handling', () => {
  let id: string
  beforeAll(async () => {
    const doc = await kernel.upload({
      collection: 'public_media',
      file: { data: PNG, name: 'ttl.png', mimeType: 'image/png' },
      ...admin,
    })
    id = doc.id
  })

  it('mints an exp ~ now + ttl', async () => {
    const before = Math.floor(Date.now() / 1000)
    const url = await kernel.signedAssetUrl({ collection: 'public_media', id, ttl: 60, ...admin })
    const after = Math.floor(Date.now() / 1000)
    const exp = Number(parse(url).exp)
    expect(exp).toBeGreaterThanOrEqual(before + 60)
    expect(exp).toBeLessThanOrEqual(after + 60)
  })

  it('clamps ttl=0 up to at least 1 second', async () => {
    const before = Math.floor(Date.now() / 1000)
    const url = await kernel.signedAssetUrl({ collection: 'public_media', id, ttl: 0, ...admin })
    const exp = Number(parse(url).exp)
    expect(exp).toBeGreaterThanOrEqual(before + 1)
  })

  it('clamps an enormous ttl down to the 7-day maximum', async () => {
    const SEVEN_DAYS = 7 * 24 * 3600
    const before = Math.floor(Date.now() / 1000)
    const url = await kernel.signedAssetUrl({ collection: 'public_media', id, ttl: 99_999_999, ...admin })
    const exp = Number(parse(url).exp)
    // exp is at most now + MAX_ASSET_TTL (allow a small clock margin).
    expect(exp).toBeLessThanOrEqual(before + SEVEN_DAYS + 2)
    expect(exp).toBeGreaterThanOrEqual(before + SEVEN_DAYS - 2)
  })
})

describe('signedAssetUrl — access gate', () => {
  let secureId: string
  beforeAll(async () => {
    const doc = await kernel.upload({
      collection: 'secure_media',
      file: { data: PNG, name: 'private.png', mimeType: 'image/png' },
      ...admin,
    })
    secureId = doc.id
  })

  it('lets an authenticated caller mint for a doc it can read', async () => {
    const url = await kernel.signedAssetUrl({ collection: 'secure_media', id: secureId, ...admin })
    expect(parse(url).sig).toBeTruthy()
  })

  it('refuses to mint for a caller who cannot read the doc', async () => {
    // A hard-deny read rule surfaces as Forbidden; a filter-based one would surface as
    // NotFound. Either way, no URL is minted for a doc you cannot see.
    const err = await kernel
      .signedAssetUrl({ collection: 'secure_media', id: secureId, ...anon })
      .then(() => null)
      .catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err instanceof ForbiddenError || err instanceof NotFoundError).toBe(true)
  })
})

describe('signedAssetUrl — bad inputs', () => {
  it('throws NotFound for a missing id', async () => {
    await expect(
      kernel.signedAssetUrl({ collection: 'public_media', id: 'does-not-exist', ...admin }),
    ).rejects.toBeInstanceOf(NotFoundError)
  })

  it('throws BadRequest for a non-upload collection', async () => {
    const article = await kernel.create({ collection: 'articles', data: { title: 'hi' }, ...admin })
    await expect(kernel.signedAssetUrl({ collection: 'articles', id: article.id, ...admin })).rejects.toBeInstanceOf(
      BadRequestError,
    )
  })
})

describe('signedAssetUrl — signature binds the actual storage key', () => {
  it('does not verify when recomputed against a different key', async () => {
    const doc = await kernel.upload({
      collection: 'public_media',
      file: { data: PNG, name: 'bind.png', mimeType: 'image/png' },
      ...admin,
    })
    const key = await storageKey('public_media', doc.id)
    const url = await kernel.signedAssetUrl({ collection: 'public_media', id: doc.id, ...admin })
    const { exp, sig } = parse(url)
    const now = Math.floor(Date.now() / 1000)

    expect(verifyAssetUrl(SECRET, key, exp, sig, now).valid).toBe(true)
    // Same exp+sig but a different key must NOT verify (the file can't be swapped).
    expect(verifyAssetUrl(SECRET, key + '.tampered', exp, sig, now).valid).toBe(false)
  })

  it('round-trips, and bumping exp by 1 without re-signing breaks it', async () => {
    const doc = await kernel.upload({
      collection: 'public_media',
      file: { data: PNG, name: 'roundtrip.png', mimeType: 'image/png' },
      ...admin,
    })
    const key = await storageKey('public_media', doc.id)
    const { exp, sig } = parse(await kernel.signedAssetUrl({ collection: 'public_media', id: doc.id, ...admin }))
    const now = Math.floor(Date.now() / 1000)

    expect(verifyAssetUrl(SECRET, key, exp, sig, now)).toEqual({ valid: true, expired: false })
    const bumped = String(Number(exp) + 1)
    expect(verifyAssetUrl(SECRET, key, bumped, sig, now).valid).toBe(false)
  })

  it('deleting an upload document sweeps its binary from disk (no orphaned bytes)', async () => {
    const doc = await kernel.upload({
      collection: 'public_media',
      file: { data: PNG, name: 'sweep.png', mimeType: 'image/png' },
      ...admin,
    })
    const key = await storageKey('public_media', doc.id)
    const onDisk = join(dir, key)
    expect(existsSync(onDisk)).toBe(true)
    await kernel.delete({ collection: 'public_media', id: doc.id, ...admin })
    // The row is gone AND so are the bytes — a signed link can't serve a deleted file.
    expect(existsSync(onDisk)).toBe(false)
  })
})
