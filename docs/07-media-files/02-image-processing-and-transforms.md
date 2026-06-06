# Image Processing & Transforms

KernelCMS treats image transformation as a first-class capability of the `upload` field, not a bolt-on. When you upload an asset to a collection backed by `@kernel/storage`, KernelCMS can resize, recompress, and reformat it ahead of time, on demand, or both — using a single transform definition that lives in `kernel.config.ts`. The pipeline runs on `sharp` (libvips) where native binaries are available and falls back to a WASM build on edge and locked-down runtimes, so the same config produces the same output regardless of where the server runs. This document specifies how transforms are declared, how the rendering pipeline is wired, when to pregenerate versus render on the fly, and how AVIF/WebP fit into the delivery story.

## Declaring transforms

Transforms are attached to an `upload` field as named sizes. Each size is a deterministic recipe: dimensions, a fit strategy, an output format, and a quality target. KernelCMS never mutates the original — the upload you stored is immutable, and every transform is a derived artifact addressed by a content hash of `(originalHash, recipe)`.

```ts
// kernel.config.ts
import { defineConfig } from '@kernel/core'
import { s3Storage } from '@kernel/storage'

export default defineConfig({
  collections: [
    {
      slug: 'media',
      upload: {
        storage: s3Storage({ bucket: 'kernel-media', region: 'eu-north-1' }),
        // Output formats KernelCMS is allowed to negotiate for delivery.
        formats: ['avif', 'webp', 'jpeg'],
        imageSizes: [
          { name: 'thumbnail', width: 320, height: 320, fit: 'cover', position: 'center' },
          { name: 'card', width: 768, fit: 'inside' },
          { name: 'hero', width: 2048, fit: 'inside', quality: 72 },
          // Art-directed crop with a focal point honored by `cover`.
          { name: 'social', width: 1200, height: 630, fit: 'cover' },
        ],
        // Strip EXIF/GPS by default; opt back in per-collection if you need it.
        metadata: 'strip',
        focalPoint: true,
      },
    },
  ],
})
```

Every named size becomes a typed property on the generated upload type, so `@kernel/client` and the Local API expose `media.sizes.hero.url` with full inference — no stringly-typed lookups. This is the same ergonomic Payload gives you with `imageSizes`, but KernelCMS carries the types through REST, GraphQL, and RPC from one declaration rather than only the Local API.

### Field types and contracts

The `upload` field documented in the upload field reference owns the transform surface. The storage adapter contract in [storage adapters](./01-storage-adapters.md) only has to implement byte get/put/delete and signed-URL issuance; it knows nothing about images. That separation means a transform produced by `sharp` can be persisted to S3, the local filesystem, or `@kernel/cloud` CDN storage without any adapter-specific code.

## Resize, format, and quality

`fit` controls how the source aspect ratio is reconciled with the requested box. KernelCMS exposes the libvips strategies directly rather than inventing its own vocabulary:

| `fit`     | Behavior                                                     | Use case                   |
| --------- | ------------------------------------------------------------ | -------------------------- |
| `cover`   | Fill the box, crop overflow (honors `focalPoint`/`position`) | Thumbnails, social cards   |
| `contain` | Fit inside the box, pad to exact dimensions                  | Logos on fixed canvases    |
| `inside`  | Scale down to fit, never upscale, no padding                 | Responsive `srcset` widths |
| `outside` | Scale so the box is fully covered, no crop                   | Background images          |
| `fill`    | Distort to exact dimensions                                  | Rarely — sprite atlases    |

Quality resolves through a three-level cascade: per-size `quality` → per-format default in `kernel.config.ts` → built-in defaults (`avif: 50`, `webp: 75`, `jpeg: 80`). AVIF numbers are not comparable to JPEG numbers — AVIF 50 is visually competitive with JPEG 80 at roughly half the bytes — so KernelCMS keeps the defaults format-aware instead of applying one global slider the way some Strapi setups do.

```ts
formats: {
  avif: { quality: 50, effort: 4 },   // effort 0-9; 4 is a sane build-time tradeoff
  webp: { quality: 75, effort: 4 },
  jpeg: { quality: 80, progressive: true, mozjpeg: true },
}
```

Upscaling is refused by default. Request a `width` larger than the source and `inside`/`outside` clamp to the original dimensions; only an explicit `withoutEnlargement: false` overrides it. This prevents the silent quality loss that bites teams who pregenerate a 4K "hero" from a 1200px source.

## The sharp and WASM pipeline

`@kernel/storage` ships two interchangeable engines behind one `ImageProcessor` interface. The native engine wraps `sharp` (libvips); the portable engine wraps `@jsquash/*` WASM codecs plus a WASM resize. KernelCMS picks the engine at boot based on runtime capability and lets you pin it.

```ts
import { sharpEngine, wasmEngine } from '@kernel/storage'

upload: {
  // 'auto' probes for a working sharp binary, else falls back to wasm.
  imageEngine: process.env.KERNEL_RUNTIME === 'edge' ? wasmEngine() : sharpEngine(),
}
```

The interface is intentionally narrow:

```ts
interface ImageProcessor {
  probe(input: Uint8Array): Promise<ImageMeta> // dims, format, orientation
  transform(input: Uint8Array, recipe: TransformRecipe): Promise<TransformResult>
}
```

The render path is the same regardless of engine:

```
                       ┌─────────────────────────────────────────┐
 request /media/...     │  1. parse recipe from URL or named size  │
 ─────────────────────▶ │  2. cache key = hash(originalHash,recipe)│
                       │  3. hit? ── stream from storage ─────────┼──▶ 304 / bytes
                       │     miss?                                 │
                       │  4. fetch original bytes                  │
                       │  5. probe → orient → resize → encode      │  (sharp | wasm)
                       │  6. persist derivative, set Cache-Control │
                       └─────────────────────────────────────────┘
```

`sharp` is the right default: libvips is streaming, multi-threaded, and an order of magnitude faster than the WASM path on real hardware. But `sharp` is a native addon — it breaks on some serverless cold starts, Cloudflare Workers, and arm/musl mismatches. Rather than make image processing the reason you can't deploy to the edge (a real constraint for Payload, which hard-depends on `sharp`), KernelCMS keeps the WASM engine as a guaranteed-portable fallback. The tradeoff is explicit and measurable: budget roughly 3–8× the per-image latency on WASM and prefer pregeneration there.

| Engine        | Relative speed | AVIF/WebP enc | Runtimes                     |
| ------------- | -------------- | ------------- | ---------------------------- |
| `sharpEngine` | 1× (baseline)  | Yes           | Node, Bun (native libvips)   |
| `wasmEngine`  | 3–8× slower    | Yes           | Edge, Workers, any WASM host |

## On-the-fly versus pregenerated

KernelCMS supports both strategies from the same recipe, and the choice is per-size, not per-project.

**Pregenerated.** On the upload hook, KernelCMS renders every named `imageSize` and writes the derivatives to storage. URLs are stable, the first request is already warm, and the CDN has nothing to compute. This is the Payload model and the safe default for a fixed design system.

**On the fly.** KernelCMS exposes a transform endpoint that accepts a signed, parameterized URL and renders-then-caches on first hit. This is the Sanity/`@sanity/image-url` model — arbitrary widths and crops without predeclaring them — and it's the right call when a frontend needs many responsive widths or art-directed crops that you can't enumerate up front.

```ts
upload: {
  imageSizes: [
    { name: 'thumbnail', width: 320, height: 320, fit: 'cover', generate: 'eager' },
  ],
  // Allow arbitrary on-demand widths within these guardrails.
  onDemand: {
    enabled: true,
    allowedWidths: [320, 640, 768, 1024, 1280, 1536, 2048],
    allowedFormats: ['avif', 'webp', 'jpeg'],
    signUrls: true,            // HMAC over params; reject unsigned requests
    maxPixels: 25_000_000,     // hard ceiling to kill decompression bombs
  },
}
```

On-the-fly URLs are signed so an attacker can't pivot the endpoint into a CPU-exhaustion or storage-amplification vector by requesting thousands of unique sizes. `maxPixels`, an allowlist of widths, and a per-IP rate limit are all enforced server-side. This is a sharp departure from naive `?width=` proxies that let any visitor mint unbounded derivatives.

```
 strategy        first byte   storage cost   flexibility   best for
 ───────────     ──────────   ────────────   ───────────   ───────────────────────
 pregenerated    fast         high (all N)   low           fixed design systems
 on-the-fly      slow (cold)  pay-as-used    high          responsive / editorial
```

A pragmatic default: pregenerate the two or three sizes the admin UI and known layouts need (`thumbnail`, `card`), and enable on-demand for everything the frontend negotiates. Derivatives are addressed by content hash, so a pregenerated `card` and an on-demand `width=768` collapse to the same object — no double storage.

## AVIF and WebP

Format negotiation is where KernelCMS earns its bytes back. The transform endpoint inspects the `Accept` header and serves the best format the client advertises, falling back down the `formats` list:

```
Accept: image/avif,image/webp,*/*  ──▶  AVIF derivative
Accept: image/webp,*/*             ──▶  WebP derivative
Accept: */*                        ──▶  JPEG derivative
```

`Vary: Accept` is set so the CDN caches each representation independently. For `<picture>`-based art direction, `@kernel/client` emits a typed `srcset`/`sources` helper so you don't hand-author markup:

```ts
import { imageSources } from '@kernel/client'

const sources = imageSources(media, {
  widths: [640, 1024, 1536],
  formats: ['avif', 'webp', 'jpeg'],
})
// → [{ type: 'image/avif', srcSet: '...640w, ...1024w' }, ...]
```

Rough guidance KernelCMS bakes into its defaults: at matched perceptual quality, AVIF lands ~50% smaller than JPEG and ~20–30% smaller than WebP, but encodes far slower — which is precisely why AVIF should be **pregenerated or aggressively cached**, never rendered synchronously on a cold WASM worker. WebP is the safe middle ground with near-universal support and cheap encoding. KernelCMS keeps JPEG (mozjpeg, progressive) as the universal floor.

Sanity and Strapi both lean on WebP-first delivery; Payload defers format choice to your `imageSizes`. KernelCMS differs by negotiating per-request from a config-declared preference list and by treating AVIF as a build-time artifact rather than a request-time gamble — you get AVIF's byte savings without paying its encode cost on the hot path.

## Cache and invalidation

Derivatives carry `Cache-Control: public, max-age=31536000, immutable` because their URLs are content-addressed — a new recipe or a re-uploaded original produces a new hash and therefore a new URL. There is no cache-busting to manage. Replacing the original through the admin or Local API enqueues regeneration of all eager sizes via the configured `@kernel/*` queue adapter, and purges the CDN paths for the old hash through the storage adapter's optional `purge(keys)` hook.

## Open questions

- **Animated formats.** Whether to resize animated WebP/GIF frame-accurately via `sharp`'s `animated: true`, or transcode short clips to AV1 video and hand off to a separate media pipeline. Leaning toward the latter for anything over a few frames.
- **On-demand crop syntax.** Whether on-the-fly crops should accept normalized focal-point coordinates only, or also raw pixel rect crops in the signed URL. Pixel rects are more powerful but harder to keep stable across re-uploads.
- **WASM codec set.** Whether to ship JPEG XL in the portable engine now or wait for broader `Accept` support. Currently out of the default `formats` list.
- **Per-tenant quality overrides.** On KernelCMS Cloud, whether format/quality defaults should be tunable per tenant for cost control, or fixed to keep the CDN cache keyspace small.
