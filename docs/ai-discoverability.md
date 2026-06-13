# AI discoverability (llms.txt & GEO)

KernelCMS can publish your content for **AI answer engines** — ChatGPT, Claude,
Perplexity, Google AI — to ingest and cite. This is **GEO** (Generative Engine
Optimization): the SEO-for-LLMs discipline of making your content easy for a model to
read, retrieve, and attribute. The lever is one optional `discoverability` block, and
the surface it produces follows the emerging **llms.txt** standard.

The point: the same content engine that serves your site already knows your published
documents, their fields, and their access rules. Rather than hand-maintaining a separate
`llms.txt` file (and watching it drift), KernelCMS generates the index, a full-text
corpus, retrieval-ready chunks, and per-document citation markdown straight from the live
content — through the **same access-checked read path** as every other read.

> TL;DR: add a top-level `discoverability: { … }` listing the collections to expose, then
> serve `GET /api/llms.txt` (proxy it to your site's `/llms.txt`), or call
> `kernel.llmsTxt()` / `kernel.llmsFullTxt()` / `kernel.contentChunks(...)` /
> `kernel.geoDocument(...)` from the Local API. Omitting the block disables the feature.

---

## 1. What llms.txt and GEO are

`llms.txt` is a convention for a single, predictable file at a site's root that tells an
LLM what the site contains and where the canonical content lives — a sitemap written for
language models instead of crawlers. KernelCMS produces two related artifacts:

- **`llms.txt`** — an *index*: your site title and description, then per-collection lists
  of `- [title](url): summary` lines. Small, link-first, a map of your content.
- **`llms-full.txt`** — the *corpus*: every exposed document rendered as a `##` markdown
  section, each with a provenance/citation footer. This is the body an engine reads when
  it wants the actual content, not just the map.

GEO is the broader goal: structured, chunkable, attributable content that an answer
engine can lift a passage from *and cite back to your canonical URL*. KernelCMS leans on
the provenance and content-credentials work (see below) so those citations carry trust.

## 2. Configure `discoverability`

The feature is **off until you add the block**. When you do, defaults are conservative:
only collections that have a public read rule and a title field are exposed, and
auth/upload/system collections are never exposed unless you set `include: true` on them.

```ts
// kernel.config.ts
import { defineConfig } from 'kernelcms'

export default defineConfig({
  // …
  discoverability: {
    title: 'Acme Blog',
    description: 'Guides, deep-dives, and changelog from the Acme team.',
    baseUrl: 'https://acme.com',          // used to build absolute canonical URLs

    collections: [
      {
        slug: 'posts',
        titleField: 'title',              // defaults to a sensible title field
        descriptionField: 'excerpt',      // used for the per-link summary
        bodyField: 'body',                // rendered into llms-full.txt / geo markdown
        urlPattern: '/blog/:slug',        // :token resolves against the document
      },
      { slug: 'pages', urlPattern: '/:slug' },
    ],

    maxDocsPerCollection: 1000,           // default 1000
    maxDocsTotal: 5000,                   // default 5000
  },

  collections: [/* … */],
})
```

Per-collection options:

| Option             | Meaning                                                                     |
| ------------------ | --------------------------------------------------------------------------- |
| `slug`             | The collection to expose (required).                                        |
| `titleField`       | Field used as the document title in links and section headings.             |
| `descriptionField` | Field used as the per-link summary in `llms.txt`.                           |
| `bodyField`        | Field rendered into the corpus / GEO markdown (rich text is run through `toMarkdown`). |
| `urlPattern`       | Path template, e.g. `'/blog/:slug'`; `:token`s resolve against the document, joined to `baseUrl`. |
| `include`          | Force-expose a collection the safe defaults would skip (e.g. an opt-in case). |

The top-level `maxDocsPerCollection` (default **1000**) and `maxDocsTotal` (default
**5000**) bound the output regardless of how large your content set grows — see
[size caps](#7-size-caps).

## 3. The four operations

All four are on the Local API (`kernel.*`) and all read as an anonymous principal (see
[the security guarantee](#5-the-published-only-guarantee)).

```ts
// (a) The llms.txt index — title, description, per-collection `- [title](url): summary`.
const indexTxt = await kernel.llmsTxt()

// (b) The full corpus — every exposed doc as a `##` markdown section + citation footer.
const corpusTxt = await kernel.llmsFullTxt()

// (c) Retrieval-ready chunks for RAG / GEO ingestion.
const chunks = await kernel.contentChunks({ collection: 'posts', limit: 200 })
//   → Array<{ id, collection, title, url, text, tokensEstimate, updatedAt, provenance? }>

// (d) One published document as GEO-optimized markdown with a citation block, or null.
const md = await kernel.geoDocument({ collection: 'posts', id })
```

`contentChunks` takes an optional `collection` (omit it to chunk every exposed
collection) and an optional `limit`. Each chunk is self-describing — id, collection,
title, canonical `url`, the `text`, a `tokensEstimate`, `updatedAt`, and an optional
`provenance` block — which is exactly the shape a RAG ingester or a GEO pipeline wants.

`geoDocument` returns `null` when the document doesn't exist, isn't published, or isn't
readable anonymously — never a draft or a restricted doc. See
[provenance citations](#6-geodocument-and-provenance-backed-citations).

## 4. The REST surface

Each op has a public REST route. These are the routes an answer engine (or your own
proxy) hits — they take **no auth** and **only ever emit published, publicly readable
content**:

```bash
curl http://localhost:3000/api/llms.txt                       # text/plain  — the index
curl http://localhost:3000/api/llms-full.txt                  # text/plain  — the corpus
curl "http://localhost:3000/api/content-chunks?collection=posts&limit=50"  # JSON chunks
curl http://localhost:3000/api/posts/<id>/geo                 # text/markdown — one doc
```

`content-chunks` accepts the same `collection` and `limit` query params as the Local API
op. The `:collection/:id/geo` route returns `text/markdown`, or `404` when the document
isn't a published, anonymously-readable doc.

**Proxy `llms.txt` to your site root.** The de-facto convention is that the file lives at
`https://your-site.com/llms.txt`, not under `/api`. If your frontend and KernelCMS share
an origin (e.g. the [Next.js embedding](embedding-nextjs.md)), add a rewrite so `/llms.txt`
serves `/api/llms.txt` (and, if you like, `/llms-full.txt` → `/api/llms-full.txt`):

```js
// next.config.js
module.exports = {
  async rewrites() {
    return [
      { source: '/llms.txt', destination: '/api/llms.txt' },
      { source: '/llms-full.txt', destination: '/api/llms-full.txt' },
    ]
  },
}
```

Behind a standalone reverse proxy, the equivalent location block does the same job.

## 5. The published-only guarantee

This is the part that makes it safe to expose these routes to the open internet.

**Every generator runs through the access-checked read pipeline as an anonymous
principal, filtering `_status === 'published'` — and never sets `overrideAccess`.** That
single rule produces the whole guarantee:

- **Drafts never appear.** Only `_status === 'published'` documents are read.
- **Scheduled-but-unpublished docs never appear.** A doc waiting on a future `publishAt`
  is still a draft until the publish flips it.
- **Access-restricted docs never appear.** A collection whose `read` rule denies
  anonymous callers contributes nothing — the same reason the safe defaults skip
  collections without a public read.
- **Read-denied fields never appear.** Field-level access is applied before the document
  is rendered, so a field an anonymous caller can't read is absent from the corpus and
  the citation markdown.

There is no second code path. The same access checks that protect `GET /api/posts` for an
anonymous browser protect `llms.txt`, `llms-full.txt`, `content-chunks`, and `/geo`. If
you wouldn't serve a document to a logged-out visitor, no answer engine sees it either.

## 6. `geoDocument` and provenance-backed citations

`geoDocument({ collection, id })` (and `GET /api/:collection/:id/geo`) renders one
published document as GEO-optimized markdown with a **citation block** — author,
last-updated date, and the canonical URL built from `baseUrl` + `urlPattern`. The corpus
(`llms-full.txt`) and each `contentChunks` entry carry the same provenance footer.

This builds on KernelCMS's provenance and **content credentials** work. When a document
is signed via content credentials, its citation block additionally carries a
**signature-verified note** — a machine-checkable assertion that the content is the
unmodified, attributed original. If signing isn't configured, the citation still carries
author, date, and canonical URL; it simply omits the verified-signature line. The aim is
that when an answer engine quotes you, the attribution it surfaces is trustworthy, not a
guess.

Rich-text bodies are rendered to markdown for all of these surfaces via the exported
helper:

```ts
import { toMarkdown } from 'kernelcms/richtext'

const md = toMarkdown(post.body) // the same renderer used by the GEO generators
```

## 7. Size caps

GEO output is bounded so a large content set can't produce an unbounded response:

- **`maxDocsPerCollection`** — at most this many documents per exposed collection
  (default **1000**).
- **`maxDocsTotal`** — at most this many documents across all collections (default
  **5000**).

The caps apply to `llms.txt`, `llms-full.txt`, and `contentChunks` alike. If you have
more content than fits, expose your most citation-worthy collections (and tune the caps)
rather than emitting everything — a focused, accurate corpus serves answer engines better
than an exhaustive one.

---

See [conventions.md](./conventions.md) for the deny-by-default access model the
published-only guarantee builds on, [semantic-search.md](./semantic-search.md) for the
RAG retrieval ops these chunks feed, and the README's **AI discoverability** section for
the one-paragraph version.
