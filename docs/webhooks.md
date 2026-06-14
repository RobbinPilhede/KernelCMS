# Outbound webhooks

**Outbound webhooks** push a signed `POST` to an external URL whenever a document changes —
"a `posts` row was published", "an `orders` row was updated" — so a downstream system, a
static-site rebuild, or a Slack relay can react without polling your API. Each delivery
carries a small JSON payload, an HMAC signature the receiver verifies, and the headers needed
to route and dedupe it.

A webhook `url` is **default-deny on egress**: it must be `http(s)` and its host may **not**
be a loopback, private, link-local, or cloud-metadata address — that SSRF guard runs at config
load, before anything fires, unless you explicitly opt the endpoint in for a trusted internal
receiver. The signing **secret** and any custom **headers** you attach are never returned by
the admin surface and never logged. Durable delivery is **at-least-once** with bounded retries,
so the receiver's job is simply to verify the signature and dedupe.

## Opt in

Webhooks are off until you register them. Each entry has a `url` and optional signing,
filtering, and delivery options:

```ts
export default defineConfig({
  webhooks: [
    // Inline (default): best-effort, fires immediately on the write.
    {
      slug: 'search-reindex',
      url: 'https://hooks.example.com/reindex',
      secret: process.env.REINDEX_SECRET, // HMAC-SHA256 signing key
      collections: ['posts'],             // default: all non-system collections
      events: ['create', 'update', 'delete'],
      headers: { 'x-source': 'kernel' },  // never returned by the admin surface
      timeoutMs: 5000,
    },
    // Durable: enqueued to the outbox and drained by the cron with retry + backoff.
    {
      slug: 'billing-sync',
      url: 'https://billing.internal.example.com/kernel',
      secret: process.env.BILLING_SECRET,
      collections: ['orders'],
      events: ['create', 'update'],
      durable: true,        // survives a down receiver — retried, never dropped
      maxAttempts: 5,       // default 5; exponential backoff, capped at 1h
    },
  ],
  collections: [/* … */],
})
```

If you omit `collections` the webhook fires for every non-system collection; if you omit
`events` it fires on `create`, `update`, and `delete`. A `slug` is optional but makes a
webhook addressable in the admin delivery log (below). Registering a durable webhook creates a
private `_webhook_deliveries` outbox table — like every system table it is **not** reachable
through generic CRUD (`find`/`create` on `_webhook_deliveries` is rejected); it is only ever
touched through the dedicated operations below.

## Inline vs. durable delivery

One config, two delivery modes — pick per endpoint with `durable`.

- **Inline (the default).** A content write fires a best-effort signed `POST` immediately. It
  is fire-and-forget: a slow or down receiver **never fails the write** (the document is
  committed first; the delivery is best-effort on top), but if the receiver is down the event
  is **dropped**. Use it for non-critical fan-out where an occasional miss is fine — a cache
  nudge, a "something changed" ping, local development.
- **Durable (`durable: true`).** The write enqueues the event to the `_webhook_deliveries`
  outbox and returns. The [cron drain](#the-cron-drain) delivers it with **retry + exponential
  backoff** (capped at 1h) up to `maxAttempts` (default 5), so a receiver that is briefly down
  no longer drops events. Use it when the receiver **must** eventually get every event — a
  billing sync, an external system of record, an audit pipeline.

Durable delivery is **at-least-once**: a receiver that ACKs slowly (or a drain that retries
after a partial success) can see the same event twice. Receivers should **dedupe** on
`id` + `event` + `timestamp` from the payload.

## The payload

Every delivery sends the same JSON body:

```json
{
  "event": "update",
  "collection": "orders",
  "id": "o_07",
  "doc": { "id": "o_07", "status": "paid" },
  "timestamp": "2026-06-13T10:00:01Z"
}
```

`doc` is the changed document (omitted on `delete`). Three headers ride along:

- `x-kernel-event` — the event type (`create` / `update` / `delete`).
- `x-kernel-timestamp` — the delivery timestamp (matches the body).
- `x-kernel-signature` — `sha256=<hmac-of-body>`, present only when the webhook has a `secret`.

## Verifying the signature

When a `secret` is set, recompute the HMAC over the **raw request body** (the exact bytes, not
a re-serialized object) and compare in constant time:

```js
import { createHmac, timingSafeEqual } from 'node:crypto'

// rawBody is the exact request body bytes; secret matches the webhook's `secret`.
function verify(rawBody, header, secret) {
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex')
  const a = Buffer.from(header ?? '')
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

// In an Express receiver (raw body required for an exact-bytes HMAC):
app.post('/kernel', express.raw({ type: 'application/json' }), (req, res) => {
  if (!verify(req.body, req.get('x-kernel-signature'), process.env.WEBHOOK_SECRET)) {
    return res.status(401).end()
  }
  const { event, id, timestamp } = JSON.parse(req.body.toString('utf8'))
  if (seenBefore(id, event, timestamp)) return res.status(200).end() // dedupe
  // … act on the event …
  res.status(200).end()
})
```

A request whose signature doesn't recompute should be rejected with `401`. Because durable
delivery is at-least-once, the dedupe check on `id` + `event` + `timestamp` is what makes your
receiver idempotent.

## The cron drain

Durable deliveries sit in the outbox until a drain runs. `kernel.processWebhooks()` claims the
due deliveries, sends them, and reschedules any failure with exponential backoff:

```ts
const { delivered, failed } = await kernel.processWebhooks({
  now: new Date(),  // optional: the clock used to decide which retries are due
  limit: 100,       // optional: max deliveries to drain this pass
})
```

Run it on a schedule. It is wired into the shared jobs runner, so the same cron that drains
background jobs also drains webhooks:

```bash
kernel jobs:run        # drains background jobs + due webhook deliveries
kernel webhooks:run    # drain only webhook deliveries (standalone)
```

A delivery moves through `pending → delivered` on success, or `pending → failed` while it has
attempts left, and lands on `exhausted` once it has used `maxAttempts` without a `2xx`. Every
attempt is [audited](conventions.md) — `webhook.deliver` on success, `webhook.fail` on a failed
attempt — when auditing is on.

## The admin surface

Webhook management is **admin-only**. The summaries are **redacted** — the admin surface never
returns the signing `secret` or your custom `headers`:

```http
GET  /api/_admin/webhooks                                                  # registered webhooks (redacted)
GET  /api/_admin/webhooks/deliveries?webhook=&status=&since=&limit=&page=  # the durable delivery log
POST /api/_admin/webhooks/deliveries/:id/retry                             # requeue a failed/exhausted delivery
```

The same operations are on the Local API (`kernel`):

| Op | Effect |
| -- | ------ |
| `kernel.processWebhooks({ now?, limit? })` | Drain due durable deliveries with retry + backoff. Returns `{ delivered, failed }`. |
| `kernel.listWebhooks()` | List the registered webhooks as **redacted** summaries — never the secret or headers. |
| `kernel.webhookDeliveries({ webhook?, status?, since?, limit?, page? })` | Page the durable delivery log, filtered by webhook, `status`, or `since`. |
| `kernel.retryWebhookDelivery({ deliveryId })` | Requeue a `failed` or `exhausted` delivery for the next drain. |

Every route **requires authentication and admin** up front — an anonymous or non-admin request
is rejected before any webhook data is read.

```bash
# list the durable delivery log for one webhook, exhausted only
curl "http://localhost:3000/api/_admin/webhooks/deliveries?webhook=billing-sync&status=exhausted" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# requeue an exhausted delivery for the next drain
curl -X POST "http://localhost:3000/api/_admin/webhooks/deliveries/$DELIVERY_ID/retry" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

Delivery statuses are `pending`, `delivered`, `failed`, and `exhausted`.

## The guarantees

The webhook surface is held to the same access bar as the rest of the engine — egress is
fenced, secrets stay server-side, and durable delivery makes a promise it keeps.

- **SSRF: default-deny egress.** A webhook `url` must be `http(s)`, and its host may **not** be
  a loopback, private, link-local, or cloud-metadata address — `127.x`, `10.x`,
  `172.16–31.x`, `192.168.x`, `169.254.x` (incl. the metadata endpoint), `localhost`,
  `*.local`, `::1`, and `fc/fd/fe8…`. Such a `url` is **rejected at config load**, before
  anything fires. The only way to target an internal host is to set `allowPrivateNetwork: true`
  on that one webhook — an explicit, per-endpoint opt-in for a trusted internal receiver or
  local dev.
- **Secrets and headers never leave the server.** The signing `secret` and any custom
  `headers` you attach are **never returned** by the admin surface (`listWebhooks` /
  `GET /api/_admin/webhooks` give redacted summaries) and are **never logged**.
- **At-least-once with bounded retries.** Durable delivery retries with exponential backoff
  (capped at 1h) up to `maxAttempts`, then stops at `exhausted` — it never retries forever.
  Because a receiver can see the same event twice, **dedupe on `id` + `event` + `timestamp`**.
- **Inline never breaks the write.** An inline delivery is best-effort on top of a committed
  write — a slow or down receiver never fails the content write (it may drop the event; use
  `durable` when you can't afford that).
- **System-table isolation.** The `_webhook_deliveries` outbox is unreachable via generic CRUD
  (`find`/`create` on it is rejected) — deliveries are only ever touched through the dedicated
  admin/Local-API operations.
- **Admin-only management + audited.** Listing webhooks, reading the delivery log, and retrying
  a delivery require an authenticated **admin**; delivery attempts are recorded in the
  [audit log](conventions.md) as `webhook.deliver` / `webhook.fail` when auditing is on.

Red-teamed to **Risk LOW**. Outbound webhooks pair naturally with the
[real-time change feed](realtime.md) (an in-process / SSE view of the same writes) and the
[draft/publish lifecycle](conventions.md#drafts-publish-and-the-default-read-view).
