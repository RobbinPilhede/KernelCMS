import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { PaymentError, signTestWebhook, stripePayment, testPayment, verifyStripeSignature } from './payments'

describe('testPayment', () => {
  it('creates a deterministic checkout session', async () => {
    const pay = testPayment()
    const session = await pay.createCheckout({
      orderId: 'order_1',
      currency: 'usd',
      lineItems: [{ name: 'Widget', amount: 1500, quantity: 2 }],
    })
    expect(session.provider).toBe('test')
    expect(session.id).toBe('cs_test_order_1')
    expect(session.url).toContain('order_1')
  })

  it('verifies a signed webhook and normalizes it', async () => {
    const pay = testPayment({ webhookSecret: 's3cret' })
    const payload = JSON.stringify({ type: 'paid', status: 'paid', orderId: 'order_1', amount: 3000, currency: 'usd' })
    const sig = signTestWebhook(payload, 's3cret')
    const event = await pay.parseWebhook({ payload, signature: sig })
    expect(event.status).toBe('paid')
    expect(event.orderId).toBe('order_1')
    expect(event.amount).toBe(3000)
  })

  it('rejects a webhook with a bad signature', async () => {
    const pay = testPayment({ webhookSecret: 's3cret' })
    const payload = JSON.stringify({ status: 'paid', orderId: 'x' })
    await expect(pay.parseWebhook({ payload, signature: 'sha256=deadbeef' })).rejects.toBeInstanceOf(PaymentError)
    await expect(pay.parseWebhook({ payload, signature: null })).rejects.toBeInstanceOf(PaymentError)
  })

  it('refunds', async () => {
    const pay = testPayment()
    expect((await pay.refund({ paymentId: 'pi_1' })).status).toBe('refunded')
  })
})

describe('stripePayment webhook verification', () => {
  const secret = 'whsec_test'

  function signStripe(payload: string, ts: number): string {
    const v1 = createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex')
    return `t=${ts},v1=${v1}`
  }

  it('accepts a correctly signed, in-tolerance event', () => {
    const payload = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_1' } } })
    const ts = Math.floor(Date.now() / 1000)
    const event = verifyStripeSignature(payload, signStripe(payload, ts), secret)
    expect(event.type).toBe('checkout.session.completed')
  })

  it('rejects a tampered payload', () => {
    const payload = JSON.stringify({ type: 'checkout.session.completed' })
    const ts = Math.floor(Date.now() / 1000)
    const header = signStripe(payload, ts)
    expect(() => verifyStripeSignature(payload + 'x', header, secret)).toThrow(PaymentError)
  })

  it('rejects a stale timestamp', () => {
    const payload = JSON.stringify({ type: 'x' })
    const old = Math.floor(Date.now() / 1000) - 10_000
    expect(() => verifyStripeSignature(payload, signStripe(payload, old), secret)).toThrow(/tolerance/)
  })

  it('rejects a missing/malformed header', () => {
    expect(() => verifyStripeSignature('{}', null, secret)).toThrow(PaymentError)
    expect(() => verifyStripeSignature('{}', 'garbage', secret)).toThrow(PaymentError)
  })

  it('normalizes a completed checkout event to paid with the order id', async () => {
    const pay = stripePayment({ secretKey: 'sk_test', webhookSecret: secret })
    const payload = JSON.stringify({
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_9',
          payment_intent: 'pi_9',
          metadata: { orderId: 'order_9' },
          amount_total: 4500,
          currency: 'usd',
        },
      },
    })
    const ts = Math.floor(Date.now() / 1000)
    const event = await pay.parseWebhook({ payload, signature: signStripe(payload, ts) })
    expect(event.status).toBe('paid')
    expect(event.orderId).toBe('order_9')
    expect(event.paymentId).toBe('pi_9')
    expect(event.amount).toBe(4500)
  })

  it('createCheckout posts a form-encoded session to the configured API base', async () => {
    const calls: { url: string; body: string; headers: Record<string, string> }[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (url: string, init: { body: string; headers: Record<string, string> }) => {
      calls.push({ url, body: init.body, headers: init.headers })
      return new Response(JSON.stringify({ id: 'cs_live', url: 'https://stripe.test/pay' }), { status: 200 })
    }) as unknown as typeof fetch
    try {
      const pay = stripePayment({ secretKey: 'sk_test', webhookSecret: secret, apiBase: 'https://api.stripe.test' })
      const session = await pay.createCheckout({
        orderId: 'order_5',
        currency: 'usd',
        lineItems: [{ name: 'Book', amount: 1999, quantity: 1 }],
        customerEmail: 'a@b.test',
      })
      expect(session.id).toBe('cs_live')
      expect(session.url).toBe('https://stripe.test/pay')
      expect(calls[0]!.url).toBe('https://api.stripe.test/v1/checkout/sessions')
      expect(calls[0]!.headers.authorization).toBe('Bearer sk_test')
      expect(calls[0]!.body).toContain('metadata%5BorderId%5D=order_5')
      expect(calls[0]!.body).toContain('unit_amount%5D=1999')
    } finally {
      globalThis.fetch = original
    }
  })
})
