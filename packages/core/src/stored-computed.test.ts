import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { describeConfig, initKernel } from './index'
import type { Doc, Kernel } from './index'

const trusted = { overrideAccess: true } as const

type Event = Doc & { title: string; starts_at: string; sort_key: number }

let kernel: Kernel

beforeEach(async () => {
  kernel = await initKernel(
    {
      secret: 'stored-computed-test',
      db: sqliteAdapter({ url: ':memory:' }),
      collections: [
        {
          slug: 'events',
          access: { read: () => true, create: () => true, update: () => true },
          fields: [
            { name: 'title', type: 'text' },
            { name: 'starts_at', type: 'text' },
            // A STORED computed field: `compute` present, `virtual` omitted. The
            // value is derived at write time and persisted, so it is sortable.
            {
              name: 'sort_key',
              type: 'number',
              index: true,
              compute: ({ doc }) => new Date(String(doc.starts_at)).getTime(),
            },
          ],
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

describe('stored computed fields', () => {
  it('derives the value at write time and persists it on create', async () => {
    const created = await kernel.create<Event>({
      collection: 'events',
      data: { title: 'a', starts_at: '2026-01-02T00:00:00.000Z' } as never,
      ...trusted,
    })
    const expected = new Date('2026-01-02T00:00:00.000Z').getTime()
    expect(created.sort_key).toBe(expected)

    // Persisted, not merely computed on the way out: a fresh read returns it.
    const reread = await kernel.findByID<Event>({ collection: 'events', id: created.id, ...trusted })
    expect(reread?.sort_key).toBe(expected)
  })

  it('recomputes and persists on update', async () => {
    const created = await kernel.create<Event>({
      collection: 'events',
      data: { title: 'a', starts_at: '2026-01-02T00:00:00.000Z' } as never,
      ...trusted,
    })
    const updated = await kernel.update<Event>({
      collection: 'events',
      id: created.id,
      data: { starts_at: '2026-03-04T00:00:00.000Z' } as never,
      ...trusted,
    })
    const expected = new Date('2026-03-04T00:00:00.000Z').getTime()
    expect(updated?.sort_key).toBe(expected)

    const reread = await kernel.findByID<Event>({ collection: 'events', id: created.id, ...trusted })
    expect(reread?.sort_key).toBe(expected)
  })

  it('ignores a client-supplied value and uses the computed one', async () => {
    const created = await kernel.create<Event>({
      collection: 'events',
      data: { title: 'a', starts_at: '2026-01-02T00:00:00.000Z', sort_key: -1 } as never,
      ...trusted,
    })
    expect(created.sort_key).toBe(new Date('2026-01-02T00:00:00.000Z').getTime())
  })

  it('is sortable because it is a real stored column', async () => {
    await kernel.create<Event>({
      collection: 'events',
      data: { title: 'march', starts_at: '2026-03-01T00:00:00.000Z' } as never,
      ...trusted,
    })
    await kernel.create<Event>({
      collection: 'events',
      data: { title: 'january', starts_at: '2026-01-01T00:00:00.000Z' } as never,
      ...trusted,
    })
    await kernel.create<Event>({
      collection: 'events',
      data: { title: 'february', starts_at: '2026-02-01T00:00:00.000Z' } as never,
      ...trusted,
    })

    const asc = await kernel.find<Event>({ collection: 'events', sort: 'sort_key', ...trusted })
    expect(asc.docs.map((d) => d.title)).toEqual(['january', 'february', 'march'])

    const desc = await kernel.find<Event>({ collection: 'events', sort: '-sort_key', ...trusted })
    expect(desc.docs.map((d) => d.title)).toEqual(['march', 'february', 'january'])
  })

  it('surfaces the stored computed field as read-only in the admin descriptor', async () => {
    const schema = describeConfig(kernel.config)
    const events = schema.collections.find((c) => c.slug === 'events')!
    const sortKey = events.fields.find((f) => f.name === 'sort_key')!
    // Not virtual (it is stored), but still server-derived → read-only.
    expect(sortKey.virtual).toBeUndefined()
    expect(sortKey.admin?.readOnly).toBe(true)
  })
})
