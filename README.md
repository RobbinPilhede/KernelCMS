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

Building on that, your content is also a **knowledge graph**. Your typed relationships
*are* the edges, so `kernel.graph(...)` walks a document and its connected neighbors
(outbound relationship/upload fields **and** inbound reverse-relationship joins), and
`kernel.graphSearch(...)` does **GraphRAG** — semantic search finds the seed documents,
then the graph expands each into its connected subgraph and returns a ready-to-ground
`context` array. You retrieve not just the matching document but its connected context —
the cutting-edge RAG technique — straight from the relationships you already modeled.
Every node is loaded through the same access-checked read path, and a node the caller
can't read (and the edge to it) is simply omitted.

And those embeddings power **content intelligence** beyond search. `kernel.relatedContent(...)`
returns the documents semantically most like a given one — built-in "more like this" for
internal-linking and recommendations — and `kernel.findDuplicates(...)` surfaces
near-duplicate / redundant pairs for content-quality and dedupe cleanups, straight from the
vectors you already index. Both run through the **same access-checked read path**: a related
or duplicate result never surfaces (or even implies the existence of) a document the caller
can't read, a duplicate pair touching a hidden doc is dropped whole, and the dedup scan is
bounded — an admin operation, not a hot path.

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

And content ships in **releases**. Opt into `releases` and you can bundle a set of draft
documents — a landing page, three posts, an updated pricing global — into a named
release and publish them **together, atomically**, optionally on a schedule. Preview the
whole bundle as it will read, then go live with an **all-or-nothing pre-flight**: every
member is dry-run through the same per-document publish gate (publish access, the agent
draft-only brake, the blocking eval/content-CI gate) and if *any* would fail, *none*
publish — no half-launched campaign. Publishing a release is held to the exact same bar
as a direct publish (a caller can only publish a release whose every member they could
publish directly; an agent can never publish one), so coordinated launches stay as safe
as a single edit. This is the practical heart of *content environments*.

And content starts from **templates**. Opt into `templates` and you define reusable
document skeletons — a landing-page block `layout`, a standard article shell, a pre-filled
campaign brief — and give editors a "New from template" that pre-fills a fresh document in
one click. `kernel.createFromTemplate({ template, data })` deep-merges the template's
defaults with the caller's overrides (caller wins) and creates the document through the
**normal create pipeline** — so it is exactly a create: access control, field scope,
validation, and the agent draft-only brake all apply. A caller who can't create can't use
a template, an agent's result is still a draft (a template setting `_status: 'published'`
never publishes for an agent), out-of-scope fields are stripped, the caller's override is
prototype-pollution-guarded, the frozen config can't be mutated between instantiations, and
a template only ever creates into its configured collection. Skeletons, not a side door.
Red-teamed to Risk LOW.

And content has a **lifecycle**. The inverse of scheduled publish: opt into `lifecycle`,
put an expiry date on a published document, and when it passes the next cron drain
automatically retires it — `unpublish` back to draft, `archive` (draft + a server-managed
`_archived_at` that hides it from public reads and marks it as archived, not merely
unpublished), or `delete`. Embargoes, time-limited campaigns, retention/compliance, and
stale-content cleanup, on autopilot. The drain (`kernel.processContentLifecycle(...)`) is a
**trusted, cron-only** maintenance op like `processScheduledPublishes` — there is no HTTP
trigger, so it runs safely under override — and `_archived_at` is **client-immutable**: a
normal caller can never set it (fake-archive) or clear it (un-archive); only the drain
writes it. Each retire is audited (`content.expire`).

And content can **personalize**. Opt into `audiences` and any field becomes
`personalized: true` — it stores audience variants the way `localized` stores locales,
resolving per request (`?audience=vip` or `req.audience`) to that segment, then the default,
then null. Built-in A/B testing rides the same model: declare `experiments` and
`kernel.assignVariant({ experiment, key })` gives **deterministic sticky bucketing** of a
visitor — the same key always gets the same variant, the variant *is* a segment, and only a
hash of the key is ever stored (no PII at rest). Variants still pass field read-access, an
untrusted audience is honored only if it's a configured segment, and per-segment writes
merge without clobbering each other — micro-experiences and experiments from the same typed
model, no separate personalization platform.

And content **translates itself**. Configure a pluggable `translation` provider — DeepL,
OpenAI, Google, or a local model; KernelCMS has no hard translation dependency — and
`kernel.translateDocument(...)` / `kernel.translateMissing(...)` auto-fill the missing
locales of your localized fields with the provider of your choice. A translation is a
**normal access-checked write**, not a side door: it goes through update access (the
caller must be able to edit the doc), strict-mode per-locale required validation still
applies, the agent draft-only brake still holds (a translation never auto-publishes), and
it merges — other locales are never clobbered (fills only MISSING values unless you pass
`overwrite`). The provider closure may hold an API key; its text and errors **never leak**
(a failure surfaces a generic message, source/target text is never logged) and a provider
fault can't corrupt the doc (no partial write). Pairs with localization strict mode and
the translation-status dashboard. Red-teamed to Risk LOW.

And content comes with **analytics**. Opt into `analytics` and KernelCMS records a
content event for every view, search, conversion, and — uniquely — every AI retrieval,
then rolls them up into aggregate insights (`top_content`, `top_queries`,
`variant_performance`, `activity`, and an `ai_retrieval_leaderboard`). With
`autoCapture`, semantic/hybrid/graph search and `assignVariant` emit those signals
themselves, so you see not just how your content performs but **how AI answer engines
retrieve it**, from the same model. It is **privacy-first**: no third-party analytics and
**no PII** — the event row has no user/IP/visitor/email column at all, the principal is
never recorded, and `track` strips PII-ish keys from `meta`. Insights are aggregates only,
filtered to collections the caller can read. Red-teamed to Risk LOW.

And content is built for the **edge**. Opt into `edge` and a public, published read carries
the cache headers a CDN needs — your configured `Cache-Control` plus a `Surrogate-Key` listing
the response's **cache tags** (`<collection>`, `<collection>:<id>`, and, by default, the docs it
references). A change-driven **purge feed** (`kernel.purgeFeed(...)`) maps recent writes — and the
docs that *reference* them — back to exactly those tags, so a CDN worker invalidates only the
content that actually changed, provider-agnostically (you emit the tags + purge list; wire it to
Cloudflare/Fastly/Vercel). Safe by construction: a private, authenticated, scoped, draft, or
time-travel response is **never** handed a public/`s-maxage` `Cache-Control` or a surrogate key —
it gets `private, no-store` — so private content is never cached at the edge. Cache aggressively,
invalidate precisely. Red-teamed to Risk LOW.

And it runs **multi-tenant**. Opt into `tenancy` and one KernelCMS instance hosts many
clients, sites, or workspaces with **airtight per-tenant data isolation — and zero
per-collection access boilerplate**. KernelCMS auto-adds a server-managed `tenant` field to
each scoped collection and AND-combines a tenant scope into its access rules (it never
widens yours), so every find/update/delete/count is automatically filtered to the caller's
tenant. The headline is *where the tenant comes from*: it is resolved from the
**authenticated principal** (`req.user.tenant`), **never** a client query param, body field,
or header — so a tenant A principal can never read, list, count, update, or delete (or
populate, or move a document into) tenant B's content, a tenant-less principal sees nothing
(fail-closed), and only `overrideAccess`/system code (migrations, admin tooling) bypasses it.
The SaaS-on-KernelCMS and agency enabler. Red-teamed across 35 cross-tenant attacks to Risk
LOW, zero leaks.

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
- **Webhooks + rate limiting:** `webhooks: [{ url, secret }]` fires signed HTTP POSTs on change — inline best-effort or `durable: true` for at-least-once retry, with an SSRF egress guard and an admin delivery log (see [Outbound webhooks](#outbound-webhooks-with-durable-delivery)); the server rate-limits every endpoint (stricter on auth) and sends HSTS / Permissions-Policy headers.
- **Real-time change feed:** `realtime: { enabled: true }` turns on an access-filtered change feed — a durable pull feed for CDC and a live SSE push stream. See [Real-time](#real-time-change-feed-cdc--sse) below.
- **Content analytics:** `analytics: { enabled: true, autoCapture: true }` records a content event per interaction (`kernel.track(...)`) and rolls them up (`kernel.insights(...)`) — including an `ai_retrieval_leaderboard` of what AI answer engines retrieve. Privacy-first: no third-party analytics, no PII at rest. See [Content analytics](#content-analytics--insights-incl-ai-retrieval-privacy-first) below.
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
- **[Personalization & A/B](docs/personalization.md)** — `personalized` fields and
  audience variants, the `audiences` config, reading/writing segments (merge semantics),
  deterministic A/B `experiments` with `assignVariant`, and the access/PII guarantees.

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
- Per-field **personalization**: `personalized: true` stores audience variants (like
  `localized`, but keyed by segment) against a configured `audiences` set, plus built-in
  deterministic A/B `experiments`. See [Personalization & A/B](#personalization--ab-experiments).
- Conditional fields, default values, validation, read-only and hidden flags, and
  sidebar field positioning.

### Content templates (reusable document skeletons)

Opt into `templates` and you define reusable **document skeletons** — a landing-page
block `layout`, a standard article shell, a pre-filled brief — that editors instantiate
with one "New from template" click. Each template names a target `collection` and a `data`
object of default field values (which may include a blocks `layout`, default text, etc.).
It is opt-in; `data` is **deep-frozen**, so one instantiation can never mutate the defaults
for the next.

```ts
export default defineConfig({
  templates: [
    {
      slug: 'landing_page',        // unique, snake_case
      collection: 'pages',
      name: 'Landing page',
      description: 'Hero + feature grid + CTA',
      data: {
        title: 'Untitled landing page',
        layout: [
          { blockType: 'hero', heading: 'Headline goes here' },
          { blockType: 'features', items: [] },
          { blockType: 'cta', label: 'Get started', href: '/signup' },
        ],
      },
    },
  ],
  collections: [/* … a `pages` collection with a blocks `layout` field … */],
})
```

- **List templates (metadata only).** `kernel.listTemplates({ collection? })` returns
  template **metadata** — `slug`, `collection`, `name`, `description`, optionally filtered
  by collection — and **never** the raw `data`. REST: `GET /api/_admin/templates?collection=`
  (admin/editor-gated).
- **Create from a template.** `kernel.createFromTemplate({ template, data?, req })` looks up
  the template, **deep-merges** its defaults with the caller's `data` (the caller wins on
  conflicts; nested objects merge), and creates the document through the **normal create
  pipeline**. Returns the created document. REST: `POST /api/:collection/from-template` with
  body `{ template, data? }`, created as the request principal — and the route's
  `:collection` **must match** the template's `collection`.

```ts
const page = await kernel.createFromTemplate({
  template: 'landing_page',
  data: { title: 'Spring launch' }, // overrides the template default; layout is inherited
  req,
})
```

```bash
curl "http://localhost:3000/api/_admin/templates?collection=pages"             # metadata only
curl -X POST "http://localhost:3000/api/pages/from-template" \
  -d '{"template":"landing_page","data":{"title":"Spring launch"}}'            # :collection must match
```

**The normal-create guarantee:** create-from-template is a create, not a side door. A
caller who can't create in the collection can't use a template; an agent's result is still
a **draft** (a template setting `_status: 'published'` never publishes for an agent);
out-of-scope fields are stripped by field scope; validation runs. The caller's `data`
override is **prototype-pollution-guarded**, the template's config is **frozen** (one
instantiation can't change the next), and a template only ever creates into its configured
collection. Red-teamed to Risk LOW. See the
[content templates guide](docs/content-templates.md).

### Content snippets (reusable fragments)

Flag a collection `snippet: true` and it becomes a **library of reusable content fragments**
— a CTA, a promo banner, a block of legal text — that you define once and reference from
anywhere with a `snippet`-typed field. A reference stores only the fragment's **id**; on read
it **transcludes** the live fragment, so editing the fragment once updates every document that
points at it. A single field references one fragment; `hasMany: true` references an ordered
list.

```ts
export default defineConfig({
  collections: [
    { slug: 'snippets', snippet: true, fields: [
      { name: 'label', type: 'text' },
      { name: 'body', type: 'richText' },
    ] },
    { slug: 'pages', fields: [
      { name: 'title', type: 'text' },
      { name: 'cta', type: 'snippet', snippet: 'snippets' },             // one fragment
      { name: 'banners', type: 'snippet', snippet: 'snippets', hasMany: true }, // an ordered list
    ] },
  ],
})
```

- **Transclusion on read.** Populated like a relationship: pass `depth` (REST `?depth=1`,
  Local API `{ depth: 1 }`) and the stored id is replaced by the **live** snippet document.
  At `depth: 0` the field stays the raw id.
- **Access-checked.** Each fragment resolves through the normal access-checked read path; a
  fragment the reader can't read falls back to its **raw id**, never its content — exactly
  like a relationship to an unreadable target.
- **Cycle-safe.** Snippet→snippet references are bounded by the populate **depth cap (10)**,
  so a cyclic reference can never infinite-loop.
- **Config-validated.** A `snippet` field may only target a collection flagged `snippet:
  true`; a bad target throws at config load.

**The edit-once guarantee:** a snippet field is a relationship to a snippet library, resolved
**live** on read — the content is transcluded, never copied. There is one source of truth, so
fixing a typo in a fragment fixes it everywhere on the next read, with no document to chase and
no snapshot to go stale. Red-teamed to Risk LOW. See the
[content snippets guide](docs/content-snippets.md).

### Editorial comments (threaded review annotations)

Set `comments: true` and editors can leave **threaded review comments** on a document —
anchored to a field or left document-level — instead of trading feedback in a separate
tool. Comments are gated by the **target document's read access**: you can only see or add
comments on a document you can already read, the author is recorded from the **authenticated
principal** (never the client body), and resolve/delete are limited to the author or a
reviewer/admin. Enabling it registers a private `_comments` system table, unreachable through
generic CRUD.

```ts
export default defineConfig({ comments: true, collections: [/* … */] })
```

- **Add / reply.** `kernel.addComment({ collection, id, body, field?, parentId?, req })` adds
  a comment (or a threaded reply via `parentId`, validated to the same document) to a document
  you can read. `body` is trimmed and length-bounded; `field` must name a real field. Returns
  the `CommentDoc` with `authorId` from the principal.
- **List / count.** `kernel.listComments({ collection, id, field?, includeResolved?, req })`
  returns comments oldest → newest (resolved hidden unless `includeResolved`);
  `kernel.commentCount({ collection, id, req })` powers an "N comments" badge.
- **Resolve / delete.** `kernel.resolveComment({ commentId, resolved?, req })` (author or a
  reviewer — `admin`/`editor`) and `kernel.deleteComment({ commentId, req })` (author or
  `admin`).

```bash
curl -X POST "http://localhost:3000/api/articles/$ID/comments" \
  -H "Authorization: Bearer $TOKEN" -d '{"body":"ready to publish?","field":"summary"}'
curl -X PATCH "http://localhost:3000/api/_admin/comments/$COMMENT_ID" \
  -H "Authorization: Bearer $TOKEN" -d '{"resolved":true}'
```

**The read-gate guarantee:** every op checks the target document's `access.read` rule **and**
row-scope before returning a comment, a count, or mutating — including the anonymous Local-API
path (a null-user caller is held to the read rule, no "no user = trusted" shortcut). Every REST
route requires auth up front (anonymous → `401`). Resolve/delete re-gate on the live document
before the author/role check; threading stays within one document; ids are
prototype-pollution-guarded; create/resolve/delete are audited. Red-teamed to Risk LOW. See the
[editorial comments guide](docs/content-comments.md).

### Saved views (smart collections)

Set `views: true` and editors can save a **named query preset** for a collection — a stored
`where` + `sort` + display `columns` — and re-apply it in one click: "Published this month",
"My drafts", "Out of stock". A view is **owned** by its creator (recorded from the
**authenticated principal**, never the client body) and **private** unless `shared`; a shared
view is visible only to those who can read its collection. Enabling it registers a private
`_views` system table, unreachable through generic CRUD.

```ts
export default defineConfig({ views: true, collections: [/* … */] })
```

- **Save / read.** `kernel.saveView({ collection, name, where?, sort?, columns?, shared?, req })`
  stores a preset (owner from `req`, returns the `ViewDoc`); `kernel.listViews({ collection?, req })`
  lists your own plus shared views on collections you can read, and `kernel.getView({ viewId, req })`
  reads one. REST: `GET/POST /api/_admin/views`, `GET /api/_admin/views/:id`.
- **Update / delete.** `kernel.updateView({ viewId, name?, where?, sort?, columns?, shared?, req })`
  and `kernel.deleteView({ viewId, req })` — **owner or admin only**. REST:
  `PATCH/DELETE /api/_admin/views/:id`.
- **Apply.** `kernel.applyView({ viewId, where?, sort?, draft?, limit?, page?, req })` runs the
  stored query through the **normal access-checked `find`** (a per-call `where` is AND-ed on to
  narrow further), returning a `PaginatedResult`. REST: `POST /api/_admin/views/:id/apply`.

```bash
curl -X POST "http://localhost:3000/api/_admin/views" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"collection":"products","name":"Out of stock","where":{"stock":{"equals":0}},"sort":"-updatedAt"}'
curl -X POST "http://localhost:3000/api/_admin/views/$VIEW_ID/apply" \
  -H "Authorization: Bearer $TOKEN" -d '{"where":{"price":{"greater_than":100}},"limit":20}'
```

**The narrowing guarantee:** applying a view is a **normal, access-checked `find`** — the
collection's `access.read` rule and row-scope run every time, and the stored `where`/`sort` are
validated against the collection on save **and** apply, so a view can only ever **narrow**
results within the caller's access, never widen or bypass it. The owner is recorded from the
principal (a forged `ownerId` is ignored), views are private unless `shared` and shared views are
read-gated by the collection, update/delete are owner-or-admin, `_views` is unreachable via
generic CRUD, and create/update/delete are audited. Red-teamed to Risk LOW. See the
[saved views guide](docs/saved-views.md).

### Field-level encryption at rest

Mark any storage field `encrypted: true` and KernelCMS encrypts it **transparently** —
encrypted on write, decrypted on read — so the plaintext lives only in the app layer while the
storage column holds an opaque, authenticated `enc:1:<iv>:<tag>:<ciphertext>` envelope
(**AES-256-GCM**, a fresh 96-bit IV per value, so the same secret stores differently every
time). It is for the fields you don't want in cleartext in a backup or a leaked dump: a SSN, an
API token, a private note. Supply a server-only key via `encryption.key` (read from the env,
**never** hardcoded; any sufficiently-random secret ≥16 chars — a 256-bit AES key is
SHA-256-derived from it).

```ts
export default defineConfig({
  encryption: { key: process.env.FIELD_ENCRYPTION_KEY }, // server-only secret, ≥16 chars
  collections: [{ slug: 'people', fields: [
    { name: 'name', type: 'text' },
    { name: 'ssn', type: 'text', encrypted: true },   // stored encrypted
    { name: 'notes', type: 'json', encrypted: true }, // any storage field type works
  ] }],
})
```

- **The trade-off (rejected at config load).** Because the column holds opaque,
  non-deterministic ciphertext, an `encrypted` field **cannot** be `unique`, `index`ed,
  filtered/sorted on, full-text searched, `localized`, or `personalized` — each is caught at
  config load. Reserve `encrypted: true` for pure payload you store and hand back, never query
  by.
- **Key management.** Treat the key like a database credential. Rotating it makes existing
  ciphertext unreadable (there's **no built-in re-encryption** — rotation is a migration), and
  field read-access still applies on top: a denied reader gets `null`, never the ciphertext.
  Helpers `createFieldCipher(key)` and `DecryptionError` are exported from `@kernel/core`.

**Authenticated, IV-per-value, server-only key:** AES-256-GCM verifies an authentication tag on
every read, so a tampered envelope or the wrong key is a hard, detectable `DecryptionError` —
never silently-decrypted garbage; the fresh per-value IV leaks no equality across rows; and the
256-bit key (SHA-256-derived from `encryption.key`) is **never logged, returned, or put in an
error message**. **Lose the key and the data is unrecoverable** — there is no backdoor. Red-teamed
to Risk LOW. See the [field encryption guide](docs/field-encryption.md).

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

### Document activity timeline (one feed, four sources)

`kernel.documentActivity(...)` merges everything that happened to one document — saved
versions, editorial comments, agent-draft reviews, and audit-log entries — into a single,
newest-first feed, instead of four panels an editor has to cross-reference. Each `event` is
`{ type: 'version' | 'comment' | 'review' | 'audit', at, actor, action, data }`. The whole
feed is gated on the document's **read access**, and the two reviewer-only sources (review +
audit) are folded in only for an admin/editor principal.

```ts
const { events, includesReviewerEvents } = await kernel.documentActivity({
  collection: 'articles',
  id: article.id,
  types: ['version', 'comment', 'review', 'audit'], // optional filter; default: all available
  limit: 100,                                        // default 100, clamped to 500
  req,                                               // gated on the document's read access
})
// includesReviewerEvents === true only for an admin/editor principal
```

```bash
curl "http://localhost:3000/api/articles/$ID/activity?types=version,comment&limit=20" \
  -H "Authorization: Bearer $TOKEN"   # GET /api/:collection/:id/activity?types=&limit=
```

- **Merges four sources.** version (snapshot `status`/`changedFields`/`autosave`), comment
  (`body`/`field`/`resolved`), review (agent-draft `decision` + `note`), and audit (`action`/
  `fields`/`meta`) — newest-first, capped by `limit` (max 500), `types` filters the kinds.
- **Doc-read-gated as a whole.** Every call checks the document's `access.read` rule and
  row-scope first; a caller who can't read the document gets Forbidden/NotFound, never an event.
- **Reviewer-only review + audit.** Those two sources are included only for an admin/editor
  principal; a non-reviewer gets `includesReviewerEvents: false` and only version + comment.

**The composed-read guarantee:** the timeline is a read-only merge of sources the caller is
**already** allowed to see — each keeps its own access rules (version events field-strip like
`history`, comments follow the comment read gate), a source whose feature is off is simply
absent, and review/audit never surface for a non-reviewer. Red-teamed to Risk LOW. See the
[document activity timeline guide](docs/activity-timeline.md).

### Content releases (atomic, schedulable publishing bundles)

Opt into `releases` and you can bundle a set of draft documents into a named **release**
and publish them **together, atomically** — for coordinated launches and campaigns. The
key provisions two system tables (`_releases` + `_release_items`); members must be real,
non-system, drafts-enabled collection documents.

```ts
export default defineConfig({
  releases: true, // provisions _releases + _release_items
  collections: [/* … drafts-enabled collections … */],
})

// open → add members → preview → publish, all on the Local API:
const release = await kernel.createRelease({ name: 'Spring launch' })
await kernel.addToRelease({ release: release.id, collection: 'posts', id })  // access-checked
const { docs } = await kernel.previewRelease({ release: release.id })        // current draft state
const result = await kernel.publishRelease({ release: release.id })          // → { status, published, failed }

// or schedule the whole bundle; drain it from a cron alongside scheduled publishes:
await kernel.scheduleRelease({ release: release.id, at: '2026-07-01T09:00:00Z' })
await kernel.processScheduledReleases() // call next to processScheduledPublishes()
```

A release moves `open` (editable — add/remove members) → `published` (all members live,
`publishedAt` set) or `scheduled` → `published`; a mid-publish error → `failed`. Only
`open` releases are editable; `published` is immutable.

**The all-or-nothing, same-gate guarantee:** `publishRelease` first dry-runs the publish
gate for **every** member — the per-document publish access check, the agent draft-only
brake, and the blocking eval/content-CI gate against current draft content. If *any*
member would fail, it publishes **none** (returns `failed` with reasons; the release
stays `open`) — no partial go-live. Only when all pass does it publish each through the
normal `publish` op. So publishing a release is held to the **same per-document publish
gate as a direct publish**: a caller can only publish a release whose every member they
could publish directly, an **agent can never publish a release**, and eval gates still
apply. Member management is access-checked (you can't pull a doc you can't read into a
release), and scheduled releases are gate-checked at schedule time and re-checked on the
drain. Best-effort atomic on a mid-publish fault; red-teamed to Risk LOW. See the
[content releases guide](docs/releases.md).

### Content branches (git-for-content)

Opt into `branches` and you get a named workspace where edits are **staged** as a
copy-on-write overlay — the live document is never touched — so you can prepare a set of
changes, preview and diff them, then **merge** the branch or discard it. The key provisions
two system tables (`_branches` + `_branch_docs`) that hold the overlay; they're unreachable
through generic CRUD.

```ts
export default defineConfig({
  branches: true, // provisions _branches + _branch_docs (the copy-on-write overlay)
  collections: [/* … */],
})

// open → stage → preview/diff → merge, all on the Local API:
const branch = await kernel.createBranch({ name: 'autumn-pricing' })
await kernel.stageChange({ branch: branch.name, collection: 'products', id, data: { price: 1900 } }) // live doc untouched
const preview = await kernel.previewBranch({ branch: branch.name, collection: 'products', id })       // live + staged overlay
const changes = await kernel.diffBranch({ branch: branch.name })                                      // [{ collection, documentId, fields }]
const result = await kernel.mergeBranch({ branch: branch.name })                                      // → { merged, failed }
// …or kernel.discardBranch({ branch: branch.name }) to throw the change set away
```

- **Stage** field edits onto a branch — copy-on-write, the live doc is never written;
  re-staging the same doc deep-merges. Staging requires **update access to the target**.
- **Preview** the live (access-checked) doc with the branch's staged overlay applied, and
  **diff** the whole change set before it touches anything.
- **Merge** replays each staged change through the **normal, access-checked update** (so the
  publish gate, field-level access, and validation all apply); a change that fails lands in
  `failed[]`. **Discard** just drops the overlay.
- Branch management (create/stage/preview/diff/merge/discard) is **reviewer-gated**
  (admin/editor); create/merge/discard are audited.

```bash
curl -X POST "http://localhost:3000/api/_admin/branches" -H "Authorization: Bearer $TOKEN" -d '{"name":"autumn-pricing"}'
curl -X POST "http://localhost:3000/api/_admin/branches/autumn-pricing/stage" \
  -H "Authorization: Bearer $TOKEN" -d '{"collection":"products","id":"<id>","data":{"price":1900}}'
curl -X POST "http://localhost:3000/api/_admin/branches/autumn-pricing/merge" -H "Authorization: Bearer $TOKEN"
```

**The same-gate guarantee:** the live read/write path is untouched (branch edits live in a
separate `_branches` + `_branch_docs` overlay), staging requires update access to the target,
and merge replays through the access-checked update — so a branch can **never** bypass the
publish gate, field access, or validation. Management is reviewer-gated, the overlay is
unreachable via generic CRUD, and create/merge/discard are audited. This is field-level
staged overlays plus a replayed merge — not git-style three-way merge with conflict
resolution. Red-teamed to Risk LOW. See the [content branches guide](docs/content-branches.md).

### Content federation (sync between environments)

Opt into `federation` and you can **export** a collection's documents as a portable,
deterministic **bundle** and **sync** it into another instance by id — create-or-update, with
a dry-run diff first. It's how you promote content from staging to production, or keep two
instances in sync. Export is **access-checked** (you only export what you can read) and
**id-preserving**; sync replays every apply through the **normal access-checked pipeline**, so
it can't bypass access, validation, or the publish gate.

```ts
export default defineConfig({
  federation: true, // unlocks exportContent / syncContent + the admin routes
  collections: [/* … */],
})

// export from the source, sync into the target — all on the Local API:
const bundle = await kernel.exportContent({ collection: 'posts', draft: true })
// -> ContentBundle { version: 1, documents: [{ collection, id, data }, …] }  (sorted by id)
const plan = await kernel.syncContent({ bundle, dryRun: true }) // the diff, writes nothing
const result = await kernel.syncContent({ bundle })            // create-or-update by id
// -> { created, updated, unchanged, failed, plan, dryRun }
```

- **Export** a collection's documents — `data` is the stored field values (`+ _status` for
  drafts collections), so identity (the id) and publish state **round-trip**. Only documents
  the caller can **read** are exported; output is sorted by id (deterministic).
- **Sync** applies a bundle keyed on id: create it (preserving the id) if missing, update it
  if a field differs, leave it if identical. Every apply goes through the normal
  `create`/`update` op — **access + validation + the publish gate all apply** — so anything
  that fails lands in `failed[]` while the rest apply. Re-syncing is **idempotent**.
- **Dry run** (`dryRun: true`) returns the full plan **without writing**, so you review the
  diff before you commit.
- `kernel.create` now takes an optional `id` to preserve identity on import; a duplicate id
  is a conflict.

```bash
curl "http://staging/api/_admin/federation/export?collection=posts&draft=true" \
  -H "Authorization: Bearer $STAGING_TOKEN" > bundle.json
curl -X POST "http://prod/api/_admin/federation/sync" -H "Authorization: Bearer $PROD_TOKEN" \
  -d "{\"bundle\": $(cat bundle.json), \"dryRun\": true}"   # diff first, then drop dryRun to apply
```

**The same-gate guarantee:** export is access-checked (you only export what you can read) and
sync replays every create/update through the **access-checked, validated, publish-gated**
pipeline — a sync **can't elevate**. Ids round-trip stably (export from A, sync into B keeps
the same ids), a dry run shows the diff before you commit, re-syncing is idempotent, and both
REST routes are **admin-only**. This is a deterministic upsert-by-id sync with a diff — not
real-time replication (last-write-wins per field on update). Red-teamed to Risk LOW. See the
[content federation guide](docs/content-federation.md).

### Content lifecycle (auto-expire, archive & delete)

Scheduled publish makes a draft go live at a future instant; **content lifecycle** is the
inverse — give a published document an expiry and KernelCMS retires it automatically when
that date passes. Opt into `lifecycle` per collection for embargoes, time-limited
campaigns, retention/compliance, and stale-content cleanup. Each `slug` must be a real,
**drafts-enabled** collection, and the `expireField` must already be a declared `date`
field on it — you own the schema; KernelCMS never adds the column for you.

```ts
export default defineConfig({
  lifecycle: {
    collections: [
      { slug: 'promos', expireField: 'expire_at', onExpire: 'unpublish' }, // back to draft
      { slug: 'press',  expireField: 'embargo_until', onExpire: 'archive' }, // draft + _archived_at
      { slug: 'tmp',    onExpire: 'delete' }, // expireField defaults to 'expire_at'
    ],
  },
  collections: [
    { slug: 'promos', versions: { drafts: true },
      fields: [/* … */ { name: 'expire_at', type: 'date' }] }, // YOU declare the date field
    // …
  ],
})

// the drain (cron-driven; runs under override like processScheduledPublishes):
const { processed } = await kernel.processContentLifecycle({ now, limit })
// processed: Array<{ collection, id, action }>
```

`expireField` defaults to `'expire_at'` and `onExpire` to `'unpublish'`. When a published
document's `expireField` date has passed, the next drain retires it: **`unpublish`** →
back to draft; **`archive`** → draft plus a server-managed `_archived_at` timestamp
(hidden from public reads, and distinguishable from a plain draft); **`delete`** → removed.
The `expireField` is an ordinary editor field, so you can only set an expiry on content you
can write.

Run the drain from a cron — either the dedicated `kernel lifecycle:run`, or `kernel
jobs:run`, which now also drains scheduled publishes and releases. There is **no HTTP
trigger**: the drain is a trusted, operator-only maintenance operation, which is exactly
why it can run under `overrideAccess` safely. It is bounded by `limit`, resilient
per-document, and **only ever touches the configured lifecycle collections**; `now`/`limit`
are validated and clamped, and each action is audited (`content.expire`).

```bash
* * * * * cd /app && npx kernel lifecycle:run   # or: kernel jobs:run (drains everything due)
```

**The trusted-drain, client-immutable guarantee:** the lifecycle drain is cron/operator-only
and never exposed to untrusted callers, so running it under override is safe. The
server-managed `_archived_at` is **client-immutable** — a normal user can never set it (to
fake an archive) or clear it (to un-archive) through the API; only the trusted drain writes
it. The `expireField` itself is a plain field gated by normal write access. See the
[content lifecycle guide](docs/content-lifecycle.md).

### Personalization & A/B experiments

`personalized` fields are the audience-keyed twin of localization: where a `localized` field
stores one value per locale, a `personalized` field stores a `{ [segment]: value }` map and
resolves per request to the caller's audience → the default segment → null. Opt in with an
`audiences` config; built-in `experiments` add deterministic A/B testing on the same model.

```ts
export default defineConfig({
  audiences: { segments: ['default', 'vip', 'returning'], default: 'default' }, // default ∈ segments
  experiments: [{ slug: 'cta', variants: ['a', 'b'], weights: [50, 50], seed: 1 }], // variants are segments
  collections: [
    { slug: 'posts', fields: [
      { name: 'headline', type: 'text', personalized: true }, // can't also be `localized`
    ] },
  ],
})
```

- **Resolve a variant.** Pass `?audience=vip` (REST) or `req.audience` (Local API). A write
  carrying an audience **merges** that segment without clobbering the others:

```ts
const { variant } = kernel.assignVariant({ experiment: 'cta', key: visitorId }) // sticky, weight-proportional
const doc = await kernel.findByID({ collection: 'posts', id, req: { audience: variant } }) // variant IS a segment
```

```bash
curl "http://localhost:3000/api/posts/<id>?audience=vip"                                  # read the vip variant
curl -X PATCH "http://localhost:3000/api/posts/<id>?audience=vip" -d '{"headline":"…"}'    # merge into vip only
curl -X POST  "http://localhost:3000/api/_experiments/cta/assign" -d '{"key":"visitor-1"}' # public; → {variant, segment}
```

**The guarantees:** an untrusted `audience` is honored only if it's a configured segment
(unknown → default); segment keys are guarded against `__proto__`/`constructor`/`prototype`
(no pollution); personalized fields still pass field read-access, so a read-denied variant
is stripped for every audience; per-segment writes merge (no variant lost); and bucketing is
deterministic over an FNV hash of the visitor `key` — **only the hash is recorded, no PII at
rest**. Red-teamed to Risk LOW. See the [personalization guide](docs/personalization.md).

### AI-assisted translation (auto-fill every locale)

Configure a pluggable `translation` provider and KernelCMS auto-translates your localized
content into every locale — with the provider of *your* choice, while keeping access
control, strict-mode validation, and your human-review workflow intact. It requires
`localization` and is off until you add the block; the provider is yours (DeepL, OpenAI,
Google, a local model — no hard translation dependency in the core).

```ts
export default defineConfig({
  localization: { locales: ['en', 'sv', 'de'], defaultLocale: 'en' },
  translation: {
    // N source strings (all in `from`) → N translations in `to`, in order. Bring any provider.
    translate: async ({ texts, from, to }) => {
      const res = await deepl.translateText(texts, from, to)
      return res.map((r) => r.text)
    },
  },
  collections: [/* … localized fields … */],
})
```

- **Translate one document.** `kernel.translateDocument({ collection, id, from, to, fields?,
  overwrite?, req })` reads the document's `from`-locale values for its localized text
  fields (the listed `fields`, or all of them), translates them through the provider, and
  **merges** the results into the `to` locale — other locales are never touched. By default
  it fills only **missing** `to` values; `overwrite: true` replaces existing ones. Returns
  the updated doc (or `null`).
- **Bulk-fill a collection.** `kernel.translateMissing({ collection, to, from?, fields?,
  limit? })` finds documents missing the `to` locale (via the translation-status data) and
  translates each, returning `{ translated, skipped }`. `from` defaults to the default
  locale; `limit` is bounded (default 50).

```ts
await kernel.translateDocument({ collection: 'posts', id, from: 'en', to: 'sv', req }) // fill missing sv
await kernel.translateDocument({ collection: 'posts', id, from: 'en', to: 'sv', overwrite: true, req })
const { translated, skipped } = await kernel.translateMissing({ collection: 'posts', to: 'de' })
```

```bash
curl -X POST "http://localhost:3000/api/posts/<id>/translate" -d '{"from":"en","to":"sv"}'
curl -X POST "http://localhost:3000/api/_admin/translate-missing" -d '{"collection":"posts","to":"de"}' # admin/editor-gated
```

**The access-checked-write guarantee:** a translation is a **write through the normal
pipeline**, never a side door. It goes through update access (the caller must be able to
update the doc), strict-mode per-locale required validation still applies, and the **agent
draft-only brake still holds** — a translation never auto-publishes. `from`/`to` must be
configured locales (unknown / `__proto__` are rejected), and a read-denied localized field
is never sent to the provider or written. The provider closure may hold an API key: its
text and errors **never leak** (a provider failure surfaces a generic message; source and
target text are never logged), and a provider fault can't corrupt the doc (no partial
write). Per-field input is bounded. Pairs with localization strict mode and the
translation-status dashboard. Red-teamed to Risk LOW. See the
[AI translation guide](docs/ai-translation.md).

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

### Knowledge graph & GraphRAG

Your typed relationships *are* a graph. `kernel.graph(...)` walks a document and its
neighbors; `kernel.graphSearch(...)` is **GraphRAG** — semantic search picks the seeds,
the graph expands each into its connected subgraph, and you get a `context` array to
ground an LLM. It is the **retrieval** half; the generation stays yours.

- **Graph traversal.** `kernel.graph({ collection, id, depth?, maxNodes?, req })` →
  `{ nodes, edges, truncated }`. BFS from the seed following outbound
  relationship/upload fields **and** inbound reverse-relationship (`join`) fields, up to
  `depth` hops (default 1, clamp 10). A `GraphNode` is `{ ref: '<collection>:<id>',
  collection, id, label }`; a `GraphEdge` is `{ from, to, field, relationTo, kind }` where
  `kind` is `'relationship'` (outbound) or `'reverse'` (inbound join). Bounded and
  cycle-safe: `maxNodes` (default 100, hard cap 500), a per-node fan-out cap (200), and
  de-duped nodes; `truncated: true` when a bound clips the walk.
- **GraphRAG retrieval.** `kernel.graphSearch({ collection?, query, depth?, limit?, req })`
  → `{ seeds, nodes, edges, context, truncated }`. It runs semantic/hybrid search (so it
  **requires `embeddings`**; it falls back to full-text, then plain `find`) to find seed
  docs for `query`, expands each through the graph, and returns the seeds + the connected
  subgraph + a `context` array of `{ ref, label, text }` snippets to ground an LLM. Pass an
  explicit `collection` when more than one is searchable.

```ts
// Local API — the connected subgraph around one document:
const { nodes, edges, truncated } = await kernel.graph({ collection: 'posts', id, depth: 2, req })

// GraphRAG — semantic seeds, expanded into their connected context:
const { seeds, context } = await kernel.graphSearch({ collection: 'posts', query: 'who wrote about deploys?', depth: 1, req })
// `context` is Array<{ ref, label, text }> — drop it straight into an LLM prompt.
```

```bash
curl "http://localhost:3000/api/posts/<id>/graph?depth=2&maxNodes=100"
curl "http://localhost:3000/api/graph-search?q=who%20wrote%20about%20deploys&collection=posts&depth=1"
```

**The access & bounds guarantee:** every node loads through the same access-checked read
path. A node the caller can't read is dropped **and the edge to it is omitted**, so the
relationship's very existence never leaks; read-denied fields never appear in a `label` or
`context`. The bounds (`depth`, `maxNodes`, fan-out, de-dupe) make traversal DoS-safe.
This is retrieval only — see the [knowledge graph guide](docs/knowledge-graph.md).

### Content intelligence (related content & near-duplicate detection)

The same embeddings that power semantic search also power **content intelligence**:
"more like this" recommendations and automatic near-duplicate detection, straight from
the vectors you already index. Both **require `embeddings`** + a vector store (the
semantic-search setup) — they build on it.

- **Related content (more-like-this).** `kernel.relatedContent({ collection, id, limit?,
  filter?, req })` → `{ docs }` re-embeds a seed document from its current content and
  returns the others most semantically similar to it (the seed itself excluded). Great for
  internal-linking and "you might also like". `limit` and `filter` behave exactly as in
  `semanticSearch`. REST: `GET /api/:collection/:id/related?limit=`.
- **Near-duplicate detection.** `kernel.findDuplicates({ collection, threshold?, limit?,
  req })` → `{ pairs: Array<{ a, b, score }> }` returns pairs of documents whose
  embeddings are at least `threshold` cosine-similar (default `0.9`, clamped to `[0, 1]`)
  — for content-QA and dedupe cleanups. Similarity is computed over the last-indexed
  content within a **bounded scan** (caps the docs scanned and pairs returned — an admin
  operation, not a hot path). REST: `GET /api/_admin/duplicates?collection=&threshold=&limit=`
  (**admin/editor-gated**).

```ts
// Local API — documents most like this one, access-checked:
const { docs } = await kernel.relatedContent({ collection: 'posts', id, limit: 5, req })

// Near-duplicate pairs across a collection (admin operation, bounded scan):
const { pairs } = await kernel.findDuplicates({ collection: 'posts', threshold: 0.92, req })
```

```bash
curl "http://localhost:3000/api/posts/<id>/related?limit=5"
curl "http://localhost:3000/api/_admin/duplicates?collection=posts&threshold=0.92&limit=50"  # admin/editor-gated
```

**The access & bounds guarantee:** every result goes through the **same access-checked
read path** — a related or duplicate result never surfaces (or implies the existence of)
a document the caller can't read. A duplicate **pair is returned only when the caller can
read both documents**, so a pair touching a hidden doc is dropped whole — it never reveals
a hidden doc's id or existence. `threshold` is clamped to `[0, 1]`, `limit` is clamped, and
`filter` is validated to real columns (no injection); the dedup scan is bounded; and the
embedding provider's key and text never leak. Red-teamed to Risk LOW. See the
[content intelligence guide](docs/content-intelligence.md).

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

### Outbound webhooks (with durable delivery)

Register `webhooks: [{ url, secret?, … }]` and every matching content write pushes a signed
`POST` to an external URL — a downstream sync, a static-site rebuild, a Slack relay — without
polling. Each delivery carries a small JSON payload and an HMAC signature the receiver verifies.
Pick **inline** (best-effort, fires immediately) or **durable** (enqueued and retried) per endpoint.

```ts
export default defineConfig({
  webhooks: [{
    url: 'https://billing.internal.example.com/kernel',
    secret: process.env.BILLING_SECRET, // HMAC-SHA256 signing key
    collections: ['orders'],            // default: all non-system collections
    events: ['create', 'update'],       // default: create, update, delete
    durable: true,                      // survive a down receiver — retried, never dropped
    maxAttempts: 5,                     // default 5; exponential backoff, capped at 1h
  }],
  collections: [/* … */],
})
```

- **Inline vs. durable.** Inline (default) fires immediately and best-effort — a slow/down
  receiver never fails the write, but the event is dropped if it's down. `durable: true`
  enqueues to the `_webhook_deliveries` outbox and delivers at-least-once with retry + backoff.
- **The cron drain.** `kernel.processWebhooks()` (wired into `kernel jobs:run`, or standalone
  `kernel webhooks:run`) drains due durable deliveries — `pending → delivered`, or `failed`
  while attempts remain, then `exhausted` after `maxAttempts`.
- **Admin REST (admin-only).** `GET /api/_admin/webhooks` (redacted — never the secret/headers),
  `GET /api/_admin/webhooks/deliveries?webhook=&status=&since=` (the delivery log),
  `POST /api/_admin/webhooks/deliveries/:id/retry` (requeue a failed/exhausted delivery).
- **SSRF guard.** A `url` must be `http(s)` and its host may not be loopback/private/link-local/
  metadata — rejected at config load unless you set `allowPrivateNetwork: true` for a trusted host.

```bash
curl "http://localhost:3000/api/_admin/webhooks/deliveries?status=exhausted" \
  -H "Authorization: Bearer $ADMIN_TOKEN"                                       # the delivery log
curl -X POST "http://localhost:3000/api/_admin/webhooks/deliveries/$ID/retry" \
  -H "Authorization: Bearer $ADMIN_TOKEN"                                       # requeue
```

**Egress is default-deny and secrets stay server-side:** the SSRF guard fences private/metadata
hosts (explicit per-endpoint opt-in only), and the signing secret + custom headers are **never**
returned by the admin surface or logged. Durable delivery is **at-least-once** with bounded
retries — dedupe on `id` + `event` + `timestamp`. The `_webhook_deliveries` outbox is unreachable
via generic CRUD, and management is admin-only. See the [webhooks guide](docs/webhooks.md).

### Saved-search alerts (content subscriptions)

Set `subscriptions: true` (it builds on `realtime` + `webhooks`) and an editor can save a
**standing query** — a collection plus an optional `where` — and get **notified when content
matching it changes**: "ping me when a `posts` row in my section is updated". A cron drain
reads the change feed since each subscription's cursor and re-evaluates every change **as the
subscription's owner** (an access-checked document reload + `where` match) before delivering a
webhook — so an alert can only ever fire for content the owner could already read.

```ts
export default defineConfig({
  subscriptions: true,           // off by default; requires realtime + webhooks
  realtime: { enabled: true },   // alerts read the change feed
  webhooks: [
    // collections: [] → this webhook NEVER fires on content writes; only the
    // subscription drain enqueues to it (no double-send).
    { slug: 'alerts', url: 'https://hooks.example.com/alerts', collections: [] },
  ],
  collections: [/* … */],
})
```

- **Subscribe.** `kernel.createSubscription({ collection, where?, webhook, req })` saves a
  standing query (owner from `req`, `webhook` is a configured slug, `lastSeq` set to the
  current cursor so it alerts on **future** changes only); `kernel.listSubscriptions({ collection?, req })`
  lists your own, `kernel.deleteSubscription({ subscriptionId, req })` removes one (owner/admin).
- **The cron drain.** `kernel.processSubscriptions({ limit? })` → `{ scanned, delivered }`
  reads the change feed since each cursor, reloads + re-matches each change **as the owner**,
  and enqueues a delivery to the subscription's webhook through the durable outbox
  (retry/backoff). Wired into `kernel jobs:run`, or standalone `kernel subscriptions:run`.
- **Owner-scoped REST.** `GET /api/_admin/subscriptions?collection=` (your own),
  `POST /api/_admin/subscriptions { collection, where?, webhook }`,
  `DELETE /api/_admin/subscriptions/:id` (owner/admin) — auth required, owner from the token.

```bash
curl -X POST "http://localhost:3000/api/_admin/subscriptions" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"collection":"posts","where":{"section":{"equals":"sports"}},"webhook":"alerts"}'
```

**The access-scoped (re-match as owner) guarantee:** every candidate change is re-evaluated
through an **access-checked reload as the subscription's owner** plus a `where` match before any
alert fires — an alert can **never leak content (or a field) the owner can't read**, and a
missing claim fails **closed** (it under-notifies, never over-notifies). The owner comes from
the principal (a forged `ownerId` is ignored), `lastSeq` means future-only (no backfill), deletes
don't fire (no live row to match), the payload is field-stripped + encrypted-field-redacted like a
normal read, `_subscriptions` is unreachable via generic CRUD, and create/delete are audited.
Red-teamed to Risk LOW. See the [saved-search alerts guide](docs/saved-search-alerts.md).

### Edge delivery & CDN caching (cache tags + change-driven purge)

Opt into `edge` and KernelCMS turns public reads into edge-cacheable responses with
**cache tags**, then emits a **change-driven purge feed** so a CDN worker invalidates
*exactly* the content that changed — provider-agnostically. You emit the tags and the
purge list; you wire them to Cloudflare, Fastly, or Vercel. It is off by default and the
purge feed requires `realtime`.

```ts
export default defineConfig({
  realtime: { enabled: true }, // the purge feed reads the change feed
  edge: {
    enabled: true,
    // the Cache-Control sent on a cacheable read:
    cacheControl: 'public, s-maxage=31536000, stale-while-revalidate=60',
    tagHeader: 'Surrogate-Key',   // surrogate-key header name (default 'Surrogate-Key')
    includeRelationships: true,   // also tag a doc with its relationship targets (default true)
  },
  collections: [/* … */],
})
```

- **Cache headers on public reads.** With `edge.enabled`, `GET /api/:collection/:id` and
  `GET /api/:collection` add the configured `Cache-Control` plus a `Surrogate-Key` header
  listing the response's cache tags (`<collection>`, `<collection>:<id>`, and — with
  `includeRelationships` — its relationship targets) — but **only for a cacheable
  response**: an *anonymous, published, non-time-travel* read. Any authenticated /
  access-scoped / draft / `asOf` / `overrideAccess` read instead gets
  `Cache-Control: private, no-store` and **no** surrogate key.
- **Cache tags.** `kernel.cacheTags({ collection, id?, doc?, docs? })` returns the surrogate
  keys for a doc or response (own + collection + relationship-target tags), sanitized to
  CDN-safe tokens.
- **Purge feed (change-driven).** `kernel.purgeFeed({ since? })` → `{ tags, cursor }` maps
  recent changes to the cache tags to invalidate — **including the tags of docs that
  reference a changed doc** (bounded), so changing a referenced doc purges the docs that
  embed it. A CDN worker polls it and purges those surrogate keys. REST:
  `GET /api/_edge/purge?since=` (**admin-gated** — it reveals changed ids).
  `kernel.onPurge(fn)` pushes tags over the realtime bus.

**The never-cache-private guarantee:** a private, authenticated, access-scoped, draft,
time-travel (`asOf`), or `overrideAccess` response is **never** given a public/`s-maxage`
`Cache-Control` or a surrogate key — a wrong header would cache private content at the
edge, so it is the make-or-break property. Cache tags only ever contain ids from the
access-checked returned docs (no leak), tag and header values are sanitized (no header
injection), and the purge feed is admin-gated and bounded. CDN integration is yours.
Red-teamed to Risk LOW. See the [edge delivery guide](docs/edge-delivery.md).

### Content analytics & insights (incl. AI-retrieval, privacy-first)

Opt into `analytics` and KernelCMS records a content event per interaction and rolls
them up into aggregate insights — including, uniquely, **how AI answer engines retrieve
your content**, from the same model. It is off by default; `retain` (default ~100k,
clamped) bounds the event table, and `autoCapture` (default `false`) turns on the
zero-touch AI-retrieval and experiment signals.

```ts
export default defineConfig({
  analytics: { enabled: true, retain: 100000, autoCapture: true }, // all opt-in
  collections: [/* … */],
})
```

- **Capture.** `kernel.track({ type, collection?, documentId?, query?, experiment?,
  variant?, value?, meta? })` records one event; `type` is `'view' | 'search' |
  'ai_retrieval' | 'citation' | 'variant_impression' | 'conversion' | 'custom'`. It is
  **resilient** — a tracking failure is logged and never throws into the caller. REST:
  `POST /api/_analytics/track` (auth required unless the server sets `publicTrack`).
- **Auto-capture (`autoCapture: true`).** `semanticSearch` / `hybridSearch` /
  `graphSearch` emit an `ai_retrieval` event per returned (access-checked) document with
  the search terms as `query`, and `assignVariant` emits a `variant_impression`.
  Fire-and-forget, **zero added latency**, a complete no-op when off.
- **Insights.** `kernel.insights({ metric, collection?, type?, from?, to?, limit? })` →
  `top_content`, `top_queries`, `variant_performance`, `activity`, and
  `ai_retrieval_leaderboard`. REST: `GET /api/_admin/insights?metric=…` (admin/editor-gated).

```ts
await kernel.track({ type: 'view', collection: 'posts', documentId })           // capture
const board = await kernel.insights({ metric: 'ai_retrieval_leaderboard', limit: 20 }) // roll-up
```

```bash
curl -X POST http://localhost:3000/api/_analytics/track -d '{"type":"view","collection":"posts","documentId":"<id>"}'
curl "http://localhost:3000/api/_admin/insights?metric=top_content&from=2026-06-01&limit=20"
```

**The privacy-first, no-PII guarantee:** there is **no user/IP/visitor/email/token
column** on the event row — only content/event metadata — and the authenticated principal
is **never recorded**; `track` strips PII-ish + prototype-pollution keys from `meta`
(keeping only scalar non-PII dimensions). `track` can only ever write `_analytics`
(`collection` is inert data, not a write target). Insights are **aggregates only**,
filtered to collections the caller can read (a hidden collection's counts never leak), and
the route is admin/editor-gated; retention, scan, and result size are bounded. No
third-party analytics, no PII. Red-teamed to Risk LOW. See the
[analytics guide](docs/analytics.md).

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

### Content QA & linting

KernelCMS runs **pre-publish evals** — "content CI" — at the publish gate: a blocking rule
that returns an `error` **rejects the publish**. Content QA extends that with an *on-demand*
lint, so an editor sees the blocking errors and quality warnings **before** they publish —
and adds three new built-in rule factories. The rules that gate a publish and the rules you
lint against are the **same rules**: a green lint is a publishable document.

```ts
export default defineConfig({
  evals: [
    requiredFieldsEval({ fields: ['summary', 'hero'] }), // BLOCKING: no publish without these
    seoEval({ titleField: 'title', descriptionField: 'meta_description' }),
    a11yEval(),                                           // alt text + heading levels
    readabilityEval({ fields: ['body'] }),               // warns on long-winded prose
    linkEval(),                                           // warns on empty/broken link targets
    // policyEval({ bannedTerms }), brandEval({ requiredDisclaimers }) …
  ],
  collections: [/* … */],
})
```

- **Lint on demand.** `kernel.lintDocument({ collection, id, req })` runs the configured
  rules read-only and returns `{ ok, findings, blocking }` — every finding
  (`{ rule, ok, severity: 'error' | 'warn' | 'info', message, field?, blocking }`), the
  subset that would reject a publish, and `ok` when nothing blocks. **Access-checked** (you
  must be able to read the document, drafts included).
- **Seven built-in checks.** `a11yEval`, `seoEval`, `policyEval`, `brandEval`,
  `readabilityEval`, `requiredFieldsEval`, `linkEval` — all pure (read only the fields they
  declare, never the network) and exported from `@kernel/core`. Scope a rule with
  `appliesTo: ['posts']`.
- **Blocking vs warning.** `blocking: true` (the default) means an `error` rejects the
  publish; a `blocking: false` rule (readability, links) only ever warns. `warn`/`info`
  never block.

```bash
# Lint a document — runs the configured evals read-only; requires UPDATE access (an editor token)
curl -H "Authorization: Bearer <editor-token>" "http://localhost:3000/api/posts/<id>/lint"
```

**`lintDocument` is read-only and gated on update access, and returns exactly what the publish
gate would see** — a green lint means the document clears the gate, for the configured rules.
Lint exposes the live draft and its findings echo content, so it requires the same right as
publishing: only an editor of the document can lint it, never a public reader — drafts can't
leak through the lint surface. Built-in rules are pure and deterministic; a rule that throws
fails closed (a blocking error, never a silent pass). Red-teamed to Risk LOW. See the
[content QA & linting guide](docs/content-qa.md).

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

### Multi-tenancy (one instance, many tenants, airtight isolation)

Opt into `tenancy` and one KernelCMS instance hosts many clients, sites, or workspaces
with **airtight per-tenant data isolation and no per-collection access boilerplate**. For
each scoped collection, KernelCMS auto-adds a server-managed `tenant` field and
**AND-combines** a tenant scope into its read/create/update/delete access — it never
widens your own rules. Every `find` / `findByID` / `update` / `delete` / `count` is then
automatically filtered to the caller's tenant through the existing access pipeline; on
create the `tenant` is auto-stamped from the caller, and on update it is immutable.

```ts
export default defineConfig({
  tenancy: {
    // all opt-in; these are the defaults:
    field: 'tenant',          // the server-managed scope field
    // collections: ['posts'], // default: every non-system, non-auth collection
    requireTenant: true,      // a principal with no tenant claim is denied scoped content (fail-closed)
    resolve: (req) => req.user?.tenant ?? null, // how the ACTING tenant is derived (this is the default)
  },
  collections: [
    {
      slug: 'users',
      auth: true,
      // put a tenant on each user — it flows into req.user.tenant on auth:
      fields: [{ name: 'tenant', type: 'text', required: true }],
    },
    {
      // scoped automatically — no per-collection tenant field or access rule needed:
      slug: 'posts',
      access: { read: ({ req }) => Boolean(req.user) },
      fields: [{ name: 'title', type: 'text', required: true }],
    },
  ],
})
```

**The principal-derived, fail-closed isolation guarantee:** the acting tenant is resolved
from the **authenticated principal** (`req.user.tenant` by default) — **never** a client
query param, body field, or header. A tenant A principal can never read, list, count,
update, or delete tenant B's content (cross-tenant access resolves to nothing /
`NotFound`); a client can never create or move a document into another tenant (the tenant
is stamped on create and stripped on update); a tenant-less principal sees **nothing** in
scoped collections (fail-closed) unless `overrideAccess`. Cross-tenant content is never
leaked through relationship `populate` (it is access-filtered to a bare id). The only
bypass is `overrideAccess`/system code (migrations, admin tooling). A custom `resolve`
(e.g. a verified subdomain → tenant mapping) must derive from trusted/authenticated state,
never raw client input. Red-teamed across 35 cross-tenant attacks to Risk LOW, zero leaks.
See the [multi-tenancy guide](docs/multi-tenancy.md).

### Media

- Uploads with local disk and S3 or R2 storage adapters.
- Optional image transforms (multiple sizes, focal point, format re-encode) through the
  `@kernel/image-sharp` adapter. Install it only if you need it; the core stays
  native-dependency-free.

### Signed asset URLs (capability links for private files)

Private media is served with a **per-request access check** against the caller's session. A
**signed asset URL** is the bearer-capability alternative: a single-file link that anyone holding
it can fetch **without a session**, until it expires — to email a private download, embed a
time-limited image, or hand a file to a service that can't authenticate.

```ts
const url = await kernel.signedAssetUrl({
  collection: 'media',
  id: file.id,
  ttl: 600,   // seconds; optional, default 3600 (1h), clamped to 1s..7days
  req,        // the caller — must be able to READ this document
})
// → "/files/2026/06/invoice.pdf?exp=1750000000&sig=9f86d0818..."
```

Minting is access-checked, so you can never sign a link to a file you can't read. The same is
exposed over REST:

```bash
# mint a 10-minute link as the authenticated caller
curl "http://localhost:3000/api/media/$FILE_ID/signed-url?ttl=600" \
  -H "Authorization: Bearer $TOKEN"
# → {"url":"/files/2026/06/invoice.pdf?exp=1750000000&sig=9f86d0818..."}

# a receiver just GETs the URL — no session needed, until it expires (then 403)
curl "http://localhost:3000/files/2026/06/invoice.pdf?exp=1750000000&sig=9f86d0818..."
```

**A signed link can't be forged or extended:** the `sig` is an HMAC keyed by `config.secret`
(server-only, never in the URL) over **both** the storage key **and** the expiry, compared
constant-time — swap the file or bump `exp` and the file route answers `403`. It expires (`ttl`
clamped to 7 days), minting requires read access, and when the storage adapter mints its own
signed URLs (e.g. S3 presign) that is delegated to instead. A link is a capability — shareable
within its TTL and not individually revocable, so use a short TTL for sensitive files (rotate
`config.secret` to invalidate every outstanding link at once). Red-teamed to Risk LOW. See
[Signed asset URLs](docs/signed-asset-urls.md).

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
