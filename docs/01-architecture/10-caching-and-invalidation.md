# Caching & Invalidation

KernelCMS treats caching as a first-class architectural concern, not a bolt-on. Reads pass through a deterministic stack of layers — request memo, in-process LRU, shared cache adapter, HTTP edge — and every layer is keyed and tagged the same way. A single write produces one canonical set of invalidation tags that fans out across all layers and all API surfaces (REST, GraphQL, RPC) in one operation. On the client, that same tag vocabulary is mirrored into TanStack Query keys so that a mutation in the admin or a webhook from the server invalidates exactly the queries it should — no `staleTime: 0` carpet-bombing, no manual `queryClient.invalidateQueries()` guesswork. This document specifies the layers, the tag model, the TanStack Query alignment, and the stale-while-revalidate policy.

## Cache layers

KernelCMS defines four layers. Each is optional and individually swappable, but they share one key/tag contract so a value cached at L2 and a value cached at L3 invalidate identically.

```
 read request
     │
     ▼
┌─────────────┐   per-request, in-memory, dies with the request
│ L0 request  │   dedupes N identical loads in one operation
│   memo      │
└─────┬───────┘
      │ miss
      ▼
┌─────────────┐   per-process LRU (lru-cache), bounded by entries+bytes
│ L1 process  │   sub-millisecond, lost on restart/redeploy
└─────┬───────┘
      │ miss
      ▼
┌─────────────┐   @kernel/cache adapter: Redis / Upstash / memory / KV
│ L2 shared   │   survives restarts, shared across instances
└─────┬───────┘
      │ miss
      ▼
┌─────────────┐   Cache-Control + CDN (Cloud) or your reverse proxy
│ L3 HTTP     │   tag-purged via the same invalidation event
└─────┬───────┘
      │ miss
      ▼   database (Drizzle / Mongo adapter)
```

| Layer | Scope | Backing | TTL default | Invalidation |
|-------|-------|---------|-------------|--------------|
| L0 request memo | Single operation | Map in `RequestContext` | request lifetime | automatic |
| L1 process | One Node/Bun instance | `lru-cache` | 60s | tag map in-process |
| L2 shared | All instances | `@kernel/cache` adapter | 300s | tag set in adapter |
| L3 HTTP/CDN | Edge / proxy | `Cache-Control` + surrogate keys | `s-maxage` | surrogate-key purge |

L0 is the cheapest and most overlooked win. Within one resolver pass, a GraphQL query with `depth: 2` may resolve the same `relationship` target several times; the request memo guarantees one database round-trip per `(collection, id, locale, draft)` tuple. Payload solves the same N+1 class with DataLoader batching; KernelCMS uses a memo keyed by the canonical cache key (below), which also covers globals and access-filtered reads, not just `findByID`.

L1 and L2 are configured in `kernel.config.ts`. The shared adapter is the same swappable-adapter contract used for storage, email, and queue — pick your infrastructure, KernelCMS does not hard-wire Redis.

```ts
// kernel.config.ts
import { defineConfig } from '@kernel/core'
import { redisCache } from '@kernel/cache/redis'

export default defineConfig({
  cache: {
    process: { max: 10_000, maxBytes: 256 * 1024 * 1024, ttl: 60_000 },
    shared: redisCache({
      url: process.env.REDIS_URL!,
      keyPrefix: 'kernel:',
      ttl: 300_000,
    }),
    // L3 is emitted as headers + surrogate keys; the proxy/CDN enforces it
    http: { sMaxAge: 300, staleWhileRevalidate: 86_400 },
  },
})
```

### Canonical cache keys

Every cacheable read produces a structured key. Caching identity is not the URL — it is the operation plus the dimensions that change the result. This is why `?depth=` and locale never produce stale cross-talk.

```ts
type CacheKey = {
  scope: 'collection' | 'global'
  slug: string                 // 'posts'
  op: 'find' | 'findByID' | 'count'
  id?: string                  // for findByID
  locale?: string              // field-level localization dimension
  draft: boolean               // drafts vs published are separate entries
  // the query language, normalized + stable-stringified:
  where?: NormalizedWhere
  sort?: string[]
  page?: number
  limit?: number
  depth: number
}
```

Access control is deliberately **not** part of the key. KernelCMS caches the unfiltered operation result and applies field- and document-level access on the way out, per request. Caching post-authorization would multiply entries by user and leak document existence through cache timing. Strapi's older cache plugins cached rendered responses and routinely served documents past their access rules; KernelCMS caches the data, authorizes the projection. See [Access Control](../06-auth-security/01-authorization-and-access-control.md) for where the filter runs.

## Tag-based invalidation

Tags are the spine. Every cache entry is written with a set of tags, and every write computes the tags it dirties. Invalidation is set intersection, not key enumeration — you never need to know which keys exist.

Tag grammar (stable, documented, used identically on server and client):

```
col:posts                  every read of the posts collection
doc:posts:42               one specific document
rel:posts:42               anything that embedded posts:42 via a relationship
global:settings            a singleton
locale:de                  localized reads in German
field:posts:slug           reads that projected a specific field (opt-in)
```

A published mutation on `posts:42` emits:

```ts
// computed by @kernel/server on the operation result
const tags = [
  'col:posts',          // list views must refresh
  'doc:posts:42',       // the document itself
  'rel:posts:42',       // documents that joined to it at any depth
  'locale:de',          // only the locales actually touched
]
```

The `rel:` tag is what makes `depth` queries correct. When a read resolves a relationship to `posts:42` at any nesting level, the resulting cache entry records `rel:posts:42`. Editing post 42 then purges the author page, the homepage, and the category listing that embedded it — without anyone declaring those dependencies. Sanity achieves comparable live correctness through GROQ query-driven listeners; KernelCMS achieves it by recording the relationship edges traversed during the read, which works identically for cached HTTP responses and client TanStack Query caches.

Invalidation flows through one bus so all layers and surfaces stay coherent:

```
write commits (Drizzle/Mongo)
        │
        ▼
  computeTags(result, op)
        │
   ┌────┴───────────────────────────────┐
   ▼            ▼            ▼            ▼
 L1 purge    L2 purge    L3 surrogate   pub/sub fan-out
 (in-proc)   (adapter)   purge (CDN)    (other instances + clients)
```

The pub/sub fan-out uses the configured queue/realtime adapter. Other server instances drop their L1 entries for the dirtied tags; connected admin clients receive a tag-invalidation event over the same channel that powers [Live Preview](../04-admin-ui/10-live-preview-and-visual-editing.md). Hooks can contribute extra tags for derived data:

```ts
// a collection that denormalizes into a search index
afterChange: async ({ doc, addTags }) => {
  addTags([`search:posts`, `sitemap:posts`])
}
```

Surrogate keys map tags onto CDN purge. On KernelCMS Cloud the response carries `Surrogate-Key: col:posts doc:posts:42`, and the invalidation bus issues a tag purge to the CDN. Self-hosters get the same header; wiring it to Fastly/Cloudflare/Varnish is one adapter method.

## Alignment with TanStack Query

The win is that server tags and client query keys are the same vocabulary. `@kernel/client` builds query keys from the canonical cache key, so a tag-shaped invalidation maps cleanly onto `queryClient.invalidateQueries`.

```ts
// @kernel/client query key factory — deterministic, structural
export const keys = {
  find: (slug: string, q: FindArgs) =>
    ['kernel', 'col', slug, 'find', normalize(q)] as const,
  doc: (slug: string, id: string, q: DocArgs = {}) =>
    ['kernel', 'col', slug, 'doc', id, normalize(q)] as const,
}

const { data } = useQuery({
  queryKey: keys.find('posts', { where, sort, depth: 1, locale }),
  queryFn: () => kernel.posts.find({ where, sort, depth: 1, locale }),
})
```

A server invalidation tag is translated to a query-key predicate by `@kernel/client`'s tag bridge. Subscribing once wires every admin query to server truth:

```ts
// admin bootstrap — one subscription, no per-query plumbing
kernel.realtime.onInvalidate((tags) => {
  for (const tag of tags) {
    queryClient.invalidateQueries({
      predicate: (q) => matchesTag(q.queryKey, tag),
    })
  }
})
```

`matchesTag` decodes structural keys: `doc:posts:42` invalidates `['kernel','col','posts','doc','42', *]`; `col:posts` invalidates every `posts` `find`; `rel:posts:42` invalidates any cached query whose recorded relationship set included `posts:42` (the server ships that set in query metadata). Because admin mutations go through the typed RPC layer, the optimistic path and the authoritative path use one key space:

```ts
const mutation = useMutation({
  mutationFn: (patch) => kernel.posts.update(id, patch),
  onMutate: async (patch) => {
    await queryClient.cancelQueries({ queryKey: keys.doc('posts', id) })
    const prev = queryClient.getQueryData(keys.doc('posts', id))
    queryClient.setQueryData(keys.doc('posts', id), (d) => ({ ...d, ...patch }))
    return { prev }
  },
  onError: (_e, _v, ctx) =>
    queryClient.setQueryData(keys.doc('posts', id), ctx?.prev),
  // no manual invalidate: server emits doc:/col:/rel: tags,
  // the realtime bridge re-syncs every affected query
})
```

This is the structural difference from Payload and Strapi, whose generated admin clients leave cache invalidation to the integrator's fetching library. KernelCMS owns both ends of the wire, so the tag a write emits and the query a screen reads are provably the same identifiers.

## Stale-while-revalidate

Every layer follows the same policy: serve fast, refresh in the background, never let a cold cache stampede the database. The contract is `{ ttl, staleTtl }` — `ttl` is the fresh window, `staleTtl` is how long a stale entry may still be served while one revalidation runs.

```ts
// per-collection override in kernel.config.ts
collections: [{
  slug: 'posts',
  cache: {
    ttl: 60_000,        // fresh for 60s
    staleTtl: 600_000,  // serve stale up to 10m while revalidating
    swr: true,
  },
}]
```

Read state machine at L1/L2:

```
 fresh  ── within ttl ───────────► serve, no work
 stale  ── ttl < age < staleTtl ─► serve stale + single bg revalidate
 expired── age > staleTtl ───────► block, fetch, fill, serve
```

Single-flight is enforced per cache key: when an entry goes stale, the first reader acquires a short-lived revalidation lock in the shared adapter; concurrent readers serve the stale value rather than dogpiling. This caps database load at one query per key per refresh regardless of traffic — the failure mode that takes down naively-cached Strapi deployments under a cache flush.

At L3, the same numbers become a header the CDN already understands:

```
Cache-Control: public, s-maxage=60, stale-while-revalidate=86400
Surrogate-Key: col:posts doc:posts:42 locale:de
```

The crucial interaction: SWR governs **time-based** staleness; tag invalidation governs **event-based** staleness. A document can be served stale-but-acceptable for ten minutes by SWR, yet the instant someone publishes an edit, the tag purge hard-evicts it everywhere. The two are complementary — SWR absorbs traffic spikes and clock-driven refresh, tags guarantee correctness on writes. On the client, this maps directly onto TanStack Query's `staleTime` (the SWR fresh window) and the realtime invalidation bridge (the event purge), so the admin behaves identically to the edge.

```ts
useQuery({
  queryKey: keys.doc('posts', id),
  queryFn: () => kernel.posts.findByID(id),
  staleTime: 60_000,      // mirrors server ttl: serve cached, no refetch
  gcTime: 600_000,        // mirrors staleTtl
})
```

Drafts opt out of SWR entirely. Draft and autosave reads use `ttl: 0`; an editor must never see a stale version of their own in-flight work. The `draft` dimension in the cache key keeps that policy isolated from the published cache, which keeps its full SWR window. See [Drafts & Versions](../02-data-modeling/10-versioning-drafts-and-autosave.md).

## Open questions

- **Negative caching.** Should `findByID` misses (404s) be cached to blunt enumeration scans, and at what TTL, given the access-existence concern? Leaning toward a short L2-only negative TTL with no L3 exposure.
- **`field:` tag granularity.** Field-level tags enable surgical invalidation but multiply tag cardinality. Default off, opt-in per field, or computed only when a projection is narrow?
- **Cross-region purge latency on Cloud.** Tag purge is near-instant in-region; the SLA for global CDN tag propagation (and whether SWR should widen to cover it) is unsettled.
- **TanStack DB integration.** When reactive client collections are enabled, should the realtime bridge feed differential row patches instead of coarse query invalidations? Likely yes for live/offline frontends, but the tag-to-row mapping needs spec work.
