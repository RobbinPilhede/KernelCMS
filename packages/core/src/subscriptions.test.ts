import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { defineConfig, initKernel } from './index'
import type { Kernel } from './index'

// Saved-search alerts / content subscriptions: a principal subscribes to a standing query
// (collection + optional `where`). A cron drain reads the change feed since the
// subscription's cursor, re-loads each changed doc AS THE OWNER (the access-checked read),
// matches it against the stored `where`, and enqueues a webhook delivery per match. These
// tests pin the security property — an alert only ever fires for content the OWNER can read
// — plus owner-from-principal, where-matching, cursor advance, config gating, authz, system-
// table isolation, and encrypted-field redaction from the delivered payload.

const KEY = 'subscriptions-test-master-key-32-chars-plus!!'

// Owner-scoped read: a row is only readable by its owner (typed `({ req }: any)` so the
// access fn returns a concrete shape, not `unknown` — CI's tsc rejects an `unknown` return).
const ownerRead = ({ req }: any) => {
  if (req.user?.roles?.includes('admin')) return true
  return { owner: { equals: req.user?.id ?? '__none__' } }
}

const alice = { user: { id: 'alice', roles: ['viewer'] } }
const bob = { user: { id: 'bob', roles: ['viewer'] } }
const admin = { user: { id: 'adm', roles: ['admin'] } }

const ALERTS = { slug: 'alerts', url: 'https://hook.example/alerts', collections: [] as string[] }

function subsConfig(overrides: Record<string, unknown> = {}) {
  return defineConfig({
    secret: 'subscriptions-test-secret-32-characters!!',
    db: sqliteAdapter({ url: ':memory:' }),
    audit: true,
    realtime: { enabled: true },
    subscriptions: true,
    // `collections: []` ⇒ the webhook never fires inline on any content write, so the drain
    // is the only thing that can ever enqueue a delivery — the outbox stays clean.
    webhooks: [ALERTS],
    collections: [
      {
        slug: 'posts',
        access: { read: () => true, create: () => true, update: () => true, delete: () => true },
        fields: [
          { name: 'title', type: 'text' },
          { name: 'status', type: 'text' },
        ],
      },
      {
        slug: 'secrets',
        access: { read: ownerRead, create: () => true, update: () => true, delete: () => true },
        fields: [
          { name: 'owner', type: 'text' },
          { name: 'tag', type: 'text' },
        ],
      },
      {
        // Statically unreadable for non-admins — used to prove the collection read-gate on
        // createSubscription (you can only subscribe to a collection you can read).
        slug: 'locked',
        access: { read: ({ req }: any) => req.user?.roles?.includes('admin') === true, create: () => true },
        fields: [{ name: 'title', type: 'text' }],
      },
    ],
    ...overrides,
  })
}

/** Read the raw `_webhook_deliveries` rows (the delivery-log doc does NOT expose `payload`,
 *  so we go through the underlying adapter to inspect the enqueued payload). */
async function rawDeliveries(kernel: Kernel): Promise<any[]> {
  const res = await (kernel as any).config.db.find({ collection: '_webhook_deliveries', limit: 1000, page: 1 })
  return res.docs as any[]
}

describe('subscriptions', () => {
  let kernel: Kernel

  beforeEach(async () => {
    // Any inline delivery attempt is harmless — fetch is stubbed and the alerts webhook is
    // subscription-only anyway.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('ok', { status: 200 })),
    )
    kernel = await initKernel(subsConfig(), { logLevel: 'error', autoMigrate: true })
  })
  afterEach(async () => {
    await kernel.destroy()
    vi.unstubAllGlobals()
  })

  // --- 1. createSubscription: owner + storage + auth + read-gate -----------
  it('records the owner from the principal, stores where/webhook, active, lastSeq = max seq', async () => {
    // Seed two changes so the current max seq is non-zero; the new subscription starts AFTER.
    await kernel.create({ collection: 'posts', data: { title: 'seed1' }, overrideAccess: true })
    await kernel.create({ collection: 'posts', data: { title: 'seed2' }, overrideAccess: true })
    const feed = await kernel.changes({ since: 0, overrideAccess: true })
    const maxSeq = Math.max(...feed.changes.map((c) => c.seq))

    const sub = await kernel.createSubscription({
      collection: 'posts',
      where: { status: { equals: 'urgent' } },
      webhook: 'alerts',
      req: alice,
    })
    expect(sub.ownerId).toBe('alice')
    expect(sub.ownerType).toBe('user')
    expect(sub.webhook).toBe('alerts')
    expect(sub.where).toEqual({ status: { equals: 'urgent' } })
    expect(sub.active).toBe(true)
    expect(sub.lastSeq).toBe(maxSeq)
  })

  it('rejects an anonymous caller and a user who cannot read the collection', async () => {
    await expect(
      kernel.createSubscription({ collection: 'posts', webhook: 'alerts', req: {} as never }),
    ).rejects.toThrow()
    // Bob can't read alice's secrets rows, but the read-gate is at the COLLECTION level:
    // an anonymous-equivalent principal still resolves the owner-scoped rule to a non-empty
    // filter, so subscribing is allowed for an authenticated user. The collection-level gate
    // bites only when read access is statically false — model that with a forbidden collection.
    await expect(kernel.createSubscription({ collection: 'locked', webhook: 'alerts', req: alice })).rejects.toThrow()
  })

  // --- 2. createSubscription validation: webhook slug + where field --------
  it('rejects an unknown webhook slug and an invalid where field (BadRequest)', async () => {
    await expect(kernel.createSubscription({ collection: 'posts', webhook: 'nope', req: alice })).rejects.toThrow()
    await expect(
      kernel.createSubscription({
        collection: 'posts',
        where: { not_a_field: { equals: 'x' } } as never,
        webhook: 'alerts',
        req: alice,
      }),
    ).rejects.toThrow()
  })

  // --- 3. HEADLINE: drain matches + enqueues ONLY for matching content -----
  it('enqueues exactly one delivery for the matching (urgent) post, not the calm one', async () => {
    await kernel.createSubscription({
      collection: 'posts',
      where: { status: { equals: 'urgent' } },
      webhook: 'alerts',
      req: alice,
    })
    const urgent = await kernel.create({
      collection: 'posts',
      data: { title: 'fire', status: 'urgent' },
      overrideAccess: true,
    })
    await kernel.create({ collection: 'posts', data: { title: 'chill', status: 'calm' }, overrideAccess: true })

    const result = await kernel.processSubscriptions()
    expect(result.scanned).toBe(1)
    expect(result.delivered).toBe(1)

    const log = await kernel.webhookDeliveries({ webhook: 'alerts' })
    expect(log.count).toBe(1)

    const rows = await rawDeliveries(kernel)
    expect(rows).toHaveLength(1)
    expect(rows[0].documentId).toBe(urgent.id)
    expect(rows[0].payload.doc.title).toBe('fire')
    expect(rows[0].status).toBe('pending')
  })

  // --- 4. ACCESS SCOPING: only the owner's READABLE content alerts ---------
  it('alerts only for content the owner can read (bob secret silent, alice secret delivers)', async () => {
    await kernel.createSubscription({
      collection: 'secrets',
      where: { tag: { equals: 'x' } },
      webhook: 'alerts',
      req: alice,
    })

    // Bob creates a secret alice cannot read. It matches the where, but the owner-scoped
    // reload returns null for alice → no alert.
    await kernel.create({ collection: 'secrets', data: { owner: 'bob', tag: 'x' }, req: bob })
    const r1 = await kernel.processSubscriptions()
    expect(r1.delivered).toBe(0)
    expect((await kernel.webhookDeliveries({ webhook: 'alerts' })).count).toBe(0)

    // Alice creates a matching secret she CAN read → exactly one alert.
    const mine = await kernel.create({ collection: 'secrets', data: { owner: 'alice', tag: 'x' }, req: alice })
    const r2 = await kernel.processSubscriptions()
    expect(r2.delivered).toBe(1)

    const rows = await rawDeliveries(kernel)
    expect(rows).toHaveLength(1)
    expect(rows[0].documentId).toBe(mine.id)
  })

  // --- 5. Cursor advances: a second drain re-delivers nothing --------------
  it('advances the cursor so a second drain with no new changes enqueues 0', async () => {
    await kernel.createSubscription({
      collection: 'posts',
      where: { status: { equals: 'urgent' } },
      webhook: 'alerts',
      req: alice,
    })
    await kernel.create({ collection: 'posts', data: { title: 'fire', status: 'urgent' }, overrideAccess: true })

    const first = await kernel.processSubscriptions()
    expect(first.delivered).toBe(1)
    const second = await kernel.processSubscriptions()
    expect(second.delivered).toBe(0)
    expect((await kernel.webhookDeliveries({ webhook: 'alerts' })).count).toBe(1)
  })

  // --- 6. list / delete authz + system-table isolation ---------------------
  it('lists the owner own subscriptions only; bob does not see alice', async () => {
    await kernel.createSubscription({ collection: 'posts', webhook: 'alerts', req: alice })
    const mine = await kernel.listSubscriptions({ req: alice })
    expect(mine).toHaveLength(1)
    expect(mine[0].ownerId).toBe('alice')
    expect(await kernel.listSubscriptions({ req: bob })).toHaveLength(0)
  })

  it('only the owner or an admin can delete; a non-owner is forbidden', async () => {
    const sub = await kernel.createSubscription({ collection: 'posts', webhook: 'alerts', req: alice })
    await expect(kernel.deleteSubscription({ subscriptionId: sub.id, req: bob })).rejects.toThrow()
    const delByOwner = await kernel.deleteSubscription({ subscriptionId: sub.id, req: alice })
    expect(delByOwner.id).toBe(sub.id)

    const sub2 = await kernel.createSubscription({ collection: 'posts', webhook: 'alerts', req: alice })
    const delByAdmin = await kernel.deleteSubscription({ subscriptionId: sub2.id, req: admin })
    expect(delByAdmin.id).toBe(sub2.id)
  })

  it('rejects a prototype-pollution subscriptionId', async () => {
    await expect(kernel.deleteSubscription({ subscriptionId: '__proto__', req: alice })).rejects.toThrow()
  })

  it('_subscriptions is not reachable via generic CRUD', async () => {
    await expect(kernel.find({ collection: '_subscriptions', ...alice })).rejects.toThrow()
    await expect(
      kernel.create({ collection: '_subscriptions', data: { collection: 'posts' }, overrideAccess: true }),
    ).rejects.toThrow()
  })
})

// --- 2 (config). initKernel asserts realtime + webhooks ------------------
describe('subscriptions config gating', () => {
  it('throws if subscriptions:true without realtime.enabled', async () => {
    await expect(
      initKernel(subsConfig({ realtime: undefined }), { logLevel: 'error', autoMigrate: true }),
    ).rejects.toThrow()
  })

  it('throws if subscriptions:true without any webhooks', async () => {
    await expect(initKernel(subsConfig({ webhooks: [] }), { logLevel: 'error', autoMigrate: true })).rejects.toThrow()
  })
})

// --- 7. Encrypted-field redaction from the delivered payload -------------
describe('subscriptions redact encrypted fields from the payload', () => {
  let kernel: Kernel

  function encConfig() {
    return defineConfig({
      secret: 'subscriptions-test-secret-32-characters!!',
      db: sqliteAdapter({ url: ':memory:' }),
      realtime: { enabled: true },
      subscriptions: true,
      encryption: { key: KEY },
      webhooks: [ALERTS],
      collections: [
        {
          slug: 'notes',
          access: { read: () => true, create: () => true, update: () => true },
          fields: [
            { name: 'title', type: 'text' },
            { name: 'status', type: 'text' },
            { name: 'ssn', type: 'text', encrypted: true },
          ],
        },
      ],
    })
  }

  beforeEach(async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('ok', { status: 200 })),
    )
    kernel = await initKernel(encConfig(), { logLevel: 'error', autoMigrate: true })
  })
  afterEach(async () => {
    await kernel.destroy()
    vi.unstubAllGlobals()
  })

  it('strips the encrypted field (plaintext AND its enc:1: ciphertext) from payload.doc', async () => {
    await kernel.createSubscription({
      collection: 'notes',
      where: { status: { equals: 'urgent' } },
      webhook: 'alerts',
      req: alice,
    })
    await kernel.create({
      collection: 'notes',
      data: { title: 'leak?', status: 'urgent', ssn: '123-45-6789' },
      overrideAccess: true,
    })

    const result = await kernel.processSubscriptions()
    expect(result.delivered).toBe(1)

    const rows = await rawDeliveries(kernel)
    expect(rows).toHaveLength(1)
    const doc = rows[0].payload.doc
    expect(doc.title).toBe('leak?')
    expect('ssn' in doc).toBe(false)
    // No ciphertext leaked either.
    expect(JSON.stringify(rows[0].payload)).not.toContain('enc:1:')
    expect(JSON.stringify(rows[0].payload)).not.toContain('123-45-6789')
  })
})

// --- 8. Disabled: ops are inert ------------------------------------------
describe('subscriptions disabled', () => {
  let kernel: Kernel

  beforeEach(async () => {
    // Omit `subscriptions` entirely (still provide realtime + a webhook so the rest is valid).
    const cfg = subsConfig({ subscriptions: false })
    kernel = await initKernel(cfg, { logLevel: 'error', autoMigrate: true })
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('processSubscriptions returns {scanned:0,delivered:0} and listSubscriptions returns []', async () => {
    expect(await kernel.processSubscriptions()).toEqual({ scanned: 0, delivered: 0 })
    expect(await kernel.listSubscriptions({ req: alice })).toEqual([])
  })
})
