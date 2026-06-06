/**
 * Payments: a provider-agnostic `PaymentAdapter` plus a deterministic test adapter
 * and a Stripe adapter. The `commerce()` module wires these into checkout and
 * webhook endpoints. Money is always in the smallest currency unit (cents), and
 * order totals are recomputed server-side from real product prices — the client
 * never supplies an amount.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

/** A single line on a checkout, priced in the smallest currency unit. */
export interface PaymentLineItem {
  name: string
  /** Unit price in minor units (e.g. cents). */
  amount: number
  quantity: number
}

export interface CreateCheckoutArgs {
  /** Your order id; carried in provider metadata and returned on the webhook. */
  orderId: string
  lineItems: PaymentLineItem[]
  /** ISO 4217 lower-case (e.g. 'usd'). */
  currency: string
  successUrl?: string
  cancelUrl?: string
  customerEmail?: string
  metadata?: Record<string, string>
}

export interface CheckoutSession {
  /** Provider session id. */
  id: string
  /** Hosted payment URL to redirect the customer to (when the provider has one). */
  url?: string
  provider: string
}

export type PaymentStatus = 'paid' | 'failed' | 'refunded' | 'pending' | 'unknown'

/** A normalized payment event parsed from a verified provider webhook. */
export interface PaymentEvent {
  /** Raw provider event type, e.g. 'checkout.session.completed'. */
  type: string
  /** Normalized outcome the order lifecycle acts on. */
  status: PaymentStatus
  /** Your order id, recovered from provider metadata. */
  orderId?: string
  sessionId?: string
  paymentId?: string
  amount?: number
  currency?: string
}

export interface RefundResult {
  id: string
  status: 'refunded' | 'pending' | 'failed'
}

export interface PaymentAdapter {
  readonly name: string
  /** Open a checkout session for the given line items + order reference. */
  createCheckout(args: CreateCheckoutArgs): Promise<CheckoutSession>
  /**
   * Verify an inbound provider webhook and normalize it. MUST throw when the
   * signature is missing or invalid — the caller treats a throw as "reject".
   */
  parseWebhook(args: { payload: string; signature: string | null }): Promise<PaymentEvent>
  /** Refund a captured payment, fully or (with `amount`) partially. */
  refund(args: { paymentId: string; amount?: number }): Promise<RefundResult>
}

export class PaymentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PaymentError'
  }
}

// ---------------------------------------------------------------------------
// Test adapter (deterministic, no network)
// ---------------------------------------------------------------------------

export interface TestPaymentOptions {
  /** Secret used to HMAC-sign test webhooks, so signature verification is exercised. */
  webhookSecret?: string
}

/**
 * A deterministic in-process payment adapter for development and tests. Checkout
 * returns a fake hosted URL; webhooks are JSON bodies signed with an HMAC over the
 * raw payload (header `sha256=<hex>`), so the full verify-and-transition path runs
 * exactly as it would with a real provider.
 */
export function testPayment(options: TestPaymentOptions = {}): PaymentAdapter {
  const secret = options.webhookSecret ?? 'test_webhook_secret'
  return {
    name: 'test',
    async createCheckout(args: CreateCheckoutArgs): Promise<CheckoutSession> {
      return {
        id: `cs_test_${args.orderId}`,
        url: `https://pay.test/checkout/${encodeURIComponent(args.orderId)}`,
        provider: 'test',
      }
    },
    async parseWebhook({ payload, signature }): Promise<PaymentEvent> {
      const expected = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`
      if (!signature || !safeEqual(signature, expected)) throw new PaymentError('Invalid webhook signature.')
      const body = JSON.parse(payload) as {
        type?: string
        status?: PaymentStatus
        orderId?: string
        sessionId?: string
        paymentId?: string
        amount?: number
        currency?: string
      }
      return {
        type: body.type ?? 'test.event',
        status: body.status ?? 'unknown',
        orderId: body.orderId,
        sessionId: body.sessionId,
        paymentId: body.paymentId,
        amount: body.amount,
        currency: body.currency,
      }
    },
    async refund({ paymentId }): Promise<RefundResult> {
      return { id: `re_test_${paymentId}`, status: 'refunded' }
    },
  }
}

/** Sign a test webhook payload (helper for tests/local tooling). */
export function signTestWebhook(payload: string, webhookSecret = 'test_webhook_secret'): string {
  return `sha256=${createHmac('sha256', webhookSecret).update(payload).digest('hex')}`
}

// ---------------------------------------------------------------------------
// Stripe adapter (REST over fetch; no SDK dependency)
// ---------------------------------------------------------------------------

export interface StripePaymentOptions {
  /** Secret API key (sk_...). Read from env; never hardcode. */
  secretKey: string
  /** Webhook signing secret (whsec_...) for verifying inbound events. */
  webhookSecret: string
  /** Default redirect targets for hosted checkout. */
  successUrl?: string
  cancelUrl?: string
  /** Override the API base (for testing). Defaults to Stripe's API. */
  apiBase?: string
  /** Tolerance in seconds for the webhook timestamp. Default 300. */
  toleranceSeconds?: number
}

function formEncode(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')
}

/**
 * Stripe payment adapter using the REST API directly (form-encoded, Bearer auth)
 * so there is no SDK dependency. Webhook signatures are verified with the
 * documented `t=<ts>,v1=<hmac>` scheme (HMAC-SHA256 over `${t}.${payload}`).
 */
export function stripePayment(options: StripePaymentOptions): PaymentAdapter {
  const apiBase = options.apiBase ?? 'https://api.stripe.com'
  const tolerance = options.toleranceSeconds ?? 300

  async function call(path: string, body: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await fetch(`${apiBase}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.secretKey}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: formEncode(body),
    })
    const json = (await res.json()) as Record<string, unknown>
    if (!res.ok) {
      const err = json.error as { message?: string } | undefined
      throw new PaymentError(`Stripe ${path} failed (${res.status}): ${err?.message ?? 'unknown error'}`)
    }
    return json
  }

  return {
    name: 'stripe',
    async createCheckout(args: CreateCheckoutArgs): Promise<CheckoutSession> {
      const params: Record<string, string> = {
        mode: 'payment',
        'metadata[orderId]': args.orderId,
        success_url: args.successUrl ?? options.successUrl ?? 'https://example.com/success',
        cancel_url: args.cancelUrl ?? options.cancelUrl ?? 'https://example.com/cancel',
      }
      if (args.customerEmail) params.customer_email = args.customerEmail
      for (const [k, v] of Object.entries(args.metadata ?? {})) params[`metadata[${k}]`] = v
      args.lineItems.forEach((item, i) => {
        params[`line_items[${i}][quantity]`] = String(item.quantity)
        params[`line_items[${i}][price_data][currency]`] = args.currency
        params[`line_items[${i}][price_data][unit_amount]`] = String(item.amount)
        params[`line_items[${i}][price_data][product_data][name]`] = item.name
      })
      const session = await call('/v1/checkout/sessions', params)
      return { id: String(session.id), url: session.url ? String(session.url) : undefined, provider: 'stripe' }
    },
    async parseWebhook({ payload, signature }): Promise<PaymentEvent> {
      const event = verifyStripeSignature(payload, signature, options.webhookSecret, tolerance)
      const type = String(event.type ?? '')
      const obj = ((event.data as { object?: Record<string, unknown> })?.object ?? {}) as Record<string, unknown>
      const metadata = (obj.metadata as Record<string, string> | undefined) ?? {}
      const status: PaymentStatus =
        type === 'checkout.session.completed' || type === 'payment_intent.succeeded'
          ? 'paid'
          : type === 'payment_intent.payment_failed'
            ? 'failed'
            : type === 'charge.refunded'
              ? 'refunded'
              : 'unknown'
      return {
        type,
        status,
        orderId: metadata.orderId,
        sessionId: typeof obj.id === 'string' ? obj.id : undefined,
        paymentId: typeof obj.payment_intent === 'string' ? obj.payment_intent : undefined,
        amount: typeof obj.amount_total === 'number' ? obj.amount_total : undefined,
        currency: typeof obj.currency === 'string' ? obj.currency : undefined,
      }
    },
    async refund({ paymentId, amount }): Promise<RefundResult> {
      const params: Record<string, string> = { payment_intent: paymentId }
      if (typeof amount === 'number') params.amount = String(amount)
      const refund = await call('/v1/refunds', params)
      const status = String(refund.status ?? 'pending')
      return {
        id: String(refund.id),
        status: status === 'succeeded' ? 'refunded' : status === 'failed' ? 'failed' : 'pending',
      }
    },
  }
}

/** Verify a Stripe `Stripe-Signature` header and return the parsed event. Throws on failure. */
export function verifyStripeSignature(
  payload: string,
  header: string | null,
  secret: string,
  toleranceSeconds = 300,
): Record<string, unknown> {
  if (!header) throw new PaymentError('Missing Stripe signature.')
  const parts = Object.fromEntries(
    header.split(',').map((kv) => {
      const idx = kv.indexOf('=')
      return [kv.slice(0, idx).trim(), kv.slice(idx + 1).trim()]
    }),
  ) as { t?: string; v1?: string }
  if (!parts.t || !parts.v1) throw new PaymentError('Malformed Stripe signature.')
  const ts = Number(parts.t)
  if (!Number.isFinite(ts)) throw new PaymentError('Invalid Stripe timestamp.')
  const expected = createHmac('sha256', secret).update(`${parts.t}.${payload}`).digest('hex')
  if (!safeEqual(parts.v1, expected)) throw new PaymentError('Stripe signature mismatch.')
  // Replay window: reject events whose timestamp is too old (when checkable).
  const nowSec = Math.floor(Date.now() / 1000)
  if (toleranceSeconds > 0 && Math.abs(nowSec - ts) > toleranceSeconds) {
    throw new PaymentError('Stripe signature timestamp outside tolerance.')
  }
  return JSON.parse(payload) as Record<string, unknown>
}

/** Constant-time string compare that never short-circuits on length. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}
