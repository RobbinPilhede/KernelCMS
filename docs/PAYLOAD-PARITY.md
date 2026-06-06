# KernelCMS — Payload Parity & Gap Inventory

An exhaustive inventory of what Payload ships today, mapped to KernelCMS's current
state and the work to reach parity (then surpass it). Written as our own analysis;
each section links the canonical Payload doc so you can read their source wording.
Verified against the Payload docs set (35 categories, ~150 pages).

**Legend** — Status: ✅ have · 🟡 partial · ❌ missing. Priority: P0 (parity-critical),
P1 (important), P2 (nice-to-have). Effort: S/M/L/XL.

**KernelCMS today (M0 baseline).** Collections + globals; ~19 field types incl.
array/group/blocks; relationships + population; per-field localization; collection
+ field-level (write) access with `where` scoping; auth (scrypt, HMAC tokens,
login/me, first-run setup, login rate-limit); SQLite + Postgres adapters; REST +
typed Local API; CLI (`migrate/seed/dev/generate:types`); React/TanStack admin
(list/edit/globals, blocks section library, drag-sortable collapsible sections);
live preview (built-in renderer + real-frontend iframe); CMS-driven page rendering
on a real Next site (home→`/`). Everything marked ❌/🟡 below is the gap.

---

## 1. Configuration & Project  (payloadcms.com/docs/configuration/overview)
- **Single typed config (`buildConfig`)** — Payload: one config object, fully typed, drives everything. KernelCMS: ✅ `defineConfig` + sanitize/validate. — P0.
- **Environment variables** — Payload: documented env conventions. KernelCMS: 🟡 `KERNEL_SECRET`, `DATABASE_URL`, `KERNEL_API_KEY`; needs a documented matrix. P1/S.
- **Collection configs** — ✅. **Global configs** — ✅. — P0.
- **Admin config options** (useAsTitle, defaultColumns, group, description, hidden, livePreview) — KernelCMS: ✅ those; missing many sub-options Payload exposes (custom views, components, meta). 🟡 P1.

## 2. Fields  (payloadcms.com/docs/fields/overview)
Payload field types and our status:
- text ✅ · textarea ✅ · email ✅ · code ✅ · number ✅ · checkbox ✅ · date ✅ ·
  radio ✅ · select ✅ (hasMany ✅) · point ✅ · json ✅ · group ✅ · array ✅ ·
  blocks ✅ · relationship ✅ · upload 🟡 (modeled as relationship; no real media) ·
  richText ❌ (we render a textarea, not a real editor) · **tabs** 🟡 (we have
  `admin.tab` grouping + sidebar position, not Payload's tabs field with named/
  unnamed tabs and per-tab data) · **row** ❌ · **collapsible** 🟡 (blocks collapse
  in builder; no `collapsible` layout field) · **join** ❌ · **ui** ❌.
- **Field admin options** Payload supports broadly: `condition`, `description`,
  `readOnly`, `position: sidebar`, `width`, custom components, `disableListColumn`,
  defaultValue (incl. function), hooks. KernelCMS: 🟡 condition ❌, custom components ❌,
  width 🟡, field hooks ❌. — P1.
- **Build:** real `richText` (see §13), `tabs`/`row`/`collapsible` as true layout
  fields, `join` (virtual reverse relationship), `ui` field, field-level
  `condition`, per-field custom components, field hooks. P0 for richText/tabs/join.

## 3. Access Control  (payloadcms.com/docs/access-control/overview)
- **Collection access** (create/read/update/delete) ✅. **Field access** (read/
  create/update) 🟡 — we enforce *write* field access; *read* stripping not yet. P0/M.
- **Globals access** ✅. **`where`-returning access (row scoping)** ✅.
- **Admin access** (who can see the panel / specific collections) ❌. P1.
- **Build:** read-side field access, admin/UI access gating, an access-matrix view.

## 4. Authentication  (payloadcms.com/docs/authentication/overview)
- **Local (email+password)** ✅ (scrypt). **JWT strategy** ✅ (HMAC verify alg/exp). 
- **Cookie strategy** ❌ (we use bearer in localStorage). P0/M.
- **API key strategy** 🟡 (single system key; no per-user scoped keys/rotation). P1.
- **Custom strategies** ❌ · **Auth emails** (verify, forgot/reset password) ❌ · 
  **Token data / custom claims** 🟡 · **operations** (login/logout/refresh/
  forgot-password/reset/verify/unlock) 🟡 (login/me only). P0/L.
- **First-run setup** ✅ (takeover-proof) — *ahead of Payload*.
- **Build:** httpOnly cookie mode, forgot/reset/verify-email flow, refresh tokens,
  scoped API keys + rotation, account lock/unlock, custom strategies, SSO/OAuth.

## 5. Database & Adapters  (payloadcms.com/docs/database/overview)
- **Postgres** ✅ · **SQLite** ✅ · **MongoDB** ❌. P1/L.
- **Transactions** ✅ (pooled clients PG; serialized SQLite). **Indexes** 🟡 (unique/
  indexed columns; no compound/`index` API). P1.
- **Migrations** 🟡 — we auto-add columns; no generated migration files, no down/
  rollback, no `migrate:create/status/down`. P0/L.
- **Build:** MongoDB adapter, compound indexes, full migrations workflow (generate
  from diff, up/down, status), build-without-DB-connection support.

## 6. Versions, Drafts, Autosave, Scheduled Publish  (payloadcms.com/docs/versions/overview)
- **Versions / history / diff / restore** ❌ · **Drafts (draft vs published)** ❌ ·
  **Autosave** ❌ · **Scheduled publish/unpublish** ❌ · **Per-version author/audit** ❌.
  This is one of Payload's biggest features and entirely missing in KernelCMS. **P0/XL.**
- **Build:** a versions store (separate table per collection), draft/published
  status + access integration, autosave, version diff UI (ours can diff *rendered
  sections* — a differentiator), restore, and scheduled publish via a job.

## 7. Localization & i18n  (payloadcms.com/docs/configuration/localization)
- **Per-field content localization + fallback** ✅. **Locale switcher / copy-from-
  locale / per-locale preview** 🟡/❌. **Admin UI i18n (translatable panel, RTL)** ❌. P1.
- **Build:** admin locale switcher, copy-between-locales, translatable admin + RTL.

## 8. Hooks  (payloadcms.com/docs/hooks/overview)
- **Collection hooks** (beforeChange/afterChange/afterRead/beforeValidate/
  beforeDelete/afterDelete + login/refresh) 🟡 (we have the core change/read/delete
  set). **Global hooks** 🟡 · **Field hooks** ❌ · **Hook `context`** 🟡. P1/M.
- **Build:** field-level hooks, beforeValidate, auth hooks, richer context, and the
  full documented signatures.

## 9. Local API  (payloadcms.com/docs/local-api/overview)
- **In-process typed operations** ✅ · **Respecting access / overrideAccess** ✅ ·
  **Server-function usage** 🟡 · **Use outside Next** ✅ (we're framework-agnostic —
  *ahead*). P0 done.

## 10. REST API  (payloadcms.com/docs/rest-api/overview)
- **CRUD + filtering/sort/pagination + depth + globals + health** ✅ · auth endpoints
  🟡 (login/me; missing forgot/reset/verify/logout/refresh) · **bulk update/delete** ❌.
  P1: bulk ops + the remaining auth endpoints.

## 11. GraphQL  (payloadcms.com/docs/graphql/overview)
- **Auto-generated GraphQL schema + resolvers + extending** ❌ — entirely missing. P1/L.
- **Build:** generate GraphQL from config through the same operation pipeline, with
  depth limits and an `extend` API.

## 12. Queries  (payloadcms.com/docs/queries/overview)
- **`where` operators, sort, pagination, depth** ✅ · **`select` (field projection)** ❌ ·
  **`populate` control** 🟡 · **Query Presets** ❌ (see §17). P1.
- **Build:** `select`/projection to trim payloads, finer populate control.

## 13. Rich Text (Lexical)  (payloadcms.com/docs/rich-text/overview)
- Payload ships a Lexical-based editor with official features (headings, lists,
  links, uploads, relationships, **blocks inside rich text**), custom features, and
  converters (HTML/JSX/Markdown/plaintext, render-on-demand). KernelCMS: ❌ (textarea).
  **P0/XL** — the editor gap is large and high-visibility.
- **Build:** a real block-based editor producing portable JSON, marks/nodes, link
  + media + relationship nodes, slash commands, paste cleanup, and converters
  (JSON→HTML/React) for the frontend. Consider building on an existing editor core.

## 14. Uploads, Storage & Media  (payloadcms.com/docs/upload/overview)
- **Upload-enabled collections, file storage, image sizes/crops, focal point,
  storage adapters (S3/Vercel/etc.), admin media handling** ❌ — none built. **P0/XL.**
- **Build:** upload field + media collection, a storage adapter contract (local +
  S3-compatible), image processing (resize/format/quality), focal point + responsive
  variants, a media library UI, "where used" tracking.

## 15. Admin Panel & Customization  (payloadcms.com/docs/admin/overview)
- **The panel** ✅ (ours is React/TanStack, framework-agnostic — *differentiator*).
- **Custom components / views / fields / providers** ❌ (no extension API). P1/L.
- **Dashboard widgets** ❌ · **Custom list/edit/document/root views** ❌ ·
  **User preferences** (saved per-user UI state) ❌ · **Document locking** (concurrent-
  edit lock + take-over/read-only) ❌ · **Page metadata / SEO of admin** 🟡 ·
  **Customizing CSS/SCSS** 🟡 (tokens exist) · **Accessibility** 🟡 (needs AA pass).
  P1 mostly; document locking P1/M (collaboration).
- **React hooks for the admin** (useField/useForm/useDocumentInfo/etc.) 🟡 (internal,
  not a public API). 
- **Build:** a component-registration API (fields, cells, views, widgets, providers),
  user preferences store, document locking, AA accessibility, public admin hooks.

## 16. Live Preview & Visual Editing  (payloadcms.com/docs/live-preview/overview)
- **Iframe preview + postMessage + `useLivePreview` + server-side preview + device
  breakpoints + draft preview** — KernelCMS: ✅ core (built-in renderer + real-site
  iframe + handshake + device widths). 🟡 missing: official frontend SDK package,
  server-side (RSC) variant, draft preview links, click-to-edit overlay. 
- **Build (and surpass):** publish a frontend `useLivePreview` SDK, click-to-edit
  bidirectional selection, draft preview tokens, and the auto-screenshot section
  library (our differentiator — not a Payload feature).

## 17. Content Organization  (folders / query-presets / trash / hierarchy / nested-docs / join)
- **Folders** (cross-collection grouping via hidden relationship, browse-by-folder) —
  Payload: beta. KernelCMS: ❌. P1/M. (payloadcms.com/docs/folders/overview)
- **Query Presets** (save/share filters+columns+sort per collection) — ❌. P1/M.
- **Trash / soft delete** (`deletedAt`, trash view, restore, empty-trash) — ❌. P1/M.
- **Hierarchy** (parent-child tree, breadcrumb paths, descendant queries) — ❌. P1/M.
- **Nested Docs plugin** (parent/breadcrumbs via plugin) — ❌ (overlaps hierarchy). P2.
- **Join field** (virtual reverse relationship; "where used") — ❌. P1/M.
- **Build:** these are discrete, high-value editorial features; each maps cleanly
  onto our adapter/operation model.

## 18. Jobs Queue  (payloadcms.com/docs/jobs-queue/overview)
- **Tasks, Workflows, Jobs, Queues, Schedules (cron), `waitUntil` delayed jobs,
  separate workers** ❌ — none built. P1/L.
- **Build:** a queue adapter, task/workflow definitions, scheduled jobs (powers
  scheduled publish, screenshot capture, webhooks, image processing, emails).

## 19. Plugins  (payloadcms.com/docs/plugins/overview)
- **Plugin system + build-your-own + advanced plugin API** ❌ (no plugin system). P0/L —
  the ecosystem unlock.
- Official plugins to eventually match/replace: **Form Builder**, **SEO**, **Search**,
  **Redirects**, **Stripe**, **Import/Export**, **Multi-Tenant**, **Nested Docs**,
  **Sentry**, **MCP** (AI/agent integration). All ❌. P1–P2 each.
- **Build:** a plugin contract (add fields/endpoints/admin views/adapters/hooks),
  then port the high-demand plugins (SEO, Search, Form Builder, Redirects, Multi-tenant).

## 20. Email  (payloadcms.com/docs/email/overview)
- **Email adapter + transactional sending (auth emails, hooks)** ❌. P1/S.
- **Build:** an email adapter contract (Resend/SMTP/Nodemailer) + templates for auth.

## 21. Ecommerce  (payloadcms.com/docs/ecommerce/overview)
- **Ecommerce plugin: products/carts/orders, payment adapters (Stripe), frontend** ❌.
  P2/XL — large, optional vertical; defer unless targeting commerce.

## 22. TypeScript & Codegen  (payloadcms.com/docs/typescript/overview)
- **Generate TS interfaces from config** ✅ (`generate:types`). **TS plugin** (experimental
  in Payload) ❌ · deep generated types across REST/GraphQL ✅ for REST/client. P1.

## 23. Production, Performance & Abuse  (payloadcms.com/docs/production/deployment)
- **Deployment guides + build-without-DB + preventing API abuse + performance guide** —
  KernelCMS: 🟡 (Docker/standalone bundle, Railway-friendly; login rate-limit). Missing
  performance budgets, large-list virtualization at scale, abuse hardening docs. P1.
- **Build:** list virtualization, query/index performance, rate-limit everywhere,
  caching headers, deployment guides, observability.

## 24. Integrations  (Vercel Content Link, MCP)
- **Vercel Content Link** (deep links from the live site into the editor) ❌. P2.
- **MCP plugin** (expose the CMS to AI agents) ❌. P2 — *natural fit given our stack;
  could leapfrog by making MCP first-class.*

---

## Payload's direction / roadmap signals
Payload doesn't publish a single roadmap file in the repo; the authoritative source
is their GitHub (github.com/payloadcms/payload — Discussions, Projects, Releases).
What the docs reveal about where they're investing:
- **Folders** — explicitly *beta*; being stabilized. (Content organization push.)
- **Hierarchy, Query Presets, Trash, Document Locking, Join field** — recently added;
  signals a focus on **editorial workflow, collaboration, and content organization**.
- **Jobs Queue with Workflows + Schedules** — maturing into a durable task platform.
- **Ecommerce** — a newer first-party vertical (plugin + payment adapters), actively expanding.
- **MCP plugin + Vercel Content Link** — investing in **AI/agent** and **visual-editing/
  deep-link** integrations.
- **TypeScript plugin** — *experimental*; tighter type ergonomics in progress.
- **Lexical rich text** — continually extended (custom features, converters).
> Treat the above as inference from beta/experimental flags and recent additions —
> confirm specifics against Payload's GitHub roadmap before committing dates.

## Where KernelCMS is already ahead (keep/extend)
- Framework-agnostic admin & adapters (Payload's admin is Next-bound).
- Zero-dependency engine; `node:sqlite`; Postgres + SQLite out of the box.
- First-run setup onboarding (takeover-proof).
- Live preview useful *before* a frontend exists (built-in renderer).
- The auto-screenshot **section library** and bidirectional click-to-edit (planned)
  exceed Payload's manual block thumbnails.

## Suggested parity order (highest leverage first)
1. **Rich text editor** (§13) — biggest visible gap. P0/XL.
2. **Versions + drafts + autosave + scheduled publish** (§6) — core editorial. P0/XL.
3. **Uploads + storage + media library** (§14) — table stakes. P0/XL.
4. **Cookie auth + forgot/reset/verify email + scoped API keys** (§4). P0/L.
5. **Migrations workflow** (§5) + **read-side field access** (§3). P0.
6. **Plugin system** (§19) → then SEO/Search/Form Builder/Redirects/Multi-tenant.
7. **GraphQL** (§11), **Jobs queue** (§18), **content-org features** (§17).
8. **Admin extensibility + document locking + a11y AA** (§15).
