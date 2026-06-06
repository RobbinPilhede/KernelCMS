# Relationship Fields

Relationships are the spine of any content model. KernelCMS treats them as a first-class field type backed by the active database adapter, not as a bolted-on convenience. The `relationship` field models edges between documents — a post to its author, an order to its line items, a media block to many possible content types — and the same configuration drives REST, GraphQL, and the typed Local/RPC API identically. This document covers the four shapes you will reach for in practice: to-one, to-many, polymorphic, and bi-directional joins, plus how population and `depth` control what crosses the wire.

## Relationship config

A relationship field declares which collection(s) it points at and whether it holds one or many references. Everything else — the foreign key, the join table, the GraphQL type, the admin combobox — is generated from that declaration.

```ts
// kernel.config.ts
import { defineCollection } from '@kernel/core'

export const Posts = defineCollection({
  slug: 'posts',
  fields: [
    { name: 'title', type: 'text', required: true },
    {
      name: 'author',
      type: 'relationship',
      relationTo: 'users',     // to-one
      required: true,
      maxDepth: 1,
    },
    {
      name: 'categories',
      type: 'relationship',
      relationTo: 'categories',
      hasMany: true,           // to-many
      min: 1,
      max: 5,
    },
  ],
})
```

The stored shape mirrors the declaration. A to-one relationship persists the related document's ID; a to-many persists an ordered list. On SQL adapters (`@kernel/db-postgres`, `@kernel/db-sqlite`, `@kernel/db-mysql`) a to-one becomes a foreign-key column and a to-many becomes a junction table with a stable `_order` column — order is content, so we never let the database scramble it. On `@kernel/db-mongodb` the same fields become an ObjectId and an array of ObjectIds.

| Option | Type | Effect |
| --- | --- | --- |
| `relationTo` | `string \| string[]` | Target collection slug, or array for polymorphic |
| `hasMany` | `boolean` | List vs. single reference; controls storage shape |
| `min` / `max` | `number` | Cardinality bounds, enforced server-side |
| `maxDepth` | `number` | Per-field population ceiling (see depth control) |
| `filterOptions` | `function` | Constrains selectable documents in the admin and on write |
| `on` | `string` | Marks the field as a virtual join (see bi-directional) |

`filterOptions` is where KernelCMS earns its keep over Strapi, whose relation pickers are effectively unconstrained without custom plugins. It runs server-side and feeds both the admin combobox query and write validation, so a curated relationship cannot be bypassed by hitting the API directly:

```ts
{
  name: 'relatedPosts',
  type: 'relationship',
  relationTo: 'posts',
  hasMany: true,
  filterOptions: ({ id, data }) => ({
    // Exclude self and anything in draft
    id: { not_equals: id },
    status: { equals: 'published' },
    tenant: { equals: data.tenant },
  }),
}
```

The returned object is an ordinary `where` clause in the shared query language — the same syntax you use for list queries — so there is nothing new to learn.

## Polymorphic relationships

A polymorphic relationship targets more than one collection. Pass an array to `relationTo` and KernelCMS stores both the relation and its target collection, so the reference is unambiguous on read-back.

```ts
{
  name: 'attachment',
  type: 'relationship',
  relationTo: ['media', 'documents', 'externalLinks'],
  // hasMany works here too, for mixed lists
}
```

The persisted value is a discriminated pair rather than a bare ID:

```ts
// Stored / returned (unpopulated)
{ relationTo: 'media', value: 'a1b2c3' }

// Populated at depth >= 1
{ relationTo: 'media', value: { id: 'a1b2c3', url: '/u/cover.webp', alt: 'Cover' } }
```

```
attachment (relationTo: ['media','documents','externalLinks'])
        │
   ┌────┴─────┬──────────────┐
   ▼          ▼              ▼
 media    documents    externalLinks
 (a1b2c3)  (...)         (...)
```

On SQL adapters this needs a `(relationTo, value)` column pair, since a single foreign key cannot reference three tables. The adapter generates a discriminator column alongside the ID column and indexes the pair. On MongoDB the same shape lives in a sub-document. This is the same model Payload uses, and we keep it deliberately compatible — but KernelCMS pushes the discriminator into the type system end to end. The Local API infers a tagged union per relationship, so a `switch (attachment.relationTo)` narrows `attachment.value` to the right document type with zero casts and no `any`:

```ts
const post = await kernel.posts.findById({ id, depth: 1 })

switch (post.attachment.relationTo) {
  case 'media':
    return post.attachment.value.url        // typed as Media
  case 'documents':
    return post.attachment.value.fileSize   // typed as Document
  case 'externalLinks':
    return post.attachment.value.href        // typed as ExternalLink
}
```

Sanity models this with its `reference` type plus `_type` discrimination inside GROQ, which is powerful but pushes the discrimination into a query language you have to hand-write. KernelCMS gives you the discriminated union at the call site in plain TypeScript.

## Bi-directional joins

Storing a relationship on one side and reading it from both is the join problem. KernelCMS solves it with a virtual `join` field — declared via the `on` option — that owns no storage and is computed by querying the inverse side.

```ts
// Posts owns the foreign key
export const Posts = defineCollection({
  slug: 'posts',
  fields: [
    { name: 'author', type: 'relationship', relationTo: 'users' },
  ],
})

// Users exposes the reverse edge without storing it
export const Users = defineCollection({
  slug: 'users',
  fields: [
    { name: 'name', type: 'text' },
    {
      name: 'posts',
      type: 'join',
      collection: 'posts',
      on: 'author',          // the field on Posts that points back here
      hasMany: true,
    },
  ],
})
```

```
Posts.author  ──────────────►  Users.id
                               Users.posts (join, on: 'author')
      ▲                                │
      └──────── computed query ────────┘
```

The `join` field is read-only and paginated. Asking for `users.findById({ id, depth: 1 })` issues a bounded `posts where author = id` query rather than dragging every related row into memory — a real difference from naive ORM `include`s that fan out unboundedly. You control the page with the same knobs as any list:

```ts
const user = await kernel.users.findById({
  id,
  depth: 1,
  joins: {
    posts: { limit: 10, sort: '-publishedAt', where: { status: { equals: 'published' } } },
  },
})

user.posts.docs        // Post[]
user.posts.totalDocs   // number
user.posts.hasNextPage // boolean
```

Because the join is computed from the forward field, there is exactly one source of truth. There is no second column to keep in sync and therefore no drift — the failure mode that plagues hand-rolled inverse fields in Strapi, where the two sides can disagree after a partial write. Payload added a comparable `join` field; KernelCMS matches the ergonomics and adds typed `joins` arguments plus per-join `where` filtering on every surface.

## Population and depth control

Unpopulated, a relationship is just an ID (or a `{ relationTo, value }` pair). Populated, it is the full related document. `depth` decides how many hops of population to follow, and it is the single most important performance lever in the API.

```ts
// depth: 0 — IDs only, one query, fastest
await kernel.posts.findById({ id, depth: 0 })
// → { author: 'u_42', categories: ['c_1','c_2'] }

// depth: 1 — relations populated one level
await kernel.posts.findById({ id, depth: 1 })
// → { author: { id:'u_42', name:'Ada' }, categories: [{ id:'c_1', ... }] }

// depth: 2 — relations of relations
await kernel.posts.findById({ id, depth: 2 })
// → author.organization is now an object, not an ID
```

`depth` is a request-level default; `maxDepth` on a field is a hard ceiling that the request cannot exceed. Set `maxDepth: 0` on a high-fan-out relationship (say, `relatedPosts`) and it will never auto-populate no matter what the caller asks, which stops a single document fetch from cascading into hundreds of joins.

```
findById(post, depth: 2)
post
 ├─ author ─────────► user (depth 1)
 │    └─ organization ─► org (depth 2)        ← stops here
 └─ categories[] ────► category (depth 1)
      └─ parent ──────► category (depth 2)    ← stops here
```

Resolution differs by surface but the semantics are identical:

| Surface | How population is requested | Notes |
| --- | --- | --- |
| Local / RPC | `depth` argument + typed `select` | Inference reflects the requested depth |
| REST | `?depth=2` query param | Capped by each field's `maxDepth` |
| GraphQL | Field selection set | Depth is implicit in what you select; resolvers batch via DataLoader |

GraphQL never needs a numeric `depth` because the selection set already says exactly which related fields to resolve, and the resolver layer batches sibling lookups to avoid the N+1 problem. For REST and the Local API, KernelCMS uses the adapter's batch-load path so that populating 50 posts' authors is one `where id in (...)` query, not 50 round-trips.

Pair `depth` with `select` to keep payloads lean — populate the relation but only the columns you render:

```ts
await kernel.posts.find({
  depth: 1,
  select: { title: true, author: { name: true, avatar: true } },
})
```

This composition — bounded depth, per-field ceilings, batched loads, and column selection — is how KernelCMS keeps relationship-heavy reads predictable. Sanity leans on GROQ projections to achieve the same shaping; the trade-off is that the shape lives in query strings rather than in typed call sites. KernelCMS keeps the shaping typed and co-located with the rest of your data layer.

## Open questions

- **Many-to-many ordering across both sides.** A join table carries `_order` for the owning side. Whether the inverse `join` field should expose a separately persisted ordering (rather than sorting by an inverse-side field) is undecided; it adds a second order column and a sync concern we have so far avoided.
- **Cascade-on-delete policy.** We currently null dangling references and surface them as `null` after population. A configurable `onDelete: 'restrict' | 'cascade' | 'setNull'` per field is proposed but not finalized for the MongoDB adapter, where referential actions are not enforced by the engine.
- **Cross-database relationships.** Relationships that span two different adapters (e.g. a Postgres collection referencing a MongoDB collection) are explicitly out of scope for v1, but the discriminator model leaves the door open. No commitment yet on whether the join would be application-resolved or rejected at config-validation time.
