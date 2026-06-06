/**
 * The storage adapter contract. Deliberately small: it moves bytes and resolves
 * URLs — it knows nothing about images, validation, or field config. The core
 * hands adapters opaque, pre-sanitized keys (no leading slash, no `..`). See
 * docs/07-media-files/01-storage-adapters.md.
 */

export interface PutOptions {
  contentType: string
  contentLength?: number
  cacheControl?: string
  acl?: 'private' | 'public-read'
  metadata?: Record<string, string>
}

export interface PutResult {
  key: string
  size: number
}

export interface ObjectHead {
  size: number
  contentType: string
  etag?: string
  lastModified?: Date
}

export interface UrlOptions {
  /** Time-to-live in seconds for adapters that mint signed URLs. */
  ttl?: number
}

export interface StorageAdapter {
  readonly name: string
  /** URL path prefix the host server should serve this adapter's bytes from
   *  (set by adapters that stream through the API host, e.g. local disk). */
  readonly servePath?: string
  /** Persist bytes under `key`. Idempotent on key. */
  put(key: string, body: Buffer, opts: PutOptions): Promise<PutResult>
  /** Read bytes back. Used for local serving and migrations. */
  get(key: string): Promise<Buffer>
  /** Remove an object. MUST resolve cleanly if the key is already gone. */
  delete(key: string): Promise<void>
  /** Cheap existence/size check without transferring the body. */
  head(key: string): Promise<ObjectHead | null>
  /** Public or signed delivery URL. Callers treat the result opaquely. */
  url(key: string, opts?: UrlOptions): Promise<string>
}
