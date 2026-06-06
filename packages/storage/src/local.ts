/**
 * Local-disk storage adapter. Writes under `rootDir` and resolves URLs against
 * `servePath` (served by @kernel/server, which re-checks access per request).
 * Single-node only — two API hosts behind a load balancer will not share disk.
 */
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import type { ObjectHead, PutOptions, PutResult, StorageAdapter } from './types'
import { assertSafeKey } from './key'

export interface LocalStorageOptions {
  /** Directory on disk where objects are written. */
  rootDir: string
  /** URL base the adapter resolves keys against, e.g. '/files'. Default '/files'. */
  servePath?: string
}

export function localStorage(opts: LocalStorageOptions): StorageAdapter {
  const root = resolve(opts.rootDir)
  const servePath = (opts.servePath ?? '/files').replace(/\/$/, '')

  const pathFor = (key: string): string => {
    assertSafeKey(key)
    const full = resolve(root, key)
    // Defense in depth: the resolved path must stay within root.
    if (full !== root && !full.startsWith(root + sep)) {
      throw new Error(`Resolved path escapes storage root: ${key}`)
    }
    return full
  }

  return {
    name: 'local',
    servePath,
    async put(key, body, _opts: PutOptions): Promise<PutResult> {
      const full = pathFor(key)
      await mkdir(dirname(full), { recursive: true })
      await writeFile(full, body)
      return { key, size: body.length }
    },
    async get(key): Promise<Buffer> {
      return readFile(pathFor(key))
    },
    async delete(key): Promise<void> {
      await rm(pathFor(key), { force: true }) // idempotent: no error if absent
    },
    async head(key): Promise<ObjectHead | null> {
      try {
        const s = await stat(pathFor(key))
        return { size: s.size, contentType: 'application/octet-stream', lastModified: s.mtime }
      } catch {
        return null
      }
    },
    async url(key): Promise<string> {
      assertSafeKey(key)
      return `${servePath}/${key}`
    },
  }
}

/** Resolve a key to its absolute on-disk path (for the server's file route). */
export function localObjectPath(rootDir: string, key: string): string {
  assertSafeKey(key)
  return join(resolve(rootDir), key)
}
