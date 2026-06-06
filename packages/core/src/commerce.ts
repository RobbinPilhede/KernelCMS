/**
 * Commerce: a `defineModule` plugin that turns a KernelCMS instance into a small
 * store. It injects `products` and `orders` collections and two endpoints:
 *
 *   POST <base>/checkout  — recomputes the cart total server-side from real product
 *                           prices (never trusts a client amount), creates a pending
 *                           order, and opens a payment checkout session.
 *   POST <base>/webhook   — verifies the provider's signature over the raw body and
 *                           transitions the order (paid / failed / refunded). Idempotent.
 *
 * Orders are server/admin-only (no public read or write); products are read-public.
 * Money is in minor units (cents) throughout.
 */
import { randomBytes } from 'node:crypto'
import { defineModule } from './plugins'
import type { KernelPlugin } from './plugins'
import { defineEndpoint } from './endpoints'
import { BadRequestError } from './errors'
import { PaymentError, type PaymentAdapter, type PaymentLineItem } from './payments'
import type { CollectionConfig, Doc, Parser } from './types'

export interface CommerceOptions {
  /** Payment adapter, e.g. `testPayment()` or `stripePayment({...})`. */
  payment: PaymentAdapter
  /** Default currency (ISO 4217, lower-case). Default 'usd'. */
  currency?: string
  /** Collection slugs. Defaults: 'products' / 'orders'. */
  productsSlug?: string
  ordersSlug?: string
  /** API base for the endpoints. Default '/commerce'. */
  basePath?: string
  /** Header carrying the provider webhook signature. Default 'stripe-signature'. */
  signatureHeader?: string
  /** Hosted-checkout redirect targets. */
  successUrl?: string
  cancelUrl?: string
}

interface CheckoutBody {
  items: { productId: string; quantity: number }[]
  email?: string
  successUrl?: string
  cancelUrl?: string
}

const checkoutBodyParser: Parser<CheckoutBody> = {
  parse(value: unknown): CheckoutBody {
    if (!value || typeof value !== 'object') throw new Error('Body must be an object.')
    const o = value as Record<string, unknown>
    if (!Array.isArray(o.items) || o.items.length === 0) throw new Error('`items` must be a non-empty array.')
    const items = o.items.map((raw) => {
      const it = raw as Record<string, unknown>
      if (typeof it.productId !== 'string' || it.productId.length === 0)
        throw new Error('each item needs a `productId`.')
      const quantity = it.quantity === undefined ? 1 : Number(it.quantity)
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) {
        throw new Error('`quantity` must be an integer between 1 and 1000.')
      }
      return { productId: it.productId, quantity }
    })
    return {
      items,
      email: typeof o.email === 'string' ? o.email : undefined,
      successUrl: typeof o.successUrl === 'string' ? o.successUrl : undefined,
      cancelUrl: typeof o.cancelUrl === 'string' ? o.cancelUrl : undefined,
    }
  },
}

function productsCollection(slug: string): CollectionConfig {
  return {
    slug,
    labels: { singular: 'Product', plural: 'Products' },
    admin: { useAsTitle: 'title', defaultColumns: ['title', 'price', 'inventory', 'active'] },
    // Catalog is public to read; writes go through admin/trusted calls (default deny).
    access: { read: () => true },
    fields: [
      { name: 'title', type: 'text', required: true },
      { name: 'description', type: 'richText' },
      // Price in minor units (cents). Integer to avoid float money bugs.
      { name: 'price', type: 'number', integer: true, required: true },
      { name: 'currency', type: 'text', defaultValue: 'usd' },
      { name: 'sku', type: 'text', index: true },
      { name: 'inventory', type: 'number', integer: true, defaultValue: 0 },
      { name: 'active', type: 'boolean', defaultValue: true },
    ],
  }
}

function ordersCollection(slug: string): CollectionConfig {
  return {
    slug,
    labels: { singular: 'Order', plural: 'Orders' },
    admin: { useAsTitle: 'order_number', defaultColumns: ['order_number', 'status', 'email', 'total'] },
    // Server/admin only: orders carry customer data and must never be publicly
    // listable or writable. All access defaults to deny; the module uses
    // overrideAccess for its own trusted writes.
    access: { read: () => false, create: () => false, update: () => false, delete: () => false },
    fields: [
      { name: 'order_number', type: 'text', index: true },
      {
        name: 'status',
        type: 'select',
        options: ['pending', 'paid', 'failed', 'fulfilled', 'cancelled', 'refunded'],
        defaultValue: 'pending',
        index: true,
      },
      { name: 'email', type: 'text' },
      // Snapshot of purchased lines at the price charged.
      { name: 'items', type: 'json' },
      { name: 'subtotal', type: 'number', integer: true },
      { name: 'total', type: 'number', integer: true },
      { name: 'currency', type: 'text' },
      { name: 'provider', type: 'text' },
      { name: 'session_id', type: 'text', index: true },
      { name: 'payment_id', type: 'text' },
    ],
  }
}

function orderNumber(): string {
  return `ORD-${randomBytes(5).toString('hex').toUpperCase()}`
}

/**
 * Build the commerce module. Add the returned plugin to `config.plugins`.
 */
export function commerce(options: CommerceOptions): KernelPlugin {
  const productsSlug = options.productsSlug ?? 'products'
  const ordersSlug = options.ordersSlug ?? 'orders'
  const base = options.basePath ?? '/commerce'
  const sigHeader = options.signatureHeader ?? 'stripe-signature'
  const defaultCurrency = options.currency ?? 'usd'
  const payment = options.payment

  const checkout = defineEndpoint<undefined, undefined, CheckoutBody, unknown>({
    method: 'POST',
    path: `${base}/checkout`,
    // Anyone may start a checkout; the order is created server-side.
    access: () => true,
    input: { body: checkoutBodyParser },
    summary: 'Create an order and a payment checkout session.',
    tags: ['commerce'],
    async handler({ input, ctx }) {
      const { items, email } = input.body
      // Load each product with a trusted read (prices/active are authoritative).
      const lineItems: PaymentLineItem[] = []
      const snapshot: Record<string, unknown>[] = []
      let subtotal = 0
      let currency = defaultCurrency
      for (const line of items) {
        const product = (await ctx.local.findByID({
          collection: productsSlug,
          id: line.productId,
          overrideAccess: true,
        })) as (Doc & { title?: string; price?: number; currency?: string; active?: boolean }) | null
        if (!product || product.active === false) {
          throw new BadRequestError(`Product "${line.productId}" is not available.`)
        }
        const amount = Number(product.price ?? 0)
        if (!Number.isInteger(amount) || amount < 0) throw new BadRequestError('Product has an invalid price.')
        currency = (product.currency as string) || currency
        lineItems.push({ name: String(product.title ?? 'Item'), amount, quantity: line.quantity })
        snapshot.push({ productId: product.id, name: product.title, amount, quantity: line.quantity })
        subtotal += amount * line.quantity
      }

      const order = await ctx.local.create({
        collection: ordersSlug,
        data: {
          order_number: orderNumber(),
          status: 'pending',
          email: email ?? null,
          items: snapshot,
          subtotal,
          total: subtotal,
          currency,
          provider: payment.name,
        },
        overrideAccess: true,
      })

      const session = await payment.createCheckout({
        orderId: order.id,
        lineItems,
        currency,
        successUrl: input.body.successUrl ?? options.successUrl,
        cancelUrl: input.body.cancelUrl ?? options.cancelUrl,
        customerEmail: email,
        metadata: { orderId: order.id },
      })

      await ctx.local.update({
        collection: ordersSlug,
        id: order.id,
        data: { session_id: session.id },
        overrideAccess: true,
      })

      return {
        orderId: order.id,
        orderNumber: order.order_number,
        total: subtotal,
        currency,
        checkoutUrl: session.url,
        sessionId: session.id,
      }
    },
  })

  const webhook = defineEndpoint<undefined, undefined, undefined, unknown>({
    method: 'POST',
    path: `${base}/webhook`,
    // Public route; the provider signature is the authentication. No `input.body`
    // is declared so the server leaves the body unread and we verify the raw bytes.
    access: () => true,
    summary: 'Receive a verified payment provider webhook.',
    tags: ['commerce'],
    async handler({ ctx }) {
      const payload = await ctx.request.text()
      const signature = ctx.request.headers.get(sigHeader)
      let event
      try {
        event = await payment.parseWebhook({ payload, signature })
      } catch (err) {
        if (err instanceof PaymentError) throw new BadRequestError('Invalid webhook signature.')
        throw err
      }
      if (!event.orderId) return { received: true, ignored: 'no orderId' }

      const order = (await ctx.local.findByID({
        collection: ordersSlug,
        id: event.orderId,
        overrideAccess: true,
      })) as (Doc & { status?: string }) | null
      if (!order) return { received: true, ignored: 'unknown order' }

      const next =
        event.status === 'paid'
          ? 'paid'
          : event.status === 'failed'
            ? 'failed'
            : event.status === 'refunded'
              ? 'refunded'
              : null
      // Idempotent: only move forward, and never downgrade a refunded/paid order.
      if (next && order.status !== next && !(order.status === 'refunded' && next !== 'refunded')) {
        await ctx.local.update({
          collection: ordersSlug,
          id: event.orderId,
          data: { status: next, ...(event.paymentId ? { payment_id: event.paymentId } : {}) },
          overrideAccess: true,
        })
      }
      return { received: true, orderId: event.orderId, status: next ?? order.status }
    },
  })

  return defineModule({
    name: 'commerce',
    collections: [productsCollection(productsSlug), ordersCollection(ordersSlug)],
    endpoints: [checkout, webhook],
  })
}
