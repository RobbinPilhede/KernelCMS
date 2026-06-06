# Roles, Permissions, RBAC & ABAC

KernelCMS treats access control as a first-class part of the content config, not a bolt-on. Every operation, document, and field passes through a deterministic policy pipeline that combines role-based access control (RBAC) for coarse, predictable grants with attribute-based access control (ABAC) for fine-grained, data-aware decisions. This document specifies how roles and permissions are modeled, how the RBAC layer maps roles to capabilities, how ABAC conditions narrow those capabilities using request and document attributes, and the exact order in which the resolver combines them into an allow/deny verdict. Everything here is evaluated server-side and on by default — see [Access Control Overview](./01-authorization-and-access-control.md) for the boundaries this layer sits behind.

## Roles and Permissions

A **role** is a named bundle of intent ("editor", "translator", "billing-admin"). A **permission** is a concrete capability over a resource: an `(action, scope)` pair such as `read:posts`, `update:posts.fields.slug`, or `publish:globals.navigation`. Roles never grant access directly; they grant permissions, and permissions are what the resolver evaluates.

Roles are config-as-code, declared in `kernel.config.ts` and versioned with the rest of your schema. This is a deliberate departure from Strapi, where roles and their permission matrices live in the admin database and drift between environments, and from Sanity, whose roles are fixed tiers (`administrator`, `editor`, `viewer`, plus custom roles on paid plans) configured through a dashboard. KernelCMS roles are code you review, diff, and deploy.

```ts
import { defineRoles } from '@kernel/auth'

export const roles = defineRoles({
  admin: {
    label: 'Administrator',
    // Wildcard grant — every action on every resource.
    grants: ['*:*'],
  },
  editor: {
    label: 'Editor',
    grants: ['read:*', 'create:posts', 'update:posts', 'delete:posts', 'publish:posts'],
  },
  translator: {
    label: 'Translator',
    grants: [
      'read:posts',
      // Field-scoped: can only touch localized field groups.
      'update:posts.fields.translations',
    ],
  },
})
```

Actions are a closed union, not free-form strings, so a typo fails at compile time:

```ts
type Action =
  | 'create'
  | 'read'
  | 'update'
  | 'delete'
  | 'publish'
  | 'unpublish'
  | 'restore' // version ops
  | 'admin' // panel/UI access
```

Scopes address resources hierarchically: `collection`, `collection.fields.fieldPath`, `globals.slug`, or `*`. A grant on a parent scope implies its children unless a narrower grant or deny overrides it. The `@kernel/core` type inference walks your collection definitions, so `update:posts.fields.<path>` only autocompletes paths that actually exist on the `posts` collection — a guarantee neither Payload's function-based access nor Strapi's string permissions provide.

| Concept             | KernelCMS                | Payload                  | Strapi        | Sanity                           |
| ------------------- | ------------------------ | ------------------------ | ------------- | -------------------------------- |
| Roles in code       | Yes (`kernel.config.ts`) | Functions per collection | DB + admin UI | Dashboard (fixed tiers + custom) |
| Field-level grants  | Yes, typed paths         | Yes, via functions       | Limited       | Document-level only              |
| ABAC conditions     | First-class              | Manual in functions      | No            | Limited (filters)                |
| Compile-time safety | Full                     | Partial                  | None          | None                             |

## The RBAC Model

RBAC is the fast path. Given a subject's roles, the resolver compiles a flattened **permission set** at session creation and caches it on the request. Most reads and writes are decided here without ever touching the database or running a single condition function.

A subject (a user or API key) carries one or more roles. Roles compose additively: the effective permission set is the union of every role's grants, then minus any explicit denies.

```
subject.roles ──► [ grants of role A ]
                  [ grants of role B ]   ──► union ──► explicit denies ──► permissionSet
                  [ grants of role C ]                  (subtracted)
```

Denies are explicit and always win at the RBAC layer. This lets you build "everything except" roles without enumerating every grant — useful for a `contractor` role that mirrors `editor` but can never `delete` or touch the `billing` global.

```ts
contractor: {
  label: 'Contractor',
  inherits: ['editor'],          // start from editor's grants
  grants: [],
  denies: ['delete:posts', '*:globals.billing'],
}
```

Role inheritance (`inherits`) is resolved breadth-first and is acyclic — the config compiler rejects cycles at build time. Inheritance is grant composition only; a child cannot weaken a parent's deny, which keeps "remove a dangerous capability" reasoning sound. When the resolver needs to answer `can(subject, 'update', 'posts.fields.slug')`, it checks the cached set:

```ts
import { resolveAccess } from '@kernel/auth'

const verdict = resolveAccess({
  subject,
  action: 'update',
  scope: 'posts.fields.slug',
})
// → { allowed: true, decidedBy: 'rbac', matchedGrant: 'update:posts' }
```

This is structurally different from Payload, where access is a per-collection function you write (`access: { update: ({ req }) => Boolean(req.user) }`). Payload's model is flexible but gives you no role registry, no inheritance, and no way to introspect "what can this role do?" without executing every function. KernelCMS keeps the declarative role registry _and_ the function escape hatch — the latter lives in the ABAC layer.

## ABAC Conditions

RBAC answers "can this role, in principle, perform this action?" ABAC answers "given _this_ request and _this_ document, should it be allowed _now_?" Conditions are attached to grants and receive a typed context: the subject, the document (on writes and document reads), the request (locale, IP, headers), and the environment.

```ts
import { defineRoles, where } from '@kernel/auth'

export const roles = defineRoles({
  author: {
    label: 'Author',
    grants: [
      'read:posts',
      {
        action: 'update',
        scope: 'posts',
        // Authors may only edit their own unpublished drafts.
        when: ({ subject, doc }) => doc.authorId === subject.id && doc.status === 'draft',
      },
      {
        action: 'read',
        scope: 'posts.fields.internalNotes',
        // Field-level ABAC: hide a field unless you own the doc.
        when: ({ subject, doc }) => doc.authorId === subject.id,
      },
    ],
  },
})
```

Conditions come in two flavors, and choosing correctly is a performance decision:

- **Predicate conditions** (`when`) run in-process and return `boolean | Promise<boolean>`. They see the full document. Use them for field-level checks and post-fetch decisions.
- **Filter conditions** (`where`) return a query constraint in KernelCMS's shared query language and are pushed down into the adapter's `WHERE` clause. They never load disallowed rows, so list endpoints stay fast and never leak counts.

```ts
{
  action: 'read',
  scope: 'posts',
  // Translated into SQL/Mongo by the active @kernel/db adapter.
  filter: ({ subject }) =>
    where('tenantId').eq(subject.tenantId),
}
```

The `filter` form is what makes KernelCMS scale where Strapi's RBAC struggles: Strapi can scope fields and actions but cannot express "rows owned by the requesting tenant" without custom controller code. Sanity approximates this with document filters in role definitions, but they are not type-checked against your schema and cannot reference arbitrary request attributes. In KernelCMS, `filter` and `predicate` conditions share the exact query language used by REST, GraphQL, and the Local/RPC API, so a `where('tenantId').eq(...)` means the same thing everywhere.

Conditions are pure and must not perform writes. Async predicates are allowed (e.g. a membership lookup against `@kernel/db`), but they are memoized per request to avoid N+1 evaluation across a paginated result set.

## Permission Resolution Order

The resolver is a fixed pipeline. Order is normative: every adapter and every API surface produces the identical verdict for the same inputs, which is what makes access control auditable. Deny-by-default is the ground state — an action with no matching grant is denied.

```
   ┌─────────────────────────────────────────────────────────┐
   │ 1. Authenticate subject (session / API key / anon)       │
   │ 2. Compile permissionSet from roles (RBAC, cached)        │
   │ 3. Match (action, scope) → candidate grants               │
   │ 4. Explicit RBAC deny?  ── yes ─► DENY (stop)             │
   │ 5. No matching grant?   ── yes ─► DENY (default)          │
   │ 6. Evaluate ABAC: filter conditions → pushed to query     │
   │ 7. Evaluate ABAC: predicate conditions on document        │
   │ 8. Field-level conditions strip/redact fields             │
   │ 9. ALLOW (with field mask + query filter applied)         │
   └─────────────────────────────────────────────────────────┘
```

Three rules govern combination:

1. **Explicit deny beats any grant.** A `deny` at step 4 short-circuits before ABAC runs. You cannot ABAC your way back into a denied capability.
2. **Grants are OR-combined; conditions on a single grant are AND-combined.** If two grants both match an action/scope, the subject is allowed if _either_ grant's conditions pass. Within one grant, every `when`/`filter`/`role-condition` must pass.
3. **Operation-level runs before document-level, which runs before field-level.** A failed operation check (e.g. `create:posts` denied) never fetches a document; a failed document check never reaches field masking. This ordering is what prevents the timing and existence leaks that naive "fetch then check" implementations ship with.

```ts
const result = await access.evaluate({
  subject,
  operation: 'update',
  collection: 'posts',
  docId,
  data,
})

if (!result.allowed) {
  throw new ForbiddenError(result.reason) // typed error, no detail leak
}

// result.fieldMask lists fields the subject may not write — the
// operation core silently drops them rather than failing the whole write.
const sanitized = applyFieldMask(data, result.fieldMask)
```

Field-level resolution (step 8) is **redact, not reject** by default: a write to a forbidden field is dropped from the payload, and a read of a forbidden field is omitted from the response. This matches how an experienced team actually wants partial-permission UIs to behave, and it mirrors Payload's field-level access while adding the declarative role registry Payload lacks. The behavior is configurable to `strict` (reject the whole operation) per field where silent dropping would be surprising.

The full evaluation is exposed through `@kernel/auth`'s `access.evaluate` and `access.explain` APIs. `explain` returns the matched grant, the deciding condition, and the resolution step, so the admin can render _why_ a button is disabled — feeding the command palette and the disabled-state tooltips described in [Admin Permissions UX](../04-admin-ui/11-command-palette-and-keyboard.md).

## Open Questions

- **Role assignment storage.** Roles are config; the subject→role mapping is data. We have not finalized whether assignments live in the `users` collection, a dedicated `@kernel/auth` table, or an external IdP claim. For KernelCMS Cloud multi-tenant, claims-from-IdP is likely the default.
- **Condition portability across adapters.** `filter` conditions push down cleanly to Drizzle (Postgres/SQLite/MySQL) and MongoDB, but exotic operators (full-text, geo `point` radius) may not have parity. We may need a capability negotiation so a `filter` falls back to a post-fetch `predicate` when the adapter can't express it — at a stated performance cost.
- **Caching invalidation for async predicates.** Per-request memoization is settled; cross-request caching of membership lookups (with correct invalidation on role change) is not.
