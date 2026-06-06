# Authorization & Access Control

KernelCMS gates every read and write through a single, server-side access layer. Access is expressed as plain TypeScript functions colocated with your content config in `kernel.config.ts`, evaluated by `@kernel/core` at three altitudes — operation, document, and field — and applied uniformly across REST, GraphQL, the Local API, and typed RPC. There is no separate policy DSL, no admin-only permission table, and no client-trusted checks. If a function returns `false` (or a `Where` filter that excludes a row), the data never leaves the server. This document specifies the model, the evaluation order, and the contracts you implement.

## Where access lives

Access is not a bolt-on role table. It is a property of each collection, global, and field. This is the same posture Payload takes (access functions per collection/field), and a deliberate departure from Strapi (a UI-managed RBAC matrix stored in the database) and Sanity (a separate role/grant document language). The KernelCMS wedge: access is config-as-code, type-checked against your own document shapes, diffable in review, and identical whether the request arrives over HTTP or in-process.

```
Request (REST | GraphQL | RPC | Local)
        │
        ▼
┌───────────────────────────────┐
│ @kernel/core operation engine │
│                               │
│  1. operation-level access ───┼──► deny → 403, no DB query
│  2. document/row-level access ┼──► narrows the Where filter
│  3. field-level access ───────┼──► strips/blocks individual fields
└───────────────────────────────┘
        │
        ▼
   Adapter (@kernel/db-*) executes the (possibly narrowed) query
```

The engine runs these in order. Operation access is the cheap gate that can short-circuit before any database round-trip. Document access shapes the query the adapter actually runs. Field access runs last, on the resolved document(s), pruning what gets serialized.

## Access functions

Every access rule is a function with one argument — the `AccessArgs` context — returning a `boolean` or a `Where` filter (and may be `async`). The contract lives in `@kernel/core`:

```ts
import type { AccessArgs, Where } from '@kernel/core'

// The shape of `req.user` is your own auth strategy's user type,
// inferred end-to-end. No `any`, no casting at the call site.
type Access<TUser, TDoc = unknown> = (
  args: AccessArgs<TUser, TDoc>,
) => boolean | Where | Promise<boolean | Where>

interface AccessArgs<TUser, TDoc> {
  req: { user: TUser | null; locale?: string; ip: string }
  operation: 'create' | 'read' | 'update' | 'delete'
  id?: string                 // present for update/delete/read-by-id
  data?: Partial<TDoc>        // proposed data on create/update
  doc?: TDoc                  // the stored document, when resolved
}
```

The three return types carry distinct meaning, and the distinction is load-bearing:

| Return value | Meaning | Applied at |
| --- | --- | --- |
| `true` | Allow unconditionally | any level |
| `false` | Deny | any level |
| `Where` | Allow only rows matching this filter | operation/document level only |

Returning a `Where` is what makes row-level security ergonomic. Instead of "can this user read this collection?" you answer "*which* rows can they read?" — and the engine merges that filter into the query before it hits `@kernel/db`. Field-level functions may only return a boolean; narrowing a single field by query makes no sense.

Helpers in `@kernel/auth` keep common rules terse and composable:

```ts
import { isAuthenticated, hasRole, or, and } from '@kernel/auth'

const isEditor = hasRole('editor')
const isAdmin = hasRole('admin')

// Composition returns a normal Access function.
const canManage = or(isAdmin, and(isEditor, isAuthenticated))
```

## Operation-level access

Operation access answers a single yes/no/which-rows question per operation, evaluated *before* the adapter runs. It is the first and cheapest gate. Define it under `access` on a collection:

```ts
// kernel.config.ts
import { defineCollection } from '@kernel/core'
import { isAuthenticated, hasRole } from '@kernel/auth'
import type { User } from './auth'

export const Posts = defineCollection<User>({
  slug: 'posts',
  access: {
    // Anyone may read published posts; authors see their own drafts too.
    read: ({ req }): boolean | Where => {
      if (req.user?.role === 'admin') return true
      if (!req.user) return { status: { equals: 'published' } }
      return {
        or: [
          { status: { equals: 'published' } },
          { author: { equals: req.user.id } },
        ],
      }
    },
    create: isAuthenticated,
    update: hasRole('editor', 'admin'),
    delete: hasRole('admin'),
  },
  fields: [/* … */],
})
```

Four operations map to the CRUD verbs the operation engine exposes. Two notes on semantics:

- **`create`** receives `data` but no `doc`/`id`. Use it to reject creation outright or to validate cross-field ownership claims (e.g., a user setting `author` to someone else).
- **`read` returning a `Where`** is the single most important pattern here. A list query (`find`) merges that filter into pagination so the user only ever sees their slice; a `findByID` that resolves to an excluded row returns 404, not 403 — we never confirm existence of a resource the caller cannot see.

Globals (singletons like site settings) expose only `read` and `update`, since there is nothing to create or delete:

```ts
import { defineGlobal } from '@kernel/core'

export const Settings = defineGlobal<User>({
  slug: 'settings',
  access: {
    read: () => true,
    update: hasRole('admin'),
  },
  fields: [/* … */],
})
```

Unlike Strapi, where public/authenticated role permissions are toggled in the admin UI and persisted to the database, KernelCMS operation access is the deployed code. There is no drift between "what the matrix says" and "what ships," and no privileged endpoint that can silently widen access at runtime.

## Field-level access

A document is rarely uniform in sensitivity. An editor may read a post but not its `internalNotes`; a user may update their `name` but not their `role`. Field access handles exactly this, and runs *after* the document resolves so it can inspect `doc` and `req.user` together.

Field access supports two operations — `read` and `update` (there is no `create`/`delete` at the field level; field creation is governed by `update` on create) — and must return a boolean:

```ts
import { defineCollection } from '@kernel/core'
import { hasRole } from '@kernel/auth'

export const Users = defineCollection<User>({
  slug: 'users',
  access: { /* operation-level … */ },
  fields: [
    { name: 'name', type: 'text' },
    {
      name: 'role',
      type: 'select',
      options: ['user', 'editor', 'admin'],
      access: {
        // Only admins may change a role; everyone authorized may read it.
        update: hasRole('admin'),
      },
    },
    {
      name: 'internalNotes',
      type: 'textarea',
      access: {
        // Visible only to editors and admins; stripped for everyone else.
        read: ({ req }) => req.user?.role === 'editor' || req.user?.role === 'admin',
      },
    },
  ],
})
```

Enforcement is symmetric on both sides of the wire:

- **On read**, a field that fails `read` access is *omitted* from the serialized document. The GraphQL schema still types it as nullable; REST and RPC simply drop the key. The client cannot distinguish "null" from "withheld," which is the point.
- **On write**, a field that fails `update` access is *discarded* from the incoming `data` before validation and persistence. The engine does not throw — it silently ignores the attempted change, so a forged payload that sets `role: 'admin'` is dropped, not honored. (This mirrors Payload's behavior and is the safe default; a stricter "reject the whole request" mode is an open question below.)

This granularity is something Sanity approximates only through document-level grants plus client-side projection, and Strapi cannot express per-field without custom controllers. In KernelCMS it is one `access` block on the field definition, type-checked against the field's value type.

## Document and row-level rules

"Document-level" and "row-level" are two views of the same mechanism: an access function that depends on the *content* of the record, not just the caller's role. The engine applies them in two modes depending on the operation:

**Filtered (list) mode** — for `find`/`read` collection queries, a `Where` returned from operation access is composed with the user's own filters using `and`, so it cannot be widened by a crafted query:

```ts
// Effective query the adapter runs for a non-admin author:
//   and(
//     <user-supplied where>,
//     or(status=published, author=<me>)   // ← from access.read
//   )
```

**Resolved (single-document) mode** — for `update`/`delete` by ID, the engine fetches the row first, then re-evaluates access with `doc` populated, so you can write ownership rules against stored state:

```ts
access: {
  update: ({ req, doc }) => {
    if (!req.user) return false
    if (req.user.role === 'admin') return true
    // Authors may edit their own posts only while in draft.
    return doc?.author === req.user.id && doc?.status === 'draft'
  },
}
```

Two guarantees make this trustworthy:

1. **Stored state, not submitted state.** Ownership checks read `doc` (what's in the database), never `data` (what the request claims). A request cannot smuggle `author: <me>` to pass an ownership gate it would otherwise fail.
2. **404 over 403 for invisible rows.** When document access denies a `read`/`findByID`, the engine returns *not found*. We never leak the existence of records a caller has no right to see — the difference between a CMS and an information-disclosure bug.

For multi-tenant deployments, the same primitive carries tenant isolation. A `req.user.tenantId` folded into every `Where` is the row-level security boundary, and because it lives in code it is applied identically across REST, GraphQL, RPC, and the Local API — see [Multi-tenancy](../10-cloud-operations/03-multi-tenancy-and-isolation.md) for the tenant-context wiring.

```
update(id) ──► fetch doc ──► access.update({ req, doc }) ──► true?
                                   │                          │
                                   └── false / Where-miss ────┴─► 404 (read) | 403 (write)
```

## Access in the admin and on the client

The admin app (`@kernel/admin`) does **not** re-implement these rules; it reads them. `@kernel/core` exposes the resolved access decisions for the current user as part of the document/collection metadata, which the admin uses purely for affordance — hiding a delete button, disabling a field input, omitting a collection from the nav. Every one of those is a hint. The authoritative check always re-runs server-side on the actual operation, so a user who hand-crafts a request gains nothing. This is the inverse of trusting the client: the UI is allowed to be optimistic precisely because the server is not.

The typed `@kernel/client` and RPC surface inherit the same guarantees. Because RPC is just the Local API exposed over TanStack Start server functions, there is exactly one code path enforcing access — never a "fast path" that skips it.

## Open questions

- **Strict write rejection.** Should failed field-`update` access silently drop the field (current default, Payload-style) or reject the entire mutation with a `403`? A per-collection `accessMode: 'strip' | 'reject'` is the leading proposal.
- **Caching resolved `Where` filters.** Async access functions that hit a store (e.g., team-membership lookups) run per request. We need a documented, opt-in memoization boundary in `@kernel/core` without risking stale authorization.
- **Field access on relationship depth.** When `depth > 0` populates related documents, field-level `read` should re-evaluate against the *related* collection's rules. The composition is specified; the performance budget under deep population is not yet measured.
- **Block/array nested field access.** Whether field access on a `blocks` or `array` member applies per-row or per-field-across-rows needs a final ruling before the editor renders partial blocks.
