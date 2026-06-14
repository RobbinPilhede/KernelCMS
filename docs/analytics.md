# Content analytics & insights

KernelCMS can record a content event for every meaningful interaction — a page
view, a search, an AI retrieval, a conversion — and roll those events up into
aggregate insights. You see how your content performs and, uniquely, **how AI
answer engines retrieve it**, from the same model that already serves your content.

It is **privacy-first and opt-in**. The feature is off until you enable it, there is
**no third-party analytics**, and — the headline — the event row has **no user, IP,
visitor, email, or token column** at all. KernelCMS stores content and event
metadata, never the person.

## Why it lives in the CMS

Most analytics answers "who visited what". KernelCMS answers a different, content-shaped
question: which documents matter, which search terms find them, which variant converts,
and — increasingly the one that decides traffic — **which content your RAG and answer
engines actually retrieve to ground their answers**. Because semantic, hybrid, and graph
search all run through the same access-checked engine, the AI-retrieval signal is right
there to capture. No second pipeline, no log shipper, no PII warehouse.

## Enable it

Opt in on your config. `retain` bounds the event table; `autoCapture` turns on the
zero-touch AI-retrieval and experiment signals (off by default):

```ts
export default defineConfig({
  analytics: {
    enabled: true,        // default false — the whole feature is opt-in
    retain: 100000,       // max event rows kept (default ~100k, clamped)
    autoCapture: false,   // default false — see "Auto-capture" below
  },
  collections: [/* … */],
})
```

`retain` caps the `_analytics` table: once it is full, the oldest rows drop (a clamped
maximum applies, so the table is never unbounded). Nothing is written until `enabled` is
true.

## Capturing an event

`kernel.track(...)` records one content event. Every field but `type` is optional —
attach only the dimensions that make sense for the event:

```ts
await kernel.track({
  type: 'view',            // required — see the event types below
  collection: 'posts',     // optional — which collection the event is about
  documentId: 'p_07',      // optional — which document
  query: 'how do I deploy', // optional — the search/retrieval terms
  experiment: 'cta',       // optional — experiment slug
  variant: 'b',            // optional — assigned variant
  value: 1,                // optional — numeric value (e.g. a conversion amount)
  meta: { source: 'blog' },// optional — extra scalar, non-PII dimensions
})
```

### Event types

`type` is one of:

- `view` — a document was viewed.
- `search` — a full-text search was run (`query` carries the terms).
- `ai_retrieval` — a document was returned by semantic/hybrid/graph search to ground an
  AI answer. This is the "how AI uses your content" signal.
- `citation` — your content was cited by an answer engine.
- `variant_impression` — an experiment variant was shown.
- `conversion` — a goal was reached (pair with `experiment`/`variant` to measure lift).
- `custom` — anything else; describe it with `meta`.

### `track` never throws

Tracking is **resilient by design**: a failure to record an event is logged and
swallowed — it never throws into your handler. Analytics can never take down a content
request. Over HTTP the same op is:

```bash
curl -X POST http://localhost:3000/api/_analytics/track \
  -H 'Content-Type: application/json' \
  -d '{"type":"view","collection":"posts","documentId":"p_07"}'
```

The REST endpoint **requires auth** unless the server is configured with `publicTrack`
(for capturing anonymous front-end views). The Local API `track` runs wherever your
server code does.

## Auto-capture — the AI-retrieval signal

Set `autoCapture: true` and KernelCMS records the two events you'd otherwise have to
wire by hand, with **zero added latency** (fire-and-forget) and a complete **no-op when
off**:

- **AI retrieval.** `semanticSearch`, `hybridSearch`, and `graphSearch` emit one
  `ai_retrieval` event per returned document — and only for the **access-checked**
  documents the caller actually received — with the search terms as `query`. This is the
  signal that tells you which content your RAG and answer engines retrieve most.
- **Variant impressions.** `assignVariant` emits a `variant_impression` for the
  experiment and bucketed variant.

Because retrieval already runs through the access-checked read path, a document the
caller couldn't read is never returned and therefore never tracked. Auto-capture adds
nothing to the request's latency budget and writes nothing at all while disabled.

## Insights — aggregate queries

`kernel.insights(...)` rolls the event table up into one of five metrics. Insights are
**aggregates only** — counts and rates, never a replay of individual events:

```ts
const result = await kernel.insights({
  metric: 'ai_retrieval_leaderboard', // which roll-up (see below)
  collection: 'posts',  // optional — scope to one collection
  type: 'view',         // optional — scope to one event type (where it applies)
  from: '2026-06-01',   // optional — ISO lower bound
  to: '2026-06-14',     // optional — ISO upper bound
  limit: 20,            // optional — result size (clamped)
})
```

The metrics:

- **`top_content`** — documents ranked by event count. Your most-engaged content.
- **`top_queries`** — the most frequent `search` / `ai_retrieval` terms. What people
  (and machines) are looking for.
- **`variant_performance`** — impressions, conversions, and conversion rate per
  experiment/variant. The lift table for your A/B tests.
- **`activity`** — event counts over time and broken down per type. The pulse of all
  content activity.
- **`ai_retrieval_leaderboard`** — the content AI retrieves most to answer questions.
  The signal you can't get from page-view analytics.

Over HTTP:

```bash
curl "http://localhost:3000/api/_admin/insights?metric=top_content&collection=posts&from=2026-06-01&to=2026-06-14&limit=20"
```

The insights route is **admin/editor-gated** — there is no public insights endpoint.

## Privacy, access & safety

The guarantees, all enforced by the engine:

1. **No PII, ever.** There is **no user, IP, visitor, email, or token column** on the
   event row — the schema simply has nowhere to put a person. The authenticated
   principal who called `track` is **never recorded**. `track` strips PII-ish keys and
   prototype-pollution keys (`__proto__` / `constructor` / `prototype`) from `meta`,
   keeping only scalar, non-PII dimensions. You measure content, not people.
2. **Write-confined.** `track` can only ever write the `_analytics` table — never
   another collection. The `collection` field is **inert data** describing the event,
   not a write target, so a crafted `track` call can't be turned into a write into
   `posts` (or anything else).
3. **Aggregate-only insights.** `insights` returns counts and rates, not raw rows.
   There is no event-replay surface.
4. **Access-bounded.** Insights are filtered to the collections the caller can read — a
   hidden collection's counts never leak into a roll-up. The route is admin/editor-gated
   on top.
5. **Bounded.** Retention (`retain`), the insights scan, and the result `limit` are all
   clamped, so neither the table nor a query can grow unbounded.

Red-teamed to **Risk LOW** (zero findings). Analytics is a view into the same
access-checked engine — never a side channel around it, and never a PII store.

## Where it fits

- **[Semantic & hybrid search](semantic-search.md)** and the
  **[knowledge graph](knowledge-graph.md)** — auto-capture turns every retrieval into an
  `ai_retrieval` signal, so the `ai_retrieval_leaderboard` shows what your RAG actually
  uses.
- **[Personalization & A/B](personalization.md)** — `assignVariant` auto-captures
  impressions; `track` a `conversion` and `variant_performance` gives you the lift.
- **[AI discoverability](ai-discoverability.md)** — pair the `citation` event with
  llms.txt/GEO to close the loop from "AI ingested it" to "AI retrieved and cited it".
