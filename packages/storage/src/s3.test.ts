import { describe, expect, it } from 'vitest'
import { r2, s3Storage } from './index'

// Offline tests: constructing the adapter and resolving public URLs make no
// network calls. Live put/get/head/delete against a bucket is an integration
// step (MinIO/R2) — not run in CI since it needs credentials.

describe('s3Storage (offline)', () => {
  it('identifies as the s3 adapter', () => {
    expect(s3Storage({ bucket: 'media' }).name).toBe('s3')
  })

  it('resolves a public CDN url from publicBaseUrl without signing', async () => {
    const store = s3Storage({ bucket: 'media', publicBaseUrl: 'https://cdn.example.com' })
    expect(await store.url('media/hero-a1b2.png')).toBe('https://cdn.example.com/media/hero-a1b2.png')
  })

  it('trims a trailing slash on publicBaseUrl', async () => {
    const store = s3Storage({ bucket: 'media', publicBaseUrl: 'https://cdn.example.com/' })
    expect(await store.url('a/b.png')).toBe('https://cdn.example.com/a/b.png')
  })

  it('rejects unsafe keys', async () => {
    const store = s3Storage({ bucket: 'media', publicBaseUrl: 'https://cdn.example.com' })
    await expect(store.url('../secret')).rejects.toThrow()
  })

  it('r2() is an s3 adapter and serves public urls the same way', async () => {
    const store = r2({ bucket: 'assets', publicBaseUrl: 'https://files.acme.com' })
    expect(store.name).toBe('s3')
    expect(await store.url('img/x.webp')).toBe('https://files.acme.com/img/x.webp')
  })
})
