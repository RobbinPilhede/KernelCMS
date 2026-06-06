import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseAdapter, KernelSchema, Logger } from '@kernel/db'
import { postgresAdapter } from './index'

// Integration tests against a real Postgres. Skipped unless DATABASE_URL is set,
// so the default unit run (SQLite in-memory) needs no database. In CI, point
// DATABASE_URL at a throwaway Postgres to exercise these.
const url = process.env.DATABASE_URL
const describePg = url ? describe : describe.skip

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} }

const schema: KernelSchema = {
  tables: [
    {
      table: 'pg_items',
      slug: 'pg_items',
      columns: [
        { name: 'name', type: 'text', required: false, unique: false, indexed: true, localized: false },
        { name: 'count', type: 'integer', required: false, unique: false, indexed: false, localized: false },
        { name: 'active', type: 'boolean', required: false, unique: false, indexed: false, localized: false },
        { name: 'meta', type: 'json', required: false, unique: false, indexed: false, localized: false },
      ],
      timestamps: true,
      singleton: false,
    },
  ],
}

describePg('postgres adapter', () => {
  let db: DatabaseAdapter

  beforeAll(async () => {
    db = postgresAdapter({ url })
    await db.init({ logger: silent })
    await db.migrate(schema)
  })

  afterAll(async () => {
    if (db) await db.destroy()
  })

  beforeEach(async () => {
    // Fresh state per test.
    const all = await db.find({ collection: 'pg_items', limit: 1000, page: 1 })
    for (const row of all.docs) await db.delete({ collection: 'pg_items', id: String(row.id) })
  })

  it('round-trips typed values including json and booleans', async () => {
    await db.create({
      collection: 'pg_items',
      data: { id: '1', name: 'alpha', count: 3, active: true, meta: { tags: ['a', 'b'] } },
    })
    const got = await db.findByID({ collection: 'pg_items', id: '1' })
    expect(got).toMatchObject({ name: 'alpha', count: 3, active: true, meta: { tags: ['a', 'b'] } })
  })

  it('commits and rolls back transactions independently', async () => {
    await db.transaction(async (tx) => {
      await tx.create({ collection: 'pg_items', data: { id: 'commit', name: 'kept' } })
    })
    await expect(
      db.transaction(async (tx) => {
        await tx.create({ collection: 'pg_items', data: { id: 'rollback', name: 'gone' } })
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    expect(await db.findByID({ collection: 'pg_items', id: 'commit' })).toMatchObject({ name: 'kept' })
    expect(await db.findByID({ collection: 'pg_items', id: 'rollback' })).toBeNull()
  })

  it('runs overlapping transactions concurrently on separate clients', async () => {
    await Promise.all([
      db.transaction(async (tx) => {
        await tx.create({ collection: 'pg_items', data: { id: 'p1', name: 'one' } })
      }),
      db.transaction(async (tx) => {
        await tx.create({ collection: 'pg_items', data: { id: 'p2', name: 'two' } })
      }),
    ])
    const all = await db.find({ collection: 'pg_items', limit: 10, page: 1 })
    expect(all.docs.map((r) => r.name).sort()).toEqual(['one', 'two'])
  })

  it('escapes LIKE wildcards in `contains`', async () => {
    await db.create({ collection: 'pg_items', data: { id: 'a', name: '50% off' } })
    await db.create({ collection: 'pg_items', data: { id: 'b', name: 'plain' } })
    const hit = await db.find({ collection: 'pg_items', where: { name: { contains: '50%' } }, limit: 10, page: 1 })
    expect(hit.docs).toHaveLength(1)
    expect(hit.docs[0]?.name).toBe('50% off')
  })
})
