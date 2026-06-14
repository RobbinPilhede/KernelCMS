# Content decisions

A **content decision** is a named delivery slot that, at request time, picks the single best
**published** document for the caller's audience and pins that choice per viewer.
`GET /api/_decide/hero_promo` returns *one* document — the one this caller should see right
now — instead of a list the front-end has to filter and choose from.

Decisions are **stateless**: there is no table, no impression store, no extra schema. A
decision composes three things KernelCMS already does — the access-checked **published read**,
**audience resolution**, and **deterministic bucketing** — into one personalized pick. Because
it reuses the published read path, a decision can **never** surface a draft, a private
document, or a field the caller can't read.

## Configure the decisions

Decisions are opt-in: list them under `config.decisions`. Audiences are only required if a
decision uses `audienceField`.

```ts
import { defineConfig } from '@kernel/core'

export default defineConfig({
  // Required only if a decision uses `audienceField`:
  audiences: { segments: ['default', 'vip'], default: 'default' },

  decisions: [
    {
      slug: 'hero_promo',          // unique, snake_case; addressed at GET /api/_decide/hero_promo
      collection: 'promos',        // a real, non-system collection to pick from
      where: { active: { equals: true } }, // optional candidate filter (config-authored, trusted)
      sort: '-priority',           // optional candidate sort
      audienceField: 'segment',    // optional doc field naming the segment a candidate targets
      fallback: 'default',         // when an audience has no match — see below
    },
  ],

  collections: [/* … */],
})
```

| Field | Required | What it does |
| ----- | -------- | ------------ |
| `slug` | yes | Unique, snake_case. The decision is addressed at `GET /api/_decide/:slug`. |
| `collection` | yes | A real, non-system collection to pick candidates from. |
| `where` | no | A candidate filter. **Config-authored and trusted** — it is not a request input. |
| `sort` | no | Candidate ordering (e.g. `-priority`). Also bounds the pool (top 100). |
| `audienceField` | no | A doc field naming the segment a candidate targets. Requires `audiences`. |
| `fallback` | no | What to do when the audience has no match: `'default'`, `'any'` (the default), or `'none'`. |

## Local API and REST

### Local API

```ts
const decision = await kernel.decide({ slug: 'hero_promo', viewerKey, req })
// → DecisionResult | null
```

`viewerKey` is the sticky identity for this viewer (see [Sticky &
deterministic](#sticky--deterministic)). It is optional — when omitted, the viewer defaults to
the authenticated user id, or `'anonymous'` for an unauthenticated request. `req` is the
request principal; candidate access is enforced against it.

The result is a `DecisionResult`, or `null` when no candidate qualifies:

```ts
{
  slug: string,            // the decision that produced this
  collection: string,      // the collection it picked from
  audience: string,        // the resolved segment (untrusted input collapses to default)
  candidateIds: string[],  // the qualifying pool, in sort order
  chosenId: string,        // the one document this viewer gets
  reason: 'single' | 'audience-match' | 'audience-fallback' | 'rotation',
  document: /* the chosen published document */,
}
```

### REST

```
GET /api/_decide/:slug?audience=<segment>&viewer=<viewerKey>
```

```bash
curl "http://localhost:3000/api/_decide/hero_promo?audience=vip&viewer=visitor-123"
```

Returns **200** with the `DecisionResult`, or **404** when decisions are disabled, the slug is
unknown, or no candidate qualifies (including when the target collection is not publicly
readable). Both query parameters are optional: `audience` resolves like the local API's segment
input, and `viewer` is the sticky `viewerKey`.

Because the response is personalized per viewer, it is sent with
`cache-control: private, no-store` — a decision is never shared-cached.

## How the pick works

1. **Load the pool.** Candidates are read through the normal **access-checked, published-only**
   read path, with the decision's `where` filter and `sort` applied. The pool is bounded to the
   **top 100** candidates by sort.
2. **Narrow by audience.** When the decision has an `audienceField`, the resolved segment
   selects the candidates that target it (`reason: 'audience-match'`). The requested
   `?audience=` (or local `audience`) is **untrusted**: an unknown value — or a
   prototype-pollution attempt like `__proto__` — collapses to the configured default segment.
3. **Fall back when nothing matches.** If the audience narrows the pool to nothing, `fallback`
   decides:
   - `'any'` (the default) — fall back to the **whole** pool (`reason: 'audience-fallback'`).
   - `'default'` — fall back to candidates targeting the **default** segment.
   - `'none'` — no fallback; the decision yields **no result** (`null` / **404**).
4. **Pick one, stickily.** From the resulting pool, exactly one document is chosen
   deterministically (see below). When the pool has a single candidate the result is
   `reason: 'single'`; otherwise the per-viewer pick is `reason: 'rotation'`.

## Sticky & deterministic

The same `viewer` always gets the **same document** for a given decision. The pick is an
**FNV-1a hash** of `slug:viewerKey`, taken modulo the pool size — a pure function of the
viewer and the decision, so it needs no stored state and is stable across requests and
processes.

Only the **hash** of the viewer key is used to index the pool; the raw key is **never stored**
and never logged — there is **no PII**. When no `viewerKey` is supplied, the viewer defaults to
the authenticated user id, or `'anonymous'` for an anonymous request.

## Impression analytics

When analytics `autoCapture` is enabled, each decision records a single `variant_impression`
event — the collection, the chosen document, the decision slug, and the resolved segment. The
event carries **no PII** (no raw viewer key).

## The guarantees

- **Published-only and access-checked.** Candidates load through the normal access-checked,
  published-only read. A decision can **never** surface a draft, a private document, or a field
  the caller can't read. A non-public collection yields no decision (**404**).
- **Sticky and deterministic.** The same viewer always gets the same document for a decision
  (FNV-1a hash of `slug:viewerKey`, modulo the pool). Only the **hash** of the viewer key is
  used — the raw key is never stored, so there is no PII.
- **Audience-safe.** `?audience=` is untrusted input: an unknown or prototype-pollution value
  collapses to the default segment, never a thrown error or a leaked path.
- **Per-viewer, never shared-cached.** The response is personalized, so it is sent with
  `cache-control: private, no-store`.
- **No PII in analytics.** An `autoCapture` impression records collection, document, slug, and
  segment — never the raw viewer key.
- **Bounded.** The candidate pool is capped at the top 100 by sort, so a decision is constant
  work regardless of collection size.

---

Stateless by design: a decision composes the published read, audience resolution, and
deterministic bucketing — no new table, no extra write path. See
[conventions.md](conventions.md#drafts-publish-and-the-default-read-view) for the draft/publish
lifecycle the published read enforces, and the README's **Content decisions** section for the
one-paragraph version.
