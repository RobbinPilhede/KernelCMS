# ADR 0005: Plugin & Hook Architecture

KernelCMS extends through two coordinated mechanisms: **plugins**, which mutate the resolved config before the system boots, and **hooks**, which intercept operations at runtime. Plugins own the *static* surface — schema, admin components, API routes, adapters — while hooks own the *dynamic* surface — what happens before and after each create, read, update, or delete. Both are typed end-to-end, both run server-side by default, and both compose deterministically. This ADR fixes the contract so that `@kernel/plugin-sdk` authors, `@kernel/server` maintainers, and `@kernel/admin` contributors share one model of how extension code touches the kernel.

## Context

A headless CMS lives or dies by its extension story. Three classes of extension exist, and conflating them is the original sin of most CMS plugin systems:

1. **Config-time extension** — adding collections, fields, globals, admin views, or API routes. This must happen *once*, before the schema is frozen and migrations are diffed.
2. **Operation-time extension** — reacting to or transforming data as it flows through create/read/update/delete. This must happen *per request*, with access to the document, the operation context, and the authenticated user.
3. **Infrastructure extension** — swapping the database, storage, email, auth, search, cache, or queue. KernelCMS already models these as adapters (see ADR 0002: Adapter Contracts); plugins are how third parties *ship* adapters, but adapters are not themselves hooks.

Payload collapses (1) and (2) into a single `config` object where hooks are inline arrays on each collection. Strapi splits them across a `register`/`bootstrap` lifecycle plus a content-type-builder plus a separate document-service middleware layer — three mental models for one job. Sanity barely has server-side hooks at all; its extension model is overwhelmingly client-side (Studio plugins, `defineDocumentActions`), with server logic pushed into separate Functions or GROQ webhooks.

KernelCMS needs a model that:

- keeps config-time and operation-time strictly separated so the type checker and migration diff stay sound,
- makes ordering and composition explicit rather than array-position-implicit,
- runs server-side by default with an *opt-in* path to ship admin (client) extensions from the same package, and
- preserves the **escape-hatch tenet** — a plugin can always drop to the raw `@kernel/server` operation core.

The constraint that shapes everything: `kernel.config.ts` is the single source of truth, and the resolved config must be a pure value before the server starts. Plugins therefore cannot be "running services." They are pure functions over config.

## Decision

### Plugins are config transformers

A plugin is a function `(config: ResolvedConfig) => ResolvedConfig`, produced by a factory that takes plugin options. It runs during the config resolution pass, in declaration order, after defaults are applied but before schema validation and migration diffing.

```ts
// @kernel/plugin-sdk
export interface KernelPlugin {
  name: string;                    // unique, used for ordering + diagnostics
  setup(ctx: PluginContext): MaybePromise<void>;
}

export interface PluginContext {
  addCollection(collection: CollectionConfig): void;
  extendCollection(slug: string, patch: CollectionPatch): void;
  addGlobal(global: GlobalConfig): void;
  addField(target: FieldTarget, field: Field): void;
  addAdminView(view: AdminViewConfig): void;     // TanStack Router route
  addServerRoute(route: ServerRouteConfig): void; // TanStack Start server fn
  registerFieldType(type: CustomFieldType): void;
  registerAdapter(adapter: AdapterRegistration): void;
  hooks: HookRegistry;             // operation-time registration, see below
  logger: Logger;
}
```

A realistic `kernel.config.ts`:

```ts
import { defineConfig } from '@kernel/core';
import { postgres } from '@kernel/db-postgres';
import { auditLog } from '@kernel/plugin-audit-log';
import { algolia } from '@kernel/plugin-algolia';

export default defineConfig({
  db: postgres({ url: process.env.DATABASE_URL! }),
  collections: [Posts, Authors, Media],
  plugins: [
    auditLog({ collections: ['posts', 'authors'], retainDays: 90 }),
    algolia({
      appId: process.env.ALGOLIA_APP_ID!,
      indexName: 'posts',
      collections: ['posts'],
    }),
  ],
});
```

`auditLog` here does two things in its `setup`: it `addCollection`s an `audit_entries` collection and it registers `afterChange`/`afterDelete` hooks on the targeted collections. One package, both extension classes, cleanly separated by API.

### Hooks are typed, named, ordered interceptors

Hooks register against operation phases, not against array positions on a collection. Every hook receives a typed argument object and may mutate it (for `before*` phases) or read it (for `after*` phases).

| Phase | Fires | Can mutate | Typical use |
|---|---|---|---|
| `beforeValidate` | pre-write, before validation | input data | normalize, coerce, default |
| `beforeChange` | pre-write, after validation | document | derive fields, enforce invariants |
| `afterChange` | post-commit | nothing (read-only) | index, webhook, audit |
| `beforeRead` | per-doc on read | document projection | strip, decrypt, transform |
| `afterRead` | per-doc on read | document | compute virtual fields |
| `beforeDelete` | pre-delete | nothing | guard, cascade-check |
| `afterDelete` | post-delete | nothing | cleanup, deindex |
| `beforeOperation` / `afterOperation` | wraps the whole op | request/result | tracing, rate context |

```ts
hooks.on('posts', 'afterChange', {
  name: 'algolia:index',
  order: 100,
  async run({ doc, operation, req }) {
    if (operation === 'create' || operation === 'update') {
      await req.services.search.upsert('posts', toIndexRecord(doc));
    }
  },
});
```

Hooks carry an explicit `name` and numeric `order`. The runtime sorts by `order` (lower runs first), breaks ties by plugin declaration order, and surfaces the resolved chain in `kernel diagnostics hooks` so authors can see exactly what runs and when. This is the single biggest divergence from Payload, where hook order is the literal index in the array and cross-plugin ordering is unknowable without reading every plugin's source.

Field-level hooks use the same registry with a `FieldTarget` (`{ collection, path }`), so a plugin can attach `beforeChange` to `posts.slug` without owning the collection.

### Where hooks run in the operation pipeline

```
                @kernel/server operation core (Local API)
   ┌──────────────────────────────────────────────────────────────┐
   │ access(operation) → beforeOperation                           │
   │   → beforeValidate → validate → beforeChange                  │
   │     → access(field) → ADAPTER WRITE (Drizzle / MongoDB)       │
   │   → afterChange → afterOperation                              │
   └──────────────────────────────────────────────────────────────┘
        ▲              ▲                ▲
     REST          GraphQL         RPC (server fn)
   @kernel/rest  @kernel/graphql  @kernel/rpc
```

Critically, hooks live *inside* the operation core, not in any single transport. REST, GraphQL, and typed RPC all call the same core, so a hook fires identically regardless of surface. Strapi's split — REST/GraphQL controllers vs. the document-service middleware — means a webhook author has to decide which layer to target. KernelCMS removes that decision.

### Admin (client) extension is opt-in and isolated

Server hooks never ship to the browser. A plugin that needs admin UI exports a separate entry point that `@kernel/admin` loads:

```ts
// @kernel/plugin-audit-log/admin
export default defineAdminPlugin({
  views: [{ path: '/audit', component: AuditLogView }],   // TanStack Router
  fieldComponents: { 'posts.status': StatusBadge },
  commands: [{ id: 'audit.export', title: 'Export audit log', run: exportAudit }],
});
```

Admin plugins are pure TanStack Start/Router/Query components; they fetch through the typed `@kernel/client`, never through ad-hoc `fetch`. This mirrors Sanity's Studio plugin strength while keeping the server authoritative — the inverse of Sanity, which has rich client plugins but a thin server.

## Consequences

**Positive.** Ordering is explicit and inspectable. The config/runtime split keeps the migration diff and type inference sound — no hook can secretly add a column. One operation core means hooks compose identically across REST, GraphQL, and RPC. Server/admin isolation means a plugin can't accidentally leak server secrets into the bundle, satisfying the "no secrets client-side" rule by construction. Adapters shipping *as* plugins gives the marketplace a single distribution unit.

**Negative / cost.** Two extension APIs (config-time `setup`, runtime `hooks`) is more surface than Payload's single inline-array model, so the learning curve is steeper for trivial cases. Named/ordered hooks require authors to think about `order`; we mitigate with sensible defaults (`order: 0`) and the diagnostics command. Async `setup` functions make config resolution async, which complicates tooling that wants a synchronous config (the CLI must `await` resolution).

**Failure semantics.** A throwing `before*` hook aborts the operation and rolls back the transaction. A throwing `after*` hook does **not** roll back (the commit already happened); it is logged and, for queued work, retried via the queue adapter. This is a deliberate, documented contract — Payload leaves `afterChange` failure behavior largely to the author.

**Boundaries.** Hooks run within the request's access-control context; they cannot escalate privileges unless they explicitly use the operation core with `overrideAccess: true`, which is audited. See [ADR 0004: Access Control Model](../../06-auth-security/01-authorization-and-access-control.md).

## Comparison to Payload and Strapi plugins

| Concern | Payload | Strapi | KernelCMS |
|---|---|---|---|
| Config vs. runtime split | Merged (inline arrays) | Split across `register`/`bootstrap` + content-type-builder | Clean: `setup` (config) vs. `hooks` (runtime) |
| Hook ordering | Array index, per-collection | Middleware order, global | Named + numeric `order`, inspectable |
| Cross-surface consistency | Hooks in operation core (good) | Controller vs. document-service split | Single operation core for REST/GraphQL/RPC |
| Admin extension | Custom React components in config | Admin panel via separate plugin SDK | Isolated `/admin` entry, TanStack-native |
| Adapter distribution | Plugins + separate DB adapters | Providers (upload, email) | Adapters ship as plugins, one unit |
| Type safety of hook args | Strong | Partial (lots of `any` in services) | End-to-end typed, zero `any` |

Payload's model is the closest relative and the one to beat. Its strength is that hooks live in the operation core, exactly as KernelCMS does. Its weakness is array-position ordering and the lack of a name for any given hook — debugging a 12-plugin install means reading source. KernelCMS keeps Payload's core-centric execution and adds names, explicit order, and a diagnostics view.

Strapi's three-headed model (lifecycle hooks on content-types, global middlewares, and document-service middlewares) is powerful but forces authors to pick a layer, and the document-service surface is weakly typed. KernelCMS collapses these into one typed registry that always targets the operation core.

Sanity is the contrast case: its extensibility is client-first. KernelCMS deliberately inverts that — server-authoritative hooks, with admin extension as a typed, optional add-on — because a headless CMS competing on **config-as-code** and **server-side-by-default security** cannot put business logic in the browser.

See also: ADR 0002: Adapter Contracts, [ADR 0004: Access Control Model](../../06-auth-security/01-authorization-and-access-control.md), and the [Plugin SDK guide](../../08-extensibility/01-plugin-sdk-and-authoring.md).

## Open questions

- **Plugin dependency resolution.** When plugin B's `setup` needs a collection plugin A added, do we expose a declarative `dependsOn: ['plugin-a']` field, or rely purely on declaration order? Declaration order is simpler but fragile across copy-pasted configs.
- **Hook concurrency for `after*` phases.** `afterChange` hooks are independent and could run in parallel. Do we run them sequentially (predictable, slower) or `Promise.all` (faster, harder to reason about ordering side effects)? Current lean: sequential by default, opt-in `parallel: true`.
- **Edge-runtime hook constraints.** On edge runtimes (Cloudflare, Deno Deploy), some hooks may need Node APIs. Do we mark hooks with a `runtime` capability and fail config resolution early, or degrade at request time?
