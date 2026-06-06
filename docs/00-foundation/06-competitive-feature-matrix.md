# Competitive Feature Matrix

This document is the canonical, feature-by-feature comparison between KernelCMS and the three headless CMS products it competes against: Payload, Sanity, and Strapi. It exists so that contributors, evaluators, and roadmap owners share one honest picture of where KernelCMS leads, where it reaches parity, and where it has gaps to close. Every cell is a claim we are willing to defend with a config snippet or an adapter contract. Marketing-grade hand-waving is not allowed here.

## How to read this document

KernelCMS is positioned on two structural bets that none of the incumbents make: the entire stack is **TanStack-native** (Start, Router, Query, Table, Form, Store, Virtual, DB), and **every infrastructure concern is a swappable adapter** — database, storage, email, auth, search, cache, and queue. The matrix below is organized to surface those bets, not to hide them inside a generic checklist. Where we differ from a competitor's architecture rather than just its feature flags, the difference is called out in prose.

For the underlying philosophy behind these comparisons, see [Positioning & Wedge](./02-positioning-and-differentiation.md), the Architecture Overview, and the [Adapter Contracts](../03-persistence/00-persistence-overview-and-adapter-contract.md).

## Scoring methodology

The matrix uses a four-level scale. A feature is only as good as its weakest realistic production path, so we score against shipping a real, multi-environment project — not against a marketing page.

| Symbol | Meaning | Bar to clear |
| --- | --- | --- |
| `Full` | First-class, documented, typed | Works end-to-end with type inference; covered by tests; no plugin required |
| `Partial` | Exists with caveats | Works, but needs a plugin, manual wiring, or loses type safety |
| `Plugin` | Available only via third-party/community add-on | Not in core; quality and maintenance vary |
| `None` | Not available | No supported path |

Two rules keep the scoring honest:

1. **Type safety is a scoring input, not a footnote.** If a feature works at runtime but forces `any` or hand-written types at the call site, it caps at `Partial`. KernelCMS's engineering tenet is zero `any` end-to-end, and we hold competitors to the same line we hold ourselves.
2. **A managed-only feature is not a self-host feature.** If something only exists in a vendor's hosted tier (notably several Sanity capabilities), it is scored from the self-host column's perspective and annotated. KernelCMS Cloud features are scored the same way against KernelCMS self-host.

Scores reflect the products as of this writing: Payload 3.x (Next.js-native, TypeScript), Sanity (hosted Content Lake + GROQ + Studio), and Strapi 5.x (Node/Koa, JS-first with TS support).

## The feature matrix

### Core platform & language

| Capability | KernelCMS | Payload | Sanity | Strapi |
| --- | --- | --- | --- | --- |
| Language | TS-first, zero `any` | TS-first | TS in Studio, JS content API | JS-first, TS supported |
| Config-as-code | `kernel.config.ts` | `payload.config.ts` | `sanity.config.ts` (Studio) + schema | Mixed: code + admin UI |
| Admin framework | TanStack Start | Next.js | Custom (Sanity Studio) | Custom (React) |
| Self-host | Full | Full | Partial (Studio only; data is hosted) | Full |
| Managed cloud | KernelCMS Cloud | Payload Cloud | Sanity (primary model) | Strapi Cloud |
| Content portability self-host ↔ cloud | Full | Partial | None (data lives in Content Lake) | Partial |

The decisive line here is the Sanity row: Sanity's content lives in a hosted Content Lake, so "self-host" means self-hosting the Studio against someone else's database. KernelCMS guarantees content and config portability in both directions — the same `kernel.config.ts` and the same adapters run locally, in Docker, and on KernelCMS Cloud. That is the no-lock-in promise made concrete.

### Data layer & adapters

| Capability | KernelCMS | Payload | Sanity | Strapi |
| --- | --- | --- | --- | --- |
| Postgres | Full (Drizzle, default) | Full | None | Full |
| SQLite / libSQL | Full | Full | None | Full |
| MySQL | Full | Partial | None | Full |
| MongoDB | Full | Full | None | None |
| Swappable DB adapter contract | Full | Partial | None | Partial |
| Pluggable storage adapter | Full | Plugin | Built-in (hosted) | Plugin |
| Pluggable search adapter | Full | Plugin | Built-in (hosted) | Plugin |
| Pluggable cache / queue adapter | Full | None | None | None |
| Migrations from schema diff | Full | Full | N/A (schemaless) | Partial |

KernelCMS implements one `Adapter` contract that every backend satisfies, and extends the same swappable model to storage, email, auth, search, cache, and queue. Payload and Strapi let you swap the database but treat storage and search as plugins and offer no first-class cache/queue abstraction. Sanity does not have this axis at all — the data layer is the product.

```typescript
// kernel.config.ts — every infra concern is an adapter, chosen explicitly.
import { defineConfig } from '@kernel/core'
import { postgres } from '@kernel/db-postgres'
import { s3 } from '@kernel/storage'

export default defineConfig({
  db: postgres({ url: process.env.DATABASE_URL }),
  storage: s3({ bucket: 'media', region: 'eu-north-1' }),
  // search, cache, queue, email, auth: same shape, swap freely.
  collections: [Posts, Authors],
  globals: [SiteSettings],
})
```

### Field types & modeling

| Capability | KernelCMS | Payload | Sanity | Strapi |
| --- | --- | --- | --- | --- |
| Primitive fields (text, number, date, etc.) | Full | Full | Full | Full |
| `relationship` | Full | Full | Full (references) | Full |
| `array` / repeatable | Full | Full | Full | Full |
| `blocks` (polymorphic) | Full | Full | Full (portable text) | Partial (dynamic zones) |
| `tabs` / `group` / `row` layout | Full | Full | Partial | None |
| `point` (geo) | Full | Full | Plugin | None |
| `code` / `json` fields | Full | Full | Partial | Partial |
| Custom field types | Full | Full | Full | Partial |
| Globals (singletons) | Full | Full | Full (documents) | Full (single types) |

Modeling is the most mature area across all four products, and KernelCMS matches Payload here closely on purpose — Payload's field model is the strongest of the incumbents and is the right bar. Strapi's dynamic zones are its blocks analogue but are weaker on nesting and layout fields.

### Content workflow

| Capability | KernelCMS | Payload | Sanity | Strapi |
| --- | --- | --- | --- | --- |
| Drafts / publish | Full | Full | Full | Full |
| Version history | Full (autosave) | Full | Full (hosted) | Partial |
| Field-level localization | Full | Full | Plugin | Partial |
| Sync + async + cross-field validation | Full | Full | Partial | Partial |
| Access control: operation / document / field | Full | Full | Partial | Partial (RBAC) |
| Live preview + visual editing | Full | Full | Full (Presentation) | Plugin |

Access control is where KernelCMS and Payload separate from the pack. Both evaluate access at three granularities — the operation, the document, and the individual field — server-side and on by default. Strapi's RBAC is role-centric and weaker at the document and field level; Sanity's strength is its real-time collaboration model rather than fine-grained programmatic field access in self-host setups.

### APIs & query language

| Capability | KernelCMS | Payload | Sanity | Strapi |
| --- | --- | --- | --- | --- |
| Auto-generated REST | Full | Full | None (uses GROQ) | Full |
| Auto-generated GraphQL | Full | Full | Partial | Full |
| Typed in-process Local API | Full | Full | None | Partial |
| Typed RPC over the wire | Full (Start server fns) | None | None | None |
| One shared query language across surfaces | Full (`where`/`sort`/depth) | Partial | GROQ (its own) | Partial |

This row is a genuine KernelCMS differentiator. The Local API is the same operation core as REST/GraphQL, called in-process with full type inference, and exposed over the wire as typed RPC through TanStack Start server functions. The exact same `where`/`sort`/pagination/`depth` query language spans REST, GraphQL, RPC, and Local.

```typescript
// Same query language, in-process and fully typed — no codegen step.
import { getLocalAPI } from '@kernel/server'

const kernel = await getLocalAPI()
const { docs } = await kernel.find('posts', {
  where: { status: { equals: 'published' }, 'author.role': { equals: 'editor' } },
  sort: '-publishedAt',
  depth: 2,
  limit: 20,
})
// `docs` is fully inferred from the Posts collection config. Zero `any`.
```

### Admin experience

| Capability | KernelCMS | Payload | Sanity | Strapi |
| --- | --- | --- | --- | --- |
| Config-driven UI | Full | Full | Full | Partial |
| Dark mode | Full | Full | Full | Full |
| Command palette / keyboard UX | Full | Partial | Partial | None |
| Virtualized list & long-document rendering | Full (TanStack Virtual) | Partial | Partial | None |
| Block-based rich-text editor | Full | Full | Full (Portable Text) | Partial |
| Media library | Full | Full | Full (hosted) | Full |
| WCAG 2.2 AA | Full | Partial | Partial | Partial |
| i18n + RTL admin | Full | Full | Partial | Partial |
| White-label theming | Full | Partial | Partial | Plugin |

The TanStack foundation pays off in this section. List views are TanStack Table (sorting, filtering, column sizing, virtualization); edit forms are TanStack Form with per-field binding; long lists and documents use TanStack Virtual. Accessibility to WCAG 2.2 AA is a non-negotiable tenet, not a checkbox — the others sit at `Partial` because their admin UIs ship known gaps in keyboard and screen-reader coverage.

```
 Admin data flow (TanStack-native)
 ┌──────────────┐   server fn / RPC   ┌──────────────┐
 │ TanStack     │ ──────────────────▶ │ @kernel/     │
 │ Query cache  │ ◀────────────────── │ server core  │
 └──────┬───────┘                     └──────┬───────┘
        │ feeds                              │ same op core
        ▼                                    ▼
 Table · Form · Virtual              REST · GraphQL · Local
```

## Gaps and opportunities

An honest matrix names where KernelCMS is not yet ahead.

- **Ecosystem maturity.** Payload, Sanity, and Strapi each have years of community plugins, integrations, and Stack Overflow answers. KernelCMS's `@kernel/plugin-sdk` is the right shape, but a shape is not an ecosystem. The opportunity: the TanStack audience is large and underserved by current CMSes, so plugin gravity can build quickly if the SDK stays boringly stable.
- **Real-time collaborative editing.** Sanity's multiplayer editing on the Content Lake is genuinely ahead. KernelCMS has the pieces — TanStack DB for reactive client collections, plus a queue/cache adapter — but co-editing presence and conflict resolution are not yet `Full`. This is the most strategically important gap to close.
- **Managed search depth.** Sanity ships GROQ and hosted search as a built-in. KernelCMS treats search as a swappable adapter (a strength for choice), but the default adapters need to reach parity on relevance and faceting before we can claim a clean win on the API row.
- **GraphQL federation.** Auto-generated GraphQL is `Full`, but federation/stitching across multiple KernelCMS instances is unscoped. Strapi and Payload are no better here, so this is an opportunity to lead rather than a gap to defend.
- **Migration tooling from competitors.** Importers from Strapi and Payload schemas into `kernel.config.ts` would lower switching cost dramatically. None exist yet; the config-as-code model makes them tractable.

## Headline takeaways

1. **KernelCMS wins outright on the API surface and the adapter model.** The typed Local API plus typed RPC over TanStack Start server functions, sharing one query language across REST/GraphQL/RPC/Local, is something none of the three incumbents offer. The same is true of a single `Adapter` contract spanning database, storage, email, auth, search, cache, and queue.
2. **KernelCMS reaches parity with Payload on modeling, workflow, and access control** — deliberately, because Payload sets the bar there — and pulls ahead on admin accessibility, command-palette UX, and virtualization because of the TanStack foundation.
3. **KernelCMS wins decisively against Sanity on portability and self-host**, since Sanity's content lives in a hosted Content Lake with no true self-host data path, while KernelCMS guarantees content and config portability between self-host and KernelCMS Cloud.
4. **The real fights are ecosystem maturity and real-time collaboration**, where the incumbents lead today. Both are closable: ecosystem via a stable `@kernel/plugin-sdk` aimed at the large, underserved TanStack audience, and collaboration via TanStack DB plus the queue/cache adapters.

## Open questions

- **Scoring weight.** Should the matrix move to a weighted numeric score (so API + adapter strengths visibly dominate) or stay categorical to avoid false precision? Undecided.
- **Plugin parity threshold.** What plugin count or coverage qualifies a row to graduate from `Plugin` to `Partial`/`Full` for the ecosystem comparison? Needs a concrete rubric before the next revision.
- **Real-time scoring.** Until co-editing ships, do we score it `Partial` (pieces exist) or `None` (no supported path)? Currently leaning `None` to stay honest, pending the collaboration design in Realtime & Collaboration.
