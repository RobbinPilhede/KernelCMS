# CI/CD & Release Engineering

KernelCMS ships as a pnpm + Turborepo monorepo with ~25 published packages, four database adapters, and a TanStack Start admin app. The release pipeline has to keep all of that coherent: a change in `@kernel/core` must not silently break `@kernel/db-mongodb`, and a published version of `@kernel/server` must declare a compatible range against every adapter it can load. This document specifies the CI stages, how we run the test matrix across adapters and runtimes, how we cut releases with Changesets, and how canary and preview builds reach users before a stable tag exists. The guiding rule: every published artifact is reproducible from a single commit, and no human types `npm publish`.

## CI pipeline stages

CI runs on GitHub Actions, triggered on `pull_request` and on `push` to `main`. The pipeline is a DAG, not a script — Turborepo's `--filter` and remote cache let us skip unaffected packages, so a docs-only PR finishes in under a minute while a `@kernel/core` change fans out to everything that depends on it.

```
                ┌──────────────┐
   push / PR ──▶│  setup+cache │ (pnpm install, restore turbo cache)
                └──────┬───────┘
          ┌───────────┼────────────┬──────────────┐
          ▼           ▼            ▼              ▼
      ┌───────┐  ┌─────────┐  ┌──────────┐  ┌──────────┐
      │ lint  │  │typecheck│  │  build   │  │changeset │
      │ (eslint│  │ (tsc -b)│  │ (turbo)  │  │  check   │
      │ +biome)│  └────┬────┘  └────┬─────┘  └──────────┘
      └───┬───┘        │            │
          └────────────┴─────┬──────┘
                             ▼
                    ┌──────────────────┐
                    │  test matrix     │  (adapters × runtimes)
                    └────────┬─────────┘
                             ▼
                    ┌──────────────────┐
                    │  e2e (admin app) │  Playwright on built bundle
                    └────────┬─────────┘
                             ▼
                    ┌──────────────────┐
                    │ size + perf gate │  bundle budgets, op benchmarks
                    └──────────────────┘
```

Each stage is opinionated about what fails the build:

| Stage       | Tooling                     | Hard fail on                                               |
| ----------- | --------------------------- | ---------------------------------------------------------- |
| `lint`      | ESLint + Biome              | any error rule, `any` in shipped code, unused exports      |
| `typecheck` | `tsc -b` project references | any type error; `--strict` is non-negotiable               |
| `build`     | `turbo run build`           | broken build, missing `exports` map, dual ESM/CJS mismatch |
| `changeset` | `@changesets/cli status`    | a code-touching PR with no changeset (see below)           |
| `test`      | Vitest (matrix)             | failing test, coverage below 80% line / 70% branch         |
| `e2e`       | Playwright                  | broken admin flow, WCAG 2.2 AA axe violation               |
| `perf`      | custom bench + `size-limit` | `@kernel/admin` over budget, op latency regression         |

The `changeset check` stage is what most monorepos get wrong. Strapi and Payload publish from a single version line, so a missing changelog entry is a process problem, not a CI failure. Because KernelCMS publishes ~25 independently versioned packages, we fail the PR if it touches `packages/**/src` but adds no `.changeset/*.md` file. The escape hatch is an empty changeset (`pnpm changeset --empty`) for genuinely non-publishable changes like test-only fixes — explicit, reviewable, and rare.

Turborepo's remote cache (S3-backed, also used locally) means the `build` and `test` outputs are content-addressed by input hash. A re-run of an unchanged commit is a cache restore, not a rebuild. This is the single biggest lever on CI cost given the matrix size below.

## Matrix testing across adapters

The contract that makes KernelCMS adapter-swappable — one `Adapter` interface implemented by `@kernel/db-postgres`, `@kernel/db-sqlite`, `@kernel/db-mysql`, and `@kernel/db-mongodb` — is also the thing most likely to rot. A query-builder change in `@kernel/db` (the Drizzle-based SQL core) can pass against Postgres and silently break MySQL's collation behavior, and MongoDB doesn't share the SQL path at all. The only defense is to run the **same** conformance suite against **every** backend.

We keep one shared suite, `@kernel/db/conformance`, that exercises the operation core (create, read with `where`/`sort`/`depth`, update, delete, versions, drafts, localization, access control) against a live database. Adapter packages don't write their own CRUD tests — they import the suite and provide a connection factory.

```typescript
// packages/db-postgres/test/conformance.test.ts
import { runAdapterConformance } from '@kernel/db/conformance'
import { postgresAdapter } from '@kernel/db-postgres'

runAdapterConformance({
  name: 'postgres',
  adapter: () =>
    postgresAdapter({
      connectionString: process.env.DATABASE_URL!, // service container
    }),
  // capabilities let the suite skip what a backend genuinely can't do
  capabilities: { transactions: true, jsonbWhere: true, fullTextSearch: true },
})
```

The GitHub Actions matrix crosses adapters with runtimes. Databases run as service containers; SQLite/libSQL runs in-process, and MongoDB uses `mongodb-memory-server` for speed with a containerized run reserved for `main`.

```yaml
# .github/workflows/test.yml (excerpt)
strategy:
  fail-fast: false
  matrix:
    adapter: [postgres, sqlite, mysql, mongodb]
    runtime: [node-22, bun]
    include:
      - adapter: postgres
        service: postgres:16
      - adapter: mysql
        service: mysql:8
# edge runtime tested separately against sqlite/libSQL only
```

`fail-fast: false` is deliberate: we want to see _all_ adapter failures on a PR, not just the first. The `capabilities` flags are how we stay honest about backend differences instead of pretending they don't exist — MongoDB skips SQL-specific `jsonbWhere` assertions but still must satisfy the shared query language (`where`/`sort`/pagination/`depth`) at the API surface. That shared query language is what lets us assert _identical_ result shapes across all four backends; see [Adapters & the database layer](../01-architecture/adr/0002-drizzle-and-pluggable-db.md) for the contract itself.

Migrations get their own matrix lane. Because Drizzle generates migrations from schema diffs, we snapshot a generated migration for a representative `kernel.config.ts` and assert it's byte-stable per dialect — a regression there would corrupt real deployments.

```typescript
// migration determinism is part of the gate, not an afterthought
test('generated migration is stable for postgres', async () => {
  const sql = await generateMigration(fixtureConfig, { dialect: 'postgres' })
  expect(sql).toMatchFileSnapshot('./__snapshots__/0001_init.pg.sql')
})
```

## Changesets and publishing

Versioning is driven by [Changesets](https://github.com/changesets/changesets). Every contributor PR includes a markdown changeset declaring which packages changed and at what semver level. This is the same tool TanStack itself uses, which keeps us aligned with the ecosystem we build on, and it scales to independent per-package versions in a way Strapi's monolithic version line cannot.

```markdown
---
'@kernel/core': minor
'@kernel/db': patch
'@kernel/db-postgres': patch
---

Add cross-field async validation to the operation core. The `validate`
hook now receives sibling field values via `ctx.siblingData`.
```

We use **linked** version groups so the surfaces that must move together do. The adapter packages are linked to `@kernel/db`; the API packages (`@kernel/rest`, `@kernel/graphql`, `@kernel/rpc`) are linked to `@kernel/server`. Linking guarantees a user never lands on `@kernel/server@2.1` with a `@kernel/graphql@2.0` that no longer matches its operation core.

```typescript
// .changeset/config.ts (typed config, not JSON, so it's reviewable)
export default {
  changelog: ['@changesets/changelog-github', { repo: 'kernelcms/kernel' }],
  access: 'public',
  baseBranch: 'main',
  linked: [
    ['@kernel/db', '@kernel/db-*'],
    ['@kernel/server', '@kernel/rest', '@kernel/graphql', '@kernel/rpc'],
  ],
  // @kernel/cloud is private and never published to npm
  ignore: ['@kernel/cloud'],
} satisfies ChangesetsConfig
```

Publishing is fully automated by the Changesets GitHub Action. On merge to `main`, the action either opens/updates a **Version Packages** PR (consuming accumulated changesets, bumping versions, writing CHANGELOGs) or, when that PR merges, runs `pnpm publish -r` with provenance.

```
PR with changeset ──merge──▶ main
                               │
                               ▼
                 ┌──────────────────────────┐
                 │ "Version Packages" PR     │  (auto-opened/updated)
                 │  bumps versions + CHANGELOG│
                 └────────────┬──────────────┘
                              │ human reviews & merges
                              ▼
                 ┌──────────────────────────┐
                 │ release job: build → test │
                 │ → pnpm publish -r         │  npm provenance + OIDC
                 └────────────┬──────────────┘
                              ▼
                    git tag + GitHub Release
```

Two non-negotiables in the release job: it publishes with **npm provenance** (`--provenance`, OIDC-signed, no long-lived `NPM_TOKEN` in plaintext), and it republishes from the exact built artifacts the matrix already validated — never a fresh local build. The `kernel` CLI binary and `create-kernel` scaffolder are published in the same run so the documented `pnpm create kernel@latest` always resolves to a coherent set of `@kernel/*` versions.

## Canary and preview releases

Stable tags are not the only way code reaches users, and waiting for them is too slow for plugin authors and contributors. We run two pre-stable channels.

**Snapshot/canary releases** publish every PR (and every `main` commit) to npm under a non-default dist-tag, using Changesets snapshot versions like `0.0.0-canary-20260530120000`. A contributor building a `@kernel/plugin-sdk` plugin can `pnpm add @kernel/core@canary` and test against unreleased work without us cutting a real version. Sanity offers nothing equivalent because its core isn't an npm-installable, self-hostable package; this is a direct consequence of KernelCMS being config-as-code and open-core.

```yaml
# on PR: snapshot publish under a PR-scoped tag
- run: pnpm changeset version --snapshot canary
- run: pnpm publish -r --tag canary --no-git-checks
# the bot comments the exact install line on the PR:
#   pnpm add @kernel/admin@0.0.0-canary-20260530120000
```

**Preview environments** spin up a full KernelCMS instance per PR — the TanStack Start admin app plus a seeded SQLite/libSQL database — so reviewers click through the actual admin UI, command palette, live preview, and a sample `kernel.config.ts`, not a Storybook approximation. The preview uses libSQL specifically because it needs no external service and boots on edge/serverless preview hosts in seconds.

| Channel     | Trigger                | dist-tag / target  | Lifetime                    |
| ----------- | ---------------------- | ------------------ | --------------------------- |
| `canary`    | every PR + `main`      | `@canary` snapshot | rolling, GC'd after 30 days |
| `next`      | merge to `main`        | `@next`            | until next stable           |
| preview app | every PR               | per-PR URL         | torn down on PR close       |
| `latest`    | Version Packages merge | `@latest`          | permanent                   |

The `next` tag is the integration channel: everything merged to `main` lands there continuously, so adopters tracking `@next` are effectively running `main`. Promotion to `@latest` only happens through the Changesets Version Packages PR — there is exactly one path to a stable version, and it always runs the full adapter matrix first.

## Open questions

- **Per-adapter publish cadence.** Should adapters be allowed to ship patches independently of `@kernel/db`, or does the `linked` group make that more confusing than helpful for self-hosters pinning ranges? Leaning toward keeping them linked.
- **Edge-runtime matrix depth.** We currently test the edge runtime only against SQLite/libSQL. Do MySQL/Postgres-over-HTTP drivers (e.g. serverless driver shims) warrant their own edge lane, or is that the deployment guide's problem?
- **MongoDB in the perf gate.** The latency benchmarks are tuned to the SQL operation core. We have not decided whether MongoDB gets its own budget thresholds or is excluded from the hard perf gate and tracked as a trend only.
