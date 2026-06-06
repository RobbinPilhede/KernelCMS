# Integrations & Third-Party Services

KernelCMS is the system of record for content, not the system of record for search indices, payments, product analytics, or generated copy. Those concerns live in specialized services, and the job of the CMS is to push the right data to them at the right moment and pull results back into the admin and the public APIs. KernelCMS handles this through the same adapter pattern that powers database, storage, and email — every integration is a typed package you install, configure in `kernel.config.ts`, and wire into the operation lifecycle via hooks. Nothing is hard-wired, and every integration respects the same access control, drafts/publish, and localization semantics as core content. This document specifies how the search, payments, analytics, AI, DAM, and email integrations are designed and how they differ from Payload's plugin model, Strapi's marketplace, and Sanity's GROQ-plus-webhooks approach.

## Integration model

Integrations attach to the operation core, not to HTTP. Because the Local API, REST, GraphQL, and typed RPC all funnel through the same `create`, `update`, `delete`, and `find` operations (see [Local API & RPC](../05-api/03-typed-rpc-and-local-api.md)), an integration that hooks `afterChange` fires identically whether a document was saved from the admin panel, a server function, or a `curl` against REST. This is the structural difference from Strapi, where lifecycle hooks bind to the database layer and miss operations that bypass the entity service, and from Sanity, where the only reliable extension point is an external webhook reacting to a mutation after the fact.

```
Operation core ── afterChange ──┬──▶ Search adapter   (index document)
                                ├──▶ Analytics sink   (emit event)
                                └──▶ Plugin hooks     (your code)

REST / GraphQL / RPC ──▶ same operations ──▶ same hooks
```

Every integration package exposes a factory that returns a plugin conforming to the `@kernel/plugin-sdk` contract. Plugins can register hooks, add fields, mount admin routes, and declare config-level options with full inference. Secrets are never inlined; they are read from the environment and validated at boot.

## Search: Algolia and Typesense

Database `where` queries are fine for filtering a list view, but they are not a search engine. For typo tolerance, relevance ranking, faceting, and sub-50ms full-text queries you index into Algolia or Typesense. KernelCMS ships `@kernel/search` as the adapter contract and two first-party backends; the contract is identical to how `@kernel/db` abstracts Postgres, SQLite, MySQL, and MongoDB.

```ts
// kernel.config.ts
import { defineConfig } from '@kernel/core'
import { typesenseSearch } from '@kernel/search/typesense'

export default defineConfig({
  plugins: [
    typesenseSearch({
      nodes: [{ host: process.env.TYPESENSE_HOST!, port: 443, protocol: 'https' }],
      apiKey: process.env.TYPESENSE_ADMIN_KEY!,
      collections: {
        posts: {
          // Fields projected into the index; everything else stays in the CMS.
          fields: ['title', 'excerpt', 'tags', 'author.name'],
          facetBy: ['tags', 'author.name'],
          // Only published, non-draft docs reach the index.
          filter: ({ doc }) => doc._status === 'published',
        },
      },
    }),
  ],
})
```

The adapter subscribes to `afterChange` and `afterDelete`. On publish it upserts a projected record; on unpublish or delete it removes it. The projection is deliberate — you index a thin, denormalized record (resolved relationships flattened, `richText` reduced to plain text) rather than the whole document. This keeps index size and reindex cost bounded.

| Concern        | Algolia                 | Typesense                    |
| -------------- | ----------------------- | ---------------------------- |
| Hosting        | SaaS only               | Self-host or Typesense Cloud |
| Typo tolerance | Excellent               | Excellent                    |
| Cost model     | Per-operation + records | Flat (self-host)             |
| Best when      | You want zero ops       | You want to own infra        |

A full reindex is a CLI operation, `kernel search reindex posts`, which streams every published document through the same projection in batches and is safe to run against a live index using an alias swap. Search-as-you-type in the admin and on the frontend uses the search-only API key minted per request, never the admin key. Payload offers a search plugin but leaves relevance and projection entirely to you; KernelCMS bakes the publish-state filter and projection into the contract so you cannot accidentally index a draft.

### Querying from the frontend

```ts
import { createSearchClient } from '@kernel/client/search'

const results = await searchClient.posts.query({
  q: 'tanstack router',
  facetFilters: [['tags:guide']],
  page: 1,
})
```

The client uses TanStack Query for caching and request deduplication, so a search box bound to a debounced input reuses in-flight requests automatically.

## Payments: Stripe

Payments are not a CMS feature, but a CMS frequently models the catalog — products, prices, plans, paywalled articles — and needs to stay in sync with Stripe in both directions. `@kernel/plugin-stripe` covers two flows: outbound sync (a `products` collection mirrors to Stripe Products/Prices) and inbound webhooks (Stripe events mutate documents).

```ts
import { stripe } from '@kernel/plugin-stripe'

export default defineConfig({
  plugins: [
    stripe({
      secretKey: process.env.STRIPE_SECRET_KEY!,
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
      sync: [
        {
          collection: 'products',
          stripe: 'products',
          // Map CMS fields to Stripe object fields.
          map: ({ doc }) => ({ name: doc.title, active: doc._status === 'published' }),
        },
      ],
      // Inbound events update CMS state.
      events: {
        'customer.subscription.updated': async ({ event, payload }) => {
          const sub = event.data.object
          await payload.update({
            collection: 'subscriptions',
            where: { stripeId: { equals: sub.id } },
            data: { status: sub.status, currentPeriodEnd: sub.current_period_end },
          })
        },
      },
    }),
  ],
})
```

The webhook handler is mounted as a TanStack Start server route and does three things before touching any document: verifies the signature with the webhook secret, checks the event ID against a processed-events table for idempotency, and acknowledges within the timeout to avoid Stripe retries. Signature verification and idempotency are not optional — they are enforced by the adapter, so a misconfigured project fails closed. Stripe API keys live only on the server; the admin panel never receives the secret key, and client-side checkout uses publishable keys handled by your frontend, outside the CMS. See Webhooks & Events for the shared idempotency and retry machinery.

## Analytics

Analytics splits into two questions: who is using the public site, and what is happening inside the CMS. KernelCMS treats them separately.

For the public site, the CMS does not inject tracking scripts — that is the frontend's job. What it does provide is a typed event sink so editorial and commerce events (a paywalled article unlocked, a product published) can be forwarded to a warehouse or product-analytics tool.

```ts
import { analytics } from '@kernel/plugin-analytics'
import { segment } from '@kernel/plugin-analytics/segment'

export default defineConfig({
  plugins: [
    analytics({
      sink: segment({ writeKey: process.env.SEGMENT_WRITE_KEY! }),
      emit: {
        'posts.afterChange': ({ doc, operation }) =>
          doc._status === 'published'
            ? { event: 'Article Published', properties: { id: doc.id, tags: doc.tags } }
            : null, // returning null suppresses the event
      },
    }),
  ],
})
```

Events are buffered and flushed asynchronously so analytics never sits on the request path or fails a write. The sink is an adapter, so Segment, PostHog, or a raw warehouse stream are interchangeable. Admin-side product analytics — which editors are slow on which screens — is opt-in, anonymized, and routed through the same sink with a distinct namespace; it is off by default because the admin handles unpublished content and we do not leak document bodies into a third party.

## AI providers

AI shows up in three places: generating or rewriting field content, embedding documents for semantic search, and structured extraction (alt text, tags, summaries). `@kernel/plugin-ai` wires these to a provider adapter (OpenAI, Anthropic, or a self-hosted model behind an OpenAI-compatible endpoint) and exposes them as field-level actions in the TanStack Form-based editor.

```ts
import { ai } from '@kernel/plugin-ai'
import { anthropic } from '@kernel/plugin-ai/anthropic'

export default defineConfig({
  plugins: [
    ai({
      provider: anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! }),
      actions: {
        // Adds a "Generate" button to the excerpt field in the admin.
        summarize: {
          field: 'excerpt',
          prompt: ({ doc }) => `Summarize this article in 30 words:\n\n${doc.body}`,
        },
      },
      // Auto-embed on publish for semantic search.
      embeddings: { collections: ['posts'], target: 'pgvector' },
    }),
  ],
})
```

Two design rules are non-negotiable. First, the AI provider key never reaches the browser; generation runs through a server function and the admin only sees the result. Second, AI output is a suggestion, never a silent write — the generated value populates the field for human review and is subject to the same validation and access control as a hand-typed value. Embeddings write to a `pgvector` column (Postgres) or the Typesense vector index, enabling hybrid keyword-plus-semantic search on top of the search adapter above. Neither Payload nor Strapi ships a unified provider-agnostic AI surface; bolt-on plugins exist but they bypass the form layer and the access model, which is exactly what we refuse to do.

## DAM and email

### Digital asset management

The built-in media library (see Storage & Uploads) covers most projects, but enterprises with an existing DAM — Cloudinary, Bynder, or a custom asset service — need uploads to resolve to that system rather than `@kernel/storage`. The `upload` field accepts an external DAM source: the admin browses the DAM via its API, the selected asset's stable URL and metadata are stored on the document, and the binary never transits the CMS. Cloudinary additionally plugs into the storage adapter so transformations (`f_auto,q_auto`, named transformations) are appended at render time, and `richText` image embeds resolve through the same pipeline.

```ts
import { cloudinary } from '@kernel/storage/cloudinary'

export default defineConfig({
  storage: cloudinary({
    cloudName: process.env.CLOUDINARY_CLOUD!,
    apiKey: process.env.CLOUDINARY_KEY!,
    apiSecret: process.env.CLOUDINARY_SECRET!,
    transformDefault: 'f_auto,q_auto',
  }),
})
```

### Email

Transactional email — invite a user, send a password reset, notify an editor that a draft needs review — runs through `@kernel/auth` and workflow hooks, both of which delegate to the email adapter. The adapter contract is provider-agnostic across Resend, Postmark, SendGrid, AWS SES, or SMTP, and templates are React components rendered server-side so they stay type-checked against their props.

```ts
import { resend } from '@kernel/email/resend'

export default defineConfig({
  email: resend({
    apiKey: process.env.RESEND_API_KEY!,
    from: 'KernelCMS <no-reply@example.com>',
  }),
})
```

| Provider | Adapter                  | Notes                                   |
| -------- | ------------------------ | --------------------------------------- |
| Resend   | `@kernel/email/resend`   | React templates, simplest setup         |
| Postmark | `@kernel/email/postmark` | Strong deliverability, separate streams |
| AWS SES  | `@kernel/email/ses`      | Cheapest at volume, more setup          |
| SMTP     | `@kernel/email/smtp`     | Self-host / on-prem relays              |

Because email is an adapter rather than a hard dependency, KernelCMS Cloud can swap in a managed sending domain with no config change in your repo, mirroring how the database and storage adapters stay portable between self-host and Cloud.

## Open questions

- **Sync conflict resolution for Stripe.** When a product is edited in both the Stripe dashboard and the CMS between webhook deliveries, last-write-wins is the current default. Whether to expose a per-collection conflict strategy (CMS-authoritative vs. Stripe-authoritative) is undecided.
- **Embedding reindex triggers.** Re-embedding on every `afterChange` is wasteful when only non-body fields change. We are evaluating a content-hash gate so embeddings regenerate only when the embedded source fields actually differ.
- **DAM write-back.** Whether the admin should be able to upload new assets into an external DAM (Bynder, Cloudinary) or remain read/select-only against it is still open and likely DAM-specific.
