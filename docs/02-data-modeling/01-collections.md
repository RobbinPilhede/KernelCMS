# Collections

Collections are KernelCMS's repeatable content types — the equivalent of a Payload collection, a Sanity document type, or a Strapi content-type. You define them in code inside `kernel.config.ts`, and `@kernel/core` turns each one into a database table (or MongoDB collection), a typed Local API, REST and GraphQL endpoints, an admin list view, and a document edit form. This page covers the config shape, slugs and labels, admin options, and the per-collection access and hooks that make a collection behave the way you want in production.

## The config shape

A collection is a plain object that satisfies the `CollectionConfig` type exported from `@kernel/core`. Config-as-code is the single source of truth here: there is no UI-driven schema builder writing to a hidden database table the way Strapi's content-type builder does. Your schema lives in version control, diffs cleanly in pull requests, and generates migrations deterministically (see [Migrations](../03-persistence/08-migrations-engine.md)).

```ts
// kernel.config.ts
import { defineConfig } from '@kernel/core'
import { postgresAdapter } from '@kernel/db-postgres'
import type { CollectionConfig } from '@kernel/core'

const Posts: CollectionConfig = {
  slug: 'posts',
  labels: { singular: 'Post', plural: 'Posts' },
  fields: [
    { name: 'title', type: 'text', required: true },
    { name: 'slug', type: 'text', required: true, unique: true, index: true },
    { name: 'body', type: 'richText' },
    { name: 'author', type: 'relationship', relationTo: 'users' },
    { name: 'publishedAt', type: 'date' },
  ],
  admin: {
    useAsTitle: 'title',
    defaultColumns: ['title', 'author', 'publishedAt', '_status'],
    group: 'Content',
  },
  versions: { drafts: true, autosave: { interval: 800 } },
  access: { read: () => true },
}

export default defineConfig({
  db: postgresAdapter({ url: process.env.DATABASE_URL }),
  collections: [Posts],
})
```

The full surface of `CollectionConfig` is small and orthogonal. Every key is optional except `slug` and `fields`.

| Key | Type | Purpose |
| --- | --- | --- |
| `slug` | `string` | Stable identifier; table name, API path, and type key. |
| `fields` | `Field[]` | Field definitions. See [Field Types](./04-field-types-catalog.md). |
| `labels` | `{ singular; plural }` | Human-readable names for the admin UI. |
| `admin` | `AdminConfig` | List/edit UI behaviour. |
| `access` | `AccessConfig` | Operation- and document-level authorization. |
| `hooks` | `HookConfig` | Lifecycle interception points. |
| `versions` | `VersionsConfig` | Drafts, autosave, version history. |
| `timestamps` | `boolean` | Adds `createdAt`/`updatedAt` (default `true`). |
| `auth` | `AuthConfig` | Promotes the collection to an auth-enabled collection. |
| `upload` | `UploadConfig` | Turns it into a [media](../07-media-files/00-media-and-uploads-overview.md) collection. |
| `defaultSort` | `string` | Default sort field for queries and the list view. |
| `indexes` | `CompoundIndex[]` | Multi-column and partial indexes. |

`defineConfig` infers a fully typed schema from this object. Every generated surface — the Local API in [`@kernel/client`](../05-api/03-typed-rpc-and-local-api.md), the [REST](../05-api/01-rest-api.md) routes, the [GraphQL](../05-api/02-graphql-api.md) types, and the admin forms — derives its types from the same source. `kernel generate:types` writes a `kernel-types.d.ts` so `payload.find({ collection: 'posts' })`-style calls return `Post`, not `any`. This is the type-safety story Strapi never had and Payload retrofitted; in KernelCMS it is the foundation, with zero `any` in the generated output.

```
kernel.config.ts
      │  defineConfig()
      ▼
  ┌─────────────────────────────────────────────┐
  │  @kernel/core  (operation core)             │
  └───┬───────┬────────┬─────────┬──────────────┘
      │       │        │         │
      ▼       ▼        ▼         ▼
   Drizzle  REST   GraphQL   Local/RPC   →  Admin (TanStack)
   schema   routes  schema   (typed)        Table + Form
```

## Slugs and labels

The `slug` is the most load-bearing string in a collection. It becomes the SQL table name (or Mongo collection), the REST path segment (`/api/posts`), the GraphQL field root (`Posts`, `Post`, `createPost`), the key in `payload.find({ collection: 'posts' })`, and the relationship target in other collections (`relationTo: 'posts'`). Because so much hangs off it, KernelCMS treats the slug as immutable infrastructure, not a label.

- Use lowercase, hyphen-free, plural identifiers: `posts`, `media`, `landingPages`. The convention is `camelCase` when multi-word, matching the generated GraphQL/TS identifiers.
- The slug must be unique across collections **and** globals — they share one namespace because a relationship can point at either.
- Renaming a slug is a breaking change. It produces a table rename in the generated migration and invalidates any persisted relationship references and external API consumers. Treat it like renaming a database table, because it is one. There is no auto-redirect; that is intentional, the same way Payload refuses to silently remap a slug.

`labels` are the opposite — purely cosmetic, freely editable, and never touch the database. They drive the admin nav, the "Create new Post" button, breadcrumbs, and toasts. Sanity collapses this into a single `title`; KernelCMS keeps singular and plural distinct so the UI reads naturally ("1 Post" vs "12 Posts") without English-pluralization guessing. Labels are localizable for the admin UI:

```ts
labels: {
  singular: { en: 'Article', de: 'Artikel', ar: 'مقالة' },
  plural:   { en: 'Articles', de: 'Artikel', ar: 'مقالات' },
}
```

When `labels` is omitted, KernelCMS derives them from the slug by title-casing and naively pluralizing, which is fine for prototypes and wrong often enough that you should set them explicitly before shipping.

## Admin options

The `admin` block controls how a collection presents in the React admin app built on TanStack Start. None of it affects the API or storage — it is pure presentation, so you can iterate on it without migrations.

```ts
admin: {
  useAsTitle: 'title',
  defaultColumns: ['title', 'author', 'publishedAt', '_status'],
  defaultSort: '-publishedAt',
  group: 'Content',
  description: 'Blog posts and editorial content.',
  pagination: { defaultLimit: 25, limits: [10, 25, 50, 100] },
  listSearchableFields: ['title', 'slug'],
  hidden: ({ user }) => user?.role !== 'editor',
  components: {
    BeforeList: ['./admin/PostsBanner'],
    edit: { SaveButton: './admin/PublishButton' },
  },
}
```

| Option | Effect |
| --- | --- |
| `useAsTitle` | Field used as the document's display label in lists, relationships, and breadcrumbs. |
| `defaultColumns` | Initial [TanStack Table](../04-admin-ui/05-collection-list-views.md) columns. Users can reorder, resize, and hide; their choice persists per user. |
| `defaultSort` | Default sort; `-` prefix for descending. |
| `group` | Groups collections under a heading in the sidebar nav. |
| `listSearchableFields` | Fields the list-view search box queries. |
| `pagination` | Page-size defaults and the allowed page-size menu. |
| `hidden` | Hide from nav, statically (`boolean`) or per-user (`({ user }) => boolean`). |
| `components` | Swap in custom React components at named slots — the escape hatch. |

The list view is a real [TanStack Table](../04-admin-ui/05-collection-list-views.md) with column sizing, multi-sort, server-driven filtering, and [TanStack Virtual](../04-admin-ui/05-collection-list-views.md) row virtualization, so a collection with 200k rows scrolls without paginating you into a corner. The edit view is a TanStack Form bound field-by-field to your schema. Search-param state (filters, sort, page) is owned by TanStack Router, so any admin view is a shareable, bookmarkable URL — something Strapi's admin and Sanity's Studio both make awkward.

`components` is the deliberate escape hatch. Where Sanity pushes you toward fully custom Studio components for anything non-trivial, KernelCMS gives you a config-driven UI that covers the common cases and named slots (`BeforeList`, `SaveButton`, field-level `Cell` and `Field`) for when you need to drop down. You override the 5% without rebuilding the 95%.

## Per-collection access and hooks

Access control and hooks are where a collection stops being a schema and becomes a system. Both are defined per collection and run **server-side, on by default** — there is no path that skips them, including the in-process Local API.

### Access control

`access` is a set of functions, one per operation, each returning a `boolean` or a **query constraint**. Returning a constraint is the feature that makes row-level authorization ergonomic: instead of "can this user read posts?" you express "this user can read *these* posts," and the constraint is merged into the `where` clause of every query across REST, GraphQL, and Local API.

```ts
import type { Access } from '@kernel/core'

const isOwnerOrAdmin: Access<Post> = ({ req: { user } }) => {
  if (!user) return false
  if (user.role === 'admin') return true
  // Non-admins only ever see their own posts — enforced as a query filter.
  return { author: { equals: user.id } }
}

const Posts: CollectionConfig = {
  slug: 'posts',
  access: {
    read: isOwnerOrAdmin,
    create: ({ req: { user } }) => Boolean(user),
    update: isOwnerOrAdmin,
    delete: ({ req: { user } }) => user?.role === 'admin',
    readVersions: ({ req: { user } }) => user?.role === 'admin',
  },
  fields: [/* … */],
}
```

| Operation | Returns | When evaluated |
| --- | --- | --- |
| `create` | `boolean` | Before insert. |
| `read` | `boolean \| Where` | Folded into every find query. |
| `update` | `boolean \| Where` | Constrains updatable documents. |
| `delete` | `boolean \| Where` | Constrains deletable documents. |
| `readVersions` | `boolean \| Where` | Gates version-history access. |

Field-level access (`field.access.read` / `.update`) composes on top, so a non-admin can read a post but never see its `internalNotes` field. Because constraints run inside the query rather than filtering results after the fetch, there is no IDOR window and no over-fetch. Payload pioneered this returns-a-query pattern; KernelCMS keeps it and extends it to the field level and to the version-history surface uniformly. See [Access Control](../06-auth-security/01-authorization-and-access-control.md) for the full evaluation order.

### Hooks

Hooks intercept the operation lifecycle. They are ordered, async, and receive the same typed `req` context as access functions. Field hooks run inside the document hooks, so transformation happens in one predictable pass.

```ts
hooks: {
  beforeValidate: [({ data }) => data],
  beforeChange: [
    ({ data, req }) => {
      if (req.user) data.lastEditedBy = req.user.id
      return data
    },
  ],
  afterChange: [
    async ({ doc, operation }) => {
      if (operation === 'create') await req.queue.enqueue('post.created', { id: doc.id })
    },
  ],
  beforeDelete: [/* … */],
  afterRead: [/* redact, decorate, compute virtuals */],
}
```

| Hook | Fires | Common use |
| --- | --- | --- |
| `beforeOperation` | Entry, all writes/reads | Mutate args, short-circuit. |
| `beforeValidate` | Before field validation | Normalize/coerce input. |
| `beforeChange` | After validation, before persist | Stamp metadata, derive fields. |
| `afterChange` | After persist | Enqueue jobs, invalidate cache, webhooks. |
| `beforeRead` / `afterRead` | Around reads | Compute virtuals, redact. |
| `beforeDelete` / `afterDelete` | Around deletes | Cascade, audit log. |

Side effects belong in `afterChange`, dispatched through the swappable queue adapter rather than run inline — keep the write path fast and let the worker handle the rest. Strapi's lifecycle hooks live in service files away from the schema; KernelCMS keeps hooks colocated with the collection that owns them, so the contract and its behaviour read top to bottom in one file.

## Open questions

- **Slug aliasing.** Should we allow an optional `apiSlug` distinct from the storage slug, so a table rename doesn't break external REST/GraphQL consumers? Leaning yes for a 2.x minor, gated behind explicit opt-in to avoid a second source of truth.
- **Hidden vs. access.** `admin.hidden` and `access.read` overlap conceptually for "don't show this." We may formally document `hidden` as cosmetic-only and forbid relying on it for authorization, with a lint rule that flags `hidden` used as a security boundary.
- **Per-collection cache TTLs.** Whether cache invalidation config belongs in `CollectionConfig` or stays in the cache adapter is unresolved; colocating it reads well but couples the schema to an infrastructure concern we otherwise keep swappable.
