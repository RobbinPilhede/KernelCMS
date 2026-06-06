import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { memoryStorage } from '@kernel/storage'
import type { ImageProcessor, ResizeOptions } from '@kernel/storage'
import { defineConfig, initKernel } from './index'
import type { Kernel } from './index'

const trusted = { overrideAccess: true } as const
// Valid PNG signature so the magic-byte sniff treats it as image/png.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

/** Deterministic processor: no native deps, records resize calls. */
function stubProcessor(): ImageProcessor & { calls: ResizeOptions[] } {
  const calls: ResizeOptions[] = []
  return {
    name: 'stub',
    calls,
    async probe() {
      return { width: 800, height: 600, format: 'png' }
    },
    async resize(_data, options) {
      calls.push(options)
      const height = options.height ?? Math.round(options.width * 0.75)
      return {
        data: Buffer.from(`resized:${options.width}x${height}:${options.format ?? 'png'}`),
        info: { width: options.width, height, format: options.format ?? 'png' },
      }
    },
  }
}

function buildConfig(image: ImageProcessor) {
  return defineConfig({
    secret: 'test-secret',
    db: sqliteAdapter({ url: ':memory:' }),
    storage: memoryStorage({ servePath: '/files' }),
    image,
    collections: [
      {
        slug: 'media',
        access: { read: () => true, create: () => true },
        upload: {
          focalPoint: true,
          imageSizes: [
            { name: 'thumbnail', width: 150, height: 150 },
            { name: 'card', width: 600, format: 'webp', quality: 80 },
          ],
        },
        fields: [{ name: 'alt', type: 'text' }],
      },
    ],
  })
}

let kernel: Kernel
let image: ImageProcessor & { calls: ResizeOptions[] }

beforeEach(async () => {
  image = stubProcessor()
  kernel = await initKernel(buildConfig(image), { logLevel: 'error' })
  await kernel.migrate()
})
afterEach(async () => {
  await kernel.destroy()
})

describe('image transforms', () => {
  it('probes dimensions and generates the configured sizes on upload', async () => {
    const doc = await kernel.upload({
      collection: 'media',
      file: { data: PNG, name: 'hero.png', mimeType: 'image/png' },
      data: { alt: 'Hero' },
      ...trusted,
    })

    // Original dimensions come from the processor's probe().
    expect(doc.width).toBe(800)
    expect(doc.height).toBe(600)

    const sizes = doc.sizes as Record<string, { url: string; width: number; height: number; filename: string }>
    expect(Object.keys(sizes).sort()).toEqual(['card', 'thumbnail'])
    expect(sizes.thumbnail).toMatchObject({ width: 150, height: 150, filename: 'hero-thumbnail.png' })
    // The 'card' size re-encodes to webp → extension + mime follow the format.
    expect(sizes.card).toMatchObject({ width: 600, filename: 'hero-card.webp' })
    expect(sizes.card!.url).toContain('-card.webp')

    // Two derivatives requested, with the right dimensions/format.
    expect(image.calls).toHaveLength(2)
    expect(image.calls.map((c) => c.width).sort()).toEqual([150, 600])
  })

  it('actually stores the derivative bytes in the backing store', async () => {
    await kernel.upload({
      collection: 'media',
      file: { data: PNG, name: 'photo.png', mimeType: 'image/png' },
      data: { alt: 'Photo' },
      ...trusted,
    })
    const store = kernel.config.storage as ReturnType<typeof memoryStorage>
    const keys = [...store._store.keys()]
    // The original + two derivatives.
    expect(keys.some((k) => k.endsWith('-thumbnail.png'))).toBe(true)
    expect(keys.some((k) => k.endsWith('-card.webp'))).toBe(true)
  })

  it('passes the document focal point to the processor', async () => {
    await kernel.upload({
      collection: 'media',
      file: { data: PNG, name: 'face.png', mimeType: 'image/png' },
      data: { alt: 'Face', focal_x: 25, focal_y: 75 },
      ...trusted,
    })
    expect(image.calls.every((c) => c.focalPoint?.x === 25 && c.focalPoint?.y === 75)).toBe(true)
  })

  it('skips processing for non-image uploads', async () => {
    const pdf = Buffer.from('%PDF-1.4 minimal', 'utf8')
    const doc = await kernel.upload({
      collection: 'media',
      file: { data: pdf, name: 'doc.pdf', mimeType: 'application/pdf' },
      data: { alt: 'Doc' },
      ...trusted,
    })
    expect(image.calls).toHaveLength(0)
    expect(doc.sizes ?? null).toBeNull()
  })
})
