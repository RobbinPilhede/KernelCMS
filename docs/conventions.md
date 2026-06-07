# Conventions & defaults

The small, non-obvious rules that KernelCMS assumes. Everything here is a default
or a naming convention — none of it requires extra configuration, but knowing it
saves time.

## Config files are `.ts`, loaded with type stripping

`kernel.config.ts` is imported directly by the CLI and by your app. On modern Node
(23.6+) TypeScript types are stripped automatically; on 22.6–23.5 you need
`--experimental-strip-types`. Type stripping **erases** type syntax rather than
compiling it, so the config must use only erasable TypeScript:

- No `enum` — use `as const` objects or union types.
- No `namespace`/`module` with runtime members.
- No constructor parameter properties (`constructor(private x: T)`).
- Use `import type { … }` / `export type { … }` for type-only imports.

`defineConfig(...)` is an identity helper — it adds full type inference and
nothing else. Export the config as the **default export** (or a named `config`
export); the CLI looks for `default` first, then `config`.

**Importing the config from a TS/Next app.** Node runs `kernel.config.ts` natively
and requires **`.ts` extensions on relative imports** (`import { x } from './x.ts'`).
TypeScript under `moduleResolution: "bundler"` (Next.js's default) rejects those
extensions unless you allow them — so set, in the tsconfig that covers your config
and its imports:

```jsonc
{ "compilerOptions": { "allowImportingTsExtensions": true, "noEmit": true } }
```

That keeps the files type-checked (don't `exclude` them — you'd lose checking).
`npx kernel init` scaffolds a config that already follows this.

## Environment variables

| Variable           | Used by                          | Notes                                                                                                             |
| ------------------ | -------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `KERNEL_SECRET`    | token signing                    | Set a long random value in production; doctor errors if unset.                                                    |
| `DATABASE_URL`     | Postgres adapter (and templates) | Scaffolded configs use Postgres when set, else local SQLite.                                                      |
| `KERNEL_API_KEY`   | `serve()` / `start`              | `Authorization: Bearer <key>` runs as a trusted system caller.                                                    |
| `KERNEL_CORS`      | `kernel start`                   | Comma-separated origin allow-list.                                                                                |
| `KERNEL_OPENAPI`   | `kernel start`                   | `true` re-enables the OpenAPI spec + Scalar docs (off in prod by default — they map every collection/field).      |
| `KERNEL_GRAPHQL`   | `kernel start`                   | `true` re-enables the GraphQL endpoint (off in prod by default — unused, unbounded attack surface for most apps). |
| `KERNEL_LOG_LEVEL` | logger                           | `debug` \| `info` \| `warn` \| `error` (default `info`).                                                          |
| `PORT`             | `dev` / `start`                  | Default `3000`. Overridable with `--port`.                                                                        |
| `NODE_ENV`         | doctor                           | `production` escalates several warnings to errors.                                                                |

A project `.env` is loaded automatically by the CLI before the config is imported.

## CLI flags

- `--config <path>` — path to the config (default `./kernel.config.ts`). Every
  data command accepts it.
- `--port <number>` — port for `dev`/`start` (default `$PORT` or `3000`).
- `--out <path>` — output file for `generate:types` / `generate:module`, or the
  snapshot path for `migrate:snapshot` / `migrate:status`.

## Access is deny-by-default

A collection with no `access` rules denies everything (the admin/doctor flags this
with `no-access`). Declare what is public explicitly:

```ts
access: {
  read: () => true
} // public reads
access: {
  read: ({ req }) => Boolean(req.user)
} // authenticated reads
```

Field-level `access` rules layer on top. A field with no rule inherits the
collection decision — see the field-access note in the README's security section.

### `overrideAccess`

Every Local API operation accepts `overrideAccess: true`, which **bypasses all
access checks** and runs as a trusted system caller (it also lets you set
server-managed auth fields directly). Use it in seeds, migrations, jobs, and
trusted server code — never with untrusted input. Over HTTP, the equivalent is the
`apiKey` bearer token.

## Drafts, publish, and the default read view

When a collection sets `versions: { drafts: true }`:

- New and edited documents are **drafts** by default; a `_status` column tracks
  `draft` / `published`.
- `find()` returns **published documents only** unless you pass `draft: true`
  (the admin always requests drafts).
- Promote with `kernel.publish({ collection, id })` and revert with
  `kernel.unpublish(...)`. Pass `publishAt` to schedule a future publish — the doc
  stays a draft until then, and `kernel.processScheduledPublishes()` (drive it
  from a cron) flips it.

## Stored vs. virtual computed fields

A field with a `compute` function comes in two flavours:

- `virtual: true` → derived on every **read**, never stored, **not** sortable or
  filterable.
- `compute` without `virtual` → a **stored** computed field: derived at write time,
  persisted to a real column, so it **is** sortable/filterable. The computed value
  always overrides client input.

Both render read-only in the admin. Reach for stored when you need to order or
filter by the derived value (e.g. a numeric sort key from a date).

## List ordering: `admin.defaultSort`

Set a collection's default ordering (used by the list view and by `find()` calls
that pass no `sort`):

```ts
admin: {
  defaultSort: '-createdAt'
} // newest first; '-' = desc, comma-separated for tie-breakers
```

Precedence: an explicit `sort` argument → `admin.defaultSort` → newest-first by
`createdAt` (or `id` when timestamps are off).

## Live preview

`admin.livePreview` controls the editor preview pane per collection:

- omitted → built-in preview renderer.
- `{ url: 'https://your-frontend/preview' }` → your frontend, iframed; the admin
  posts the live document to it via `postMessage`.
- `false` → disable the preview pane entirely for that collection.

Auth and upload collections never show a preview pane.

## Uploads & storage

`localStorage` (disk) is the default durable adapter:

```ts
storage: localStorage({ rootDir: './.uploads', servePath: '/files' })
// rootDir   — directory on disk (required)
// servePath — URL base keys resolve against (default '/files')
```

`memoryStorage()` keeps bytes in a `Map` — great for tests/previews, **lost on
restart and not shared across nodes**. Doctor warns when an upload collection is
backed by memory storage (and errors in production). For production use
`localStorage`, S3, or R2.

## Join (reverse-relationship) fields

A `join` field is a **virtual reverse relationship** — nothing is stored; it's
resolved at read time by querying the related collection for documents that point
back at the current one:

```ts
// on `authors`: list the author's posts (posts.author → this author)
{ type: 'join', name: 'posts', collection: 'posts', on: 'author', limit: 100 }
```

Population semantics:

- **When:** populated only when the request `depth` is `> 0` (REST: `?depth=1`).
  Each level decrements depth, so nested joins/relationships keep expanding while
  depth remains. At `depth: 0` the field is absent.
- **Order:** the related query runs with no explicit sort, so it follows the
  **related collection's `admin.defaultSort`**, falling back to newest-first by
  `createdAt` (or `id`). Set `admin.defaultSort` on the related collection to make
  join order deterministic.
- **Limit:** at most `limit` rows (default **100**).
- **Access:** related rows are fetched through the normal access-checked read path;
  if the caller can't read them, the field resolves to `[]` rather than erroring.

## The `seed` convention

Export a `seed` function alongside your config and run `kernel seed`:

```ts
export const seed = async (kernel: Kernel) => {
  await kernel.create({ collection: 'users', data: { email, password }, overrideAccess: true })
}
export default defineConfig({
  /* … */
})
```

`kernel seed` (and `kernel import`) auto-migrate first, so a fresh database is
ready before the seed runs.

## The SEO plugin adds **top-level** fields

`seoPlugin({ collections: ['posts'] })` appends `meta_title` (text, ≤70) and
`meta_description` (textarea) as **top-level fields** on each named collection —
grouped under an "SEO" admin tab, but stored as their own columns (so you can
query and sort on them), not nested under a `meta` group. With
`generateTitleFrom`/`generateDescriptionFrom` it fills blanks from another field
on write. It won't double-add a field you already declared.

## Server handler options (`HandlerOptions`)

Passed to `createRequestHandler(kernel, options)` / `serve(kernel, options)`:

| Option       | Meaning                                                                                 |
| ------------ | --------------------------------------------------------------------------------------- |
| `apiKey`     | Bearer token that runs a request as a trusted system caller.                            |
| `getUser`    | Resolve the authenticated user from the request (sessions/JWT).                         |
| `cors`       | `true` reflects the request origin; an array allow-lists origins.                       |
| `admin`      | `true` mounts the admin at `/admin`; `{ path, scripts }` to customise / inject scripts. |
| `graphql`    | Expose `<api>/graphql` (POST).                                                          |
| `openapi`    | Serve `<api>/openapi` + a Scalar reference at `<api>/docs` (default `true`).            |
| `cookieAuth` | Issue the session as an `HttpOnly` cookie on login (default `true`).                    |
| `rateLimit`  | `{ enabled, windowMs, max, authMax, trustProxy, clientKey, store }` — see below.        |

`RequestHandler` (the return type of `createRequestHandler`) and the rate-limit
types/helpers (`RateLimitOptions`, `RateLimitStore`, `memoryRateLimitStore`) are
exported from `kernelcms/server`.

## Admin session & CSRF

By default (`cookieAuth: true`) login sets the session token in an **`HttpOnly`,
`SameSite=Lax`** cookie (`Secure` over HTTPS), so the admin never keeps it in
`localStorage` and an XSS cannot read it. The token is still returned in the login
response and **`Authorization: Bearer <token>` keeps working** for API clients and
scripts. CSRF is covered two ways: `SameSite=Lax` stops the cookie riding cross-site
on unsafe requests, and a **same-origin `Origin` check** rejects any cookie-authed
`POST`/`PUT`/`PATCH`/`DELETE` whose `Origin` doesn't match (Bearer callers are
exempt — their credential can't be sent cross-site). `POST <api>/<auth>/logout`
clears the cookie. For a cross-origin embedded admin, set `cors` to an explicit
origin allow-list so the browser sends the cookie.

## Migrations are additive

`kernel migrate` (and `serve`'s autoMigrate in `dev`) **only create tables and add
columns** — they never drop or retype, so you can't lose data by surprise.
Destructive changes (dropped/renamed/retyped columns) are reported by
`kernel migrate:status` (diffed against `kernel/schema-snapshot.json`) and by
`kernel migrate` itself when a snapshot exists, but must be applied by hand. Record
the current schema with `kernel migrate:snapshot` so future drift checks have a
baseline.

## `kernel doctor` checks config **and** connectivity

`kernel doctor` runs the static config checks (secrets, storage, relationships,
access, cache/search/webhook wiring) and then opens the database to confirm it is
actually reachable and queryable. It exits non-zero if either the config has
errors or the database is unreachable — handy as a deploy preflight.
