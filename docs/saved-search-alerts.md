# Saved-search alerts

A **saved-search alert** (a *content subscription*) is a standing query an editor saves
once — a collection plus an optional `where` — that **notifies them when content matching
it changes**. "Tell me when a `posts` row in my section is updated", "ping me when an
`orders` row over $1000 is created": instead of polling the API or watching a list, you
subscribe once and a cron drain delivers a webhook for every future match.

An alert is *just a standing read*: each candidate change is re-evaluated **as the
subscription's owner** — an access-checked document reload plus a `where` match — before a
notification fires. So an alert can only ever notify on content the owner could already
read with a plain `find`; it can never widen, bypass, or probe past their access. A missing
claim fails **closed**: the alert under-notifies, never over-notifies.

## Opt in

Subscriptions are off until you enable them. They build on the [real-time change
feed](realtime.md) and [outbound webhooks](webhooks.md), so set `subscriptions: true`
alongside `realtime: { enabled: true }` and at least one configured webhook to deliver on:

```ts
export default defineConfig({
  subscriptions: true,             // off by default — the whole feature is opt-in
  realtime: { enabled: true },     // alerts read the change feed; required
  webhooks: [
    // A subscription-only webhook: collections: [] so it NEVER fires on content writes.
    {
      slug: 'alerts',
      url: 'https://hooks.example.com/alerts',
      secret: process.env.ALERTS_SECRET, // HMAC-SHA256 signing key
      collections: [],                   // ← only subscriptions enqueue to it (no double-send)
    },
  ],
  collections: [/* … */],
})
```

Subscriptions require **both** `realtime.enabled` (the change feed is the source of truth
for what changed) and a configured `webhooks` array (the delivery channel) — enabling
`subscriptions` without them is rejected at config load.

> **Give a subscription-only webhook `collections: []`.** A webhook with a non-empty
> `collections` list *also* fires inline on every matching content write. Set
> `collections: []` and that webhook fires for **nothing** on writes — only the
> subscription drain ever enqueues to it. That keeps a subscriber from getting a second,
> unfiltered copy of every change (no double-send), and it is the recommended shape for an
> alerts endpoint.

Enabling subscriptions registers a private `_subscriptions` system table. Like every
system table it is **not** reachable through generic CRUD (`find`/`create` on
`_subscriptions` is rejected) — subscriptions are only ever touched through the dedicated
operations below, which enforce the owner gate.

## Subscribe

All ops are on the Local API (`kernel`):

| Op | Effect |
| -- | ------ |
| `createSubscription({ collection, where?, webhook, req })` | Subscribe to a collection you can read, optionally narrowed by `where`. Owner comes from `req`. Returns the `SubscriptionDoc`. |
| `listSubscriptions({ collection?, req })` | List **your own** subscriptions, optionally scoped to one `collection`. |
| `deleteSubscription({ subscriptionId, req })` | Delete a subscription. Owner or admin only. Returns `{ id }`. |
| `processSubscriptions({ limit? })` | The cron drain — read the change feed, re-match as each owner, enqueue deliveries. Returns `{ scanned, delivered }`. |

### Creating a subscription

```ts
const sub = await kernel.createSubscription({
  collection: 'posts',
  where: { section: { equals: 'sports' } }, // optional: narrows what counts as a match
  webhook: 'alerts',                        // a configured webhook slug
  req,                                       // the principal owns the subscription
})
// sub.ownerId === req.user.id   (a forged ownerId in the call is ignored)
// sub.lastSeq is set to the current feed cursor — alerts fire on FUTURE changes only
```

The `webhook` is a **configured webhook slug** (it must exist in `webhooks`), and the
caller must be able to **read** `collection`. `where`, when present, is **validated against
the collection** — every field referenced must be a real, queryable field, so a
subscription can never smuggle in an unknown column or a malformed filter. The recorded
`lastSeq` cursor is the feed's current position, so a subscription alerts only on **changes
after it was created** — there is no backfill of existing content.

### Listing and deleting

```ts
const mine = await kernel.listSubscriptions({ collection: 'posts', req }) // your subs on `posts`
const all = await kernel.listSubscriptions({ req })                       // every subscription you own
await kernel.deleteSubscription({ subscriptionId: sub.id, req })          // delete -> { id }
```

`listSubscriptions` returns **only the caller's own** subscriptions — the surface never
lists another principal's standing queries. Delete is **owner-or-admin only**: an editor
can't remove someone else's subscription.

### The REST surface

```http
GET    /api/_admin/subscriptions?collection=                  # list your own (auth required)
POST   /api/_admin/subscriptions  { collection, where?, webhook }  # subscribe (201)
DELETE /api/_admin/subscriptions/:id                          # delete (owner/admin)
```

Every subscription route **requires authentication** up front — an anonymous request is
rejected with `401` before any subscription data is read. The owner is always the
server-resolved principal; the client body never names the owner.

```bash
# subscribe as the authenticated user (owner comes from the token, not the body)
curl -X POST "http://localhost:3000/api/_admin/subscriptions" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"collection":"posts","where":{"section":{"equals":"sports"}},"webhook":"alerts"}'

# list your subscriptions on one collection
curl "http://localhost:3000/api/_admin/subscriptions?collection=posts" \
  -H "Authorization: Bearer $TOKEN"

# unsubscribe
curl -X DELETE "http://localhost:3000/api/_admin/subscriptions/$SUBSCRIPTION_ID" \
  -H "Authorization: Bearer $TOKEN"
```

## How delivery works

Nothing fires inline. Alerts are delivered by a **cron drain** that reads the [change
feed](realtime.md#the-pull-feed-cursor-polling) and re-matches each candidate change
against every subscription:

```ts
const { scanned, delivered } = await kernel.processSubscriptions({
  limit: 100, // optional: max change rows to scan this pass
})
```

For each pass the drain, per subscription:

1. **Reads the change feed since the subscription's cursor.** It pulls changes with
   `seq > lastSeq` for the subscribed collection — so it only ever considers **future**
   changes, never a backfill.
2. **Re-evaluates each change as the owner.** For a candidate change it performs an
   **access-checked document reload as the subscription's owner** (the same read path a
   plain `kernel.findByID` takes for that principal) and then tests the subscription's
   `where` against the reloaded document. A change passes only if the owner can **read** the
   document *and* it matches the `where`.
3. **Enqueues a webhook delivery for each match.** A match enqueues a delivery to the
   subscription's configured webhook, reusing the **durable [outbox](webhooks.md#the-cron-drain)**
   (retry + exponential backoff) — so a briefly-down receiver never drops the alert.
4. **Advances the cursor.** The subscription's `lastSeq` moves forward, so the next pass
   starts after the last change it scanned (no re-delivery).

Run the drain on a schedule. It is wired into the shared jobs runner, so the same cron that
drains background jobs and webhooks also drains subscriptions:

```bash
kernel jobs:run            # drains background jobs + webhooks + due subscriptions
kernel subscriptions:run   # drain only subscriptions (standalone)
```

## What gets delivered

A match enqueues a normal [webhook delivery](webhooks.md#the-payload) — a signed `POST`
with the matched document in the body, delivered through the durable outbox with
at-least-once retry. Because the document was reloaded through the **owner's normal read
path**, the payload is **field-access-stripped and encrypted-field-redacted** exactly like
any other read for that owner:

- A field the owner can't **read** is stripped from the payload — an alert never leaks a
  field through the notification that the owner couldn't see on a plain read.
- An [encrypted field](field-encryption.md) is **redacted** from the payload, never shipped
  as ciphertext or plaintext.

**Deletes don't fire.** An alert is a *positive* "content matching X now exists / changed"
signal, evaluated against a **live document**. A `delete` removes the row, so there is
nothing to reload and re-match — a deleted document never produces an alert. (This is also
why an alert can't leak the existence of a row the owner couldn't read: there's no live
document to match.)

## The guarantees

A saved-search alert is held to the **same access bar as a read** — there is no looser path
through a subscription than through the collection it watches.

- **Re-matched as the owner, access-scoped.** Every candidate change is re-evaluated
  through an **access-checked document reload as the subscription's owner**, then matched
  against `where`. An alert can only ever fire for content the owner could already
  **read** — it can never leak a document (or a field) the owner can't see.
- **Fails closed — under-notifies, never over-notifies.** When the owner's access can't be
  confirmed (a missing claim, a row-scoped rule that can't be re-checked), the change is
  **dropped**, not delivered. The match errs toward silence, never toward a leak.
- **Owner from the principal, never the client.** The recorded `ownerId` comes from the
  authenticated principal. A forged `ownerId` in the call is ignored, and
  `listSubscriptions` only ever returns the caller's own subscriptions.
- **Future-only, no backfill.** The `lastSeq` cursor is set to the feed's current position
  at create time, so a subscription alerts only on changes **after** it was created — it
  can't be used to replay history.
- **Owner-or-admin to delete.** Removing a subscription is limited to its owner or an admin
  — an editor can't delete someone else's standing query.
- **Field-stripped + encrypted-redacted payload.** The delivered document is reloaded
  through the owner's normal read path, so read-denied fields are stripped and encrypted
  fields are redacted from the webhook payload, exactly as on a live read.
- **System-table isolation.** `_subscriptions` is unreachable via generic CRUD (`find`/
  `create` on it is rejected) — subscriptions are only ever touched through the dedicated
  operations.
- **Audited.** Subscription create/delete are recorded in the [audit log](conventions.md)
  as `subscription.create` / `subscription.delete` when auditing is on.

Red-teamed to **Risk LOW**. Saved-search alerts pair naturally with the
[real-time change feed](realtime.md) (the change source they drain), [outbound
webhooks](webhooks.md) (the delivery channel — give the alert webhook `collections: []`),
and [saved views](saved-views.md) (the same standing-query primitive, for in-admin list
presets instead of notifications).
