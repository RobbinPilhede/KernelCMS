import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import type { Kernel } from './index'
import { initKernel } from './index'

interface Captured {
  url: string
  headers: Record<string, string>
  body: string
}

/** Stub global fetch, recording each request. `respond` controls the outcome per call. */
function stubFetch(respond: () => Response | Promise<Response> = () => new Response('ok', { status: 200 })): {
  calls: Captured[]
  restore: () => void
} {
  const calls: Captured[] = []
  const fn = vi.fn(async (url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ url, headers: init.headers, body: init.body })
    return respond()
  })
  vi.stubGlobal('fetch', fn)
  return { calls, restore: () => vi.unstubAllGlobals() }
}

/** A fresh `posts` collection per boot. `attachWebhooks` mutates collection configs in
 *  place (appends afterChange/afterDelete hooks), so a shared object would accumulate hooks
 *  across kernels and fire a webhook multiple times — build a new one every time. */
function postsCollection() {
  return {
    slug: 'posts',
    access: { read: () => true, create: () => true, update: () => true, delete: () => true },
    fields: [{ name: 'title', type: 'text' as const }],
  }
}

/** Boot a kernel with the given webhooks + a `posts` collection. Migrates immediately. */
async function boot(webhooks: unknown[]): Promise<Kernel> {
  const kernel = await initKernel(
    {
      secret: 'wh-durable-test',
      db: sqliteAdapter({ url: ':memory:' }),
      webhooks: webhooks as never,
      collections: [postsCollection()],
    },
    { logLevel: 'error' },
  )
  await kernel.migrate()
  return kernel
}

describe('durable webhooks — SSRF guard at config load', () => {
  let fetchStub: ReturnType<typeof stubFetch>
  beforeEach(() => {
    fetchStub = stubFetch()
  })
  afterEach(() => {
    fetchStub.restore()
  })

  it('rejects a loopback host (127.0.0.1)', async () => {
    await expect(boot([{ url: 'http://127.0.0.1/x' }])).rejects.toThrow(/private|loopback|SSRF/i)
  })

  it('rejects localhost', async () => {
    await expect(boot([{ url: 'http://localhost/x' }])).rejects.toThrow(/private|loopback|SSRF/i)
  })

  it('rejects the cloud-metadata address (169.254.169.254)', async () => {
    await expect(boot([{ url: 'http://169.254.169.254/x' }])).rejects.toThrow(/private|loopback|SSRF/i)
  })

  it('rejects a non-http(s) scheme (ftp://)', async () => {
    await expect(boot([{ url: 'ftp://files.example/x' }])).rejects.toThrow(/http/i)
  })

  it('accepts a private host when allowPrivateNetwork is set', async () => {
    const kernel = await boot([{ url: 'http://127.0.0.1/x', allowPrivateNetwork: true }])
    expect(kernel.listWebhooks()).toHaveLength(1)
    await kernel.destroy()
  })

  it('accepts a valid public https endpoint', async () => {
    const kernel = await boot([{ url: 'https://hook.example/x' }])
    expect(kernel.listWebhooks()[0]!.url).toBe('https://hook.example/x')
    await kernel.destroy()
  })
})

describe('durable webhooks — slug assignment', () => {
  let fetchStub: ReturnType<typeof stubFetch>
  beforeEach(() => {
    fetchStub = stubFetch()
  })
  afterEach(() => {
    fetchStub.restore()
  })

  it('keeps an explicit slug', async () => {
    const kernel = await boot([{ slug: 'my_hook', url: 'https://hook.example/a' }])
    expect(kernel.listWebhooks()[0]!.slug).toBe('my_hook')
    await kernel.destroy()
  })

  it('derives a unique slug across two same-host webhooks', async () => {
    const kernel = await boot([{ url: 'https://hook.example/a' }, { url: 'https://hook.example/a' }])
    const slugs = kernel.listWebhooks().map((w) => w.slug)
    expect(new Set(slugs).size).toBe(2)
    expect(slugs[0]).not.toBe(slugs[1])
    await kernel.destroy()
  })

  it('rejects an invalid explicit slug', async () => {
    await expect(boot([{ slug: 'Bad Slug', url: 'https://hook.example/a' }])).rejects.toThrow(/snake_case|slug/i)
  })
})

describe('durable webhooks — runtime', () => {
  let kernel: Kernel
  let fetchStub: ReturnType<typeof stubFetch>
  const SECRET = 'durable-secret'

  async function bootDurable(respond?: () => Response | Promise<Response>, extra: Record<string, unknown> = {}) {
    fetchStub = stubFetch(respond)
    kernel = await boot([
      { slug: 'durable_hook', url: 'https://hook.example/durable', secret: SECRET, durable: true, ...extra },
    ])
  }

  afterEach(async () => {
    fetchStub.restore()
    await kernel.destroy()
  })

  it('enqueues exactly one pending delivery on create and does NOT POST inline', async () => {
    await bootDurable()
    const doc = await kernel.create({ collection: 'posts', data: { title: 'hi' }, overrideAccess: true })
    expect(fetchStub.calls).toHaveLength(0)
    const { docs, count } = await kernel.webhookDeliveries()
    expect(count).toBe(1)
    expect(docs[0]!.status).toBe('pending')
    expect(docs[0]!.event).toBe('create')
    expect(docs[0]!.collection).toBe('posts')
    expect(docs[0]!.documentId).toBe(doc.id)
    expect(docs[0]!.attempts).toBe(0)
  })

  it('an inline webhook on the same write POSTs and does NOT enqueue', async () => {
    fetchStub = stubFetch()
    kernel = await boot([
      { slug: 'durable_hook', url: 'https://hook.example/durable', durable: true },
      { slug: 'inline_hook', url: 'https://hook.example/inline' },
    ])
    await kernel.create({ collection: 'posts', data: { title: 'hi' }, overrideAccess: true })
    // The inline hook fired; the durable one did not.
    expect(fetchStub.calls.map((c) => c.url)).toEqual(['https://hook.example/inline'])
    const { docs } = await kernel.webhookDeliveries()
    expect(docs).toHaveLength(1)
    expect(docs[0]!.webhook).toBe('durable_hook')
  })

  it('drains a due delivery to delivered with a valid signature + event header', async () => {
    await bootDurable(() => new Response('ok', { status: 200 }))
    await kernel.create({ collection: 'posts', data: { title: 'deliver me' }, overrideAccess: true })
    const result = await kernel.processWebhooks()
    const { docs } = await kernel.webhookDeliveries()
    const row = docs[0]!
    expect(result.delivered).toEqual([row.id])
    expect(row.status).toBe('delivered')
    expect(row.deliveredAt).toBeTruthy()
    expect(row.nextAttemptAt).toBeNull()
    // The captured POST carried a valid HMAC of the body + the event header.
    expect(fetchStub.calls).toHaveLength(1)
    const sent = fetchStub.calls[0]!
    const expected = `sha256=${createHmac('sha256', SECRET).update(sent.body).digest('hex')}`
    expect(sent.headers['x-kernel-signature']).toBe(expected)
    expect(sent.headers['x-kernel-event']).toBe('create')
  })

  it('retries with backoff, is not re-attempted before due, then exhausts at maxAttempts', async () => {
    await bootDurable(() => new Response('boom', { status: 500 }), { maxAttempts: 2 })
    await kernel.create({ collection: 'posts', data: { title: 'fail me' }, overrideAccess: true })

    const t0 = new Date('2030-01-01T00:00:00.000Z')
    const r1 = await kernel.processWebhooks({ now: t0 })
    let row = (await kernel.webhookDeliveries()).docs[0]!
    expect(r1.retried).toEqual([row.id])
    expect(row.status).toBe('failed')
    expect(row.attempts).toBe(1)
    // Backoff after attempt 1 is min(2**1,3600)*1000 = 2000ms.
    expect(new Date(row.nextAttemptAt!).getTime()).toBe(t0.getTime() + 2000)

    // Same `now`: not due yet, nothing happens.
    const sameNow = await kernel.processWebhooks({ now: t0 })
    expect(sameNow).toEqual({ delivered: [], retried: [], exhausted: [] })
    row = (await kernel.webhookDeliveries()).docs[0]!
    expect(row.attempts).toBe(1)

    // Advance past the backoff → second (final) attempt → exhausted.
    const t1 = new Date(t0.getTime() + 3000)
    const r2 = await kernel.processWebhooks({ now: t1 })
    row = (await kernel.webhookDeliveries()).docs[0]!
    expect(r2.exhausted).toEqual([row.id])
    expect(row.status).toBe('exhausted')
    expect(row.attempts).toBe(2)
    expect(row.nextAttemptAt).toBeNull()
  })

  it('recovers a failed (not exhausted) delivery when the receiver later succeeds', async () => {
    let healthy = false
    await bootDurable(() => new Response(healthy ? 'ok' : 'boom', { status: healthy ? 200 : 500 }), { maxAttempts: 5 })
    await kernel.create({ collection: 'posts', data: { title: 'recover' }, overrideAccess: true })

    const t0 = new Date('2030-02-01T00:00:00.000Z')
    await kernel.processWebhooks({ now: t0 })
    let row = (await kernel.webhookDeliveries()).docs[0]!
    expect(row.status).toBe('failed')

    healthy = true
    const t1 = new Date(t0.getTime() + 3000)
    const r = await kernel.processWebhooks({ now: t1 })
    row = (await kernel.webhookDeliveries()).docs[0]!
    expect(r.delivered).toEqual([row.id])
    expect(row.status).toBe('delivered')
    expect(row.deliveredAt).toBeTruthy()
  })

  it('redacts secret + headers in listWebhooks and reflects signed', async () => {
    fetchStub = stubFetch()
    kernel = await boot([
      {
        slug: 'signed_hook',
        url: 'https://hook.example/s',
        secret: 'top-secret',
        headers: { authorization: 'Bearer abc' },
        durable: true,
      },
      { slug: 'unsigned_hook', url: 'https://hook.example/u', durable: true },
    ])
    const summaries = kernel.listWebhooks()
    const serialized = JSON.stringify(summaries)
    expect(serialized).not.toContain('top-secret')
    expect(serialized).not.toContain('Bearer')
    expect(summaries.find((w) => w.slug === 'signed_hook')!.signed).toBe(true)
    expect(summaries.find((w) => w.slug === 'unsigned_hook')!.signed).toBe(false)
    for (const s of summaries) {
      expect(s).not.toHaveProperty('secret')
      expect(s).not.toHaveProperty('headers')
    }
  })

  it('filters deliveries by status and webhook; the outbox is not reachable via find', async () => {
    fetchStub = stubFetch(() => new Response('ok', { status: 200 }))
    kernel = await boot([
      { slug: 'hook_a', url: 'https://hook.example/a', collections: ['posts'], durable: true },
      { slug: 'hook_b', url: 'https://hook.example/b', collections: ['posts'], durable: true },
    ])
    await kernel.create({ collection: 'posts', data: { title: 'x' }, overrideAccess: true })
    // Both hooks enqueued one pending delivery each.
    expect((await kernel.webhookDeliveries({ status: 'pending' })).count).toBe(2)
    const byA = await kernel.webhookDeliveries({ webhook: 'hook_a' })
    expect(byA.count).toBe(1)
    expect(byA.docs[0]!.webhook).toBe('hook_a')

    // Deliver only, then the pending filter should report fewer rows.
    await kernel.processWebhooks()
    expect((await kernel.webhookDeliveries({ status: 'pending' })).count).toBe(0)
    expect((await kernel.webhookDeliveries({ status: 'delivered' })).count).toBe(2)

    // The system outbox is NOT reachable via generic CRUD.
    await expect(kernel.find({ collection: '_webhook_deliveries', overrideAccess: true })).rejects.toThrow()
  })

  it('retryWebhookDelivery resets a delivery to pending due now (keeps attempts)', async () => {
    await bootDurable(() => new Response('boom', { status: 500 }), { maxAttempts: 5 })
    await kernel.create({ collection: 'posts', data: { title: 'retry' }, overrideAccess: true })
    const t0 = new Date('2030-03-01T00:00:00.000Z')
    await kernel.processWebhooks({ now: t0 })
    const failed = (await kernel.webhookDeliveries()).docs[0]!
    expect(failed.status).toBe('failed')
    expect(failed.attempts).toBe(1)

    const retried = await kernel.retryWebhookDelivery({ deliveryId: failed.id })
    expect(retried.status).toBe('pending')
    expect(retried.attempts).toBe(1) // history preserved
    expect(retried.nextAttemptAt).toBeTruthy()
    expect(retried.deliveredAt).toBeNull()
  })

  it('retryWebhookDelivery rejects an unknown id (NotFound) and a polluting id (BadRequest)', async () => {
    await bootDurable()
    await expect(kernel.retryWebhookDelivery({ deliveryId: 'does-not-exist' })).rejects.toThrow(/not.?found/i)
    await expect(kernel.retryWebhookDelivery({ deliveryId: '__proto__' })).rejects.toThrow(/valid|bad.?request/i)
  })
})

describe('durable webhooks — disabled (inline only)', () => {
  let kernel: Kernel
  let fetchStub: ReturnType<typeof stubFetch>

  beforeEach(async () => {
    fetchStub = stubFetch()
    kernel = await boot([{ slug: 'inline_only', url: 'https://hook.example/inline' }])
  })
  afterEach(async () => {
    fetchStub.restore()
    await kernel.destroy()
  })

  it('processWebhooks is a no-op and webhookDeliveries returns empty (no outbox table)', async () => {
    await kernel.create({ collection: 'posts', data: { title: 'x' }, overrideAccess: true })
    // Inline fired.
    expect(fetchStub.calls).toHaveLength(1)
    const result = await kernel.processWebhooks()
    expect(result).toEqual({ delivered: [], retried: [], exhausted: [] })
    expect(await kernel.webhookDeliveries()).toEqual({ docs: [], count: 0 })
  })
})
