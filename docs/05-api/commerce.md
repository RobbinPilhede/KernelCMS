# Commerce: payments & orders

The `commerce()` module turns a KernelCMS instance into a small store. It is opt-in
and built on the same primitives as everything else (a module that injects
collections + endpoints, plus a provider-agnostic payment adapter).

## Enable it

```ts
import { defineConfig, commerce, stripePayment } from 'kernelcms'
import { sqliteAdapter } from 'kernelcms/sqlite'

export default defineConfig({
  db: sqliteAdapter({ url: 'file:./content.db' }),
  plugins: [
    commerce({
      payment: stripePayment({
        secretKey: process.env.STRIPE_SECRET_KEY!,
        webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
        successUrl: 'https://yoursite.com/thank-you',
        cancelUrl: 'https://yoursite.com/cart',
      }),
      currency: 'usd',
    }),
  ],
  collections: [],
})
```

For local development and tests use `testPayment()` — a deterministic adapter with
no network that signs its webhooks so the full verify-and-transition path runs.

## What you get

Two collections (slugs configurable):

- **`products`** — `title`, `description` (rich text), `price` (integer minor units,
  e.g. cents), `currency`, `sku`, `inventory`, `active`. Read-public; writes are
  admin/trusted only.
- **`orders`** — `order_number`, `status` (pending / paid / failed / fulfilled /
  cancelled / refunded), `email`, `items` (a snapshot of what was bought at the price
  charged), `subtotal`, `total`, `currency`, `provider`, `session_id`, `payment_id`.
  **Server/admin only** — never publicly readable or writable.

Two endpoints (under `/commerce` by default):

- **`POST /commerce/checkout`** — body `{ items: [{ productId, quantity }], email? }`.
  Loads each product, **recomputes the total server-side from the real price**,
  creates a `pending` order, opens a payment checkout session, and returns
  `{ orderId, orderNumber, total, currency, checkoutUrl, sessionId }`.
- **`POST /commerce/webhook`** — the payment provider calls this. The raw body is
  verified against the provider signature before anything happens, then the matching
  order is transitioned (paid / failed / refunded). Idempotent.

## Security model

- **The client never sends an amount.** Checkout takes only product ids and
  quantities; totals come from the product records. A tampered price is impossible.
- **Webhooks are signature-verified** over the raw request body (Stripe's
  `t=<ts>,v1=<hmac>` scheme, constant-time compare, replay-tolerance window). A
  forged webhook is rejected with 400 and the order is untouched.
- **Orders are not enumerable.** They default to deny on every access rule, so one
  customer can never read another's order over the API (no IDOR).

## Payment adapters

`PaymentAdapter` has three methods: `createCheckout`, `parseWebhook` (verify +
normalize), and `refund`. Implement it for any provider.

- **`stripePayment({ secretKey, webhookSecret })`** — uses the Stripe REST API
  directly over `fetch` (no SDK dependency). Set the webhook endpoint in your Stripe
  dashboard to `https://yoursite.com/api/commerce/webhook`.
- **`testPayment({ webhookSecret? })`** — deterministic, for dev and tests.

## Notes

- Money is always in the smallest currency unit (integer cents) to avoid float bugs.
- Tax, shipping, discounts, carts, and inventory decrement-on-paid are natural next
  additions — the order/product model leaves room for them.
