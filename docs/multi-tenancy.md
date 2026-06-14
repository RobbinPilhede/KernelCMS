# Multi-tenancy

Run many clients, sites, or workspaces on **one** KernelCMS instance, with **airtight
per-tenant data isolation** — and no per-collection access boilerplate. Opt into
`tenancy` and each scoped collection gets a server-managed `tenant` field plus an
auto-injected tenant scope, so every read and write is silently filtered to the caller's
tenant. A tenant A principal can never see, list, count, change, or even learn of tenant
B's content.

This is the SaaS-on-KernelCMS and agency enabler: one deploy, one database, one config,
many tenants — isolated by construction rather than by access rules you have to remember to
write on every collection.

## The concept

A *tenant* is whatever you partition by — a customer, a site, a workspace, a brand. With
tenancy on, KernelCMS treats a scoped collection as if every tenant had its own private
copy of it, while it all lives in one set of tables:

- A server-managed `tenant` field is added to each scoped collection.
- A tenant scope is **AND-combined** into that collection's access rules — it narrows your
  rules, it never widens them.
- The acting tenant is resolved from the **authenticated principal**, so the filter
  follows *who is asking*, not what they ask for.

The result: `find`, `findByID`, `update`, `delete`, and `count` are all automatically
scoped, with zero per-collection work.

## Opt in

Tenancy is off until you enable it. Add a `tenancy` block to the config:

```ts
export default defineConfig({
  tenancy: {
    field: 'tenant',           // the server-managed scope field (default 'tenant')
    // collections: ['posts'], // which collections are scoped (default: all non-system, non-auth)
    requireTenant: true,       // tenant-less principal → denied scoped content (default true, fail-closed)
    resolve: (req) => req.user?.tenant ?? null, // how the acting tenant is derived (this is the DEFAULT)
  },
  collections: [/* … */],
})
```

| Option          | Default                            | Meaning                                                                              |
| --------------- | ---------------------------------- | ------------------------------------------------------------------------------------ |
| `field`         | `'tenant'`                         | Name of the server-managed scope field added to each scoped collection.              |
| `collections`   | all non-system, non-auth           | Which collections are tenant-scoped. Omit to scope every eligible collection.        |
| `requireTenant` | `true`                             | When `true`, a principal with no tenant claim is denied scoped content (fail-closed). |
| `resolve`       | `(req) => req.user?.tenant ?? null` | How the **acting** tenant is derived. Must come from trusted/authenticated state.    |

## How the tenant is resolved — and the one rule

The acting tenant comes from the **authenticated principal** — by default
`req.user.tenant`. This is the whole security model, so the rule is absolute:

> **The tenant is NEVER read from client input.** Not a query param, not a body field, not
> a header. It is derived only from trusted, authenticated state.

The normal path is to put a `tenant` value on each user record; it flows into
`req.user.tenant` when they authenticate, and `resolve` picks it up. If you need a
different source — say a subdomain — supply a custom `resolve`, but it **must** map to a
*verified* tenant from trusted state:

```ts
tenancy: {
  // a subdomain mapped to a tenant the request is actually authorized for —
  // resolved from authenticated/verified state, never raw `Host`/input you trust blindly
  resolve: (req) => req.user?.tenant ?? tenantForVerifiedHost(req) ?? null,
}
```

If `resolve` returns `null` and `requireTenant` is `true`, the principal is tenant-less and
sees nothing in scoped collections (see [Fail-closed](#fail-closed-tenant-less-principals)).

## The auto-field, auto-scope, and auto-stamp

For each scoped collection, KernelCMS does three things for you:

1. **Auto-adds the `tenant` field** — server-managed, so a client can't declare or
   overwrite it.
2. **Auto-injects a tenant scope** into the collection's read/create/update/delete access,
   **AND-combined** with your own rules. Your access still runs in full; the tenant filter
   is layered *on top*, so it can only ever narrow what a caller sees, never broaden it.
3. **Auto-stamps the tenant on create** from the caller's resolved tenant, and treats it as
   **immutable on update** — a write that tries to set or change `tenant` is stripped, so a
   document can never be created in, or moved to, another tenant.

Because the scope rides the **existing access pipeline**, every operation — Local API,
REST, GraphQL, search, graph traversal — is filtered the same way, with no second code path
to keep in sync.

## Fail-closed: tenant-less principals

With `requireTenant: true` (the default), a principal whose `resolve` yields no tenant is
**denied all scoped content** — reads return nothing, writes are rejected. KernelCMS fails
**closed**: the absence of a tenant claim means *no access*, never *all access*. The only
caller that sees across tenants is a trusted system caller (next section).

## The `overrideAccess` escape hatch

Trusted server code — migrations, admin tooling, cross-tenant maintenance — needs to step
outside the per-tenant view. That is exactly what `overrideAccess` is for: every Local API
operation accepts `overrideAccess: true`, which **bypasses the tenant scope** (along with
all other access checks) and runs as a trusted system caller. Over HTTP the equivalent is
the API-key bearer token.

```ts
// admin tooling: read across every tenant
const all = await kernel.find({ collection: 'posts', overrideAccess: true })

// migration: backfill a tenant onto existing rows
await kernel.update({ collection: 'posts', id, data: { tenant: 'acme' }, overrideAccess: true })
```

This is the **only** bypass. Use it in seeds, migrations, jobs, and trusted server code —
**never** with untrusted input. No client-facing request can reach it.

## No cross-tenant leak through populate

Relationships are filtered too. When a document in tenant A references a document in
tenant B (e.g. a stale or seeded relationship), populating that relationship goes through
the same access-checked read path — so the cross-tenant target is **not** expanded. The
field resolves to a **bare id**, never the foreign document's content, so a relationship
can never become a side channel that leaks another tenant's data.

## Worked example: two tenants on one instance

A `tenant` claim on users, a scoped `posts` collection, and two callers who each see only
their own.

```ts
import { defineConfig } from 'kernelcms'
import { sqliteAdapter } from 'kernelcms/sqlite'

export default defineConfig({
  secret: process.env.KERNEL_SECRET ?? 'dev-only-secret',
  db: sqliteAdapter({ url: 'file:./content.db' }),
  tenancy: {
    // defaults are fine: field 'tenant', all non-auth collections scoped,
    // requireTenant true, resolve = req.user?.tenant
  },
  collections: [
    {
      slug: 'users',
      auth: true,
      // the tenant claim lives on the user; it flows into req.user.tenant on auth
      fields: [{ name: 'tenant', type: 'text', required: true }],
    },
    {
      // scoped automatically — no tenant field or tenant access rule declared here
      slug: 'posts',
      access: { read: ({ req }) => Boolean(req.user) },
      fields: [{ name: 'title', type: 'text', required: true }],
    },
  ],
})
```

Provision two users in different tenants and give each a post (system caller, so it can set
`tenant` directly):

```ts
await kernel.create({ collection: 'users', data: { email: 'a@acme.com',  password, tenant: 'acme'  }, overrideAccess: true })
await kernel.create({ collection: 'users', data: { email: 'b@globex.com', password, tenant: 'globex' }, overrideAccess: true })

// the tenant is auto-stamped from the caller — no need to pass it
const acmeReq   = { user: await loginAs('a@acme.com') }    // req.user.tenant === 'acme'
const globexReq = { user: await loginAs('b@globex.com') }  // req.user.tenant === 'globex'

await kernel.create({ collection: 'posts', data: { title: 'Acme launch' },   req: acmeReq })
await kernel.create({ collection: 'posts', data: { title: 'Globex memo'  },   req: globexReq })
```

Now read as each — and each sees only their own:

```ts
const acme   = await kernel.find({ collection: 'posts', req: acmeReq })
// → [{ title: 'Acme launch',  tenant: 'acme' }]   — the Globex post is invisible

const globex = await kernel.find({ collection: 'posts', req: globexReq })
// → [{ title: 'Globex memo',  tenant: 'globex' }] — the Acme post is invisible

// cross-tenant access by id resolves to nothing — as if it did not exist:
await kernel.findByID({ collection: 'posts', id: acmePostId, req: globexReq }) // → null (NotFound over HTTP)

// a client cannot move a document into another tenant — `tenant` is stripped on update:
await kernel.update({ collection: 'posts', id: acmePostId, data: { tenant: 'globex' }, req: acmeReq })
// → still tenant 'acme'
```

Over HTTP the same holds: a request authenticated as the Acme user only ever lists, counts,
reads, updates, or deletes Acme posts, regardless of any `?tenant=`, body `tenant`, or
header it sends — those are ignored entirely.

## The guarantees

The acting tenant is **principal-derived** — `req.user.tenant` by default, never client
input — and the scope **AND-combines** with your access (it never widens it). On that base:

- **No cross-tenant read/list/count.** A tenant A principal can never read, list, or count
  tenant B's content; a cross-tenant `findByID` resolves to nothing (`NotFound`).
- **No cross-tenant write.** A client can never create or move a document into another
  tenant — `tenant` is auto-stamped on create and immutable (stripped) on update.
- **Fail-closed.** A tenant-less principal sees nothing in scoped collections (with
  `requireTenant: true`).
- **No populate leak.** A cross-tenant relationship target is access-filtered to a bare id,
  never expanded.
- **One bypass only.** `overrideAccess` / a trusted system caller (migrations, admin
  tooling) is the sole way across tenants.

Red-teamed across **35 cross-tenant attacks** to **Risk LOW**, zero leaks. Tenancy pairs
naturally with [access control](conventions.md#access-is-deny-by-default) and
[authentication](conventions.md) — it rides the exact same pipeline.
