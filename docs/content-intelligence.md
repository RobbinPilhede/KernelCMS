# Content intelligence (related content & near-duplicate detection)

Your embeddings power more than search. The same vectors KernelCMS writes for
[semantic search](semantic-search.md) also drive two **content-intelligence** operations:
`kernel.relatedContent(...)` returns the documents most semantically *like* a given one —
"more like this" — and `kernel.findDuplicates(...)` finds **near-duplicate / redundant**
documents across a collection. Both run through the same access-checked read path as every
other operation, so a related or duplicate result never surfaces — or even implies the
existence of — a document the caller cannot read.

The point: once your content is embedded, recommendations and content-quality cleanups come
for free. Internal-linking ("you might also like"), surfacing the closest existing article
before someone writes a near-copy, and periodic dedupe sweeps all read the index you already
maintain — no separate recommendation service, no second similarity job to keep in step.

> TL;DR: with `embeddings` + a vector store configured (the semantic-search setup),
> `kernel.relatedContent({ collection, id, limit, filter })` returns `{ docs }` like a seed,
> and `kernel.findDuplicates({ collection, threshold, limit })` returns
> `{ pairs: [{ a, b, score }] }`. Both are access-checked; the dedup scan is bounded.

This guide builds on [semantic search](semantic-search.md) — both features **require an
embedder and a vector store**. If you haven't configured `embeddings` yet, start there.

---

## 1. Prerequisites: embeddings + a vector store

Content intelligence is built on the vector index. It needs exactly the semantic-search
setup and nothing more:

- A pluggable `embeddings: { embed }` (any provider — `string[] → number[][]`).
- A collection whose `search` sets `semantic: true`, so its fields are embedded on every
  write.
- A `vector` store — the built-in in-process `memoryVector()` by default when `embeddings`
  is set; a pgvector-backed adapter is the documented production follow-up.

```ts
// kernel.config.ts — the same block semantic search uses
export default defineConfig({
  embeddings: {
    embed: async (texts) => {
      const res = await openai.embeddings.create({ model: 'text-embedding-3-small', input: texts })
      return res.data.map((d) => d.embedding)
    },
  },
  collections: [
    {
      slug: 'posts',
      access: { read: () => true },
      search: { fields: ['title', 'body'], semantic: true }, // embedded on every write
      fields: [/* … */],
    },
  ],
})
```

See [semantic search §1](semantic-search.md) for the embedder contract and the
`memoryVector()` / pgvector notes. With no embedder configured, these ops have nothing to
compare and don't apply.

## 2. `kernel.relatedContent` — more like this

Given one document, return the others most like it. KernelCMS re-embeds the **seed from its
current content**, runs a vector nearest-neighbor search, drops the seed itself, and loads
the rest through the access-checked read path:

```ts
const { docs } = await kernel.relatedContent({
  collection: 'posts',
  id,                                  // the seed document
  limit: 5,                            // how many neighbors to return (clamped)
  filter: { _status: 'published' },    // optional; validated against real columns
  req,                                 // the request principal — access is enforced
})
```

- **Seeded by content, not a stored vector argument.** The seed is re-embedded from its
  current fields, so "related" always reflects the document as it reads now.
- **The seed never returns itself.** It's excluded from its own neighbor list.
- **`limit` and `filter` behave exactly as in `semanticSearch`** — `limit` is clamped, and
  `filter` is validated to the collection's real columns (no injection, no prototype
  pollution through crafted keys).

This is the engine behind internal-linking and recommendation rails: ask for the documents
like the one a reader is on, render them as "related posts". Because every neighbor is loaded
through the normal access pipeline, a related result the caller can't read is simply dropped
from `docs`.

## 3. `kernel.findDuplicates` — near-duplicate detection

Sweep a collection for pairs of documents whose embeddings are close enough to be
near-duplicates or redundant content — the heart of a content-QA / dedupe pass:

```ts
const { pairs } = await kernel.findDuplicates({
  collection: 'posts',
  threshold: 0.92,   // min cosine similarity for a pair; default 0.9, clamped to [0, 1]
  limit: 50,         // max pairs returned (clamped)
  req,
})
// pairs: Array<{ a, b, score }> — a and b are the two documents, score the cosine similarity
```

- **`threshold`** is the minimum cosine similarity for two documents to count as a pair —
  default `0.9`, clamped to `[0, 1]`. Raise it (`0.95`+) for only the closest copies; lower
  it to catch looser redundancy.
- **`score`** is the cosine similarity of the pair, so you can sort and triage: the highest
  scores are the most likely genuine duplicates.
- **The scan is bounded.** `findDuplicates` is an **admin operation, not a hot path** — it
  caps both the number of documents scanned and the number of pairs returned, so a large
  collection can't turn one call into an unbounded all-pairs comparison.

Use it as a content-quality tool: run it after a migration or content import to find
accidental re-posts, surface near-identical landing pages, or flag two articles that have
drifted into covering the same thing. Similarity is computed over the **last-indexed
content** of each document within that bounded scan, by design — it reads the vector index,
it doesn't re-embed the whole collection on every call.

## 4. The REST surface

Both ops are exposed over HTTP, access-checked to the request principal:

```bash
# Related content — documents like one seed (resolves the caller like any read route)
curl "http://localhost:3000/api/posts/<id>/related?limit=5"

# Near-duplicate pairs across a collection — admin/editor-gated
curl "http://localhost:3000/api/_admin/duplicates?collection=posts&threshold=0.92&limit=50"
```

`GET /api/:collection/:id/related` resolves the caller exactly like every other REST route —
an anonymous request only sees related documents that `access.read` allows anonymously, and
`limit` is clamped. `GET /api/_admin/duplicates` is **admin/editor-gated**: near-duplicate
detection is an administrative content-quality operation, so the route sits behind the same
gate as insights and the purge feed, and `threshold` / `limit` are clamped at the boundary.

## 5. The access & bounds guarantee

This is what makes content intelligence safe to expose to agents and users alike:
**every result goes through the access-checked read path** — the same pipeline as a normal
`findByID`, evaluated against the caller's access. Related and duplicate results never
surface (or imply the existence of) a document the caller can't read.

- **Related results are access-checked, one document at a time.** The vector store returns
  candidate ids; KernelCMS loads each through the normal access pipeline and drops any the
  caller can't read. A neighbor that's a private draft never leaks to a public caller — the
  ranking sees it, the response does not.
- **A duplicate pair leaks nothing — it's dropped whole.** A pair is returned **only when
  the caller can read both documents**. If either side is a document the caller can't read,
  the entire pair is dropped — it never reveals the hidden document's id, its score, or even
  that it exists. There's no half-pair pointing at something invisible.
- **Bounded by design.** `threshold` is clamped to `[0, 1]`, `limit` is clamped, and the
  dedup scan caps both the documents scanned and the pairs returned — an admin operation,
  not a hot path, so one call can't run an unbounded all-pairs comparison.
- **`filter` is validated** against the collection's real columns before it touches the
  store — no SQL/operator injection, no prototype pollution through crafted keys.
- **The provider never leaks.** The embedder closure may hold an API key; its key and the
  text it embeds are never written to logs or surfaced in errors.

Combined with [deny-by-default access](conventions.md#access-is-deny-by-default) and the
draft-only AI-agent principal, you can point an agent at `kernel.relatedContent(...)` and
trust it recommends only what its scope allows — and run `findDuplicates` as an admin tool
that never reveals a document an operator couldn't already read. Red-teamed to Risk LOW.

---

See [semantic-search.md](./semantic-search.md) for the embedder + vector-store setup these
ops build on, [conventions.md](./conventions.md#access-is-deny-by-default) for the
deny-by-default access model, and the README's **Content intelligence** section for the
one-paragraph version.
