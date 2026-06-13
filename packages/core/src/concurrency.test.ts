import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { defineConfig, initKernel } from './index'
import type { Kernel } from './index'

// Three lightweight, DB-backed coordination primitives for "two editors on one doc":
//  - optimistic concurrency: an `expectedUpdatedAt` token rejects a stale write (409)
//    with a diff-friendly payload, never writing on conflict; omitting it is last-write-wins.
//  - advisory soft locks: acquire/refresh/expire with steal-prevention; advisory means a
//    writer who ignores the lock still writes (access is untouched).
//  - presence: a TTL-filtered active set of heartbeats, with kinds.
// Expiry is deterministic via an injected `now`.

function config() {
  return defineConfig({
    secret: 'concurrency-test-secret',
    db: sqliteAdapter({ url: ':memory:' }),
    collections: [
      {
        slug: 'docs',
        access: { read: () => true, create: () => true, update: () => true, delete: () => true },
        fields: [
          { name: 'title', type: 'text' },
          { name: 'body', type: 'text' },
        ],
      },
    ],
  })
}

const A = { req: { user: { id: 'a', roles: ['editor'] } } }
const B = { req: { user: { id: 'b', roles: ['editor'] } } }

// The adapter stamps `updatedAt` from the wall clock, so two writes in the same
// millisecond can collide. Re-apply A's write until `updatedAt` actually advances past
// the prior token, so a conflict test can't flake on a same-ms timestamp.
async function updateUntilAdvanced(k: Kernel, id: string, data: Record<string, unknown>, prev: string) {
  let doc = await k.update({ collection: 'docs', id, data, ...A })
  while (String(doc?.updatedAt) === prev) {
    doc = await k.update({ collection: 'docs', id, data, ...A })
  }
  return doc
}

let kernel: Kernel
beforeEach(async () => {
  kernel = await initKernel(config(), { logLevel: 'error', autoMigrate: true })
})
afterEach(async () => {
  await kernel.destroy()
})

describe('optimistic concurrency', () => {
  it('rejects a stale update with ConflictError and writes nothing', async () => {
    const created = await kernel.create({ collection: 'docs', data: { title: 'v0' }, ...A })
    const v0 = String(created.updatedAt)
    const afterA = await updateUntilAdvanced(kernel, created.id, { title: 'A' }, v0)
    expect(afterA?.title).toBe('A')
    expect(String(afterA?.updatedAt)).not.toBe(v0)

    await expect(
      kernel.update({ collection: 'docs', id: created.id, data: { title: 'B' }, expectedUpdatedAt: v0, ...B }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    const current = await kernel.findByID({ collection: 'docs', id: created.id, ...A })
    expect(current?.title).toBe('A')
  })

  it('carries a diff-friendly payload (current doc, updatedAt, attempted fields)', async () => {
    const created = await kernel.create({ collection: 'docs', data: { title: 'v0', body: 'orig' }, ...A })
    const v0 = String(created.updatedAt)
    const afterA = await updateUntilAdvanced(kernel, created.id, { title: 'A' }, v0)
    const v1 = String(afterA?.updatedAt)

    let err: any
    try {
      await kernel.update({
        collection: 'docs',
        id: created.id,
        data: { title: 'B', body: 'orig' },
        expectedUpdatedAt: v0,
        ...B,
      })
    } catch (e) {
      err = e
    }
    expect(err?.code).toBe('CONFLICT')
    expect(err.details.currentUpdatedAt).toBe(v1)
    expect(err.details.current.title).toBe('A')
    // `title` moved on the server (now "A"), `body` did not — only `title` conflicts.
    expect(err.details.attemptedFields).toContain('title')
    expect(err.details.attemptedFields).not.toContain('body')
  })

  it('is opt-in: an update without a token still succeeds (backward-compatible)', async () => {
    const created = await kernel.create({ collection: 'docs', data: { title: 'v0' }, ...A })
    await kernel.update({ collection: 'docs', id: created.id, data: { title: 'moved' }, ...A })
    const ok = await kernel.update({ collection: 'docs', id: created.id, data: { body: 'no-token' }, ...B })
    expect(ok?.body).toBe('no-token')
  })

  it('accepts the current token', async () => {
    const created = await kernel.create({ collection: 'docs', data: { title: 'v0' }, ...A })
    const moved = await kernel.update({ collection: 'docs', id: created.id, data: { title: 'm' }, ...A })
    const ok = await kernel.update({
      collection: 'docs',
      id: created.id,
      data: { title: 'fresh' },
      expectedUpdatedAt: String(moved?.updatedAt),
      ...B,
    })
    expect(ok?.title).toBe('fresh')
  })
})

describe('advisory soft locks', () => {
  const t0 = 1_700_000_000_000
  const ttl = 120_000
  let id: string
  beforeEach(async () => {
    id = (await kernel.create({ collection: 'docs', data: { title: 'doc' }, ...A })).id
  })

  it('grants a free lock and refuses to steal an unexpired one', async () => {
    const p = await kernel.acquireLock({ collection: 'docs', id, ttlMs: ttl, now: t0, ...A })
    expect(p.heldBy).toBe('you')
    const q = await kernel.acquireLock({ collection: 'docs', id, ttlMs: ttl, now: t0 + 1000, ...B })
    expect(q.heldBy).toBe('other')
    expect(q.lock.principalId).toBe('a')
  })

  it('lets the holder refresh, extending expiresAt', async () => {
    await kernel.acquireLock({ collection: 'docs', id, ttlMs: ttl, now: t0, ...A })
    const refreshed = await kernel.acquireLock({ collection: 'docs', id, ttlMs: ttl, now: t0 + 5000, ...A })
    expect(new Date(refreshed.lock.expiresAt).getTime()).toBe(t0 + 5000 + ttl)
  })

  it('frees an expired lock for another principal', async () => {
    await kernel.acquireLock({ collection: 'docs', id, ttlMs: ttl, now: t0, ...A })
    const blocked = await kernel.acquireLock({ collection: 'docs', id, ttlMs: ttl, now: t0 + ttl - 1, ...B })
    expect(blocked.heldBy).toBe('other')
    const free = await kernel.acquireLock({ collection: 'docs', id, ttlMs: ttl, now: t0 + ttl + 1, ...B })
    expect(free.heldBy).toBe('you')
  })

  it('only shows unexpired locks via getLock/listLocks', async () => {
    await kernel.acquireLock({ collection: 'docs', id, ttlMs: ttl, now: t0, ...A })
    expect(await kernel.getLock({ collection: 'docs', id, now: t0 + 1000 })).not.toBeNull()
    expect(await kernel.getLock({ collection: 'docs', id, now: t0 + ttl + 1 })).toBeNull()
    expect(await kernel.listLocks({ now: t0 + 1000 })).toHaveLength(1)
    expect(await kernel.listLocks({ now: t0 + ttl + 1 })).toHaveLength(0)
  })

  it('refuses release by a non-holder but allows the holder', async () => {
    await kernel.acquireLock({ collection: 'docs', id, ttlMs: ttl, now: t0, ...A })
    await expect(kernel.releaseLock({ collection: 'docs', id, now: t0 + 1000, ...B })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    const rel = await kernel.releaseLock({ collection: 'docs', id, now: t0 + 1000, ...A })
    expect(rel.released).toBe(true)
  })

  it('is advisory: a writer ignoring the lock still writes', async () => {
    await kernel.acquireLock({ collection: 'docs', id, ttlMs: ttl, now: t0, ...A })
    const written = await kernel.update({ collection: 'docs', id, data: { title: 'B ignored the lock' }, ...B })
    expect(written?.title).toBe('B ignored the lock')
  })
})

describe('presence', () => {
  const t0 = 1_700_000_000_000
  const ttl = 30_000
  let id: string
  beforeEach(async () => {
    id = (await kernel.create({ collection: 'docs', data: { title: 'doc' }, ...A })).id
  })

  it('lists active participants with their kinds', async () => {
    await kernel.heartbeat({ collection: 'docs', id, kind: 'editing', now: t0, ...A })
    await kernel.heartbeat({ collection: 'docs', id, kind: 'viewing', now: t0 + 1000, ...B })
    const active = await kernel.getPresence({ collection: 'docs', id, ttlMs: ttl, now: t0 + 2000 })
    expect(active).toHaveLength(2)
    expect(active.find((e) => e.principalId === 'a')?.kind).toBe('editing')
    expect(active.find((e) => e.principalId === 'b')?.kind).toBe('viewing')
  })

  it('drops participants whose last heartbeat fell outside the TTL', async () => {
    await kernel.heartbeat({ collection: 'docs', id, kind: 'editing', now: t0, ...A })
    await kernel.heartbeat({ collection: 'docs', id, kind: 'viewing', now: t0, ...B })
    // P re-heartbeats inside the window; Q goes stale.
    await kernel.heartbeat({ collection: 'docs', id, kind: 'editing', now: t0 + 40_000, ...A })
    const active = await kernel.getPresence({ collection: 'docs', id, ttlMs: ttl, now: t0 + 45_000 })
    expect(active).toHaveLength(1)
    expect(active[0]?.principalId).toBe('a')
  })

  it('upserts: repeated heartbeats keep a single row per principal', async () => {
    await kernel.heartbeat({ collection: 'docs', id, kind: 'viewing', now: t0, ...A })
    await kernel.heartbeat({ collection: 'docs', id, kind: 'editing', now: t0 + 1000, ...A })
    const active = await kernel.getPresence({ collection: 'docs', id, ttlMs: ttl, now: t0 + 2000 })
    expect(active).toHaveLength(1)
    expect(active[0]?.kind).toBe('editing')
  })
})
