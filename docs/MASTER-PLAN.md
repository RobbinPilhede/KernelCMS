# KernelCMS — Master Plan

> The TanStack-native, adapter-based, end-to-end type-safe headless CMS.
> A page-builder-first competitor to Payload that feels hand-built, not generated.

This is the index-of-record for the product. It enumerates ~100 specification
documents grouped into 13 tracks, from the smallest UX detail to the largest
architectural bet. Each entry is a doc to be written in full under `docs/<track>/`.
Every entry states **what it is**, the **key decisions/features**, and where
relevant **▲ Better than Payload** (the concrete differentiator) and
**✦ No-AI-feel** (the craft detail that makes it feel senior-built).

---

## 0. North Star

**Thesis.** Payload proved config-as-code + a great admin is the right shape. But
it is Next.js-bound, its block/page-building is utilitarian, live preview takes
setup, and customizing the admin means learning its server-component internals.
KernelCMS wins by being **framework-agnostic via adapters**, **page-builder-first
with a real visual library**, **live-preview-by-default**, and **obsessively
crafted** so nothing feels templated.

**Five differentiation pillars.**

1. **Adapter-everything** — DB, storage, auth, email, search, cache, queue are all
   swappable contracts. The core depends on interfaces, never a driver.
2. **Visual page building done right** — a section library with **auto-captured
   screenshots**, drag-to-compose, click-to-edit on a live canvas.
3. **Live preview with zero config** — your real frontend renders 1:1; turn it on
   with one URL, or use the built-in renderer until you have a frontend.
4. **TanStack-native, type-safe to the edge** — Router/Query/Table/Form/Start;
   generated types flow from schema → API → client → admin.
5. **Senior craft as a feature** — motion, empty states, keyboard-first, a11y AA,
   no placeholder energy anywhere.

**Engineering standards (non-negotiable, applies to every doc).**

- Zero `any`; `unknown` + guards. Named exports. Error classes extend a typed base.
- Every public operation has tests (capability + regression). 80% line / 70% branch.
- Security gate on every feature touching auth, input, APIs, or storage.
- Performance budgets per surface (see Track L). A11y AA minimum (Track D).
- Accessibility, loading, empty, and error states are part of "done," not extras.

**Roadmap phases** (milestones map onto the tracks):

- **M0 Foundation** (done/in-progress): engine, SQLite+Postgres adapters, REST + Local API, auth, CLI, React/TanStack admin, blocks, live preview MVP.
- **M1 Page Builder**: section library + auto-screenshots, drag canvas, click-to-edit, templates.
- **M2 Editorial**: drafts/versions/autosave, scheduled publish, localization, media library.
- **M3 Platform**: GraphQL, realtime, webhooks, plugin system, SSO, audit log.
- **M4 Scale & Cloud**: multi-tenant, jobs/queues, managed cloud, observability.

---

## Track A — Foundation & Positioning (docs 1–8)

1. **Vision & Mission** — the one-paragraph promise, the wedge (page-builder-first
   headless), the 3-year arc, and explicit non-goals (not a website builder, not
   a no-code-only tool, not a SaaS-lock-in).
2. **Personas & Jobs-to-be-Done** — the _developer_ (owns schema/deploy), the
   _editor_ (composes pages, never sees code), the _designer_ (owns tokens/sections),
   the _agency_ (multi-client). Each with their critical path and failure modes.
3. **Payload Gap Analysis** — catalog of concrete friction people hit: Next-only
   admin, RSC learning curve to customize, live-preview wiring, block UX without
   visual previews, migration DX, large-list admin perf, theming requires ejecting,
   plugin breadth, cloud pricing anxiety. Each gap → our answer + proof.
4. **Differentiation Matrix** — feature-by-feature vs Payload, Strapi, Sanity,
   Directus, with honest "where they're still better" so we stay grounded.
5. **Design Tenets** — the rules every contributor follows: _config is the source
   of truth_, _the frontend is the renderer_, _adapters over assumptions_,
   _progressive disclosure_, _fast by default_, _never a dead end_.
   ✦ No-AI-feel: a written "taste guide" (spacing rhythm, copy voice, motion curves).
6. **Naming, Brand & Voice** — product naming (`kernelcms`, `@kernelcms/*`),
   microcopy voice (concise, human, a little warm), error-message tone.
7. **Open-Source Model & Governance** — MIT core, optional commercial add-ons,
   RFC process, contribution guide, semver policy, security disclosure.
8. **Glossary** — collection, global, field, block/section, document, adapter,
   hook, access fn, draft, version — one canonical definition each.

---

## Track B — Core Architecture (docs 9–19)

9. **System Architecture Overview** — the request lifecycle diagram: config →
   sanitize → compile schema → operation pipeline → adapter → serialize → populate,
   exposed as Local API and over HTTP; consumed by typed client + admin.
10. **The Adapter Pattern** — the contract design (`Adapter` base: kind, name,
    contractVersion, capabilities). How capabilities drive feature availability.
    ▲ Better than Payload: storage/auth/email/search are first-class adapters too.
11. **Configuration System** — `defineConfig`, sanitize/validate, merge of defaults,
    typed inference so the whole app is checked from one object.
12. **Schema Compilation & Type Generation** — schema → storage tables → generated
    TS types that flow to the client and admin. Codegen is deterministic and diffable.
13. **Operation Pipeline** — defaults → access → field-access → hooks → validate →
    serialize → adapter → populate; documented as the single chokepoint for behavior.
14. **Error Model & Result Types** — typed `KernelError` hierarchy, machine codes,
    HTTP status mapping, never leak internals, `Retry-After` on 429.
15. **Query Engine & `where` AST** — the portable filter/sort/paginate AST, operator
    set, in-memory matcher for access scoping, adapter compilation rules.
16. **Transactions & Consistency** — contract semantics, pooled-client transactions
    (Postgres), savepoints for nesting, single-connection serialization (SQLite).
17. **Caching & Invalidation** — tag-based cache, request-scoped dedupe, adapter
    cache hooks, and how live preview bypasses caches.
18. **Edge & Serverless Compatibility** — what runs on the edge (web-standard
    Request→Response handler), what needs Node, how to split.
19. **Monorepo & Package Topology** — `@kernel/db|core|db-sqlite|db-postgres|server
|client|cli|admin-app`, the published `kernelcms` rollup, build/embed pipeline.

---

## Track C — Content Modeling (docs 20–31)

20. **Collections** — slug rules, labels, timestamps, admin options, access, hooks,
    auth flag; the mental model and worked examples.
21. **Globals & Singletons** — single-row content (settings, header/footer), same
    field system, same access/hooks.
22. **Field Types Catalog** — text, textarea, email, slug, code, number, boolean/
    checkbox, date, select/radio (hasMany), relationship/upload, point, json,
    richText, array, group, blocks, tabs/row/collapsible (presentational).
23. **Relationships & Population** — single/hasMany, polymorphic relationships,
    depth control, circular-safety, and join strategy per adapter.
24. **Arrays & Blocks** — repeatable groups vs typed blocks; storage as JSON;
    per-row validation; stable row keys; min/max rows.
25. **Blocks as Sections** — block defs with `labels`, `admin.group`, description,
    and **thumbnail (auto or manual)**; the data model behind the page builder.
26. **Tabs, Rows, Collapsibles & Sidebar** — presentational layout fields and
    `admin.position: 'sidebar'`, `admin.tab` grouping; no extra storage.
27. **Conditional Logic** — `admin.condition` to show/hide fields by sibling data;
    and conditional validation.
28. **Validation & Constraints** — built-in rules, custom `validate`, nested paths,
    friendly error surfacing in the admin (banner + inline + tab focus).
    ✦ No-AI-feel: errors say _which section/field_ in human terms, never a raw path.
29. **Localization & i18n (content)** — per-field localized values, locale fallback,
    locale switcher, copy-from-locale, and per-locale live preview.
30. **Versioning, Drafts & Autosave** — draft vs published, version history with
    diff + restore, autosave with conflict handling, scheduled publish/unpublish.
    ▲ Better than Payload: visual diff of _rendered sections_, not just JSON.
31. **Data Migrations & Schema Evolution** — generated migrations, safe column adds,
    backfills, dry-run, and a migration DX that doesn't require hand-writing SQL.

---

## Track D — Admin UX (docs 32–46)

32. **Design System & Tokens** — color/spacing/type/radii/motion tokens as CSS
    custom properties; light/dark; density modes; the single source of visual truth.
33. **Component Library** — buttons, inputs, selects, switches, dialogs (native
    `<dialog>`), toasts, tables, pills, menus — accessible, themeable, documented.
34. **App Shell & Navigation** — sidebar with grouped collections/globals, command
    bar, breadcrumb, responsive collapse; remembers last location.
35. **Dashboard / Home** — useful by default: recent edits, drafts awaiting publish,
    quick-create, per-collection cards, not a hello-world.
36. **List Views** — TanStack Table: column config, sort, filter builder, saved
    views, density, sticky header, **virtualized rows** for large datasets, bulk select.
    ▲ Better than Payload: filter builder + saved views are first-class, fast at scale.
37. **Document Editor** — tabs + sidebar layout, sticky save bar, dirty-state guard,
    keyboard save, and the field-render pipeline.
38. **Field Rendering & Custom Fields** — schema-driven inputs, recursion into
    group/array/blocks, and a clean API to register custom field components.
39. **Command Palette & Keyboard** — ⌘K to jump anywhere/create anything; every
    primary action has a shortcut; documented and discoverable.
    ✦ No-AI-feel: real keyboard model, focus rings via `:focus-visible`, no mouse-only.
40. **Accessibility Standard (AA)** — semantic landmarks, labels on every input,
    44px targets, contrast ≥4.5, reduced-motion respected, screen-reader passes.
41. **Theming & White-Label** — rebrand via tokens + logo without ejecting; per-
    project themes; agency multi-brand.
    ▲ Better than Payload: deep theming without touching admin internals.
42. **Admin i18n & RTL** — translatable admin UI, RTL layouts, locale-aware dates.
43. **States: Empty, Loading, Error, Offline** — every view has designed empty
    (with a real next action), skeleton loading, recoverable errors, offline notice.
    ✦ No-AI-feel: empty states teach the next step; never a blank box.
44. **Optimistic UI & Undo** — instant feedback on save/reorder/delete with rollback;
    undo for destructive actions; autosave indicators.
45. **Notifications & Activity** — toasts, in-app activity feed (who changed what),
    save/publish confirmations with links.
46. **Resilience Details** — token storage that never throws (memory→session→local
    fallback), CSRF-safe mutations, graceful API-down screen, request retry policy.

---

## Track E — Visual Page & Section Builder (docs 47–58)

47. **Page Builder Overview** — compose pages from sections; the editor is fields-
    left / live-canvas-right; the section is the real component.
48. **Section Library (the "Add section" gallery)** — full-width modal, search,
    grouping, large image-first cards.
    ▲ Better than Payload: a true visual library, not a labeled button list.
49. **Auto-Screenshot Thumbnails** — render each section in isolation with sample
    data, capture headlessly, cache, and use as the library card image. Re-capture
    on block change. Manual override supported.
    ▲ Better than Payload: the gallery "snatches" real previews automatically.
50. **Drag-to-Compose Canvas** — dnd-kit reorder, collapsible section cards, drag
    handle, number/type pill, duplicate/remove, collapse-all, insert-between.
51. **Click-to-Edit (visual editing)** — click a section in the live preview to
    focus its fields; hover outlines; in-context add/remove.
    ▲ Better than Payload: bidirectional canvas↔fields selection.
52. **Section Presets & Templates** — save a configured section as a reusable preset;
    page templates to start from; per-tenant template libraries.
53. **Reusable Global Sections** — shared header/footer/CTA edited once, referenced
    across pages; live updates everywhere.
54. **Nested Blocks & Layout Blocks** — columns/grids as blocks; sections within
    sections; depth limits and sane defaults.
55. **Copy / Paste / Move Across Pages** — clipboard for sections between documents,
    with schema validation on paste.
56. **Responsive Preview & Breakpoints** — device frames (desktop/tablet/mobile),
    custom sizes, full-bleed desktop, zoom.
57. **Block-Level Design Controls** — optional per-section spacing/theme/background
    tokens, constrained to the design system (no arbitrary CSS soup).
58. **Inline Rich Text** — a real editor (not a textarea) with blocks, links, marks,
    portable JSON, paste-cleanup, and slash commands.

---

## Track F — Live Preview & Visual Editing (docs 59–66)

59. **Live Preview Architecture** — iframe at `admin.livePreview.url`; the admin
    `postMessage`s live data; the frontend subscribes/merges/re-renders.
60. **Zero-Config Onramp** — built-in renderer when no frontend URL is set; one URL
    to switch to your real site; relative-URL support for preview deploys.
    ▲ Better than Payload: useful preview before you've wired a frontend.
61. **Frontend SDK (`useLivePreview`)** — framework hooks (React/Solid/TanStack
    Start) to subscribe, merge incoming data, optionally repopulate relationships.
62. **Robust Handshake** — ready signal + onLoad fallback + targeted origins so the
    preview never silently misses initial data.
63. **Device & Zoom Toolbar** — breakpoints, custom dimensions, open-in-new-window.
64. **Multi-Locale Preview** — preview any locale; side-by-side locale compare.
65. **Draft Preview Links** — shareable tokenized URLs that render unpublished
    content for stakeholders without admin access.
66. **Security of Preview** — dev-only frame relaxation, prod `frame-ancestors`
    allow-list, signed preview tokens, no data leakage cross-origin.

---

## Track G — Auth, Access & Security (docs 67–76)

67. **Authentication** — scrypt hashing, HMAC tokens, login/me, token expiry,
    refresh strategy, httpOnly-cookie mode option.
68. **First-Run Setup** — the "create admin" onboarding, guarded server-side so it
    can only create the first account (takeover-proof).
    ✦ No-AI-feel: a real onboarding, not a seeded default password in the README.
69. **Authorization & Access Control** — collection + field-level access fns
    returning boolean or a `where` scope; `overrideAccess` for trusted callers.
70. **Roles, Permissions (RBAC/ABAC)** — role model, resource-scoped rules, policy
    composition, and an access matrix view in the admin.
71. **Field-Level Access (write & read)** — strip fields a user can't write
    (escalation-proof) and hide fields they can't read.
72. **API Keys & Service Auth** — scoped keys, rotation, per-key rate limits.
73. **Sessions, JWT & CSRF** — session model, token validation (verify alg, exp,
    issuer), CSRF protection for cookie mode.
74. **SSO / OAuth / Social** — pluggable providers, SCIM-ready user provisioning.
75. **Rate Limiting & Abuse** — per-endpoint limits, stricter on auth, lockout with
    `Retry-After`, bot mitigation hooks.
76. **Security Hardening** — secure-by-default access, parameterized queries +
    identifier allowlists, CSP/headers guidance, secrets handling, dependency audit,
    audit log of privileged actions, STRIDE threat model.

---

## Track H — APIs & Integration (docs 77–84)

77. **API Philosophy** — same operations everywhere: Local API (in-process, typed),
    REST (auto-generated), and the typed client all share one core.
78. **REST API** — CRUD, filtering/sorting/pagination, relationship depth, globals,
    `/_config` descriptor, `/health`, consistent error envelope.
79. **GraphQL API** — schema generated from config, resolvers through the same
    pipeline, query depth limits.
80. **Typed RPC / Local API** — call operations directly with full types; the basis
    for server functions and SSR data loading.
81. **Query, Filter, Sort, Paginate** — the public query language, examples, and the
    `where` operator reference.
82. **Realtime & Subscriptions** — change streams over SSE/WebSocket; presence for
    collaborative editing; scaling notes.
83. **Webhooks** — per-collection events, signed payloads, retries with backoff,
    delivery log.
84. **Typed Client & SDK** — `createClient`, `login`/`me`, generated per-collection
    methods, framework adapters.
    ▲ Better than Payload: client gets generated, collection-aware typed methods.

---

## Track I — Developer Experience & Extensibility (docs 85–93)

85. **CLI** — `migrate`, `seed`, `dev`, `generate:types`, `snapshot` (screenshots),
    helpful output, no interactive traps.
86. **Scaffolder (`create kernelcms`)** — one command to a running, seeded app on
    TanStack Start; Postgres default; sample Pages collection + a few sections.
    ▲ Better than Payload: ships a CMS-driven page (home→`/`) and live preview wired.
87. **Codegen & Types Workflow** — when/how types regenerate, watch mode, CI check.
88. **Migrations DX** — generate from schema diff, review, apply, rollback; no raw
    SQL required for the common path.
89. **Seeding & Fixtures** — idempotent seeds, factory helpers, demo content.
90. **Plugin & Hook Architecture** — install a plugin to add fields, endpoints,
    admin views, adapters; lifecycle hooks (before/after change/read/delete).
91. **Custom Admin Components** — register field inputs, list cells, dashboard
    widgets, and whole routes without forking the admin.
92. **Testing & Eval Harness** — unit/integration patterns, an eval harness for
    regressions, fixtures, and a "reproduce-first" bug workflow.
93. **Docs Site & Examples** — searchable docs, runnable examples (blog, marketing
    site, multi-tenant), copy-paste recipes.

---

## Track J — Media & Files (docs 94–99)

94. **Upload & File Handling** — validation (type/size), virus-scan hook, dedupe,
    metadata extraction.
95. **Storage Adapters** — local disk, S3-compatible, and object-store buckets via
    the storage contract.
96. **Image Processing** — resize/crop, format conversion (webp/avif), quality,
    on-the-fly variants.
97. **Focal Point & Responsive Variants** — editor sets focal point; `srcset`
    generation; art direction via `<picture>`.
98. **Media Library UI** — grid, search, folders, usage tracking ("where used"),
    bulk actions, drag-into-fields.
99. **CDN & Delivery** — signed URLs, cache headers, transform URLs, and
    AI-assisted alt-text suggestions (opt-in).

---

## Track K — Performance & Scale (docs 100–104)

100. **Performance Budgets** — per-surface targets (admin TTI, list render at 10k
     rows, save latency, preview update <100ms) and how each is enforced/measured.
101. **Large-Dataset Admin** — virtualized lists/tables, server-side pagination,
     indexed filters, debounced search.
102. **Caching & Invalidation at Scale** — tag invalidation, ISR-friendly headers,
     stale-while-revalidate for public reads.
103. **Multi-Tenant Architecture** — tenant context middleware, row-level isolation,
     per-tenant config/themes/section libraries, per-tenant billing.
104. **Background Jobs & Queues** — queue adapter, scheduled tasks (publish,
     screenshots, webhooks, image processing), retries and dead-letter.

---

## Track L — Deployment & Operations (docs 105–109)

105. **Self-Hosting & Docker** — single-image deploy, env config, healthchecks,
     standalone build.
106. **Platform Guides** — Railway (Postgres + bucket + deploy), Vercel/Netlify for
     the frontend, Fly/Render notes.
107. **Managed Cloud (roadmap)** — one-click hosted KernelCMS, no lock-in (export
     anytime), pricing philosophy that avoids the anxiety competitors create.
108. **Backups, Restore & Disaster Recovery** — automated backups, point-in-time
     restore, export/import.
109. **Observability** — structured logging, metrics, traces, error tracking, and an
     admin "system status" panel.

---

## Track M — Quality, Process & Craft (docs 110–114)

110. **Engineering Standards** — the codified rules (types, errors, tests, security
     gate) and how PRs are reviewed against them.
111. **Test Strategy** — capability vs regression evals, coverage targets, what must
     be tested (auth, access, validation, transactions, payments).
112. **Security Review Gate** — the mandatory pre-ship checklist (secrets, authz,
     injection, OWASP), run on every feature touching the sensitive surfaces.
113. **Release Process** — semver, changelog generation, migration notes, deprecation
     policy, supported-version window.
114. **The Craft Bar ("No-AI-feel" spec)** — the taste guide made testable: motion
     curves, spacing rhythm, copy voice, focus/hover/active states, transition
     discipline (never `transition: all`), and a pre-merge "does this feel
     hand-built?" review. Anything generic is sent back.

---

## How to use this plan

- Each numbered item becomes a full doc at `docs/<track-folder>/<nn>-<slug>.md`
  following the existing docs structure, with: problem, design, API, examples,
  acceptance criteria, and tests.
- Items carry the **▲ Better than Payload** and **✦ No-AI-feel** tags into their
  docs as explicit acceptance criteria, so differentiation and craft are verified,
  not aspirational.
- Sequence by milestone (M0–M4 above), not by track order; pull the next item from
  the current milestone.

## Honest current state (M0)

Built and working today: engine (core + Postgres/SQLite adapters), REST + Local
API, auth + first-run setup + field-level access + login rate limiting, the
React/TanStack admin (list/edit/globals), the `blocks` field with a searchable
section library, drag-sortable collapsible sections, live preview (built-in
renderer + real-frontend iframe), and a CMS-driven page rendering on a real site
(home→`/`). Everything past M0 in this document is planned, not yet built.
