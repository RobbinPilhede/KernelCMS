import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { sharpImageProcessor } from './index'

const processor = sharpImageProcessor()

async function makeImage(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 10, g: 120, b: 200 } } })
    .png()
    .toBuffer()
}

describe('sharpImageProcessor', () => {
  it('probes real image dimensions and format', async () => {
    const png = await makeImage(120, 90)
    const info = await processor.probe(png)
    expect(info).toEqual({ width: 120, height: 90, format: 'png' })
  })

  it('resizes to the requested width preserving aspect ratio', async () => {
    const png = await makeImage(400, 300)
    const { data, info } = await processor.resize(png, { width: 200, fit: 'inside' })
    expect(info.width).toBe(200)
    expect(info.height).toBe(150)
    // Output is real, smaller-than-source image bytes.
    const reprobe = await processor.probe(data)
    expect(reprobe?.width).toBe(200)
  })

  it('re-encodes to a different format', async () => {
    const png = await makeImage(100, 100)
    const { data, info } = await processor.resize(png, { width: 50, format: 'webp', quality: 70 })
    expect(info.format).toBe('webp')
    expect(info.width).toBe(50)
    const reprobe = await processor.probe(data)
    expect(reprobe?.format).toBe('webp')
  })

  it('crops to cover when both dimensions are given', async () => {
    const png = await makeImage(400, 200)
    const { info } = await processor.resize(png, { width: 100, height: 100, fit: 'cover' })
    expect(info.width).toBe(100)
    expect(info.height).toBe(100)
  })
})
