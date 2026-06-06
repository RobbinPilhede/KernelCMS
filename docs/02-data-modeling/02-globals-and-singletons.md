# Globals & Singletons

Globals are single-instance content types: there is exactly one site-settings document, one main navigation, one homepage hero config. Where a [collection](./01-collections.md) is a table with N rows, a global is a single row that always exists. KernelCMS models globals as first-class `kernel.config.ts` entities with the same field system, validation, localization, drafts, versioning, and access control as collections — but with operations narrowed to read and update, because there is nothing to create or delete. This document specifies how globals are declared, when to reach for them, how their version history behaves, and how access control is evaluated against a singleton.

## What a Global Is

A global is a named singleton document keyed by its `slug`. It has no list view, no `id`-based addressing, and no `create`/`delete` operations. The Local API surface reflects that:

```ts
// Collections expose the full CRUD surface
await payload.create({ collection: 'posts', data })
await payload.find({ collection: 'posts', where })

// Globals expose only read + update
const settings = await kernel.findGlobal({ slug: 'site-settings' })
await kernel.updateGlobal({ slug: 'site-settings', data })
```

The mental model maps cleanly onto the competition. Payload calls these `globals` and gives them an identical read/update-only API — KernelCMS deliberately mirrors that ergonomics because it is correct. Sanity has no native singleton concept; you fake it with a document of a known fixed `_id` plus desk-structure hacks and a "prevent create/delete" plugin. Strapi calls them "single types," a separate content-type kind in the Content-Type Builder. KernelCMS keeps Payload's clean `collections` vs `globals` split and adds TanStack-native typing on top, so `kernel.findGlobal({ slug: 'site-settings' })` returns a fully inferred `SiteSettings` type with zero codegen step.

## Global Config

A global is declared in the `globals` array of `kernel.config.ts`. The shape is intentionally close to a collection minus the list-view and identity concerns.

```ts
// kernel.config.ts
import { buildConfig } from '@kernel/core'
import { postgresAdapter } from '@kernel/db-postgres'

export default buildConfig({
  db: postgresAdapter({ url: process.env.DATABASE_URL }),
  globals: [
    {
      slug: 'site-settings',
      label: { singular: 'Site Settings' },
      access: {
        read: () => true,
        update: ({ req }) => req.user?.role === 'admin',
      },
      versions: {
        drafts: { autosave: { interval: 800 } },
        max: 50,
      },
      admin: {
        group: 'Configuration',
        description: 'Global identity, SEO defaults, and contact info.',
      },
      fields: [
        { name: 'siteName', type: 'text', required: true, localized: true },
        { name: 'tagline', type: 'text', localized: true },
        {
          name: 'logo',
          type: 'upload',
          relationTo: 'media',
        },
        {
          name: 'defaultSeo',
          type: 'group',
          fields: [
            { name: 'title', type: 'text', localized: true },
            { name: 'description', type: 'textarea', localized: true },
            { name: 'ogImage', type: 'upload', relationTo: 'media' },
          ],
        },
        {
          name: 'social',
          type: 'array',
          fields: [
            {
              name: 'platform',
              type: 'select',
              options: ['x', 'github', 'linkedin', 'youtube'],
            },
            { name: 'url', type: 'text', required: true },
          ],
        },
      ],
    },
  ],
})
```

Every field type from the [field reference](./04-field-types-catalog.md) is available inside a global: `text`, `richText`, `array`, `blocks`, `group`, `tabs`, `relationship`, `upload`, and custom field types. A global *is* its fields plus a small envelope of behavior flags. The notable config keys:

| Key | Purpose | Notes |
| --- | --- | --- |
| `slug` | Stable identity and table name | Immutable once data exists; renaming requires a migration |
| `label` | Admin display name | `singular` only — there is no plural for a singleton |
| `fields` | The document schema | Full field system, including localized fields |
| `access` | Operation-level guards | Only `read` and `update` apply |
| `versions` | Drafts, autosave, history depth | Same engine as collections |
| `admin.group` | Sidebar grouping | Cluster related globals under one heading |
| `hooks` | `beforeChange` / `afterChange` / `beforeRead` | No `beforeDelete` — globals are never deleted |

### Schema and storage

Drizzle generates one table per global, with a single materialized row created lazily on first read. The row is addressed by `slug`, not a synthetic `id`, so application code never juggles "the magic settings document id" the way a Sanity singleton forces you to.

```
globals (one table per global slug)
┌──────────────┬───────────┬───────────────┬─────────────┐
│ slug (PK)    │ data      │ updated_at    │ version_id  │
├──────────────┼───────────┼───────────────┼─────────────┤
│ site-settings│ {jsonb}   │ 2026-05-30…   │ v_8f3a…     │
│ main-nav     │ {jsonb}   │ 2026-05-29…   │ v_2c91…     │
└──────────────┴───────────┴───────────────┴─────────────┘
                          │
                          ▼
            _site_settings_versions (append-only history)
```

For the MongoDB adapter the same global maps to a one-document collection keyed by `slug`. The Adapter contract exposes `findGlobal` / `updateGlobal` / `findGlobalVersions`, so the rest of the stack — [REST](../05-api/01-rest-api.md), [GraphQL](../05-api/02-graphql-api.md), and typed RPC — is backend-agnostic.

## Use Cases

Globals fit any content that is conceptually unique to the site and edited in place rather than authored as repeatable entries. Strong fits:

- **Site settings** — name, tagline, default SEO, analytics IDs, contact details. The canonical example.
- **Navigation** — header and footer menus modeled as an `array` of link rows or a `blocks` field for nested menus.
- **Theme and branding** — logo, color tokens, white-label overrides consumed by [admin theming](../04-admin-ui/12-theming-and-white-label.md).
- **Legal and announcement bars** — cookie-banner copy, a site-wide promo strip, maintenance-mode toggles.
- **Integration config** — feature flags or third-party keys that editors (not just deployers) must control.

The decision rule is cardinality. If the answer to "how many of these exist?" is "exactly one, forever," use a global. If it is "one today but plausibly many later" — for example a single landing page that might become a page tree — model it as a collection from the start. Migrating a global into a collection later is a data-shape change and a migration; the reverse rarely happens. This is the same trap Strapi users hit when a "single type" outgrows its singleton-ness, except Strapi makes that conversion painful. Favor a collection when in doubt.

```ts
// A navigation global: nested menus via blocks
{
  slug: 'main-nav',
  access: { read: () => true, update: ({ req }) => req.user?.role === 'admin' },
  fields: [
    {
      name: 'items',
      type: 'array',
      fields: [
        { name: 'label', type: 'text', required: true, localized: true },
        { name: 'href', type: 'text', required: true },
        {
          name: 'children',
          type: 'array',
          fields: [
            { name: 'label', type: 'text', required: true, localized: true },
            { name: 'href', type: 'text', required: true },
          ],
        },
      ],
    },
  ],
}
```

## Versioning of Globals

Globals share the [drafts and version-history](./10-versioning-drafts-and-autosave.md) engine with collections, with one structural difference: there is no row identity to scope by, so the version table is scoped purely by global `slug`. Every `updateGlobal` writes an append-only version row; autosave writes draft versions on the interval; publishing promotes the latest draft to the live row.

```ts
versions: {
  drafts: {
    autosave: { interval: 800 }, // ms of idle before a draft snapshot
    schedulePublish: true,        // allow timed go-live
  },
  max: 50, // prune history beyond the most recent 50 versions
}
```

Reading is draft-aware via the shared query language. `draft: true` reads the latest draft; the default reads the published row.

```ts
// Published settings (what the live site sees)
const live = await kernel.findGlobal({ slug: 'site-settings' })

// Draft preview for the admin / live-preview pane
const draft = await kernel.findGlobal({ slug: 'site-settings', draft: true })

// Inspect and restore history
const history = await kernel.findGlobalVersions({ slug: 'site-settings' })
await kernel.restoreGlobalVersion({ slug: 'site-settings', versionId: 'v_2c91' })
```

Localized fields version per locale, so a German autosave does not clobber an in-flight English draft. The shared `where`/`sort`/pagination semantics apply to `findGlobalVersions` exactly as they do to collection versions.

This is a concrete win over the competition. Payload versions globals but its draft model is bolt-on per global. Strapi's Draft & Publish historically did **not** cover single types in the same way it covers collection types, leaving settings changes unversioned. Sanity gets drafts on its faux-singleton but you inherit all the desk-structure scaffolding to make a singleton behave like one. KernelCMS treats a global as a versioned document by default — autosave, scheduled publish, per-locale drafts, and one-click restore work the same whether the slug names a collection or a global.

```
update ──► beforeChange hook ──► validate ──► write draft version
                                                    │
                                       publish ─────┼──► promote to live row
                                                    │       │
                                       autosave ────┘       └──► afterChange hook
```

## Access Control on Globals

Access control on a global is evaluated server-side at two of the three levels described in [access control](../06-auth-security/01-authorization-and-access-control.md): the **operation** level (`read`, `update`) and the **field** level. There is no document level because the document is the global — there is only one. The functions receive the standard `{ req, data }` argument and run in-process for the Local API and behind every wire surface, so REST, GraphQL, and RPC enforce the same rules with no extra wiring.

```ts
{
  slug: 'site-settings',
  access: {
    // Anyone may read public settings
    read: () => true,
    // Only admins may change them
    update: ({ req }) => req.user?.role === 'admin',
  },
  fields: [
    { name: 'siteName', type: 'text' },
    {
      name: 'analyticsKey',
      type: 'text',
      access: {
        // Hidden from the API entirely for non-admins
        read: ({ req }) => req.user?.role === 'admin',
        update: ({ req }) => req.user?.role === 'admin',
      },
    },
  ],
}
```

| Level | Functions | Effect |
| --- | --- | --- |
| Operation | `read`, `update` | Gates the whole `findGlobal` / `updateGlobal` call |
| Field | per-field `read`, `update` | Strips unreadable fields from responses; rejects unauthorized field writes |

Field-level `read` access is enforced on the way out: a non-admin requesting `site-settings` receives the document with `analyticsKey` omitted, not nulled and not erroring. Field-level `update` access is enforced on the way in: a write that touches a forbidden field is rejected before it reaches the database, never silently dropped. Returning a `Where` constraint from an operation function is meaningless for a singleton, so a global's access functions return only `boolean` — a deliberate narrowing of the collection contract that the types enforce at compile time.

Because globals are read-only-by-default magnets for sensitive config (API keys, analytics IDs, feature flags), the recommended posture is `read: () => true` only for genuinely public fields and an explicit role check everywhere else. Defaulting `update` to deny and opting specific roles in matches the project tenet: security is server-side and on by default.

## Open Questions

- **Per-locale publish state for globals.** Should a global be publishable independently per locale (German live while English stays draft), or is publish always document-wide? Collections lean document-wide today; globals may warrant per-locale.
- **`max` history pruning vs. legal retention.** A single `max` count is simple, but settings audited for compliance may need time-based retention. Whether to expose a `retention` policy alongside `max` is undecided.
- **Read-through caching layer.** Globals are read on nearly every request. Whether the cache adapter should auto-cache `findGlobal` with slug-scoped invalidation on `updateGlobal`, or leave it to the developer, is still open.
