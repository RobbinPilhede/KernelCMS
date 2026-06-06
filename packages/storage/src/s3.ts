/**
 * S3-compatible storage adapter — works against AWS S3, Cloudflare R2, MinIO,
 * Backblaze B2, DigitalOcean Spaces, and anything else that speaks the S3 API.
 * Delivery: a public CDN base URL when set, otherwise a short-lived presigned
 * GET. Credentials default to the SDK's environment/instance chain — never inlined.
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { ObjectHead, PutOptions, PutResult, StorageAdapter, UrlOptions } from './types'
import { assertSafeKey } from './key'

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
  const client = new S3Client({
    region: opts.region ?? 'us-east-1',
    ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
    ...(opts.forcePathStyle ? { forcePathStyle: true } : {}),
    ...(opts.credentials ? { credentials: opts.credentials } : {}),
  })
  const ttl = opts.signedUrlTtl ?? 900
  const base = opts.publicBaseUrl?.replace(/\/+$/, '')

  return {
    name: 's3',
    async put(key, body, options: PutOptions): Promise<PutResult> {
      assertSafeKey(key)
      await client.send(
        new PutObjectCommand({
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
      const res = await client.send(new GetObjectCommand({ Bucket: opts.bucket, Key: key }))
      const body = res.Body as { transformToByteArray(): Promise<Uint8Array> } | undefined
      if (!body) throw new Error(`Object not found: ${key}`)
      return Buffer.from(await body.transformToByteArray())
    },
    async delete(key): Promise<void> {
      assertSafeKey(key)
      // S3 delete of a missing key is a success — idempotent by contract.
      await client.send(new DeleteObjectCommand({ Bucket: opts.bucket, Key: key }))
    },
    async head(key): Promise<ObjectHead | null> {
      assertSafeKey(key)
      try {
        const res = await client.send(new HeadObjectCommand({ Bucket: opts.bucket, Key: key }))
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
      return getSignedUrl(client, new GetObjectCommand({ Bucket: opts.bucket, Key: key }), {
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
