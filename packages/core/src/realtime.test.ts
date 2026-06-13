import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import type { Kernel } from './index'
import { initKernel } from './index'
import { createChangeBus, clampRetain, clampChangesLimit, MAX_CHANGE_LISTENERS } from './realtime'

const sys = { overrideAccess: true } as const
const owner = (id: string) => ({ req: { user: { id, roles: ['user'] } } })

function makeKernel(retain?: number): Promise<Kernel> {
  return initKernel(
    {
      secret: 'realtime-test-secret-aaaaaaaaaaaa',
      db: sqliteAdapter({ url: ':memory:' }),
      realtime: { enabled: true, ...(retain !== undefined ? { retain } : {}) },
      collections: [
        {
          slug: 'posts',
          access: { read: () => true, create: () => true, update: () => true, delete: () => true },
          fields: [{ name: 'title', type: 'text' }],
        },
        {
          slug: 'secrets',
          // Owner-scoped: a user reads only rows whose `owner` equals their id.
          access: {
            read: ({ req }) => (req.user ? { owner: { equals: req.user.id } } : false),
            create: () => true,
            update: () => true,
            delete: () => true,
          },
          fields: [
            { name: 'title', type: 'text' },
            { name: 'owner', type: 'text' },
          ],
        },
      ],
    },
    { logLevel: 'error' },
  )
}

describe('realtime change feed', () => {
  let kernel: Kernel

  beforeEach(async () => {
    kernel = await makeKernel()
    await kernel.migrate()
  })

  afterEach(async () => {
    await kernel.destroy()
  })

  it('records ordered create/update/delete events with a monotonic cursor', async () => {
    const post = await kernel.create({ collection: 'posts', data: { title: 'a' }, ...sys })
    await kernel.update({ collection: 'posts', id: post.id, data: { title: 'b' }, ...sys })
    await kernel.delete({ collection: 'posts', id: post.id, ...sys })

    const { changes, cursor } = await kernel.changes({ since: 0, ...sys })
    expect(changes.map((c) => c.event)).toEqual(['create', 'update', 'delete'])
    expect(changes.every((c) => c.collection === 'posts' && c.documentId === post.id)).toBe(true)
    // Strictly increasing seqs, cursor = highest.
    expect(changes[0]!.seq).toBeLessThan(changes[1]!.seq)
    expect(changes[1]!.seq).toBeLessThan(changes[2]!.seq)
    expect(cursor).toBe(changes[2]!.seq)
  })

  it('since=cursor returns only newer events', async () => {
    const p1 = await kernel.create({ collection: 'posts', data: { title: '1' }, ...sys })
    const first = await kernel.changes({ since: 0, ...sys })
    const p2 = await kernel.create({ collection: 'posts', data: { title: '2' }, ...sys })

    const next = await kernel.changes({ since: first.cursor, ...sys })
    expect(next.changes).toHaveLength(1)
    expect(next.changes[0]!.documentId).toBe(p2.id)
    expect(next.changes[0]!.documentId).not.toBe(p1.id)
  })

  it('filters by collection', async () => {
    await kernel.create({ collection: 'posts', data: { title: 'p' }, ...sys })
    await kernel.create({ collection: 'secrets', data: { title: 's', owner: 'u1' }, ...sys })

    const onlyPosts = await kernel.changes({ since: 0, collection: 'posts', ...sys })
    expect(onlyPosts.changes.every((c) => c.collection === 'posts')).toBe(true)
    expect(onlyPosts.changes.some((c) => c.collection === 'secrets')).toBe(false)
  })

  it('events are metadata-only (no document body / field values)', async () => {
    await kernel.create({ collection: 'posts', data: { title: 'secret-title-value' }, ...sys })
    const { changes } = await kernel.changes({ since: 0, ...sys })
    const event = changes[0]!
    expect(Object.keys(event).sort()).toEqual(['at', 'collection', 'documentId', 'event', 'principalType', 'seq'])
    expect(JSON.stringify(event)).not.toContain('secret-title-value')
    expect((event as unknown as Record<string, unknown>).title).toBeUndefined()
  })

  it('access-filters events: a non-owner never learns a forbidden doc changed', async () => {
    // Two owner-scoped secrets, plus a public post.
    const s1 = await kernel.create({ collection: 'secrets', data: { title: 's1', owner: 'alice' }, ...sys })
    await kernel.create({ collection: 'secrets', data: { title: 's2', owner: 'bob' }, ...sys })
    await kernel.create({ collection: 'posts', data: { title: 'public' }, ...sys })

    // Alice sees only HER secret event (+ the public post), never bob's.
    const alice = await kernel.changes({ since: 0, ...owner('alice') })
    const secretEvents = alice.changes.filter((c) => c.collection === 'secrets')
    expect(secretEvents).toHaveLength(1)
    expect(secretEvents[0]!.documentId).toBe(s1.id)
    expect(alice.changes.some((c) => c.collection === 'posts')).toBe(true)

    // Bob does NOT see Alice's secret change at all (dropped, not just bodyless).
    const bob = await kernel.changes({ since: 0, ...owner('bob') })
    expect(bob.changes.some((c) => c.documentId === s1.id)).toBe(false)
  })

  it('access-filters delete events by collection read access (fail closed for scoped readers)', async () => {
    const s = await kernel.create({ collection: 'secrets', data: { title: 's', owner: 'alice' }, ...sys })
    await kernel.delete({ collection: 'secrets', id: s.id, ...sys })
    // The doc is gone; a scoped (row-level) read rule can't be matched → delete is dropped.
    const alice = await kernel.changes({ since: 0, ...owner('alice') })
    expect(alice.changes.some((c) => c.event === 'delete' && c.collection === 'secrets')).toBe(false)
    // A trusted (override) caller still sees the delete.
    const all = await kernel.changes({ since: 0, ...sys })
    expect(all.changes.some((c) => c.event === 'delete' && c.documentId === s.id)).toBe(true)
  })

  it('subscribe delivers live events; unsubscribe stops delivery', async () => {
    const received: string[] = []
    const unsubscribe = kernel.subscribe((e) => received.push(`${e.event}:${e.documentId}`))

    const p = await kernel.create({ collection: 'posts', data: { title: 'live' }, ...sys })
    expect(received).toContain(`create:${p.id}`)

    unsubscribe()
    const before = received.length
    await kernel.update({ collection: 'posts', id: p.id, data: { title: 'after' }, ...sys })
    expect(received).toHaveLength(before)
  })

  it('trims the outbox to retain (oldest dropped) and cursors still work', async () => {
    await kernel.destroy()
    kernel = await makeKernel(3)
    await kernel.migrate()

    const ids: string[] = []
    for (let i = 0; i < 6; i++) {
      const d = await kernel.create({ collection: 'posts', data: { title: `t${i}` }, ...sys })
      ids.push(d.id)
    }
    const { changes, cursor } = await kernel.changes({ since: 0, ...sys })
    // Only the last 3 rows survive (oldest dropped); seqs still monotonic.
    expect(changes).toHaveLength(3)
    expect(changes[0]!.seq).toBeLessThan(changes[2]!.seq)
    expect(cursor).toBe(changes[2]!.seq)
    // The newest creates survive; the very first does not.
    const survivingDocs = changes.map((c) => c.documentId)
    expect(survivingDocs).toContain(ids[5])
    expect(survivingDocs).not.toContain(ids[0])
  })
})

describe('change bus bounds + clamps', () => {
  it('rejects past the listener bound', () => {
    const bus = createChangeBus()
    const unsubs: Array<() => void> = []
    for (let i = 0; i < MAX_CHANGE_LISTENERS; i++) unsubs.push(bus.subscribe(() => {}))
    expect(bus.size()).toBe(MAX_CHANGE_LISTENERS)
    expect(() => bus.subscribe(() => {})).toThrow(/too many/i)
    unsubs[0]!()
    // After freeing one, a new subscription is accepted again.
    expect(() => bus.subscribe(() => {})).not.toThrow()
  })

  it('isolates a throwing listener', () => {
    const bus = createChangeBus()
    const seen: number[] = []
    bus.subscribe(() => {
      throw new Error('bad listener')
    })
    bus.subscribe((e) => seen.push(e.seq))
    bus.emit({ seq: 1, at: 'now', collection: 'posts', documentId: 'x', event: 'create', principalType: 'system' })
    expect(seen).toEqual([1])
  })

  it('clamps retention and pull limit into sane bounds', () => {
    expect(clampRetain(undefined)).toBeGreaterThan(0)
    expect(clampRetain(-5)).toBe(1)
    expect(clampRetain(5)).toBe(5)
    expect(clampChangesLimit(0)).toBe(1)
    expect(clampChangesLimit(99999)).toBe(1000)
    expect(clampChangesLimit(50)).toBe(50)
  })
})
