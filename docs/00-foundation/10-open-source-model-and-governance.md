# Open Source Model & Governance

KernelCMS is MIT-licensed at the core and stays that way. This document fixes the boundary between what is free and open forever, what belongs to KernelCMS Cloud and enterprise add-ons, and how code, decisions, and roadmap authority actually move through the project. The short version: the entire content engine — collections, fields, adapters, REST/GraphQL/RPC, the admin panel, the CLI — is MIT and runs anywhere. Cloud is a hosting product, not a feature gate. We do not pull a Strapi: nothing graceful in the self-host story gets relicensed out from under you.

## MIT Core License

Every package that you need to model content, run the server, and operate the admin panel ships under the MIT license. That is a deliberate, load-bearing decision, not a default we copied from a template.

The MIT-licensed surface is the whole `@kernel/*` runtime:

| Package                                                                                                 | Scope                                                 | License |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------- |
| `@kernel/core`                                                                                          | Operation core, query language, field & access engine | MIT     |
| `@kernel/server`                                                                                        | TanStack Start host, lifecycle, hooks                 | MIT     |
| `@kernel/admin`                                                                                         | React admin app                                       | MIT     |
| `@kernel/ui`                                                                                            | Component library, design tokens                      | MIT     |
| `@kernel/db`, `@kernel/db-postgres`, `@kernel/db-sqlite`, `@kernel/db-mysql`, `@kernel/db-mongodb`      | Adapter contract + all official adapters              | MIT     |
| `@kernel/storage`, `@kernel/auth`, `@kernel/graphql`, `@kernel/rest`, `@kernel/rpc`, `@kernel/richtext` | Infrastructure adapters & API surfaces                | MIT     |
| `@kernel/cli`, `@kernel/client`, `@kernel/plugin-sdk`                                                   | `kernel` binary, typed client, plugin authoring kit   | MIT     |
| `create-kernel`                                                                                         | Scaffolder                                            | MIT     |

The one package outside this list is `@kernel/cloud`, covered below.

Why MIT and not AGPL or BSL? Three reasons.

1. **Adapters and plugins must be unencumbered.** A copyleft core would force every database adapter, storage backend, and third-party plugin to reason about license compatibility before it could link against us. The `@kernel/plugin-sdk` ecosystem only works if the boundary is permissive. Payload is MIT and benefits from exactly this; Strapi's relicensing to a custom SSPL-adjacent model in its enterprise tiers created precisely the uncertainty we want to avoid.
2. **Embedding is a first-class use case.** People build commercial products _on top of_ KernelCMS. MIT means they never have to ask a lawyer whether shipping their app triggers a disclosure obligation.
3. **Cloud does not need a license moat.** Sanity is closed-core with an open SDK; their leverage is the hosted backend, not the license. We take the better half of that: the backend is open too, and Cloud competes on operational excellence rather than on being the only thing that can run the code.

Every published package carries a `LICENSE` file and an SPDX header. CI fails on any new dependency whose license is not in the allowlist (`MIT`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, `ISC`). Copyleft dependencies are rejected at the PR gate, not discovered at release.

## OSS vs Commercial Cloud Boundary

The rule is simple and we will not blur it: **if it changes what your CMS can do, it is MIT. If it operates infrastructure on your behalf, it can be commercial.**

```
                    ┌──────────────────────────────────────┐
   MIT, forever  →  │  @kernel/core  @kernel/server         │
                    │  @kernel/admin  @kernel/db-*          │
                    │  REST · GraphQL · RPC · CLI · plugins │
                    └──────────────────┬───────────────────┘
                                       │  same code, same config
                       ┌───────────────┴───────────────┐
                       ▼                                ▼
              ┌─────────────────┐            ┌────────────────────────┐
              │  Self-host      │            │  KernelCMS Cloud        │
              │  Docker/K8s/    │            │  multi-tenant hosting,  │
              │  Node/Bun/edge  │            │  billing, CDN, backups, │
              │  (you operate)  │            │  observability          │
              └─────────────────┘            │  (@kernel/cloud, comm.) │
                                             └────────────────────────┘
```

A `kernel.config.ts` is identical whether it runs on your laptop, in your Kubernetes cluster, or on Cloud. The Cloud connection is an opt-in adapter, never a requirement:

```ts
// kernel.config.ts
import { defineConfig } from '@kernel/core'
import { postgres } from '@kernel/db-postgres'
import { s3 } from '@kernel/storage'

export default defineConfig({
  db: postgres({ url: process.env.DATABASE_URL }),
  storage: s3({ bucket: process.env.MEDIA_BUCKET }),
  collections: [Posts, Authors, Media],
  globals: [SiteSettings],
})
```

To move to Cloud you add a deploy target, not a rewrite. The commercial `@kernel/cloud` package wires managed Postgres, the global CDN, backups, and billing — but the `collections`, `globals`, and field definitions above are byte-for-byte portable:

```ts
// kernel.config.ts — Cloud target
import { cloud } from '@kernel/cloud' // commercial license

export default defineConfig({
  deploy: cloud({ project: 'acme-marketing', region: 'eu-west' }),
  collections: [Posts, Authors, Media], // unchanged
  globals: [SiteSettings], // unchanged
})
```

What lives in commercial / enterprise add-ons, and the explicit guarantee that it never migrates into Cloud-only:

| Capability                                                 | Where           | Guarantee                                                        |
| ---------------------------------------------------------- | --------------- | ---------------------------------------------------------------- |
| Content modeling, fields, validation, access control       | MIT core        | Always free                                                      |
| REST / GraphQL / RPC generation, query language            | MIT core        | Always free                                                      |
| Admin panel, live preview, command palette, i18n/RTL       | MIT core        | Always free                                                      |
| All database, storage, auth, search, cache, queue adapters | MIT core        | Always free                                                      |
| Drafts, versions, autosave, localization                   | MIT core        | Always free                                                      |
| Managed multi-tenant hosting, billing, metering            | `@kernel/cloud` | Commercial                                                       |
| Global content CDN, managed backups, point-in-time restore | `@kernel/cloud` | Commercial                                                       |
| SSO/SCIM provisioning, audit-log export, SLA support       | Enterprise      | Commercial, but the **mechanisms** (auth adapter, hooks) are MIT |

The last row matters. Enterprise SSO is a paid offering, but `@kernel/auth` exposes the adapter interface that makes any SSO provider implementable by anyone, for free. We sell the supported, hardened integration and the SLA — never the only door into the building. This is where we diverge hardest from Strapi, whose RBAC and SSO are gated enterprise features with no community-buildable equivalent at the framework layer. See [Deployment Topologies](../10-cloud-operations/00-deployment-models-self-host-vs-cloud.md) and the [Adapter Contract](../03-persistence/00-persistence-overview-and-adapter-contract.md) for the mechanics.

## Contribution Flow & CLA

Contributions move through a single, boring, predictable pipeline. Boring is the goal — surprises in a governance process are always bad surprises.

```
fork → branch → changeset → PR → CI (typecheck/test/lint/license/perf) →
  2 maintainer reviews → squash-merge → release via Changesets
```

Concrete requirements, enforced by automation rather than reviewer goodwill:

- **Conventional Commits** for PR titles. The release tooling derives semver bumps from them; `feat:` → minor, `fix:` → patch, `feat!:`/`BREAKING CHANGE` → major.
- **A changeset per user-visible change.** `pnpm changeset` records the affected packages and bump level. PRs that touch public API without a changeset fail CI.
- **Zero `any`, zero `@ts-ignore`.** The repo is `strict: true` end to end; the type gate is non-negotiable and applies to contributors and maintainers equally.
- **Tests with the change.** New behavior ships with tests against real adapters (SQLite in-memory for the SQL path, an ephemeral Mongo for the document path) — not mocks of our own code. Coverage floor is enforced in CI.
- **Performance budgets.** Benchmark-sensitive paths (query planning, admin bundle size) have budgets; a PR that regresses them past threshold is blocked until justified.

### The DCO, not a CLA

We require the **Developer Certificate of Origin**, signed off per commit (`git commit -s`), and explicitly _not_ a copyright-assignment CLA. A bot enforces sign-off on every commit in a PR.

This is a values decision. A traditional CLA — the kind that assigns or licenses your copyright to a single company — gives that company the unilateral power to relicense the whole project later. That is the exact lever Strapi and others have pulled. By standing on the DCO, **no entity, including the KernelCMS company, can relicense contributed core code away from MIT without every contributor's agreement.** The license stickiness is structural, not a promise. Contributors retain their copyright; they grant the project the MIT license to their work and certify they have the right to do so. Nothing more.

## RFC Process

Anything that changes a public contract goes through an RFC before code. "Public contract" means: the Adapter interface, the shared query language (`where` / `sort` / pagination / `depth`), field-type semantics, the `kernel.config.ts` shape, the generated REST/GraphQL schemas, and the `@kernel/plugin-sdk` surface. Bug fixes, internal refactors, docs, and new adapters that implement an existing contract do not need one.

The flow:

```
Draft (PR to rfcs/) → Discussion (≥7 days) → FCP "final comment period" (3 days)
  → Accepted / Rejected / Postponed → tracking issue → implementation
```

RFCs are Markdown files in `rfcs/` with a fixed front matter, so tooling and humans can both reason about them:

```md
---
rfc: 0042
title: Cross-field async validation in @kernel/core
status: draft # draft | fcp | accepted | rejected | postponed
authors: [you@example.com]
packages: ['@kernel/core', '@kernel/admin']
breaking: false
target: 2.3.0
---

## Summary

## Motivation # what's broken without this; prior art in Payload/Sanity/Strapi

## Design # kernel.config.ts snippets, @kernel/\* signatures, migration notes

## Drawbacks

## Alternatives

## Open questions
```

Two norms keep RFCs honest. First, **every RFC must cite prior art** — how Payload, Sanity, or Strapi solve the same problem, and why our answer differs or wins. An RFC that ignores the competitive landscape gets sent back. Second, **breaking changes require a migration story in the RFC itself**, including the `kernel` codemod or migration generator that ships with it. We do not accept "users will adapt." The proposer owns the upgrade path. Larger or more contentious proposals are pre-screened with the [Architecture Decision Records](../01-architecture/adr/0000-adr-process.md) so the trade-offs are captured even when an RFC is postponed.

## Governance & Roadmap Ownership

KernelCMS runs on **BDFL-delegated, package-scoped maintainership** — strong enough to ship a coherent product, distributed enough that no single person is a bottleneck.

| Role                     | Authority                                                | How you get it                                                  |
| ------------------------ | -------------------------------------------------------- | --------------------------------------------------------------- |
| Contributor              | Open PRs, file RFCs, vote in discussion                  | Land one merged PR                                              |
| Maintainer (per package) | Approve/merge in their package(s), triage                | Sustained quality contribution + existing maintainer nomination |
| Core team                | Cross-package architecture, accept/reject RFCs, releases | Maintainer + core nomination + lazy-consensus confirmation      |
| Lead (BDFL)              | Tie-break only; stewards license & trademark             | Founder role, succession defined below                          |

Decision rule is **lazy consensus**: a proposal with no sustained objection after its comment window passes. Disagreement escalates one level — package maintainers to core team, core team to a recorded vote, and only an unbreakable deadlock reaches the Lead. The Lead's standing job is to _not_ be needed; using the tie-break is treated as a process smell to be reviewed afterward.

**Roadmap ownership is split on purpose.** The open-source roadmap lives in public GitHub milestones and is owned by the core team. The KernelCMS Cloud roadmap is owned by the company. The firewall between them is a hard rule: **Cloud's commercial priorities cannot reorder or starve the OSS roadmap, and no OSS feature may be deferred to make Cloud more attractive.** Where the two genuinely conflict, the OSS roadmap wins, because the open core is the product and Cloud is a way to run it. This is the opposite of the gravitational pull that turns open cores into demos for a paid product.

```
   public RFCs + issues ──► core team ──► OSS roadmap (GitHub milestones)
                                  │
                                  └── firewall: Cloud cannot deprioritize OSS
   customer needs ─────────► company ──► Cloud roadmap (separate, commercial)
```

Two guarantees codify the trust:

- **Trademark, not license, is the brand protection.** "KernelCMS" and the logo are protected so forks cannot impersonate official releases — but the MIT code can be forked, renamed, and shipped freely. The DCO ensures a hostile relicense is impossible; the trademark ensures honest forks stay honest.
- **Succession is written down.** If the Lead steps away, authority passes to the core team operating by majority vote until they appoint a new steward. The project does not depend on one person remaining.

### Open questions

- **Foundation timing.** Whether and when to move trademark and CI infrastructure into a neutral foundation (Linux Foundation / Commonhaus style). Independence is good; premature bureaucracy is not. Undecided pending project maturity.
- **Maintainer compensation.** Whether Cloud revenue funds a paid maintainer pool, and how to do that without the company implicitly buying roadmap influence that the firewall is meant to prevent.
- **RFC voting weight.** Current model is lazy consensus with maintainer escalation. An open question is whether high-impact RFCs (breaking changes to the Adapter contract) should require an explicit supermajority of the core team rather than absence-of-objection.
