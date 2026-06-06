# CDN & Delivery

KernelCMS treats media delivery as a first-class adapter concern, not an afterthought bolted onto storage. The `@kernel/storage` adapter knows where bytes _live_; the delivery layer decides how they reach a browser — which CDN fronts them, how cache keys are derived, whether a URL must be signed, and where transforms execute. This document specifies that delivery layer: how to wire a CDN, how cache keys and invalidation work, how signed URLs gate private assets, and how edge transforms turn a single stored original into a globally cached, format-negotiated variant. The design goal is the same as everywhere else in KernelCMS — sensible defaults that work on day one, with an escape hatch at every seam.

## CDN integration

A CDN in KernelCMS is configured per-storage-adapter, because the public base URL of an asset is a property of where it is stored. Payload and Strapi both leave CDN wiring almost entirely to you — you rewrite URLs in a hook or reverse-proxy in front of the upload route. Sanity goes the other way: its CDN (`cdn.sanity.io`) is hard-wired and non-optional. KernelCMS sits deliberately in between. The CDN is a typed, swappable adapter you choose, but it is a real adapter with real behavior (URL signing, invalidation, transform delegation), not a string you have to remember to prepend.

```ts
// kernel.config.ts
import { defineConfig } from '@kernel/core'
import { s3Storage } from '@kernel/storage'
import { cloudflareCDN } from '@kernel/storage/cdn'

export default defineConfig({
  storage: s3Storage({
    bucket: 'kernel-media',
    region: 'eu-central-1',
    cdn: cloudflareCDN({
      baseUrl: 'https://cdn.example.com',
      zoneId: process.env.CF_ZONE_ID!,
      apiToken: process.env.CF_API_TOKEN!,
      // edge transforms via Cloudflare Image Resizing
      transforms: 'edge',
    }),
  }),
})
```

The CDN adapter implements a narrow contract. Anything satisfying it — a managed provider, a self-hosted Varnish, a bare reverse proxy — drops in unchanged.

```ts
export interface CDNAdapter {
  /** Public, cache-friendly URL for a stored object key + optional transform. */
  resolveUrl(key: string, opts?: TransformParams & { signed?: boolean }): string
  /** Purge one or more cache keys after a mutation. */
  invalidate(keys: string[]): Promise<InvalidationResult>
  /** Sign a delivery URL with an expiry for private assets. */
  sign(key: string, opts: SignOptions): SignedUrl
  /** Where transforms run: 'origin' | 'edge' | 'none'. */
  readonly transforms: TransformMode
}
```

Built-in adapters ship for `cloudflareCDN`, `cloudfrontCDN`, `fastlyCDN`, `bunnyCDN`, and `imgproxyCDN` (self-hosted origin transforms). On KernelCMS Cloud the CDN is preconfigured — a global content CDN is part of the managed platform — but the same adapter interface is exposed so a Cloud project can be exported and self-hosted without rewriting a single URL.

```
upload  ──►  @kernel/storage (S3/GCS/local/...)   ◄── source of truth (originals)
                       │
                resolveUrl(key, transform)
                       ▼
            CDNAdapter  ──►  edge POP (cache HIT)  ──►  browser
                       │            │ MISS
                       └────────────┴──►  origin transform / passthrough
```

URL resolution flows through `@kernel/client` and the admin media library automatically, so you never hand-build CDN URLs. `client.media.url(doc, { width: 800, format: 'auto' })` returns the signed-or-public, transform-encoded CDN URL for that asset. See [storage adapters](./01-storage-adapters.md) for how originals are persisted and [image transforms](./02-image-processing-and-transforms.md) for the transform pipeline itself.

## Cache keys and invalidation

A CDN is only as good as its cache key discipline. KernelCMS derives a deterministic cache key from four inputs: the object key, the transform parameters (normalized and sorted), the negotiated output format, and a per-asset **version token**. The version token is the linchpin — it is what makes invalidation atomic.

```
cacheKey = `${objectKey}@${version}/${normalizedTransform}.${format}`

example:
  media/2026/hero.jpg@v7/w=800,q=82,fit=cover.webp
```

The version token is stored on the upload document and bumped whenever the underlying bytes change — a re-upload, a focal-point edit, or a manual "regenerate". Because the token is _in the URL path_, a new version produces a brand-new cache key, and the old cached objects simply age out. This is how Sanity avoids stale assets, and it is strictly better than the alternative most Strapi/Payload deployments fall back on: a global wildcard purge that hammers the CDN API and momentarily cold-caches everything.

| Strategy                            | When KernelCMS uses it                   | Trade-off                                    |
| ----------------------------------- | ---------------------------------------- | -------------------------------------------- |
| Version-token (immutable URL)       | Default for all rendered variants        | Zero purge calls; old bytes age out via TTL  |
| Targeted purge (`invalidate(keys)`) | Original re-uploaded under a stable URL  | One API call per affected key                |
| Tag/surrogate-key purge             | Bulk operations (re-encode a collection) | One call purges many; needs provider support |
| Wildcard purge                      | Manual escape hatch only                 | Expensive; cold cache; rate-limited          |

Invalidation is wired to the operation lifecycle, not left to the developer to remember. The upload collection hook fires `invalidate` on the exact derived keys:

```ts
// internal: @kernel/storage upload lifecycle
afterChange: async ({ doc, previousDoc, req }) => {
  if (bytesChanged(doc, previousDoc)) {
    doc.cdnVersion = nextVersion(previousDoc?.cdnVersion)
    // new version => new immutable URLs, no purge needed for variants
  }
  if (urlStableButContentChanged(doc, previousDoc)) {
    const keys = enumerateVariantKeys(doc) // every generated size/format
    await req.payload.storage.cdn.invalidate(keys)
  }
}
```

For providers that support **surrogate keys** (Fastly, and Cloudflare via cache tags), KernelCMS tags every delivered variant with `kernel:asset:<id>` and, for bulk jobs, `kernel:collection:<slug>`. A re-encode migration then purges one tag instead of N URLs:

```ts
await storage.cdn.invalidate(['kernel:collection:media'])
```

Set cache headers explicitly per asset class. Rendered, version-pinned variants are immutable and cached aggressively; the original (mutable URL) gets a short TTL with revalidation.

```ts
cloudflareCDN({
  cacheControl: {
    variants: 'public, max-age=31536000, immutable',
    originals: 'public, max-age=300, must-revalidate',
    signed: 'private, max-age=60',
  },
})
```

## Signed delivery

Public-by-default is wrong for a CMS that also stores invoices, gated downloads, and pre-publish draft imagery. KernelCMS makes access control on delivery an extension of the same access-control evaluation used everywhere else — the upload collection's `access.read` function decides whether an asset is public or must be signed, and the delivery layer enforces it. This is a real differentiator: Strapi serves uploads publicly with no native signing, and Payload requires you to hand-roll a signed-route handler. KernelCMS bakes signing into `resolveUrl`.

```ts
// kernel.config.ts — a private media collection
collections: [
  {
    slug: 'protected-assets',
    upload: {
      storage: 'private-bucket',
      access: {
        // evaluated server-side per request
        read: ({ req }) => Boolean(req.user) && req.user.role !== 'guest',
      },
      delivery: {
        signed: true,
        ttl: 300,            // seconds
        algorithm: 'sha256', // HMAC; provider may use its own scheme
      },
    },
  },
],
```

When `access.read` resolves to anything other than "public", `client.media.url()` returns a signed URL with an HMAC signature and expiry baked into the query string. The signature covers the object key, the transform params, and the expiry, so a signed variant URL cannot be tampered into a different transform or a longer life.

```
https://cdn.example.com/media/contract.pdf
  ?exp=1748620800
  &kt=w%3D1200%2Cq%3D82
  &sig=9f4c2a…   ◄── HMAC over (key + kt + exp), secret never leaves the server
```

Signing keys live in `@kernel/storage` config (or the provider's keypair for CloudFront signed URLs) and never reach the client. The admin panel requests fresh signed URLs through a TanStack Start server function, so the secret stays server-side and TanStack Query handles caching and refetch-before-expiry. Two enforcement modes:

- **Edge-verified** (CloudFront, Cloudflare Workers, Fastly Compute): the signature is checked at the POP. Unauthorized requests never touch origin.
- **Origin-verified** (self-hosted): the `@kernel/server` delivery route verifies the HMAC before streaming from storage. Slower, but no provider lock-in.

```ts
// @kernel/client usage
const url = await client.media.url(asset, {
  width: 1200,
  signed: true, // forced; ignored if collection is public
})
// url is valid for `ttl`; the client refetches before expiry
```

## Edge transforms

The cleanest delivery model is one stored original and every variant generated on demand, cached at the edge, keyed immutably. KernelCMS supports three transform locations, chosen by the `transforms` field on the CDN adapter, so the same `kernel.config.ts` runs whether or not your provider can resize at the edge.

| Mode     | Where it runs                                                    | Use when                                            |
| -------- | ---------------------------------------------------------------- | --------------------------------------------------- |
| `edge`   | CDN POP (Cloudflare Images, Fastly IO, CloudFront + Lambda@Edge) | Provider supports it; best global latency           |
| `origin` | `@kernel/server` via sharp / imgproxy                            | Self-host, full control, no provider transform fees |
| `none`   | Pre-generated sizes only                                         | Locked-down environments, no on-the-fly resizing    |

Transform parameters are a single normalized vocabulary shared across all modes, so switching from `origin` to `edge` never changes a URL's meaning — only where the work happens.

```ts
interface TransformParams {
  width?: number
  height?: number
  fit?: 'cover' | 'contain' | 'fill' | 'inside' | 'outside'
  format?: 'auto' | 'webp' | 'avif' | 'jpeg' | 'png'
  quality?: number // 1–100
  dpr?: 1 | 2 | 3
  focal?: { x: number; y: number } // from the focal-point editor
}
```

`format: 'auto'` performs server-side content negotiation: the edge inspects the `Accept` header and serves AVIF, then WebP, then the original format, and — critically — varies the cache key on the negotiated format rather than on raw `Accept`, so the cache doesn't fragment across dozens of header permutations. This is the behavior Sanity's CDN gives you for free and that Payload/Strapi leave you to implement; KernelCMS makes it a one-word option.

```ts
cloudflareCDN({
  baseUrl: 'https://cdn.example.com',
  transforms: 'edge',
  defaults: { format: 'auto', quality: 82, dpr: 1 },
  // hard caps so a hostile query string can't request a 30k-px render
  limits: { maxWidth: 4000, maxHeight: 4000, allowedFormats: ['webp', 'avif', 'jpeg'] },
})
```

Those `limits` are not optional polish — unbounded transform endpoints are a denial-of-wallet vector. KernelCMS rejects out-of-range transform requests at resolution time (the URL is never minted) and again at the edge/origin, returning the nearest allowed variant rather than rendering an attacker-chosen size. Requested transforms are validated against the allowlist before a cache key is generated, so the cache can never be poisoned with a junk render.

```
client.media.url(asset,{w:800,format:'auto'})
        │  normalize + validate against limits
        ▼
  resolveUrl  ──►  immutable cache key  ──►  edge POP
                                              │ MISS
                                              ▼
                                    edge transform (sharp/imgproxy)
                                              │  store + serve AVIF/WebP
                                              ▼
                                            browser
```

For the transform engine and focal-point UX themselves, see [image transforms](./02-image-processing-and-transforms.md). Delivery's job ends at: hand the edge a validated, immutable, optionally-signed key, and let the cache do the rest.

## Open questions

- **Surrogate-key granularity.** Per-asset tags are clearly worth it; per-field or per-document tagging for richText-embedded media may explode tag cardinality on large providers. Undecided whether to cap tag depth or make it adapter-configurable.
- **Signed-URL renewal at the edge.** For edge-verified signing we currently mint short-lived URLs and refetch. A cookie-based session signature (one auth check, many assets) would cut round-trips but couples delivery to the admin session — unclear if that's an acceptable trade for the public `@kernel/client`.
- **Transform cost accounting on Cloud.** Edge transforms have real per-render cost. Whether KernelCMS Cloud meters by render, by cached-variant count, or by egress is still open and affects whether `format: 'auto'` should default to AVIF (smaller egress, costlier encode) or WebP.
