# Testing Utilities & Harness

KernelCMS ships a first-party test harness in `@kernel/core` and `@kernel/client` so that integration tests against a real schema run in milliseconds, not minutes. The harness boots a complete KernelCMS instance — collections, globals, access control, hooks, validation, the operation core — backed by an in-memory adapter, exposes a fully typed test client that calls the same Local API your app uses, ships auth helpers for impersonating users and roles, and gives you snapshot capture plus deterministic database reset. The goal is parity: the code path a test exercises is the code path production runs, minus the network and the durable disk.

## Why a first-party harness

Payload tests typically require a running MongoDB or Postgres and a real HTTP server; the docs lean on `payload.init()` against a live database and `supertest` against the running app. Strapi's testing story is famously heavy — spin up the full server, hit it over HTTP, tear it down. Sanity pushes you toward mocking its hosted dataset API or testing GROQ in isolation, because the content lake is a remote service you do not run locally.

KernelCMS treats tests as a supported runtime, not an afterthought. Because every infrastructure concern is a swappable adapter (see Adapters Overview), the database is just another adapter you can substitute. The harness swaps the configured database for `@kernel/db/memory`, keeps everything else identical, and hands you a typed client. No HTTP, no Docker, no test container — unless you specifically want them.

```
┌──────────────────────────────────────────────┐
│  your test                                     │
│    ↓ typed test client (same Local API)        │
│  operation core (access, hooks, validation)    │  ← identical to prod
│    ↓ Adapter contract                          │
│  in-memory adapter  ←─ swapped in by harness   │
└──────────────────────────────────────────────┘
```

## The in-memory adapter

`@kernel/db/memory` is a full implementation of the same `Adapter` contract that `@kernel/db-postgres`, `@kernel/db-sqlite`, `@kernel/db-mysql`, and `@kernel/db-mongodb` implement (see [The Adapter Contract](../01-architecture/adr/0002-drizzle-and-pluggable-db.md)). It is not a mock — it executes the shared query language (`where` / `sort` / pagination / `depth`) against JavaScript data structures, enforces unique constraints, resolves relationships, applies localization, and stores draft and published versions. If a query works against the in-memory adapter, it works against Postgres.

Use `createTestKernel` to boot an instance. It accepts your real `kernel.config.ts` and overrides only the database:

```ts
import { createTestKernel } from '@kernel/core/testing'
import config from '../kernel.config'

const kernel = await createTestKernel({
  config,
  // db defaults to '@kernel/db/memory'; override per test if needed
  seed: async ({ db }) => {
    await db.create({ collection: 'users', data: { email: 'a@b.co', role: 'editor' } })
  },
})
```

What the in-memory adapter guarantees, and where it deliberately diverges:

| Behavior                                | In-memory adapter | Notes                                                      |
| --------------------------------------- | ----------------- | ---------------------------------------------------------- |
| `where` / `sort` / pagination / `depth` | Full parity       | Same query compiler as SQL adapters                        |
| Unique + required constraints           | Enforced          | Throws `ValidationError`, like production                  |
| Relationships + `depth` joins           | Full parity       | Resolved in-process, no N+1 cost                           |
| Localized fields                        | Full parity       | Per-locale storage and fallback                            |
| Drafts, publish, version history        | Full parity       | Autosave versions retained in memory                       |
| Transactions                            | Emulated          | Synchronous; rollback supported, no isolation levels       |
| Migrations                              | Skipped           | Schema built directly from config, no diff                 |
| Raw SQL escape hatch                    | Unsupported       | Throws — tests using `db.raw()` must target a real adapter |

Two adapters cover real cases the SQL path cannot: `@kernel/db-postgres` against a throwaway Postgres for migration and raw-SQL tests, and `@kernel/db-mongodb/memory` when you specifically test document-oriented behavior. The harness keeps the swap to one line:

```ts
const kernel = await createTestKernel({
  config,
  db: { adapter: '@kernel/db-postgres', url: process.env.TEST_DATABASE_URL },
})
```

Run the bulk of your suite on the in-memory adapter for speed, and a small contract-test tier against a real Postgres in CI to catch adapter-specific drift.

## The test client

`createTestClient` returns a typed surface over the Local API — the same operation core described in [The Local API](../05-api/03-typed-rpc-and-local-api.md), called in-process. Types are inferred from your config, so `client.find('posts')` knows the shape of a `Post` without a code-generation step.

```ts
import { createTestClient } from '@kernel/client/testing'

const client = createTestClient(kernel)

const created = await client.create('posts', {
  data: { title: 'Hello', status: 'draft' },
})
//    ^? { id: string; title: string; status: 'draft' | 'published'; ... }

const page = await client.find('posts', {
  where: { status: { equals: 'draft' } },
  sort: '-createdAt',
  limit: 10,
  depth: 1,
})
```

The test client mirrors every operation: `find`, `findByID`, `create`, `update`, `delete`, `count`, plus `findGlobal` / `updateGlobal` for singletons. Because it routes through the operation core, access control, hooks, and validation all fire. That is the point — a test that creates a document with an `editor` user proves your `access.create` rule, your `beforeChange` hook, and your field validators together.

For surface-level coverage you can also exercise REST, GraphQL, and RPC without a network. The harness builds in-memory request handlers:

```ts
// REST handler, no HTTP server
const res = await kernel.rest.fetch('/api/posts?where[status][equals]=draft')
expect(res.status).toBe(200)

// GraphQL, in-process
const { data } = await kernel.graphql(`query { Posts { docs { id title } } }`)

// RPC server function (TanStack Start), called directly
const result = await kernel.rpc.posts.find({ where: { status: { equals: 'draft' } } })
```

This lets one suite assert that all four surfaces return consistent results from the same query — something that is awkward in Payload (REST and GraphQL tested separately) and effectively impossible in Sanity without hitting the live API.

## Auth helpers

Most CMS bugs hide in authorization. KernelCMS evaluates access at the operation, document, and field level, so the harness makes it trivial to run any operation _as_ a given user without minting real sessions or tokens.

```ts
import { asUser, asRole, asAnonymous } from '@kernel/core/testing'

// impersonate a concrete user document
const editorClient = client.with(asUser(editor))

// impersonate a role without creating a user
const adminClient = client.with(asRole('admin'))

// the unauthenticated public surface
const publicClient = client.with(asAnonymous())

await expect(publicClient.delete('posts', { id: created.id })).rejects.toThrow(ForbiddenError)
```

`asUser` attaches a real user document so document- and field-level rules that read `req.user` behave correctly. `asRole` is a shortcut for the common case where only the role matters. Both produce a fully populated `req` (user, locale, transaction) identical to what a real request builds — there is no parallel "test mode" branch in the access logic.

A focused helper, `expectAccess`, turns the operation/role matrix into a table-driven assertion:

```ts
import { expectAccess } from '@kernel/core/testing'

await expectAccess(kernel, 'posts', {
  anonymous: { read: true, create: false, update: false, delete: false },
  editor: { read: true, create: true, update: 'own', delete: false },
  admin: { read: true, create: true, update: true, delete: true },
})
```

`'own'` asserts resource-level authorization — the editor may update documents they own but not others. This single table replaces dozens of hand-written cases and doubles as living documentation of your authorization model. Field-level access is covered the same way with `expectFieldAccess`, which checks that restricted fields are stripped from reads and rejected on writes per role.

## Snapshot and database reset

Two utilities keep tests deterministic and fast: snapshot/restore for state, and reset for isolation.

### Snapshots

`kernel.snapshot()` serializes the entire in-memory database — every collection, global, version, and locale — into a portable value. `kernel.restore(snap)` replaces current state with it. This is far cheaper than re-running a seed, and it composes well with the AAA pattern: seed once, snapshot, and restore between tests instead of rebuilding.

```ts
const baseline = await kernel.snapshot()

beforeEach(async () => {
  await kernel.restore(baseline) // O(copy), not O(re-seed)
})
```

Snapshots also serve content assertions. Capture a snapshot after a workflow and diff it against a committed fixture to catch unintended schema or data drift — distinct from UI snapshot testing, this is _data_ snapshotting tied to your typed schema.

```ts
expect(await kernel.snapshot('posts')).toMatchKernelSnapshot('posts-after-publish')
```

### Reset

`kernel.reset()` clears all data and returns the instance to its post-`createTestKernel` state, optionally re-running the seed. Use `reset` for hard isolation (no shared state at all) and `restore` when re-seeding is expensive.

| Strategy                        | Use when                             | Cost                     |
| ------------------------------- | ------------------------------------ | ------------------------ |
| `restore(baseline)`             | Tests share a seeded fixture         | Lowest — structural copy |
| `reset({ seed: true })`         | Tests need the original seed, fresh  | Medium — replays seed    |
| `reset()`                       | Test builds its own state from empty | Lowest — clears only     |
| New `createTestKernel` per test | Total isolation, separate config     | Highest — full boot      |

For real-database tiers, the harness wraps each test in a transaction and rolls back on teardown — no truncation, no cross-test bleed. Against the in-memory adapter, `reset` is effectively free because there is no disk.

```ts
afterEach(async () => {
  await kernel.reset() // or rely on transaction rollback for the Postgres tier
})

afterAll(async () => {
  await kernel.destroy() // release adapters, timers, queue workers
})
```

Always call `kernel.destroy()` in `afterAll`. The harness starts real subsystems — cache, queue, and search adapters in their in-memory variants — and `destroy` shuts them down so the test runner exits cleanly instead of hanging on open handles.

## Putting it together

A representative integration test combines all four:

```ts
import { createTestKernel } from '@kernel/core/testing'
import { createTestClient, asRole } from '@kernel/client/testing'
import config from '../kernel.config'

let kernel: TestKernel
let baseline: Snapshot

beforeAll(async () => {
  kernel = await createTestKernel({ config, seed: seedFixtures })
  baseline = await kernel.snapshot()
})
afterEach(() => kernel.restore(baseline))
afterAll(() => kernel.destroy())

test('editor publishes a draft, public reads it', async () => {
  const editor = createTestClient(kernel).with(asRole('editor'))
  const draft = await editor.create('posts', { data: { title: 'X', status: 'draft' } })
  const published = await editor.update('posts', { id: draft.id, data: { status: 'published' } })

  const res = await kernel.rest.fetch('/api/posts?where[status][equals]=published')
  expect(await res.json()).toMatchObject({ docs: [{ id: published.id }] })
})
```

This is the harness's whole thesis: the same config, the same operation core, the same query language, the same access rules — only the adapter and the network are removed.

## Open questions

- **Concurrency semantics.** The in-memory adapter emulates transactions synchronously and does not model isolation levels. We have not decided whether to ship an opt-in "strict" mode that simulates serialization conflicts, or to route all concurrency tests to the Postgres tier.
- **Snapshot format stability.** Whether `toMatchKernelSnapshot` fixtures are versioned and auto-migrated across schema changes, or treated as throwaway and regenerated, is undecided. Auto-migration risks masking real drift.
- **Time control.** A built-in clock for autosave-version and `createdAt`/`updatedAt` determinism is planned but the API (injected `now()` vs. global fake timers) is not finalized.
