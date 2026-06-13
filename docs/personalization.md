# Personalization & A/B experiments

Personalization lets a single field carry **audience variants** — different values for
different segments of your visitors — resolved per request from the same typed model.
It is the audience-keyed twin of localization: where a `localized` field stores one value
per *locale*, a `personalized` field stores one value per *audience segment*. The same
model also powers built-in, deterministic A/B testing, so you don't run a separate
personalization platform alongside your CMS.

Personalization is opt-in and fully access-checked. Nothing changes for a collection until
you configure `audiences` and mark a field `personalized: true`.

## The concept: audience variants

A `personalized` field stores a `{ [segment]: value }` map instead of a single value —
exactly the shape a `localized` field uses for locales. A request carries an audience
(`req.audience`, or `?audience=<segment>` over REST), and the field resolves to that
segment's value, falling back to the **default segment**, then to `null`.

Think of it as content that adapts to *who is asking*: a `headline` that reads one way for
first-time visitors and another for returning customers, served from one document.

## Configure audiences

Personalized fields require an `audiences` config. Declare the segments you support and a
default; the default **must** be one of the segments.

```ts
export default defineConfig({
  audiences: {
    segments: ['default', 'vip', 'returning'],
    default: 'default',
  },
  // …
})
```

## Mark fields personalized

Add `personalized: true` to any field, the same way you'd add `localized: true`:

```ts
{ name: 'headline', type: 'text',     personalized: true },
{ name: 'offer',    type: 'richText', personalized: true },
```

A personalized field stores one value per segment; non-personalized fields are shared
across all audiences.

A field **cannot be both `localized` and `personalized`** — that combination is rejected at
config load. (Compose them at the model level instead: a localized field and a personalized
field side by side, each resolving on its own axis.)

## Reading & writing variants

**Reading.** Pass the audience on the request and read normally:

```ts
// Local API
await kernel.find({ collection: 'posts', req: { audience: 'vip' } })
```

```bash
# REST
curl "http://localhost:3000/api/posts?audience=vip"
```

A personalized field resolves to the requested segment → the default segment → `null`. With
no audience on the request, you get the default segment.

**Writing merges.** Writing with an audience merges that segment's value into the map
**without clobbering the other segments**:

```ts
// Sets only the 'vip' slot; 'default' and 'returning' are untouched.
await kernel.update({
  collection: 'posts',
  id,
  req: { audience: 'vip' },
  data: { headline: 'Welcome back' },
})
```

```bash
curl -X PATCH "http://localhost:3000/api/posts/<id>?audience=vip" \
  -H 'content-type: application/json' \
  -d '{ "headline": "Welcome back" }'
```

To author several variants, write once per audience. Each write touches only its own
segment, so building up a variant map is safe and incremental.

## A/B experiments

Experiments turn personalization into testing. Declare experiments whose `variants` are
configured segments; `weights` (optional) bias the split and `seed` (optional) makes the
bucketing reproducible:

```ts
export default defineConfig({
  audiences: { segments: ['default', 'a', 'b'], default: 'default' },
  experiments: [
    { slug: 'cta', variants: ['a', 'b'], weights: [50, 50], seed: 1 },
  ],
})
```

`kernel.assignVariant` performs **deterministic, sticky bucketing** of a visitor `key` (an
FNV hash, distributed weight-proportionally). The same key always lands in the same
variant — no server-side session state required.

```ts
const { experiment, variant, segment } = kernel.assignVariant({
  experiment: 'cta',
  key: visitorId,
})
// → { experiment: 'cta', variant: 'a', segment: 'a' }
```

**Composing variant → audience.** The assigned `variant` *is* a segment. Set it as the
request audience to serve that variant's content:

```ts
const { variant } = kernel.assignVariant({ experiment: 'cta', key: visitorId })
const doc = await kernel.findByID({
  collection: 'pages',
  id,
  req: { audience: variant },
})
```

Over REST the assignment endpoint is **public** — an assignment isn't secret, and you often
need it client-side before the first content fetch:

```bash
curl -X POST "http://localhost:3000/api/_experiments/cta/assign" -d '{"key":"visitor-123"}'
curl       "http://localhost:3000/api/_experiments/cta/assign?key=visitor-123"
# → { "experiment": "cta", "variant": "a", "segment": "a" }
```

Pair experiments with the [agent layer](agentic-workflows.md) (agents can author the
variants) and the [real-time feed](realtime.md) (track assignments as they happen).

## The guarantees

- **Untrusted audience is validated.** An `audience` value is honored only if it is a
  configured segment; anything else (including a missing or unknown value) resolves to the
  default segment. Untrusted input can never reach an undeclared segment.
- **Prototype-pollution safe.** Segment keys are guarded against `__proto__`,
  `constructor`, and `prototype`, so a crafted audience can't pollute the prototype chain
  of the variant map.
- **Access checks are never bypassed.** Personalized fields go through the normal field
  read-access path. A read-denied personalized field is stripped for **every** audience —
  variant resolution is not a side door around access control.
- **No PII at rest.** Bucketing records only a **hash** of the visitor `key`; the raw key is
  never stored. No visitor identifier persists in the database.
- **Per-segment writes merge.** Writing one segment never overwrites the others, so
  concurrent variant authoring doesn't lose content.

The feature was red-teamed to **Risk LOW**.
