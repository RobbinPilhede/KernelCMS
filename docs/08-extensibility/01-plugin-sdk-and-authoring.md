# Plugin SDK & Authoring

Plugins are how KernelCMS grows without forking the core. A plugin is a typed function that receives the resolved config and returns a modified config plus any servers, routes, admin views, fields, or hooks it wants to register. The `@kernel/plugin-sdk` package gives you the builder, the typed context, and the test harness to do this safely. This document covers the plugin API surface, the lifecycle a plugin moves through, how to test plugins against a real adapter, and how to publish them under semver without breaking downstream installs.

A KernelCMS plugin is just code that runs during config resolution and (optionally) at runtime — there is no separate manifest format, no JSON schema to satisfy, and no sandboxed runtime to fight. That is a deliberate departure from Strapi, where plugins are directory-structured packages discovered by convention and wired through `strapi-server.js` / `strapi-admin.js` entry points. It is closer to Payload's plugin signature (`(config) => config`), but where Payload plugins are largely an init-time config transform, KernelCMS plugins are first-class participants in the request lifecycle, the admin bundle, and the type system.

## The plugin API

A plugin is authored with `definePlugin` from `@kernel/plugin-sdk`. It returns a `KernelPlugin` — a named, versioned unit with a `setup` function that runs during config resolution.

```ts
// @acme/kernel-plugin-audit/src/index.ts
import { definePlugin } from '@kernel/plugin-sdk'
import type { CollectionConfig } from '@kernel/core'

export interface AuditOptions {
  /** Collections to record an immutable audit trail for. */
  collections: string[]
  /** Where to persist the trail. Defaults to the app's primary db adapter. */
  storage?: 'db' | 'queue'
}

export const auditPlugin = definePlugin<AuditOptions>((options) => ({
  name: '@acme/kernel-plugin-audit',
  version: '1.4.0',
  // Declared so the host can warn on incompatible cores before setup runs.
  kernelVersion: '^1.0.0',
  setup(ctx) {
    for (const slug of options.collections) {
      ctx.extendCollection(
        slug,
        (collection): CollectionConfig => ({
          ...collection,
          hooks: {
            ...collection.hooks,
            afterChange: [
              ...(collection.hooks?.afterChange ?? []),
              async ({ doc, previousDoc, req, operation }) => {
                await ctx.services.db.create('_audit_log', {
                  collection: slug,
                  operation,
                  actor: req.user?.id ?? null,
                  before: previousDoc ?? null,
                  after: doc,
                  at: new Date(),
                })
                return doc
              },
            ],
          },
        }),
      )
    }

    ctx.addCollection({
      slug: '_audit_log',
      access: { read: ({ req }) => req.user?.role === 'admin', create: () => false },
      fields: [
        { name: 'collection', type: 'text' },
        { name: 'operation', type: 'select', options: ['create', 'update', 'delete'] },
        { name: 'actor', type: 'text' },
        { name: 'before', type: 'json' },
        { name: 'after', type: 'json' },
        { name: 'at', type: 'date' },
      ],
    })
  },
}))
```

Wiring it into an app is one line in `kernel.config.ts`:

```ts
import { defineConfig } from '@kernel/core'
import { postgresAdapter } from '@kernel/db-postgres'
import { auditPlugin } from '@acme/kernel-plugin-audit'

export default defineConfig({
  db: postgresAdapter({ url: process.env.DATABASE_URL! }),
  plugins: [auditPlugin({ collections: ['posts', 'orders'] })],
  collections: [
    /* ... */
  ],
})
```

### The setup context

The `ctx` object passed to `setup` is the entire extension surface. It is strongly typed against the resolved config, so `ctx.extendCollection("posts", ...)` is type-checked against the actual `posts` shape — there is no stringly-typed registry to get wrong at runtime.

| Method                                         | Purpose                                                                       |
| ---------------------------------------------- | ----------------------------------------------------------------------------- |
| `ctx.addCollection(config)`                    | Register a new collection.                                                    |
| `ctx.extendCollection(slug, fn)`               | Transform an existing collection (fields, hooks, access).                     |
| `ctx.addGlobal(config)` / `ctx.extendGlobal`   | Same for globals (singletons).                                                |
| `ctx.addField(type, definition)`               | Register a custom field type usable in any collection.                        |
| `ctx.addEndpoint({ method, path, handler })`   | Mount a REST route on the API host.                                           |
| `ctx.addServerFn(name, fn)`                    | Expose a typed RPC server function via TanStack Start.                        |
| `ctx.admin.addView({ path, component })`       | Register a TanStack Router admin route.                                       |
| `ctx.admin.addNavItem(item)`                   | Add an entry to the admin nav / command palette.                              |
| `ctx.admin.addFieldComponent(type, component)` | Provide the React editor for a custom field.                                  |
| `ctx.hooks.on(event, handler)`                 | Subscribe to global lifecycle events.                                         |
| `ctx.services`                                 | Access `db`, `storage`, `auth`, `email`, `cache`, `queue`, `search` adapters. |
| `ctx.logger`                                   | Namespaced logger scoped to the plugin.                                       |

`ctx.services` is the key reason plugins do not hard-wire infrastructure: a plugin asks for `ctx.services.queue` and receives whatever adapter the app configured. Write an audit plugin once and it works on Postgres or MongoDB, with BullMQ or SQS, because the plugin never names a concrete backend. Contrast Sanity, where plugins target the hosted Content Lake and cannot be lifted onto self-hosted storage; KernelCMS plugins are adapter-agnostic by construction. See Adapters for the contract.

### Admin and server split

Admin extensions (`ctx.admin.*`) register React components and routes; server extensions (`ctx.addEndpoint`, hooks) run on the API host. A single plugin can do both, and the SDK keeps them in separate import paths so the admin bundle never pulls server-only code. Strapi enforces this with two physical files; KernelCMS does it with conditional registration plus tree-shaking, so you keep one cohesive module while the bundler drops what the client does not need.

```ts
// Admin code is registered behind ctx.admin and only included in the admin build.
ctx.admin.addView({
  path: '/audit',
  component: () => import('./views/AuditLog'), // lazy, code-split via TanStack Router
})
```

## The plugin lifecycle

A plugin moves through resolution, validation, runtime registration, and shutdown. Every `setup` runs once, in array order, during config resolution — before the server boots.

```
defineConfig(plugins)
        │
        ▼
  resolve order ──► for each plugin:
        │             ├─ check kernelVersion against core
        │             ├─ run setup(ctx)  ← mutates the working config
        │             └─ collect registrations (routes, views, hooks)
        ▼
  validate merged config (fields, access, slugs, field-component pairing)
        │
        ▼
  build admin bundle  +  mount API host (REST / GraphQL / RPC)
        │
        ▼
  runtime: lifecycle events fire ──► plugin hook handlers run
        │
        ▼
  onShutdown(): plugins flush queues, close connections
```

Two ordering rules matter. First, `setup` runs in declaration order, so a plugin that extends a collection added by an earlier plugin must come after it. Second, hooks contributed by plugins run in registration order alongside collection-level hooks — there is no separate priority lane, which keeps the mental model flat. If you need to run before app-defined hooks, register your plugin first in the `plugins` array.

### Lifecycle events

Beyond per-collection hooks, plugins subscribe to global events through `ctx.hooks.on`. These fire on the operation core, so they are identical whether the operation arrived via REST, GraphQL, RPC, or the in-process Local API.

| Event             | Fires when                              | Common use                            |
| ----------------- | --------------------------------------- | ------------------------------------- |
| `onInit`          | After all `setup` calls, before serving | Seed data, register cron, warm caches |
| `beforeOperation` | Before any read/create/update/delete    | Tenant scoping, rate limiting         |
| `afterOperation`  | After a successful operation            | Cache invalidation, webhooks          |
| `afterError`      | On any operation error                  | Error reporting, alerting             |
| `onShutdown`      | On SIGTERM / graceful stop              | Flush queues, close clients           |

```ts
ctx.hooks.on('onShutdown', async () => {
  await ctx.services.queue.drain()
  ctx.logger.info('audit queue drained')
})
```

Because every event carries the typed operation context (`collection`, `operation`, `req`, `doc`), there is no `any` in a handler signature. This is where KernelCMS pulls ahead of Strapi's lifecycle subscribers, which hand you loosely typed event objects keyed by model UID.

## Testing plugins

`@kernel/plugin-sdk/testing` ships a `createTestKernel` harness that boots a real operation core against an in-memory SQLite (`@kernel/db-sqlite`) or an ephemeral Postgres. The point is to test plugins against a real adapter and real hooks, per the project's preference for real dependencies over mocks — not against a stubbed registry.

```ts
import { test, expect } from 'vitest'
import { createTestKernel } from '@kernel/plugin-sdk/testing'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { auditPlugin } from '../src'

test('records an entry on create', async () => {
  const kernel = await createTestKernel({
    db: sqliteAdapter({ url: ':memory:' }),
    collections: [{ slug: 'posts', fields: [{ name: 'title', type: 'text' }] }],
    plugins: [auditPlugin({ collections: ['posts'] })],
  })

  const post = await kernel.local.create('posts', { data: { title: 'Hello' } })

  const trail = await kernel.local.find('_audit_log', {
    where: { collection: { equals: 'posts' } },
  })

  expect(trail.docs).toHaveLength(1)
  expect(trail.docs[0]).toMatchObject({ operation: 'create', after: { id: post.id } })

  await kernel.destroy()
})
```

The harness exposes `kernel.local` (the typed Local API), `kernel.rest` and `kernel.rpc` test clients, and `kernel.admin` for asserting that views and nav items registered. Test through the Local API and the trail is written by the same hook path production uses — no mock seam to drift. For admin field components, render them with `kernel.admin.renderField(type, props)`, which mounts the component inside a real TanStack Form context so validation and binding are exercised.

Recommended coverage for a plugin: the happy path per registered hook, the unhappy path (operation errors must not corrupt the trail, shutdown must flush), access-control denial, and adapter portability — run the same suite against both `@kernel/db-sqlite` and `@kernel/db-postgres` in CI to catch backend-specific assumptions. See Testing for the project-wide harness conventions.

## Publishing and semver

A plugin is an npm package. Name it `kernel-plugin-*` or scope it (`@acme/kernel-plugin-*`) so the registry and `create-kernel` discovery surface it. Publish ESM with bundled `.d.ts`, list `@kernel/core` and `@kernel/plugin-sdk` as `peerDependencies` (never regular dependencies — a plugin must use the host's copy of the core), and declare the compatible core range there and in the plugin's `kernelVersion` field.

```jsonc
{
  "name": "@acme/kernel-plugin-audit",
  "version": "1.4.0",
  "type": "module",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
    "./admin": { "types": "./dist/admin.d.ts", "import": "./dist/admin.js" },
  },
  "peerDependencies": {
    "@kernel/core": "^1.0.0",
    "@kernel/plugin-sdk": "^1.0.0",
  },
}
```

Semver for a CMS plugin is about the contract downstream apps depend on, not just the code. Treat these as the rules:

| Change                                                          | Bump  | Rationale                           |
| --------------------------------------------------------------- | ----- | ----------------------------------- |
| New optional option, new collection, new admin view             | minor | Additive, no existing app breaks    |
| Bug fix, internal refactor, copy change                         | patch | No contract change                  |
| Removed/renamed option, changed field type, new required option | major | Breaks config or stored data        |
| Schema change requiring a migration                             | major | Stored documents must be migrated   |
| Widened `peerDependencies` core range                           | minor | More hosts supported                |
| Narrowed `peerDependencies` core range                          | major | Previously valid hosts now excluded |

The trap unique to a CMS is data-shape changes. If a new version of your plugin alters a field's type or a collection's schema, the host's existing rows must be migrated — bumping a field from `text` to `json` is a major version, and you should ship a migration alongside it (migrations are generated from schema diffs; see [Migrations](../03-persistence/08-migrations-engine.md)). Sanity and Strapi both leave this to the app author by default; a well-behaved KernelCMS plugin ships the diff-generated migration in the package and references it from the changelog so upgraders run it deliberately.

Keep a `CHANGELOG.md`, tag releases, and gate publishing on the test matrix passing against every supported core minor. For pre-release work, publish under a `next` dist-tag (`1.5.0-next.0`) so apps opt in explicitly. Mark deprecations with `@deprecated` JSDoc one minor before removal so editors warn authors before a major lands.

## Open questions

- **Plugin-to-plugin dependencies.** Should the SDK support declaring a hard dependency on another plugin (and a resolved order), or stay flat and require apps to order the `plugins` array themselves?
- **Capability declaration.** Should plugins declare required services (e.g. `requires: ["queue", "search"]`) so the host fails fast at resolution when an adapter is absent, rather than at first use?
- **Admin bundle isolation.** How much isolation do third-party admin views need — module federation per plugin, or is tree-shaken co-bundling sufficient given the trust model of self-hosted installs?
- **Cloud-signed plugins.** For KernelCMS Cloud, do we require signed/reviewed plugins from a registry, and how does that interact with self-host's open install model?
