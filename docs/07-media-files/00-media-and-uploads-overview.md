# Media & Uploads Overview

KernelCMS treats media as first-class content, not a side channel. An upload is a document in an ordinary collection, governed by the same access control, hooks, validation, versioning, and query language as any other content type. The binary lives in a swappable `@kernel/storage` adapter; the metadata lives in your database adapter; the two are reconciled by a deterministic upload pipeline. This document covers how a file moves from the browser to durable storage, how that file becomes a queryable document, what metadata we extract along the way, and how bytes get back out to your frontend.

## Upload as a Collection

In Payload, an upload collection is created by setting `upload: true` on a collection config. Sanity models assets as a built-in `sanity.imageAsset` / `sanity.fileAsset` document type you do not author. Strapi hides media entirely behind its Media Library plugin and a single `files` table. KernelCMS takes Payload's posture and makes it explicit and configurable: you declare an upload collection, you own its slug, and you choose its storage adapter per collection.

```ts
// kernel.config.ts
import { defineConfig } from '@kernel/core'
import { s3Storage } from '@kernel/storage'

export default defineConfig({
  collections: [
    {
      slug: 'media',
      upload: {
        storage: s3Storage({
          bucket: process.env.MEDIA_BUCKET!,
          region: 'eu-central-1',
          // credentials resolved from the environment, never inlined
        }),
        mimeTypes: ['image/*', 'application/pdf', 'video/mp4'],
        maxFileSize: 25 * 1024 * 1024, // 25 MB, enforced server-side
        imageSizes: [
          { name: 'thumbnail', width: 320, height: 320, fit: 'cover' },
          { name: 'card', width: 768, fit: 'inside' },
          { name: 'hero', width: 1920, fit: 'inside', format: 'webp' },
        ],
        focalPoint: true,
      },
      fields: [
        { name: 'alt', type: 'text', required: true },
        { name: 'caption', type: 'richText' },
        { name: 'credit', type: 'text' },
      ],
    },
  ],
})
```

The collection still has user-authored fields (`alt`, `caption`, `credit`). KernelCMS injects system fields — `filename`, `mimeType`, `filesize`, `width`, `height`, `url`, `sizes`, `focalPoint`, `checksum` — into the schema at config-resolve time. Because the record is a normal document, you get `relationship` and `upload` fields elsewhere that point at it, `where`/`sort`/`depth` queries over media, field-level access control on `credit`, and version history for the `alt` text. See [Collections](../02-data-modeling/01-collections.md) and [Access Control](../06-auth-security/01-authorization-and-access-control.md).

## The Upload Pipeline

The pipeline is the same whether the request arrives via REST `multipart/form-data`, the admin's TanStack Form upload field, or the typed `@kernel/client` SDK over RPC. It is a fixed sequence of stages, each with a hook boundary.

```
 client ──multipart/RPC──▶ @kernel/server upload operation
   │
   ▼
 ① validate (mimeType, size, magic-bytes sniff)
   │
   ▼
 ② beforeUpload hook ─────▶ rename / reject / mutate
   │
   ▼
 ③ extract metadata (probe dimensions, EXIF, hash)
   │
   ▼
 ④ generate derivatives (imageSizes via sharp)
   │
   ▼
 ⑤ persist binaries ──────▶ @kernel/storage.put(original + sizes)
   │
   ▼
 ⑥ write document ────────▶ db adapter (Drizzle / Mongo) in a txn
   │
   ▼
 ⑦ afterChange hook ──────▶ enqueue async work via @kernel/queue
```

Two design rules matter here. First, **validation happens before any byte is read into a derivative or written to storage.** We sniff magic bytes rather than trusting the client-supplied `Content-Type`, because a `.php` renamed to `.png` will announce `image/png`. Second, **storage and database writes are ordered so the database is the source of truth.** Binaries are written first (⑤), then the document (⑥); if the document write fails, orphaned binaries are swept by a reconciliation job keyed on `checksum`. We never have a document row pointing at a missing object — the more dangerous failure mode.

The operation core is identical in-process and over the wire. Locally you call it with full type inference; remotely the same function is exposed as a typed RPC server function.

```ts
import { getKernel } from '@kernel/server'

const kernel = await getKernel()

const doc = await kernel.collections.media.create({
  file: {
    data: buffer,
    name: 'launch.png',
    mimeType: 'image/png',
  },
  data: { alt: 'Product launch keynote stage' },
})

doc.sizes.thumbnail.url // → fully typed, no `any`
```

### Direct-to-storage uploads

Routing large files through the Node process is wasteful and caps throughput at your server's bandwidth. For files over a configurable threshold, KernelCMS issues a presigned PUT and lets the client upload straight to the storage backend, then calls a finalize operation that runs stages ③–⑦ against the already-stored object. This mirrors how Sanity's asset pipeline works but keeps it adapter-agnostic — the same flow runs against S3, GCS, R2, or a local-disk adapter that simply returns a server endpoint instead of a presigned URL.

```ts
const { uploadUrl, token } = await kernel.collections.media.presign({
  name: 'keynote.mp4',
  mimeType: 'video/mp4',
  filesize: 480_000_000,
})
// client PUTs bytes to uploadUrl, then:
await kernel.collections.media.finalize({ token, data: { alt: 'Keynote' } })
```

## Metadata Extraction

Extraction (stage ③) is where an opaque blob becomes queryable content. We run a typed extractor per media class and merge the result into the system fields.

| Field | Source | Applies to |
|---|---|---|
| `width`, `height` | image header probe (`sharp`/`image-size`) | images, video poster |
| `mimeType` | magic-byte sniff (`file-type`) | all |
| `filesize` | byte length | all |
| `checksum` | SHA-256 of original bytes | all |
| `exif` | EXIF/IPTC/XMP parse | images |
| `dominantColor`, `blurhash` | downscaled pixel analysis | images |
| `duration`, `codec` | container probe (`ffprobe`) | video, audio |
| `pageCount` | PDF catalog | documents |

EXIF handling is opinionated: **GPS and serial-number tags are stripped from stored derivatives by default** to avoid leaking a photographer's location, while the parsed values remain available on the document for editors who need them. This is a deliberate divergence from tools that re-serve original EXIF verbatim. `blurhash` and `dominantColor` exist so the frontend can render a meaningful placeholder before the image paints — Sanity ships `lqip` for the same reason; we make it a standard system field rather than a metadata sub-object.

Extractors are pluggable. A custom extractor receives the buffer and the document draft and returns a partial patch, merged before persistence:

```ts
import type { MediaExtractor } from '@kernel/storage'

export const captionExtractor: MediaExtractor = async ({ buffer, mimeType }) => {
  if (!mimeType.startsWith('image/')) return {}
  const alt = await visionModel.describe(buffer)
  return { alt } // pre-fills a required field, editor can override
}
```

Derivative generation (stage ④) is driven entirely by the `imageSizes` config. Each entry produces one stored object plus a `sizes[name]` record with its own `url`, `width`, `height`, and `filesize`. Generation is synchronous for images under a threshold and offloaded to `@kernel/queue` for large images and all video transcodes, so the create operation never blocks on a slow `ffmpeg` pass.

## Delivery

Storage and delivery are separate concerns, and KernelCMS keeps them separate. The storage adapter knows how to `put`/`get`/`delete` objects; a delivery strategy decides what URL an editor or frontend actually receives.

```ts
import { s3Storage } from '@kernel/storage'

s3Storage({
  bucket: process.env.MEDIA_BUCKET!,
  delivery: {
    mode: 'cdn',                 // 'cdn' | 'signed' | 'proxy'
    baseUrl: 'https://cdn.acme.com',
    signedUrlTtl: 3600,          // used when mode: 'signed'
  },
})
```

Three modes cover the realistic cases:

| Mode | URL returned | Access control | Use when |
|---|---|---|---|
| `cdn` | public CDN URL | none at fetch time | public marketing assets |
| `signed` | time-limited presigned URL | enforced at issue time | gated/paid media |
| `proxy` | `@kernel/server` route | re-checked per request | per-user document access |

`proxy` mode is the only one that re-evaluates collection access control on every byte served, because it routes through the server. It is the correct choice when a file's visibility depends on the requesting user — exactly the scenario Strapi and Payload handle awkwardly because their media URLs are effectively public once known. With `proxy`, a `read` access function on the `media` collection gates the binary, not just the metadata.

The admin and `@kernel/client` never hardcode a URL shape. They read `doc.url` and `doc.sizes[name].url`, which the active delivery strategy populates. Swapping from local disk in development to R2 + CDN in production changes one adapter line and zero application code. The frontend renders responsive images straight from the `sizes` map:

```tsx
const { data: media } = useQuery(/* @kernel/client query for the doc */)

<picture>
  <source srcSet={media.sizes.hero.url} media="(min-width: 1024px)" />
  <source srcSet={media.sizes.card.url} media="(min-width: 640px)" />
  <img
    src={media.sizes.thumbnail.url}
    width={media.width}
    height={media.height}
    alt={media.alt}
    style={{ backgroundColor: media.dominantColor }}
    loading="lazy"
  />
</picture>
```

On-the-fly transforms (arbitrary crop/format via query string) are intentionally **not** baked into the core adapter contract. They belong to the delivery layer — a CDN transform service or an image-proxy plugin — so the storage adapter stays a thin object store. The fixed `imageSizes` set is generated at upload time and cached forever; dynamic transforms are an opt-in plugin concern.

## Open Questions

- **Dynamic transforms in core.** Whether `@kernel/storage` should expose a standardized `transform({ width, format, quality })` URL builder, or leave all on-the-fly resizing to a delivery plugin. Leaning toward plugin-only to keep the adapter contract minimal.
- **Dedup semantics.** We compute a `checksum`; should identical bytes uploaded twice resolve to one stored object with two documents, one shared document, or remain fully independent? This interacts with delete/garbage-collection and per-document access control.
- **Video transcoding ladder.** Whether to ship an opinionated default ABR ladder (e.g. 360p/720p/1080p HLS) or require an explicit `videoSizes` config analogous to `imageSizes`.
- **EXIF retention policy granularity.** Per-collection vs. per-field control over which metadata tags survive into stored derivatives.
