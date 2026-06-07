import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { initKernel } from './index'
import type { Doc, Kernel } from './index'

const trusted = { overrideAccess: true } as const

type Order = Doc & { name: string; priority: number; rank: number }

let kernel: Kernel

beforeEach(async () => {
  kernel = await initKernel(
    {
      secret: 'hooks-update-test',
      db: sqliteAdapter({ url: ':memory:' }),
      collections: [
        {
          slug: 'orders',
          access: { read: () => true, create: () => true, update: () => true },
          fields: [
            { name: 'name', type: 'text' },
            { name: 'priority', type: 'number' },
            // `rank` is derived by the hook from `priority`; the client never sets it.
            { name: 'rank', type: 'number' },
          ],
          hooks: {
            // Regression guard for the bug where a beforeChange-added field was
            // written on create but silently dropped on update.
            beforeChange: [({ data }) => ({ ...data, rank: Number(data.priority) * 10 })],
          },
        },
      ],
    },
    { logLevel: 'error' },
  )
  await kernel.migrate()
})

afterEach(async () => {
  await kernel.destroy()
})

describe('beforeChange hook fields persist on update', () => {
  it('writes a hook-derived field on create', async () => {
    const created = await kernel.create<Order>({
      collection: 'orders',
      data: { name: 'a', priority: 71 } as never,
      ...trusted,
    })
    expect(created.rank).toBe(710)

    // And it is actually persisted, not just returned in the create response.
    const reread = await kernel.findByID<Order>({ collection: 'orders', id: created.id, ...trusted })
    expect(reread?.rank).toBe(710)
  })

  it('re-derives and persists the hook field on update', async () => {
    const created = await kernel.create<Order>({
      collection: 'orders',
      data: { name: 'a', priority: 71 } as never,
      ...trusted,
    })
    expect(created.rank).toBe(710)

    const updated = await kernel.update<Order>({
      collection: 'orders',
      id: created.id,
      data: { priority: 70 } as never,
      ...trusted,
    })
    // The hook returned rank: 700 — it must reach the database, not be discarded.
    expect(updated?.rank).toBe(700)

    const reread = await kernel.findByID<Order>({ collection: 'orders', id: created.id, ...trusted })
    expect(reread?.rank).toBe(700)
  })

  it('persists a hook field even when its own column is absent from the update input', async () => {
    const created = await kernel.create<Order>({
      collection: 'orders',
      data: { name: 'a', priority: 5 } as never,
      ...trusted,
    })
    expect(created.rank).toBe(50)

    // The caller only touches `name`; the hook still recomputes `rank` from the
    // (unchanged) priority and that value must survive the write.
    const updated = await kernel.update<Order>({
      collection: 'orders',
      id: created.id,
      data: { name: 'renamed' } as never,
      ...trusted,
    })
    expect(updated?.name).toBe('renamed')
    expect(updated?.rank).toBe(50)

    const reread = await kernel.findByID<Order>({ collection: 'orders', id: created.id, ...trusted })
    expect(reread?.rank).toBe(50)
  })
})
