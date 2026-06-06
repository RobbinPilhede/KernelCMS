# Risks & Mitigations

KernelCMS makes two large bets: that betting the entire stack on the TanStack ecosystem is a durable advantage rather than a liability, and that "choose everything" adapter swappability can be delivered without the system collapsing into a leaky abstraction. This document is the honest accounting of what could go wrong — technical, market, and ecosystem — and the concrete engineering and strategic moves we use to contain each risk. We grade each risk on likelihood and impact, name the early-warning signal we watch, and describe the mitigation already built into the architecture rather than aspirational hand-waving.

## Risk register at a glance

| ID  | Risk                                                  | Likelihood | Impact   | Primary mitigation                                             |
| --- | ----------------------------------------------------- | ---------- | -------- | -------------------------------------------------------------- |
| T1  | Adapter contract leaks DB-specific behavior           | High       | High     | Conformance test suite every adapter must pass                 |
| T2  | Auto-generated GraphQL/REST schemas drift from config | Medium     | High     | Single operation core; generators are pure functions of config |
| T3  | Type inference cost explodes editor/build performance | Medium     | High     | Performance budgets in CI; codegen fallback path               |
| T4  | Migration generation produces destructive diffs       | Medium     | Critical | Diff classification + mandatory review gate                    |
| M1  | Payload/Sanity/Strapi out-execute on mindshare        | High       | High     | Wedge on TanStack-native + portability                         |
| M2  | Cloud cannibalizes or distracts from OSS core         | Medium     | Medium   | Strict open-core boundary, portability guarantee               |
| M3  | Slow adoption starves the plugin ecosystem            | Medium     | High     | First-party adapters cover 90% of needs                        |
| D1  | TanStack breaking changes / abandonment               | Low–Medium | High     | Thin internal facades, version pinning, contribution           |

## Technical risks

### T1 — The adapter contract leaks

The "choose everything" promise lives or dies on one interface. Every database, storage, email, auth, search, cache, and queue backend implements an `Adapter` contract, and the danger is that Postgres semantics quietly bleed into the contract so that `@kernel/db-mongodb` or `@kernel/db-sqlite` can never fully satisfy it. Strapi suffered a milder version of this — its query engine assumed relational semantics, which made its Mongo support brittle and eventually dropped. Payload took the opposite, cleaner route with a narrow database adapter interface; we follow that instinct but widen it across all seven infrastructure concerns.

Our defense is a shared conformance suite. The contract is defined once in `@kernel/core`, and every adapter package is tested against the same behavioral spec — not a mock, but the real backend in a container.

```ts
// @kernel/core — the contract is the test, not just the type
import { defineAdapterConformance } from '@kernel/core/testing'

defineAdapterConformance({
  name: '@kernel/db-postgres',
  setup: async () => createPostgresAdapter({ url: process.env.TEST_DB_URL! }),
  // Every adapter must satisfy: where/sort/pagination/depth, transactions,
  // field localization, drafts, version history, and nested upserts.
})
```

If a behavior cannot be expressed uniformly (e.g., MongoDB lacks real transactions across some topologies), the contract surfaces a typed capability flag rather than pretending. Callers can branch on `adapter.capabilities.transactions` instead of discovering the gap at runtime. See Adapters Overview for the full contract surface.

### T2 — Generated APIs drift from config

REST, GraphQL, and typed RPC are all auto-generated from content config. The failure mode is three generators interpreting the same `kernel.config.ts` slightly differently, so a field is required in REST but nullable in GraphQL. Sanity avoids this by having one query language (GROQ); we avoid it by routing every surface through a single operation core.

```
kernel.config.ts ──▶ Collection/Global schema (canonical)
                          │
                          ▼
                 Operation core (find/create/update/delete)
                  │           │            │
                  ▼           ▼            ▼
                REST       GraphQL     typed RPC
              (@kernel/rest) (@kernel/graphql) (@kernel/rpc)
```

The generators are pure functions of the canonical schema and never re-derive validation, access control, or shape independently. The Local API _is_ the operation core called in-process; RPC is that same core exposed over TanStack Start server functions. One shared query language (`where` / `sort` / pagination / `depth`) spans all of them, which is enforced by a cross-surface contract test that issues the identical logical query through REST, GraphQL, and RPC and asserts byte-equivalent results.

### T3 — Type inference becomes the bottleneck

End-to-end type safety with zero `any` is a tenet, but deep generic inference is exactly what makes large TypeScript projects slow to typecheck and laggy in the editor. A 200-collection config with relationship `depth` chains can produce inference graphs that blow past acceptable `tsc` times. This is a real, measured risk — not theoretical.

We enforce performance budgets in CI using `tsc --extendedDiagnostics` and fail the build if instantiation counts or check time regress beyond a threshold. The escape hatch is a generated `.d.ts` path: for very large projects, `kernel generate types` materializes concrete types so the editor consumes flat declarations instead of resolving generics live.

```ts
// kernel.config.ts
export default defineConfig({
  typegen: {
    // 'infer' for small/medium projects; 'codegen' emits flat .d.ts at scale.
    mode: 'codegen',
    outDir: './.kernel/types',
  },
})
```

### T4 — Migrations destroy data

Migrations are generated from schema diffs with Drizzle as the default SQL ORM. Auto-generated migrations are convenient and dangerous: a renamed field looks identical to a drop-plus-add, and silently running that against production deletes a column. Every CMS with codegen migrations has shipped this footgun.

We classify each diff by destructiveness and gate it. Non-destructive changes (add nullable column, add index) apply freely; destructive ones (drop column, narrow type, drop table) require an explicit acknowledgment and a printed data-loss warning.

```ts
// @kernel/cli output
$ kernel migrate diff
  + add column posts.subtitle (text, nullable)        safe
  ~ widen column posts.views (int → bigint)           safe
  - DROP column posts.legacy_slug                     DESTRUCTIVE — requires --allow-destructive
```

Rename detection prompts interactively when run locally and refuses to guess in CI. Details live in Migrations.

## Market and adoption risks

### M1 — Incumbents out-execute on mindshare

Payload owns the "code-first, self-hosted, TypeScript" narrative. Sanity owns structured content and real-time collaboration with a polished hosted product. Strapi owns sheer install base and plugin breadth. We are entering a crowded field where the default outcome for a new CMS is irrelevance.

Our answer is a sharp wedge, not feature parity on day one. Two things no incumbent has:

- **TanStack-native end to end.** Server and admin both run on TanStack Start, Router, Query, Table, Form, Store, Virtual, and DB. For teams already standardized on TanStack — a fast-growing cohort — KernelCMS is the only CMS where the admin's data layer, routing, and forms are the libraries they already know. Payload's admin is bespoke; Sanity's is its own runtime; Strapi's is React-Redux legacy.
- **No lock-in across self-host and Cloud.** Content and config are portable between self-host and KernelCMS Cloud by guarantee. Sanity is effectively hosted-only; Strapi Cloud and Payload Cloud exist but the portability story is weaker than "the same `kernel.config.ts` runs both places, byte-identical."

We do not win by being broader than Strapi in year one. We win the TanStack-shaped segment first, then expand outward. See [Positioning](../00-foundation/02-positioning-and-differentiation.md).

### M2 — Cloud distorts the open-source core

The commercial KernelCMS Cloud could quietly starve the MIT core — the classic open-core trap where the good features migrate behind a paywall and the community loses trust (the criticism repeatedly leveled at hosted-CMS vendors). If contributors smell a bait-and-switch, the ecosystem we depend on never forms.

The boundary is architectural and contractual: everything required to model, store, query, and edit content is in the MIT-licensed core. Cloud adds operational surface — managed multi-tenant hosting, billing, observability, backups, global content CDN — never content capability. The portability guarantee is the enforcement mechanism: if Cloud could do something the core cannot, portability would break, and portability is a tested invariant.

### M3 — Thin adoption starves the plugin ecosystem

A CMS is only as strong as its adapters and plugins, and those require a critical mass of users to materialize. Strapi's marketplace is its moat; a new entrant has none. If we ship a beautiful core and an empty `@kernel/plugin-sdk` ecosystem, we lose.

Mitigation: we do not depend on the community for table-stakes infrastructure. First-party packages — `@kernel/db-postgres`, `@kernel/db-sqlite`, `@kernel/db-mysql`, `@kernel/db-mongodb`, `@kernel/storage`, `@kernel/auth`, `@kernel/graphql`, `@kernel/rest`, `@kernel/rpc`, `@kernel/richtext` — cover roughly 90% of real deployments out of the box. The `@kernel/plugin-sdk` exists to extend, not to fill gaps that should never have existed. Community plugins are upside, not a dependency.

## Dependency risk on TanStack

This is the bet that defines KernelCMS, so it deserves the most candor. We are coupled to nine TanStack libraries. If TanStack ships a hostile breaking change, slows maintenance, or a core library is abandoned, our differentiation becomes our liability.

We assess the _likelihood_ as low-to-medium — TanStack is actively maintained, widely adopted, and several libraries are stable — but the _impact_ is high, so we engineer as if a breaking change is a when, not an if.

**Facade isolation.** No `@kernel/*` package imports TanStack libraries directly across the codebase at large. Each is wrapped behind a thin internal facade so a breaking upgrade is contained to one module.

```ts
// @kernel/admin/internal/query.ts — the ONLY file that imports @tanstack/react-query
export { useQuery, useMutation, queryOptions } from '@tanstack/react-query'
// The rest of @kernel/admin imports from here. A v6 migration touches one file.
```

| TanStack lib | Our usage                         | Blast radius if it breaks | Fallback                                |
| ------------ | --------------------------------- | ------------------------- | --------------------------------------- |
| Start        | SSR, server fns, routing host     | High                      | Self-host on Node/Bun adapters directly |
| Router       | Admin routing, search-param state | Medium                    | Facade swap                             |
| Query        | All admin/client fetching         | Medium                    | Facade swap                             |
| Table        | Collection list views             | Low                       | Isolated to list components             |
| Form         | Document edit forms               | Medium                    | Facade swap                             |
| Store        | Reactive UI state                 | Low                       | Trivially replaceable                   |
| Virtual      | Long lists/documents              | Low                       | Isolated                                |
| DB           | Optional reactive collections     | Low                       | Opt-in; degrades gracefully             |

**Version pinning and a tested upgrade lane.** We pin exact versions and run the full conformance and e2e suite against the next TanStack release candidate in a scheduled CI lane, so we learn about breakage before users do, not after.

**Upstream contribution.** We treat TanStack as a partner, not a black box — we contribute fixes and maintain relationships, which lowers the probability of a surprise that strands us.

## Open questions

- **T3 threshold:** at what collection/relationship count do we flip the default `typegen.mode` from `infer` to `codegen` automatically? We need real-world `tsc` data before hard-coding a number.
- **D1 facade for TanStack DB:** the optional reactive-collections feature is the least mature dependency. Do we ship it behind an experimental flag until its API stabilizes, or accept the coupling now?
- **M2 boundary edge case:** where exactly does "operational" end and "content capability" begin for features like scheduled publishing — core or Cloud? This line needs a written, testable definition.
