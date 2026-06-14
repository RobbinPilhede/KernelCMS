# Stability & versioning policy

KernelCMS is a CMS: you build your content model, access rules, and integrations on top
of it, so you need to know what a version bump can change under you. This document is that
contract — what counts as the public API, what a release may change, how deprecations are
handled, and what 1.0 commits to.

It applies to the published [`kernelcms`](https://www.npmjs.com/package/kernelcms) package
and the `@kernel/*` packages it re-exports.

## TL;DR

- We follow [Semantic Versioning](https://semver.org/).
- **Until 1.0** (the current `0.x` line): **minor** releases may contain breaking changes
  to the public API, but every one is called out in the changelog
  ([`packages/kernelcms/CHANGELOG.md`](./packages/kernelcms/CHANGELOG.md), mirrored in the
  GitHub release notes) with a migration note. **Patch** releases never break the public
  API.
- A breaking change to a **stable** API is never silent: it ships a deprecation first
  (see [Deprecation policy](#deprecation-policy)) wherever a runtime shim is possible.
- **Experimental** APIs (see below) can change in any release without a deprecation cycle.
- **1.0 onward:** standard SemVer — breaking changes to stable APIs only in **major**
  releases.

## What is the public API

The public API is everything you are *meant* to import and call:

- The `defineConfig` configuration surface — collection, field, access, hook, auth, jobs,
  and plugin shapes — i.e. everything you write in your kernel config.
- The `Kernel` operations surface returned by `initKernel` (the Local API): `find`,
  `create`, `update`, `delete`, `publish`, `mergeBranch`, `syncContent`, and the rest.
- The exported TypeScript types backing the above.
- The HTTP surface mounted by `@kernel/server`: the REST routes, their request/response
  shapes, the GraphQL schema, and the generated OpenAPI document.
- The adapter contracts in `@kernel/db` (`DatabaseAdapter`, `CacheAdapter`,
  `SearchAdapter`, `VectorAdapter`, `StorageAdapter`, …) — the seams third-party adapters
  implement.
- The CLI commands and their flags (`kernel dev|migrate|seed|mcp|types|…`).
- The MCP tool surface generated from your model.

### What is NOT public (may change in any release)

- Anything imported from a deep path rather than a package entry point (e.g.
  `kernelcms/dist/...`). Import from the package root only.
- Identifiers prefixed with `_` (functions, fields, response keys) and the `_`-prefixed
  **system tables** (`_versions`, `_audit`, `_credentials`, `_releases`, `_branches`,
  `_branch_docs`, `_workflow_runs`, …). Treat these as engine internals; their schema and
  contents are not a stable interface.
- The **on-disk database schema and migration SQL.** It is managed for you through
  `kernel migrate`; we may change how a feature is stored between versions. Do not write
  application code against the raw tables — go through the API.
- Internal module structure and any symbol not documented as public.
- Exact log lines, error *messages* (the typed error `code` is stable; the human string is
  not), and timing.

## Stability tiers

Every feature is **stable** unless explicitly marked **experimental** here. Experimental
features are fully usable and tested, but their API may still change without a deprecation
cycle as we learn from real use.

**Experimental at the current release:**

- Agentic **workflows** (`runWorkflow`, the workflow config shape, `_workflow_runs`).
- **GraphRAG** / knowledge-graph search (`graphSearch`) and the bundled in-memory vector
  store (`memoryVector`) — the vector **adapter contract** is stable; the bundled store is
  for single-node/modest-corpus use and its internals are not.
- **Content federation** (`exportContent` / `syncContent`) and **content branches**
  (`stageChange` / `mergeBranch`), including their new opt-in `atomic` modes.
- **Personalization** experiments / A/B assignment.

When an experimental feature graduates to stable it is announced in the changelog and
removed from this list.

## Deprecation policy

When we need to change or remove a **stable** public API, we do not break it outright:

1. The old API keeps working and gains a **runtime deprecation warning** (logged once per
   process) and a `@deprecated` JSDoc tag pointing at the replacement.
2. The deprecation, the replacement, and the migration are documented in the changelog.
3. The old API is removed no sooner than:
   - **Pre-1.0:** the next **minor** release after the one that introduced the deprecation
     (a one-minor window — we move fast, but never in the same release).
   - **1.0 onward:** the next **major** release.

Where a runtime shim is impossible (e.g. a type-only change the compiler must catch), the
break is still called out in the changelog with a migration note, and we aim to make the
compiler error point at the fix.

## Reading the changelog

Releases are produced with [Changesets](https://github.com/changesets/changesets). Every
change that affects you is in the per-package changelog (e.g.
[`packages/kernelcms/CHANGELOG.md`](./packages/kernelcms/CHANGELOG.md)) and the GitHub
release notes, classified as `major` / `minor` / `patch`. Before upgrading across a
**minor** on the `0.x` line, skim the changelog for the **breaking** / **deprecated**
entries — that is where any required migration lives.

## The road to 1.0

1.0 is the point at which the stable surface stops moving without a major bump. Reaching it
means:

- The stable public API (above) is frozen behind the SemVer guarantee — breaking changes
  only in a major.
- The experimental list is empty or each remaining item is explicitly tagged as staying
  experimental past 1.0.
- A published **upgrade guide** between every subsequent minor.
- A stated **support window** for the latest major.

Until then, treat `0.x` minors as potentially breaking-but-documented, pin the version you
deploy, and read the changelog before you bump.
