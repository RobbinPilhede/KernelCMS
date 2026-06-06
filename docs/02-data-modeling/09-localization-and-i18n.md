# Localization & i18n

KernelCMS treats localization as a property of individual fields, not of whole documents or separate language trees. A document is one entity with one ID; every field marked `localized: true` stores a value per locale, and unlocalized fields are shared across all locales. This is the same model Payload uses and the opposite of Strapi's "one entry per locale linked by relation" approach. The result is a single source of truth per piece of content, server-side fallback resolution, and a typed query language where `locale` and `fallback` are first-class parameters across REST, GraphQL, and the [Local/RPC API](../05-api/03-typed-rpc-and-local-api.md).

## Locale config

Locales are declared once in `kernel.config.ts` under `localization`. They are global to the project — collections and globals opt into them per field rather than redeclaring them. Each locale has a stable `code` (used as the storage key and the API parameter), a human `label` for the admin switcher, an optional `rtl` flag that flips the admin layout and editor direction, and an optional `fallback` to another locale code.

```ts
// kernel.config.ts
import { defineConfig } from '@kernel/core'

export default defineConfig({
  localization: {
    locales: [
      { code: 'en',    label: 'English' },
      { code: 'en-GB', label: 'English (UK)', fallback: 'en' },
      { code: 'da',    label: 'Dansk',        fallback: 'en' },
      { code: 'de',    label: 'Deutsch',      fallback: 'en' },
      { code: 'ar',    label: 'العربية',       fallback: 'en', rtl: true },
    ],
    defaultLocale: 'en',
    // Resolve a missing localized value from the fallback chain at read time.
    fallback: true,
  },
})
```

The `code` is an opaque string — we do not validate it against BCP 47, because real projects use region tags (`en-GB`), script tags (`zh-Hans`), and occasionally non-standard internal codes. The codes become a `const`-derived union throughout the typed API, so `Locale = 'en' | 'en-GB' | 'da' | 'de' | 'ar'` is inferred and a typo like `locale: 'eng'` fails at compile time. That inference is the practical win over Strapi, where locale codes are runtime strings configured in the admin and never reach your types.

| Option | Type | Purpose |
| --- | --- | --- |
| `locales` | `LocaleConfig[]` | The full locale set; order controls switcher order |
| `defaultLocale` | `string` | Used when a request omits `locale` |
| `fallback` | `boolean` | Default read-time fallback behavior (overridable per request) |
| `LocaleConfig.fallback` | `string` | Per-locale fallback target; chains are resolved transitively |
| `LocaleConfig.rtl` | `boolean` | Flips admin direction and richText editor base direction |

Turning `localization` on after a project already has content is a non-breaking migration: existing single-value columns are migrated into the default locale's slot. See [Migrations](../03-persistence/08-migrations-engine.md) for how the schema diff handles the localized-column reshape per adapter.

## Field-level localization

Any field gains a per-locale value by setting `localized: true`. This works on leaf fields (`text`, `richText`, `number`, `select`) and on container fields (`array`, `blocks`, `group`) — localizing a container localizes its entire subtree as one unit, which is what you want when sibling languages need structurally different content, not just translated strings.

```ts
// collections/posts.ts
import { defineCollection } from '@kernel/core'

export const Posts = defineCollection({
  slug: 'posts',
  fields: [
    { name: 'title',   type: 'text',     localized: true, required: true },
    { name: 'slug',    type: 'text',     localized: true, unique: true },
    { name: 'body',    type: 'richText', localized: true },
    // Shared across locales — one value, edited once.
    { name: 'author',  type: 'relationship', to: 'users' },
    { name: 'hero',    type: 'upload',   relationTo: 'media' },
    // A localized array: each locale has its own ordering and items.
    {
      name: 'sections',
      type: 'array',
      localized: true,
      fields: [
        { name: 'heading', type: 'text' },
        { name: 'copy',    type: 'richText' },
      ],
    },
  ],
})
```

Storage differs by adapter but the contract is identical. On SQL backends (`@kernel/db-postgres`, `@kernel/db-sqlite`, `@kernel/db-mysql`) localized scalar fields become a JSON column keyed by locale, while large localized fields like `richText` and localized `array`/`blocks` get a sidecar `_locales` table keyed by `(parent_id, _locale)` so a single locale's value can be loaded, indexed, and versioned without rehydrating the rest. On `@kernel/db-mongodb` the value is an object keyed by locale code on the same document. Either way the [Adapter contract](../03-persistence/00-persistence-overview-and-adapter-contract.md) exposes the same `localized` read/write semantics so application code never branches on backend.

```
posts row
┌────────────┬─────────────────────────────────────────────┐
│ id         │ "p_8231"                                     │
│ author     │ "u_55"          ← shared (one value)         │
│ title      │ { en: "...", da: "...", de: "..." }  localized│
│ body       │ → posts_locales (parent_id, _locale, value)  │
└────────────┴─────────────────────────────────────────────┘
```

Validation, access control, and versioning all run per active locale. A `required` localized field is required in the locale being written, not in every locale — publishing English does not block on a missing Arabic translation. Field-level [access control](../06-auth-security/01-authorization-and-access-control.md) is evaluated with the request's locale in context, so you can grant a translator write access to `da`/`de` while denying it on `en`. Drafts and [version history](./10-versioning-drafts-and-autosave.md) snapshot the full localized payload, so reverting a version restores every locale together.

## Fallback chains

Fallback resolution is server-side and happens at read time. When a locale's value is empty (null, undefined, or an empty richText document), KernelCMS walks the `fallback` pointer until it finds a non-empty value or exhausts the chain, then returns the default locale's value as the last resort. Chains are resolved transitively but cycle-guarded.

```
request locale: en-GB
  en-GB.fallback → en
  en.fallback    → (none) → defaultLocale (en)

resolve("title", "en-GB"):
  en-GB.title empty? ── yes ──▶ en.title present? ── yes ──▶ return en.title
                     └─ no  ──▶ return en-GB.title
```

The resolution rules, in order:

1. The requested locale's stored value, if non-empty.
2. Each locale named by a transitively-followed `fallback`, stopping at the first non-empty value.
3. The `defaultLocale` value, if still unresolved.
4. `null` if every step is empty.

Two request-time overrides give callers full control:

- `fallback: false` disables resolution and returns the raw stored value (or `null`) for the requested locale — exactly what a translation-progress dashboard needs to detect gaps.
- `locale: 'all'` returns the full per-locale object for every localized field, bypassing resolution entirely. This is how the admin loads a document for editing and how an export job captures every translation in one read.

Emptiness is intentionally richer than "is null." An empty richText (`{ root: { children: [] } }`) and an empty string both trigger fallback, because a translator who cleared a field expects the source language to show, not a blank. This is a deliberate departure from Sanity, where document-level i18n plugins generally leave fallback to client query logic, and from Strapi, where an unpopulated locale simply 404s its linked entry. In KernelCMS, fallback is a guarantee of the read path, not something each consumer reimplements.

## Admin locale switcher

The admin renders one locale-aware editor backed by [TanStack Form](../04-admin-ui/06-document-edit-view.md), with the active locale stored in TanStack Router search params (`?locale=da`) so the choice is bookmarkable, shareable, and survives reload. The switcher in the document header lists every configured locale; switching it updates the search param, and [TanStack Query](../09-developer-experience/03-client-sdk-and-data-fetching.md) refetches the document with `locale=all`, so all locales are already in memory and the switch is instant with no save round-trip.

```
┌─ Edit · Posts / "Release notes" ───────────── [ Dansk ▾ ] ─┐
│ Title  [ Udgivelsesnoter                                ]  │  ← localized
│ Slug   [ udgivelsesnoter                                ]  │  ← localized
│ Author [ Astrid Holm                          ] (shared)   │  ← not localized
│ Body   [ richText editor … RTL when locale.rtl = true ]    │  ← localized
└────────────────────────────────────────────────────────────┘
```

Localized fields show a small per-field locale badge and an "inherited from `en`" hint when the displayed value came from fallback rather than this locale — editing it forks a real value for the active locale. Unlocalized fields render once and are visually marked as shared; saving them writes the same value regardless of the active locale. When `locale.rtl` is true the form region and richText editor switch to `dir="rtl"` and logical CSS properties handle the mirroring, satisfying the WCAG 2.2 AA and RTL commitments in the brief. A command-palette action (`Switch locale → …`) and live-preview both read the same router search param, so preview always reflects the locale you are editing.

## Locale params in the API

`locale` and `fallback` are part of the one shared query language, so they behave identically across REST, GraphQL, the Local API, and typed RPC. The Local API infers the return type from the locale argument — pass a single code and localized fields are `string`; pass `'all'` and they widen to `Record<Locale, string>`.

```ts
import { getKernel } from '@kernel/server'
const kernel = await getKernel()

// Single locale, fallback on (default): title is `string`
const da = await kernel.find('posts', {
  where: { status: { equals: 'published' } },
  locale: 'da',
  depth: 1,
})

// All locales for editing/export: title is Record<Locale, string>
const every = await kernel.findByID('posts', 'p_8231', { locale: 'all' })

// Disable fallback to audit translation gaps
const raw = await kernel.findByID('posts', 'p_8231', {
  locale: 'da',
  fallback: false,
})
```

Over the wire the parameter shapes are consistent:

| Surface | Single locale | All locales | Disable fallback |
| --- | --- | --- | --- |
| REST | `GET /api/posts?locale=da` | `?locale=all` | `&fallback=false` |
| GraphQL | `posts(locale: da)` | `locale: all` | `fallback: false` |
| RPC / Local | `find('posts', { locale })` | `locale: 'all'` | `fallback: false` |

GraphQL exposes the locale set as an enum generated from your config, so `locale: da` is validated by the schema rather than passed as a free string — another place where Strapi's stringly-typed locales lose to generated types. The typed [`@kernel/client`](../09-developer-experience/03-client-sdk-and-data-fetching.md) carries the same `Locale` union to the frontend, so a Next.js or TanStack DB-backed app cannot request a locale that does not exist.

## Open questions

- **Per-locale publish state.** Today drafts/publish are document-level. Should `_status` be localizable so `en` can be published while `da` stays draft? This needs a versioning-model decision before we commit (see [Drafts & versions](./10-versioning-drafts-and-autosave.md)).
- **Locale-scoped slugs and uniqueness.** A `unique` localized `slug` must be unique per locale, not globally. The SQL uniqueness constraint over a sidecar `_locales` table needs a final shape per adapter.
- **Active vs. inactive locales.** Whether to support soft-disabling a locale (hidden in admin, still stored and served) versus full removal, and how removal interacts with existing stored values.
- **Locale negotiation at the edge.** Whether `@kernel/rest` should auto-resolve `Accept-Language` to a configured locale by default, or keep locale strictly explicit to avoid surprising cache keys on the content CDN.
