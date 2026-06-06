# Performance Benchmarks & Budgets

KernelCMS treats performance as a contract, not a hope. Every release ships with a benchmark suite that measures cold-start, query latency, write throughput, and admin bundle size against fixed budgets, and CI fails the build when any of them regress past tolerance. This document specifies how the suite is built, what the budgets are, how we benchmark our query layer against Payload, Sanity, and Strapi, and how the regression gates wire into the pipeline. The goal is simple: a headless CMS that stays fast as the schema, content volume, and feature set grow — and proof that it does.

## Why budgets, not vibes

Payload, Strapi, and Sanity all publish performance claims but none of them gate releases on measured budgets in public CI. Strapi's admin bundle has historically ballooned past 4 MB; Payload's Local API is fast but unmeasured release-over-release; Sanity's perceived speed comes from a hosted CDN you cannot self-host. KernelCMS commits to numbers and enforces them. A budget is a hard ceiling stored in version control. A benchmark is a reproducible measurement. A gate is the CI step that compares the two and blocks merge on violation.

```
 author PR ──▶ bench suite ──▶ compare vs baseline ──▶ gate
                   │                    │                 │
              p50/p95/p99         delta tolerance     pass / FAIL
              bundle bytes        ±% per metric        block merge
```

See [Continuous Integration](./01-ci-cd-and-release-engineering.md) and Profiling the Admin for the surrounding tooling.

## The benchmark suite

The suite lives in `@kernel/bench` and is driven by the `kernel bench` CLI command. It is deterministic by construction: a fixed seed, a frozen fixture dataset, pinned adapter versions, and a warm-up phase before any timed run. We run it three ways — locally for ad-hoc profiling, in CI on every PR against a baseline, and nightly on a dedicated bare-metal runner for absolute numbers free of shared-CI noise.

Benchmarks are declared as code, co-located with the operation core so they exercise the real `@kernel/core` operation pipeline rather than a mock:

```typescript
import { defineBench } from "@kernel/bench";
import { postgres } from "@kernel/db-postgres";

export default defineBench({
  name: "collection.find — depth 0, 50 rows",
  adapter: postgres({ url: process.env.BENCH_DATABASE_URL }),
  fixture: "blog-10k", // 10k posts, 2k authors, 30k relationships
  warmup: { iterations: 50 },
  measure: { iterations: 500, collect: ["p50", "p95", "p99"] },
  async run({ payload }) {
    await payload.find({
      collection: "posts",
      where: { status: { equals: "published" } },
      sort: "-publishedAt",
      limit: 50,
      depth: 0,
    });
  },
  budget: { p95: "8ms", p99: "20ms" },
});
```

The fixture catalog is fixed and versioned so numbers are comparable across months:

| Fixture | Documents | Relationships | Purpose |
| --- | --- | --- | --- |
| `blog-1k` | 1k posts | 3k | Small-site baseline, cold-start sanity |
| `blog-10k` | 10k posts | 30k | Default query suite, the headline number |
| `commerce-100k` | 100k products | 400k | Deep `where` + faceting, index pressure |
| `i18n-10k` | 10k docs × 6 locales | 30k | Localized field hydration cost |
| `media-50k` | 50k uploads | 50k | Upload field joins, storage adapter calls |

Each fixture seeds through the same `@kernel/core` create pipeline used in production, so validation, hooks, and access control all run during seeding. We never hand-write SQL into the fixture — that would measure a database KernelCMS does not actually produce.

### What we measure

Four operation classes carry budgets, each at p50/p95/p99:

- **Read**: `find`, `findByID`, `count`, including `depth` traversal and localized hydration.
- **Write**: `create`, `update`, `delete`, including hook execution, validation, and version-history writes.
- **Auth**: token verification and access-control evaluation per operation — the per-request tax every endpoint pays.
- **Cold start**: time-to-first-response after process boot for Node, Bun, and an edge runtime.

Because the Local API, REST, GraphQL, and typed RPC all funnel through the same operation core, we benchmark the core once and benchmark each surface's overhead separately. This isolates "is the query slow" from "is the GraphQL resolver layer slow," which Strapi conflates and Payload does not separately report.

## Admin bundle budgets

The admin panel is a TanStack Start application, and its bundle is the single biggest lever on time-to-interactive. We budget per-route, not just total, because the only bundle a user pays for on login is the shell plus the first route. Budgets are declared in `kernel.config.ts` and enforced by the `@kernel/admin` build, which emits a manifest the gate reads.

```typescript
import { defineConfig } from "@kernel/core";

export default defineConfig({
  admin: {
    performance: {
      budgets: {
        // gzipped transfer size, per entry point
        "shell": "90kb",          // app chrome, router, query client
        "route:collection-list": "55kb",  // TanStack Table + virtual
        "route:document-edit": "75kb",     // TanStack Form + richtext editor
        "route:media-library": "60kb",
        "total-initial": "180kb", // shell + first route, hard ceiling
      },
      // fail build, don't just warn
      onExceed: "error",
    },
  },
});
```

The richtext editor is the heaviest single dependency in any CMS admin. We lazy-load it at the route boundary with `lazy()` + Suspense so the collection-list route never pays for it. Design tokens ship as CSS custom properties, not a runtime CSS-in-JS engine, so theming costs zero JavaScript — a direct contrast to admin panels that ship Emotion or styled-components and pay the serialization cost on every render.

Budget enforcement compares the gzipped transfer size of each named entry point against its ceiling. The build writes `dist/admin/bundle-manifest.json`; the gate diffs it against the baseline committed under `bench/baselines/`.

| Surface | Budget (gzip) | KernelCMS | Strapi v5 | Payload v3 |
| --- | --- | --- | --- | --- |
| Initial load (shell + first route) | 180 kB | ~165 kB | ~1.1 MB | ~320 kB |
| Document edit route | 75 kB | ~70 kB | bundled | ~140 kB |

The Strapi and Payload figures are reference measurements we re-capture each quarter, not budgets we enforce on them — they exist to keep us honest about the wedge. The win is structural: route-level code splitting plus zero-runtime styling, not micro-optimization.

## Query benchmarks versus competitors

The query suite is the one that matters most to evaluators, so we make it reproducible by anyone. `kernel bench --compare` stands up KernelCMS, Payload, Strapi, and a Sanity GROQ baseline against the same Postgres instance (Sanity runs against its own dataset since it is not self-hostable on SQL — we note that asymmetry explicitly rather than fake a comparison). Every system runs the identical logical query against the identical `blog-10k` content shape.

```
find(published posts, sort -publishedAt, limit 50, depth 1)  ·  blog-10k  ·  p95 ms

KernelCMS (Local API)   ▇▇▇                 6.1
KernelCMS (REST)        ▇▇▇▇                 8.4
KernelCMS (GraphQL)     ▇▇▇▇▇                9.7
Payload (Local API)     ▇▇▇▇                 7.8
Strapi (REST)           ▇▇▇▇▇▇▇▇▇▇▇▇        24.6
Sanity (GROQ, hosted)   ▇▇▇▇▇▇▇             14.2*
                        * different substrate; network + CDN included
```

The structural reasons KernelCMS wins on SQL:

- **Single shared query language.** `where` / `sort` / pagination / `depth` compile once into a Drizzle query plan. Strapi's REST layer issues N+1 queries for populated relations unless you hand-tune `populate`; our `depth` resolver batches relationship loads into joins or grouped `IN` queries by default.
- **No ORM round-trips for hot reads.** The operation core asks the adapter for exactly the columns the projection needs. Payload is competitive here because its Local API is also in-process; the gap is our explicit projection pruning under `depth: 0`.
- **Access control compiled into the query.** Document- and field-level access rules that can be expressed as `where` constraints are pushed into the SQL predicate rather than filtered in application memory after the fact.

```typescript
// what depth:1 compiles to — one query for posts, one batched query per
// relationship field, never one query per row
const plan = compileFind({
  collection: "posts",
  where: { status: { equals: "published" } },
  depth: 1,
});
// plan.rootQuery       → SELECT ... FROM posts WHERE status = $1 ...
// plan.relationLoaders → [ author: SELECT ... FROM users WHERE id IN ($...) ]
```

We publish the harness, the fixtures, and the exact competitor versions so the comparison is auditable. Marketing numbers without a reproducible harness are worthless; ours ships in the repo. See [Query Language](../05-api/04-query-filtering-sorting-pagination.md) and [the Drizzle adapter](../03-persistence/02-postgres-adapter.md) for how the plan is built.

## Regression gates

A benchmark that nobody enforces is a screensaver. The gate is the enforcement. On every PR, CI runs the suite against the PR branch, loads the baseline for the target branch, and compares each metric within a per-metric tolerance. Tolerances exist because CI runners are noisy; nightly bare-metal runs use tighter ones.

```typescript
// bench/gate.config.ts
import { defineGate } from "@kernel/bench";

export default defineGate({
  baseline: "bench/baselines/main.json",
  tolerances: {
    "query.p95": "+5%",     // slower than baseline by >5% → fail
    "query.p99": "+8%",
    "write.p95": "+5%",
    "coldStart": "+10%",
    "bundle.total-initial": "+0%", // bundle never grows silently
  },
  // a 3% improvement that then silently regresses is still a regression
  ratchet: ["bundle.total-initial", "query.p95"],
});
```

Two policies make the gate trustworthy:

- **Ratcheting.** Listed metrics can only move down. If a PR improves p95, the baseline is updated to the new value on merge, and future PRs are held to it. This prevents the slow-creep death that bundle sizes suffer everywhere — you cannot "spend" a past optimization.
- **Explicit, reviewed waivers.** A genuine, justified regression (say, a new required validation that costs 2 ms) is approved by committing a waiver entry with a reason and an owner, not by bumping the tolerance globally. The waiver shows up in the PR and in the changelog.

The gate posts a comment on the PR with a metric table — green for within tolerance, red for violations, blue for improvements that update the baseline. Bundle violations link to a treemap diff so the author sees exactly which dependency grew.

```
PERF GATE — FAIL (1 violation)

  metric                  baseline   this PR    delta    budget
  query.p95               6.1ms      6.3ms      +3.3%    ok
  write.p95               4.2ms      5.0ms      +19% ✗   FAIL (>+5%)
  bundle.total-initial    165kB      165kB      0%       ok

  → write.p95 regressed: new afterChange hook runs synchronously.
    Move to queue or add a reviewed waiver.
```

Nightly runs on bare metal publish absolute numbers to an internal dashboard so we track multi-month drift that per-PR deltas hide. Those numbers, not CI-runner numbers, are what we cite publicly.

## Open questions

- **Sanity comparison fairness.** GROQ on hosted infrastructure includes network and CDN; there is no apples-to-apples self-hosted SQL equivalent. Do we present it as a separate "hosted read path" category, or exclude it from the headline chart entirely and only reference it qualitatively?
- **MongoDB query budgets.** The document adapter has a different cost model (no joins, embedded relations). We have not yet decided whether MongoDB shares the SQL budgets or gets its own baseline file and tolerances.
- **Edge cold-start variance.** Edge runtimes show high cold-start variance across providers. We may need provider-specific baselines rather than one `coldStart` budget, which complicates the gate's single-number comparison.
- **Per-PR cost on bare metal.** Bare-metal runs are the trustworthy numbers but too slow for every PR. Open question whether a representative subset runs per-PR on bare metal or we accept CI-runner noise with wider tolerances for the full suite.
