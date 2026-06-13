import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseAdapter, KernelSchema, Logger } from '@kernel/db'
import { sqliteAdapter } from './index'

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} }

const schema: KernelSchema = {
  tables: [
    {
      table: 'items',
      slug: 'items',
      columns: [{ name: 'name', type: 'text', required: false, unique: false, indexed: false, localized: false }],
      timestamps: true,
      singleton: false,
    },
  ],
}

let db: DatabaseAdapter

beforeEach(async () => {
  db = sqliteAdapter({ url: ':memory:' })
  await db.init({ logger: silent })
  await db.migrate(schema)
})

afterEach(async () => {
  await db.destroy()
})

describe('transactions', () => {
  it('commits every write when the callback resolves', async () => {
    await db.transaction(async (tx) => {
      await tx.create({ collection: 'items', data: { id: 'a', name: 'committed' } })
    })
    expect(await db.findByID({ collection: 'items', id: 'a' })).toMatchObject({ name: 'committed' })
  })

  it('rolls back every write when the callback throws', async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.create({ collection: 'items', data: { id: 'b', name: 'doomed' } })
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(await db.findByID({ collection: 'items', id: 'b' })).toBeNull()
  })

  it('serializes overlapping transactions instead of nesting BEGINs', async () => {
    // Started without awaiting the first: a single shared connection would throw
    // "cannot start a transaction within a transaction" if these interleaved.
    const t1 = db.transaction(async (tx) => {
      await tx.create({ collection: 'items', data: { id: 'c1', name: 'one' } })
    })
    const t2 = db.transaction(async (tx) => {
      await tx.create({ collection: 'items', data: { id: 'c2', name: 'two' } })
    })
    await Promise.all([t1, t2])

    const all = await db.find({ collection: 'items', limit: 10, page: 1 })
    expect(all.docs.map((r) => r.name).sort()).toEqual(['one', 'two'])
  })

  it('keeps the queue healthy after a failed transaction', async () => {
    await expect(db.transaction(async () => Promise.reject(new Error('x')))).rejects.toThrow('x')
    // A subsequent transaction must still run (the tail recovered from rejection).
    await db.transaction(async (tx) => {
      await tx.create({ collection: 'items', data: { id: 'd', name: 'after' } })
    })
    expect(await db.findByID({ collection: 'items', id: 'd' })).toMatchObject({ name: 'after' })
  })
})

describe('migrate dry run + rollback', () => {
  const fresh: KernelSchema = {
    tables: [
      {
        table: 'widgets',
        slug: 'widgets',
        columns: [{ name: 'label', type: 'text', required: false, unique: false, indexed: true, localized: false }],
        timestamps: true,
        singleton: false,
      },
    ],
  }

  it('computes statements but executes nothing on a dry run', async () => {
    const report = await db.migrate(fresh, { dryRun: true })
    expect(report.createdTables).toContain('widgets')
    expect(report.statements.some((s) => /CREATE TABLE/.test(s))).toBe(true)
    // Nothing was created — the physical table does not exist, so querying it throws
    // ("no such table: widgets") even though the dry run registered it in the registry.
    await expect(db.find({ collection: 'widgets', limit: 1, page: 1 })).rejects.toThrow()
  })

  it('actually creates the table on a real migrate after the dry run', async () => {
    await db.migrate(fresh)
    const res = await db.find({ collection: 'widgets', limit: 1, page: 1 })
    expect(res.totalDocs).toBe(0)
  })

  it('rollback drops the column and table the entry recorded, never a system table', async () => {
    await db.migrate(fresh)
    await db.create({ collection: 'widgets', data: { id: 'w1', label: 'hi' } })
    // Add a column via a second migrate so we can prove DROP COLUMN works.
    const withCol: KernelSchema = {
      tables: [
        {
          table: 'widgets',
          slug: 'widgets',
          columns: [
            { name: 'label', type: 'text', required: false, unique: false, indexed: true, localized: false },
            { name: 'extra', type: 'text', required: false, unique: false, indexed: false, localized: false },
          ],
          timestamps: true,
          singleton: false,
        },
      ],
    }
    await db.migrate(withCol)

    // Dry-run rollback shows DROP SQL without executing.
    const preview = await db.rollback!(
      [{ id: 'm', at: '', createdTables: [], addedColumns: ['widgets.extra'], statements: [] }],
      {
        dryRun: true,
      },
    )
    expect(preview.statements.some((s) => /DROP COLUMN "extra"/.test(s))).toBe(true)
    // Column still present after a dry run.
    const stillThere = await db.find({ collection: 'widgets', where: { extra: { exists: false } }, limit: 1, page: 1 })
    expect(stillThere.totalDocs).toBe(1)

    // A real rollback that names a system table is refused by core's generator.
    const sys = await db.rollback!([
      { id: 'm', at: '', createdTables: ['_migrations'], addedColumns: [], statements: [] },
    ])
    expect(sys.statements).toEqual([])
  })
})

describe('LIKE escaping', () => {
  it('matches wildcard characters literally', async () => {
    await db.create({ collection: 'items', data: { id: '1', name: '50% off' } })
    await db.create({ collection: 'items', data: { id: '2', name: 'plain' } })

    const hit = await db.find({ collection: 'items', where: { name: { contains: '50%' } }, limit: 10, page: 1 })
    expect(hit.docs).toHaveLength(1)
    expect(hit.docs[0]?.name).toBe('50% off')

    const everything = await db.find({ collection: 'items', where: { name: { contains: '%' } }, limit: 10, page: 1 })
    expect(everything.docs).toHaveLength(1)
  })
})
