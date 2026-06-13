# Semantic & hybrid search

KernelCMS treats your content as a RAG knowledge base. On top of the adapter-based
full-text search, you can supply a pluggable **embedder** and a collection's fields are
embedded on every write into a vector store. You then query that store two ways:
**semantic** (pure vector top-K) and **hybrid** (full-text + vector fused with Reciprocal
Rank Fusion). Both run through the same access-checked read path as everything else, so a
vector hit for a document the caller cannot read is dropped, never leaked.

The point: your CMS *is* the knowledge base. Instead of a CMS plus a sync Lambda plus a
managed vector database (Pinecone, Weaviate, …) that you keep in step by hand, the index
is maintained inline with your content writes — roughly 60% less infrastructure to stitch
together.

> TL;DR: set a top-level `embeddings: { embed }` (any provider — KernelCMS has no
> embedding dependency of its own), mark a collection's `search` with `semantic: true`,
> and call `kernel.hybridSearch(...)` / `kernel.semanticSearch(...)` or hit
> `GET /api/:collection/hybrid` / `/semantic`.

---

## 1. Configure an embedder

`embeddings.embed` is the entire contract: take an array of strings and return an array
of vectors (one per input, same order). KernelCMS never calls a specific provider — you
own that line — so OpenAI, Cohere, Voyage, or a local model behind a small `fetch` all
work the same way.

```ts
// kernel.config.ts
import { defineConfig } from 'kernelcms'
import { memorySearch } from 'kernelcms'
import OpenAI from 'openai'

const openai = new OpenAI() // reads OPENAI_API_KEY from the environment

export default defineConfig({
  secret: process.env.KERNEL_SECRET!,
  db: sqliteAdapter({ url: process.env.DATABASE_URL ?? 'file:./content.db' }),

  // Full-text adapter — hybrid search fuses this with the vector store.
  search: memorySearch(),

  // Pluggable embedder. The only required shape is string[] → number[][].
  embeddings: {
    embed: async (texts) => {
      const res = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: texts,
      })
      return res.data.map((d) => d.embedding)
    },
    dimensions: 1536, // optional; helps a backing store size its columns
  },

  collections: [/* … */],
})
```

`embeddings.dimensions` is optional metadata — the in-process default store doesn't need
it, but a backing vector store (see [Production](#production-pgvector)) uses it to size
its column. Any provider works as long as `embed` returns one vector per input string.

When `embeddings` is set, KernelCMS defaults `vector` to the built-in `memoryVector()` —
an in-process cosine-similarity store. It's perfect for development and small datasets;
for production durability and scale you point `vector` at a backing adapter (again, see
[Production](#production-pgvector)).

> The embedder runs on the **content write path**. If a call to your provider fails, the
> failure is logged (never with the source text or your API key) and the write still
> succeeds — a transient embedding outage can never block content editing. The affected
> document simply isn't in the vector index until its next successful write.

## 2. Enable `semantic` on a collection

Full-text search needs `search: { fields }`. To also embed those fields, add
`semantic: true`:

```ts
{
  slug: 'posts',
  access: { read: () => true },
  search: { fields: ['title', 'body'], semantic: true },
  fields: [
    { name: 'title', type: 'text', required: true },
    { name: 'body', type: 'richText' },
  ],
}
```

The listed fields are embedded on **every write**, on the same real-time path as the
full-text index — no separate job, no nightly batch. The text handed to the embedder is
enriched with field metadata for retrieval accuracy rather than embedding raw values
blind. Real-time indexing isn't just convenience: it's a governance requirement for AI
agents, which must never retrieve a stale or already-deleted document.

You can run semantic search with no full-text fields and full-text with no embedder —
each side is independent, and the query ops degrade gracefully when one is missing (see
below).

## 3. Semantic vs. hybrid — when to use which

Two Local API ops, both returning `{ docs }` already loaded through the access-checked
read path:

```ts
// Pure vector top-K. Best for "find me things that mean roughly this".
const { docs } = await kernel.semanticSearch({
  collection: 'posts',
  query: 'how do I deploy to a single container?',
  limit: 10,                          // clamped to a max of 100
  filter: { _status: 'published' },   // validated against real columns
  req,                                // the request principal — access is enforced
})

// Hybrid: full-text + vector, fused with Reciprocal Rank Fusion.
const { docs } = await kernel.hybridSearch({
  collection: 'posts',
  query: 'kernel deploy container',
  limit: 10,
  req,
})
```

- **Semantic** is meaning-based. It shines on conversational or paraphrased queries
  ("what's the cheapest way to host this?") where the user's words don't match the
  document's words. It can miss exact identifiers (a SKU, an error code) that share no
  semantic neighborhood.
- **Hybrid** is the 2026 default for most retrieval. It runs both searches and fuses their
  rankings with **Reciprocal Rank Fusion** (RRF, constant `k = 60`): each document scores
  `Σ 1 / (k + rank)` across the two result lists, so a result that ranks well in *either*
  full-text or vector surfaces, and results that rank well in *both* rise to the top. You
  get keyword precision (exact terms, names, codes) and semantic recall (synonyms,
  paraphrase) in one ranked list, without tuning a blend weight.

**Graceful degradation.** If a collection has `semantic: true` but no full-text fields,
`hybridSearch` returns vector-only results. If it has full-text fields but no embedder
configured, `hybridSearch` returns full-text-only results. You don't have to branch on
configuration in your application code — ask for hybrid and get the best available.

## 4. The REST surface

The same two ops are exposed over HTTP, access-checked to the request principal:

```bash
# Semantic (vector top-K)
curl "http://localhost:3000/api/posts/semantic?q=how%20do%20I%20deploy&limit=10"

# Hybrid (full-text + vector, RRF)
curl "http://localhost:3000/api/posts/hybrid?q=how%20do%20I%20deploy"
```

`q` is the query string and `limit` is the optional result cap. `limit` is clamped to a
maximum of **100**. These routes resolve the caller exactly like every other REST route —
an anonymous request only sees what `access.read` allows anonymously.

## 5. The access guarantee

This is the part that makes built-in retrieval safe to expose to agents and users alike:
**results always go through the access-checked read path**. The vector store returns
candidate IDs; KernelCMS then loads those documents through the normal access pipeline and
drops any the caller cannot read. A vector hit for a private draft never leaks to a public
caller — the ranking sees it, the response does not.

Two more boundaries are enforced on every call:

- **`limit` is clamped** to a maximum of 100, so a caller can't ask the store for an
  unbounded scan.
- **`filter` is validated** against the collection's real columns before it touches the
  store — no SQL/operator injection, no prototype pollution through crafted keys.

Combined with [deny-by-default access](conventions.md#access-is-deny-by-default) and the
draft-only AI-agent principal, this means you can point an agent at
`kernel.hybridSearch(...)` and trust that it retrieves only what its scope allows.

## 6. Real-time indexing

The vector index is updated **synchronously on write**, on the same path as the full-text
index. There is no eventual-consistency window and no cron to schedule:

- A `create` or `update` re-embeds the collection's `semantic` fields and upserts the
  document's vector.
- A `delete` removes the document's vector, so a deleted document can't be retrieved a
  moment later.

For AI agents this isn't a nicety — research on agentic systems treats stale retrieval as
a correctness and governance failure. Indexing inline with the write keeps the knowledge
base and the content in lockstep.

## 7. Production: the vector adapter (pgvector) {#production-pgvector}

The built-in `memoryVector()` keeps vectors in process. Like `memorySearch()` and
`memoryStorage()`, that's ideal for development, tests, and small single-node deployments,
but it is **lost on restart and not shared across nodes**.

For production you set `vector` to a durable, shared adapter. The `VectorAdapter`
interface is defined and the engine wires through it today; a **pgvector-backed adapter is
the documented next step** — the interface is ready, the adapter is not yet shipped. Until
it lands, run semantic/hybrid search on a single node with `memoryVector()`, or keep your
embeddings in your own store behind the same interface.

```ts
import { defineConfig } from 'kernelcms'

export default defineConfig({
  embeddings: { embed: myEmbed, dimensions: 1536 },
  // vector defaults to memoryVector() when embeddings is set.
  // vector: pgVector({ url: process.env.DATABASE_URL }), // production follow-up — not yet shipped
  collections: [/* … */],
})
```

---

See [conventions.md](./conventions.md) for the deny-by-default access model and the
`memory*` adapter caveats this guide builds on, and the README's **Search** section for the
one-paragraph version.
