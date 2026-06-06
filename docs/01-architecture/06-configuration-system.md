# Configuration System

`kernel.config.ts` is the root of KernelCMS. It is a single, fully typed TypeScript module that declares your collections, globals, adapters, access rules, and admin behavior — and the rest of the system is derived from it. There is no separate schema language, no YAML, no admin database that drifts from your code. The config object is the contract: the REST and GraphQL schemas, the typed Local/RPC client, the Drizzle tables and migrations, and the admin UI are all projections of it. This document specifies the config schema, how typed config is authored with `satisfies`, how environment variables and secrets are handled, and how validation and defaults are resolved at boot.

## The config schema

A KernelCMS app is defined by a call to `defineConfig` from `@kernel/core`. The return value is a `KernelConfig` — a discriminated, deeply typed object whose shape is the source of truth for every other surface.

```ts
// kernel.config.ts
import { defineConfig } from '@kernel/core'
import { postgresAdapter } from '@kernel/db-postgres'
import { s3Storage } from '@kernel/storage'
import { Posts } from './collections/Posts'
import { Media } from './collections/Media'
import { SiteSettings } from './globals/SiteSettings'

export default defineConfig({
  serverURL: process.env.KERNEL_SERVER_URL,
  secret: process.env.KERNEL_SECRET,

  db: postgresAdapter({
    url: process.env.DATABASE_URL,
    schemaName: 'kernel',
  }),

  collections: [Posts, Media],
  globals: [SiteSettings],

  storage: s3Storage({
    bucket: process.env.S3_BUCKET,
    region: process.env.S3_REGION,
  }),

  admin: {
    user: 'users',
    meta: { titleSuffix: '· KernelCMS' },
    theme: 'system',
  },

  localization: {
    locales: ['en', 'da', 'ar'],
    defaultLocale: 'en',
    rtl: ['ar'],
  },

  typescript: { outputFile: './kernel-types.ts' },
})
```

The top-level keys form a small, stable surface. Everything else nests under collections and globals.

| Key                                         | Type                 | Purpose                                                                              |
| ------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------ |
| `serverURL`                                 | `string`             | Absolute origin for callbacks, CORS, preview, and CDN signing.                       |
| `secret`                                    | `string`             | Server-side signing key for sessions, tokens, and preview URLs.                      |
| `db`                                        | `Adapter`            | Database adapter — `@kernel/db-postgres` (default), `-sqlite`, `-mysql`, `-mongodb`. |
| `collections`                               | `Collection[]`       | Repeatable content types. See [Collections](../02-data-modeling/01-collections.md).  |
| `globals`                                   | `Global[]`           | Singletons such as settings and navigation.                                          |
| `storage`                                   | `StorageAdapter`     | Upload backend from `@kernel/storage`.                                               |
| `auth`, `email`, `search`, `cache`, `queue` | adapters             | Swappable infrastructure; each defaults to a sane local implementation.              |
| `admin`                                     | `AdminConfig`        | Admin panel behavior, theming, and component overrides.                              |
| `localization`                              | `LocalizationConfig` | Locales, default, and RTL set for field-level i18n.                                  |
| `plugins`                                   | `Plugin[]`           | `@kernel/plugin-sdk` plugins that mutate config before resolution.                   |
| `typescript`                                | `{ outputFile }`     | Where generated types are written.                                                   |

Payload bundles this kind of config too, but couples it tightly to Express and its own Mongo/Drizzle pairing. Sanity splits configuration between `sanity.config.ts` and a separate GROQ-driven schema runtime. Strapi spreads it across a `config/` directory of plugin files, a content-type JSON registry, and a database config — three places that can disagree. KernelCMS keeps one typed object and one resolution pass, so the admin, the API, and the database can never drift from each other.

### Collections and the field tree

A collection is itself a typed config node. Fields are an array of discriminated unions keyed by `type`, which is what makes downstream inference possible.

```ts
// collections/Posts.ts
import { defineCollection } from '@kernel/core'

export const Posts = defineCollection({
  slug: 'posts',
  admin: { useAsTitle: 'title', defaultColumns: ['title', 'status', 'updatedAt'] },
  access: {
    read: () => true,
    update: ({ req }) => Boolean(req.user),
  },
  versions: { drafts: true, autosave: { interval: 800 } },
  fields: [
    { name: 'title', type: 'text', required: true },
    { name: 'slug', type: 'text', unique: true, index: true },
    { name: 'body', type: 'richText' },
    { name: 'author', type: 'relationship', relationTo: 'users' },
    {
      type: 'tabs',
      tabs: [{ label: 'SEO', fields: [{ name: 'metaTitle', type: 'text' }] }],
    },
  ],
})
```

`defineCollection` exists so each collection carries its own inferred type and can live in its own file, but it is a thin identity helper — the heavy inference happens when the array is assembled into `KernelConfig`.

## Typed config with `satisfies`

The hard constraint is that the config must be _both_ exactly the `KernelConfig` shape _and_ preserve the literal types of your field names, slugs, and locales. A plain type annotation (`const config: KernelConfig = …`) widens `slug: 'posts'` to `string` and erases the literal field names, which destroys the inference that powers the typed client and generated types. `satisfies` is the mechanism that gives us both.

```ts
import { defineConfig, type KernelConfig } from '@kernel/core'

const config = {
  collections: [Posts, Media],
  globals: [SiteSettings],
  db: postgresAdapter({ url: process.env.DATABASE_URL }),
} satisfies KernelConfig

export default config
```

`defineConfig` wraps the same idea behind a function so callers do not have to import the type: its signature is `defineConfig<const T extends KernelConfig>(config: T): ResolvedConfig<T>`. The `const` type parameter keeps `'posts'`, `'en'`, and every field `name` as literals. From those literals, `@kernel/core` builds the type map that the rest of the stack consumes:

```
KernelConfig (literal-preserving)
        │
        ├─► CollectionMap          { posts: Post; media: Media; … }
        ├─► WhereInput<'posts'>    typed query language per collection
        ├─► generated kernel-types.ts
        └─► @kernel/client         typed RPC: kernel.collections.posts.find()
```

This is the line that separates KernelCMS from Payload's `GeneratedTypes` approach. Payload infers types by code-generating an interface file and then _re-importing_ it via module augmentation — types and runtime config are stitched together after the fact. KernelCMS derives the type map directly from the `satisfies`-checked object, so the editor shows `posts` as a known key before any codegen runs. Codegen (`kernel generate:types`) only persists those types to disk for non-TS consumers and faster cold builds; it is never the source of truth. Sanity, by contrast, types content through GROQ query result inference rather than the schema object, so a field rename does not surface as a config-level type error the way it does here.

## Env and secrets handling

Configuration reads from the environment, but raw `process.env` access is banned in app code beyond the config module. `process.env` values are `string | undefined`, unvalidated, and easy to typo. KernelCMS funnels every environment dependency through `@kernel/core`'s `env` helper, which validates and coerces at boot and produces a typed object.

```ts
import { env } from '@kernel/core'
import { z } from 'zod'

export const config = env({
  DATABASE_URL: z.string().url(),
  KERNEL_SECRET: z.string().min(32),
  S3_BUCKET: z.string(),
  S3_REGION: z.string().default('us-east-1'),
  PREVIEW_ENABLED: z.coerce.boolean().default(false),
})
// config.DATABASE_URL: string  (never undefined)
```

If a required variable is missing or malformed, the process refuses to start and prints a single grouped report of every offending key, not a stack trace from the first failure. This is deliberately stricter than Strapi, which reads env lazily through `env()` calls scattered across `config/*.js` and only fails when a given code path runs — meaning a bad `DATABASE_URL` can pass boot and surface as a runtime 500 hours later.

Secrets follow three rules, enforced by the loader:

- **Secrets never have literal defaults.** `secret`, database URLs, and adapter credentials must come from the environment. A hardcoded string in `kernel.config.ts` fails the config linter (`kernel doctor`) with an error, not a warning.
- **Secrets are server-only.** The config is split during the build: a `ClientConfig` projection — collections, fields, admin UI, labels — is serialized to the browser, while `secret`, adapter credentials, and any field marked `admin.hidden` plus server-only hooks stay in the server bundle. The boundary is enforced by a `@kernel/server` build step that throws if a value flagged `secret()` is reachable from the client graph.

```ts
db: postgresAdapter({
  url: secret(process.env.DATABASE_URL), // tainted: build fails if it reaches the client
}),
```

- **Secret sources are pluggable.** Beyond `process.env`, the `secrets` option accepts a provider so values can resolve from Vault, AWS Secrets Manager, or KernelCMS Cloud's managed secret store. Providers resolve asynchronously before the config is frozen.

```ts
import { vaultSecrets } from '@kernel/core/secrets'

export default defineConfig({
  secrets: vaultSecrets({ addr: env.VAULT_ADDR, path: 'kernel/prod' }),
  db: postgresAdapter({ url: secretRef('database/url') }),
})
```

On KernelCMS Cloud this provider is wired automatically, so the same `kernel.config.ts` runs self-hosted and managed with no edits — the portability the brief requires.

## Config validation and defaults

Config passes through a fixed pipeline before the server accepts a request. Each stage is total: it either produces a valid `ResolvedConfig` or aborts with actionable diagnostics.

```
load → apply plugins → merge defaults → validate → freeze → derive
```

**Plugins** run first. Each plugin in `plugins[]` receives the config and returns a new one — they can add collections, inject fields, or register hooks. They run in array order, and the result is fed to the next stage, so plugin output is validated exactly like hand-written config.

**Defaults** are merged structurally, not with a shallow spread. The defaults are opinionated and documented:

| Area                                | Default                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------ |
| `db`                                | none — required; the only adapter with no default.                                         |
| `auth`                              | `@kernel/auth` local strategy with session cookies (`Secure`, `HttpOnly`, `SameSite=Lax`). |
| `storage`                           | local filesystem under `./uploads`.                                                        |
| `email`, `search`, `cache`, `queue` | in-memory/no-op dev implementations; must be set for production.                           |
| `admin.theme`                       | `'system'`.                                                                                |
| `versions.autosave.interval`        | `800` ms when drafts are enabled.                                                          |
| field `access`                      | inherits collection `access`; collection inherits a deny-by-default for writes.            |

**Validation** runs structural and semantic checks that the type system cannot express at compile time: duplicate collection slugs, relationship `relationTo` targets that point at unknown collections, `defaultLocale` not present in `locales`, field names colliding with reserved columns (`id`, `createdAt`), and `useAsTitle` referencing a non-existent field. Errors are collected and reported together, each with the JSON path into the config:

```
✗ collections[2].fields[4].relationTo: "athors" is not a known collection. Did you mean "authors"?
✗ localization.defaultLocale: "de" is not in locales [en, da, ar].
```

**Freeze** deep-freezes the resolved object so no hook or plugin mutates config at request time — config is immutable for the process lifetime, which keeps the derived schemas and the running server in lockstep.

**Derivation** then builds the Drizzle schema, the REST/GraphQL types, and the typed client from the frozen config. Because every prior stage is total, derivation never has to handle a partial or invalid config.

The same pipeline is exposed programmatically as `resolveConfig(config)` from `@kernel/core`, so tests can assert on a resolved config and `kernel doctor` can run the full validation without booting a server.

## Open questions

- **Async `defineConfig`.** Secret providers and remote adapter discovery are async, but `export default` is evaluated synchronously by most tooling. Do we standardize on an async config factory (`export default defineConfig(async () => …)`), or keep config synchronous and resolve secrets in a separate pre-boot phase?
- **Per-environment config composition.** Should we ship a first-class `extends`/overlay mechanism (base + `kernel.config.prod.ts`), or steer everyone toward branching inside one file via the typed `env` object?
- **Plugin ordering guarantees.** Array order is simple but brittle when plugins depend on each other. Do we add explicit `before`/`after` dependency declarations to the plugin contract, or keep ordering purely positional?
