/**
 * Magic-byte content sniffing. We never trust the client-supplied Content-Type:
 * a `.php` renamed to `.png` will announce `image/png`. This inspects the actual
 * leading bytes. Pure and dependency-free. See docs/07-media-files/05-file-security.
 */

/** Detect a MIME type from a buffer's signature, or null if unrecognized. */
export function sniffMimeType(buf: Buffer): string | null {
  if (buf.length < 4) return null
  const b = buf

  // Images
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif'
  if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) return 'image/webp'
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp'
  // SVG is text; sniff a leading <svg or <?xml ... svg
  if (looksLikeSvg(b)) return 'image/svg+xml'

  // Documents
  if (ascii(b, 0, '%PDF-')) return 'application/pdf'

  // Media containers — ISO base media (mp4/mov) has 'ftyp' at offset 4
  if (ascii(b, 4, 'ftyp')) return 'video/mp4'
  if (ascii(b, 0, 'OggS')) return 'audio/ogg'
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return 'audio/mpeg' // ID3 (mp3)

  // Archives / office (zip-based)
  if (b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05)) return 'application/zip'

  return null
}

/**
 * True when the sniffed type is consistent with the declared one. A null sniff
 * (unknown signature) is treated as a mismatch for executable-ish risk, but
 * allowed for text/* and application/json where there is no reliable signature.
 */
export function isContentTypeConsistent(declared: string, sniffed: string | null): boolean {
  if (sniffed) {
    if (declared === sniffed) return true
    // jpeg sometimes declared as image/jpg
    if (declared === 'image/jpg' && sniffed === 'image/jpeg') return true
    return false
  }
  // No signature: only trust inherently text-based types.
  return declared.startsWith('text/') || declared === 'application/json'
}

function ascii(b: Buffer, offset: number, str: string): boolean {
  if (b.length < offset + str.length) return false
  for (let i = 0; i < str.length; i++) if (b[offset + i] !== str.charCodeAt(i)) return false
  return true
}

function looksLikeSvg(b: Buffer): boolean {
  const head = b.subarray(0, Math.min(b.length, 256)).toString('utf8').trimStart().toLowerCase()
  return head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))
}
