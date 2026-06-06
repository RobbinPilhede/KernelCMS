# Plugin System Architecture

A KernelCMS plugin is a pure function that receives the resolved config and returns a new one. That single decision — plugins are config transformers, not lifecycle objects with `register()`/`bootstrap()` hooks — is what lets the same plugin inject a collection, mount an admin route, patch a Drizzle schema, and wrap an operation handler without ever touching the runtime's internals. This document specifies the plugin shape, how config transformation composes, the capability surface a plugin is allowed to touch, and the isolation and ordering guarantees that keep twenty community plugins from corrupting each other.

## The Plugin Shape

A plugin is a factory that returns a `KernelPlugin`. The factory takes the plugin's own options; the returned object carries identity metadata and a single `setup` transform.

```ts
// @kernel/plugin-sdk
export interface KernelPlugin {
  /** Stable, namespaced id. Used for ordering, dedupe, and diagnostics. */
  name: `${string}/${string}`;
  /** Semver of the plugin package, surfaced in the admin and CLI doctor. */
  version: string;
  /** Plugins that must run before this one. Resolved topologically. */
  dependsOn?: ReadonlyArray<string>;
  /** The transform. Receives the config-so-far, returns the next config. */
  setup: (ctx: PluginContext) => Config | Promise<Config>;
}

export type KernelPluginFactory<TOptions = void> = (
  options: TOptions,
) => KernelPlugin;
```

In `kernel.config.ts`, plugins are values in an array, no different from collections or adapters:

```ts
import { defineConfig } from '@kernel/core';
import { postgresAdapter } from '@kernel/db-postgres';
import { seoPlugin } from '@kernel/plugin-seo';
import { stripePlugin } from '@kernel/plugin-stripe';

export default defineConfig({
  db: postgresAdapter({ url: process.env.DATABASE_URL! }),
  collections: [Posts, Authors],
  plugins: [
    seoPlugin({ collections: ['posts'], generateTitle: true }),
    stripePlugin({ webhookSlug: 'stripe' }),
  ],
});
```

This is deliberately closer to Payload than to Strapi. Strapi plugins are filesystem packages with a fixed directory contract (`server/`, `admin/`, `strapi-server.js`) discovered by convention; you extend behavior by overriding generated files and registering services through a global `strapi` object. Sanity's plugins are closer to ours — a plugin returns a config object that the `definePlugin` helper merges — but Sanity's surface is overwhelmingly studio (admin) configuration. KernelCMS plugins are first-class config transformers with equal authority over server, schema, and admin, and they are ordinary npm packages with no magic directory layout. There is no plugin registry to scan, no autoloader, no `enabled: true` toggle in a separate file. If it is in the `plugins` array, it runs; if not, it does not exist.

## Config Transformation

The core idea: a plugin receives the fully-typed `Config` produced by the user plus every prior plugin, and returns the next `Config`. Composition is a left fold.

```
defineConfig input
      │
      ▼
 ┌──────────┐    ┌──────────┐    ┌──────────┐
 │ plugin A │ ─▶ │ plugin B │ ─▶ │ plugin C │ ─▶  resolved Config
 └──────────┘    └──────────┘    └──────────┘
   config₀          config₁          config₂          config₃
```

`PluginContext` wraps the current config with helpers so plugins do not hand-roll immutable spreads against a deep object:

```ts
export interface PluginContext {
  /** The config produced so far. Treat as immutable. */
  readonly config: Readonly<Config>;
  /** Structured, validated mutation helpers — see the capability surface. */
  readonly extend: PluginExtensions;
  /** Logger scoped to this plugin's name. */
  readonly log: Logger;
  /** Read-only view of which other plugins are present and their options. */
  readonly peers: ReadonlyArray<PluginManifest>;
}
```

A small but real plugin — add a `slug` field and a `beforeChange` hook to selected collections:

```ts
import { definePlugin } from '@kernel/plugin-sdk';
import { slugify } from './slugify';

export const slugPlugin = definePlugin<{ collections: string[]; from: string }>(
  (options) => ({
    name: 'kernel/slug',
    version: '1.4.0',
    setup: (ctx) =>
      ctx.extend.collections(options.collections, (collection) => ({
        ...collection,
        fields: [
          ...collection.fields,
          {
            name: 'slug',
            type: 'text',
            unique: true,
            index: true,
            admin: { position: 'sidebar', readOnly: true },
          },
        ],
        hooks: {
          ...collection.hooks,
          beforeChange: [
            ...(collection.hooks?.beforeChange ?? []),
            ({ data }) => ({ ...data, slug: slugify(data[options.from]) }),
          ],
        },
      })),
  }),
);
```

Three properties make this safe and predictable:

- **Total typing, zero `any`.** `ctx.config` and every `extend` helper are fully typed against the user's actual collections, so a plugin that targets a collection slug that does not exist is a type error in the user's editor, surfaced through `@kernel/core`'s inference — not a runtime crash.
- **Async is allowed but bounded.** `setup` may be async (fetch a remote schema, read a manifest), but it runs once at config resolution, never per-request. The resolved config is frozen and cached.
- **No hidden global state.** Unlike Strapi's `strapi.service()` registry, there is nothing to mutate out-of-band. Everything a plugin contributes is in its returned config and therefore visible to the next plugin and to the diff-based migration generator.

## The Capability Surface

`ctx.extend` is the allowlist. A plugin can only do what the surface exposes, which keeps plugins from reaching into the operation engine or the Drizzle connection directly. The surface maps one-to-one onto the four extension domains.

| Domain   | Helper                       | What it adds                                                        |
|----------|------------------------------|--------------------------------------------------------------------|
| Config   | `extend.collections(...)`    | Collections, globals, fields, custom field types                   |
| Config   | `extend.globals(...)`        | Singletons (settings, navigation)                                  |
| Schema   | `extend.schema(...)`         | Extra Drizzle tables/columns + a migration contribution            |
| Runtime  | `extend.hooks(...)`          | `beforeChange` / `afterRead` / `afterDelete` operation hooks       |
| Runtime  | `extend.endpoints(...)`      | Custom REST/RPC routes via TanStack Start server functions         |
| Runtime  | `extend.jobs(...)`           | Queue handlers on the configured queue adapter                     |
| Admin    | `extend.views(...)`          | TanStack Router routes, nav items, command-palette actions         |
| Admin    | `extend.fieldComponents(...)`| Custom field UI bound through TanStack Form                        |
| Admin    | `extend.providers(...)`      | React context providers wrapping the admin shell                   |

Schema extensions are where KernelCMS pulls ahead of the competition. Because every backend implements one Adapter contract and migrations are generated from schema diffs, a plugin contributes schema declaratively and the migration is generated, not authored:

```ts
setup: (ctx) =>
  ctx.extend.schema((s) => ({
    ...s,
    auditLog: s.table('audit_log', {
      id: s.uuid().primaryKey().defaultRandom(),
      action: s.text().notNull(),
      actorId: s.uuid().references(() => s.tables.users.id),
      at: s.timestamp().notNull().defaultNow(),
    }),
  })),
```

Run `kernel migrate generate` and the diff against the live database includes the plugin's table. Payload offers hooks and custom fields but treats database schema as adapter-owned and largely opaque to plugins; Sanity has no migration story because it is schemaless on the server. KernelCMS plugins can ship real relational schema and the user still gets a single, reviewable migration.

Admin contributions resolve against the same TanStack stack the core admin uses — there is no separate plugin runtime. A plugin's view is a TanStack Router route; its data fetching is TanStack Query; its field component binds through TanStack Form. That is the wedge in practice: a plugin author writes the same code the core team writes, against `@kernel/ui` primitives, with the same type-safety guarantees.

```ts
ctx.extend.views((views) => [
  ...views,
  {
    path: '/analytics',
    nav: { label: 'Analytics', group: 'Insights', icon: 'chart' },
    component: () => import('./AnalyticsView'),
    access: ({ user }) => user.roles.includes('admin'),
  },
]);
```

## Isolation and Ordering

Plugins are ordered, dependency-aware, and sandboxed against the three failure modes that wreck plugin systems: silent overwrites, cyclic dependencies, and one bad plugin taking down boot.

**Ordering is explicit and stable.** Array position is the default order, but `dependsOn` introduces hard edges that the resolver respects via topological sort. A cycle is a fatal config error with the offending names printed — it never silently picks an order.

```
plugins: [seo, slug, search]   with  search.dependsOn = ['kernel/slug']

resolved order:  slug → seo → search
                 (array order preserved except where dependsOn forces an edge)
```

**Conflicts are detected, not last-write-wins.** When a plugin adds a field, route path, endpoint slug, or schema table that already exists, the resolver raises a `PluginConflictError` naming both contributors. This is the opposite of Strapi, where override-by-convention means the last plugin to touch a file wins silently. KernelCMS forces an explicit resolution — rename, or have the later plugin transform the earlier contribution intentionally.

| Failure mode            | KernelCMS behavior                                  |
|-------------------------|-----------------------------------------------------|
| Duplicate field/route   | `PluginConflictError` at resolve time, build fails  |
| Dependency cycle        | `PluginCycleError`, names printed, build fails      |
| `setup` throws          | Boot aborts; only that plugin's frame is unwound    |
| Slow async `setup`      | Per-plugin timeout (default 10s), logged with name  |

**Isolation has limits, and we are honest about them.** Because the admin is one React tree and the server is one process, a plugin's React component or hook runs in the same memory space as core. We do not promise VM-level sandboxing. What we do promise: the *capability surface* is the only sanctioned mutation path, all writes go through validated helpers, plugin errors are attributed by name, and access control on plugin endpoints and views is evaluated by the same server-side engine — at the operation, document, and field level — as everything else. A plugin cannot bypass authz by mounting a route, because route access is checked by core, not by the plugin.

**Determinism.** The resolved config is a pure function of the input array and plugin options. The same `kernel.config.ts` produces byte-identical resolved config across machines, which is what makes config-as-code portable between self-host and KernelCMS Cloud without surprises.

See Writing a Plugin for the authoring workflow, [Custom Field Types](../02-data-modeling/04-field-types-catalog.md) for the field component contract, and Schema & Migrations for how plugin schema contributions flow into generated migrations.

## Open Questions

- **Plugin-scoped config validation.** Should `definePlugin` accept a Zod/standard-schema validator for its options so misconfiguration fails at `defineConfig` time rather than inside `setup`? Leaning yes, gated behind an optional `optionsSchema` field.
- **Capability declarations.** Worth requiring plugins to declare which `extend` domains they touch (a `capabilities: ['schema', 'admin']` manifest) so the CLI doctor and Cloud can show a trust summary before install? Trades a little ceremony for a real supply-chain signal.
- **Admin-only bundle splitting.** A plugin that only contributes server hooks should never ship code to the admin bundle. The current shape lets the bundler tree-shake `extend.views`, but we have not decided whether to enforce a hard server/admin entry split at the package level.
