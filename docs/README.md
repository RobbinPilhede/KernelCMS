# KernelCMS — Documentation

KernelCMS is an open-source, TanStack-native headless CMS built to compete with Payload, Sanity, and Strapi. It is config-as-code, adapter-based (choose your own database, storage, auth, and more), and runs either fully self-hosted or on the managed KernelCMS Cloud.

This is the planning corpus: 131 specification documents across 14 domains. Start with [Vision & Mission](./00-foundation/00-vision-and-mission.md) and the [Product Overview](./00-foundation/01-product-overview.md).

---

## Foundation

- [Vision & Mission](./00-foundation/00-vision-and-mission.md) — The north star: what is broken in the current CMS landscape, why a TanStack-native CMS now, and the three-year vision.
- [Product Overview](./00-foundation/01-product-overview.md) — What KernelCMS is, its core capabilities, and who it serves at a glance.
- [Positioning & Differentiation](./00-foundation/02-positioning-and-differentiation.md) — How KernelCMS wins against Payload, Sanity, and Strapi — the wedge and the moat.
- [Competitive Analysis: Payload](./00-foundation/03-competitive-analysis-payload.md) — A deep teardown of Payload CMS: architecture, strengths, weaknesses, and what KernelCMS adopts or beats.
- [Competitive Analysis: Sanity](./00-foundation/04-competitive-analysis-sanity.md) — A deep teardown of Sanity: GROQ, Studio, the hosted content lake, Portable Text, and the lessons for KernelCMS.
- [Competitive Analysis: Strapi](./00-foundation/05-competitive-analysis-strapi.md) — A deep teardown of Strapi: the content-type builder, plugin marketplace, REST and GraphQL, and the lessons.
- [Competitive Feature Matrix](./00-foundation/06-competitive-feature-matrix.md) — A comprehensive feature-by-feature comparison table across KernelCMS, Payload, Sanity, and Strapi.
- [Personas & Use Cases](./00-foundation/07-personas-and-use-cases.md) — The people KernelCMS serves and the jobs they hire it for.
- [Design Principles & Tenets](./00-foundation/08-design-principles-and-tenets.md) — The engineering tenets that govern every KernelCMS decision.
- [Glossary & Terminology](./00-foundation/09-glossary-and-terminology.md) — Canonical definitions for every core concept and term.
- [Open Source Model & Governance](./00-foundation/10-open-source-model-and-governance.md) — Licensing, the open-source versus commercial boundary, and the contribution and RFC process.

## Architecture

- [System Architecture Overview](./01-architecture/00-system-architecture-overview.md) — The layered architecture and how the major subsystems fit together.
- [Monorepo & Package Topology](./01-architecture/01-monorepo-and-package-topology.md) — The pnpm and Turborepo monorepo, package boundaries, and dependency rules.
- [TanStack Stack Integration](./01-architecture/02-tanstack-stack-integration.md) — How each TanStack library is used across server and admin.
- [Runtime & Server Model](./01-architecture/03-runtime-and-server-model.md) — The server runtime, handler model, and host adapters.
- [Request Lifecycle](./01-architecture/04-request-lifecycle.md) — From an inbound request to a response: middleware, auth, hooks, and persistence.
- [The Adapter Pattern](./01-architecture/05-the-adapter-pattern.md) — The core extensibility primitive: pluggable database, storage, email, auth, search, cache, and queue adapters.
- [Configuration System](./01-architecture/06-configuration-system.md) — kernel.config.ts: the typed, code-first configuration that drives the whole system.
- [Content Schema & Type Generation](./01-architecture/07-content-schema-and-type-generation.md) — How config compiles into schema, database tables, and generated TypeScript types.
- [Context & Dependency Injection](./01-architecture/08-context-and-dependency-injection.md) — Request context, service resolution, and how subsystems access their dependencies.
- [Error Model & Result Types](./01-architecture/09-error-model-and-result-types.md) — Typed errors, the Result pattern, and consistent failure handling.
- [Caching & Invalidation](./01-architecture/10-caching-and-invalidation.md) — The multi-layer caching strategy and tag-based invalidation aligned with TanStack Query.
- [Edge & Serverless Compatibility](./01-architecture/11-edge-and-serverless-compatibility.md) — Running KernelCMS on edge and serverless runtimes.
- [ADR 0000: Architecture Decision Record Process](./01-architecture/adr/0000-adr-process.md) — How KernelCMS records, accepts, and supersedes architectural decisions.
- [ADR 0001: TanStack Start as the Foundation](./01-architecture/adr/0001-tanstack-start-foundation.md) — Why TanStack Start underpins both the admin and the server.
- [ADR 0002: Drizzle and Pluggable Database Adapters](./01-architecture/adr/0002-drizzle-and-pluggable-db.md) — Why Drizzle is the default and how multiple databases are supported behind one contract.
- [ADR 0003: Config-as-Code over a UI Schema Builder](./01-architecture/adr/0003-config-as-code.md) — Why content modeling is code-first rather than a database-backed UI builder.
- [ADR 0004: React for the Admin Panel](./01-architecture/adr/0004-react-admin.md) — Why the admin is React on TanStack Start, and the path to other frameworks later.
- [ADR 0005: Plugin & Hook Architecture](./01-architecture/adr/0005-plugin-and-hook-architecture.md) — How extensibility is structured across config, schema, admin, and runtime.

## Data Modeling

- [Content Modeling Overview](./02-data-modeling/00-content-modeling-overview.md) — How content is modeled in KernelCMS: collections, globals, and fields.
- [Collections](./02-data-modeling/01-collections.md) — Defining, configuring, and operating on collections.
- [Globals & Singletons](./02-data-modeling/02-globals-and-singletons.md) — Single-instance content such as site settings and navigation.
- [Fields: Overview & Architecture](./02-data-modeling/03-fields-overview-and-architecture.md) — The field system: how fields are defined, validated, stored, and rendered.
- [Field Types Catalog](./02-data-modeling/04-field-types-catalog.md) — The complete catalog of built-in field types with config and storage notes.
- [Relationship Fields](./02-data-modeling/05-relationship-fields.md) — Modeling relationships: to-one, to-many, polymorphic, and bi-directional joins.
- [Array & Block Fields](./02-data-modeling/06-array-and-block-fields.md) — Repeatable arrays and the flexible block and layout builder.
- [Rich Text & Portable Content](./02-data-modeling/07-rich-text-and-portable-content.md) — The structured rich-text model and how it serializes.
- [Validation & Constraints](./02-data-modeling/08-validation-and-constraints.md) — Field-level and document-level validation.
- [Localization & i18n](./02-data-modeling/09-localization-and-i18n.md) — Field-level localization and multi-locale content.
- [Versioning, Drafts & Autosave](./02-data-modeling/10-versioning-drafts-and-autosave.md) — The draft and publish workflow, version history, and autosave.
- [Data Migrations & Schema Evolution](./02-data-modeling/11-data-migrations-and-schema-evolution.md) — Evolving content schemas safely over time.

## Persistence

- [Persistence Overview & Adapter Contract](./03-persistence/00-persistence-overview-and-adapter-contract.md) — The database adapter contract every backend implements.
- [Drizzle Adapter](./03-persistence/01-drizzle-adapter.md) — The default Drizzle-based adapter shared across SQL databases.
- [PostgreSQL Adapter](./03-persistence/02-postgres-adapter.md) — Postgres-specific behavior and optimizations.
- [SQLite Adapter](./03-persistence/03-sqlite-adapter.md) — SQLite and libSQL for local-first and edge deployments.
- [MySQL Adapter](./03-persistence/04-mysql-adapter.md) — MySQL and MariaDB support and constraints.
- [MongoDB Adapter](./03-persistence/05-mongodb-adapter.md) — The document-database adapter for schemaless workflows.
- [Query Engine & Find API](./03-persistence/06-query-engine-and-find-api.md) — The unified find API and how queries compile per backend.
- [Transactions & Consistency](./03-persistence/07-transactions-and-consistency.md) — Transactional guarantees across operations and hooks.
- [Migrations Engine](./03-persistence/08-migrations-engine.md) — How migrations are generated, ordered, and applied.

## Admin UI

- [Admin Panel Architecture](./04-admin-ui/00-admin-panel-architecture.md) — How the React admin is structured on TanStack Start.
- [Design System & Tokens](./04-admin-ui/01-design-system-and-tokens.md) — The token architecture and visual language of the admin.
- [Component Library](./04-admin-ui/02-component-library.md) — The reusable component set that builds the admin.
- [Navigation & App Shell](./04-admin-ui/03-navigation-and-app-shell.md) — The shell: sidebar, breadcrumbs, and global navigation.
- [Dashboard & Home](./04-admin-ui/04-dashboard-and-home.md) — The landing dashboard and customizable widgets.
- [Collection List Views](./04-admin-ui/05-collection-list-views.md) — Data tables for browsing content, built on TanStack Table.
- [Document Edit View](./04-admin-ui/06-document-edit-view.md) — The document editor, field rendering, version controls, and autosave.
- [Field Components & Rendering](./04-admin-ui/07-field-components-and-rendering.md) — How field configs become interactive React components.
- [Rich Text Editor](./04-admin-ui/08-rich-text-editor.md) — The block-based rich-text editor and its extension model.
- [Media Library UI](./04-admin-ui/09-media-library-ui.md) — Browsing, uploading, and selecting media in the admin.
- [Live Preview & Visual Editing](./04-admin-ui/10-live-preview-and-visual-editing.md) — Real-time preview and click-to-edit overlays on the live site.
- [Command Palette & Keyboard UX](./04-admin-ui/11-command-palette-and-keyboard.md) — Power-user navigation and keyboard-driven workflows.
- [Theming & White-Label](./04-admin-ui/12-theming-and-white-label.md) — Rebranding the admin for agencies and enterprises.
- [Admin Accessibility Standards](./04-admin-ui/13-accessibility-standards.md) — WCAG conformance and inclusive design for the admin.
- [Admin i18n & RTL](./04-admin-ui/14-admin-i18n-and-rtl.md) — Translating the admin UI and supporting right-to-left languages.

## API

- [API Overview & Philosophy](./05-api/00-api-overview-and-philosophy.md) — The three coordinated API surfaces and when to use each.
- [REST API](./05-api/01-rest-api.md) — The auto-generated REST API for every collection and global.
- [GraphQL API](./05-api/02-graphql-api.md) — The generated GraphQL schema and resolver model.
- [Typed RPC & Local API](./05-api/03-typed-rpc-and-local-api.md) — The end-to-end typed Local API and server-side data access.
- [Querying: Filtering, Sorting & Pagination](./05-api/04-query-filtering-sorting-pagination.md) — The shared query language across all API surfaces.
- [Realtime & Subscriptions](./05-api/05-realtime-and-subscriptions.md) — Live data via subscriptions and change streams.
- [Webhooks](./05-api/06-webhooks.md) — Outbound webhooks for content events.
- [API Versioning & Deprecation](./05-api/07-api-versioning-and-deprecation.md) — How API surfaces evolve without breaking consumers.

## Auth & Security

- [Authentication](./06-auth-security/00-authentication.md) — User authentication for the admin and for API consumers.
- [Authorization & Access Control](./06-auth-security/01-authorization-and-access-control.md) — The access-control model gating every operation and field.
- [Roles, Permissions, RBAC & ABAC](./06-auth-security/02-roles-permissions-rbac-abac.md) — Role-based and attribute-based permission modeling.
- [Sessions, JWT & API Keys](./06-auth-security/03-sessions-jwt-and-api-keys.md) — Credential types and their lifecycles.
- [SSO, OAuth & Social Login](./06-auth-security/04-sso-oauth-and-social-login.md) — Federated identity and enterprise single sign-on.
- [MFA & Account Security](./06-auth-security/05-mfa-and-account-security.md) — Multi-factor authentication and account protection.
- [Security Model & Hardening](./06-auth-security/06-security-model-and-hardening.md) — The platform security posture and its defenses.
- [Data Privacy & Compliance](./06-auth-security/07-data-privacy-and-compliance.md) — Privacy features and regulatory alignment.

## Media & Files

- [Media & Uploads Overview](./07-media-files/00-media-and-uploads-overview.md) — How uploads, media metadata, and delivery work end to end.
- [Storage Adapters](./07-media-files/01-storage-adapters.md) — Pluggable storage backends for files.
- [Image Processing & Transforms](./07-media-files/02-image-processing-and-transforms.md) — On-demand and ahead-of-time image transformations.
- [Focal Points, Crops & Responsive Images](./07-media-files/03-focal-points-crops-and-responsive.md) — Art direction and responsive delivery.
- [CDN & Delivery](./07-media-files/04-cdn-and-delivery.md) — Caching and globally distributing media.
- [File Security & Validation](./07-media-files/05-file-security-and-validation.md) — Keeping uploads safe.

## Extensibility

- [Plugin System Architecture](./08-extensibility/00-plugin-system-architecture.md) — How plugins extend config, schema, admin, and runtime.
- [Plugin SDK & Authoring](./08-extensibility/01-plugin-sdk-and-authoring.md) — Building, testing, and publishing a plugin.
- [Hooks & Lifecycle](./08-extensibility/02-hooks-and-lifecycle.md) — The complete hook surface for documents and operations.
- [Custom Fields](./08-extensibility/03-custom-fields.md) — Authoring new field types with both data and UI.
- [Custom Admin Components & Slots](./08-extensibility/04-custom-admin-components-and-slots.md) — Injecting custom UI into the admin.
- [Custom Endpoints & Routes](./08-extensibility/05-custom-endpoints-and-routes.md) — Adding bespoke server endpoints alongside the generated API.
- [Events & Messaging](./08-extensibility/06-events-and-messaging.md) — The internal event bus and external pub/sub integration.
- [Jobs, Queues & Scheduling](./08-extensibility/07-jobs-queues-and-scheduling.md) — Background work, queues, and cron.
- [Plugin Marketplace & Registry](./08-extensibility/08-plugin-marketplace-and-registry.md) — Discovering and distributing community plugins.

## Developer Experience

- [Developer Experience Overview](./09-developer-experience/00-dx-overview-and-principles.md) — The DX north star and what great feels like.
- [CLI & Scaffolding](./09-developer-experience/01-cli-and-scaffolding.md) — create-kernel and the project CLI.
- [TypeScript Codegen & Types](./09-developer-experience/02-typescript-codegen-and-types.md) — Generated types from content config.
- [Client SDK & Data Fetching](./09-developer-experience/03-client-sdk-and-data-fetching.md) — The typed client and TanStack Query integration for frontends.
- [Local Development & HMR](./09-developer-experience/04-local-development-and-hmr.md) — The local dev loop and hot reload.
- [Seeding & Fixtures](./09-developer-experience/05-seeding-and-fixtures.md) — Deterministic data for development and tests.
- [Templates, Starters & Examples](./09-developer-experience/06-templates-starters-and-examples.md) — Official starters and example applications.
- [Testing Utilities & Harness](./09-developer-experience/07-testing-utilities-and-harness.md) — First-party tools for testing KernelCMS apps.

## Cloud & Operations

- [Deployment Models: Self-Host vs Cloud](./10-cloud-operations/00-deployment-models-self-host-vs-cloud.md) — The two ways to run KernelCMS and how they relate.
- [Managed Cloud Platform Architecture](./10-cloud-operations/01-managed-cloud-platform-architecture.md) — The hosted platform that runs KernelCMS for teams.
- [Self-Hosting: Docker & Kubernetes](./10-cloud-operations/02-self-hosting-guide-docker-and-k8s.md) — Running KernelCMS on your own infrastructure.
- [Multi-Tenancy & Isolation](./10-cloud-operations/03-multi-tenancy-and-isolation.md) — Serving many tenants safely in one deployment.
- [Billing, Metering & Plans](./10-cloud-operations/04-billing-metering-and-plans.md) — Monetizing the managed cloud.
- [Observability: Logging, Metrics & Tracing](./10-cloud-operations/05-observability-logging-metrics-tracing.md) — Seeing inside a running KernelCMS.
- [Backups & Disaster Recovery](./10-cloud-operations/06-backups-and-disaster-recovery.md) — Protecting and restoring content.
- [Scaling & Performance Operations](./10-cloud-operations/07-scaling-and-performance-operations.md) — Operating KernelCMS under load.
- [Edge & Content Delivery Network](./10-cloud-operations/08-edge-and-content-delivery-network.md) — Delivering content globally with low latency.

## Quality

- [Testing Strategy](./11-quality/00-testing-strategy.md) — The test pyramid across the monorepo.
- [CI/CD & Release Engineering](./11-quality/01-ci-cd-and-release-engineering.md) — Pipelines, releases, and changesets.
- [Performance Benchmarks & Budgets](./11-quality/02-performance-benchmarks-and-budgets.md) — How we measure and defend performance.
- [Threat Model (STRIDE)](./11-quality/03-threat-model-stride.md) — A STRIDE threat model of the platform.
- [Accessibility & Compliance Testing](./11-quality/04-accessibility-and-compliance-testing.md) — Automated and manual accessibility and compliance gates.
- [Documentation & DX Quality](./11-quality/05-documentation-and-dx-quality.md) — How docs stay accurate and helpful.

## Ecosystem & Migration

- [Frontend Framework Integrations](./12-ecosystem-migration/00-frontend-framework-integrations.md) — Consuming KernelCMS from any frontend.
- [Migrating from Payload](./12-ecosystem-migration/01-migrating-from-payload.md) — A playbook for moving Payload projects to KernelCMS.
- [Migrating from Sanity](./12-ecosystem-migration/02-migrating-from-sanity.md) — Moving from Sanity: schemas, GROQ, and the content lake.
- [Migrating from Strapi](./12-ecosystem-migration/03-migrating-from-strapi.md) — Moving Strapi projects over.
- [Integrations & Third-Party Services](./12-ecosystem-migration/04-integrations-and-third-party.md) — Connecting KernelCMS to the wider ecosystem.
- [Community & Ecosystem Strategy](./12-ecosystem-migration/05-community-and-ecosystem-strategy.md) — Growing adoption and contributors.

## Roadmap

- [MVP Scope & Definition](./13-roadmap/00-mvp-scope-and-definition.md) — What the first shippable version includes.
- [Milestones & Phases](./13-roadmap/01-milestones-and-phases.md) — The phased build plan from MVP to GA.
- [Release Plan & Versioning](./13-roadmap/02-release-plan-and-versioning.md) — How versions ship and what stability means.
- [Feature Parity Roadmap](./13-roadmap/03-feature-parity-roadmap.md) — A sequenced plan to reach and exceed competitor parity.
- [Risks & Mitigations](./13-roadmap/04-risks-and-mitigations.md) — The major risks to the project and how we counter them.
- [Success Metrics & KPIs](./13-roadmap/05-success-metrics-and-kpis.md) — How we measure whether KernelCMS is winning.

---

_Generated as a planning corpus. Every document follows the canonical project brief; see [Design Principles & Tenets](./00-foundation/08-design-principles-and-tenets.md)._
