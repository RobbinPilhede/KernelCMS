# Edge delivery & CDN caching

KernelCMS can turn your public reads into **edge-cacheable** responses and tell a CDN
*exactly* what to invalidate on every write. The model is two halves:

- **Tag on read.** A cacheable public read carries your `Cache-Control` plus a
  `Surrogate-Key` header listing the response's **cache tags** — stable labels for the
  content in it (`<collection>`, `<collection>:<id>`, and the docs it references).
- **Purge by tag.** A change-driven **purge feed** maps recent writes back to those same
  tags. A small CDN worker polls it and purges the matching surrogate keys — so the only
  thing that drops from cache is the content that actually changed.

You cache aggressively at the CDN and invalidate precisely. KernelCMS emits the tags and
the purge list; **the CDN integration is yours** (you wire it to Cloudflare, Fastly,
Vercel, or any provider that supports surrogate-key / cache-tag purging).

It is **off by default**, and the purge feed requires the [real-time change
feed](realtime.md) to be enabled.

## Enable it

```ts
export default defineConfig({
  realtime: { enabled: true }, // the purge feed reads the change feed
  edge: {
    enabled: true,             // default false - the whole feature is opt-in
    // The Cache-Control value sent on a cacheable content read:
    cacheControl: 'public, s-maxage=31536000, stale-while-revalidate=60',
    tagHeader: 'Surrogate-Key',  // surrogate-key header name (default 'Surrogate-Key')
    includeRelationships: true,  // also tag a doc with its relationship targets (default true)
  },
  collections: [/* … */],
})
```

| Option                 | Default            | Meaning                                                                                  |
| ---------------------- | ------------------ | ---------------------------------------------------------------------------------------- |
| `enabled`              | `false`            | Turn the whole feature on. Off → no cache headers, no purge feed.                        |
| `cacheControl`         | —                  | The `Cache-Control` sent on a **cacheable** read (e.g. a long `s-maxage` with SWR).      |
| `tagHeader`            | `'Surrogate-Key'`  | The response header that carries the cache tags. Match it to your CDN's expectation.     |
| `includeRelationships` | `true`             | Also tag a doc with its direct relationship targets, so changing a referenced doc purges this one. |

Set `tagHeader` to whatever your CDN reads — `Surrogate-Key` (Fastly), `Cache-Tag`
(Cloudflare Enterprise), or your own header consumed by a worker.

## The cache headers — cacheable vs. private

This is the security property of the whole feature, so it is worth stating precisely.
When `edge.enabled`, the public REST read endpoints — `GET /api/:collection/:id` and
`GET /api/:collection` — branch on whether the response is **cacheable at a shared edge**:

A response is **cacheable** only when **all** of these hold:

- The caller is **anonymous** (no authenticated user, no API key, no agent principal).
- The read is **not access-scoped** — the collection's read rule is fully public, not a
  row-level filter that depends on who is asking.
- Every returned document is **published** (no drafts; `draft: true` was not requested).
- It is **not a time-travel** read (no `asOf`).
- It does **not** use `overrideAccess`.

For a cacheable response the endpoint adds:

```http
Cache-Control: public, s-maxage=31536000, stale-while-revalidate=60
Surrogate-Key: posts posts:p_07 users:u_1 media:m_3
```

For **anything else** — an authenticated, access-scoped, draft, `asOf`, or
`overrideAccess` read — the endpoint instead sends:

```http
Cache-Control: private, no-store
```

…and **no** surrogate key. Private content is never told to cache at a shared edge, so a
CDN can never serve one user's scoped or draft content to another. There is no
configuration that relaxes this; it is the make-or-break invariant.

## Cache tags

A **cache tag** (surrogate key) is a stable label for a piece of content. The tags for a
response are:

- `<collection>` — the collection itself (purges the list views).
- `<collection>:<id>` — each document in the response.
- With `includeRelationships: true`, the `<collection>:<id>` of each document a returned
  doc **references** (its relationship and upload targets), so the embedding doc carries
  the tag of the thing it embeds.

`kernel.cacheTags(...)` computes them for a doc or a response:

```ts
// tags for one document (its own + collection + relationship-target tags):
const tags = kernel.cacheTags({ collection: 'posts', id: 'p_07', doc })

// tags for a whole list response:
const listTags = kernel.cacheTags({ collection: 'posts', docs })
```

Tags are **sanitized to CDN-safe tokens** — only characters a surrogate-key header
accepts survive, so a slug or id can never inject a header or smuggle a second key.

### Why relationship tagging matters

Say a `posts` document embeds an `author` (a `users` doc). With `includeRelationships`,
the cached post response is tagged `users:<authorId>` as well as `posts:<id>`. When that
author is edited, the purge feed emits `users:<authorId>` — and because the post carries
that tag, the post is purged too. You don't have to know which pages reference a record;
the tags encode it. (The reverse direction — purging docs that reference a *changed* doc
— is handled by the purge feed itself; see below.)

## The purge feed (change-driven invalidation)

`kernel.purgeFeed(...)` reads the [real-time change feed](realtime.md) and maps recent
changes to the cache tags to invalidate:

```ts
let cursor = 0 // or a value you persisted from a previous run

const { tags, cursor: next } = await kernel.purgeFeed({ since: cursor })
// tags: string[] of surrogate keys to purge at the CDN
await purgeAtYourCDN(tags)
cursor = next  // persist; poll again with since: cursor
```

For each recent change it emits the changed doc's own tags **and the tags of the
documents that *reference* it** (bounded) — so editing a referenced record invalidates
every doc that embeds it, not just the record's own URL. The bound keeps a
heavily-referenced doc from fanning out without limit.

Over HTTP the same feed is one **admin-gated** GET — it reveals which document ids
changed, so it is not public:

```bash
curl "http://localhost:3000/api/_edge/purge?since=0" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

```json
{ "tags": ["posts", "posts:p_07", "users:u_1"], "cursor": 41 }
```

For a push model instead of polling, `kernel.onPurge(fn)` delivers tags over the realtime
bus as changes happen:

```ts
const off = kernel.onPurge((tags) => purgeAtYourCDN(tags))
// later: off()
```

Both the polling and push paths require `realtime` to be enabled — the purge feed is
built on the change feed.

## Wiring it to a CDN

KernelCMS produces two things — a `Surrogate-Key`/`Cache-Tag` header on cacheable reads,
and a stream of tags to purge — and you connect them to your provider. The shape is the
same everywhere; only the API call differs.

**Fastly** reads the `Surrogate-Key` response header natively and purges by key:

```ts
// a worker draining the purge feed into Fastly's purge API
const { tags, cursor } = await kernel.purgeFeed({ since })
await fetch(`https://api.fastly.com/service/${SERVICE}/purge`, {
  method: 'POST',
  headers: { 'Fastly-Key': FASTLY_TOKEN, 'surrogate-key': tags.join(' ') },
})
```

**Cloudflare** (Enterprise cache-tags): set `tagHeader: 'Cache-Tag'` so origin responses
carry the tag header, then purge by tag:

```ts
const { tags, cursor } = await kernel.purgeFeed({ since })
await fetch(`https://api.cloudflare.com/client/v4/zones/${ZONE}/purge_cache`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${CF_TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ tags }),
})
```

Run the worker on a short interval (or behind `onPurge`), persist the returned `cursor`,
and the CDN stays in sync — caching public reads for as long as your `s-maxage` allows,
and dropping exactly the changed content within seconds of a write.

## The guarantees

- **Private content is never edge-cached.** A private, authenticated, access-scoped,
  draft, time-travel (`asOf`), or `overrideAccess` response is **never** given a
  public/`s-maxage` `Cache-Control` or a surrogate key — it gets `private, no-store`. A
  wrong header here would cache private content at a shared edge, so this is the invariant
  the whole feature is built around.
- **Tags can't leak ids.** Cache tags only ever contain ids from the **access-checked
  returned documents** — a doc the caller couldn't read is never in the response, so its
  id is never in a tag.
- **No header injection.** Tag and header values are sanitized to CDN-safe tokens, so a
  slug, id, or relationship value can't break out of the header or add a second key.
- **The purge feed is admin-gated and bounded.** `GET /api/_edge/purge` requires an admin
  principal (it reveals changed ids), and the reference fan-out is bounded so one change
  can't emit an unbounded purge list.

Red-teamed to Risk LOW. The CDN integration — the actual purge calls and cache config —
is yours; KernelCMS gives you correct, safe tags and a precise purge list to drive it.

## Where it fits

Edge delivery builds on two other features:

- **[Real-time change feed](realtime.md)** — the purge feed is a projection of the change
  feed onto cache tags; it requires `realtime`.
- **[Relationships & joins](conventions.md)** — relationship tagging is what lets a change
  to one record purge every document that embeds it.

The same access-checked engine decides what is cacheable, what a tag may contain, and what
a purge reveals — edge delivery is a view onto it, never a side channel around it.
