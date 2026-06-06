/**
 * Image processing is an *optional adapter*, not a core dependency. The interface
 * is byte-in / byte-out so it sits beside the storage contract without dragging a
 * native dependency (sharp, libvips) into `@kernel/core`. Ship a processor by
 * installing an adapter package (e.g. `@kernel/image-sharp`) and wiring it to
 * `config.image`; with none configured, uploads simply store the original.
 */

export interface ImageInfo {
  width: number
  height: number
  /** Short format token, e.g. "jpeg" | "png" | "webp" | "avif" | "gif". */
  format: string
}

export type ImageFit = 'cover' | 'contain' | 'inside'
export type ImageFormat = 'jpeg' | 'png' | 'webp' | 'avif'

export interface ResizeOptions {
  width: number
  /** Omit to preserve aspect ratio from `width`. */
  height?: number
  /** How the image fills the box. Default 'cover' (crop to fill). */
  fit?: ImageFit
  /** Re-encode to this format. Omit to keep the source format. */
  format?: ImageFormat
  /** Encoder quality 1–100. */
  quality?: number
  /** Crop anchor as percentages (0–100). Used when `fit: 'cover'` crops. */
  focalPoint?: { x: number; y: number }
}

export interface ResizeResult {
  data: Buffer
  info: ImageInfo
}

export interface ImageProcessor {
  readonly name: string
  /** Read dimensions/format without transforming. Returns null if not an image. */
  probe(data: Buffer): Promise<ImageInfo | null>
  /** Produce a resized/re-encoded derivative. */
  resize(data: Buffer, options: ResizeOptions): Promise<ResizeResult>
}

/** Extension for a re-encoded format (so derivative keys/filenames stay correct). */
export function extForFormat(format: ImageFormat): string {
  return format === 'jpeg' ? 'jpg' : format
}
