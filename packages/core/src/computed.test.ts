import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { describeConfig, initKernel } from './index'
import type { Doc, Kernel } from './index'

const trusted = { overrideAccess: true } as const

let kernel: Kernel

beforeEach(async () => {
  kernel = await initKernel(
    {
      secret: 'computed-test',
      db: sqliteAdapter({ url: ':memory:' }),
      collections: [
        {
          slug: 'people',
          access: { read: () => true, create: () => true, update: () => true },
          fields: [
            { name: 'first', type: 'text' },
            { name: 'last', type: 'text' },
            {
              name: 'full_name',
              type: 'text',
              virtual: true,
              compute: ({ doc }) => `${doc.first ?? ''} ${doc.last ?? ''}`.trim(),
            },
            { name: 'badge', type: 'text', virtual: true, compute: async () => 'computed-async' },
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

describe('computed (virtual) fields', () => {
  it('derives the value on create and find', async () => {
    const created = await kernel.create<Doc & { full_name: string; badge: string }>({
      collection: 'people',
      data: { first: 'Ada', last: 'Lovelace' },
      ...trusted,
    })
    expect(created.full_name).toBe('Ada Lovelace')
    expect(created.badge).toBe('computed-async')

    const list = await kernel.find<Doc & { full_name: string }>({ collection: 'people', ...trusted })
    expect(list.docs[0]!.full_name).toBe('Ada Lovelace')

    const byId = await kernel.findByID<Doc & { full_name: string }>({
      collection: 'people',
      id: created.id,
      ...trusted,
    })
    expect(byId?.full_name).toBe('Ada Lovelace')
  })

  it('is not stored: a client-supplied value is ignored and the field recomputes', async () => {
    const created = await kernel.create<Doc & { full_name: string }>({
      collection: 'people',
      data: { first: 'Grace', last: 'Hopper', full_name: 'HACKED' } as never,
      ...trusted,
    })
    expect(created.full_name).toBe('Grace Hopper') // not 'HACKED'

    const updated = await kernel.update<Doc & { full_name: string }>({
      collection: 'people',
      id: created.id,
      data: { last: 'Murray Hopper' },
      ...trusted,
    })
    expect(updated?.full_name).toBe('Grace Murray Hopper') // recomputed from new data
  })

  it('is surfaced as a read-only virtual field in the admin descriptor', async () => {
    const schema = describeConfig(kernel.config)
    const people = schema.collections.find((c) => c.slug === 'people')!
    const full_name = people.fields.find((f) => f.name === 'full_name')!
    expect(full_name.virtual).toBe(true)
    expect(full_name.admin?.readOnly).toBe(true)
  })
})
