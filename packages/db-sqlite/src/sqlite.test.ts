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
