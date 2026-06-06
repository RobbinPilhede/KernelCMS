# Release Plan & Versioning

KernelCMS ships on a predictable cadence with a strict, mechanical interpretation of semver. This document defines what each version number means, what we promise not to break, how features mature through alpha and beta into general availability, which releases earn long-term support, and how we deprecate APIs without ambushing you. The short version: minor releases ship monthly, breaking changes are batched into majors roughly twice a year, and every breaking change is preceded by a deprecation that you can detect in code and at the type level before it lands.

## The unit of versioning: the workspace, not the package

KernelCMS publishes ~20 packages — `@kernel/core`, `@kernel/server`, `@kernel/admin`, `@kernel/db`, `@kernel/db-postgres`, `@kernel/graphql`, `@kernel/rest`, `@kernel/rpc`, `@kernel/cli`, `@kernel/client`, `@kernel/plugin-sdk`, and the rest — and they are **versioned in lockstep**. Every package in a release shares one version number. If `@kernel/core` is `2.4.0`, then `@kernel/admin`, `@kernel/db`, and `@kernel/graphql` are all `2.4.0`.

This is the same decision Payload made when it consolidated its packages, and the opposite of Strapi's looser per-plugin drift. Independent versioning sounds flexible until a user pairs `@kernel/core@2.4` with `@kernel/db-postgres@2.1` and hits a schema-diff bug that exists only at that combination. Lockstep makes the support matrix one-dimensional: there is exactly one valid combination per version, the CLI enforces it, and bug reports collapse to a single coordinate.

```bash
# kernel doctor refuses to run on a mismatched workspace
$ kernel doctor
✖ Version skew detected
    @kernel/core        2.4.0
    @kernel/db-postgres 2.1.3   ← expected 2.4.0
  Run `kernel upgrade` to align all @kernel/* packages.
```

The one exception is `@kernel/cloud`, which tracks the hosted platform and carries its own version because it deploys continuously rather than on the npm cadence. It declares a peer range against the core line (`"@kernel/core": "^2.x"`).

## Semver policy

We follow [Semantic Versioning 2.0.0](https://semver.org) literally. The contract is defined by what we consider *public surface*, because semver is only as meaningful as its boundary.

| Bump | Triggers when we… | Examples |
|------|-------------------|----------|
| **major** `x.0.0` | break a documented public API, change generated REST/GraphQL/RPC output shape, or change the migration format | rename a field config key, change `where` operator semantics, drop a Node version |
| **minor** `2.x.0` | add public API, add an adapter, add a field type, or deprecate something | new `point` field option, new `@kernel/db-mysql` capability, new server hook |
| **patch** `2.4.x` | fix a bug without changing surface | migration diff correctness fix, admin render bug |

### What is public surface

Public surface is exactly:

- The exported, non-`internal` types and functions of every `@kernel/*` package.
- The `kernel.config.ts` schema — field types, collection/global options, adapter options.
- The **generated** REST routes, GraphQL schema, and RPC server-function signatures derived from a given config. If your config is unchanged across a minor, your API shape is unchanged.
- The shared query language: `where`, `sort`, pagination, and `depth` semantics across REST, GraphQL, the Local API, and `@kernel/client`.
- The migration file format and the Adapter contract that database backends implement.

Anything exported under an `internal` subpath, anything typed with the `@kernel-unstable` JSDoc tag, and the admin component internals (as opposed to the documented slot/override API) are **not** public surface and may change in a minor.

```ts
// kernel.config.ts — surface that is covered by semver
import { defineConfig, collection, fields } from '@kernel/core'
import { postgres } from '@kernel/db-postgres'

export default defineConfig({
  db: postgres({ url: process.env.DATABASE_URL! }),
  collections: [
    collection('posts', {
      fields: [
        fields.text('title', { required: true }),
        fields.richText('body'),
        fields.relationship('author', { to: 'users' }),
      ],
      versions: { drafts: true, autosave: true },
    }),
  ],
})
```

The output of `kernel generate types` is also covered: a minor release will not change a type in a way that breaks a previously-compiling project. New optional properties are fine; tightening an existing one is a major.

### Pre-1.0 caveat

Before `1.0.0`, semver permits breaking changes in minors. We honor that but soften it: every `0.x` minor with a breaking change ships a codemod (`kernel upgrade --codemod`) and a migration note. This is the window where Sanity and Strapi historically broke users silently between minors; we will not.

## Release channels: alpha, beta, GA

Every feature moves left-to-right through three channels. The channel is encoded in both the npm dist-tag and the version's prerelease identifier, so you always know what you installed.

```
                deprecation
                   window
   ┌─────────┐  ┌─────────┐  ┌─────────────┐  ┌──────────┐
   │  alpha  │→ │  beta   │→ │     GA      │→ │ deprecated│
   │ @next   │  │ @beta   │  │  @latest    │  │  (still   │
   │ 2.5.0-  │  │ 2.5.0-  │  │  2.5.0      │  │  works)   │
   │ alpha.3 │  │ beta.1  │  │             │  │           │
   └─────────┘  └─────────┘  └─────────────┘  └──────────┘
     no SLA      API frozen    semver applies   ≥1 major
   may vanish    may patch      in full
```

| Channel | dist-tag | Stability promise | Who it's for |
|---------|----------|-------------------|--------------|
| **alpha** | `@next` | None. APIs change without notice; features may be removed entirely. | Contributors, plugin authors validating the SDK early. |
| **beta** | `@beta` | API is **frozen** for the feature. Only bug fixes land. Data written is forward-compatible to GA. | Teams who want the feature in staging and will tolerate patch churn. |
| **GA** | `@latest` | Full semver. This is the default `npm install`. | Production. |

A feature graduates alpha → beta when its `kernel.config.ts` surface and generated API are settled and it has migration coverage. Beta → GA requires: docs, a codemod for any migration path, performance budgets met (see [Performance Budgets](../11-quality/02-performance-benchmarks-and-budgets.md)), and the security gate passed (see Security Model).

Individual features can also ship behind a flag inside a GA release, which is how we get real-world signal without a separate prerelease line:

```ts
export default defineConfig({
  experimental: {
    // typed, autocompleted, and warns at boot
    liveCollections: true,    // @kernel/db reactive client collections
    visualEditingV2: false,
  },
})
```

`experimental` flags are explicitly **not** under semver. A flag can change shape or be removed in a minor; the flag name itself signals that. When the feature reaches GA, the flag becomes a no-op for one major (it warns, then is removed in the next major).

## LTS

KernelCMS designates one major line per year as **LTS**. Self-hosters and agencies running many client sites cannot chase a new major every six months; this is the gap Strapi's frequent majors and Payload's faster cadence leave open for teams that prize stability over the newest field type.

```
2024        2025                2026                2027
 │           │                   │                   │
 v1.x ───────┤                   │                   │
             v2.x (LTS) ─────────────────────────────┤  ← 18mo support
             │      v3.x ────────┤                   │
             │      │   v4.x (LTS)────────────────────────────┤
```

An LTS line receives:

- **18 months** of patch releases from the day the *next* major ships.
- Security backports for the full window, even after feature patches stop at 12 months.
- Guaranteed adapter compatibility: an LTS pins exact `drizzle-orm` and runtime (Node/Bun) ranges and will not move them.

Non-LTS majors are supported for **6 months** after their successor ships — enough to upgrade off, not enough to camp on. The CLI surfaces this:

```bash
$ kernel upgrade --check
  Current: 2.7.3 (LTS, security support until 2027-04)
  Latest:  3.1.0 (@latest)
  → You are on an LTS line. No action required.
    Run `kernel upgrade --to 3` when ready; codemods available.
```

LTS does not mean frozen. LTS lines still receive new minor releases (additive only) for their first 12 months, so you get new adapters and field types without a major jump — you simply opt out of breaking churn.

## Deprecation cadence

Nothing is removed without first being deprecated, and every deprecation is observable three ways: at the **type level**, at **runtime**, and in the **changelog**. The rule is **deprecate in a minor, remove no sooner than the next major** — a minimum runway of one major (roughly six months).

```ts
// @kernel/core — a deprecated option is still typed, still works,
// and is flagged by the @deprecated tag so editors strike it through.
export interface TextFieldOptions {
  /** @deprecated since 2.6 — use `unique` on the collection index. Removed in 3.0. */
  unique?: boolean
  index?: IndexOptions
}
```

At runtime the server logs a single, deduplicated warning per deprecated usage at boot, with the version it lands in:

```
⚠ [deprecation] fields.text('slug', { unique: true })
   `unique` on a field is deprecated since 2.6.0 and will be removed in 3.0.0.
   Migrate to: collection('posts', { indexes: [{ on: ['slug'], unique: true }] })
   Docs: https://kernelcms.dev/migrate/field-unique
   Silence: KERNEL_SUPPRESS_DEPRECATIONS=field-unique
```

The deprecation timeline is fixed so you can plan around it:

| Phase | Channel | What happens |
|-------|---------|--------------|
| Announce | minor `2.6.0` | `@deprecated` JSDoc, boot warning, changelog entry, codemod published |
| Sustain | every minor `2.7+` | warning persists, behavior unchanged |
| Remove | next major `3.0.0` | symbol deleted; `kernel upgrade --codemod` rewrites call sites |

Every removal ships with an executable codemod, not just prose. Sanity and Strapi have historically documented breaking changes in release notes and left the rewrite to you; we treat the codemod as part of the deprecation's definition of done.

```bash
$ kernel upgrade --to 3 --codemod
  Scanning kernel.config.ts and src/**
  ✓ field-unique → collection index   (3 sites)
  ✓ where.contains → where.like       (12 call sites)
  ✓ rich-text v1 nodes → v2           (kernel.config.ts)
  Review the diff, run `kernel doctor`, then commit.
```

We also enforce a **deprecation budget**: no single major may break more than is reasonably codemod-able, and any change without a codemod requires explicit sign-off in the release plan. If we cannot write the codemod, we question whether the breaking change is worth it.

## Cutting a release

The pipeline is mechanical and runs from a Changesets-driven workflow, so the version bump is a function of the merged changes, not a judgment call at release time.

```
PR merged ──▶ changeset (patch|minor|major) ──▶ CI gate ──▶ tag ──▶ publish
                                                    │
                              type check · tests · perf budgets · security gate
```

Each PR that touches public surface must include a changeset declaring its bump level; CI fails the PR if surface changed without one. At release, the bumps aggregate to the highest level present, the changelog is generated from the changeset bodies, all `@kernel/*` packages are stamped with the same version, and the artifacts publish under the channel-appropriate dist-tag.

- **Minor**: monthly, on a fixed week.
- **Patch**: as needed, typically weekly, including security patches to all supported lines (current GA + all LTS).
- **Major**: roughly twice a year, never as a surprise — the deprecations that enable it have been live for at least a full major beforehand.

See Roadmap for what each upcoming minor and major targets, and Migration Guides for the per-major codemod catalog.

## Open questions

- **LTS count.** One LTS line at a time keeps the matrix simple, but large agencies have asked for two overlapping LTS lines (a 36-month effective window). The carrying cost of security backports across three lines (current + 2 LTS) is the blocker; undecided.
- **Edge-runtime versioning.** Edge deploys (`@kernel/server` on Cloudflare/Deno) pin a runtime that itself moves faster than our LTS window. Whether an LTS can guarantee an edge target for 18 months, or only the Node/Bun targets, is unresolved.
- **`@kernel/plugin-sdk` independence.** Plugin authors want the SDK to carry a slower, wider compatibility range than the lockstep core so a plugin built for `2.0` keeps working through `2.x` without a rebuild. This conflicts with strict lockstep; we may carve the plugin-sdk out as a second independently-versioned package alongside `@kernel/cloud`.
