# MVP Scope & Definition

The KernelCMS MVP is the smallest version that a real team can self-host in production and never feel like they hit a wall. It is not a demo. The bar is: model content in `kernel.config.ts`, run `kernel dev`, edit documents in the admin panel, and read that content over REST, GraphQL, and the typed Local/RPC API — all with end-to-end types and zero `any`. This document fixes what ships, what explicitly does not, what "done" means for each surface, and who we are building the first release for.

## The MVP feature set

The MVP proves the wedge: TanStack-native end to end, and persistence as a swappable adapter. Everything below is in scope for v1.

### Content modeling

Collections and globals defined as code. The config is the single source of truth — types, REST/GraphQL schemas, and the admin UI all derive from it. No separate schema file, no UI builder, no drift.

```ts
// kernel.config.ts
import { defineConfig } from '@kernel/core'
import { postgres } from '@kernel/db-postgres'
import { localDisk } from '@kernel/storage'

export default defineConfig({
  db: postgres({ url: process.env.DATABASE_URL! }),
  storage: localDisk({ dir: './uploads' }),
  collections: [
    {
      slug: 'posts',
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'slug', type: 'text', unique: true, index: true },
        { name: 'body', type: 'richText' },
        { name: 'hero', type: 'upload', relationTo: 'media' },
        { name: 'author', type: 'relationship', relationTo: 'users' },
        { name: 'status', type: 'select', options: ['draft', 'published'] },
      ],
      access: {
        read: () => true,
        update: ({ req }) => Boolean(req.user),
      },
    },
    { slug: 'media', upload: true, fields: [{ name: 'alt', type: 'text' }] },
  ],
  globals: [{ slug: 'settings', fields: [{ name: 'siteName', type: 'text' }] }],
})
```

The MVP field types are the ones a content team actually needs on day one:

| Category       | Fields in MVP                                                    |
| -------------- | ---------------------------------------------------------------- |
| Scalar         | `text`, `textarea`, `number`, `boolean`, `date`, `email`, `json` |
| Choice         | `select`, `radio`, `checkbox`                                    |
| Relational     | `relationship`, `upload`                                         |
| Structural     | `array`, `group`, `row`, `tabs`                                  |
| Rich           | `richText`, `blocks`                                             |
| Presentational | `ui`                                                             |

That is enough to model a marketing site, a docs site, or a product catalog. `code`, `point`, and custom field types ship later (see Exclusions).

### Persistence and the Adapter contract

The MVP ships **Postgres (default)** and **SQLite/libSQL**, both on Drizzle, behind one `Adapter` interface. This is the load-bearing decision: proving two SQL backends share one contract is what makes the "choose everything" claim real rather than aspirational. MySQL and MongoDB are post-MVP, but the contract is frozen in v1 so they slot in without touching `@kernel/core`.

```ts
interface Adapter {
  find(args: FindArgs): Promise<PaginatedDocs>
  findByID(args: FindByIDArgs): Promise<Document | null>
  create(args: CreateArgs): Promise<Document>
  update(args: UpdateArgs): Promise<Document>
  delete(args: DeleteArgs): Promise<Document>
  migrate(): Promise<void>
  transaction<T>(fn: (tx: Adapter) => Promise<T>): Promise<T>
}
```

Migrations are generated from schema diffs via `kernel migrate`. Payload and Strapi both couple you tightly to their data layer; KernelCMS treats the database as a port, and v1 has to demonstrate that with two real implementations.

### The three APIs and one query language

REST and GraphQL are auto-generated from config. The Local API is the same operation core, called in-process with full type inference, and exposed over the wire as typed RPC through TanStack Start server functions. One `where`/`sort`/pagination/`depth` query language spans all three.

```
                       ┌──────────────────────────┐
   kernel.config.ts ──▶│   Operation core         │──▶ Adapter ──▶ DB
                       │ (access, hooks, validate) │
                       └────┬─────────┬────────┬───┘
                            │         │        │
                         REST     GraphQL   Local/RPC
                          │           │        │
                       fetch     gql query  payload.find(...)
```

```ts
// Local API — fully inferred, same core as REST/GraphQL
const { docs } = await payload.find({
  collection: 'posts',
  where: { status: { equals: 'published' } },
  sort: '-publishedAt',
  depth: 1,
  limit: 20,
})
//      ^? docs: Post[]   — title/slug/body typed from config
```

Sanity gives you GROQ and a great query story but no typed in-process API; Strapi's REST and GraphQL drift from each other. KernelCMS guarantees the three surfaces share one core, so behavior — access control, hooks, validation — is identical everywhere.

### Admin panel

React on TanStack Start, config-driven. MVP admin includes:

- **Auth UI** — login, logout, password reset (email via the email adapter).
- **Collection list views** on TanStack Table: sorting, filtering, pagination, column sizing.
- **Document edit forms** on TanStack Form with per-field binding and validation.
- **Drafts & publish** with version history and autosave.
- **Media library** backed by the storage adapter (local disk for MVP, S3-compatible behind the same interface).
- **Block-based rich-text editor** for `richText` and `blocks`.
- **Dark mode, keyboard navigation, command palette**, WCAG 2.2 AA on core flows.

Data fetching is TanStack Query throughout; routing and search-param state are TanStack Router; lightweight UI state is TanStack Store; long lists virtualize via TanStack Virtual.

### Auth, access control, and adapters

Email/password auth via `@kernel/auth` with sessions. Access control is evaluated at the operation, document, and field level, server-side. The MVP ships swappable adapters for **database** (Postgres, SQLite), **storage** (local disk, S3-compatible), and **email** (SMTP). Search, cache, and queue adapters are defined as interfaces but ship with no-op/in-memory defaults only.

### Tooling and client

`create-kernel` scaffolds a project; the `kernel` CLI runs `dev`, `build`, `migrate`, and `generate:types`. `@kernel/client` is a typed fetch client generated from config for frontend consumption.

## Explicit exclusions

What we are deliberately **not** shipping in v1. These are not failures of scope — they are sequencing decisions, and most depend on contracts the MVP locks down.

| Excluded from MVP                           | Why deferred                                                        | Lands    |
| ------------------------------------------- | ------------------------------------------------------------------- | -------- |
| KernelCMS Cloud (managed hosting, billing)  | Self-host must be solid before multi-tenant; needs the stable core  | Post-MVP |
| MySQL & MongoDB adapters                    | Contract proven with Postgres + SQLite first                        | Post-MVP |
| Live preview / visual editing               | Depends on a stable richText + draft model                          | Post-MVP |
| Field-level localization & i18n/RTL admin   | Large surface; needs the field schema frozen                        | Post-MVP |
| TanStack DB reactive client collections     | Powerful but additive; not needed to ship content                   | Post-MVP |
| Plugin SDK (`@kernel/plugin-sdk`)           | Public extension API must not churn — stabilize core first          | Post-MVP |
| Search, cache, queue (real adapters)        | Interfaces ship; real backends (e.g. Meilisearch, Redis) come later | Post-MVP |
| White-label theming, advanced RBAC roles    | Access primitives ship; role management UI is later                 | Post-MVP |
| `code` & `point` field types, custom fields | Niche for v1; field plugin API comes with the SDK                   | Post-MVP |
| Edge/Bun runtime targets                    | Node-first; broaden after the core is stable                        | Post-MVP |

Payload shipped its first versions without managed hosting or live preview and added them later — that ordering is correct and we follow it. Sanity leads with a hosted platform; we deliberately invert that, because portability and self-host credibility are the trust foundation. Cross-references: Cloud architecture, [Localization](../02-data-modeling/09-localization-and-i18n.md), Plugin SDK.

## Definition of done

The MVP is done when every item below is true and verifiable in CI — not when it demos.

### Per-surface acceptance criteria

| Surface        | Done means                                                                                    |
| -------------- | --------------------------------------------------------------------------------------------- |
| Config         | `defineConfig` type-checks; invalid configs fail at compile time, not runtime                 |
| Adapters       | Postgres and SQLite pass one shared adapter conformance suite (identical results)             |
| REST           | Full CRUD + query language; OpenAPI spec generated from config                                |
| GraphQL        | Generated schema covers all collections/globals; introspection matches config                 |
| Local/RPC      | `payload.find/create/update/delete` fully typed; RPC mirrors Local API behavior over the wire |
| Admin          | Create/edit/publish a document end to end; list, media upload, rich text all functional       |
| Access control | Op/doc/field rules enforced server-side; covered by tests that assert denial paths            |
| Migrations     | `kernel migrate` generates and applies diffs on both SQL adapters                             |

### Cross-cutting gates

```
DoD gate ─────────────────────────────────────────────
[x] tsc --noEmit clean, zero `any` in shipped packages
[x] One config drives REST + GraphQL + RPC with identical results
[x] Adapter conformance suite green on Postgres AND SQLite
[x] Coverage ≥ 80% line / 70% branch on @kernel/core + @kernel/server
[x] Security sweep: access denial tested, no injection, no secrets in logs
[x] Performance budgets met (cold start, list query p95, admin TTI)
[x] create-kernel → running admin in < 5 minutes on a clean machine
[x] WCAG 2.2 AA on login, list, and edit flows
───────────────────────────────────────────────────────
```

The single most important gate is the second line: **one config, three surfaces, identical results.** If REST and GraphQL disagree, the MVP is not done. This is precisely the failure mode that erodes trust in Strapi, and we treat it as a release blocker.

### Performance budgets (enforced)

| Metric                       | Budget   |
| ---------------------------- | -------- |
| Cold start (Node, Postgres)  | < 800 ms |
| List query p95 (10k docs)    | < 120 ms |
| Admin route TTI              | < 2.5 s  |
| `create-kernel` to first run | < 5 min  |

## The target user for the MVP

The MVP is for the **self-hosting TypeScript developer** building a content-driven site or app for themselves or a small team — the same person who today reaches for Payload because they want config-as-code and an owned database, but who lives in the TanStack ecosystem and wants the CMS to speak the same language as their app.

Concretely, the v1 user:

- Runs Node and a SQL database they control (Postgres in prod, SQLite locally).
- Wants types to flow from content model to query result with no codegen ceremony.
- Will self-host on Docker or a single VM; does not need managed hosting yet.
- Needs drafts, publish, media, and rich text — not localization or live preview on day one.
- Has 1–5 editors, not an enterprise approval workflow.

We are explicitly **not** targeting, in the MVP: enterprise teams needing SSO/SAML and granular RBAC, agencies needing white-label multi-tenant hosting, or non-technical users expecting a no-code schema builder. Sanity owns the hosted, real-time, non-developer-friendly end; Strapi chases enterprise RBAC. The MVP wins a narrower fight first — the TanStack developer who wants Payload's model without leaving the TanStack world — and earns the right to expand from there. See Architecture overview and Getting started.

## Open questions

- **Default richText representation** — portable JSON AST vs. a Lexical/ProseMirror-tied model. Affects whether richText survives an adapter or editor swap. Leaning portable AST.
- **Autosave granularity** — per-field deltas vs. whole-document snapshots for version history. Trade-off between storage cost and diff fidelity.
- **RPC transport boundary** — how much of the Local API surface to expose over RPC by default vs. opt-in per operation, given access control must hold identically on both.
- **SQLite in production** — do we bless libSQL/Turso as a first-class production target in v1, or position SQLite as dev-only and require Postgres for prod?
