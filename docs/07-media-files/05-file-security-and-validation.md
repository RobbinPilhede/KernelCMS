# File Security & Validation

Uploads are the single largest untrusted-input surface in any CMS. A file is bytes from someone you don't control, written to your storage, and frequently served back to a browser with whatever `Content-Type` you assign it. KernelCMS treats every upload as hostile until proven otherwise: validation runs server-side inside the operation core, never in the admin client, and the same checks apply whether the file arrives through REST, GraphQL, the typed RPC layer, or a direct Local API call. This document specifies how `@kernel/storage` and the upload field validate MIME and content type, enforce size limits, expose malware-scanning hooks, and gate access to private files.

## Where Validation Runs

The upload pipeline is a fixed sequence of stages. Each stage can reject; rejection short-circuits and the bytes are never committed to the storage adapter.

```
client ──multipart──▶ @kernel/server upload handler
                          │
            ┌─────────────┼─────────────────────────────┐
            ▼             ▼             ▼                ▼
      1. size guard  2. ext+mime   3. content sniff  4. scan hook
       (stream cap)   (declared)    (magic bytes)    (async/sync)
            │             │             │                │
            └─────────────┴──────┬──────┴────────────────┘
                                 ▼
                       5. access (create)  ──▶  StorageAdapter.put()
```

Payload and Strapi both validate after buffering the whole file in memory or in a temp directory, which makes the size limit a memory-pressure liability rather than a guard. KernelCMS enforces the size cap as a **streaming byte counter** (stage 1) that aborts the request the moment the threshold is exceeded, before stages 2–5 ever see a complete file. The declared-type and magic-byte checks then run on the head of the stream, and only a fully validated file reaches `StorageAdapter.put()`.

## MIME and Type Validation

There are two distinct things people sloppily call "MIME validation," and KernelCMS keeps them separate:

1. **Declared type** — the extension on the filename and the `Content-Type` header the client sent. Both are attacker-controlled and worthless on their own.
2. **Detected type** — the media type inferred from the file's actual magic bytes by sniffing the first few kilobytes.

Validation passes only when the declared type and the detected type **agree** and the detected type is on the allowlist. A `.png` that sniffs as `text/html` (a classic polyglot/XSS vector) is rejected even though both halves might individually look fine.

```ts
// kernel.config.ts
import { defineConfig } from '@kernel/core'
import { uploadField } from '@kernel/storage'

export default defineConfig({
  collections: [
    {
      slug: 'media',
      upload: {
        // Allowlist by detected type, not by extension.
        // Never use a denylist — you will always miss a format.
        allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'],
        // Detected type must match declared type, else reject.
        sniff: 'strict',        // 'strict' | 'detected-wins' | 'off'
        // Reject SVG by default: it is an HTML/JS execution surface.
        allowSvg: false,
      },
    },
  ],
})
```

The `sniff` modes are deliberately opinionated:

| Mode | Behavior | Use when |
|------|----------|----------|
| `strict` | Declared and detected must match **and** be allowlisted. Default. | Public media, anything served to browsers. |
| `detected-wins` | Ignore the declared type; allowlist the detected type and rewrite `Content-Type` from it. | Trusted internal pipelines where filenames are unreliable. |
| `off` | Allowlist the declared type only. | Never in production. Exists for tests and exotic adapters. |

### SVG, polyglots, and HTML smuggling

SVG is XML that can carry `<script>`, `<foreignObject>`, and event handlers. Served with `image/svg+xml` and rendered inline, it is stored XSS. Sanity sidesteps this by serving everything from a separate asset CDN origin; Payload leaves SVG handling to the integrator. KernelCMS makes the safe choice the default: `allowSvg: false`. When SVG is genuinely required, enabling it forces a sanitization pass:

```ts
upload: {
  allowSvg: true,
  svgSanitize: '@kernel/storage/svg-sanitizer', // strips <script>, on*, href=javascript:, external refs
}
```

Even sanitized SVGs and other user uploads should never be served from your primary application origin — see [Access Control on Private Files](#access-control-on-private-files) and the response-header policy below.

### The detection contract

Type detection is an adapter so you can swap the implementation (the default wraps a magic-byte table; a stricter build can delegate to `file(1)` or a WASM detector):

```ts
interface TypeDetector {
  // Reads only the head of the stream; never buffers the whole file.
  detect(head: Uint8Array, declared: {
    filename: string
    contentType: string
  }): Promise<{ mime: string; ext: string } | null>
}
```

## Size Limits

Size limits are enforced per-collection and can be narrowed per detected type, because "20 MB" is reasonable for a video and absurd for an SVG icon.

```ts
upload: {
  maxFileSize: '20mb',          // global cap for this collection
  perType: {
    'image/svg+xml': '256kb',   // tight cap — SVG bombs are a DoS vector
    'application/pdf': '15mb',
    'video/mp4': '500mb',
  },
}
```

Resolution order: a `perType` entry wins over the collection `maxFileSize`, which wins over the global default in `kernel.config.ts`. The limit is enforced as a streaming counter, so a client that lies about `Content-Length` and then streams 4 GB still gets cut off at the cap with a `413`.

| Concern | KernelCMS behavior |
|---------|--------------------|
| Oversized upload | Stream aborted at threshold, `413 Payload Too Large`, nothing written. |
| Falsified `Content-Length` | Ignored; actual byte count governs. |
| Decompression bomb (SVG/PDF/zip) | Caught by the tight `perType` cap on the *compressed* bytes; downstream image processing has its own pixel-dimension cap. |
| Multipart with many small files | `maxFiles` per request cap (default 10) rejects flood requests. |

Strapi and Payload expose a single global size limit; per-type caps are the difference between a usable video field and a wide-open DoS hole.

## Malware Scanning Hooks

KernelCMS ships no bundled antivirus engine — that would be a maintenance and licensing liability. Instead it exposes a typed `scan` hook that runs after validation and before commit, so you wire in ClamAV, a cloud scanning API, or a queue-based async scan. This is more than Payload, Sanity, or Strapi offer out of the box; none of them have a first-class scanning stage.

```ts
import type { ScanContext, ScanResult } from '@kernel/storage'

upload: {
  scan: {
    mode: 'sync',          // 'sync' | 'async'
    timeoutMs: 8_000,      // sync scans that exceed this are treated as failures
    onTimeout: 'reject',   // 'reject' | 'quarantine'
    async scanner(ctx: ScanContext): Promise<ScanResult> {
      const verdict = await clamav.scanStream(ctx.stream)
      return verdict.isInfected
        ? { status: 'infected', signature: verdict.viruses[0] }
        : { status: 'clean' }
    },
  },
}
```

```ts
interface ScanContext {
  stream: ReadableStream<Uint8Array>
  size: number
  detectedMime: string
  filename: string
  collection: string
  user: AuthUser | null
}

type ScanResult =
  | { status: 'clean' }
  | { status: 'infected'; signature: string }
  | { status: 'error'; reason: string }
```

### Sync vs. async

```
sync mode                        async mode
─────────                        ──────────
upload ─▶ scan ─▶ commit ─▶ 201  upload ─▶ commit (pending) ─▶ 201
          (blocks)                          │
                                            ▼ @kernel/rpc queue job
                                       scanner ─▶ clean ▶ status:ready
                                                └ infected ▶ delete + audit
```

- **`sync`** blocks the upload response until the verdict returns. Correct for low-volume, high-trust admin uploads where you want a hard guarantee that nothing infected is ever stored.
- **`async`** commits the file in a `pending` state, enqueues a scan via the configured queue adapter, and flips the document to `ready` or deletes it on the result. Use this for high-volume public uploads. While `pending`, the file is treated as private and is never publicly servable.

Every non-clean result writes an audit entry (`upload.scan.infected`, `upload.scan.error`) through the same hook surface described in Audit Logging, capturing the user, collection, filename, and signature.

## Access Control on Private Files

Storage and authorization are separate concerns. A file living in S3 is not "secure" because the bucket is private — it's secure because every read goes through KernelCMS access control. The upload field reuses the same `access` evaluators documented in [Access Control](../06-auth-security/01-authorization-and-access-control.md), evaluated at the document and field level on the **read** operation.

```ts
{
  slug: 'invoices',
  upload: {
    // Files are never directly reachable; all reads are brokered.
    serve: 'private',
    access: {
      read: ({ req, doc }) =>
        req.user?.role === 'admin' || doc.ownerId === req.user?.id,
    },
  },
}
```

`serve` has three modes:

| Mode | URL shape | Authorization |
|------|-----------|---------------|
| `public` | Stable CDN URL | None — only for genuinely public assets. |
| `signed` | Time-limited signed URL minted per request | Access checked when the signed URL is issued; URL expires. |
| `private` | `/api/media/:id/file` brokered through `@kernel/server` | Access checked on **every** request; no shareable URL escapes. |

For `signed`, KernelCMS asks the storage adapter to mint a short-lived URL only after the `read` evaluator passes:

```ts
interface StorageAdapter {
  put(key: string, body: ReadableStream, meta: ObjectMeta): Promise<void>
  get(key: string): Promise<ReadableStream>
  signedUrl(key: string, opts: { expiresIn: number; disposition?: string }): Promise<string>
  delete(key: string): Promise<void>
}
```

Payload brokers private files through its own server but historically leaned on obscure URLs; Strapi's default is fully public uploads. KernelCMS makes `signed`/`private` first-class and ties them to the same access layer that protects every other operation, so authorization can never drift between "the document" and "the file attached to it."

### Hardened response headers

Every brokered or signed response from `@kernel/storage` sets defensive headers, regardless of `serve` mode:

```
Content-Type: <detected mime>            # never the client-declared type
X-Content-Type-Options: nosniff          # stop browser MIME re-sniffing
Content-Disposition: attachment          # for non-image, non-allowlisted inline types
Content-Security-Policy: default-src 'none'; sandbox
Cache-Control: private, no-store         # for private/signed serve modes
```

Serving user files from a dedicated asset origin (a separate domain or subdomain) is strongly recommended so that even a bypass cannot reach same-origin cookies or the admin session. KernelCMS Cloud serves all uploads from an isolated CDN origin by default; self-hosters should configure `assetOrigin` in `kernel.config.ts`.

## Open Questions

- **Image re-encoding as a sanitization default.** Re-encoding every image through the processing pipeline (`@kernel/storage` transforms) strips embedded scripts, EXIF, and polyglot payloads, but breaks lossless and animated formats. Should re-encode-on-upload be the default for raster images, opt-in, or per-type?
- **Async scan and live preview.** When a `pending` (unscanned) file is referenced in a draft that an editor live-previews, do we show a placeholder, a watermarked proxy, or block the preview entirely until the scan clears?
- **Per-tenant scanner overrides on Cloud.** Should KernelCMS Cloud allow a tenant to bring their own scanner endpoint, and if so, how do we bound the `timeoutMs` so one tenant's slow scanner can't starve shared upload workers?
