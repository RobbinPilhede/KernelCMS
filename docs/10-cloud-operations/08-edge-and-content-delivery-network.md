# Edge & Content Delivery Network

KernelCMS Cloud serves content from a global edge fabric so that a reader in São Paulo and a reader in Frankfurt both get sub-50ms responses to the same published document. This page specifies how the edge runtime executes read-path operations, how the content CDN caches and revalidates responses, how publish events invalidate caches deterministically, and how regional data residency constrains where documents physically live. Self-hosters can reproduce the same shape with their own CDN and runtime — KernelCMS does not require Cloud — but Cloud wires it together by default.

## The edge runtime

KernelCMS Cloud runs the API host on TanStack Start deployed to a V8-isolate edge runtime (Cloudflare Workers as the default target, with Deno Deploy and Vercel Edge as alternates). The same server functions that power the Local/RPC API run at the edge; there is no separate "edge build." What changes is which adapters are available and which operations are allowed to execute there.

The hard constraint is that edge isolates have no persistent TCP connection pool and a tight CPU budget. So KernelCMS splits the runtime into two tiers:

```
            ┌─────────────────────────────────────────────┐
   reader → │  EDGE TIER  (V8 isolates, ~300 PoPs)         │
            │  • REST / GraphQL / RPC read handlers        │
            │  • TanStack Start server fns                 │
            │  • @kernel/db read replica (HTTP/libSQL)     │
            │  • cache lookup + revalidation               │
            └───────────────┬─────────────────────────────┘
                            │ cache miss / any write
            ┌───────────────▼─────────────────────────────┐
   editor → │  REGION TIER  (Node/Bun, per data region)    │
            │  • writes, migrations, jobs, webhooks        │
            │  • primary Postgres / MySQL / Mongo          │
            │  • @kernel/storage origin, image pipeline    │
            └─────────────────────────────────────────────┘
```

Read operations that can be satisfied from a regional read replica run entirely in the isolate. The database adapters that work at the edge are the HTTP-friendly ones: `@kernel/db-sqlite` over libSQL/Turso embedded replicas, and `@kernel/db-postgres` over an HTTP proxy (Hyperdrive or a serverless driver). Writes, migrations, and queue jobs always route to the region tier, because they need the primary and a real connection pool.

You select edge behavior in `kernel.config.ts`:

```ts
import { defineConfig } from '@kernel/core'
import { cloud } from '@kernel/cloud'

export default defineConfig({
  deployment: cloud({
    runtime: 'edge', // 'edge' | 'node' | 'bun'
    edge: {
      // Operations allowed to execute in the isolate.
      // Everything else falls through to the region tier.
      allow: ['find', 'findByID', 'count'],
      // Read replica reachable over HTTP from isolates.
      read: { adapter: '@kernel/db-sqlite', mode: 'embedded-replica' },
      // Per-isolate CPU budget; over this, return 503 and warm the region.
      cpuBudgetMs: 30,
    },
  }),
})
```

This is a sharper line than the competition draws. Payload runs on Node and leans on Next.js to push _rendered pages_ to the edge, but its API and Local API still execute against a single primary region. Strapi is Node-only and effectively single-region without a bespoke replica setup. Sanity solves the problem by being a hosted document store with its own global API and CDN — but you don't run _your_ code there. KernelCMS runs your access-control functions, hooks, and field logic in the isolate, so the edge response is the real, authorized response, not a dumb cache of a pre-rendered blob.

### What does not run at the edge

Access control still executes — that's the point — but anything that touches a write primary, a queue, or a non-HTTP adapter is forced to the region tier. The config validator rejects an `edge.allow` entry that references an operation whose access function performs a write, so you cannot accidentally ship a handler that stalls an isolate on a TCP connect. See [Access Control](../06-auth-security/01-authorization-and-access-control.md) and [Adapters](../03-persistence/00-persistence-overview-and-adapter-contract.md).

## The content CDN

Every cacheable read response carries explicit cache directives and a set of surrogate keys (cache tags). The CDN — Cloudflare's cache by default on Cloud — keys entries on the normalized request and stores them at the PoP. The shared query language (`where`, `sort`, `pagination`, `depth`) is normalized into the cache key so that two semantically identical requests with different param ordering hit the same entry.

Responses use `stale-while-revalidate` so a stale-but-recent entry is served instantly while the isolate revalidates in the background:

```
Cache-Control: public, max-age=0, s-maxage=60, stale-while-revalidate=600
Surrogate-Key: col:posts doc:posts:01HZ... rel:authors:42 locale:en
ETag: "W/v7-9f2a"
```

Cache policy is declared per collection or global, with overrides per operation:

```ts
import { collection } from '@kernel/core'

export const Posts = collection({
  slug: 'posts',
  cache: {
    surface: ['rest', 'graphql', 'rpc'],
    // Edge TTL; browsers get max-age=0 and always revalidate.
    sMaxAge: 60,
    staleWhileRevalidate: 600,
    // Extra surrogate keys beyond the automatic col:/doc:/rel: tags.
    tags: (doc) => [`section:${doc.section}`],
    // Drafts and access-controlled reads are never shared-cached.
    private: ({ draft, hasFieldAccessControl }) => draft || hasFieldAccessControl,
  },
  fields: [
    /* ... */
  ],
})
```

The automatic tag scheme is what makes invalidation precise:

| Tag pattern       | Emitted on                                          | Invalidated when                       |
| ----------------- | --------------------------------------------------- | -------------------------------------- |
| `col:<slug>`      | any list/`count` read of a collection               | any doc in the collection is published |
| `doc:<slug>:<id>` | `findByID` and any response containing the doc      | that document changes                  |
| `rel:<slug>:<id>` | responses that resolved a relationship with `depth` | the related doc changes                |
| `locale:<code>`   | localized reads                                     | a translation in that locale publishes |
| `global:<slug>`   | global reads                                        | the global is saved                    |

Because relationship resolution emits `rel:` tags, a response built with `depth: 2` is automatically invalidated when any document it embedded changes — without you tracking the dependency graph by hand. Sanity's CDN tags queries similarly via its `syncTags`; KernelCMS differs by deriving tags from the resolved document graph and your config, so custom tags live next to the schema rather than in client query annotations.

## Cache invalidation

Invalidation is event-driven and runs on the region tier, because that's where writes land. The operation core emits a domain event on every successful mutation; a built-in subscriber translates it into a surrogate-key purge against the CDN.

```
publish(posts/01HZ…)
   │
   ├─▶ operation core commits to primary
   │
   ├─▶ emits  document.published  { slug, id, locale, tags, relatedTo }
   │
   └─▶ @kernel/cloud cdn subscriber:
          purge keys → doc:posts:01HZ…
                       col:posts
                       locale:en
                       rel:* (reverse refs to this doc)
```

The purge is by surrogate key, never by URL, so a single publish clears every cached representation of that document — REST, GraphQL, and RPC; every locale; every list it appears in — in one call. Reverse-reference purging is computed from the relationship index maintained by `@kernel/db`, so editing an author also clears the cached post lists that embedded that author at `depth >= 1`.

You can purge programmatically from hooks or jobs for anything the automatic scheme doesn't cover (for example, an external system that mirrors content):

```ts
import { cdn } from '@kernel/cloud'

afterChange: async ({ doc, req }) => {
  if (doc.featured) {
    await cdn.purge(req, { tags: [`section:${doc.section}`, 'col:posts'] })
  }
}
```

Two guarantees matter. First, purge happens **after** the primary commit and **before** the event is acknowledged, so a reader who triggered the publish never sees the old version on their next read — read-your-writes holds at the document level. Second, purges are idempotent and retried via the queue adapter; a CDN API blip degrades to "served stale a little longer," never "served stale forever." This is where KernelCMS beats a hand-rolled Strapi-plus-Varnish setup: the dependency tags and the retry/ordering semantics are part of the core, not glue you wrote and now maintain.

For preview, the live-preview surface (see [Live Preview](../04-admin-ui/10-live-preview-and-visual-editing.md)) bypasses the shared cache entirely by sending `Cache-Control: private, no-store` and a signed preview token, so editors see uncached drafts while readers see the cached published copy.

## Regional data

Edge is the read path; regional data is where the bytes actually live. KernelCMS Cloud pins each project's primary database and `@kernel/storage` origin to a chosen **home region** (for example `eu-central`, `us-east`, `ap-southeast`). The edge isolates and CDN are global; the durable state is regional and never silently leaves its region.

```ts
deployment: cloud({
  runtime: 'edge',
  data: {
    homeRegion: 'eu-central', // primary + storage origin live here
    readReplicas: ['us-east', 'ap-southeast'],
    residency: 'strict', // 'strict' pins all PII to homeRegion
  },
})
```

`residency: 'strict'` keeps the primary and all uploads in the home region and only replicates **public, published** content to the read-replica regions; drafts, version history, and any collection flagged `pii: true` are excluded from replication and answered from home. This is the lever that satisfies GDPR-style data-locality requirements without giving up global read latency for public content.

| Mode            | Primary | Replicas carry                  | Use case                     |
| --------------- | ------- | ------------------------------- | ---------------------------- |
| `global`        | home    | all published content           | marketing sites, docs        |
| `strict`        | home    | public published only           | regulated content + PII      |
| `region-locked` | home    | nothing (no cross-region reads) | full residency, latency cost |

The home region also owns migrations and the write primary, so [Migrations](../03-persistence/08-migrations-engine.md) and write-path access control run in exactly one place — no multi-primary conflict resolution to reason about. None of Payload, Strapi, or Sanity exposes a per-collection residency flag that the replication layer enforces; Sanity offers regional hosting but not field-level PII exclusion from its global CDN. KernelCMS makes residency a config-as-code property of the data model.

## Open questions

- **Multi-primary writes.** The current model is single home-region primary with global read replicas. Do we ever support active-active write regions, and if so, do we adopt CRDT-style merge for `array`/`blocks` fields or stay last-write-wins with version history as the audit trail?
- **Edge cost ceiling for `depth`.** Deep relationship resolution at the edge can blow the `cpuBudgetMs`. Should `depth > N` automatically fall through to the region tier, or should we precompute denormalized read models per collection?
- **Tag cardinality.** High-fanout documents (a popular author referenced by thousands of posts) produce large `rel:` purge sets. Do we cap reverse-reference purging and fall back to a `col:` purge above a threshold, and where is that threshold?
- **Self-host parity.** How much of the surrogate-key purge subscriber ships in `@kernel/cloud` versus a generic CDN adapter interface so self-hosters get the same invalidation against Fastly/Cloudflare/Bunny without Cloud?
