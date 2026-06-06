# Competition Audit — KernelCMS vs Payload, Sanity, Strapi

A feature-by-feature capability audit of the headless-CMS field, used to prioritize
the build. Status legend for the KernelCMS column: ✅ built + tested, 🟡 partial,
⬜ planned. Tests referenced are in this repo (`packages/**/*.test.ts`, `e2e/`).

## Content modeling

| Capability                                          | Payload    | Sanity              | Strapi             | KernelCMS                                                             |
| --------------------------------------------------- | ---------- | ------------------- | ------------------ | --------------------------------------------------------------------- |
| Config-as-code collections                          | ✅         | ✅ (schema)         | 🟡 (UI + files)    | ✅                                                                    |
| Field types (text, number, select, relationship, …) | ✅         | ✅                  | ✅                 | ✅                                                                    |
| Group / array / blocks (repeatable layouts)         | ✅         | ✅ (arrays/objects) | 🟡 (components/DZ) | ✅ blocks + array + group                                             |
| Rich text (structured, editor-agnostic)             | ✅ Lexical | ✅ Portable Text    | 🟡 (Blocks)        | ✅ KernelRichText model + sanitizer + converters (`@kernel/richtext`) |
| Localization (per-field locales)                    | ✅         | ✅                  | ✅                 | ✅                                                                    |
| Field-level access (read & write)                   | ✅         | 🟡                  | 🟡                 | ✅                                                                    |

## Versioning & workflow

| Capability                  | Payload | Sanity | Strapi  | KernelCMS                          |
| --------------------------- | ------- | ------ | ------- | ---------------------------------- |
| Version history             | ✅      | ✅     | ✅ (EE) | ✅ `_versions_<slug>` + restore    |
| Draft / published lifecycle | ✅      | ✅     | ✅      | ✅ publish/unpublish + draft reads |
| Draft autosave              | ✅      | ✅     | 🟡      | ⬜                                 |
| Scheduled publish           | 🟡      | 🟡     | 🟡      | ⬜                                 |

## APIs

| Capability                              | Payload | Sanity    | Strapi | KernelCMS                                                    |
| --------------------------------------- | ------- | --------- | ------ | ------------------------------------------------------------ |
| REST CRUD + where/sort/depth/pagination | ✅      | 🟡 (GROQ) | ✅     | ✅                                                           |
| Bulk update / delete                    | ✅      | ✅        | 🟡     | ✅ `updateMany`/`deleteMany` (+ REST, where-required guard)  |
| GraphQL (generated from model)          | ✅      | 🟡        | ✅     | ✅ `@kernel/graphql` (queries + mutations, access-enforcing) |
| Typed local API (in-process)            | ✅      | 🟡        | ⬜     | ✅                                                           |

## Media & uploads

| Capability                           | Payload     | Sanity       | Strapi         | KernelCMS                                           |
| ------------------------------------ | ----------- | ------------ | -------------- | --------------------------------------------------- |
| Upload-as-document                   | ✅          | ✅ (assets)  | 🟡 (media lib) | ✅ `upload` collections + system fields             |
| Swappable storage adapters           | ✅ (plugin) | ⬜ (managed) | ✅ (providers) | ✅ `@kernel/storage` (local + memory; S3/R2/GCS ⬜) |
| Magic-byte content validation        | 🟡          | n/a          | 🟡             | ✅ `sniffMimeType` + consistency check              |
| Per-document delivery access (proxy) | 🟡          | ⬜           | 🟡             | ✅ proxy-mode read-access on file route             |
| Image derivatives (`imageSizes`)     | ✅ sharp    | ✅ CDN       | ✅ sharp       | ⬜                                                  |

## Extensibility

| Capability                   | Payload         | Sanity            | Strapi          | KernelCMS                                                           |
| ---------------------------- | --------------- | ----------------- | --------------- | ------------------------------------------------------------------- |
| Plugin system                | ✅ (config fns) | ✅ (definePlugin) | ✅ (filesystem) | ✅ config transformers + dependsOn ordering + conflict/cycle guards |
| Hooks (before/after change)  | ✅              | 🟡                | ✅ (lifecycles) | ✅                                                                  |
| First-party SEO plugin       | ✅ `plugin-seo` | 🟡                | 🟡              | ✅ `@kernel/plugin-seo`                                             |
| Admin view / field extension | ✅              | ✅                | ✅              | ⬜ (extend surface designed, not built)                             |

## Persistence & migrations

| Capability                        | Payload      | Sanity       | Strapi         | KernelCMS                                                         |
| --------------------------------- | ------------ | ------------ | -------------- | ----------------------------------------------------------------- |
| Reviewable, checked-in migrations | ✅ (Drizzle) | ⬜ (managed) | 🟡 (auto-sync) | 🟡 diff engine + `migrate:status`/`snapshot` (DDL emit/ledger ⬜) |
| Multi-DB adapters                 | ✅           | ⬜           | ✅             | 🟡 sqlite ✅, postgres 🟡, others ⬜                              |

## Auth

| Capability              | Payload | Sanity       | Strapi | KernelCMS                                            |
| ----------------------- | ------- | ------------ | ------ | ---------------------------------------------------- |
| Email/password + JWT    | ✅      | ✅ (managed) | ✅     | ✅ + brute-force throttle                            |
| Per-collection API keys | ✅      | ✅ (tokens)  | ✅     | ✅ hashed key, `Authorization: <coll> API-Key <key>` |
| Role-based access       | ✅      | ✅           | ✅     | ✅ (access functions + field access)                 |

## Admin UX (the "no AI feeling" bar)

| Capability                            | Payload | Sanity | Strapi | KernelCMS                                        |
| ------------------------------------- | ------- | ------ | ------ | ------------------------------------------------ |
| Visual section/block builder          | 🟡      | ✅     | 🟡     | ✅ section library + drag-reorder                |
| Live preview (real frontend)          | ✅      | ✅     | 🟡     | ✅ iframe + postMessage, `admin.livePreview.url` |
| Rich-text slash menu + bubble toolbar | ✅      | ✅     | 🟡     | ✅ animated, schema-gated                        |
| Command palette (⌘K)                  | 🟡      | ✅     | ⬜     | ✅                                               |
| Animated toasts + confirm dialogs     | 🟡      | ✅     | 🟡     | ✅ panel-wide, reduced-motion-aware              |

## Where KernelCMS already differentiates

- **One Adapter contract** for DB and storage, with a **pure, deterministic schema-diff**
  migration planner (risk-classified) rather than opaque auto-sync.
- **GraphQL + REST + typed local API** all resolving through the _same_ access/hook/
  validation pipeline — no second authorization path.
- **Editor-agnostic rich-text model** (`KernelRichText`) with a security-first sanitizer
  and pure converters (`toHTML`/`toPlainText`/`toReact`), decoupled from the editor.
- **Plugins as config transformers** with explicit ordering and conflict/cycle errors —
  no silent last-write-wins.
- **Proxy-mode media delivery** that re-checks document access per byte served.

## Gap backlog (prioritized)

1. Image derivatives + focal points (track 07) — the biggest media gap vs Payload/Sanity.
2. Migration DDL emission + ledger/rollback (track 03) — finish the engine past planning.
3. Admin view/field plugin-extension surface (track 08) — let plugins ship UI.
4. Draft autosave + scheduled publish (spec 02).
5. S3/R2/GCS storage adapters (track 07).
6. Relationship/upload population inside GraphQL (track 05).
