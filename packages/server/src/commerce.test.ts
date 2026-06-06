import { beforeEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { commerce, initKernel, signTestWebhook, testPayment } from '@kernel/core'
import type { Kernel } from '@kernel/core'
import { createRequestHandler } from './index'

const WEBHOOK_SECRET = 'test_webhook_secret'
let kernel: Kernel

beforeEach(async () => {
  kernel = await initKernel(
    {
      secret: 'commerce-test',
      db: sqliteAdapter({ url: ':memory:' }),
      plugins: [commerce({ payment: testPayment({ webhookSecret: WEBHOOK_SECRET }) })],
      collections: [],
    },
    { logLevel: 'error' },
  )
  await kernel.migrate()
})

const handler = () => createRequestHandler(kernel, { rateLimit: { enabled: false } })

async function makeProduct(price: number, extra: Record<string, unknown> = {}) {
  return kernel.create<{ id: string }>({
    collection: 'products',
    data: { title: 'Widget', price, currency: 'usd', active: true, ...extra },
    overrideAccess: true,
  })
}

describe('commerce module', () => {
  it('checkout computes the total server-side and creates a pending order', async () => {
    const product = await makeProduct(1500)
    const res = await handler()(
      new Request('http://localhost/api/commerce/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // The client supplies only product ids + quantities — never amounts.
        body: JSON.stringify({ items: [{ productId: product.id, quantity: 2 }], email: 'buyer@test.dev' }),
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { orderId: string; total: number; checkoutUrl: string }
    expect(body.total).toBe(3000) // 1500 * 2, recomputed from the product
    expect(body.checkoutUrl).toContain('pay.test')

    const order = await kernel.findByID<{ id: string; status: string; total: number }>({
      collection: 'orders',
      id: body.orderId,
      overrideAccess: true,
    })
    expect(order?.status).toBe('pending')
    expect(order?.total).toBe(3000)
  })

  it('rejects a checkout for an inactive or unknown product', async () => {
    const inactive = await makeProduct(1000, { active: false })
    const res = await handler()(
      new Request('http://localhost/api/commerce/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items: [{ productId: inactive.id, quantity: 1 }] }),
      }),
    )
    expect(res.status).toBe(400)
  })

  it('a verified webhook marks the order paid', async () => {
    const product = await makeProduct(2500)
    const checkout = (await (
      await handler()(
        new Request('http://localhost/api/commerce/checkout', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ items: [{ productId: product.id, quantity: 1 }] }),
        }),
      )
    ).json()) as { orderId: string }

    const payload = JSON.stringify({ type: 'paid', status: 'paid', orderId: checkout.orderId, paymentId: 'pi_1' })
    const res = await handler()(
      new Request('http://localhost/api/commerce/webhook', {
        method: 'POST',
        headers: { 'stripe-signature': signTestWebhook(payload, WEBHOOK_SECRET) },
        body: payload,
      }),
    )
    expect(res.status).toBe(200)
    const order = await kernel.findByID<{ id: string; status: string; payment_id: string }>({
      collection: 'orders',
      id: checkout.orderId,
      overrideAccess: true,
    })
    expect(order?.status).toBe('paid')
    expect(order?.payment_id).toBe('pi_1')
  })

  it('rejects a webhook with a bad signature and leaves the order untouched', async () => {
    const product = await makeProduct(500)
    const checkout = (await (
      await handler()(
        new Request('http://localhost/api/commerce/checkout', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ items: [{ productId: product.id, quantity: 1 }] }),
        }),
      )
    ).json()) as { orderId: string }

    const payload = JSON.stringify({ status: 'paid', orderId: checkout.orderId })
    const res = await handler()(
      new Request('http://localhost/api/commerce/webhook', {
        method: 'POST',
        headers: { 'stripe-signature': 'sha256=forged' },
        body: payload,
      }),
    )
    expect(res.status).toBe(400)
    const order = await kernel.findByID<{ id: string; status: string }>({
      collection: 'orders',
      id: checkout.orderId,
      overrideAccess: true,
    })
    expect(order?.status).toBe('pending')
  })

  it('orders are not publicly readable (no IDOR)', async () => {
    const product = await makeProduct(100)
    const checkout = (await (
      await handler()(
        new Request('http://localhost/api/commerce/checkout', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ items: [{ productId: product.id, quantity: 1 }] }),
        }),
      )
    ).json()) as { orderId: string }
    const res = await handler()(new Request(`http://localhost/api/orders/${checkout.orderId}`))
    expect(res.status).toBe(403)
  })

  it('exposes a public product catalog', async () => {
    await makeProduct(999)
    const res = await handler()(new Request('http://localhost/api/products'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { docs: unknown[] }
    expect(body.docs.length).toBe(1)
  })
})
