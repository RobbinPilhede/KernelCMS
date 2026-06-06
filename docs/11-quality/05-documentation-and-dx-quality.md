# Documentation & DX Quality

Documentation in KernelCMS is treated as a build artifact, not prose written once and abandoned. The same config-as-code that drives the runtime drives the docs: types are extracted from source, examples are compiled and executed in CI, and the published site is regenerated on every merge. This document specifies how the docs site is architected, how we detect drift between the documentation and the actual `@kernel/*` surface, how examples are kept executable, and how reader feedback closes the loop. The goal is blunt: a developer should never hit a `kernel.config.ts` snippet that no longer compiles, an API reference that lags the source by three releases, or a "REST endpoint" that was renamed two minors ago. Payload, Sanity, and Strapi all ship excellent hand-written docs that drift the moment the team is busy shipping features. We refuse to hand-write what we can derive.

## Docs Site Architecture

The docs site is itself a TanStack Start application living in `apps/docs`, which means it shares the same SSR, routing, and data-fetching primitives the admin panel uses. We do not adopt Docusaurus or Nextra; using our own stack means dogfooding TanStack Router and TanStack Query, and it lets reference pages hydrate live examples against a real `@kernel/server` instance running in a worker.

Content is authored as MDX under `docs/`, organized by the numbered directory scheme you are reading now (`11-quality/05-documentation-and-dx-quality.md`). Three content sources feed the site:

| Source                  | Origin                                        | Generation                    |
| ----------------------- | --------------------------------------------- | ----------------------------- |
| Guides & concepts       | Hand-written MDX in `docs/`                   | Authored, reviewed in PR      |
| API reference           | TSDoc + type extraction from `packages/*/src` | Generated at build time       |
| Config schema reference | `defineConfig` Zod/validator metadata         | Generated from `@kernel/core` |

```
packages/*/src ──(api-extractor)──► .api.json ─┐
                                                ├─► @kernel/docs-gen ─► MDX ─► TanStack Start ─► static + SSR
docs/*.mdx ─────────────────────────────────────┘
kernel.config schema ──(reflection)──────────────┘
```

Reference pages are never written by hand. A `@kernel/docs-gen` package walks the public entry points declared in each package's `exports` map, runs the TypeScript compiler API over them, and emits one MDX page per exported symbol with its signature, TSDoc summary, `@example` blocks, and resolved type links. Cross-links between symbols (for example, `defineCollection` → `Field` → `RichTextField`) are resolved from the type graph, so a rename in source produces a corrected link in docs without anyone touching markdown. This is the structural advantage over Sanity and Strapi, whose API references are maintained separately from the codebase and are therefore always a manual diff behind.

Routing and search are wired through TanStack Router's type-safe routes; search params hold the active version and the symbol filter, so a deep link like `/reference/core?symbol=defineCollection&v=2.3` is reproducible. Versioned docs are built per release tag and served from immutable paths; the latest stable is aliased at the root.

See [Type Safety End to End](../01-architecture/07-content-schema-and-type-generation.md) and [Release & Versioning](../13-roadmap/02-release-plan-and-versioning.md) for the upstream contracts the docs depend on.

## Drift Detection From Types

Drift is the failure mode that kills CMS documentation. We attack it by making types the single source of truth and failing CI when the docs no longer match.

The mechanism is an API report. Every package emits a committed `.api.md` rollup (via API Extractor) that captures its entire public surface. A PR that changes an exported signature must regenerate and commit the rollup; if it does not, the `api-report` check fails. This turns every public API change into a reviewable diff that a human approves on purpose.

```ts
// .github/workflows/docs.yml runs, per package:
//   pnpm api-extractor run --local   → updates etc/<pkg>.api.md
//   git diff --exit-code etc/        → fails if uncommitted drift exists
```

On top of the rollup, `@kernel/docs-gen` runs an assertion pass that checks documented symbols against the live type graph:

```ts
import { collectPublicApi } from '@kernel/docs-gen'

const api = collectPublicApi(['@kernel/core', '@kernel/server', '@kernel/client'])

for (const symbol of api.exported) {
  if (!symbol.tsdoc.summary) {
    fail(`${symbol.canonicalName} is exported without a TSDoc summary`)
  }
  if (symbol.kind === 'function' && symbol.params.some((p) => !p.documented)) {
    fail(`${symbol.canonicalName} has undocumented parameters`)
  }
}
```

We also detect drift in the _config_ surface, which is where Payload's and Strapi's docs most often go stale. Because `kernel.config.ts` is validated by a schema in `@kernel/core`, that schema is the authority for what fields and options exist. The config reference page is generated from it, and a snapshot test guards it:

```ts
// kernel.config.ts — the canonical shape the reference is derived from
import { defineConfig, defineCollection } from '@kernel/core'

export default defineConfig({
  db: { adapter: '@kernel/db-postgres', url: process.env.DATABASE_URL! },
  collections: [
    defineCollection({
      slug: 'posts',
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'body', type: 'richText' },
        { name: 'author', type: 'relationship', to: 'users' },
      ],
      versions: { drafts: true, autosave: true },
    }),
  ],
})
```

```ts
// drift guard
import { configSchema } from '@kernel/core'
import { readDocumentedOptions } from '@kernel/docs-gen'

test('every config option is documented', () => {
  const schemaKeys = configSchema.keyPaths() // from the validator
  const documented = readDocumentedOptions('docs/reference/config.mdx')
  expect(schemaKeys).toEqual(expect.arrayContaining(documented))
  expect(documented).toEqual(expect.arrayContaining(schemaKeys)) // both directions
})
```

The check runs in both directions: a documented option that the schema dropped is a _stale_ doc; a schema option with no docs is a _missing_ doc. Both fail the build. The result is that you cannot add a field type to the validator without the docs pipeline forcing a reference entry, and you cannot remove one without the stale entry surfacing.

## Examples That Run in CI

A code example that does not compile is worse than no example — it actively misleads. Every fenced TypeScript block in the docs is extracted and type-checked, and the runnable ones are executed against a real ephemeral KernelCMS instance.

Extraction is by language tag and a small set of attributes on the fence:

````md
```ts title="kernel.config.ts" runtime="check"
// type-checked only — must compile against the published @kernel/* types
```

```ts title="seed.ts" runtime="run" db="sqlite"
// executed end-to-end against an in-memory @kernel/db-sqlite instance
```

```ts runtime="skip"
// excluded from CI — for illustrative pseudo-code only, used sparingly
```
````

The pipeline assembles each `runtime="check"` block into a temp module, points it at the workspace's built `.d.ts` outputs, and runs `tsc --noEmit`. Blocks marked `runtime="run"` go further: they boot a `@kernel/server` over `@kernel/db-sqlite` (in-memory, zero external services) and execute the snippet through the Local API so that operations, access control, and validation all fire for real.

```ts
// example harness, conceptually
import { createTestServer } from '@kernel/server/testing'
import config from './fixtures/example.config'

const kernel = await createTestServer({ config, db: 'sqlite::memory:' })

const post = await kernel.local.create('posts', {
  data: { title: 'Hello', body: richText('First post') },
})

expect(post.id).toBeDefined()
await kernel.close()
```

| Block mode | What CI does                              | Catches                                               |
| ---------- | ----------------------------------------- | ----------------------------------------------------- |
| `check`    | `tsc --noEmit` against published types    | Signature drift, renamed exports, wrong generics      |
| `run`      | Boots server + SQLite, runs via Local API | Behavioral breakage, removed operations, bad defaults |
| `skip`     | Nothing (linted for overuse)              | —                                                     |

This is the part most competitors do not do at all. Strapi and Sanity docs contain hundreds of snippets that are never compiled; readers discover breakage at runtime. Because KernelCMS exposes the **same operation core** through the Local API, REST, GraphQL, and typed RPC, one executed snippet exercises the path every surface shares. We cap `runtime="skip"` usage with a lint rule — if more than a small percentage of a page's blocks are skipped, review flags it, because skipping is how rot creeps back in.

Examples live next to the docs they appear in and are also published as a `examples/` directory in the monorepo, so a reader can `git clone`, `pnpm install`, and run the exact thing they read. The CI job and the published example share one source file; there is no second copy to drift.

## The Feedback Loop

Generation and CI keep docs _correct_; the feedback loop keeps them _useful_. Correct-but-confusing is still a DX failure.

Every docs page carries a footer widget — a small TanStack Form — with "Was this page helpful?" and an optional free-text field. Submissions post through a TanStack Start server function to a `doc_feedback` collection (dogfooding KernelCMS to store KernelCMS's own feedback) tagged with the page path, the docs version, and the resolved symbol if it is a reference page. We deliberately do not collect anything user-identifying; the payload is page, verdict, optional text, and a coarse referrer.

```
reader ──► feedback widget ──► server fn ──► doc_feedback collection
                                                   │
weekly digest ◄── TanStack Query dashboard ◄───────┘
                                                   │
"unhelpful" spike ──► auto-open GitHub issue ──► triage ──► PR ──► regenerate
```

Signals are aggregated three ways:

1. **In-product dashboard** — a `@kernel/admin` view (TanStack Table + TanStack Query) ranking pages by unhelpful-rate and volume, so the worst pages float to the top.
2. **Search-with-no-result log** — queries that returned nothing become a backlog of missing docs; this is the highest-signal source of _what to write next_.
3. **Automated issue filing** — when an unhelpful-rate crosses a threshold over a rolling window, a bot opens a GitHub issue with the page, the verbatim comments, and the diff of recent changes to that page's underlying source, so a maintainer can see whether a code change caused the confusion.

The loop is explicitly tied back to the generators. If feedback shows a reference page is unclear, the fix is usually a better TSDoc `@example` in source — which then flows into the generated page automatically. Improving the docs and improving the in-IDE hover text are the same action, because both read from the same TSDoc. That alignment is the whole thesis: one source, many surfaces, every surface verified.

## Open Questions

- **Versioned example execution.** Running `runtime="run"` blocks for _every_ supported version on every PR is expensive. Do we execute only against the latest, and type-check (`check`) against the version matrix, or invest in caching booted-server fixtures per version?
- **Feedback storage tenancy.** Hosting feedback in a KernelCMS instance is good dogfooding, but couples the public docs site's availability to a write path. Should `doc_feedback` live in a separate isolated project, or in KernelCMS Cloud with stricter rate limits?
- **MongoDB in the example harness.** The harness uses `@kernel/db-sqlite` for speed and zero dependencies. Document-oriented examples that lean on `@kernel/db-mongodb` semantics are not exercised end-to-end — do we add an optional containerized Mongo lane for the subset of examples that need it?
