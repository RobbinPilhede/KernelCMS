# Contributing to KernelCMS

Thanks for your interest in improving KernelCMS. This guide gets you from clone to a
green pull request.

## Prerequisites

- Node.js 22 or newer (the project is developed on Node 24; the SQLite adapter uses the
  built-in `node:sqlite`).
- pnpm (the repo pins a version through the `packageManager` field, so Corepack picks
  it up automatically).

## Setup

```bash
pnpm install
pnpm example:seed     # creates ./blog.db with demo content and an admin user
pnpm example:dev      # API on http://localhost:3000/api
pnpm admin            # admin UI on http://localhost:5173
```

## The checks a PR must pass

These are exactly what CI runs, so run them locally before pushing:

```bash
pnpm typecheck        # tsc across all packages
pnpm lint             # ESLint
pnpm format           # Prettier check (use pnpm format:write to fix)
pnpm test             # vitest: engine, HTTP API, adapters
pnpm -r run build     # build every package
pnpm exec playwright test   # end-to-end browser suite
```

## Project layout

This is a pnpm monorepo. The interesting parts:

- `packages/core` is the content engine: config, fields, operations, access, hooks,
  auth, jobs, and the Local API.
- `packages/server`, `packages/graphql`, and `packages/client` expose it.
- `packages/db-*` and `packages/storage` are adapters; new backends go here.
- `apps/admin` is the React admin panel.
- `examples/blog` is a runnable demo and the source of the example tests.

Heavy or opinionated dependencies belong behind optional adapters, never in
`@kernel/core`. Keeping the core dependency-light is a core design goal.

## Changesets

We use [Changesets](https://github.com/changesets/changesets) to manage versions and
the changelog. If your change affects a published package, add one:

```bash
pnpm changeset
```

Pick the affected packages and a semver bump, and write a short, user-facing summary.
Commit the generated file in `.changeset/` with your PR.

## Commit and PR guidelines

- Keep PRs focused; smaller is easier to review.
- Write a clear description of what changed and why.
- Add or update tests for behavior changes.
- Make sure the full check list above is green.

## Code of conduct

Be respectful and constructive. We follow the spirit of the
[Contributor Covenant](https://www.contributor-covenant.org/).
