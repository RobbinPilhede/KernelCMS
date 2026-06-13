# Knowledge graph & GraphRAG

Your content already *is* a graph. Every `relationship` and `upload` field is a typed
edge from one document to another, and every `join` field is the same edge read backwards.
KernelCMS exposes that graph two ways: `kernel.graph(...)` walks a document and its
connected neighbors, and `kernel.graphSearch(...)` does **GraphRAG** — it finds seed
documents by meaning, then expands each through the graph to gather the *connected
context* an LLM needs.

GraphRAG is the retrieval technique that pairs a knowledge graph with semantic search:
instead of returning only the documents that match a query, you return those documents
*plus their connected subgraph*. A question like "what did this author write, and who
edited it?" is a graph walk, not a keyword match — and the answer is grounded in
relationships you already modeled, not a side index you maintain by hand.

This is the **retrieval** half. The LLM generation is the caller's — KernelCMS gathers the
subgraph and the grounding context; you hand it to your model.

> TL;DR: `kernel.graph({ collection, id, depth })` returns `{ nodes, edges, truncated }`;
> `kernel.graphSearch({ collection, query, depth })` runs semantic search for seeds (needs
> `embeddings`), expands them through the graph, and adds a `context` array to ground an
> LLM. Both load every node through the access-checked read path and are bounded against
> traversal DoS.

This guide builds on [semantic search](semantic-search.md) (for the seed step) and the
[`join` field](conventions.md#join-reverse-relationship-fields) (for inbound edges).

---

## 1. Content as a typed graph

A node is a document; an edge is a relationship between two documents. KernelCMS reads both
directions of an edge:

- **Outbound** — a `relationship` or `upload` field on the seed pointing at another
  document (`posts.author → users`, `posts.cover → media`).
- **Inbound (reverse)** — a `join` field, i.e. another document pointing *back* at the
  seed (`comments.post → this post`). Nothing is stored for a reverse edge; it's resolved
  by querying the related collection, exactly as a `join` field is at read time.

Polymorphic relationships (`relationTo: ['a', 'b']`) and `hasMany` relationships expand to
one edge per target. That's the whole model — no separate graph database, no edge table to
keep in sync. The relationships you declared for content modeling are the graph.

## 2. `kernel.graph` — walk the neighborhood

```ts
const { nodes, edges, truncated } = await kernel.graph({
  collection: 'posts',
  id,
  depth: 2,        // hops from the seed; default 1, clamped to a max of 10
  maxNodes: 100,   // node budget; default 100, hard cap 500
  req,             // the request principal — access is enforced (see §5)
})
```

It runs a breadth-first walk from the seed, following outbound relationship/upload fields
and inbound reverse-relationship (`join`) fields, up to `depth` hops.

**The shape.** Two flat arrays — easy to feed into a graph renderer or a prompt:

```ts
type GraphNode = {
  ref: string        // '<collection>:<id>' — the stable node identity
  collection: string
  id: string
  label: string      // a human label, built only from readable fields
}

type GraphEdge = {
  from: string                          // a node ref
  to: string                            // a node ref
  field: string                         // the field the edge came from
  relationTo: string                    // the target collection
  kind: 'relationship' | 'reverse'      // outbound field, or inbound join
}
```

The seed is always the first node. `truncated` is `true` when a bound clipped the walk
(see below) — so you can tell a complete neighborhood from a partial one.

### Bounds (cycle-safe and DoS-safe)

A naive graph walk over richly linked content can fan out to the whole database. Every
traversal is bounded:

- **`depth`** — hops from the seed. Default `1`, **clamped to a maximum of 10**.
- **`maxNodes`** — total node budget. Default `100`, **hard cap 500**. When hit, the walk
  stops and `truncated: true`.
- **Per-node fan-out cap** — at most **200** edges are followed out of any single node, so
  one hyper-connected document can't blow the budget on its own.
- **Cycle-safe de-dupe** — each node is visited once (keyed by `ref`), so a cycle
  (`a → b → a`) terminates instead of looping.

## 3. `kernel.graphSearch` — GraphRAG retrieval

`graphSearch` is the retrieval flow for grounding an LLM: **semantic seeds → graph
expansion → context**.

```ts
const { seeds, nodes, edges, context, truncated } = await kernel.graphSearch({
  collection: 'posts',   // required when more than one collection is searchable
  query: 'who wrote about single-container deploys?',
  depth: 1,              // how far to expand each seed; same clamp as graph()
  limit: 5,              // number of seed documents to retrieve
  req,
})
```

The flow, step by step:

1. **Find seeds by meaning.** `query` runs through the same retrieval stack as
   [semantic search](semantic-search.md): semantic/hybrid first, falling back to full-text,
   then a plain `find`. The top documents become the **seeds**.
2. **Expand each seed through the graph.** Every seed is walked exactly like
   `kernel.graph(...)` — outbound and reverse edges, up to `depth` — and the subgraphs are
   merged (and de-duped) into one `{ nodes, edges }`.
3. **Build grounding context.** Each node contributes a `context` entry —
   `{ ref, label, text }`, a label plus a text snippet — assembled from *readable* fields.
   Drop the `context` array into an LLM prompt to ground its answer in the connected
   content.

```ts
type GraphSearchResult = {
  seeds: Doc[]                                           // the semantic matches
  nodes: GraphNode[]                                     // seeds + their expansions
  edges: GraphEdge[]
  context: Array<{ ref: string; label: string; text: string }>  // grounding for an LLM
  truncated: boolean
}
```

> **`graphSearch` needs `embeddings`.** The seed step is semantic/hybrid search, so it
> wants a configured embedder. Without one it degrades gracefully — full-text, then plain
> `find` — so it still returns seeds, just ranked by keyword rather than meaning. The graph
> expansion and the access guarantee are identical either way. See
> [semantic search §1](semantic-search.md) for configuring an embedder.

Because `graphSearch` resolves seeds by collection, pass an explicit `collection` when more
than one collection is searchable; with a single searchable collection it can be omitted.

## 4. The REST surface

Both ops are exposed over HTTP, access-checked to the request principal:

```bash
# Walk one document's neighborhood
curl "http://localhost:3000/api/posts/<id>/graph?depth=2&maxNodes=100"

# GraphRAG — semantic seeds expanded into their connected subgraph
curl "http://localhost:3000/api/graph-search?q=who%20wrote%20about%20deploys&collection=posts&depth=1"
```

`depth` and `maxNodes` map to the Local API arguments and obey the same clamps. `q` is the
query, `collection` selects the searchable collection, and `limit` caps the seed count.
These routes resolve the caller exactly like every other REST route — an anonymous request
only ever sees what `access.read` allows anonymously.

## 5. The access & bounds guarantee

This is what makes a knowledge graph safe to expose to agents and users alike:
**every node is loaded through the access-checked read path** — the same pipeline as a
normal `findByID`, evaluated against the caller's access.

- **A node you can't read is dropped — and so is the edge to it.** The walk never includes
  a document the caller can't read, *and it omits the edge that pointed at it*. The
  relationship's very existence never leaks: a caller can't infer "this post links to a
  document I'm not allowed to see" from a dangling edge, because there is no dangling edge.
- **Read-denied fields never surface.** A node's `label` and a `context` entry's `text`
  are built only from fields the caller can read. Field-read access is applied before the
  label/snippet is composed, so a restricted field never appears in the graph.
- **Bounds prevent traversal DoS.** `depth` (clamp 10), `maxNodes` (cap 500), the per-node
  fan-out cap (200), and cycle-safe de-dupe mean a single call can't walk the whole
  database or loop forever. When a bound clips the result, `truncated` says so.

Combined with [deny-by-default access](conventions.md#access-is-deny-by-default) and the
draft-only AI-agent principal, you can point an agent at `kernel.graphSearch(...)` and
trust it retrieves only the connected context its scope allows — and that the graph itself
never reveals a relationship to something it can't see.

Remember the boundary: `graph`/`graphSearch` do **retrieval**. They gather the subgraph and
the grounding `context`; the LLM call that turns that context into an answer is yours.

---

See [semantic-search.md](./semantic-search.md) for the seed-retrieval stack this builds on,
[conventions.md](./conventions.md#join-reverse-relationship-fields) for the `join` field
that provides inbound edges, and the README's **Knowledge graph & GraphRAG** section for
the one-paragraph version.
