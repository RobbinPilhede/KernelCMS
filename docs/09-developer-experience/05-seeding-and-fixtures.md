# Seeding & Fixtures

KernelCMS treats seed data as code, not as a database dump you have to keep in sync by hand. The `@kernel/core` seed runtime gives you a typed `seed()` operation that runs through the same access-control, validation, and hook pipeline as the Local API, a fixture layer that builds reproducible documents from factories, and reset/snapshot primitives that make integration tests fast and deterministic. Payload exposes a bare `onInit` hook and tells you to write your own loop; Strapi ships `strapi.entityService` calls in a bootstrap file; Sanity hands you `sanity dataset import` against NDJSON. KernelCMS unifies all three concerns — population, isolation, and determinism — behind one contract that knows your schema.

## Why seeding belongs in the core

Seed data has three jobs that pull in different directions. Local development wants a believable dataset you can click through. CI wants the smallest possible dataset that exercises a code path, created and torn down in milliseconds. Demos want polished, curated content. A seed system that only does one of these forces you to maintain three parallel stacks of throwaway scripts.

KernelCMS routes all three through the operation core, so a seeded document is indistinguishable from one created in the admin panel. That matters: if your seed bypasses hooks and validation (as a raw SQL insert or `db.insert()` would), you get data that the real API would have rejected, and your tests pass against rows that can never exist in production.

```
                    ┌──────────────────────────────┐
  seed.ts ────────▶ │      @kernel/core seed        │
  fixtures/  ──────▶ │  ┌────────────────────────┐  │
  factories  ──────▶ │  │ validate → access → hooks │ │ ───▶ Adapter (Drizzle / Mongo)
                    │  └────────────────────────┘  │
  CLI: kernel seed   └──────────────────────────────┘
```

## The seed API

A seed is a default-exported async function typed against your config. It receives a `payload`-free, fully inferred context: a `local` client (the in-process Local API), the resolved config, a deterministic `faker` instance, and a `logger`. You never import a database handle here — you talk to collections by name, and the field types you pass are checked against the schema.

```typescript
// kernel.config.ts
import { defineConfig } from '@kernel/core'

export default defineConfig({
  // ...collections, globals, db adapter...
  seed: {
    // default seed run by `kernel seed`
    default: './seed/index.ts',
    // named seeds for specific scenarios
    scenarios: {
      'empty-tenant': './seed/empty-tenant.ts',
      'load-test': './seed/load-test.ts',
    },
    // fixed RNG seed so faker output is identical across runs
    randomSeed: 'kernel-dev-1',
  },
})
```

```typescript
// seed/index.ts
import { defineSeed } from '@kernel/core'

export default defineSeed(async ({ local, faker, logger }) => {
  const author = await local.create({
    collection: 'users',
    data: {
      email: 'editor@example.com',
      name: faker.person.fullName(),
      role: 'editor',
    },
    // seeds run as the system actor by default; opt into real access checks per call
    overrideAccess: true,
  })

  for (let i = 0; i < 25; i++) {
    await local.create({
      collection: 'posts',
      data: {
        title: faker.lorem.sentence(),
        author: author.id,
        status: i % 3 === 0 ? 'draft' : 'published',
      },
    })
  }

  logger.info('seeded 1 user, 25 posts')
})
```

Run it with the CLI:

```bash
kernel seed                      # runs seed.default
kernel seed --scenario load-test # runs a named scenario
kernel seed --reset              # wipe, then seed (see Reset below)
kernel seed --dry-run            # validate + log, no writes
```

Because seeds go through the operation core, you get the full query language ([`where` / `sort` / `depth`](../05-api/04-query-filtering-sorting-pagination.md)), localization, and draft/publish handling for free. To seed a localized field, pass `locale`; to seed a draft, pass `draft: true`. The same `local.create`, `local.update`, and `local.upsert` you'd call from a server function are what populate the database.

### Idempotency and upsert

Re-running a seed should not create duplicates. Use `local.upsert` with a natural key so the seed converges to the same state regardless of how many times it runs — important for `onInit`-style boot seeding in long-lived dev containers.

```typescript
await local.upsert({
  collection: 'globals-settings',
  where: { key: { equals: 'site' } },
  data: { siteName: 'Acme', defaultLocale: 'en' },
})
```

## Fixtures

A **fixture** is a named, reusable, serializable description of one document or a small graph of related documents. Where a seed is a procedure, a fixture is data. Fixtures live in `fixtures/` and are loaded by name, which makes them ideal for tests: a test declares exactly which fixtures it needs, and nothing else exists in the database.

```typescript
// fixtures/posts.ts
import { defineFixture } from '@kernel/core'

export const publishedPost = defineFixture('posts', {
  title: 'Hello World',
  slug: 'hello-world',
  status: 'published',
  // references resolve to other fixtures by handle, in dependency order
  author: ref('users.editor'),
})

export const draftPost = defineFixture('posts', {
  title: 'Work in progress',
  slug: 'wip',
  status: 'draft',
  author: ref('users.editor'),
})
```

The loader topologically sorts fixtures by their `ref()` edges, so you never hand-order inserts. This is the sharp edge Strapi leaves exposed — its fixture/bootstrap scripts make you create the author before the post manually and track the returned IDs yourself.

| Concern     | Seed                      | Fixture                        |
| ----------- | ------------------------- | ------------------------------ |
| Shape       | imperative function       | declarative data               |
| Primary use | dev DB, demos, load tests | tests, deterministic graphs    |
| References  | you wire IDs              | `ref()` resolved automatically |
| Volume      | hundreds–millions         | a handful per test             |
| Determinism | RNG-seeded faker          | fully static                   |

```typescript
// in a test
import { loadFixtures } from '@kernel/core/testing'

const { publishedPost, draftPost } = await loadFixtures(['users.editor', 'posts.publishedPost', 'posts.draftPost'])
```

## Factory helpers

Fixtures are static; factories are parameterized fixture generators. A factory produces valid documents with sensible defaults and lets each call override only the fields under test. This is the pattern our testing rules mandate — factory functions for test data, never inline object literals copied across files.

```typescript
// factories/post.ts
import { defineFactory } from '@kernel/core'
import { userFactory } from './user'

export const postFactory = defineFactory('posts', ({ faker, sequence }) => ({
  title: faker.lorem.sentence(),
  slug: faker.helpers.slugify(faker.lorem.words(3)) + '-' + sequence(),
  status: 'published' as const,
  author: userFactory, // nested factories build the graph
}))
```

```typescript
// usage — override only what the test cares about
const post = await postFactory.build({ status: 'draft' })

// build many; sequence() guarantees unique slugs
const posts = await postFactory.buildMany(50, { author: existingUser.id })

// build the object without persisting (for unit tests on pure logic)
const draft = postFactory.make({ title: 'X' })
```

`build` persists through the Local API (validation and hooks run); `make` returns a plain typed object with no I/O. `sequence()` is per-factory and reset between tests, which kills the "unique constraint violated on the second test" class of flake. Faker is seeded from `seed.randomSeed`, so `faker.person.fullName()` returns the same name on every CI run — no snapshot churn.

Factories compose: passing `userFactory` as the `author` builds and persists a user first, then links it. Pass an existing ID to skip creation. This is closer to Ruby's FactoryBot or Laravel factories than anything Payload, Sanity, or Strapi ships natively.

## Reset and snapshot

Deterministic tests need a clean database per test or per file. KernelCMS exposes two strategies through `@kernel/core/testing`, both implemented per Adapter so they're as fast as the backend allows.

**Reset** truncates all collection and version tables (and document collections, for MongoDB) and re-runs migrations if the schema drifted. **Snapshot** captures the current state once and restores it cheaply — far faster than re-seeding when a fixture graph is expensive to build.

```
  beforeAll:  await snapshot.capture('baseline')   ── seed once ──▶ [snapshot]
                                                                       │
  beforeEach: await snapshot.restore('baseline')  ◀── instant ────────┘
  afterAll:   await snapshot.drop('baseline')
```

```typescript
import { reset, snapshot } from '@kernel/core/testing'

beforeAll(async () => {
  await reset() // clean slate
  await loadFixtures(['users.editor']) // expensive shared setup
  await snapshot.capture('baseline') // freeze it
})

beforeEach(async () => {
  await snapshot.restore('baseline') // roll back to frozen state
})
```

The Adapter contract requires three methods so every backend behaves identically:

| Method               | Postgres / MySQL                        | SQLite / libSQL                         | MongoDB                         |
| -------------------- | --------------------------------------- | --------------------------------------- | ------------------------------- |
| `reset()`            | `TRUNCATE ... RESTART IDENTITY CASCADE` | `DELETE FROM` + reset `sqlite_sequence` | `deleteMany({})` per collection |
| `snapshot.capture()` | `pg_dump` to temp / template DB         | file copy of the `.db`                  | `mongodump` / collection clone  |
| `snapshot.restore()` | restore from template                   | swap file back                          | `mongorestore` / clone back     |

For the common SQLite-in-memory test setup, `snapshot.restore` is a buffer copy and runs in microseconds — the reason we default the test adapter to `@kernel/db-sqlite` with `:memory:`. Postgres integration suites use the template-database trick (`CREATE DATABASE ... TEMPLATE baseline`) so restore is a metadata operation, not a re-import.

Sanity has no equivalent: its dataset import/export is the only primitive, so test isolation means spinning up disposable datasets over the network. Payload leans on your own `mongodb-memory-server` plumbing. KernelCMS makes reset and snapshot first-class and adapter-aware.

## Seeding uploads and rich text

Two field types need special handling. For `upload` fields, factories accept a local file path and route it through the configured `@kernel/storage` adapter so the file lands wherever real uploads go (and gets the same image-resize pipeline). For `richText`, pass the editor's JSON AST directly, or use the `richText()` helper to build it from Markdown so fixtures stay readable.

```typescript
export const heroPost = defineFixture('posts', {
  title: 'Launch',
  cover: upload('./fixtures/assets/hero.jpg'),
  body: richText('# Launch\n\nWe shipped **KernelCMS**.'),
})
```

## Open questions

- **Snapshot format portability.** Should `snapshot.capture` produce a portable, cross-adapter artifact (so a Postgres snapshot can restore into SQLite for a quick local run), or stay native per adapter for speed? Leaning native, with an optional `--portable` flag that serializes through the Local API instead of the DB layer.
- **Faker vs. a pinned generator.** We default to a seeded faker, but faker's output can change across major versions and silently break snapshot tests. Consider vendoring a frozen generator or pinning the faker version in `@kernel/core` and re-exporting it.
- **Production seeding guardrails.** `kernel seed --reset` against a production `DATABASE_URL` is catastrophic. The plan is a `KERNEL_ENV !== 'production'` gate plus a required `--force-production` flag, but the exact env-detection contract for KernelCMS Cloud tenants is still open.
