# Billing, Metering & Plans

KernelCMS Cloud is the managed counterpart to self-hosted KernelCMS. This document specifies how the Cloud monetizes the platform: the plan tiers and what each unlocks, the metering pipeline that turns raw platform events into billable usage, the Stripe integration that handles subscriptions and invoicing, and the overage and limit-enforcement model. The design goal is that billing is a thin, swappable layer on top of the same `@kernel/cloud` control plane — never wired into `@kernel/core`, so self-hosters never pay a tax of code they don't run. Unlike Sanity, where metering and quotas are baked into the only product you can buy, KernelCMS Cloud is one deployment target among many, and the billing surface is intentionally isolated.

## Plan Tiers

Four tiers, plus a per-seat enterprise track negotiated off the price book. Tiers gate three things: included quota, hard caps, and feature flags. A tier is a row in the `plans` table on the control plane, not a hardcoded enum, so we can ship grandfathered plans and run pricing experiments without a deploy.

| Plan           | Price (USD/mo) | Projects  | Included docs | API requests/mo | Storage | Seats  | Environments      |
| -------------- | -------------- | --------- | ------------- | --------------- | ------- | ------ | ----------------- |
| **Hobby**      | $0             | 1         | 5,000         | 100k            | 1 GB    | 2      | 1 (prod)          |
| **Pro**        | $39            | 5         | 100,000       | 2M              | 25 GB   | 10     | 3 (prod + 2)      |
| **Team**       | $199           | 20        | 1,000,000     | 25M             | 250 GB  | 50     | 10                |
| **Enterprise** | Custom         | Unlimited | Custom        | Custom          | Custom  | Custom | Custom + SSO/SAML |

Feature gates (live preview collaboration, audit-log retention, custom domains on the content CDN, point-in-time backups, SAML/SCIM) are encoded as a `features` bitmask plus a `limits` JSON column. This keeps Payload's "Enterprise license unlocks a build flag" model off the table — gating happens server-side in the Cloud control plane, evaluated per-request, so there's nothing to crack in a client bundle.

```ts
// @kernel/cloud — plan definition (seeded into the control-plane DB)
import type { PlanDefinition } from '@kernel/cloud'

export const proPlan = {
  id: 'pro',
  displayName: 'Pro',
  stripePriceId: 'price_1QxProMonthly',
  limits: {
    projects: 5,
    documents: 100_000,
    apiRequests: 2_000_000,
    storageBytes: 25 * 1024 ** 3,
    seats: 10,
    environments: 3,
  },
  overage: {
    apiRequests: { per: 1_000_000, priceCents: 1000 },
    storageBytes: { per: 1024 ** 3, priceCents: 25 },
    documents: { per: 10_000, priceCents: 500 },
  },
  features: ['live-preview', 'custom-domain', 'audit-log-90d'],
} satisfies PlanDefinition
```

A project's plan is resolved once per request in Cloud middleware and cached in `@kernel/cloud`'s tenant context via TanStack Store, so field-level access checks and metering both read the same snapshot. Note that none of this lives in `kernel.config.ts` — your content config is identical whether you self-host or run on Cloud. That portability is the whole pitch: see Self-Hosting vs. Cloud.

## Usage Metering

Metering is event-sourced. Every billable action emits a typed `MeterEvent` onto an append-only stream; an aggregator rolls events into per-project, per-period counters that both the dashboard and Stripe read from. We never bill off live database row counts — those drift, can't be audited, and don't survive a restore.

```ts
// @kernel/cloud — the meter contract
export type MeterDimension =
  | 'api.request'
  | 'storage.bytes'
  | 'document.count'
  | 'bandwidth.egress'
  | 'function.invocation'

export interface MeterEvent {
  readonly projectId: string
  readonly dimension: MeterDimension
  readonly quantity: number // delta, signed for storage/doc count
  readonly at: number // epoch ms, server-assigned
  readonly idempotencyKey: string // dedupes retried emissions
}
```

The four meterable dimensions and where they're captured:

- **`api.request`** — counted in the REST/GraphQL/RPC entry middleware (`@kernel/server`), one event per resolved operation. Admin-panel traffic and webhook deliveries are tagged but excluded from the billable count so dashboards don't punish editors.
- **`storage.bytes`** — emitted by the `@kernel/storage` adapter on upload (positive delta) and delete (negative). The aggregator keeps a running gauge; we bill the time-weighted average GB across the period, not the peak.
- **`document.count`** — emitted by the operation core on create/delete across all collections. Drafts and published versions count once; version-history snapshots do not.
- **`bandwidth.egress`** — pulled from the content CDN's edge logs hourly, reconciled against `api.request` to attribute egress to a project.

```
 ┌────────────┐   MeterEvent   ┌──────────────┐  hourly roll-up  ┌───────────────┐
 │ @kernel/   │──────────────▶│  meter stream │────────────────▶│ usage_period  │
 │ server     │  idempotent    │ (append-only) │   aggregator     │ counters      │
 │ storage    │                └──────────────┘                  └──────┬────────┘
 │ cdn logs   │                                                         │
 └────────────┘                                            ┌────────────▼─────────────┐
                                                           │ dashboard (TanStack Query)│
                                                           │ Stripe usage records      │
                                                           └───────────────────────────┘
```

The aggregator runs on the configured queue adapter (the same swappable `@kernel/cloud` queue used elsewhere). Idempotency keys make emission at-least-once safe: a retried request with the same key is dropped at the stream boundary. Counters are exposed read-only through the RPC API so the admin panel's billing page fetches them with TanStack Query and a 60-second `staleTime` — usage doesn't need to be real-time, and we avoid hammering the aggregator.

```ts
// admin billing page — current-period usage
const { data: usage } = useQuery({
  queryKey: ['cloud', 'usage', projectId, period],
  queryFn: () => cloud.usage.current({ projectId }),
  staleTime: 60_000,
})
// usage.apiRequests.used / usage.apiRequests.included → progress bar
```

This is closer to Strapi Cloud's metered model than Sanity's, but with one difference that matters: because the events are typed and self-describing, a self-hoster can flip on the same metering pipeline locally for capacity planning without paying us a cent. The meter is open-source; only the billing reconciliation in `@kernel/cloud` is Cloud-only.

## Stripe Integration

Stripe is the system of record for money. The control plane is the system of record for entitlement. We sync deliberately and treat Stripe webhooks as the authority on subscription state — never the client.

Each Cloud organization maps to one Stripe `Customer`. Each subscription maps to a `Subscription` with a base recurring price (the plan) plus metered `SubscriptionItem`s for each overage dimension. Overage is reported via Stripe's usage-records API at period close, computed from our own counters — we do not let Stripe meter, because our aggregator already holds the auditable truth.

```ts
// @kernel/cloud — report overage at period close
export async function reportOverage(sub: CloudSubscription, usage: PeriodUsage) {
  const items = computeOverageItems(sub.plan, usage) // [{ stripeItemId, quantity }]
  await Promise.all(
    items.map((item) =>
      stripe.subscriptionItems.createUsageRecord(
        item.stripeItemId,
        { quantity: item.quantity, timestamp: usage.periodEnd, action: 'set' },
        { idempotencyKey: `${sub.id}:${usage.periodEnd}:${item.stripeItemId}` },
      ),
    ),
  )
}
```

Webhook handling is the load-bearing part. Every webhook is verified against the signing secret, persisted before processing, and handled idempotently keyed on Stripe's event ID:

| Stripe event                    | Control-plane action                                |
| ------------------------------- | --------------------------------------------------- |
| `checkout.session.completed`    | Activate subscription, attach plan, unlock features |
| `customer.subscription.updated` | Re-resolve plan limits, apply proration             |
| `invoice.payment_succeeded`     | Mark period paid, reset soft-limit grace            |
| `invoice.payment_failed`        | Enter dunning, schedule retry, flag org             |
| `customer.subscription.deleted` | Downgrade to Hobby at period end, enforce caps      |

The signing secret, API key, and price IDs come from environment-injected secrets in the Cloud runtime — never `kernel.config.ts`, never a client bundle. See Secrets & Configuration for the injection model. Plan changes flow Cloud → Stripe for the subscription mutation, then the resulting webhook flows Stripe → Cloud as the confirmation that flips entitlement. We never grant entitlement optimistically on the checkout redirect; a user who closes the tab mid-payment must not end up on Pro.

Dunning (failed payment recovery) runs on Stripe's smart-retry schedule. On `invoice.payment_failed`, the org keeps full access through a 7-day grace window with an in-admin banner; after grace with no recovery, the project drops to read-only (content stays served, writes are blocked) rather than going dark. Sanity and Payload Cloud both hard-suspend on non-payment; the read-only fallback is a deliberately gentler default that protects the user's live site.

## Overages and Limits

Every limit has a defined behavior: **hard cap** (request refused), **soft cap** (allowed, metered, billed as overage), or **block** (write refused, reads continue). Mixing these per-dimension is what keeps the platform usable without surprise five-figure invoices.

| Dimension        | Behavior | At limit                                                           |
| ---------------- | -------- | ------------------------------------------------------------------ |
| `api.request`    | Soft cap | Billed per overage block; throttled only at 150%                   |
| `storage.bytes`  | Soft cap | Billed per GB-month over included                                  |
| `document.count` | Block    | New writes refused (`429 quota_exceeded`); reads + deletes allowed |
| `seats`          | Hard cap | Invite refused until seat freed or plan upgraded                   |
| `projects`       | Hard cap | Project creation refused                                           |

Enforcement is evaluated in Cloud middleware against the cached usage snapshot, so it costs nothing in the hot path:

```ts
// @kernel/cloud — limit check in the request pipeline
export function enforceLimit(ctx: CloudContext, dim: MeterDimension): LimitResult {
  const { used, included, behavior } = ctx.usage[dim]
  if (used < included) return { ok: true }
  switch (behavior) {
    case 'hard':
      return { ok: false, status: 403, code: 'limit_reached' }
    case 'block':
      return { ok: false, status: 429, code: 'quota_exceeded' }
    case 'soft':
      return { ok: true, overage: used - included } // continue, accrue
  }
}
```

To prevent runaway bills, every soft-capped dimension also has a per-org **overage ceiling** — a maximum monthly overage in dollars that the org owner sets. Hit the ceiling and the dimension converts from soft to block until the next period or a manual ceiling raise. This is the safety valve Sanity lacks: there's no way on their platform to say "bill me up to $200 of overage, then stop, don't take down my site silently."

Org owners get usage alerts at 80% and 100% of each included quota and at 50%/90% of the overage ceiling, delivered through the configured `@kernel/cloud` email adapter and surfaced in the admin command palette. Plan changes prorate through Stripe automatically; downgrades that would put the org over a hard cap (e.g., 8 projects on a downgrade to Pro's 5) are blocked at the API with a clear remediation list rather than silently orphaning data.

## Open questions

- **Annual billing & commitments** — discount percentage and whether annual plans get a separate overage rate are not yet decided.
- **Bandwidth pricing** — currently included up to a soft cap, but whether to break egress into its own billable line or fold it into the API-request meter is undecided pending real CDN cost data.
- **Per-seat vs. flat on Team** — Team is flat-rate with a seat cap; whether to offer a per-seat variant for orgs above 50 before they hit Enterprise is open.
- **Usage-based-only plan** — a pure pay-as-you-go tier with no base subscription (Hobby + overages) has been requested; it complicates dunning and is parked.
