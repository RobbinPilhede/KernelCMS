# Testing Strategy

KernelCMS is a monorepo of swappable adapters wired through one operation core. That shape dictates the test strategy: a wide base of fast unit tests on pure logic, a deliberately thick middle of integration tests that run the real operation core against **real** databases through the `Adapter` contract, and a thin top of Playwright end-to-end tests that exercise the TanStack Start admin against a live server. This document defines the split, the tooling, what runs where, and the coverage gates that block a merge.

## The pyramid, applied to a CMS

A generic test pyramid says "lots of unit, some integration, few e2e." For a headless CMS that is almost right but misleading. The most valuable tests we own are integration tests that prove a `create`, `update`, `find`, or `publish` operation behaves identically across `@kernel/db-postgres`, `@kernel/db-sqlite`, `@kernel/db-mysql`, and `@kernel/db-mongodb`. Those tests are where Payload, Sanity, and Strapi accrue the most regressions, because adapter behavior diverges (transaction semantics, JSON column handling, relationship joins) in ways unit tests never catch.

```
        e2e (Playwright)        ~5%   admin flows, auth, live preview
      ─────────────────────
    integration (Vitest)        ~30%  operation core × real adapters
  ───────────────────────────
 unit (Vitest)                  ~65%  validation, query compiler, field logic
```

The split is by _count_ of tests, not by _value_. We run the whole base on every push; the integration matrix on every push for the default adapter (Postgres) and on a merge queue for the full matrix; e2e on the merge queue and nightly.

| Layer       | Runner     | Scope                         | Where it lives                | Speed budget |
| ----------- | ---------- | ----------------------------- | ----------------------------- | ------------ |
| Unit        | Vitest     | Pure functions, no I/O        | colocated `*.test.ts`         | < 50ms each  |
| Integration | Vitest     | Operation core + real adapter | `packages/*/test/integration` | < 2s each    |
| E2E         | Playwright | Admin app + server over HTTP  | `e2e/` at repo root           | < 30s each   |

We standardize on **Vitest** for unit and integration (native ESM, TypeScript, `vi.mock`, workspace projects) and **Playwright** for e2e. Strapi leans on Jest and Sanity on a mix; a single Vitest workspace across `@kernel/*` keeps watch mode, coverage, and config uniform.

## Unit tests

Unit tests cover code that can be exercised with no database, no network, and no filesystem. In KernelCMS that is a large surface: the validation engine, the shared query language compiler (`where` / `sort` / pagination / `depth`), field type coercion, access-control predicate evaluation, the richtext AST transforms in `@kernel/richtext`, and config normalization in `@kernel/core`.

These tests are colocated next to source as `*.test.ts` and never touch an adapter. The query compiler is the canonical example — it must turn one query object into correct SQL fragments or a Mongo filter, and that logic is pure given an adapter dialect.

```ts
import { describe, it, expect } from 'vitest'
import { compileWhere } from '@kernel/db'

describe('compileWhere', () => {
  it('translates nested and/or with operators for the postgres dialect', () => {
    const result = compileWhere(
      {
        and: [
          { status: { equals: 'published' } },
          { or: [{ title: { contains: 'kernel' } }, { views: { greater_than: 100 } }] },
        ],
      },
      { dialect: 'postgres', table: 'posts' },
    )

    expect(result.sql).toBe(`("posts"."status" = $1 and ("posts"."title" ilike $2 or "posts"."views" > $3))`)
    expect(result.params).toEqual(['published', '%kernel%', 100])
  })
})
```

Validation is the other heavy unit area. A field's sync, async, and cross-field rules are functions; we test them in isolation with factory-built field configs rather than spinning up a document operation.

```ts
import { runFieldValidators } from '@kernel/core'
import { textField } from '../factories'

it('rejects a slug that collides with a sibling in the same array row', async () => {
  const field = textField({ name: 'slug', validate: uniqueWithinArray('slug') })
  const errors = await runFieldValidators(field, 'intro', {
    siblingData: [{ slug: 'intro' }, { slug: 'intro' }],
  })
  expect(errors).toContainEqual({ path: 'slug', code: 'duplicate' })
})
```

Rules for the unit layer:

- **No mocking the adapter.** If a test needs an adapter, it belongs in integration. Mocked adapters give false confidence — they pass while the real driver throws.
- **Factories, not literals.** Each package ships a `test/factories.ts` exporting `collectionConfig()`, `textField()`, `relationshipField()`, etc., so tests state only the field under examination.
- **Test behavior.** Assert on returned errors, compiled output, and transformed ASTs — never on private internals.

## Integration tests

Integration tests are the strategic center of KernelCMS. They instantiate the **real** operation core — the same code path the Local API, REST, GraphQL, and RPC surfaces call — and run it against a **real** database through a concrete adapter. We do not stub Drizzle, and we do not use an in-memory fake for Postgres. SQLite runs in-process (libSQL), but Postgres, MySQL, and MongoDB run as actual servers via **Testcontainers**, so transactions, constraints, JSON columns, and relationship joins are exercised exactly as in production.

This is the line that separates KernelCMS from the field. Payload's adapter behavior, Strapi's database layer, and Sanity's dataset semantics all drift between backends; users discover the drift in production. Our contract is that every adapter passes the _same_ suite.

### The shared adapter conformance suite

`@kernel/db` exports a parameterized conformance suite. Each adapter package imports it and supplies a factory that returns a connected, migrated instance pointed at a throwaway database. One suite, four adapters, identical assertions.

```ts
// packages/db-postgres/test/integration/conformance.test.ts
import { runAdapterConformance } from '@kernel/db/conformance'
import { PostgreSqlContainer } from '@testcontainers/postgresql'
import { postgresAdapter } from '@kernel/db-postgres'

runAdapterConformance({
  name: 'postgres',
  async setup() {
    const container = await new PostgreSqlContainer('postgres:16-alpine').start()
    const adapter = postgresAdapter({ connectionString: container.getConnectionUri() })
    await adapter.migrate() // applies generated schema-diff migrations
    return {
      adapter,
      teardown: () => container.stop(),
    }
  },
})
```

The suite asserts cross-cutting operation behavior, not adapter internals:

- CRUD round-trips for every field type, including `point`, `json`, `code`, and `blocks`.
- `depth`-controlled relationship population (depth 0 = IDs, depth 2 = nested docs).
- Draft/publish: a published read never returns autosaved draft data; version history records each save.
- Field-level localization: writing `en` then `da` yields two locale values on one document row.
- Access control evaluated at operation, document, and field level — a field the caller cannot read is stripped from the result.
- Transaction rollback: a failing afterChange hook rolls the whole operation back, leaving zero rows.

```ts
export function runAdapterConformance(driver: AdapterDriver) {
  describe(`adapter conformance: ${driver.name}`, () => {
    let ctx: AdapterContext
    beforeAll(async () => {
      ctx = await driver.setup()
    })
    afterAll(() => ctx.teardown())

    it('populates relationships to the requested depth', async () => {
      const author = await ctx.adapter.create('authors', { name: 'Lars' })
      const post = await ctx.adapter.create('posts', { title: 'Hi', author: author.id })

      const shallow = await ctx.adapter.findByID('posts', post.id, { depth: 0 })
      expect(shallow.author).toBe(author.id)

      const deep = await ctx.adapter.findByID('posts', post.id, { depth: 1 })
      expect(deep.author).toMatchObject({ id: author.id, name: 'Lars' })
    })
  })
}
```

### API surface integration

Above the adapter, a second integration tier proves the four API surfaces agree. We build a server from a fixture `kernel.config.ts` and assert that REST, GraphQL, and RPC return the same documents for the same query, since all three compile to the one shared query language.

```ts
import { defineConfig } from '@kernel/core'
import { postgresAdapter } from '@kernel/db-postgres'

export default defineConfig({
  db: postgresAdapter({ connectionString: process.env.DATABASE_URL! }),
  collections: [
    {
      slug: 'posts',
      access: { read: ({ req }) => req.user?.role === 'editor' },
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'body', type: 'richText' },
        { name: 'author', type: 'relationship', relationTo: 'authors' },
      ],
    },
  ],
})
```

```ts
it('returns identical results from REST, GraphQL, and the Local API', async () => {
  const app = await createTestServer(config)
  const where = { title: { contains: 'kernel' } }

  const local = await app.local.find({ collection: 'posts', where, depth: 1 })
  const rest = await app.rest.get('/api/posts', { query: { where, depth: 1 } })
  const gql = await app.graphql(`query($w: PostWhere) { posts(where:$w, depth:1){ docs{ id title } } }`, { w: where })

  expect(rest.body.docs).toEqual(local.docs)
  expect(gql.data.posts.docs).toEqual(local.docs.map(pick('id', 'title')))
})
```

This tier is also where access control gets its real workout: we drive operations as different `req.user` roles and assert that unauthorized reads are denied and unreadable fields are stripped — at the operation, document, _and_ field level. See [Access Control](../06-auth-security/01-authorization-and-access-control.md) for the model under test.

## Admin e2e with Playwright

The admin is a TanStack Start app: TanStack Router for routing and search-param state, Query for data, Table for list views, Form for edit forms, Store for UI state, Virtual for long lists. Unit-testing React components in isolation buys little here, because the value is in the wiring — router params driving Query keys, Form submissions hitting RPC server functions, optimistic updates reconciling against the server. So we keep component unit tests minimal and invest in **Playwright** flows against a real running stack.

Each e2e spec boots the full server with a seeded Postgres container, signs in through `@kernel/auth`, and drives the browser. We test journeys, not pages.

```ts
import { test, expect } from '@playwright/test'

test('editor creates, autosaves, and publishes a post', async ({ page }) => {
  await signIn(page, { role: 'editor' })
  await page.goto('/admin/collections/posts/create')

  await page.getByLabel('Title').fill('Launch announcement')
  await page.getByRole('textbox', { name: 'Body' }).fill('KernelCMS is live.')

  // autosave writes a draft version without an explicit save
  await expect(page.getByText('Draft saved')).toBeVisible()

  await page.getByRole('button', { name: 'Publish' }).click()
  await expect(page.getByText('Published')).toBeVisible()

  // version history records both the autosave and the publish
  await page.getByRole('tab', { name: 'Versions' }).click()
  await expect(page.getByRole('listitem')).toHaveCount(2)
})
```

Priority e2e flows:

- **Auth and access:** sign-in, role gating, a viewer being denied the create route.
- **Collection list:** TanStack Table sorting, filtering, and column sizing persist to URL search params and survive reload.
- **Document edit:** TanStack Form validation (sync, async, cross-field), array/blocks add-remove-reorder, localized field switching.
- **Drafts and versions:** autosave, restore a prior version, publish.
- **Live preview:** edits in the form reflect in the preview iframe via visual editing.
- **Command palette and keyboard UX:** every primary action reachable without a mouse.

Accessibility is enforced inside the e2e run, not as a separate afterthought. We assert `@axe-core/playwright` finds zero violations on key screens, backing the WCAG 2.2 AA commitment. RTL is covered by running a locale-switched variant of the edit flow. See [Accessibility](../04-admin-ui/13-accessibility-standards.md).

```ts
import AxeBuilder from '@axe-core/playwright'

test('document editor has no WCAG 2.2 AA violations', async ({ page }) => {
  await signIn(page, { role: 'editor' })
  await page.goto('/admin/collections/posts/create')
  const results = await new AxeBuilder({ page }).withTags(['wcag22aa']).analyze()
  expect(results.violations).toEqual([])
})
```

## Coverage targets

Coverage is a floor, not a goal. We gate on V8 coverage via Vitest with thresholds tuned per layer of value. The query compiler and validation engine carry the strictest gates because a regression there corrupts every surface.

| Package / area                                                   | Line | Branch | Notes                                        |
| ---------------------------------------------------------------- | ---- | ------ | -------------------------------------------- |
| `@kernel/core` (operations, validation)                          | 90%  | 85%    | the hot path for every API                   |
| `@kernel/db` (query compiler, conformance harness)               | 90%  | 85%    | dialect bugs are silent and costly           |
| `@kernel/db-*` adapters                                          | 85%  | 75%    | driven by the shared conformance suite       |
| `@kernel/auth`, `@kernel/rest`, `@kernel/graphql`, `@kernel/rpc` | 85%  | 75%    | security-sensitive boundaries                |
| `@kernel/admin`, `@kernel/ui`                                    | 70%  | 60%    | covered mostly by Playwright, not line count |
| Repo-wide minimum                                                | 80%  | 70%    | CI hard gate                                 |

```ts
// vitest.config.ts (repo root, workspace mode)
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      thresholds: { lines: 80, branches: 70, functions: 80, statements: 80 },
    },
  },
})
```

Two rules keep the number honest. First, e2e coverage does not count toward the line gate — a Playwright run can paint coverage across the whole admin and mask untested logic, so we measure admin coverage from component/unit tests and treat e2e as behavioral assurance. Second, new code is held to a higher bar than the repo average via per-PR diff coverage (90% on changed lines), so the codebase ratchets upward instead of coasting on legacy.

## Open questions

- **Full adapter matrix on every PR vs. merge queue.** Running Postgres, MySQL, and MongoDB Testcontainers on every push is correct but slow. Current lean: Postgres + SQLite per-push, full matrix on the merge queue. Revisit if PR-only adapter regressions slip through.
- **MongoDB transaction parity.** The conformance suite assumes transactional rollback. Single-node Mongo needs a replica set for transactions; deciding whether to require a replica-set container in CI or to mark a small set of transaction tests as Mongo-conditional.
- **Cloud multi-tenant e2e.** Whether `@kernel/cloud` tenant isolation gets its own Playwright project or rides on the self-host admin suite with a tenant-scoped fixture.
- **Visual regression.** Playwright snapshot diffing for the admin is attractive but flaky across rendering environments; undecided whether to gate on it or run it advisory-only.
