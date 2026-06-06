/**
 * `sharp`-backed ImageProcessor — the production adapter for `config.image`.
 *
 * `sharp` is an *optional peer dependency*, loaded lazily on first use, so neither
 * `@kernel/core` nor this package forces a native build on installs that don't need
 * image processing. Install it alongside: `npm i @kernel/image-sharp sharp`.
 */
import type { ImageInfo, ImageProcessor, ResizeOptions, ResizeResult } from '@kernel/storage'

// A minimal structural type for the slice of sharp we use. This avoids a
// compile-time dependency on sharp's own types, so the workspace builds even when
// the native module isn't installed.
interface SharpLike {
  metadata(): Promise<{ width?: number; height?: number; format?: string }>
  resize(opts: Record<string, unknown>): SharpLike
  jpeg(opts?: Record<string, unknown>): SharpLike
  png(opts?: Record<string, unknown>): SharpLike
  webp(opts?: Record<string, unknown>): SharpLike
  avif(opts?: Record<string, unknown>): SharpLike
  toBuffer(opts: { resolveWithObject: true }): Promise<{
    data: Buffer
    info: { width: number; height: number; format: string }
  }>
}
type SharpFactory = (input: Buffer, opts?: Record<string, unknown>) => SharpLike

// Cap decoded pixels to defang decompression bombs (a few-KB file that inflates
// to hundreds of megapixels of RAM). ~50 MP comfortably covers real photos.
const MAX_INPUT_PIXELS = 50_000_000
const SHARP_INPUT_OPTS = { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' as const }

let cached: SharpFactory | null = null
async function loadSharp(): Promise<SharpFactory> {
  if (cached) return cached
  try {
    const mod = (await import('sharp')) as unknown as { default?: SharpFactory } & SharpFactory
    cached = (mod.default ?? mod) as SharpFactory
    return cached
  } catch {
    throw new Error('@kernel/image-sharp needs the optional peer dependency "sharp". Install it with `npm i sharp`.')
  }
}

/** Map a focal point (0–100, 0–100) to sharp's nearest gravity for `cover` crops.
 *  An approximation — sharp's resize positions to a gravity, not exact pixels. */
function gravityFor(fp?: { x: number; y: number }): string {
  if (!fp) return 'centre'
  const h = fp.x < 33 ? 'west' : fp.x > 66 ? 'east' : ''
  const v = fp.y < 33 ? 'north' : fp.y > 66 ? 'south' : ''
  const g = `${v}${h}`
  return g === '' ? 'centre' : g
}

export function sharpImageProcessor(): ImageProcessor {
  return {
    name: 'sharp',
    async probe(data: Buffer): Promise<ImageInfo | null> {
      const sharp = await loadSharp()
      const meta = await sharp(data, SHARP_INPUT_OPTS).metadata()
      if (!meta.width || !meta.height) return null
      return { width: meta.width, height: meta.height, format: meta.format ?? 'unknown' }
    },
    async resize(data: Buffer, options: ResizeOptions): Promise<ResizeResult> {
      const sharp = await loadSharp()
      const fit = options.fit ?? 'cover'
      let img: SharpLike = sharp(data, SHARP_INPUT_OPTS).resize({
        width: options.width,
        height: options.height,
        fit,
        position: gravityFor(options.focalPoint),
        withoutEnlargement: true,
      })
      const quality = options.quality
      if (options.format === 'jpeg') img = img.jpeg(quality ? { quality } : {})
      else if (options.format === 'png') img = img.png(quality ? { quality } : {})
      else if (options.format === 'webp') img = img.webp(quality ? { quality } : {})
      else if (options.format === 'avif') img = img.avif(quality ? { quality } : {})
      const { data: out, info } = await img.toBuffer({ resolveWithObject: true })
      return { data: out, info: { width: info.width, height: info.height, format: info.format } }
    },
  }
}
