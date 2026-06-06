# Focal Points, Crops & Responsive Images

KernelCMS treats art direction as a first-class data concern, not a frontend afterthought. A focal point and a set of named crops are stored on the upload document itself, generated server-side by the active `@kernel/storage` adapter, and consumed through typed helpers in `@kernel/client`. The result is that an editor decides once where an image should pivot and how it should be cropped for each placement, and every downstream surface — your Next.js site, a native app, an email, an RSS thumbnail — gets the right pixels with a correct `srcset` and no layout shift. This document specifies how the focal point is selected, how crops are defined in `kernel.config.ts`, how `srcset` is generated, and how the responsive helpers render markup.

## Where this fits

Uploads are configured on a collection (see [Uploads & Storage Adapters](./01-storage-adapters.md)) and persisted through a storage adapter (see [Image Processing & Transforms](./02-image-processing-and-transforms.md)). This page covers the layer above raw transforms: the editorial intent (focal point, crop boxes) and the delivery contract (`srcset`, `sizes`, helpers). Access control on derivative URLs is covered in [Signed URLs & Access Control](../06-auth-security/01-authorization-and-access-control.md).

## Focal point selection

A focal point is a normalized coordinate `{ x: number; y: number }` in the range `0..1`, where `0,0` is the top-left of the original image. It answers one question: when this image must be cropped to an aspect ratio that differs from the source, which point must remain visible and centered? This is the part Payload gets right with its focal-point UI and Strapi largely punts on — Strapi's Media Library has no editorial focal point at all, so non-square crops drift toward the geometric center. Sanity stores a `hotspot` plus a `crop` rect on the asset reference, which is powerful but couples the crop to the _reference_, not the asset, and leaks `@sanity/image-url` math into every frontend. KernelCMS stores the focal point on the upload document and resolves crops server-side, so frontends never do trigonometry.

The focal point lives in a reserved field that the upload feature injects:

```ts
// Persisted shape on every upload document
interface UploadFocalPoint {
  x: number // 0..1, default 0.5
  y: number // 0..1, default 0.5
}
```

In the admin, focal point is set via a draggable marker overlaid on the image preview. The marker is a TanStack Store-backed control so the value stays reactive across the crop previews shown beside it — drag the dot, and every named-crop thumbnail re-renders its framing live. Editors can also let an adapter that supports it propose a focal point (face/saliency detection); the proposal is a _suggestion_ written into the field, never an irreversible bake. The stored coordinate is the single source of truth; derivatives are recomputed from it.

```ts
// kernel.config.ts — opt into automatic focal-point suggestion
import { defineCollection } from '@kernel/core'

export const Media = defineCollection({
  slug: 'media',
  upload: {
    focalPoint: {
      enabled: true, // adds the draggable marker (default true for image uploads)
      suggest: 'saliency', // 'none' | 'saliency' | 'face' — adapter capability, advisory only
    },
  },
  fields: [{ name: 'alt', type: 'text', required: true }],
})
```

Validation clamps `x` and `y` into `0..1` at the operation boundary; an out-of-range value from a misbehaving client is rejected, not silently coerced into a broken crop.

## Named crops

A named crop is a declared aspect ratio plus rules for how it derives from the source using the focal point. Crops are config-as-code, defined once per upload collection so every document of that type produces a consistent, predictable set of derivatives. This is the key divergence from Sanity (where crop geometry is decided per-usage on the frontend) and from Payload (whose `imageSizes` are fixed pixel boxes, not focal-aware aspect ratios). KernelCMS crops are aspect-ratio-first and focal-aware: you declare the _shape_, the engine computes the _box_ from the focal point.

```ts
// kernel.config.ts
import { defineCollection } from '@kernel/core'

export const Media = defineCollection({
  slug: 'media',
  upload: {
    crops: [
      { name: 'square', aspectRatio: '1:1' },
      { name: 'hero', aspectRatio: '16:9', minWidth: 1280 },
      { name: 'portrait', aspectRatio: '3:4' },
      { name: 'thumbnail', aspectRatio: '1:1', fit: 'cover', widths: [80, 160] },
    ],
    formats: ['avif', 'webp', 'jpeg'], // negotiated per request; see Image Processing doc
  },
  fields: [{ name: 'alt', type: 'text', required: true }],
})
```

Each crop entry resolves against this contract:

| Property      | Type                               | Default   | Meaning                                                             |
| ------------- | ---------------------------------- | --------- | ------------------------------------------------------------------- |
| `name`        | `string`                           | —         | Stable key used in helpers and the typed `media.crops[name]` map.   |
| `aspectRatio` | `` `${number}:${number}` ``        | required  | Target shape; the box is computed to honor it.                      |
| `fit`         | `'cover' \| 'contain' \| 'inside'` | `'cover'` | How the source fills the box.                                       |
| `widths`      | `number[]`                         | derived   | Explicit `srcset` widths; if omitted, defaults apply (below).       |
| `minWidth`    | `number`                           | `0`       | Skip generating widths the source cannot satisfy without upscaling. |
| `gravity`     | `'focal' \| 'center'`              | `'focal'` | Whether the crop box is positioned by the focal point.              |

The crop box is computed by centering the largest rectangle of the target aspect ratio on the focal point, then clamping it inside the source bounds so it never reads outside the image:

```
source (W×H), focal (fx,fy), target ratio r = aw/ah

         ┌──────────────── W ────────────────┐
         │                                   │
         │        ┌───────────┐              │  crop box: widest rect of ratio r
       H │        │     ●fx,fy│              │  centered on (fx·W, fy·H),
         │        └───────────┘              │  then clamped to [0,W]×[0,H]
         │                                   │
         └───────────────────────────────────┘
```

An editor can override the auto-computed box per document with a manual crop rectangle (stored as a normalized `{ x, y, width, height }`); when present it wins over the focal-derived box for that crop on that document. This gives Payload-style automation by default with Sanity-style manual control as an escape hatch.

## Srcset generation

`srcset` is generated server-side from the crop's resolved width ladder. The storage adapter materializes one derivative per `(crop, width, format)` tuple, addressable through a deterministic, signable URL. We never emit a width that would upscale past the source, and we never bloat the ladder past the largest declared `sizes` need.

Default width ladder, when `widths` is omitted, is the intersection of a standard ramp and the source's capability:

```ts
const DEFAULT_WIDTHS = [320, 640, 768, 1024, 1280, 1536, 1920, 2560] as const
// emitted widths = DEFAULT_WIDTHS.filter(w => w <= source.width && w >= crop.minWidth)
```

Derivatives are generated lazily on first request and cached by the adapter, or eagerly at upload time when `upload.eager: true` is set — the tradeoff is upload latency versus first-view latency, and it is yours to make per collection. Either way the URL contract is stable:

```
/media/{id}/{crop}/{width}.{format}?s={signature}
            └ hero  └ 1280  └ avif
```

The signature binds the transform parameters so a client cannot fabricate an unbounded derivative (a real DoS vector in naive image proxies). Signing and access rules are specified in [Signed URLs & Access Control](../06-auth-security/01-authorization-and-access-control.md).

## Responsive image helpers

`@kernel/client` exposes a typed helper that turns an upload document plus a crop name into a complete, ready-to-spread set of `<img>`/`<source>` attributes. The crop names are inferred from your config, so `crop: 'heor'` is a compile error, not a runtime 404.

```ts
import { srcSet } from '@kernel/client'

const img = srcSet(media, {
  crop: 'hero', // ← autocompleted & type-checked from config
  sizes: '(min-width: 1024px) 800px, 100vw',
  formats: ['avif', 'webp'], // optional override of collection formats
})

// img => { src, srcSet, sizes, width, height, alt, fetchPriority? }
```

For React, a thin component wraps the helper and wires `width`/`height` to reserve space and prevent CLS, while emitting `<picture>` with one `<source>` per format in priority order:

```tsx
import { KernelImage } from '@kernel/client/react'

export function Hero({ media }: { media: UploadDoc }) {
  return (
    <KernelImage
      doc={media}
      crop="hero"
      sizes="(min-width: 1024px) 800px, 100vw"
      priority // sets fetchPriority="high" and disables lazy loading
    />
  )
}
```

`KernelImage` always renders `loading="lazy"` and `decoding="async"` unless `priority` is set, pulls `alt` straight from the required upload field, and refuses to render without it — accessibility is enforced at the type level, not left to reviewer vigilance. The intrinsic `width`/`height` come from the crop's largest derivative, so the aspect ratio box is correct before a single byte of image data arrives.

For framework-agnostic use (email, RSS, server-rendered strings), `srcSet` returns plain data you assemble yourself; for TanStack Start routes the same helper runs inside a loader so the markup is fully resolved at SSR with no client round-trip.

## Open questions

- **Animated and vector sources.** Focal points are meaningless for SVG and ambiguous for animated GIF/APNG. Current plan: skip crop generation and pass through the original, but whether `KernelImage` should silently degrade or require an explicit `crop="original"` is undecided.
- **Per-document crop overrides in the typed map.** Manual crop rectangles are stored, but whether `media.crops[name]` should expose the override provenance (auto vs. manual) to the frontend, or hide it as an implementation detail, is still open.
- **Client-negotiated format vs. baked URLs.** Format negotiation via `Accept` keeps URLs format-agnostic but defeats some CDN cache keys. We may offer both modes per storage adapter; the default has not been settled.
