# Community & Ecosystem Strategy

KernelCMS lives or dies by its community. The technical wedge — TanStack-native, swappable adapters for every infrastructure concern, two-way portability between self-host and KernelCMS Cloud — only matters if developers find it, trust it, build on it, and tell each other about it. This document specifies how we grow adoption and contributors deliberately: the channels we run, the plugin ecosystem flywheel that turns users into authors, the docs-and-education investment that lowers time-to-first-success, and the partnerships that put KernelCMS in front of agencies and platforms. We treat community as a system with feedback loops and measurable throughput — not a Discord server we open and hope.

## Community Channels

We run a small number of channels well rather than a large number poorly. Each channel has an owner, a response-time SLA, and a clear job. Sprawl is the enemy: Strapi's community spans Discord, a forum, GitHub Discussions, and a subreddit, and answers fragment across all four. We consolidate.

| Channel                  | Job                                        | Owner               | SLA                         |
| ------------------------ | ------------------------------------------ | ------------------- | --------------------------- |
| GitHub Issues            | Bugs, regressions, reproducible defects    | Core maintainers    | Triage < 48h                |
| GitHub Discussions       | Q&A, RFCs, "show and tell"                 | Rotating maintainer | First reply < 24h           |
| Discord                  | Real-time help, casual chat, release pings | Community manager   | Best-effort, business hours |
| RFC repo (`kernel-rfcs`) | Design proposals for breaking changes      | Steering group      | Reviewed in next cycle      |
| Office hours (biweekly)  | Live debugging, roadmap Q&A                | Core team           | Scheduled                   |

GitHub is the system of record. Discord is for speed and warmth, but anything that produces a decision or a reusable answer gets promoted to a Discussion or an issue. We explicitly avoid the Sanity pattern where the most useful answers are buried in unindexable Slack history — every resolved Discord thread with a real solution gets a one-line summary posted to Discussions with a link, so the knowledge is crawlable.

The RFC process is the single most important governance artifact. Payload and Strapi both ship breaking changes that surprise plugin authors; we commit to an RFC for anything that touches the Adapter contract, the field config schema, the shared query language (`where` / `sort` / pagination / `depth`), or the `@kernel/plugin-sdk` surface. An RFC is a Markdown file, a two-week comment window, and a labeled decision — which lets third-party authors plan instead of react.

```
contributor → GitHub Discussion (RFC draft)
            → kernel-rfcs PR + 2-week comment window
            → steering review (accept / revise / decline)
            → tracking issue + milestone
            → changelog entry on release
```

## The Plugin Ecosystem Flywheel

A headless CMS is a platform, and platforms win on the breadth of what other people build on them. The flywheel: more plugins make KernelCMS useful for more use cases, attracting more users, a fraction of whom hit a gap and author a plugin. Our job is to remove every point of friction on that loop.

```
        more users
       ↗            ↘
  more plugins      gaps surfaced
       ↖            ↙
     plugin authors
```

The friction points are predictable, so we attack them directly:

**A stable, typed SDK.** `@kernel/plugin-sdk` exposes the same hooks the core uses, with full type inference and zero `any`. A plugin is a function that receives the config and returns a modified config — the same config-as-code model that defines collections and globals. Because the entire stack is TanStack-native, a plugin can contribute server functions, TanStack Query options, admin routes (TanStack Router), and TanStack Table column definitions through one coherent API, instead of the bolt-on plugin model Strapi uses where the admin and server plugin surfaces are effectively two different SDKs.

```ts
// kernel.config.ts
import { defineConfig } from '@kernel/core'
import { postgres } from '@kernel/db-postgres'
import { stripePlugin } from '@kernel/plugin-stripe'
import { algoliaSearch } from '@kernel/plugin-algolia'

export default defineConfig({
  db: postgres({ url: process.env.DATABASE_URL! }),
  collections: [
    /* ... */
  ],
  plugins: [
    stripePlugin({ secretKey: process.env.STRIPE_SECRET_KEY! }),
    algoliaSearch({ appId: process.env.ALGOLIA_APP_ID!, index: 'content' }),
  ],
})
```

```ts
// A minimal plugin: add a read-only `slug` field to every collection
import type { KernelPlugin } from '@kernel/plugin-sdk'

export const autoSlug =
  (opts: { from: string }): KernelPlugin =>
  (config) => ({
    ...config,
    collections: config.collections.map((c) => ({
      ...c,
      fields: [
        ...c.fields,
        {
          name: 'slug',
          type: 'text',
          admin: { readOnly: true },
          hooks: {
            beforeChange: [({ data }) => slugify(String(data[opts.from] ?? ''))],
          },
        },
      ],
    })),
  })
```

**A registry with provenance.** We run a curated registry at `registry.kernelcms.org`, indexed by adapter category (database, storage, email, auth, search, cache, queue) and by capability (field types, admin views, hooks). Every entry shows compatible version range, weekly downloads, last publish date, and an "official / partner / community" trust tier. Sanity's plugin discovery is largely a GitHub-topic search; Payload's is a docs page. A typed, filterable registry that surfaces _which adapter contract version a plugin targets_ answers the question users actually ask: "will this work with my stack?"

**`create-kernel-plugin` scaffolder.** One command produces a typed plugin package with a test harness that boots a real in-memory SQLite adapter (`@kernel/db-sqlite`), so authors test against a real backend, not mocks — consistent with our testing tenet of real dependencies over mocks.

```bash
pnpm create kernel-plugin my-plugin
```

**Conformance, not just publish.** A plugin can opt into the conformance suite, which exercises it against every official database adapter and asserts the Adapter contract holds. Passing plugins earn a registry badge. This keeps the ecosystem from rotting as the core evolves — the thing Strapi and Payload most visibly lack, where a major version bump silently breaks a long tail of community plugins.

Measured outputs of the flywheel: number of published plugins, share passing conformance, time from `create-kernel-plugin` to first publish, and the ratio of community-to-official plugins per adapter category. See Plugin development and the [Adapter contract](../03-persistence/00-persistence-overview-and-adapter-contract.md) for the technical surfaces these metrics ride on.

## Docs and Education

Documentation is the highest-leverage growth investment we make, because it directly compresses time-to-first-success and it is what search engines and LLMs ingest. We split docs into four layers, each with a different job:

| Layer      | Job                                      | Success metric  |
| ---------- | ---------------------------------------- | --------------- |
| Quickstart | Running CMS in < 10 minutes              | Completion rate |
| Guides     | Task-oriented ("add localization")       | Bounce rate     |
| Reference  | Exhaustive API/config surface            | Coverage %      |
| Concepts   | Mental models (adapters, query language) | Time on page    |

Two non-negotiable standards. First, **every code sample is type-checked in CI.** Samples live in real `.ts` files, are compiled against the current `@kernel/*` packages, and are embedded into Markdown by a build step. A sample that no longer compiles fails the docs build. This kills the most common docs failure mode — drift between prose and the shipped API — which plagues fast-moving projects like Strapi across major versions.

Second, **the docs are an LLM target by design.** We publish `llms.txt` and per-page Markdown so that Claude, Cursor, and Copilot answer KernelCMS questions correctly. A meaningful share of new developers will meet KernelCMS through an AI assistant before they ever open our site; if the model hallucinates our API, we lose them. Keeping the corpus accurate, versioned, and machine-readable is an acquisition channel, not a nicety.

Education beyond reference docs:

- **Recipes** — copy-pasteable `kernel.config.ts` solutions for common shapes (blog, e-commerce catalog, multi-tenant SaaS, marketing site with live preview).
- **Migration guides** — concrete, runnable paths from Payload, Sanity, and Strapi, mapping their concepts to KernelCMS collections/globals/fields. See [Migrating from Payload](./01-migrating-from-payload.md).
- **Video and streams** — a short build-along per quarter, plus office-hours recordings.
- **Certification (Cloud-tier)** — a free assessment agencies use to vet hires; it doubles as a qualified-lead funnel into KernelCMS Cloud and the partner program.

## Partnerships

Partnerships put KernelCMS in front of audiences we can't reach organically, and they create commercial gravity around the open-source core without compromising the MIT license. We pursue three categories.

**Agencies and system integrators.** Agencies choose a CMS once and then deploy it across dozens of client projects — they are a force multiplier. The partner program offers a directory listing, early access to RFCs, a Cloud revenue share for projects they bring, and co-branded case studies. The pitch versus Sanity is ownership: an agency can hand a client a fully portable, self-hostable system with no per-seat content-platform tax, and still upsell managed KernelCMS Cloud where the client wants zero ops.

**Infrastructure and adapter vendors.** Because every infrastructure concern is a swappable adapter, vendors have a direct incentive to ship and maintain a first-class adapter — a Neon or Turso `@kernel/db-*` integration, a storage provider, a search vendor, an email/queue provider. We co-maintain the high-value ones, list them as "partner" tier in the registry, and run them through the conformance suite. This is structurally different from Strapi's provider plugins: our Adapter contract is one stable interface across database, storage, email, auth, search, cache, and queue, so a vendor learns one contract and the conformance suite proves the integration.

**The TanStack ecosystem itself.** Our deepest strategic relationship is with TanStack. We are the flagship application of Start, Router, Query, Table, Form, Store, Virtual, and DB working together in production. We contribute fixes upstream, present KernelCMS as a reference architecture, and ride TanStack's developer mindshare. No competitor can claim this — it is the moat that comes free with the wedge.

```
TanStack ecosystem ──┐
infra/adapter vendors ┼──→ KernelCMS core (MIT) ──→ KernelCMS Cloud (commercial)
agencies / SIs ──────┘                                ↑ revenue share back to partners
```

## Open Questions

- **Governance model timing.** When do we move from BDFL-style core ownership to a formal steering committee with external seats — at a download threshold, a contributor threshold, or a calendar date?
- **Plugin monetization.** Do we allow paid third-party plugins through the registry (with a marketplace cut), keep the registry strictly open-source, or restrict commercial plugins to the Cloud-tier only?
- **Conformance enforcement.** Is conformance a voluntary badge, or do we eventually gate the official registry on it — and how do we avoid punishing small community authors when the contract version bumps?
- **Translation ownership.** Docs i18n (with RTL) is a stated admin capability; do we crowdsource translations, fund them, or both, and how do we keep translated samples type-checked?
