# Storage Adapters

KernelCMS treats file storage as a swappable adapter, exactly like its database and email layers. The CMS core never reads or writes bytes directly — it talks to a single `StorageAdapter` contract, and the concrete backend (local disk, S3, R2, GCS, Azure) is chosen in `kernel.config.ts`. This means an `upload` field behaves identically whether files land on a developer's laptop or in a multi-region object store, and you can change that decision later without touching collection config or content. This document specifies the adapter contract, the first-party backends, signed-URL delivery, and how to migrate from one store to another without breaking existing references.

## The storage adapter contract

Every storage backend implements one interface from `@kernel/storage`. The contract is deliberately small: it is about moving bytes and resolving URLs, not about images, validation, or metadata — those live in the upload field and the [media library](../04-admin-ui/09-media-library-ui.md). Adapters receive a normalized object key and a stream; they never see KernelCMS field config.

```ts
// @kernel/storage
export interface StorageAdapter {
  readonly name: string

  // Persist a stream/buffer under `key`. Idempotent on key.
  put(key: string, body: Readable | Buffer, opts: PutOptions): Promise<PutResult>

  // Stream bytes back. Used for local serving and migrations.
  get(key: string): Promise<Readable>

  // Remove an object. MUST resolve cleanly if the key is already gone.
  delete(key: string): Promise<void>

  // Cheap existence/size check without transferring the body.
  head(key: string): Promise<ObjectHead | null>

  // Public or signed delivery URL. See "Signed URLs" below.
  url(key: string, opts?: UrlOptions): Promise<string>

  // Optional: direct browser→store uploads, bypassing the API host.
  presignPut?(key: string, opts: PresignOptions): Promise<PresignedUpload>
}

export interface PutOptions {
  contentType: string
  contentLength?: number
  cacheControl?: string
  acl?: 'private' | 'public-read'
  metadata?: Record<string, string>
}

export interface ObjectHead {
  size: number
  contentType: string
  etag: string
  lastModified: Date
}
```

Three rules keep adapters interchangeable:

- **Keys, not paths.** The core hands adapters opaque keys like `posts/2026/hero-a1b2.webp`. No leading slashes, no backslashes, no `..`. Key generation is centralized so every backend stores the same layout.
- **`delete` is idempotent.** Deleting a missing object is success, never an error. This makes garbage collection and failed-upload cleanup safe to retry.
- **`url()` is the only delivery contract.** Callers never assume a public base URL. An adapter may return a permanent CDN URL or a short-lived signed URL; consumers treat both opaquely.

Payload couples storage to its `@payloadcms/plugin-cloud-storage` plugin and a handful of provider adapters; Strapi ships a provider system too, but its `upload` provider API leaks provider-specific options into config. KernelCMS keeps the contract narrow and uniform: provider quirks stay inside the adapter package, and `upload` fields are written once against the abstraction.

```
upload field ─┐
              ▼
        @kernel/server (key gen, validation, hooks)
              ▼
        StorageAdapter.put / url / delete
              ▼
   ┌──────┬──────┬──────┬──────┬───────┐
 local    S3     R2    GCS   Azure   custom
```

## Configuring a backend

Storage is wired in `kernel.config.ts` under `storage`. The default scaffold from `create-kernel` uses the local adapter so a clone-and-run works with zero cloud credentials.

```ts
import { defineConfig } from '@kernel/core'
import { s3 } from '@kernel/storage/s3'
import { local } from '@kernel/storage/local'

export default defineConfig({
  storage:
    process.env.NODE_ENV === 'production'
      ? s3({
          bucket: process.env.S3_BUCKET!,
          region: process.env.S3_REGION!,
          credentials: {
            accessKeyId: process.env.S3_ACCESS_KEY_ID!,
            secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
          },
          // Delivery: serve through CloudFront, sign when private.
          publicBaseUrl: process.env.CDN_BASE_URL,
          signedUrlTtl: 900,
        })
      : local({ rootDir: './.kernel/uploads', servePath: '/files' }),
})
```

You can run **multiple** stores by passing a map and pointing individual `upload` collections at one of them — useful when public marketing images live on a CDN bucket while private contracts live in a locked-down bucket.

```ts
storage: {
  default: r2({ bucket: 'public-assets', /* ... */ }),
  secure: s3({ bucket: 'private-docs', acl: 'private', signedUrlTtl: 300 }),
}
```

```ts
// in a collection
upload: { store: 'secure' }
```

## Local, S3, R2, GCS, and Azure

All five first-party adapters live in `@kernel/storage` and share the contract above. They differ only in credentials and a few delivery options.

| Adapter | Import | Best for | Signed URLs | Direct upload |
|---|---|---|---|---|
| Local | `@kernel/storage/local` | dev, single-node self-host | served via API host | n/a |
| S3 | `@kernel/storage/s3` | AWS, MinIO, any S3-compatible | SigV4 presign | yes |
| R2 | `@kernel/storage/r2` | Cloudflare, zero egress fees | SigV4 presign | yes |
| GCS | `@kernel/storage/gcs` | Google Cloud | V4 signed URL | yes |
| Azure | `@kernel/storage/azure` | Azure Blob Storage | SAS token | yes |

**Local** writes to `rootDir` and serves through a TanStack Start server function at `servePath`. It is the only adapter where KernelCMS itself streams bytes, so it enforces access control per request before piping the file. It is not meant for multi-node deployments — two API hosts behind a load balancer will not share a local disk. Use it for development, single-VM self-host, or as a migration source/target.

**S3** is the workhorse and doubles as the adapter for any S3-compatible store: MinIO, Backblaze B2, DigitalOcean Spaces, Wasabi. Point `endpoint` at the compatible host and set `forcePathStyle: true` for MinIO.

```ts
import { s3 } from '@kernel/storage/s3'

s3({
  bucket: 'media',
  region: 'us-east-1',
  endpoint: 'http://minio:9000',
  forcePathStyle: true,
  credentials: { accessKeyId: '...', secretAccessKey: '...' },
})
```

**R2** is S3-compatible under the hood but ships as its own adapter so the defaults are correct: R2 has no regions (`region: 'auto'`), charges zero egress, and pairs naturally with a Cloudflare CDN domain. Set `publicBaseUrl` to your `r2.dev` or custom domain and most reads skip signing entirely.

**GCS** uses a service-account JSON key (or workload identity on GKE) and the native V4 signing API. Provide credentials by path or inline:

```ts
import { gcs } from '@kernel/storage/gcs'

gcs({
  bucket: 'kernel-media',
  projectId: 'my-project',
  credentials: JSON.parse(process.env.GCP_SA_KEY!),
})
```

**Azure** targets Blob Storage. Configure with an account name plus either an account key or a connection string, and a container. Signed delivery uses SAS tokens with a configurable expiry.

```ts
import { azure } from '@kernel/storage/azure'

azure({
  account: 'kernelmedia',
  container: 'uploads',
  connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING!,
  sasTtl: 600,
})
```

Sanity hides storage entirely — you cannot choose your bucket, and assets live on Sanity's CDN. That is excellent until you need data residency, a private VPC, or your own egress economics. KernelCMS gives you Sanity's frictionless default (managed storage on KernelCMS Cloud) while keeping the bucket yours when you self-host.

## Signed URLs

Public-read objects get a stable URL and lean on CDN caching. Private objects must never be world-readable, so `url()` returns a time-limited signed URL minted on demand. The adapter decides the mechanism — SigV4 query params for S3/R2, V4 signed URLs for GCS, SAS tokens for Azure — but the caller experience is identical.

```ts
import { getPayload } from '@kernel/client'

const kernel = await getPayload()
const doc = await kernel.findByID({ collection: 'contracts', id })

// Private store → short-lived signed URL, access-checked first.
const href = await kernel.storage.url(doc.file.key, { ttl: 120 })
```

Access control runs **before** signing. KernelCMS evaluates the `upload` field's `access.read` rule against the request, and only mints a URL if the caller is authorized. A signed URL is therefore proof of a passed authorization check, not a substitute for one. Keep TTLs short (60–900s) for sensitive media; the admin and REST/GraphQL layers re-sign transparently on each read, so users never see expiry.

Direct browser uploads use the same signing path in reverse. `presignPut()` returns a one-time URL the client `PUT`s to, so large files never transit the API host:

```
browser ──(1) request upload ──▶ @kernel/server  (validates type/size, checks access)
browser ◀─(2) presigned PUT URL ── @kernel/server
browser ──(3) PUT bytes ─────────▶ object store
browser ──(4) confirm key ───────▶ @kernel/server (creates upload doc)
```

The server still owns validation: it constrains content type, max size, and key prefix in the presign request, and the store enforces them, so a malicious client cannot upload an executable to an arbitrary path. Payload and Strapi proxy uploads through the app server by default; KernelCMS makes presigned direct upload a first-class, access-gated path.

## Migrating between stores

Because every adapter implements the same contract, switching backends is a copy plus a config change. Object keys are stable across stores, so references stored on documents (`{ key, size, contentType }`) stay valid as long as the key survives the copy. The `kernel storage migrate` command streams every object from a source adapter to a target adapter.

```bash
# Copy all objects from the current store to a new one, in parallel.
kernel storage migrate --from local --to s3 --concurrency 16

# Verify (head + size + etag) without copying.
kernel storage migrate --from local --to s3 --dry-run

# Resume a partial run; already-present keys are skipped via head().
kernel storage migrate --from local --to s3 --resume
```

The recommended cutover keeps zero downtime by writing to both stores before flipping reads:

1. **Dual-write.** Add the new store and mark it `mirror: true`. New uploads land in both; reads still resolve from the old store.
2. **Backfill.** Run `kernel storage migrate` to copy historical objects. It is idempotent — `head()` skips keys already present, so re-runs are cheap and resumable.
3. **Verify.** `--dry-run` re-heads both sides and reports any size/etag mismatches or missing keys.
4. **Flip reads.** Make the new store `default`. The old store stays as a read fallback for one deploy cycle.
5. **Decommission.** Drop the old adapter once metrics show zero fallback reads.

Keys are content-addressed enough to be collision-safe across this process, and because `url()` is resolved per request, no document needs rewriting — flipping the default adapter is what changes where bytes are served from. This is the migration story Sanity cannot offer (no portable bucket) and that Payload/Strapi leave to hand-rolled scripts.

## Open questions

- **Per-field stores vs. per-collection stores.** The current design binds a store at the collection's `upload` config. Should individual `upload` *fields* be allowed to target different stores, or is collection-level granularity enough?
- **Server-side encryption ownership.** Do we expose SSE-KMS / customer-managed keys as first-class adapter options, or treat encryption as a bucket-policy concern outside the contract?
- **Checksum strategy for verification.** ETag semantics differ across S3 multipart, GCS, and Azure. Should `--dry-run` fall back to a streamed SHA-256 when ETags are not comparable, accepting the extra egress cost?
