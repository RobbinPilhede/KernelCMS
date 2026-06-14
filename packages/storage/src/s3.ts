/**
 * S3-compatible storage adapter — works against AWS S3, Cloudflare R2, MinIO,
 * Backblaze B2, DigitalOcean Spaces, and anything else that speaks the S3 API.
 * Delivery: a public CDN base URL when set, otherwise a short-lived presigned
 * GET. Credentials default to the SDK's environment/instance chain — never inlined.
 */
import type { S3Client } from '@aws-sdk/client-s3'
import type { ObjectHead, PutOptions, PutResult, StorageAdapter, UrlOptions } from './types'
import { assertSafeKey } from './key'

// The AWS SDK is an OPTIONAL peer dependency. It is loaded LAZILY — on the first S3
// operation, never at import time — so merely importing @kernel/storage (which @kernel/core
// does, for the storage contract + helpers) never pulls @aws-sdk into the module graph. A
// SQLite + local-file + REST install therefore never needs it installed. The `import type`
// above is erased at build time and creates no runtime dependency.
type ClientMod = typeof import('@aws-sdk/client-s3')
type PresignMod = typeof import('@aws-sdk/s3-request-presigner')
let sdkPromise: Promise<{ client: ClientMod; presign: PresignMod }> | null = null
function loadSdk(): Promise<{ client: ClientMod; presign: PresignMod }> {
  if (!sdkPromise) {
    sdkPromise = Promise.all([import('@aws-sdk/client-s3'), import('@aws-sdk/s3-request-presigner')])
      .then(([client, presign]) => ({ client, presign }))
      .catch((err: unknown) => {
        sdkPromise = null
        throw new Error(
          'The S3 storage adapter needs the optional "@aws-sdk/client-s3" and ' +
            '"@aws-sdk/s3-request-presigner" packages. Install them to use s3Storage()/r2():\n' +
            '  npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner',
          { cause: err },
        )
      })
  }
  return sdkPromise
}

export interface S3StorageOptions {
  bucket: string
  region?: string
  /** Custom endpoint for S3-compatible stores (R2, MinIO, Spaces, …). */
  endpoint?: string
  /** Required for MinIO and some compatibles. */
  forcePathStyle?: boolean
  credentials?: { accessKeyId: string; secretAccessKey: string }
  /** Public CDN base (e.g. a Cloudflare custom domain or `…r2.dev`). When set,
   *  `url()` returns `${publicBaseUrl}/${key}` instead of a presigned URL. */
  publicBaseUrl?: string
  /** TTL (seconds) for presigned GET URLs when no `publicBaseUrl`. Default 900. */
  signedUrlTtl?: number
  acl?: 'private' | 'public-read'
}

export function s3Storage(opts: S3StorageOptions): StorageAdapter {
  const ttl = opts.signedUrlTtl ?? 900
  const base = opts.publicBaseUrl?.replace(/\/+$/, '')

  // The SDK and the client are built once, on first use, and cached. Construction is the
  // moment @aws-sdk is actually required — so the factory itself stays synchronous and
  // side-effect-free at import time.
  let clientPromise: Promise<{ client: S3Client; mod: ClientMod; presign: PresignMod }> | null = null
  const getClient = (): Promise<{ client: S3Client; mod: ClientMod; presign: PresignMod }> => {
    if (!clientPromise) {
      clientPromise = loadSdk().then(({ client: mod, presign }) => ({
        client: new mod.S3Client({
          region: opts.region ?? 'us-east-1',
          ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
          ...(opts.forcePathStyle ? { forcePathStyle: true } : {}),
          ...(opts.credentials ? { credentials: opts.credentials } : {}),
        }),
        mod,
        presign,
      }))
    }
    return clientPromise
  }

  return {
    name: 's3',
    async put(key, body, options: PutOptions): Promise<PutResult> {
      assertSafeKey(key)
      const { client, mod } = await getClient()
      await client.send(
        new mod.PutObjectCommand({
          Bucket: opts.bucket,
          Key: key,
          Body: body,
          ContentType: options.contentType,
          ...(options.cacheControl ? { CacheControl: options.cacheControl } : {}),
          ...(opts.acl ? { ACL: opts.acl } : {}),
          ...(options.metadata ? { Metadata: options.metadata } : {}),
        }),
      )
      return { key, size: body.length }
    },
    async get(key): Promise<Buffer> {
      assertSafeKey(key)
      const { client, mod } = await getClient()
      const res = await client.send(new mod.GetObjectCommand({ Bucket: opts.bucket, Key: key }))
      const body = res.Body as { transformToByteArray(): Promise<Uint8Array> } | undefined
      if (!body) throw new Error(`Object not found: ${key}`)
      return Buffer.from(await body.transformToByteArray())
    },
    async delete(key): Promise<void> {
      assertSafeKey(key)
      const { client, mod } = await getClient()
      // S3 delete of a missing key is a success — idempotent by contract.
      await client.send(new mod.DeleteObjectCommand({ Bucket: opts.bucket, Key: key }))
    },
    async head(key): Promise<ObjectHead | null> {
      assertSafeKey(key)
      const { client, mod } = await getClient()
      try {
        const res = await client.send(new mod.HeadObjectCommand({ Bucket: opts.bucket, Key: key }))
        return {
          size: res.ContentLength ?? 0,
          contentType: res.ContentType ?? 'application/octet-stream',
          etag: res.ETag,
          lastModified: res.LastModified,
        }
      } catch (err) {
        if (isNotFound(err)) return null
        throw err
      }
    },
    async url(key, urlOpts?: UrlOptions): Promise<string> {
      assertSafeKey(key)
      if (base) return `${base}/${key}`
      const { client, mod, presign } = await getClient()
      return presign.getSignedUrl(client, new mod.GetObjectCommand({ Bucket: opts.bucket, Key: key }), {
        expiresIn: urlOpts?.ttl ?? ttl,
      })
    },
  }
}

/** Cloudflare R2 preset — S3 API with `region: 'auto'`. Pair with a `publicBaseUrl`
 *  (custom domain / r2.dev) for public assets, or omit for presigned delivery. */
export function r2(opts: Omit<S3StorageOptions, 'region'> & { region?: string }): StorageAdapter {
  return s3Storage({ region: 'auto', ...opts })
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } }
  return e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404
}
