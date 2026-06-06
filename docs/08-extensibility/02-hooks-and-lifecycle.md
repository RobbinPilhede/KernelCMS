# Hooks & Lifecycle

Hooks are KernelCMS's primary extensibility surface for reacting to and reshaping data as it flows through operations. Every read, write, and delete passes through a deterministic chain of hook stages — operation-level, then field-level — each receiving a fully typed context. This document specifies the complete hook surface: the operation hooks that wrap `create`, `read`, `update`, and `delete`; the field hooks that transform individual values; how collection hooks differ from global hooks; and the exact ordering and context guarantees you can rely on.

## The lifecycle in one diagram

Every operation — whether it arrives via REST, GraphQL, RPC, or the in-process Local API — runs the same pipeline. The transport is irrelevant; hooks fire identically regardless of surface (see APIs overview).

```
                 ┌─────────────────────────────────────────────┐
  request  ──▶   │ access (operation)                          │
                 │   │                                          │
                 │   ▼  beforeValidate ──▶ field beforeValidate │
                 │   │                                          │
                 │   ▼  validate (field) ──▶ beforeChange       │
                 │   │                       │                  │
                 │   ▼  field beforeChange ──▶ DB write         │
                 │   │                       │                  │
                 │   ▼  afterChange ◀── field afterChange       │
                 │   │                                          │
                 │   ▼  afterRead ◀── field afterRead           │
                 └─────────────────────────────────────────────┘
                     │
  response ◀─────────┘
```

`beforeValidate → validate → beforeChange → afterChange` form the **write path**. `afterRead` is the **read path** and also runs as the final stage of any write so the returned document is fully resolved. This mirrors Payload's hook taxonomy closely — and deliberately so, since Payload's model is the most battle-tested in the headless-CMS space — but KernelCMS makes two hard guarantees Payload does not: every hook argument is inferred from your collection schema with zero `any`, and hooks run inside the same transaction as the DB write (see [Transactions](../03-persistence/07-transactions-and-consistency.md)).

## Operation hooks

Operation hooks attach to a collection or global and fire once per operation. They are defined under the `hooks` key in your config and receive the whole document.

```ts
// kernel.config.ts
import { defineCollection } from '@kernel/core'
import type { CollectionAfterChangeHook } from '@kernel/core'

const revalidate: CollectionAfterChangeHook<'posts'> = async ({
  doc,
  operation,
  req,
}) => {
  if (operation === 'create' || operation === 'update') {
    await req.context.cache.revalidateTag(`post:${doc.slug}`)
  }
  return doc
}

export const Posts = defineCollection({
  slug: 'posts',
  hooks: {
    beforeOperation: [enforceTenantScope],
    beforeValidate: [normalizeSlug],
    beforeChange: [stampEditor],
    afterChange: [revalidate, indexForSearch],
    beforeRead: [hideUnpublished],
    afterRead: [resolveByline],
    beforeDelete: [blockIfReferenced],
    afterDelete: [purgeUploads],
  },
  fields: [/* … */],
})
```

### The full operation hook table

| Hook | Path | Fires when | Mutates | Typical use |
|------|------|-----------|---------|-------------|
| `beforeOperation` | write + read | before access/validation, once | `args` | inject scope, mutate `where`, audit |
| `beforeValidate` | write | before field validation | `data` | normalize, coerce, default |
| `beforeChange` | write | after validation, before DB | `data` | stamp metadata, derive fields |
| `afterChange` | write | after DB commit (in-tx) | side effects | revalidate, index, emit events |
| `beforeRead` | read | before doc is loaded for response | `query` | filter drafts, tenant scope |
| `afterRead` | read + write tail | after doc is loaded | `doc` | resolve virtuals, format |
| `beforeDelete` | delete | before row removed | — | guard, cascade checks |
| `afterDelete` | delete | after row removed (in-tx) | side effects | purge storage, cleanup relations |

The split between `beforeValidate` and `beforeChange` matters. Put **idempotent shaping** (lowercasing a slug, trimming whitespace) in `beforeValidate` so validation sees the cleaned value. Put **authoritative side data** (the editing user, a computed `readingTime`) in `beforeChange`, after validation has already passed — there's no point computing derived fields for data that's about to be rejected.

Strapi exposes lifecycle hooks too (`beforeCreate`, `afterUpdate`, …) but they are global per-model functions registered in a `lifecycles.js` file, decoupled from the schema and untyped against it. Sanity has no server-side write hooks at all — its model is document-mutation webhooks plus GROQ-driven functions, so you cannot synchronously reshape a document before it's written. KernelCMS keeps hooks co-located with the collection definition and arrays them so plugins can append without clobbering your own.

### Why `afterChange` runs inside the transaction

In Payload, `afterChange` runs after the write commits but outside any transaction boundary — a failure there leaves a committed-but-unprocessed document. KernelCMS runs `afterChange` and `afterDelete` inside the operation's transaction by default. If your search-indexing hook throws, the whole write rolls back. For genuinely external, non-transactional work (sending email, calling a third-party API), use the `req.context.after()` deferral, which queues the callback to run only after a successful commit:

```ts
const notify: CollectionAfterChangeHook<'orders'> = async ({ doc, req }) => {
  req.context.after(async () => {
    await req.context.email.send({ to: doc.email, template: 'order-placed' })
  })
  return doc
}
```

This is the escape hatch the engineering tenets demand: transactional by default, with an explicit opt-out for effects that must not block or roll back the write.

## Field hooks

Field hooks are scoped to a single field and fire for that field on every matching operation. They are the right tool when a transformation belongs to the *field*, not the document — encryption of a single column, formatting a price, hashing a token. Because they travel with the field definition, they apply everywhere that field appears, including inside `array`, `blocks`, and `group` field types, with the correct `siblingData` in context.

```ts
import { field } from '@kernel/core'

const apiKey = field.text({
  name: 'apiKey',
  hooks: {
    beforeChange: [({ value }) => (value ? encrypt(value) : value)],
    afterRead: [({ value, req }) =>
      req.user?.role === 'admin' ? decrypt(value) : '••••••••',
    ],
  },
})
```

Field hooks run the same four write-path/read-path stages as operation hooks — `beforeValidate`, `beforeChange`, `afterChange`, `afterRead` — but their context is narrowed to the field. The key difference from operation hooks is the argument shape:

| Arg | Field hook | Operation hook |
|-----|-----------|----------------|
| `value` | the field's value | — |
| `siblingData` | adjacent fields in the same group/row | — |
| `data` | full incoming document | the document |
| `path` | dotted path, e.g. `meta.seo.title` | — |
| `originalDoc` | the pre-change document | `previousDoc` |

The `path` arg is what makes field hooks composable inside nested structures. A field hook on a `price` field used inside an `array` of `variants` receives `path` of `variants.2.price`, so a single localized-currency formatter works whether the field is top-level or three levels deep. Payload's field hooks expose a similar `siblingData`, but KernelCMS additionally guarantees `path` is always present and typed as a template-literal type derived from the schema, so you can branch on location without string-parsing.

## Collection vs. global hooks

Collections are repeatable; globals are singletons (site settings, navigation). Their hook surfaces are nearly identical, with two structural differences.

First, globals have **no `delete` path**. A global is a single row that always exists, so `beforeDelete` and `afterDelete` are simply not part of the global hook type — the compiler rejects them.

Second, global hooks never receive an `id`-based bulk context. Collection operations can be bulk (`updateMany`, `deleteMany`), and the corresponding hooks fire **once per affected document**, not once per request, so a per-document `afterChange` stays correct under bulk writes. Globals are always single-document.

```ts
import { defineGlobal } from '@kernel/core'

export const Settings = defineGlobal({
  slug: 'settings',
  hooks: {
    beforeChange: [validateThemeTokens],
    afterChange: [({ doc, req }) =>
      req.context.cache.revalidateTag('global:settings') && doc,
    ],
    // beforeDelete / afterDelete are a type error here
  },
  fields: [/* … */],
})
```

Both share the same `req` and `req.context` object, so a hook utility written for a collection works unchanged on a global as long as it doesn't touch delete-only fields.

## Hook ordering and context

Ordering is deterministic and total. Within a single stage, hooks run **in array order, sequentially, awaiting each**. The return value of each hook becomes the input to the next, so hooks in the same array compose like a pipeline. There is no parallelism inside a stage — this is intentional, because a normalizer must run before a validator that depends on it.

Across the two levels, the rule is: **operation hooks bracket field hooks**. On the write path, `operation.beforeValidate` runs fully, then every field's `beforeValidate` runs; then `operation.beforeChange`, then every field's `beforeChange`. On the read path it inverts — field `afterRead` runs before `operation.afterRead`, so document-level hooks see fully resolved field values.

```
write:  op.beforeValidate ─▶ field.beforeValidate ─▶ validate
        ─▶ op.beforeChange ─▶ field.beforeChange ─▶ [DB]
        ─▶ field.afterChange ─▶ op.afterChange
        ─▶ field.afterRead ─▶ op.afterRead
```

Plugins register hooks by **appending** to these arrays through the plugin SDK (see [Plugin SDK](./01-plugin-sdk-and-authoring.md)); user-defined hooks in `kernel.config.ts` run before plugin hooks within the same stage unless a plugin declares `prepend`. This gives you a predictable mental model: your code first, plugins after, top-to-bottom.

### The context object

Every hook — operation or field — receives a shared `req`. It is the single carrier of request state and the only sanctioned way to reach infrastructure adapters from inside a hook.

```ts
interface KernelRequest {
  user: AuthUser | null
  locale: string
  fallbackLocale: string | null
  transactionID: string | null
  context: RequestContext // db, cache, email, storage, search adapters + after()
  payload: never          // reserved; use req.context — no Payload-style god object
}
```

`req.context` is request-scoped and carries the active transaction, so any adapter call made through it joins the same transaction as the operation. Mutations you make to `req.context` (stashing a computed value in `beforeValidate` to reuse in `afterChange`) persist across stages within one operation but never leak across requests. This is the deliberate counter to Strapi, where lifecycle hooks reach for global `strapi.*` singletons and shared state with no request scoping — a frequent source of cross-request bugs under load.

## Open questions

- **Field-hook concurrency.** Field hooks currently run sequentially across fields within a stage. For documents with hundreds of independent fields each doing async work (decryption, signed-URL generation), should we offer an opt-in parallel mode per field, accepting that ordering guarantees are lost for those fields?
- **`afterOperation` stage.** Payload added a top-level `afterOperation` hook that fires after the entire operation including the response shaping. We have deliberately omitted it; whether `req.context.after()` fully covers its use cases needs validation against real plugin demand.
- **Hook timeouts.** Should the runtime enforce a per-hook time budget (consistent with the performance-budget tenet) and surface slow hooks in dev, or leave timing to userland instrumentation?
