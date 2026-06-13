import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { defineConfig, initKernel, MIGRATIONS_TABLE } from './index'
import type { Doc, Kernel } from './index'

function buildKernel(): ReturnType<typeof defineConfig> {
  return defineConfig({
    secret: 'backfill-test-secret',
    db: sqliteAdapter({ url: ':memory:' }),
    collections: [
      {
        slug: 'posts',
        access: { read: () => true, create: () => true, update: () => true, delete: () => true },
        fields: [
          { name: 'title', type: 'text' },
          { name: 'views', type: 'number' },
          { name: 'tier', type: 'text' },
        ],
      },
    ],
  })
}

describe('backfill', () => {
  let kernel: Kernel

  beforeEach(async () => {
    kernel = await initKernel(buildKernel(), { logLevel: 'error' })
    await kernel.migrate()
    for (let i = 0; i < 3; i++) {
      await kernel.create({ collection: 'posts', data: { title: `p${i}`, views: i } })
    }
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('sets a constant value across every existing row', async () => {
    const result = await kernel.backfill({ collection: 'posts', field: 'tier', value: 'free' })
    expect(result).toEqual({ matched: 3, updated: 3 })
    const all = await kernel.find({ collection: 'posts', limit: 10, page: 1 })
    expect(all.docs.every((d) => d.tier === 'free')).toBe(true)
  })

  it('dry run reports matched without writing', async () => {
    const result = await kernel.backfill({ collection: 'posts', field: 'tier', value: 'free', dryRun: true })
    expect(result).toEqual({ matched: 3, updated: 0 })
    const all = await kernel.find({ collection: 'posts', limit: 10, page: 1 })
    expect(all.docs.every((d) => d.tier == null)).toBe(true)
  })

  it('computes a per-document value via set(doc)', async () => {
    const result = await kernel.backfill<Doc>({
      collection: 'posts',
      field: 'tier',
      set: (doc) => (Number(doc.views) >= 1 ? 'paid' : 'free'),
    })
    expect(result.updated).toBe(3)
    const all = await kernel.find({ collection: 'posts', limit: 10, page: 1, sort: 'views' })
    expect(all.docs.map((d) => d.tier)).toEqual(['free', 'paid', 'paid'])
  })

  it('honours a where filter', async () => {
    const result = await kernel.backfill({
      collection: 'posts',
      field: 'tier',
      value: 'hot',
      where: { views: { greater_than: 0 } },
    })
    expect(result).toEqual({ matched: 2, updated: 2 })
  })

  it('rejects an unknown collection', async () => {
    await expect(kernel.backfill({ collection: 'nope', field: 'x', value: 1 })).rejects.toThrow(/Unknown collection/)
  })

  it('rejects a non-field / system column', async () => {
    await expect(kernel.backfill({ collection: 'posts', field: 'id', value: 'x' })).rejects.toThrow(
      /not a writable field/,
    )
    await expect(kernel.backfill({ collection: 'posts', field: '__proto__', value: 'x' })).rejects.toThrow(
      /not a writable field/,
    )
    await expect(kernel.backfill({ collection: 'posts', field: 'createdAt', value: 'x' })).rejects.toThrow(
      /not a writable field/,
    )
  })

  it('requires either value or set', async () => {
    await expect(kernel.backfill({ collection: 'posts', field: 'tier' })).rejects.toThrow(/either `value` or a `set/)
  })
})

describe('migration journal + rollback (kernel layer)', () => {
  let kernel: Kernel

  beforeEach(async () => {
    kernel = await initKernel(buildKernel(), { logLevel: 'error' })
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  // The `_migrations` journal is a system table — read it via the raw adapter (like the
  // engine does), not the access-checked `kernel.find` which only knows user collections.
  const journalRows = (k: Kernel) => k.db.find({ collection: MIGRATIONS_TABLE, limit: 10, page: 1 })

  it('dry-run migrate writes no journal row and creates no tables', async () => {
    const report = await kernel.migrate({ dryRun: true })
    expect(report.createdTables).toContain('posts')
    expect(report.statements.length).toBeGreaterThan(0)
    // The _migrations table itself was not created, so reading it errors.
    await expect(journalRows(kernel)).rejects.toThrow()
  })

  it('records exactly one journal row for a real, non-empty migrate', async () => {
    const report = await kernel.migrate()
    expect(report.createdTables).toContain('posts')
    const journal = await journalRows(kernel)
    expect(journal.totalDocs).toBe(1)
    const row = journal.docs[0]!
    expect(row.createdTables).toContain('posts')
    expect(Array.isArray(row.statements)).toBe(true)
  })

  it('skips an empty (no-op) migrate', async () => {
    await kernel.migrate()
    await kernel.migrate() // nothing to do the second time
    const journal = await journalRows(kernel)
    expect(journal.totalDocs).toBe(1)
  })

  it('rollback dry run shows DROP SQL without executing or consuming the journal', async () => {
    await kernel.migrate()
    const before = await journalRows(kernel)
    const plan = await kernel.rollbackMigration({ dryRun: true })
    expect(plan.statements.some((s) => /DROP TABLE/.test(s))).toBe(true)
    expect(plan.reverted.length).toBe(1)
    // Journal still intact; posts table still queryable.
    const after = await journalRows(kernel)
    expect(after.totalDocs).toBe(before.totalDocs)
    expect((await kernel.find({ collection: 'posts', limit: 1, page: 1 })).totalDocs).toBe(0)
  })
})
