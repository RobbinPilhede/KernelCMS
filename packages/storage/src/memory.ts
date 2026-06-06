/**
 * In-memory storage adapter. Holds bytes in a Map — ideal for tests and
 * ephemeral previews. Not for production (lost on restart, not shared across
 * nodes). `url()` returns a data: URL so previews work without a server route.
 */
import type { ObjectHead, PutOptions, PutResult, StorageAdapter } from './types'
import { assertSafeKey } from './key'

export interface MemoryStorageOptions {
  /** Base path used to build readable URLs, e.g. '/files'. Default 'memory://'. */
  servePath?: string
}

interface Stored {
  body: Buffer
  contentType: string
  lastModified: Date
}

export function memoryStorage(opts: MemoryStorageOptions = {}): StorageAdapter & { _store: Map<string, Stored> } {
  const store = new Map<string, Stored>()
  const servePath = opts.servePath ?? 'memory://'

  return {
    name: 'memory',
    _store: store,
    async put(key, body, options: PutOptions): Promise<PutResult> {
      assertSafeKey(key)
      store.set(key, { body, contentType: options.contentType, lastModified: new Date() })
      return { key, size: body.length }
    },
    async get(key): Promise<Buffer> {
      const item = store.get(key)
      if (!item) throw new Error(`Object not found: ${key}`)
      return item.body
    },
    async delete(key): Promise<void> {
      store.delete(key) // idempotent
    },
    async head(key): Promise<ObjectHead | null> {
      const item = store.get(key)
      if (!item) return null
      return { size: item.body.length, contentType: item.contentType, lastModified: item.lastModified }
    },
    async url(key): Promise<string> {
      return servePath.endsWith('://') ? `${servePath}${key}` : `${servePath.replace(/\/$/, '')}/${key}`
    },
  }
}
