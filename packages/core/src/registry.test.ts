import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { initKernel } from './index'
import type { Doc } from './index'

const trusted = { overrideAccess: true } as const

function config(dbPath: string) {
  return {
    secret: 'registry-test',
    db: sqliteAdapter({ url: `file:${dbPath}`, wal: false }),
    collections: [
      {
        slug: 'notes',
        access: { read: () => true, create: () => true, update: () => true },
        fields: [{ name: 'body', type: 'text' as const }],
      },
    ],
  }
}

let dir: string
let dbPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kernel-registry-'))
  dbPath = join(dir, 'test.db')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('table registry without autoMigrate', () => {
  it('resolves tables for reads after booting an already-migrated database', async () => {
    // Phase 1: migrate and seed, then shut down — the file now has real tables.
    const seeder = await initKernel(config(dbPath), { autoMigrate: true, logLevel: 'error' })
    const created = await seeder.create<Doc & { body: string }>({
      collection: 'notes',
      data: { body: 'hello' },
      ...trusted,
    })
    await seeder.destroy()

    // Phase 2: boot WITHOUT autoMigrate (the realistic prod/script/embed start).
    // Previously this threw "Unknown table" because the registry was only ever
    // populated inside migrate(); now initKernel registers the schema on boot.
    const reader = await initKernel(config(dbPath), { logLevel: 'error' })
    const found = await reader.findByID<Doc & { body: string }>({
      collection: 'notes',
      id: created.id,
      ...trusted,
    })
    expect(found?.body).toBe('hello')

    const list = await reader.find<Doc & { body: string }>({ collection: 'notes', ...trusted })
    expect(list.totalDocs).toBe(1)
    await reader.destroy()
  })

  it('allows writes without autoMigrate too', async () => {
    const seeder = await initKernel(config(dbPath), { autoMigrate: true, logLevel: 'error' })
    await seeder.destroy()

    const writer = await initKernel(config(dbPath), { logLevel: 'error' })
    const created = await writer.create<Doc & { body: string }>({
      collection: 'notes',
      data: { body: 'written without a migration' },
      ...trusted,
    })
    expect(created.id).toBeTruthy()
    const reread = await writer.findByID<Doc & { body: string }>({ collection: 'notes', id: created.id, ...trusted })
    expect(reread?.body).toBe('written without a migration')
    await writer.destroy()
  })
})
