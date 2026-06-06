# Success Metrics & KPIs

This document defines how we decide whether KernelCMS is winning. Metrics are leading where possible (they predict outcomes we can still influence) and lagging only where the lagging number is the actual goal. Every KPI here has an owner, a cadence, an instrument that produces the number, and a threshold that triggers action. We measure four surfaces: **adoption** (are people choosing us over Payload, Sanity, and Strapi?), **DX** (does the product feel fast and obvious?), **performance** (do we hold our budgets under real workloads?), and **community health** (is the project sustainable without the core team in the loop?). Vanity metrics — GitHub stars, Twitter impressions, total downloads — are tracked for context but never gate a decision.

## Adoption metrics

Adoption is the scoreboard. We split it into acquisition (new projects), activation (projects that reach a working admin), and retention (projects still alive after 30/90 days). The wedge is config-as-code on a fully swappable adapter stack, so we segment heavily by **database adapter** and **deployment target** to see which parts of the "choose everything" promise actually get exercised.

```
acquisition ──> activation ──> retention ──> expansion
 create-kernel   first publish   30/90-day      Cloud upgrade
 npm installs    via admin       active project  / paid plan
```

The single most important number is **Time-to-First-Publish (TTFP)**: from `pnpm create kernel` to the first document published through the admin. Payload and Strapi both win the install race; we intend to win the _working CMS_ race because the typed Local API and generated REST/GraphQL mean a developer is productive the moment the schema compiles.

| Metric              | Definition                                    | Instrument                     | Target (12mo)  | Alert threshold            |
| ------------------- | --------------------------------------------- | ------------------------------ | -------------- | -------------------------- |
| Weekly new projects | Unique `create-kernel` scaffolds telemetry-on | `create-kernel` opt-in ping    | 1,500/wk       | < 60% of trailing 8-wk avg |
| Activation rate     | Scaffolds reaching first publish              | admin event `document.publish` | 45%            | < 35%                      |
| TTFP (median)       | Scaffold → first publish                      | event delta                    | < 20 min       | > 45 min                   |
| 30-day retention    | Projects with a write op at day 30            | server heartbeat               | 55%            | < 40%                      |
| Adapter mix         | Share by `@kernel/db-*`                       | config telemetry               | Postgres ≥ 50% | any adapter 0 for 90d      |
| Cloud conversion    | Self-host → KernelCMS Cloud                   | billing                        | 4% of active   | < 2%                       |

Telemetry is opt-in and anonymous, configured in `kernel.config.ts`. We do not ship analytics that can't be turned off — that is a hard product rule, not a metric.

```ts
import { defineConfig } from '@kernel/core'

export default defineConfig({
  telemetry: {
    enabled: true, // opt-in; false by default in self-host
    anonymousId: 'auto', // hashed install id, no PII, no content
    events: ['scaffold', 'first_publish', 'adapter', 'deploy_target'],
    endpoint: 'https://metrics.kernelcms.dev/v1/ingest',
  },
})
```

Cross-reference self-hosting and [KernelCMS Cloud](../10-cloud-operations/00-deployment-models-self-host-vs-cloud.md) for how deploy-target attribution is captured without leaking infrastructure details.

## DX metrics

Developer experience is our durable advantage, so we instrument it directly instead of inferring it from survey sentiment. Sanity has a polished studio but a proprietary content lake; Payload has strong DX but is Express/Next-coupled; Strapi's plugin DX is uneven. Our claim is that being **TanStack-native end-to-end** plus **zero `any`** produces a tighter feedback loop. We measure that loop.

### Type safety as a measurable KPI

"End-to-end type safety, zero any" is a tenet, so it gets a number. CI fails the build if `any` count regresses, and we publish the count.

| KPI                                      | Instrument                             | Gate         |
| ---------------------------------------- | -------------------------------------- | ------------ |
| `any` occurrences in shipped `@kernel/*` | `tsc` + custom AST rule                | must be 0    |
| Public API type-coverage                 | `type-coverage --strict`               | ≥ 99.5%      |
| Generated types drift                    | snapshot diff of `kernel types` output | 0 unexpected |
| `kernel dev` cold start                  | CLI timing                             | p95 < 3.0s   |
| HMR round-trip (schema edit → admin)     | dev-server timing                      | p95 < 800ms  |

The Local API is the proof surface — a developer edits `kernel.config.ts` and gets inferred operations in-process with no codegen step required for types:

```ts
import { getKernel } from '@kernel/server'

const kernel = await getKernel()

// `posts` is inferred from the collection config; `where`/`sort`/`depth`
// are the one shared query language across REST, GraphQL, RPC, and Local.
const { docs } = await kernel.find({
  collection: 'posts',
  where: { status: { equals: 'published' } },
  sort: '-publishedAt',
  depth: 1,
})
//      ^? docs: Post[]  — fully typed, no `as`, no generated client needed
```

### Friction events

We log **friction events** in `kernel dev` and the admin: a failed migration, a type error surfaced after save, a validation that fires server-side that should have fired in the form, a 500 from a generated resolver. These are aggregated per session. The DX KPI is **friction events per active hour**, trending down release over release. A spike in any single friction class becomes a triage ticket before the next release.

### Onboarding survey (lagging, low weight)

We run a short in-CLI prompt after first publish (skippable, opt-in) asking one question on a 1–5 scale: "Did KernelCMS do what you expected?" This is a lagging sanity check on the hard numbers, never a substitute for them.

## Performance KPIs

Performance budgets are enforced and measured — failing a budget fails CI, the same way a failing test does. We separate **admin** (the React/TanStack Start app), **API** (REST/GraphQL/RPC operation latency), and **build/migration** (developer-time operations). Numbers below are p75/p95 against a reference dataset (10k documents, 25 fields, one relationship two levels deep) on the Postgres adapter; other adapters have their own baselines.

| Surface | Metric                                      | Budget (p95) | Owner  | Tool                  |
| ------- | ------------------------------------------- | ------------ | ------ | --------------------- |
| Admin   | List view TTI (TanStack Table, virtualized) | < 1.2s       | admin  | Lighthouse CI + RUM   |
| Admin   | Document load → editable (TanStack Form)    | < 700ms      | admin  | RUM                   |
| Admin   | Command palette open                        | < 100ms      | admin  | perf marks            |
| API     | `find` (depth 1, 25 rows)                   | < 80ms       | server | k6 + traces           |
| API     | `create`/`update` single doc                | < 120ms      | server | k6                    |
| API     | GraphQL N+1 guard (resolver fanout)         | 0 unbatched  | server | query plan assert     |
| Build   | `kernel build` (admin bundle)               | < 25s        | core   | Turbo cache hit ≥ 85% |
| Migrate | Schema-diff migration gen                   | < 2s         | db     | bench                 |

Budgets live next to the config so they are reviewable and diffable:

```ts
import { defineConfig } from '@kernel/core'

export default defineConfig({
  performance: {
    budgets: {
      admin: { listViewTti: '1200ms', docLoad: '700ms' },
      api: { find: '80ms', mutate: '120ms' },
      build: { adminBundle: '25s' },
    },
    onBudgetExceeded: 'fail', // 'fail' in CI, 'warn' locally
  },
})
```

```
request ──> @kernel/rpc (server fn) ──> operation core ──> Adapter ──> db
   │              │                          │                 │
   └─ p95 budget  └─ trace span             └─ access checks   └─ query timing
```

Two things make these enforceable. First, the operation core is shared across all four API surfaces, so we instrument it once and every surface benefits — REST, GraphQL, RPC, and Local all run the same traced path. Payload and Strapi each have separate REST/GraphQL stacks; we don't, which is why a single budget covers all of them. Second, TanStack Virtual and Query mean list and document performance degrade gracefully with size rather than falling off a cliff — but we still bench the cliff, with the 100k-document soak test, and treat regressions there as P1.

## Community health

A CMS with a swappable-everything promise lives or dies on whether the community writes adapters and plugins we don't. So community health is measured as **contribution throughput and sustainability**, not raw popularity. The risk we watch for is bus-factor: if only the core team can merge, the "choose everything" promise is hollow.

| Metric                                 | Definition                                       | Target         | Why it matters                             |
| -------------------------------------- | ------------------------------------------------ | -------------- | ------------------------------------------ |
| Median time-to-first-response (issues) | open → first maintainer reply                    | < 24h          | Strapi's slow triage is a known pain point |
| Median PR time-to-merge                | non-trivial PRs                                  | < 5 days       | predicts external contributor retention    |
| External contributor ratio             | non-core merged PRs / total                      | ≥ 40%          | bus-factor and sustainability              |
| Community adapters/plugins             | published `@kernel/plugin-sdk` packages          | 50 in year 1   | validates the adapter contract             |
| Adapter contract conformance           | community adapters passing the shared test suite | 100% of listed | "no lock-in" must be real                  |
| Docs coverage                          | public APIs with a doc page + example            | ≥ 95%          | DX compounding                             |
| Discord/forum resolved ratio           | questions marked answered                        | ≥ 80%          | community self-sufficiency                 |

The conformance number is the one that keeps us honest. We ship a single adapter test suite via `@kernel/plugin-sdk`; any storage, db, auth, email, search, cache, or queue adapter — ours or community — must pass it to be listed. This is how "every infrastructure concern is a swappable adapter" stays a guarantee instead of a slogan.

```ts
import { runAdapterConformance } from '@kernel/plugin-sdk/testing'
import { createMyQueueAdapter } from './my-queue-adapter'

// Community adapters self-certify against the same suite we run.
runAdapterConformance({
  kind: 'queue',
  adapter: createMyQueueAdapter(),
  // exercises ordering, retries, dead-letter, idempotency, cancellation
})
```

We publish a quarterly community health snapshot (the table above, with trends) in the repo. Stars and total npm downloads appear in that snapshot for context only and are explicitly labeled non-actionable, so nobody optimizes for them.

## Review cadence and ownership

- **Weekly**: adoption acquisition/activation, friction events, budget regressions. Owned by the relevant package lead.
- **Monthly**: retention cohorts, adapter mix, DX type-safety KPIs, community throughput.
- **Quarterly**: Cloud conversion, community health snapshot, target re-baselining.

A metric without an owner is deleted. A target we've held for two quarters gets tightened. See [the release process](./02-release-plan-and-versioning.md) for how budget gates wire into the release checklist.

## Open questions

- **Telemetry default.** Self-host telemetry is opt-in, which means acquisition is undercounted. Do we estimate a correction factor from Cloud-attributed installs, or report only the observed floor and accept the undercount?
- **TTFP instrumentation.** Measuring scaffold → first publish requires correlating a CLI event with an admin event across two processes without a stable user identity. Anonymous install id is the current plan; whether it survives a fresh clone in CI is unresolved.
- **Adapter conformance enforcement.** Should a failing conformance run automatically delist a community adapter from the registry, or only flag it? Auto-delist is safer for users but may discourage early-stage contributions.
- **DX survey weighting.** The 1–5 post-publish prompt is low-weight today. If it correlates strongly with 30-day retention, we may promote it — but we need the correlation data first.
