# Milestones & Phases

KernelCMS ships in five phases — **P0 Foundations**, **P1 Core API**, **P2 Admin**, **P3 Beta**, and **P4 GA** — each gated by hard exit criteria rather than dates. The sequencing is deliberately bottom-up: the operation core and the Adapter contract land before any surface that consumes them, because every later decision (REST, GraphQL, RPC, admin) is downstream of a single typed operation layer. Payload, Sanity, and Strapi all bolted their admin onto an API that calcified early; we invert that, freezing the kernel first and treating every surface as a thin projection of it.

## Phase breakdown

Each phase produces a tagged, installable release of the affected `@kernel/*` packages. Nothing ships to the public registry until P3.

| Phase | Theme | Headline deliverables | Packages frozen for API |
|-------|-------|----------------------|------------------------|
| **P0** | Foundations | Config loader, field type system, Adapter contract, Postgres adapter | `@kernel/core`, `@kernel/db`, `@kernel/db-postgres` |
| **P1** | Core API | Operation core, query language, REST + GraphQL + RPC generation | `@kernel/server`, `@kernel/rest`, `@kernel/graphql`, `@kernel/rpc`, `@kernel/client` |
| **P2** | Admin | TanStack Start admin, collection lists, doc forms, media library, rich text | `@kernel/admin`, `@kernel/ui`, `@kernel/richtext` |
| **P3** | Beta | Drafts/versions, localization, live preview, plugin SDK, second + third adapters | `@kernel/plugin-sdk`, `@kernel/db-sqlite`, `@kernel/db-mongodb` |
| **P4** | GA | Performance budgets, security hardening, docs, Cloud GA, white-label | `@kernel/cloud`, all packages 1.0.0 |

### P0 — Foundations

P0 builds the parts no other layer can fake. `@kernel/core` parses and validates `kernel.config.ts`, normalizes the field tree, and exposes the typed field registry. `@kernel/db` defines the Adapter contract every backend must satisfy; `@kernel/db-postgres` is the reference implementation on Drizzle, and it is the only adapter built in P0 so the contract is proven against exactly one real backend before we generalize.

```ts
// kernel.config.ts — the P0 surface that must compile and validate
import { defineConfig } from '@kernel/core'
import { postgres } from '@kernel/db-postgres'

export default defineConfig({
  db: postgres({ url: process.env.DATABASE_URL! }),
  collections: [
    {
      slug: 'posts',
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'body', type: 'richText' },
        { name: 'author', type: 'relationship', relationTo: 'users' },
      ],
    },
  ],
})
```

The Adapter contract is the most important artifact of the entire project. Get it wrong and every later adapter (SQLite, MySQL, MongoDB) inherits the mistake. Payload learned this the hard way — its database layer was Mongo-shaped for years, and the SQL adapters arrived later with awkward seams. We define the contract abstract from day one:

```ts
// @kernel/db — the contract every backend implements
export interface Adapter {
  find(args: FindArgs): Promise<PaginatedDocs>
  findByID(args: FindByIDArgs): Promise<Document | null>
  create(args: CreateArgs): Promise<Document>
  update(args: UpdateArgs): Promise<Document>
  delete(args: DeleteArgs): Promise<Document>
  migrate(diff: SchemaDiff): Promise<void>
  transaction<T>(fn: (tx: Adapter) => Promise<T>): Promise<T>
}
```

### P1 — Core API

P1 is the operation core in `@kernel/server`: the in-process Local API that every surface calls. The shared query language — `where`, `sort`, pagination, `depth` — is implemented once here and reused everywhere. REST (`@kernel/rest`), GraphQL (`@kernel/graphql`), and typed RPC (`@kernel/rpc`, over TanStack Start server functions) are all generated from content config and delegate to the same operation functions. `@kernel/client` ships the typed wire client.

```ts
// One operation core, three surfaces — all generated, none hand-written
import { getPayload } from '@kernel/server'

const kernel = await getPayload({ config })

// Local API — same types REST/GraphQL/RPC expose
const posts = await kernel.find({
  collection: 'posts',
  where: { status: { equals: 'published' } },
  sort: '-publishedAt',
  depth: 1,
})
```

This is where we beat Strapi structurally. Strapi's REST and GraphQL diverge in capability and query syntax; populate semantics differ between them. KernelCMS forbids that by construction — there is exactly one query resolver, and the surfaces are projections.

### P2 — Admin

The admin app in `@kernel/admin` is built on TanStack Start with TanStack Router for type-safe routing and search-param state. Collection lists use TanStack Table (sorting, filtering, column sizing) with TanStack Virtual for large datasets; document forms use TanStack Form for per-field binding and validation; TanStack Query owns all fetching and invalidation; TanStack Store holds reactive UI state. `@kernel/ui` provides the design-token component library; `@kernel/richtext` provides the block-based editor. The admin consumes only the RPC surface from P1 — it gets no privileged access, which keeps the API honest.

### P3 — Beta

P3 adds the content features that make a CMS a CMS rather than a database admin: drafts and publish, version history with autosave, and field-level localization. Live preview with visual editing lands here. `@kernel/plugin-sdk` ships so the ecosystem can extend the system, and the second and third adapters (`@kernel/db-sqlite`, `@kernel/db-mongodb`) validate the Adapter contract across SQL and document stores. This is the first public release.

### P4 — GA

P4 is hardening, not features. Performance budgets are enforced in CI, the full security sweep is mandatory, documentation is complete, and `@kernel/cloud` reaches managed-hosting GA with billing, observability, backups, and the content CDN. All packages tag 1.0.0 together.

## Sequencing and dependencies

The dependency graph is strictly layered. Each phase consumes only what is frozen below it.

```
P0  ┌─ @kernel/core ──┐
    └─ @kernel/db ────┴─ @kernel/db-postgres
            │
P1          ▼
    @kernel/server ─┬─ @kernel/rest
                    ├─ @kernel/graphql
                    └─ @kernel/rpc ── @kernel/client
            │
P2          ▼
    @kernel/admin ── @kernel/ui, @kernel/richtext   (consumes RPC only)
            │
P3          ▼
    drafts/versions/i18n/preview, @kernel/plugin-sdk
    @kernel/db-sqlite, @kernel/db-mongodb
            │
P4          ▼
    perf budgets, security gate, @kernel/cloud, 1.0.0
```

Two dependencies are non-negotiable. First, **the Adapter contract must be stable before P1 starts** — the operation core is written against the interface, not the Postgres implementation. Second, **the RPC surface must be stable before P2 starts** — the admin is a client, and a moving wire format means perpetual admin churn. See [Adapters](../03-persistence/00-persistence-overview-and-adapter-contract.md) and APIs for the contracts these phases freeze.

Three things are deliberately deferred to avoid blocking the critical path: the extra SQL/document adapters wait until P3 (the contract is proven on one backend first), the plugin SDK waits until the internal extension points have settled, and Cloud multi-tenancy waits until the self-host story is solid — see [Deployment](../10-cloud-operations/00-deployment-models-self-host-vs-cloud.md).

## Team allocation

Five squads, sized to the phase that needs them most. Allocation shifts as the critical path moves.

| Squad | Owns | P0 | P1 | P2 | P3 | P4 |
|-------|------|----|----|----|----|----|
| **Kernel** | core, db, adapters | ●●● | ●● | ○ | ●● | ● |
| **API** | server, rest, graphql, rpc | ○ | ●●● | ● | ● | ● |
| **Admin** | admin, ui, richtext | ○ | ○ | ●●● | ●● | ● |
| **Platform** | cloud, deploy, CI, perf | ● | ● | ● | ● | ●●● |
| **DX/Docs** | cli, create-kernel, client, docs | ● | ● | ● | ●● | ●●● |

`●●●` lead, `●●`/`●` support, `○` minimal. The Kernel squad front-loads P0/P1 then rotates to adapters in P3. The Admin squad is idle-by-design in P0/P1 — pulling them in early to "help" only produces admin code against an unstable API that gets rewritten. DX/Docs ramps hard into P3/P4 because the public beta is the first time external users hit `create-kernel` and the docs.

## Exit criteria per phase

A phase is done when every box is checked. Dates do not move criteria.

**P0 exit**
- `kernel.config.ts` parses, type-checks, and validates with actionable errors.
- All field types resolve into the typed registry; zero `any` in `@kernel/core`.
- Postgres adapter passes the full Adapter conformance suite.
- Migrations generate correctly from a schema diff and round-trip.

**P1 exit**
- Local API implements all CRUD operations plus the full query language.
- REST, GraphQL, and RPC are auto-generated and pass an identical behavior matrix — same `where`/`sort`/`depth` results across all three.
- `@kernel/client` is end-to-end type-safe against a sample config.
- Access control evaluates at operation, document, and field level.

**P2 exit**
- Admin performs full CRUD via RPC for collections and globals.
- Lists virtualize and stay responsive at 50k+ rows; forms validate per field (sync + async).
- Rich-text editor produces and round-trips block content.
- Keyboard navigation and command palette functional; WCAG 2.2 AA on core flows.

**P3 exit**
- Drafts/publish, version history with autosave, and field-level localization work end to end.
- Live preview with visual editing functional against a sample frontend.
- `@kernel/plugin-sdk` documented; one first-party plugin built against it.
- SQLite and MongoDB adapters pass the same conformance suite as Postgres.
- `create-kernel` scaffolds a working project in under two minutes.

**P4 / GA exit**
- Performance budgets enforced in CI and green.
- Saga security audit and Loki red-team pass with zero CRITICAL/HIGH findings.
- Docs complete; migration guides from Payload, Sanity, and Strapi published.
- KernelCMS Cloud GA: billing, observability, backups, CDN live; content portable in/out.
- All `@kernel/*` packages tagged 1.0.0.

## Open questions

- **Adapter freeze timing.** Should the MySQL adapter (`@kernel/db-mysql`) ship in P3 alongside SQLite/MongoDB, or wait for a P3.5 point release? Building four adapters before GA may delay P3.
- **TanStack DB scope.** Is optional reactive client-side collections a P3 beta feature or a post-GA addition? It is the least proven TanStack dependency and may not be GA-blocking.
- **Cloud and self-host parity.** Does GA require feature parity between `@kernel/cloud` and self-host, or can Cloud trail by one minor version as long as content/config stay portable?
