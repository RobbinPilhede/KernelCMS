# Competitive Analysis: Strapi

Strapi is the most-installed open-source headless CMS, and it earned that position by shipping a friendly admin-driven content-type builder, a REST and GraphQL API that "just works," and a plugin marketplace that turned a CMS into a small ecosystem. It is also the clearest example of the failure mode KernelCMS exists to avoid: a runtime-mutable schema persisted to the database, a UI that generates code you cannot meaningfully review, and a type story bolted on years late. This teardown walks the parts of Strapi that work, the parts that hurt, and exactly where KernelCMS takes a different bet — config-as-code, end-to-end types from a single Drizzle-backed source of truth, and TanStack everywhere.

## Content-Type Builder

Strapi's flagship feature is the **Content-Type Builder**: an admin UI where you click to create collection types, single types (their term for what KernelCMS calls Globals), and components. Each save writes a JSON schema file (`src/api/<name>/content-types/<name>/schema.json`) and, in dev, restarts the server to regenerate routes, controllers, services, and the database tables. It is genuinely fast for a first prototype and it is the single biggest reason non-developers reach for Strapi.

The cost shows up the moment more than one person touches the project. The schema lives partly in committed JSON and partly in database state, the builder is disabled in production by design, and "what is the actual shape of my content?" has no single answer you can read in a code review. Two developers building locally produce divergent `schema.json` plus divergent migration history, and reconciling that is a manual, error-prone merge of generated files.

KernelCMS inverts this. The schema is `kernel.config.ts` — plain TypeScript, the single source of truth, reviewed and versioned like any other code. There is no builder UI mutating the running system. Migrations are generated from schema diffs against the Drizzle layer, never from clicking around an admin panel.

```ts
// kernel.config.ts
import { defineConfig, collection, fields } from '@kernel/core'

const Article = collection('articles', {
  fields: [
    fields.text('title', { required: true, localized: true }),
    fields.richText('body'),
    fields.relationship('author', { to: 'authors', hasMany: false }),
    fields.upload('cover', { to: 'media' }),
    fields.select('status', {
      options: ['draft', 'review', 'published'],
      defaultValue: 'draft',
    }),
  ],
  versions: { drafts: true, autosave: true },
  access: {
    read: ({ doc }) => doc.status === 'published' || hasRole('editor'),
  },
})

export default defineConfig({
  db: postgres({ url: process.env.DATABASE_URL }),
  collections: [Article],
})
```

The structural difference, side by side:

```
Strapi                                  KernelCMS
------                                  ---------
Admin UI ──clicks──▶ schema.json        kernel.config.ts (TS, reviewed)
        │            (+ DB state)               │
        ▼                                       ▼
   server restart                       diff vs Drizzle schema
        │                                       │
        ▼                                       ▼
 regenerated routes/controllers         generated migration (SQL/file)
        │                                       │
        ▼                                       ▼
   types you hope match            inferred types, zero `any`, e2e
```

Strapi added a typegen step (`strapi ts:generate-types`) that emits `Schema.Attribute` types after the fact, but it is downstream of a JSON file the builder owns. KernelCMS never generates types as a separate artifact you can forget to run — `import type { Article } from '@kernel/client'` is inferred directly from the config, and the Local API returns fully typed documents in-process with no codegen at all. This is the same wedge we use against Payload and Sanity (see [`./03-competitive-analysis-payload.md`](./03-competitive-analysis-payload.md) and [`./04-competitive-analysis-sanity.md`](./04-competitive-analysis-sanity.md)): config-as-code wins, but only Payload also does it — Strapi does not, and that is the gap.

### Field types and components

Strapi's field set is solid: text, rich text (Blocks), media, relations, components, dynamic zones (their version of blocks), JSON, enumeration. KernelCMS matches and extends this with `text`, `textarea`, `number`, `boolean`, `date`, `email`, `json`, `code`, `point`, `select`, `radio`, `checkbox`, `relationship`, `upload`, `array`, `blocks`, `group`, `tabs`, `row`, `richText`, `ui`, and custom field types. Two practical wins: KernelCMS treats **field-level localization** as a first-class flag (`localized: true`) rather than Strapi's plugin-gated i18n, and **field-level access control** evaluates on read and write, which Strapi only approximates through role-based content-type permissions.

| Capability             | Strapi                               | KernelCMS                            |
| ---------------------- | ------------------------------------ | ------------------------------------ |
| Schema source of truth | JSON + DB (builder-owned)            | `kernel.config.ts` (code)            |
| Builder in production  | Disabled by design                   | N/A — no runtime builder             |
| Type generation        | Separate `ts:generate-types` step    | Inferred, no codegen                 |
| Field-level access     | Role-based, content-type granularity | Per-field, per-operation callbacks   |
| Localization           | i18n plugin                          | Built-in `localized` flag            |
| Migrations             | DB lifecycle + ad hoc                | Generated from schema diff (Drizzle) |

## Plugin Marketplace

Strapi's `market.strapi.io` is its real moat. SEO, sitemap, Cloudinary upload providers, email providers, transformer plugins, GraphQL — much of it community-built, installable with `strapi install`. The marketplace proves that an extension story sells a CMS. It also exposes how brittle Strapi's plugin model is: plugins patch the admin via webpack customization, hook into a `register`/`bootstrap`/`destroy` lifecycle, and frequently break across major versions (the v3→v4 and v4→v5 transitions orphaned large swaths of the marketplace). Because the admin is a bespoke React build, a plugin that injects UI is coupled to Strapi's internal component tree, which is not a stable contract.

KernelCMS ships `@kernel/plugin-sdk` with a typed plugin contract and an admin built on **TanStack Start**, so UI extensions slot into documented router and component seams rather than monkey-patching a webpack config. A plugin can add fields, collections, hooks, admin routes, and adapter implementations through one interface.

```ts
// a plugin is a typed function over the config
import { definePlugin } from '@kernel/plugin-sdk'

export const seo = definePlugin({
  name: '@acme/kernel-seo',
  setup(kernel) {
    kernel.extendCollections((c) => ({
      ...c,
      fields: [
        ...c.fields,
        fields.group('seo', {
          fields: [fields.text('metaTitle'), fields.textarea('metaDescription')],
        }),
      ],
    }))
    kernel.admin.addRoute({ path: '/seo-audit', component: () => import('./SeoAudit') })
    kernel.hooks.beforeChange('articles', validateSeo)
  },
})
```

The decisive architectural difference is the adapter contract. Strapi hard-wires a great deal — its database layer, its upload pipeline, its admin bundler. KernelCMS makes **database, storage, email, auth, search, cache, and queue** swappable adapters, each implementing one contract. A "Cloudinary provider plugin" in Strapi is, in KernelCMS, just a `@kernel/storage` adapter; switching Postgres for SQLite/libSQL or MongoDB is a one-line change against `@kernel/db-postgres`, `@kernel/db-sqlite`, `@kernel/db-mysql`, or `@kernel/db-mongodb` rather than a fork. See [`../03-architecture/02-adapters.md`](../01-architecture/adr/0002-drizzle-and-pluggable-db.md) for the contract.

## Community and Ecosystem

Strapi's community is its strongest asset and the bar we have to clear. Tens of thousands of GitHub stars, an active Discord and forum, a paid Cloud offering, and broad tutorial coverage mean a developer hitting an error usually finds an answer. Strapi monetizes through Strapi Cloud and enterprise tiers (RBAC, SSO, audit logs gated behind paid plans) — a model KernelCMS mirrors deliberately: MIT-licensed open-source core, with **KernelCMS Cloud** as the managed, Sanity-style hosted platform and optional enterprise add-ons. The difference we enforce is portability: content and config move between self-host and KernelCMS Cloud with no lock-in, whereas Strapi's paid features create a one-way gravity toward their hosted product.

Where Strapi's ecosystem fragments is the front end. It is backend-only and deliberately frontend-agnostic, so every team rebuilds data fetching, caching, and preview from scratch — usually a hand-rolled fetch layer plus whatever client they like. KernelCMS is **TanStack-native end to end**, which collapses that work:

| Concern                    | Strapi                    | KernelCMS                                    |
| -------------------------- | ------------------------- | -------------------------------------------- |
| Data fetching / cache      | Bring your own            | TanStack Query, shared with admin            |
| List views                 | Custom in your app        | TanStack Table (sort, filter, virtualize)    |
| Edit forms                 | Admin only                | TanStack Form (per-field binding/validation) |
| Routing / search state     | Custom                    | TanStack Router                              |
| Live / offline collections | None                      | TanStack DB (optional reactive client)       |
| Typed client               | Generated SDK (community) | `@kernel/client` inferred from config        |

A frontend developer consuming KernelCMS uses the same `where`/`sort`/pagination/`depth` query language across REST, GraphQL, and typed RPC, with `@kernel/client` returning inferred types. That is one query language and one type system spanning every surface — something neither Strapi's REST plus separate GraphQL plugin nor Sanity's GROQ-only model offers.

## Weaknesses We Exploit

The teardown points to four seams where KernelCMS wins on engineering merit, not marketing.

**1. Runtime schema, not source of truth.** Strapi's builder mutates a running system and persists schema to the database, so the "real" schema is unreviewable and environments drift. KernelCMS makes `kernel.config.ts` the only source of truth, diffed into migrations. Code review covers the data model.

**2. Type safety as an afterthought.** Strapi began as JavaScript; its types are generated downstream of JSON and routinely lag the schema. KernelCMS is TypeScript-first with **zero `any`** — the Local API, RPC, REST response types, and `@kernel/client` are all inferred from one config. There is no "regenerate types" footgun.

**3. Plugin fragility across majors.** Strapi plugins monkey-patch a bespoke admin and break on major upgrades. The `@kernel/plugin-sdk` contract plus a TanStack Start admin gives plugins documented, versioned seams.

**4. Closed infrastructure assumptions.** Strapi treats database, upload, and bundler as mostly fixed. KernelCMS makes every infrastructure concern a swappable adapter against one contract, so teams choose Postgres or MongoDB, S3 or local disk, and any auth/search/cache/queue without forking.

```ts
// the same operation core, three surfaces, one type system
const res = await kernel.find('articles', {
  where: { status: { equals: 'published' } },
  sort: ['-publishedAt'],
  depth: 1,
  limit: 20,
})
// res.docs: Article[]  — typed in-process (Local API),
// over the wire as typed RPC, and identically shaped in REST/GraphQL
```

Strapi taught the market that an open-source headless CMS needs a low-friction modeling experience, a real extension ecosystem, and a credible hosted option. KernelCMS keeps all three and removes the cost Strapi pays for them: it replaces the runtime builder with config-as-code, replaces fragile admin patching with a typed plugin SDK on TanStack Start, and replaces hard-wired infrastructure with swappable adapters — while staying portable between self-host and KernelCMS Cloud.

## Open Questions

- **Migration on-ramp from Strapi.** Should `@kernel/cli` ship a `kernel import strapi` that reads `schema.json` files and emits a starter `kernel.config.ts`? The schemas are mechanical to translate, but dynamic zones, components, and i18n state need careful mapping.
- **No-code modeling parity.** Some teams genuinely want a click-to-build experience. Do we offer an optional admin "config composer" that _writes_ `kernel.config.ts` (and opens a PR) without ever mutating a running system — keeping config-as-code intact?
- **Marketplace governance.** A plugin marketplace needs trust signals. What is the verification, security review, and versioning policy for third-party `@kernel/plugin-sdk` packages, and how do we avoid Strapi's cross-major breakage?
