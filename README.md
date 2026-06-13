<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/kernelcms-logo-dark.svg" />
    <img alt="KernelCMS" src="brand/kernelcms-logo.svg" width="380" />
  </picture>
</p>

<p align="center">
  <a href="https://github.com/RobbinPilhede/KernelCMS/actions/workflows/ci.yml">
    <img alt="CI" src="https://github.com/RobbinPilhede/KernelCMS/actions/workflows/ci.yml/badge.svg" />
  </a>
</p>

<p align="center"><strong>The lightweight, standalone, type-safe headless CMS that does not hijack your framework.</strong></p>

<p align="center">
  <a href="https://kernelcms.com">Website</a> ·
  <a href="https://kernelcms.com/docs/introduction">Documentation</a> ·
  <a href="https://github.com/RobbinPilhede/KernelCMS">GitHub</a>
</p>

KernelCMS is a config-as-code, end-to-end TypeScript headless CMS. You model your
content in a single `kernel.config.ts`, and you get a typed content engine, a REST and
GraphQL API, a typed in-process Local API, a polished React admin panel, and a CLI.
Pick your own database, storage, email, image processor, and auth providers through
small adapter contracts. Run it fully self-hosted on a single container.

And when the built-in CRUD is not enough, you build your own: typed custom endpoints,
computed fields, and whole feature **modules** (collection + endpoints + jobs in one
unit). Everything is type-safe, access-controlled, and auto-documented with a built-in
OpenAPI spec and an interactive API reference.

```bash
npm install kernelcms     # then add a kernel.config.ts and run: npx kernel dev
```

---

## Why KernelCMS

Most modern headless CMSs make you adopt their whole world: a specific framework, a
heavy dependency tree, a particular database, and a build pipeline you do not control.
KernelCMS takes the opposite stance.

|                            | KernelCMS                                                                                      | Typical heavyweight CMS                                      |
| -------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **Framework coupling**     | None. A web-standard `Request` to `Response` server that runs on Node, edge, or any container. | Often welded to one framework that then owns your whole app. |
| **Default database**       | SQLite via Node's built-in `node:sqlite`. Zero native dependencies.                            | Mongo or Postgres, with heavier setup.                       |
| **Install and cold start** | Light and fast.                                                                                | Large dependency tree, slow boots.                           |
| **Dev loop**               | `npx kernel dev` plus a single inlined admin bundle.                                           | A full framework build pipeline.                             |
| **Migrations**             | Diff-based, risk-classified, deterministic.                                                    | Frequently a pain point.                                     |
| **Deploy**                 | One container, anywhere.                                                                       | Often tied to one host shape.                                |
| **Heavy features**         | Optional adapters (email, image, OAuth). Core stays tiny.                                      | Batteries baked into the core install.                       |

The guiding rule of the whole codebase: heavy or opinionated dependencies live behind
optional adapters, never in `@kernel/core`. The lean default is the product.

One more stance worth calling out: KernelCMS is **RAG-native**. Bring any embedder and a
collection's content is indexed into a vector store on every write, with built-in
semantic and hybrid (Reciprocal Rank Fusion) search served through the same
access-checked read path. Your CMS *is* your RAG knowledge base, instead of a CMS plus a
Lambda plus a separate vector database you have to keep in sync.

And the same content engine is **AI-discoverable**. Opt into `discoverability` and KernelCMS
serves `llms.txt`, a full-text corpus, retrieval-ready content chunks, and per-document
GEO markdown with provenance-backed citations — so answer engines (ChatGPT, Claude,
Perplexity, Google AI) can ingest and cite your content. Every byte is generated as an
anonymous principal over the same access-checked read path: only published, publicly
readable content ever ships.

And it emits **structured data**. Opt into `structuredData` and KernelCMS generates
schema.org **JSON-LD** for any collection straight from your typed model — so search
engines get rich results and AI answer engines get machine-understandable facts, without
you hand-writing `<script type="application/ld+json">` by hand. Smart defaults map your
fields to schema.org properties (override per-collection), and every read goes through the
same access-checked pipeline: a draft, private, or read-denied document or field is never
emitted, and the embeddable `<script>` is HTML-escaped so content can't break out of the
tag. With semantic search and llms.txt/GEO it completes the discoverability trio.

It is also the **agentic CMS**. Define `workflows` and an agent can run an autonomous
content pipeline — ideation → draft → quality gate → human review — entirely inside the
engine, with hard guardrails. Every step runs as a scoped agent principal: it physically
cannot publish (draft-only brake), cannot write outside its `fieldScope`, and never gets
`overrideAccess`. Content only advances through `evalGate` (your content-CI quality
checks) and `requestReview` (a human approval in the inbox). Hand a job to an agent;
nothing it produces goes live unchecked.

It is also **real-time**. Opt into `realtime` and every content write lands on a durable,
access-filtered change feed: pull it with cursor-based polling (`kernel.changes` / `GET
/api/changes`) for CDC pipelines, or subscribe to a live Server-Sent-Events stream (`GET
/api/changes/stream`) for UIs that update as content moves. Events are **metadata only**
and filtered per subscriber — a caller is never even told that a document they can't read
changed. Reactive admin UIs, agents that react to content, and search re-indexers stay in
sync over the *same* access-checked engine, not a side channel around it.

And content has a **time-machine**. On any collection with `versions` enabled, you can
read a document (or a whole list) as it existed at any past instant (`asOf`), walk its
complete change timeline, diff any two points field-by-field, and revert in one call —
*git for content*, built on the version history KernelCMS already keeps. Every
historical read, diff, and restore goes through the **same** access checks and
field-stripping as a live read: time-travel is a view into the access-checked engine,
never a side door around it.

---

## Quickstart

A working CMS, an admin panel, and a typed REST + GraphQL API in three steps.

### 1. Install

```bash
npm install kernelcms
```

### 2. Add a `kernel.config.ts`

```ts
import { defineConfig } from 'kernelcms'
import { sqliteAdapter } from 'kernelcms/sqlite'

export default defineConfig({
  // Set KERNEL_SECRET in production; anything works locally.
  secret: process.env.KERNEL_SECRET ?? 'dev-only-secret',
  db: sqliteAdapter({ url: 'file:./content.db' }),
  collections: [
    {
      slug: 'users',
      auth: true, // email + password sign-in, included
      fields: [{ name: 'name', type: 'text' }],
    },
    {
      slug: 'posts',
      access: { read: () => true }, // public reads
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'body', type: 'richText' },
        { name: 'author', type: 'relationship', relationTo: 'users' },
      ],
    },
  ],
})
```

### 3. Run it

```bash
npx kernel dev
```

That creates the database tables, starts the server, and gives you:

- **Admin panel** at http://localhost:3000/admin (the first visit asks you to create your admin account)
- **REST API** at http://localhost:3000/api/posts
- **GraphQL** at http://localhost:3000/api/graphql
- **API reference** at http://localhost:3000/api/docs (OpenAPI spec at `/api/openapi`)

> Prefer a head start? `npx kernel init` scaffolds this `kernel.config.ts` for you.

Edit `kernel.config.ts`, refresh, and the admin and APIs update with it. That is the whole setup.

```bash
# try the API
curl http://localhost:3000/api/health
curl "http://localhost:3000/api/posts?where[title][like]=hello&depth=1"
```

> Needs Node 22.18+ or 24 (it runs your TypeScript config directly, no build step).

---

## Go further

Everything is opt-in on the same config. A few one-liners unlock a lot:

```ts
{
  slug: 'posts',
  versions: { drafts: true }, // drafts, version history, scheduled publish
  fields: [
    { name: 'cover', type: 'upload', relationTo: 'media' },
    // polymorphic relationship to more than one collection
    { name: 'related', type: 'relationship', relationTo: ['posts', 'pages'], hasMany: true },
  ],
}
```

- **Auth:** `auth: { forgotPassword: true, twoFactor: true }` adds email password reset and TOTP two-factor.
- **Uploads + images:** add `storage: localStorage(...)` (or S3 / R2) and `imageSizes` for auto-resized variants.
- **Postgres:** swap `sqliteAdapter` for `postgresAdapter()` and set `DATABASE_URL` (or pick it in the first-run Connectors step). Configs scaffolded by `npx kernel init` are already env-driven: set `DATABASE_URL` and they use Postgres, otherwise a local SQLite file.
- **Caching:** add `cache: memoryCache()` (or `dbCache()` / `redisCache()`) and mark a collection `cache: true`. Reads are served read-through and invalidated automatically on write.
- **Search:** add `search: memorySearch()` and give a collection `search: { fields: ['title', 'body'] }`, then `kernel.searchDocs({ collection, query })`. Hits are loaded through the access-checked read path, so search never surfaces a document the caller cannot read.
- **Semantic & hybrid search (RAG-native):** set a pluggable `embeddings: { embed }` (your OpenAI/Cohere/local model — no embedding dependency baked in) and mark a collection's search `semantic: true`. Fields are embedded on every write into a vector store, and `kernel.semanticSearch(...)` / `kernel.hybridSearch(...)` (Reciprocal Rank Fusion of full-text + vector) plus `GET /api/:collection/semantic` and `/hybrid` are served through the same access-checked read path. Your CMS becomes your RAG knowledge base — see the [semantic search guide](docs/semantic-search.md).
- **Webhooks + rate limiting:** `webhooks: [{ url, secret }]` fires signed HTTP POSTs on change; the server rate-limits every endpoint (stricter on auth) and sends HSTS / Permissions-Policy headers.
- **Real-time change feed:** `realtime: { enabled: true }` turns on an access-filtered change feed — a durable pull feed for CDC and a live SSE push stream. See [Real-time](#real-time-change-feed-cdc--sse) below.
- **Payments & orders:** add the `commerce({ payment: stripePayment({ ... }) })` plugin and you get `products` + `orders` collections, a `POST /commerce/checkout` (totals recomputed server-side from real prices), and a signature-verified `POST /commerce/webhook` that transitions orders to paid/refunded. Stripe and a deterministic `testPayment()` adapter included.
- **AI agents (MCP):** register `agents: [{ id, token, roles, fieldScope }]` and serve your kernel over the Model Context Protocol — `npx kernel mcp` (stdio, for Claude Desktop / Cursor) or `kernel mcp --http` (multi-agent, per-request scoped tokens). Tools are auto-generated from the same model that builds the OpenAPI spec (CRUD, count, version history, your opt-in `defineEndpoint` business logic, plus `kernel://schema` resources to introspect), and every call runs through the in-process Local API as a scoped principal — so an agent goes through the **same access pipeline as a human**: it only touches the fields you allow, **cannot publish** (drafts only, enforced by the engine), and is attributed in version history. The MCP layer enforces nothing on its own. Import from `kernelcms/mcp`; the MCP SDK is an optional peer dependency.
- **Agentic workflows:** define `workflows: [{ slug, agent, trigger, steps }]` and an agent runs an autonomous content pipeline (draft → quality gate → human review) under the same guardrails as MCP. Triggers (`on: 'create' | 'update'`) enqueue a **durable** run via the jobs queue, so a slow agent step never blocks the content write; `runWorkflow(...)` / `POST /api/_admin/workflows/:slug/run` run a `manual` one. Content advances only through `ctx.evalGate(...)` (your content-CI evals) and `ctx.requestReview(...)` (human approval in the inbox) — the agent itself physically cannot publish. See [agentic workflows](docs/agentic-workflows.md).
- **Referential integrity:** give a relationship `onDelete: 'setNull' | 'cascade' | 'restrict'` to clean up references when a document is deleted.
- **Hooks, access rules, localization, background jobs, plugins:** all configured the same way.

See [What is in the box](#what-is-in-the-box) for the full list.

---

## Guides

The full documentation lives at **[kernelcms.com/docs](https://kernelcms.com/docs/introduction)**.
A couple of the guides are also kept alongside the source:

- **[Embedding in Next.js](docs/embedding-nextjs.md)** — mount the full CMS (REST,
  GraphQL, admin) inside a Next.js app: the kernel singleton, the Node.js runtime,
  external native packages, and rate limiting behind a platform proxy.
- **[Conventions & defaults](docs/conventions.md)** — the small non-obvious rules:
  deny-by-default access, `overrideAccess`, drafts→publish, stored vs. virtual
  computed fields, `defaultSort`, the seed convention, env vars, CLI flags, and
  the `.ts` type-stripping requirements for config files.

---

## Build anything: modules & custom endpoints

Collections give you typed CRUD for free. When you need real behavior, add **custom
endpoints** with typed input/output, declarative access, validation through the same
error pipeline as core routes, and automatic inclusion in the OpenAPI docs and typed
client:

```ts
import { defineEndpoint } from 'kernelcms'

defineEndpoint({
  method: 'POST',
  path: '/posts/:id/publish',
  access: ({ req }) => Boolean(req.user), // secure by default (authenticated only)
  handler: async ({ input, ctx }) =>
    // ctx = { req, user, local (the typed Local API), logger, request }
    ctx.local.update({ collection: 'posts', id: input.params.id, data: { _status: 'published' } }),
})
```

Bundle a whole feature (collection + endpoints + jobs) into one installable,
conflict-checked **module**:

```ts
import { defineModule, defineEndpoint, defineConfig } from 'kernelcms'

export const comments = defineModule({
  name: 'comments',
  version: '1.0.0',
  collections: [{ slug: 'comments', access: { read: () => true }, fields: [/* … */] }],
  endpoints: [defineEndpoint({ method: 'POST', path: '/comments/:postId', access, handler })],
  jobs: [{ slug: 'moderate-comments', handler: async () => {/* … */} }],
})

export default defineConfig({ /* … */, plugins: [comments] })
```

Scaffold one with `npx kernel generate:module comments`. Input validation accepts any
Zod-compatible schema (`{ parse }`); no Zod dependency is forced on the core.

**Computed fields** derive a value from a single `compute` function, so business
logic lives in one place and stays read-only in the admin. A `virtual` field is
derived on read and not stored; drop `virtual` for a **stored** computed field
that is persisted at write time and therefore sortable and filterable:

```ts
// virtual: derived on read, not stored (not sortable)
{ name: 'word_count', type: 'number', virtual: true,
  compute: ({ doc }) => countWords(doc.body) }

// stored: derived on write, persisted to a real column (sortable/filterable)
{ name: 'sort_key', type: 'number', index: true,
  compute: ({ doc }) => new Date(doc.starts_at).getTime() }
```

---

## What is in the box

### Content modeling

- Collections and singleton globals, defined as code with full type inference.
- A rich field set: text, textarea, email, slug, code, number, boolean, checkbox,
  date, select, radio, json, point, group, array, blocks (a page builder), rich text,
  relationship, and upload.
- Reverse relationships through a virtual `join` field, plus polymorphic
  relationships with `relationTo: ['a', 'b']`.
- Referential integrity per relationship/upload field: `onDelete: 'setNull' | 'cascade'
| 'restrict'` (with cycle protection) decides what happens to references when a
  document is deleted.
- Presentational layout containers: rows, tabs, and UI slots.
- Computed (virtual) fields: `virtual: true` + `compute({ doc, req })`, derived on read,
  never stored, read-only in the admin.
- Per-field localization with a configurable locale set and fallbacks.
- Conditional fields, default values, validation, read-only and hidden flags, and
  sidebar field positioning.

### Data and APIs

- Collection-level and field-level access control that returns a boolean or a row-level
  filter, with role-based rules.
- Lifecycle hooks: `beforeChange`, `afterChange`, `afterRead`, `beforeDelete`, and
  `afterDelete`.
- Auto-generated REST API with filtering, sorting, pagination, relationship depth, and
  bulk operations.
- An auto-generated GraphQL endpoint.
- Custom typed endpoints (`defineEndpoint`) and feature modules (`defineModule`) that
  bundle a collection + endpoints + jobs as one conflict-checked unit.
- A generated OpenAPI spec at `/api/openapi` and an interactive API reference at
  `/api/docs`, covering collections, globals, and your custom endpoints.
- Localized, structured error responses (`{ error: { code, message } }`) rendered for
  the request's locale at the boundary.
- A fully typed in-process Local API with the exact same operations.
- Versions and drafts, including a draft and publish lifecycle and scheduled publishing.
  Publishing is a distinct, access-controlled transition: `access.publish` gates the
  draft → published edge separately from `update` (and falls back to `update` when
  omitted, so existing behavior is unchanged).

### Content time-machine (point-in-time reads, diff & restore)

On any collection with `versions` enabled, the version history becomes a queryable
*git-for-content* surface — no extra storage, no second access path. (Without
`versions`, these ops raise `BadRequestError` — there's no history to reconstruct.)

- **Point-in-time reads.** Pass `asOf: '<iso>'` to `kernel.findByID(...)` or
  `kernel.find(...)` and the engine reconstructs the document(s) from the latest
  snapshot with `createdAt <= asOf` (`null` if it didn't exist yet; current when
  `asOf` is omitted). List reads honor `where` / `limit` / `page`.
- **History timeline.** `kernel.history({ collection, id })` →
  `Array<{ versionId, at, by, byType, status, autosave, changedFields }>`, oldest →
  newest; `changedFields` are the fields that differ from the previous snapshot.
- **Field-level diff.** `kernel.diffVersions({ collection, id, from, to })` →
  `Record<field, { from, to }>`. `from`/`to` are each a versionId **or** an ISO
  timestamp (resolved to the snapshot at-or-before it).
- **Restore as-of.** `kernel.restoreAsOf({ collection, id, asOf })` reverts by writing
  that historical content through the **normal update path** — content fields only
  (`_status`/system columns excluded, so a restore is never a publish), no
  `overrideAccess`, the agent draft-only brake still applies, and it records a new
  version.

```bash
curl "http://localhost:3000/api/posts/<id>?asOf=2025-12-31T23:59:59Z"  # point-in-time read
curl "http://localhost:3000/api/posts?asOf=2025-12-31T23:59:59Z"       # point-in-time list
curl "http://localhost:3000/api/posts/<id>/history"                    # the change timeline
curl "http://localhost:3000/api/posts/<id>/diff?from=<a>&to=<b>"       # field-level diff
curl -X POST "http://localhost:3000/api/posts/<id>/restore-as-of?asOf=2026-06-01T00:00:00Z" # gated like an update
```

**The access-parity guarantee:** every historical read, diff, and timeline runs through
the *same* read-check and field-stripping as a live read, evaluated against the caller's
**current** access — no time-travel around revoked access. A caller who can't read the
doc now can't read its `asOf` state, `history`, or `diff`; a read-denied field never
appears in an `asOf` doc, in `changedFields`, or in a diff; historical drafts stay hidden
unless `draft: true`. See the [content time-machine guide](docs/time-machine.md).

### Search (full-text, semantic & hybrid)

- Adapter-based **full-text** search (`search: memorySearch()` + a collection's
  `search: { fields }`), with hits loaded through the access-checked read path.
- **RAG-native semantic search.** Supply a pluggable embedder — KernelCMS has no hard
  embedding dependency, so OpenAI, Cohere, or a local model all work — and a collection's
  fields are embedded on every write into a vector store (the built-in in-process
  `memoryVector()` by default; a pgvector adapter is the documented production follow-up).
- **Hybrid search** fuses full-text and vector results with Reciprocal Rank Fusion
  (RRF, k=60), the 2026-standard ranking. Both ops degrade gracefully — semantic-only with
  no full-text fields, full-text-only with no embedder.
- Every result goes through the **access-checked read path**: a vector hit for a document
  the caller cannot read is dropped, never leaked. `limit` is clamped (max 100) and
  `filter` is validated to real columns. Indexing is real-time (a governance requirement
  for AI agents), and an embed failure is logged (never with the text or key) without
  breaking the content write.

```ts
import { defineConfig } from 'kernelcms'
import OpenAI from 'openai'

const openai = new OpenAI()

export default defineConfig({
  search: memorySearch(), // full-text (hybrid fuses this with the vector store)
  embeddings: {
    // Bring any embedder; KernelCMS just needs string[] → number[][].
    embed: async (texts) => {
      const res = await openai.embeddings.create({ model: 'text-embedding-3-small', input: texts })
      return res.data.map((d) => d.embedding)
    },
  },
  collections: [
    {
      slug: 'posts',
      access: { read: () => true },
      search: { fields: ['title', 'body'], semantic: true }, // index + embed on write
      fields: [/* … */],
    },
  ],
})

// Local API — fused full-text + vector, access-checked:
const { docs } = await kernel.hybridSearch({ collection: 'posts', query: 'how do I deploy?', req })
// or pure vector: kernel.semanticSearch({ collection, query, limit, filter, req })
```

```bash
curl "http://localhost:3000/api/posts/semantic?q=how%20do%20I%20deploy&limit=10"
curl "http://localhost:3000/api/posts/hybrid?q=how%20do%20I%20deploy"
```

### Real-time change feed (CDC & SSE)

Opt in with `realtime: { enabled: true }` and every content write emits a change event
onto a durable, access-filtered feed. Two shapes are served from one source: a **pull
feed** for CDC pipelines (cursor polling) and a **live SSE push stream** for reactive UIs.
The feed is off by default; `retain` (default 10000, clamped) bounds the change outbox.

```ts
export default defineConfig({
  realtime: { enabled: true, retain: 50000 }, // off by default; retain = max outbox rows
  collections: [/* … */],
})
```

- **Durable pull (CDC).** `kernel.changes({ since, collection?, limit?, req })` →
  `{ changes, cursor }`; poll again with `since: cursor`. Each `ChangeEvent` is
  `{ seq, at, collection, documentId, event, principalType }` —
  `event` is `'create' | 'update' | 'delete' | 'publish' | 'unpublish'`. REST:
  `GET /api/changes?since=&collection=&limit=` (auth required).
- **Live push (SSE).** `GET /api/changes/stream?collection=` returns `text/event-stream`,
  emitting `id: <seq>` + `data: <json>` frames as changes happen, with `: ping`
  heartbeats; reconnect with `Last-Event-ID` to resume from the last `seq`. Auth required.
- **In-process subscribe.** `const off = kernel.subscribe((e) => { … })` returns an
  unsubscribe function — for server code, workflows, and live re-indexing.

```ts
// In-process: react to changes inside the server.
const off = kernel.subscribe((e) => {
  if (e.collection === 'posts') reindex(e.documentId)
})
// later: off()
```

```bash
curl "http://localhost:3000/api/changes?since=0&collection=posts&limit=100"  # pull (CDC)
curl -N "http://localhost:3000/api/changes/stream?collection=posts"          # live SSE
```

**The metadata-only, access-filtered guarantee:** an event carries **metadata only, never
the document body**, and the feed is **filtered per subscriber** — a subscriber is never
even told that a document they cannot read changed (the event is dropped entirely,
fail-closed; for deletes and row-scoped reads the filter requires a fully-public read
rule). The client re-fetches the actual document through the normal access-checked API.
Both endpoints require auth, retention and connection counts are bounded, and a feed-write
failure never breaks the content write. *(Honest notes: the hook-based feed emits
create/update/delete, so a publish currently reads as `update`; `seq` is per-node — single-node
ordering, multi-node needs a shared sequence.)* Pairs with [workflows](docs/agentic-workflows.md)
(react to a change) and search (live re-index). See the [real-time guide](docs/realtime.md).

### AI discoverability (llms.txt & GEO)

- **GEO-native.** Opt into `discoverability` and KernelCMS exposes your content to AI
  answer engines through the emerging **llms.txt** standard — an index of your content
  plus a full-text corpus, both with provenance/citation footers — so ChatGPT, Claude,
  Perplexity, and Google AI can ingest and *cite* it. Omitting the key disables the
  feature; defaults are safe — only collections with a public read and a title are
  exposed, never auth/upload/system collections (unless `include: true`).
- **Four ops, one access pipeline.** `kernel.llmsTxt()` (the index),
  `kernel.llmsFullTxt()` (the full markdown corpus), `kernel.contentChunks({ collection?,
  limit? })` (retrieval-ready chunks for RAG/GEO ingestion), and
  `kernel.geoDocument({ collection, id })` (one published doc as GEO markdown with a
  citation block — author, last-updated, canonical URL, and a signature-verified note
  when content credentials are configured).

```ts
export default defineConfig({
  discoverability: {
    title: 'Acme Blog',
    description: 'Guides and changelog from the Acme team.',
    baseUrl: 'https://acme.com',
    collections: [
      { slug: 'posts', titleField: 'title', descriptionField: 'excerpt',
        bodyField: 'body', urlPattern: '/blog/:slug' },
    ],
    // maxDocsPerCollection defaults to 1000, maxDocsTotal to 5000
  },
  collections: [/* … */],
})

// Local API — the llms.txt index (title, description, per-collection link lists):
const indexTxt = await kernel.llmsTxt()
```

```bash
curl http://localhost:3000/api/llms.txt          # text/plain — proxy to your site root /llms.txt
curl http://localhost:3000/api/llms-full.txt     # text/plain — the full content corpus
curl "http://localhost:3000/api/content-chunks?collection=posts&limit=50"  # JSON chunks
curl http://localhost:3000/api/posts/<id>/geo    # text/markdown — one doc, with citation
```

The **published-only guarantee:** every generator reads through the access-checked
pipeline as an *anonymous* principal filtering `_status === 'published'`, with no
`overrideAccess`. Drafts, scheduled-but-unpublished docs, access-restricted documents,
and read-denied fields never appear. Output is size-bounded by `maxDocsPerCollection`
(default 1000) and `maxDocsTotal` (default 5000). See the
[AI discoverability guide](docs/ai-discoverability.md). (`toMarkdown(richTextDoc)` is
also exported from `kernelcms/richtext`.)

### Structured data (schema.org JSON-LD)

- **JSON-LD from your model.** Opt into `structuredData` and KernelCMS generates
  schema.org [JSON-LD](https://json-ld.org) for a collection's documents — so search
  engines render rich results and AI answer engines get machine-understandable facts,
  generated automatically from your typed fields. Off until you add the block; you pick the
  schema.org `type` (`'Article'`, `'Product'`, `'Person'`, `'BlogPosting'`, …) per
  collection.
- **Smart defaults, explicit override.** With no `mapping`, the title / `useAsTitle` field
  becomes `name` + `headline`, the first rich-text/textarea becomes `articleBody` (plus a
  truncated `description`), a publish/posted/created date becomes `datePublished` (else
  `createdAt`) and updated/modified becomes `dateModified` (else `updatedAt`), `email` → `email`,
  an image/upload → `image` (URL), and an author-ish relationship → `author`
  (`{ '@type': 'Person', name }`). A `mapping: { schemaProperty: fieldName }` overrides the lot.

```ts
export default defineConfig({
  structuredData: {
    baseUrl: 'https://acme.com',
    collections: [
      { slug: 'posts', type: 'BlogPosting', urlPattern: '/blog/:slug' }, // smart defaults
      { slug: 'authors', type: 'Person', mapping: { name: 'full_name', email: 'contact' } },
    ],
  },
  collections: [/* … */],
})

// Local API — the JSON-LD object, or null:
const ld = await kernel.jsonLd({ collection: 'posts', id, req })
// or the ready-to-embed, HTML-escaped <script> string ('' when no doc):
const script = await kernel.jsonLdScript({ collection: 'posts', id, req })
```

```html
<!-- drop the escaped <script> into your page head -->
<head>{{ script }}</head>
```

```bash
curl http://localhost:3000/api/posts/<id>/jsonld   # application/ld+json (404 when null/disabled)
```

**The guarantees:** reads go through the same access-checked pipeline as every live read —
a draft, private, or read-denied document or field is **never** emitted (a public/anonymous
caller sees only published, publicly readable content). `jsonLdScript` HTML-escapes
`<`/`>`/`&` so content can't break out of the `<script>` tag (XSS-safe), and the `@id` /
`image` URLs are injection-safe (no `javascript:` / `data:` / path traversal). The
standalone op is the surface — it is not auto-injected into the GEO output. See the
[structured data guide](docs/structured-data.md).

### Agentic workflows (autonomous, governed AI pipelines)

Hand a job to an agent and let it run a multi-step content pipeline — ideation, draft,
quality gate, human review — without it ever being able to push something live. A
`workflow` names a scoped `agent`, an optional `trigger`, and ordered `steps`. Every step
runs through `ctx.kernel`, a Local-API subset (`find` / `findByID` / `create` / `update` /
`delete` / `count` / `composePage` / `findVersions`) pinned to that agent principal — a
step can't pass `overrideAccess` or a different principal — plus two gates:

```ts
export default defineConfig({
  agents: [{ id: 'writer', token: process.env.WRITER_TOKEN, roles: ['editor'],
             fieldScope: { allow: ['title', 'body', 'excerpt'] } }],
  workflows: [
    {
      slug: 'draft_from_brief',
      agent: 'writer',                       // every step runs as this scoped agent
      trigger: { on: 'create', collection: 'briefs' },
      maxAttempts: 3,
      steps: [
        {
          name: 'draft',
          async run(ctx) {
            // ctx.input is the trigger doc; ctx.kernel is pinned to `writer`
            const body = await generateWithYourLLM(ctx.input.brief) // your agent/LLM
            const post = await ctx.kernel.create({
              collection: 'posts',
              data: { title: ctx.input.title, body }, // a DRAFT — agents cannot publish
            })
            ctx.log(`drafted post ${post.id}`)
            // quality CI: runs the collection's `evals`; THROWS → the run fails
            await ctx.evalGate({ collection: 'posts', id: post.id })
            // pause as `awaiting_review`; a human approves (and publishes) in the inbox
            await ctx.requestReview({ collection: 'posts', id: post.id }, 'ready for review')
          },
        },
      ],
    },
  ],
})
```

```ts
// Local API — run a manual workflow, or read the durable run log:
const run = await kernel.runWorkflow({ slug: 'draft_from_brief', input })
const { docs } = await kernel.workflowRuns({ slug: 'draft_from_brief', status: 'awaiting_review' })
```

```bash
# REST (admin/editor-gated):
curl http://localhost:3000/api/_admin/workflow-runs?slug=draft_from_brief
curl -X POST http://localhost:3000/api/_admin/workflows/draft_from_brief/run -d '{ … }'
```

Triggers (`on: 'create' | 'update'`) enqueue a **durable** run via the jobs queue (drained
by `kernel jobs:run` / `runDueJobs`), so a slow agent step never blocks the content write;
`on: 'manual'` runs only via `runWorkflow` / the route. Runs move through
`pending → running → completed | failed | awaiting_review`, recorded per-step in
`_workflow_runs` (error **messages** only, never stacks or secrets) and decisioned as
`workflow.completed` / `workflow.failed` / `workflow.awaiting_review`.

**The guardrails are the whole point.** Every step is the scoped agent: it physically
cannot publish (draft-only brake), cannot write outside `fieldScope`, and never runs with
`overrideAccess`. Content advances **only** through `evalGate` (quality CI) and
`requestReview` → human approval — KernelCMS orchestrates and guards; the actual
generation is your agent/LLM inside a step, and approval publishes through the inbox path.
A self-triggering loop is guarded: an agent's own write into its trigger collection won't
re-fire its workflow.

### Auth

- Scrypt password hashing and stateless, JWT-compatible tokens.
- Per-document API keys for machine clients.
- Brute-force protection on login.
- Authority fields (`roles`, `permissions`, …) on auth collections are admin-write by
  default, so self-service privilege escalation is blocked out of the box.
- Email-based password reset and email verification, powered by a pluggable email
  adapter (console, memory, or HTTP, all dependency-free).
- TOTP two-factor auth, implemented on `node:crypto` with no extra dependencies.
- OAuth sign-in through a small provider adapter, with Google and GitHub presets.
- An AI agent is a first-class, access-controlled principal: register
  `agents: [{ id, token, roles, fieldScope }]` and it authenticates with its own
  constant-time-checked token, is scoped by a field allow/deny list, is **draft-only**
  (it physically cannot publish — a hard engine guarantee, never `overrideAccess`), and
  is attributed in version history. It flows through the same per-operation access
  pipeline as a human.
- The kernel serves over the Model Context Protocol (`@kernel/mcp`): CRUD, `count`,
  version-history, global, and opt-in custom-endpoint tools are auto-generated from the
  same descriptor as the OpenAPI spec and gated by your access rules. See
  [Go further](#go-further) for the CLI and transports.

### Media

- Uploads with local disk and S3 or R2 storage adapters.
- Optional image transforms (multiple sizes, focal point, format re-encode) through the
  `@kernel/image-sharp` adapter. Install it only if you need it; the core stays
  native-dependency-free.

### Admin panel

- A React app on TanStack Router, Query, and Table.
- A welcoming dashboard, list views with search, a filter builder, bulk actions, and
  column visibility, plus a config-driven editor for every field type.
- A rich text editor with a slash menu and a floating selection toolbar.
- Live preview with a built-in renderer, or point it at your own frontend.
- A guided first-run welcome with a Connectors step: choose your database,
  storage, email, or sign-in provider during setup. Pick PostgreSQL, paste a
  connection string, and KernelCMS writes `DATABASE_URL` to your `.env`; restart
  to apply it through the env-driven config. A Connectors panel in the sidebar
  lets you review and add connectors anytime.
- A command palette, light and dark themes, and smooth page and content animations.
- Extensible through `window.KernelCMS` registries: custom field components, list-cell
  renderers, and dashboard widgets.

### Tooling and operations

- A `kernel` CLI: `init`, `generate:module`, `generate:types`, `migrate`,
  `migrate:status`, `migrate:snapshot`, `seed`, `dev`, `start`, `jobs:run`, `import`,
  `info`, and `doctor`.
- Diff-based, risk-classified, deterministic schema migrations.
- TypeScript codegen from your content model.
- A background jobs system: define handlers, enqueue work, and drain due jobs from a
  cron with `kernel jobs:run`.
- A typed fetch client for browser, Node, and edge runtimes, including a
  `client.endpoint(...)` call for your custom endpoints.
- A plugin system that transforms config in dependency order, with an SEO plugin
  included as an example.

---

## Architecture in one line

`kernel.config.ts` (config as code) goes into `@kernel/core`, which compiles a schema
and runs every operation through defaults, access, hooks, validation, serialize,
adapter, and populate. That pipeline is exposed in-process as the Local API and over
HTTP by `@kernel/server`, consumed by the typed client and the TanStack admin. The core
depends only on contracts and never on a driver, which is what makes the database,
storage, email, image processor, and auth all swappable adapters.

---

## Packages

| Package                 | Responsibility                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `kernelcms`             | The published meta-package. Re-exports core plus adapters under subpaths.                              |
| `@kernel/core`          | Config, fields, operations, validation, access, auth, jobs, codegen, Local API.                        |
| `@kernel/db`            | The database adapter contract and query AST.                                                           |
| `@kernel/db-sqlite`     | SQLite adapter built on `node:sqlite`.                                                                 |
| `@kernel/db-postgres`   | Pooled PostgreSQL adapter.                                                                             |
| `@kernel/server`        | Web-standard `Request` to `Response` REST handler plus a Node http adapter.                            |
| `@kernel/graphql`       | GraphQL schema generation and executor.                                                                |
| `@kernel/mcp`           | MCP server: agent-safe, access-gated tools auto-generated from your model.                             |
| `@kernel/client`        | Typed fetch client.                                                                                    |
| `@kernel/cli`           | The `kernel` command-line tool.                                                                        |
| `@kernel/storage`       | Storage adapter contract with local, S3 or R2, and memory adapters, plus the image-processor contract. |
| `@kernel/image-sharp`   | Optional `sharp`-backed image processor.                                                               |
| `@kernel/richtext`      | Rich text schema, sanitization, and rendering.                                                         |
| `@kernel/admin-app`     | The React and TanStack admin panel.                                                                    |
| `@kernel/plugin-seo`    | Example plugin: SEO fields with optional auto-generation.                                              |
| `@kernel/testing`       | Test utilities.                                                                                        |
| `@kernel/create-kernel` | The `npm create kernel` scaffolder.                                                                    |

---

## Develop

```bash
pnpm typecheck                        # tsc across all packages
pnpm test                             # vitest: engine, HTTP API, adapters
pnpm --filter @kernel/admin-app build # bundle the admin
pnpm kernel -- --help                 # the CLI
```

---

## Security notes

- Secure by default: writes require authentication unless a collection opts into public
  access.
- No accidental privilege escalation: on an auth collection, authority fields (`roles`,
  `role`, `permissions`, `is_admin`, `is_staff`, `is_superuser`) are admin-write by
  default — even a user who can update their own record cannot promote themselves. An
  explicit field-level `access` rule overrides the default; trusted server paths
  (seed, first-admin setup, OAuth provisioning) still set them.
- SQL identifiers are validated and all values are parameterized.
- Passwords are scrypt-hashed and never returned. Reset, verification, and TOTP secrets
  are never exposed through the API, and their field names are kept out of the OpenAPI
  spec and config descriptor.
- No user-enumeration on the password reset and verification flows.
- Custom endpoints are secure by default (authenticated only) until you set an `access`
  rule, share the same validation and error pipeline, and cannot shadow built-in auth
  or system routes.
- Computed fields are evaluated after field-read access is applied, so they cannot leak
  a value the caller is not allowed to read.
- AI agents are scoped, draft-only principals on the same access pipeline: every call
  runs the collection's access rules with the agent's `fieldScope`, never sets
  `overrideAccess`, and cannot publish. The MCP layer enforces nothing on its own — the
  guarantees live in `@kernel/core`.
- Set `KERNEL_SECRET` in any non-local environment. For production CORS, use an explicit
  origin allow-list rather than a wildcard with credentials.

---

## License

MIT for the core.
