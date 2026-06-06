export const meta = {
  name: 'kernelcms-docs',
  description: 'Generate the KernelCMS planning documentation set (130+ specs) across 14 domains, plus master index and root README.',
  phases: [
    { title: 'Foundation' },
    { title: 'Architecture' },
    { title: 'Data Modeling' },
    { title: 'Persistence' },
    { title: 'Admin UI' },
    { title: 'API' },
    { title: 'Auth & Security' },
    { title: 'Media & Files' },
    { title: 'Extensibility' },
    { title: 'Developer Experience' },
    { title: 'Cloud & Operations' },
    { title: 'Quality' },
    { title: 'Ecosystem & Migration' },
    { title: 'Roadmap' },
    { title: 'Finalize' },
  ],
}

const BASE = 'C:/Users/robin/Desktop/KernelCMS'
const DOCS_DIR = BASE + '/docs'

// ---------------------------------------------------------------------------
// Canonical project brief — the single source of truth handed to every agent.
// Kept free of backticks and the dollar-brace sequence so it is safe inside a
// template literal. Apostrophes are fine here.
// ---------------------------------------------------------------------------
const ANCHOR = `KERNELCMS — CANONICAL PROJECT BRIEF (single source of truth; obey exactly, use the exact names).

WHAT IT IS
KernelCMS is an open-source, TypeScript-first, TanStack-native headless CMS that competes directly with Payload, Sanity, and Strapi. Content is modeled in code (config-as-code). It exposes REST, GraphQL, and a fully typed Local/RPC API. The admin panel is a React application built on TanStack Start.

POSITIONING (the wedge)
- TanStack-native: the entire stack — server and admin — is built on TanStack Start, Router, Query, Table, Form, Store, Virtual, and DB. No other CMS is.
- Choose everything: every infrastructure concern is a swappable adapter — database, storage, email, auth, search, cache, and queue. Users pick what they want; nothing is hard-wired.
- Two ways to run: self-host (own your data and infra) OR KernelCMS Cloud, a managed Sanity-style hosted platform. Content and config are always portable between them; no lock-in.
- Open-source core under the MIT license; optional commercial Cloud and enterprise add-ons.

CANONICAL NAMING
- Product: KernelCMS. Hosted platform: KernelCMS Cloud. CLI binary: kernel. Scaffolder: create-kernel. Config file: kernel.config.ts.
- Packages (pnpm workspace + Turborepo): @kernel/core, @kernel/server, @kernel/admin, @kernel/ui, @kernel/db, @kernel/db-postgres, @kernel/db-sqlite, @kernel/db-mysql, @kernel/db-mongodb, @kernel/storage, @kernel/auth, @kernel/graphql, @kernel/rest, @kernel/rpc, @kernel/richtext, @kernel/cli, @kernel/client, @kernel/plugin-sdk, @kernel/cloud.

TANSTACK USAGE (be specific, never generic)
- TanStack Start: SSR, server functions, and routing for both the admin app and the API host.
- TanStack Router: type-safe admin routing and search-param state.
- TanStack Query: all admin and client data fetching, caching, and invalidation.
- TanStack Table: collection list views (sorting, filtering, column sizing, virtualization).
- TanStack Form: document edit forms and per-field binding/validation.
- TanStack Store: lightweight reactive admin UI state.
- TanStack Virtual: virtualized long lists and long documents.
- TanStack DB: optional reactive client-side collections for live/offline admin and frontends.

DATA MODEL
- Collections: repeatable content types. Globals: singletons (site settings, navigation).
- Field types: text, textarea, number, boolean, date, email, json, code, point, select, radio, checkbox, relationship, upload, array, blocks, group, tabs, row, richText, ui (presentational), plus custom field types.
- Features: field-level localization, drafts and publish, version history with autosave, validation (sync, async, cross-field), and access control evaluated at the operation, document, and field level.

PERSISTENCE
- Drizzle is the default ORM for SQL: Postgres (default), SQLite/libSQL, and MySQL. A MongoDB adapter serves document-oriented workflows. Every backend implements one Adapter contract. Migrations are generated from schema diffs.

APIS
- REST and GraphQL are auto-generated from content config. The Local API is the same operation core called in-process with full type inference; over the wire it is exposed as typed RPC via TanStack Start server functions. One shared query language (where / sort / pagination / depth) spans all surfaces.

ADMIN
- React + TanStack Start. Config-driven UI, design tokens, dark mode, full keyboard and command-palette UX, a block-based rich-text editor, a media library, live preview with visual editing, WCAG 2.2 AA, i18n with RTL, and white-label theming.

DEPLOYMENT
- Self-host via Docker, Compose, or Kubernetes, on Node, Bun, or edge runtimes. KernelCMS Cloud provides managed multi-tenant hosting with billing, observability, backups, and a global content CDN.

ENGINEERING TENETS
- End-to-end type safety, zero any. Config-as-code is the single source of truth. Always provide escape hatches. Performance budgets are enforced and measured. Security is server-side and on by default. Accessibility is non-negotiable.

WRITING STYLE FOR ALL DOCS
- Senior-engineer voice. Concrete and opinionated. Prefer fenced TypeScript code blocks, tables, and small ASCII diagrams. Show realistic kernel.config.ts snippets and @kernel/* APIs. Reference Payload, Sanity, and Strapi specifically when relevant — what they do and how KernelCMS differs or wins. Use the canonical names above exactly. No marketing fluff, no AI throat-clearing, no "in conclusion" or "in summary" filler. Target roughly 900 to 1700 words per document.`

// ---------------------------------------------------------------------------
// Document manifest. Each entry: [dir, file, title, purpose, [keyPoints]].
// ---------------------------------------------------------------------------
const DOCS = [
  // 00 — Foundation
  ['00-foundation','00-vision-and-mission.md','Vision & Mission','The north star: what is broken in the current CMS landscape, why a TanStack-native CMS now, and the three-year vision.',['problem statement','why TanStack and why now','three-year vision','explicit non-goals']],
  ['00-foundation','01-product-overview.md','Product Overview','What KernelCMS is, its core capabilities, and who it serves at a glance.',['one-paragraph definition','core capabilities','primary audiences','high-level architecture sketch']],
  ['00-foundation','02-positioning-and-differentiation.md','Positioning & Differentiation','How KernelCMS wins against Payload, Sanity, and Strapi — the wedge and the moat.',['the wedge: TanStack-native plus choose-everything','moat and defensibility','tagline and core messaging','where we deliberately do not compete']],
  ['00-foundation','03-competitive-analysis-payload.md','Competitive Analysis: Payload','A deep teardown of Payload CMS: architecture, strengths, weaknesses, and what KernelCMS adopts or beats.',['Payload architecture overview','strengths','weaknesses and gaps','what we adopt versus beat']],
  ['00-foundation','04-competitive-analysis-sanity.md','Competitive Analysis: Sanity','A deep teardown of Sanity: GROQ, Studio, the hosted content lake, Portable Text, and the lessons for KernelCMS.',['GROQ and the content lake','Sanity Studio','hosted versus self-host tradeoffs','Portable Text lessons']],
  ['00-foundation','05-competitive-analysis-strapi.md','Competitive Analysis: Strapi','A deep teardown of Strapi: the content-type builder, plugin marketplace, REST and GraphQL, and the lessons.',['content-type builder','plugin marketplace','community and ecosystem','weaknesses we exploit']],
  ['00-foundation','06-competitive-feature-matrix.md','Competitive Feature Matrix','A comprehensive feature-by-feature comparison table across KernelCMS, Payload, Sanity, and Strapi.',['the feature matrix table','scoring methodology','gaps and opportunities','headline takeaways']],
  ['00-foundation','07-personas-and-use-cases.md','Personas & Use Cases','The people KernelCMS serves and the jobs they hire it for.',['developer persona','content editor persona','agency and enterprise','indie and startup','primary use cases']],
  ['00-foundation','08-design-principles-and-tenets.md','Design Principles & Tenets','The engineering tenets that govern every KernelCMS decision.',['type-safety end to end','config-as-code','escape hatches everywhere','progressive disclosure','enforced performance budgets']],
  ['00-foundation','09-glossary-and-terminology.md','Glossary & Terminology','Canonical definitions for every core concept and term.',['collections, globals, fields','adapters','hooks and lifecycle','draft and version','tenant and project']],
  ['00-foundation','10-open-source-model-and-governance.md','Open Source Model & Governance','Licensing, the open-source versus commercial boundary, and the contribution and RFC process.',['MIT core license','OSS versus commercial Cloud boundary','contribution flow and CLA','RFC process','governance and roadmap ownership']],

  // 01 — Architecture
  ['01-architecture','00-system-architecture-overview.md','System Architecture Overview','The layered architecture and how the major subsystems fit together.',['layer diagram','core, server, admin, and cloud layers','end-to-end data flow','subsystem responsibilities']],
  ['01-architecture','01-monorepo-and-package-topology.md','Monorepo & Package Topology','The pnpm and Turborepo monorepo, package boundaries, and dependency rules.',['pnpm workspace layout','the @kernel/* package list','dependency boundary rules','Turborepo build pipeline']],
  ['01-architecture','02-tanstack-stack-integration.md','TanStack Stack Integration','How each TanStack library is used across server and admin.',['Start for SSR and server functions','Router','Query','Table and Form','Store, Virtual, and DB','where each library is used and why']],
  ['01-architecture','03-runtime-and-server-model.md','Runtime & Server Model','The server runtime, handler model, and host adapters.',['server-function model','host adapters for Node, Bun, and edge','handler composition','cold-start considerations']],
  ['01-architecture','04-request-lifecycle.md','Request Lifecycle','From an inbound request to a response: middleware, auth, hooks, and persistence.',['middleware chain','auth and context resolution','the operation pipeline','hook execution points']],
  ['01-architecture','05-the-adapter-pattern.md','The Adapter Pattern','The core extensibility primitive: pluggable database, storage, email, auth, search, cache, and queue adapters.',['the adapter contract interface','adapter registry and resolution','first-party adapters','community adapters','the choose-everything philosophy']],
  ['01-architecture','06-configuration-system.md','Configuration System','kernel.config.ts: the typed, code-first configuration that drives the whole system.',['the config schema','typed config with satisfies','env and secrets handling','config validation and defaults']],
  ['01-architecture','07-content-schema-and-type-generation.md','Content Schema & Type Generation','How config compiles into schema, database tables, and generated TypeScript types.',['config to internal schema','schema to database tables','schema to generated types','one single source of truth']],
  ['01-architecture','08-context-and-dependency-injection.md','Context & Dependency Injection','Request context, service resolution, and how subsystems access their dependencies.',['the request context object','the service container','scoping and lifetimes','testability']],
  ['01-architecture','09-error-model-and-result-types.md','Error Model & Result Types','Typed errors, the Result pattern, and consistent failure handling.',['the typed error base class','the Result type pattern','error serialization across APIs','user-facing versus internal errors']],
  ['01-architecture','10-caching-and-invalidation.md','Caching & Invalidation','The multi-layer caching strategy and tag-based invalidation aligned with TanStack Query.',['cache layers','tag-based invalidation','alignment with TanStack Query','stale-while-revalidate']],
  ['01-architecture','11-edge-and-serverless-compatibility.md','Edge & Serverless Compatibility','Running KernelCMS on edge and serverless runtimes.',['web-standard APIs','runtime constraints','database driver compatibility','cold start and connection pooling']],

  // 01 — Architecture / ADRs
  ['01-architecture/adr','0000-adr-process.md','ADR 0000: Architecture Decision Record Process','How KernelCMS records, accepts, and supersedes architectural decisions.',['the ADR format','lifecycle: proposed, accepted, superseded','where ADRs live and how they are numbered']],
  ['01-architecture/adr','0001-tanstack-start-foundation.md','ADR 0001: TanStack Start as the Foundation','Why TanStack Start underpins both the admin and the server.',['context','decision','consequences','alternatives considered (Next.js, Remix)']],
  ['01-architecture/adr','0002-drizzle-and-pluggable-db.md','ADR 0002: Drizzle and Pluggable Database Adapters','Why Drizzle is the default and how multiple databases are supported behind one contract.',['context','decision','consequences','alternatives considered (Prisma, raw SQL)']],
  ['01-architecture/adr','0003-config-as-code.md','ADR 0003: Config-as-Code over a UI Schema Builder','Why content modeling is code-first rather than a database-backed UI builder.',['context','decision','consequences','tradeoff versus the Strapi content-type builder']],
  ['01-architecture/adr','0004-react-admin.md','ADR 0004: React for the Admin Panel','Why the admin is React on TanStack Start, and the path to other frameworks later.',['context','decision','consequences','future multi-framework support']],
  ['01-architecture/adr','0005-plugin-and-hook-architecture.md','ADR 0005: Plugin & Hook Architecture','How extensibility is structured across config, schema, admin, and runtime.',['context','decision','consequences','comparison to Payload and Strapi plugins']],

  // 02 — Data Modeling
  ['02-data-modeling','00-content-modeling-overview.md','Content Modeling Overview','How content is modeled in KernelCMS: collections, globals, and fields.',['the mental model','collections versus globals','fields','relationships']],
  ['02-data-modeling','01-collections.md','Collections','Defining, configuring, and operating on collections.',['collection config shape','slugs and labels','admin options','per-collection access and hooks']],
  ['02-data-modeling','02-globals-and-singletons.md','Globals & Singletons','Single-instance content such as site settings and navigation.',['global config','use cases','versioning of globals','access control on globals']],
  ['02-data-modeling','03-fields-overview-and-architecture.md','Fields: Overview & Architecture','The field system: how fields are defined, validated, stored, and rendered.',['the field definition shape','the field lifecycle','data fields versus presentational fields','custom field hook-in points']],
  ['02-data-modeling','04-field-types-catalog.md','Field Types Catalog','The complete catalog of built-in field types with config and storage notes.',['scalar fields','date, email, json, code, point','select, radio, checkbox','ui and virtual fields','a table of every field type']],
  ['02-data-modeling','05-relationship-fields.md','Relationship Fields','Modeling relationships: to-one, to-many, polymorphic, and bi-directional joins.',['relationship config','polymorphic relationships','bi-directional joins','population and depth control']],
  ['02-data-modeling','06-array-and-block-fields.md','Array & Block Fields','Repeatable arrays and the flexible block and layout builder.',['array fields','blocks as discriminated unions','the layout builder UX','the storage model']],
  ['02-data-modeling','07-rich-text-and-portable-content.md','Rich Text & Portable Content','The structured rich-text model and how it serializes.',['the structured JSON model','comparison to Portable Text and Lexical','serializers to HTML, Markdown, and JSX','embeds and custom nodes']],
  ['02-data-modeling','08-validation-and-constraints.md','Validation & Constraints','Field-level and document-level validation.',['built-in validators','custom validators','async validation','cross-field constraints']],
  ['02-data-modeling','09-localization-and-i18n.md','Localization & i18n','Field-level localization and multi-locale content.',['locale config','field-level localization','fallback chains','admin locale switcher','locale params in the API']],
  ['02-data-modeling','10-versioning-drafts-and-autosave.md','Versioning, Drafts & Autosave','The draft and publish workflow, version history, and autosave.',['draft versus published','version history and diffs','autosave','scheduled publish','restore a version']],
  ['02-data-modeling','11-data-migrations-and-schema-evolution.md','Data Migrations & Schema Evolution','Evolving content schemas safely over time.',['migration files','generated versus handwritten','data backfills','zero-downtime schema changes']],

  // 03 — Persistence
  ['03-persistence','00-persistence-overview-and-adapter-contract.md','Persistence Overview & Adapter Contract','The database adapter contract every backend implements.',['the adapter interface (find, create, update, delete, transaction)','capability flags','the query AST','how config maps to storage']],
  ['03-persistence','01-drizzle-adapter.md','Drizzle Adapter','The default Drizzle-based adapter shared across SQL databases.',['Drizzle schema generation','query building','relations','migration integration']],
  ['03-persistence','02-postgres-adapter.md','PostgreSQL Adapter','Postgres-specific behavior and optimizations.',['JSONB usage','full-text search','indexing strategy','connection pooling','Postgres-only features']],
  ['03-persistence','03-sqlite-adapter.md','SQLite Adapter','SQLite and libSQL for local-first and edge deployments.',['libSQL and Turso','local-first development','limitations','edge usage']],
  ['03-persistence','04-mysql-adapter.md','MySQL Adapter','MySQL and MariaDB support and constraints.',['type mapping','JSON columns','limitations versus Postgres','indexing notes']],
  ['03-persistence','05-mongodb-adapter.md','MongoDB Adapter','The document-database adapter for schemaless workflows.',['document mapping','query translation','transactions','when to choose Mongo']],
  ['03-persistence','06-query-engine-and-find-api.md','Query Engine & Find API','The unified find API and how queries compile per backend.',['where syntax','operators','sort, limit, and pagination','depth and population','query compilation per backend']],
  ['03-persistence','07-transactions-and-consistency.md','Transactions & Consistency','Transactional guarantees across operations and hooks.',['transaction boundaries','hooks running inside transactions','cross-adapter consistency','idempotency']],
  ['03-persistence','08-migrations-engine.md','Migrations Engine','How migrations are generated, ordered, and applied.',['the migration lifecycle','generation from schema diff','apply and rollback','the production migration strategy']],

  // 04 — Admin UI
  ['04-admin-ui','00-admin-panel-architecture.md','Admin Panel Architecture','How the React admin is structured on TanStack Start.',['route structure with TanStack Router','the data layer with TanStack Query','config-driven UI','code-splitting strategy']],
  ['04-admin-ui','01-design-system-and-tokens.md','Design System & Tokens','The token architecture and visual language of the admin.',['design tokens for color, space, and type','theming primitives','dark mode','density modes']],
  ['04-admin-ui','02-component-library.md','Component Library','The reusable component set that builds the admin.',['the primitives inventory','composition patterns','headless plus styled split','accessibility baked in']],
  ['04-admin-ui','03-navigation-and-app-shell.md','Navigation & App Shell','The shell: sidebar, breadcrumbs, and global navigation.',['the app-shell layout','collection nav generation','breadcrumbs','responsive shell']],
  ['04-admin-ui','04-dashboard-and-home.md','Dashboard & Home','The landing dashboard and customizable widgets.',['the default dashboard','widgets','custom dashboard slots','recent activity feed']],
  ['04-admin-ui','05-collection-list-views.md','Collection List Views','Data tables for browsing content, built on TanStack Table.',['TanStack Table integration','column configuration','filters, search, and sort','bulk actions','saved views']],
  ['04-admin-ui','06-document-edit-view.md','Document Edit View','The document editor, field rendering, version controls, and autosave.',['the edit layout','the field rendering pipeline','the status and versions sidebar','autosave UI','surfacing validation errors']],
  ['04-admin-ui','07-field-components-and-rendering.md','Field Components & Rendering','How field configs become interactive React components.',['the field component registry','TanStack Form binding','conditional fields','the custom field override API']],
  ['04-admin-ui','08-rich-text-editor.md','Rich Text Editor','The block-based rich-text editor and its extension model.',['editor architecture','blocks, marks, and nodes','toolbar and slash menu','embeds','serialization to the schema model']],
  ['04-admin-ui','09-media-library-ui.md','Media Library UI','Browsing, uploading, and selecting media in the admin.',['grid and list browsing','drag-and-drop upload UX','search and folders','selecting media inside fields']],
  ['04-admin-ui','10-live-preview-and-visual-editing.md','Live Preview & Visual Editing','Real-time preview and click-to-edit overlays on the live site.',['the live-preview iframe','passing draft data','visual editing overlays','comparison to Sanity Presentation']],
  ['04-admin-ui','11-command-palette-and-keyboard.md','Command Palette & Keyboard UX','Power-user navigation and keyboard-driven workflows.',['the command palette','keyboard shortcuts','the quick switcher','accessibility of shortcuts']],
  ['04-admin-ui','12-theming-and-white-label.md','Theming & White-Label','Rebranding the admin for agencies and enterprises.',['the theme override API','logo, colors, and copy','a custom CSS layer','per-tenant theming']],
  ['04-admin-ui','13-accessibility-standards.md','Admin Accessibility Standards','WCAG conformance and inclusive design for the admin.',['WCAG 2.2 AA targets','keyboard and focus management','ARIA patterns','the testing approach']],
  ['04-admin-ui','14-admin-i18n-and-rtl.md','Admin i18n & RTL','Translating the admin UI and supporting right-to-left languages.',['the UI translation system','locale loading','RTL layout','date and number formatting']],

  // 05 — API
  ['05-api','00-api-overview-and-philosophy.md','API Overview & Philosophy','The three coordinated API surfaces and when to use each.',['REST, GraphQL, and typed RPC overview','the shared operation core','consistency guarantees','choosing an API surface']],
  ['05-api','01-rest-api.md','REST API','The auto-generated REST API for every collection and global.',['endpoint shape','CRUD routes','query parameters','auth','worked examples']],
  ['05-api','02-graphql-api.md','GraphQL API','The generated GraphQL schema and resolver model.',['schema generation','queries and mutations','depth and complexity limits','comparison to Strapi and Payload GraphQL']],
  ['05-api','03-typed-rpc-and-local-api.md','Typed RPC & Local API','The end-to-end typed Local API and server-side data access.',['the Local API surface','TanStack Start server functions','in-process no-HTTP access','type inference end to end']],
  ['05-api','04-query-filtering-sorting-pagination.md','Querying: Filtering, Sorting & Pagination','The shared query language across all API surfaces.',['filter operators','sorting','offset versus cursor pagination','population and depth']],
  ['05-api','05-realtime-and-subscriptions.md','Realtime & Subscriptions','Live data via subscriptions and change streams.',['transport (SSE and WebSocket)','the subscription model','presence and collaboration hooks','scaling realtime']],
  ['05-api','06-webhooks.md','Webhooks','Outbound webhooks for content events.',['event triggers','payload and signing','retries and delivery guarantees','consumer patterns']],
  ['05-api','07-api-versioning-and-deprecation.md','API Versioning & Deprecation','How API surfaces evolve without breaking consumers.',['the versioning strategy','the deprecation policy','schema evolution','compatibility windows']],

  // 06 — Auth & Security
  ['06-auth-security','00-authentication.md','Authentication','User authentication for the admin and for API consumers.',['auth strategies','password hashing with argon2 and bcrypt','sessions versus tokens','email verification and reset']],
  ['06-auth-security','01-authorization-and-access-control.md','Authorization & Access Control','The access-control model gating every operation and field.',['access functions','operation-level access','field-level access','document and row-level rules']],
  ['06-auth-security','02-roles-permissions-rbac-abac.md','Roles, Permissions, RBAC & ABAC','Role-based and attribute-based permission modeling.',['roles and permissions','the RBAC model','ABAC conditions','permission resolution order']],
  ['06-auth-security','03-sessions-jwt-and-api-keys.md','Sessions, JWT & API Keys','Credential types and their lifecycles.',['session cookies (Secure, HttpOnly, SameSite)','JWT handling','API keys and scopes','rotation and revocation']],
  ['06-auth-security','04-sso-oauth-and-social-login.md','SSO, OAuth & Social Login','Federated identity and enterprise single sign-on.',['OAuth and OIDC','SAML for enterprise','social providers','account linking']],
  ['06-auth-security','05-mfa-and-account-security.md','MFA & Account Security','Multi-factor authentication and account protection.',['TOTP and WebAuthn','recovery codes','rate limiting and lockout','audit logging']],
  ['06-auth-security','06-security-model-and-hardening.md','Security Model & Hardening','The platform security posture and its defenses.',['the threat surface','input validation and output encoding','CSRF, XSS, and SSRF defenses','CSP and security headers','secrets handling']],
  ['06-auth-security','07-data-privacy-and-compliance.md','Data Privacy & Compliance','Privacy features and regulatory alignment.',['GDPR and CCPA','data export and erasure','audit trails','data residency']],

  // 07 — Media & Files
  ['07-media-files','00-media-and-uploads-overview.md','Media & Uploads Overview','How uploads, media metadata, and delivery work end to end.',['the upload pipeline','media as a collection','metadata extraction','delivery']],
  ['07-media-files','01-storage-adapters.md','Storage Adapters','Pluggable storage backends for files.',['the storage adapter contract','local, S3, R2, GCS, and Azure','signed URLs','migrating between stores']],
  ['07-media-files','02-image-processing-and-transforms.md','Image Processing & Transforms','On-demand and ahead-of-time image transformations.',['resize, format, and quality','the sharp and wasm pipeline','on-the-fly versus pregenerated','AVIF and WebP']],
  ['07-media-files','03-focal-points-crops-and-responsive.md','Focal Points, Crops & Responsive Images','Art direction and responsive delivery.',['focal point selection','named crops','srcset generation','responsive image helpers']],
  ['07-media-files','04-cdn-and-delivery.md','CDN & Delivery','Caching and globally distributing media.',['CDN integration','cache keys and invalidation','signed delivery','edge transforms']],
  ['07-media-files','05-file-security-and-validation.md','File Security & Validation','Keeping uploads safe.',['mime and type validation','size limits','malware scanning hooks','access control on private files']],

  // 08 — Extensibility
  ['08-extensibility','00-plugin-system-architecture.md','Plugin System Architecture','How plugins extend config, schema, admin, and runtime.',['the plugin shape','config transformation','the capability surface','isolation and ordering']],
  ['08-extensibility','01-plugin-sdk-and-authoring.md','Plugin SDK & Authoring','Building, testing, and publishing a plugin.',['the plugin API','the plugin lifecycle','testing plugins','publishing and semver']],
  ['08-extensibility','02-hooks-and-lifecycle.md','Hooks & Lifecycle','The complete hook surface for documents and operations.',['before and after operation hooks','field hooks','collection versus global hooks','hook ordering and context']],
  ['08-extensibility','03-custom-fields.md','Custom Fields','Authoring new field types with both data and UI.',['the field type definition','server validation and storage','the admin component','registration']],
  ['08-extensibility','04-custom-admin-components-and-slots.md','Custom Admin Components & Slots','Injecting custom UI into the admin.',['component slots and overrides','custom views and routes','providers','reusing the design system']],
  ['08-extensibility','05-custom-endpoints-and-routes.md','Custom Endpoints & Routes','Adding bespoke server endpoints alongside the generated API.',['endpoint registration','access to context','reusing auth','worked examples']],
  ['08-extensibility','06-events-and-messaging.md','Events & Messaging','The internal event bus and external pub/sub integration.',['the event catalog','subscribers','external brokers (NATS, Kafka)','ordering and delivery']],
  ['08-extensibility','07-jobs-queues-and-scheduling.md','Jobs, Queues & Scheduling','Background work, queues, and cron.',['job definition','queue adapters','retries and backoff','scheduled tasks']],
  ['08-extensibility','08-plugin-marketplace-and-registry.md','Plugin Marketplace & Registry','Discovering and distributing community plugins.',['the registry model','metadata and trust','versioning','monetization options']],

  // 09 — Developer Experience
  ['09-developer-experience','00-dx-overview-and-principles.md','Developer Experience Overview','The DX north star and what great feels like.',['time-to-first-content','type-safety everywhere','escape hatches','error message quality']],
  ['09-developer-experience','01-cli-and-scaffolding.md','CLI & Scaffolding','create-kernel and the project CLI.',['create-kernel','generators','dev, build, and migrate commands','codemods']],
  ['09-developer-experience','02-typescript-codegen-and-types.md','TypeScript Codegen & Types','Generated types from content config.',['generated types output','inference versus codegen','keeping types in sync','consuming generated types']],
  ['09-developer-experience','03-client-sdk-and-data-fetching.md','Client SDK & Data Fetching','The typed client and TanStack Query integration for frontends.',['the typed client','query and mutation helpers','TanStack Query hooks','caching and invalidation']],
  ['09-developer-experience','04-local-development-and-hmr.md','Local Development & HMR','The local dev loop and hot reload.',['the dev server','schema and type watching','HMR for the admin','seed and reset workflow']],
  ['09-developer-experience','05-seeding-and-fixtures.md','Seeding & Fixtures','Deterministic data for development and tests.',['the seed API','fixtures','reset and snapshot','factory helpers']],
  ['09-developer-experience','06-templates-starters-and-examples.md','Templates, Starters & Examples','Official starters and example applications.',['the starter catalog','example apps','use-case templates','maintenance strategy']],
  ['09-developer-experience','07-testing-utilities-and-harness.md','Testing Utilities & Harness','First-party tools for testing KernelCMS apps.',['the in-memory adapter','the test client','auth helpers','snapshot and db reset']],

  // 10 — Cloud & Operations
  ['10-cloud-operations','00-deployment-models-self-host-vs-cloud.md','Deployment Models: Self-Host vs Cloud','The two ways to run KernelCMS and how they relate.',['self-host: own everything','managed cloud: Sanity-style','the hybrid model','data ownership and portability']],
  ['10-cloud-operations','01-managed-cloud-platform-architecture.md','Managed Cloud Platform Architecture','The hosted platform that runs KernelCMS for teams.',['control plane versus data plane','project provisioning','tenant isolation','platform services']],
  ['10-cloud-operations','02-self-hosting-guide-docker-and-k8s.md','Self-Hosting: Docker & Kubernetes','Running KernelCMS on your own infrastructure.',['the Docker image','a Compose stack','Kubernetes and Helm','config and secrets','upgrades']],
  ['10-cloud-operations','03-multi-tenancy-and-isolation.md','Multi-Tenancy & Isolation','Serving many tenants safely in one deployment.',['isolation models (row, schema, database)','tenant context middleware','noisy-neighbor controls','per-tenant config']],
  ['10-cloud-operations','04-billing-metering-and-plans.md','Billing, Metering & Plans','Monetizing the managed cloud.',['plan tiers','usage metering','Stripe integration','overages and limits']],
  ['10-cloud-operations','05-observability-logging-metrics-tracing.md','Observability: Logging, Metrics & Tracing','Seeing inside a running KernelCMS.',['structured logging','metrics (RED and USE)','OpenTelemetry tracing','dashboards and alerts']],
  ['10-cloud-operations','06-backups-and-disaster-recovery.md','Backups & Disaster Recovery','Protecting and restoring content.',['backup strategy','point-in-time recovery','restore drills','RPO and RTO targets']],
  ['10-cloud-operations','07-scaling-and-performance-operations.md','Scaling & Performance Operations','Operating KernelCMS under load.',['horizontal scaling','database scaling and read replicas','caching tiers','load testing']],
  ['10-cloud-operations','08-edge-and-content-delivery-network.md','Edge & Content Delivery Network','Delivering content globally with low latency.',['the edge runtime','the content CDN','cache invalidation','regional data']],

  // 11 — Quality
  ['11-quality','00-testing-strategy.md','Testing Strategy','The test pyramid across the monorepo.',['unit, integration, and e2e split','real-database integration tests','admin e2e with Playwright','coverage targets']],
  ['11-quality','01-ci-cd-and-release-engineering.md','CI/CD & Release Engineering','Pipelines, releases, and changesets.',['CI pipeline stages','matrix testing across adapters','changesets and publishing','canary and preview releases']],
  ['11-quality','02-performance-benchmarks-and-budgets.md','Performance Benchmarks & Budgets','How we measure and defend performance.',['the benchmark suite','admin bundle budgets','query benchmarks versus competitors','regression gates']],
  ['11-quality','03-threat-model-stride.md','Threat Model (STRIDE)','A STRIDE threat model of the platform.',['assets and trust boundaries','STRIDE per component','top risks and mitigations','residual risk']],
  ['11-quality','04-accessibility-and-compliance-testing.md','Accessibility & Compliance Testing','Automated and manual accessibility and compliance gates.',['axe and automated checks','manual audits','the VPAT','CI gates']],
  ['11-quality','05-documentation-and-dx-quality.md','Documentation & DX Quality','How docs stay accurate and helpful.',['docs site architecture','drift detection from types','examples that run in CI','the feedback loop']],

  // 12 — Ecosystem & Migration
  ['12-ecosystem-migration','00-frontend-framework-integrations.md','Frontend Framework Integrations','Consuming KernelCMS from any frontend.',['TanStack Start as first-class','Next, Remix, Astro, Nuxt, and SvelteKit','draft and preview integration','ISR and revalidation']],
  ['12-ecosystem-migration','01-migrating-from-payload.md','Migrating from Payload','A playbook for moving Payload projects to KernelCMS.',['config mapping','data migration','API differences','common gotchas']],
  ['12-ecosystem-migration','02-migrating-from-sanity.md','Migrating from Sanity','Moving from Sanity: schemas, GROQ, and the content lake.',['schema mapping','GROQ to KernelCMS queries','dataset export and import','Portable Text conversion']],
  ['12-ecosystem-migration','03-migrating-from-strapi.md','Migrating from Strapi','Moving Strapi projects over.',['content-type mapping','data import','plugin equivalents','API differences']],
  ['12-ecosystem-migration','04-integrations-and-third-party.md','Integrations & Third-Party Services','Connecting KernelCMS to the wider ecosystem.',['search (Algolia, Typesense)','payments (Stripe)','analytics','AI providers','DAM and email']],
  ['12-ecosystem-migration','05-community-and-ecosystem-strategy.md','Community & Ecosystem Strategy','Growing adoption and contributors.',['community channels','the plugin ecosystem flywheel','docs and education','partnerships']],

  // 13 — Roadmap
  ['13-roadmap','00-mvp-scope-and-definition.md','MVP Scope & Definition','What the first shippable version includes.',['the MVP feature set','explicit exclusions','definition of done','the target user for the MVP']],
  ['13-roadmap','01-milestones-and-phases.md','Milestones & Phases','The phased build plan from MVP to GA.',['phase breakdown','sequencing and dependencies','team allocation','exit criteria per phase']],
  ['13-roadmap','02-release-plan-and-versioning.md','Release Plan & Versioning','How versions ship and what stability means.',['the semver policy','alpha, beta, and GA','LTS','deprecation cadence']],
  ['13-roadmap','03-feature-parity-roadmap.md','Feature Parity Roadmap','A sequenced plan to reach and exceed competitor parity.',['parity targets by competitor','sequencing','differentiators beyond parity','tracking progress']],
  ['13-roadmap','04-risks-and-mitigations.md','Risks & Mitigations','The major risks to the project and how we counter them.',['technical risks','market and adoption risks','dependency risk on TanStack','mitigations']],
  ['13-roadmap','05-success-metrics-and-kpis.md','Success Metrics & KPIs','How we measure whether KernelCMS is winning.',['adoption metrics','DX metrics','performance KPIs','community health']],
]

// ---------------------------------------------------------------------------
// Phase grouping for the progress display.
// ---------------------------------------------------------------------------
const CATEGORIES = [
  ['00-foundation', 'Foundation'],
  ['01-architecture', 'Architecture'],
  ['02-data-modeling', 'Data Modeling'],
  ['03-persistence', 'Persistence'],
  ['04-admin-ui', 'Admin UI'],
  ['05-api', 'API'],
  ['06-auth-security', 'Auth & Security'],
  ['07-media-files', 'Media & Files'],
  ['08-extensibility', 'Extensibility'],
  ['09-developer-experience', 'Developer Experience'],
  ['10-cloud-operations', 'Cloud & Operations'],
  ['11-quality', 'Quality'],
  ['12-ecosystem-migration', 'Ecosystem & Migration'],
  ['13-roadmap', 'Roadmap'],
]
const PHASE_BY_PREFIX = Object.fromEntries(CATEGORIES)
function phaseFor(dir) { return PHASE_BY_PREFIX[dir.split('/')[0]] || 'Foundation' }

const STATUS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string' },
    title: { type: 'string' },
    words: { type: 'number' },
    sections: { type: 'array', items: { type: 'string' } },
    status: { type: 'string', enum: ['written', 'failed'] },
    note: { type: 'string' },
  },
  required: ['path', 'title', 'status'],
}

function docPrompt(d) {
  const dir = d[0], file = d[1], title = d[2], purpose = d[3], keys = d[4]
  const abs = DOCS_DIR + '/' + dir + '/' + file
  return [
    'You are a principal engineer and technical writer on KernelCMS, an open-source, TanStack-native headless CMS that competes with Payload, Sanity, and Strapi.',
    '',
    'CANONICAL PROJECT BRIEF (the single source of truth — obey every detail and use the exact names):',
    ANCHOR,
    '',
    'TASK: Write exactly ONE Markdown documentation file. Do NOT explore the filesystem or read other files. Just write this one file with the Write tool.',
    'Absolute file path to write: ' + abs,
    'Document H1 title: ' + title,
    'Purpose: ' + purpose,
    'Must cover (turn each into a real section with depth, not a one-line bullet): ' + keys.join('; ') + '.',
    '',
    'REQUIREMENTS:',
    '- 900 to 1700 words of substantive, production-grade planning and specification content.',
    '- Begin with a single H1 equal to the title, then a one-paragraph summary, then H2 and H3 sections.',
    '- Be concrete and opinionated. Use fenced TypeScript code blocks, tables, and small ASCII diagrams where they add real value. Show realistic kernel.config.ts snippets and @kernel/* APIs.',
    '- Reference Payload, Sanity, and/or Strapi specifically wherever relevant: what they do and how KernelCMS differs or wins.',
    '- Use the canonical product name, package names, and terminology from the brief exactly. Cross-link sibling docs with relative Markdown links where natural.',
    '- Senior-engineer voice. No marketing fluff, no AI throat-clearing, no "in conclusion" or "in summary" filler.',
    '- Where a design point is genuinely undecided, add a short "Open questions" section at the end.',
    '',
    'After writing the file, return the status object: the path, the title, the word count, the H2 section titles, and status set to "written".',
  ].join('\n')
}

function writeVerbatimPrompt(path, content) {
  return [
    'You are writing one file. Do NOT explore the filesystem or read other files.',
    'Create the file at this exact absolute path: ' + path,
    'Write EXACTLY the content between the markers below, verbatim, with no additions, edits, or commentary. Do not include the marker lines in the file.',
    '<<<BEGIN-CONTENT>>>',
    content,
    '<<<END-CONTENT>>>',
    'After writing, return the status object with status set to "written".',
  ].join('\n')
}

function buildIndex() {
  let md = ''
  md += '# KernelCMS — Documentation\n\n'
  md += 'KernelCMS is an open-source, TanStack-native headless CMS built to compete with Payload, Sanity, and Strapi. '
  md += 'It is config-as-code, adapter-based (choose your own database, storage, auth, and more), and runs either fully self-hosted or on the managed KernelCMS Cloud.\n\n'
  md += 'This is the planning corpus: ' + DOCS.length + ' specification documents across ' + CATEGORIES.length + ' domains. '
  md += 'Start with [Vision & Mission](./00-foundation/00-vision-and-mission.md) and the [Product Overview](./00-foundation/01-product-overview.md).\n\n'
  md += '---\n\n'
  for (const pair of CATEGORIES) {
    const prefix = pair[0], name = pair[1]
    const items = DOCS.filter(function (d) { return d[0].split('/')[0] === prefix })
    md += '## ' + name + '\n\n'
    for (const d of items) {
      md += '- [' + d[2] + '](./' + d[0] + '/' + d[1] + ') — ' + d[3] + '\n'
    }
    md += '\n'
  }
  md += '---\n\n'
  md += '_Generated as a planning corpus. Every document follows the canonical project brief; see [Design Principles & Tenets](./00-foundation/08-design-principles-and-tenets.md)._\n'
  return md
}

function buildRootReadme() {
  return [
    '# KernelCMS',
    '',
    'The TanStack-native, open-source headless CMS.',
    '',
    'KernelCMS is a content platform built to compete head-on with Payload, Sanity, and Strapi. It is config-as-code, end-to-end type-safe, and adapter-based: you choose your own database, storage, auth, search, cache, and queue. Run it fully self-hosted, or on the managed KernelCMS Cloud — your content and config stay portable either way.',
    '',
    '> Status: Planning. This repository currently holds the design and specification corpus. See [docs/README.md](./docs/README.md).',
    '',
    '## Why KernelCMS',
    '',
    '- TanStack-native. The whole stack — server and admin — is built on TanStack Start, Router, Query, Table, Form, Store, Virtual, and DB.',
    '- Choose everything. Database (Postgres, SQLite, MySQL, MongoDB), storage, email, auth, search, cache, and queue are all swappable adapters.',
    '- Config-as-code. Model content in kernel.config.ts; get generated types, a REST API, a GraphQL API, and a fully typed Local/RPC API.',
    '- Two ways to run. Self-host with Docker or Kubernetes, or use the managed KernelCMS Cloud. No lock-in.',
    '- Open source. MIT-licensed core; optional commercial Cloud and enterprise add-ons.',
    '',
    '## The stack',
    '',
    '| Concern | Default | Swappable |',
    '| --- | --- | --- |',
    '| Framework | TanStack Start | — |',
    '| Database | Postgres via Drizzle | SQLite/libSQL, MySQL, MongoDB |',
    '| Storage | Local filesystem | S3, R2, GCS, Azure |',
    '| Admin | React on TanStack Start | — |',
    '| APIs | REST + GraphQL + typed RPC | — |',
    '',
    '## Documentation',
    '',
    'The full planning corpus lives in [`docs/`](./docs/README.md), organized into 14 domains — foundation, architecture, data modeling, persistence, admin UI, API, auth and security, media, extensibility, developer experience, cloud and operations, quality, ecosystem and migration, and roadmap.',
    '',
    '## License',
    '',
    'MIT (planned) for the core. See [Open Source Model & Governance](./docs/00-foundation/10-open-source-model-and-governance.md).',
    '',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Execute: fan out one agent per document, then write the index and README.
// ---------------------------------------------------------------------------
log('KernelCMS: generating ' + DOCS.length + ' planning documents across ' + CATEGORIES.length + ' domains...')

const results = (await parallel(DOCS.map(function (d) {
  return function () {
    return agent(docPrompt(d), {
      label: d[2],
      phase: phaseFor(d[0]),
      schema: STATUS_SCHEMA,
      agentType: 'general-purpose',
    })
  }
}))).filter(Boolean)

const written = results.filter(function (r) { return r && r.status === 'written' })
log('Documents written: ' + written.length + ' of ' + DOCS.length + '. Finalizing index and README...')

const indexMd = buildIndex()
const rootReadme = buildRootReadme()

const finals = (await parallel([
  function () {
    return agent(writeVerbatimPrompt(DOCS_DIR + '/README.md', indexMd), {
      label: 'docs/README.md (master index)', phase: 'Finalize', schema: STATUS_SCHEMA, agentType: 'general-purpose',
    })
  },
  function () {
    return agent(writeVerbatimPrompt(BASE + '/README.md', rootReadme), {
      label: 'README.md (root)', phase: 'Finalize', schema: STATUS_SCHEMA, agentType: 'general-purpose',
    })
  },
])).filter(Boolean)

return {
  totalDocs: DOCS.length,
  written: written.length,
  failed: DOCS.length - written.length,
  finalized: finals.map(function (f) { return f && f.path }),
  byCategory: CATEGORIES.map(function (pair) {
    return { category: pair[1], count: DOCS.filter(function (d) { return d[0].split('/')[0] === pair[0] }).length }
  }),
}
