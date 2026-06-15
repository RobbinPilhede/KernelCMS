# kernelcms

## 0.44.1

### Patch Changes

- aa12acb: Fix the `kernelcms/visual-editing/react` entry so Next.js apps resolve React from the consuming app and keep the preview hook behind a client boundary.

## 0.44.0

### Minor Changes

- 09aea16: Atomicity, a published stability policy, and a leaner install.
  - **Atomic multi-write.** A document's row write, version snapshot, and content credential now commit in a single transaction — a crash mid-publish can no longer leave a published document without its snapshot or credential. `publishRelease` is now genuinely all-or-nothing (a mid-publish failure rolls the whole release back), and `mergeBranch` / `syncContent` gain an opt-in `atomic` mode. Cascade deletes settle their referrers in one transaction. Adapters without transaction support fall back to the previous best-effort behaviour.
  - **Lighter install (action may be required).** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `pg`, and `graphql` are now **optional peer dependencies** instead of hard dependencies, so a SQLite + local-file + REST install no longer pulls ~10 MB of unused packages. Install the one you use: `pg` for the Postgres adapter, the two `@aws-sdk/*` packages for the S3/R2 storage adapter, `graphql` for the GraphQL endpoint. The S3 adapter and GraphQL endpoint load their dependency lazily and surface a clear "install this package" error if it is missing.
  - **Stability & versioning policy.** New `STABILITY.md` defines the public API surface, the experimental tiers, the deprecation policy, and the road to 1.0.

## 0.43.0

### Minor Changes

- f4ee85d: Content decisions: named delivery slots that pick the single best PUBLISHED document for the
  caller's audience + a sticky per-viewer choice, served at `GET /api/_decide/:slug` (or
  `kernel.decide(...)`). Stateless — it composes the existing access-checked published read,
  audience resolution, and deterministic bucketing into one request-time delivery surface.
  Published-only and access-checked (never surfaces a draft, private doc, or read-restricted
  field); the choice is sticky per `?viewer=` (only the hash of the key is used — no PII), an
  unknown `?audience=` collapses to the default segment, and the impression is auto-captured as a
  `variant_impression`. Configure with `decisions: [{ slug, collection, where?, sort?,
audienceField?, fallback? }]`.

## 0.42.0

### Minor Changes

- 66f6268: Content QA / linting: `kernel.lintDocument(...)` runs the configured pre-publish evals against a
  document on demand (read-only) and reports every finding plus the blocking subset — the same
  rules that gate `publish()`, surfaced so an editor sees blockers and quality warnings before
  publishing. Exposed over REST as `GET /api/:collection/:id/lint`. Linting is an editorial tool
  gated on **update access** (it inspects the live draft and its findings echo content), so a
  public reader can never harvest unpublished drafts through it. Adds three pure built-in eval
  factories: `requiredFieldsEval` (blocking), `readabilityEval` and `linkEval` (non-blocking
  nudges).

## 0.41.0

### Minor Changes

- a0e1e05: Content federation / sync. Opt in with `federation: true` to promote content between environments or keep instances in sync. `kernel.exportContent({ collection, where?, ids?, draft? })` produces a portable, deterministic bundle (`{ version: 1, documents: [{ collection, id, data }] }`) — access-checked, so you only export documents you can read; the stable id and publish state round-trip. `kernel.syncContent({ bundle, dryRun? })` applies a bundle by id (create-or-update, identity preserved) and returns `{ created, updated, unchanged, failed, plan, dryRun }`; `dryRun: true` returns the plan without writing, and re-syncing the same bundle is idempotent. Every applied document goes through the normal access-checked create/update — access, validation, and the publish gate all apply — so a sync can never elevate; anything that fails lands in `failed[]` while the rest apply. REST (admin-only): `GET /api/_admin/federation/export`, `POST /api/_admin/federation/sync`. `kernel.create` now accepts an optional `id` (validated; a duplicate is a conflict; insert-only — it can't overwrite another document, and the normal content POST route does not accept a client id).

## 0.40.0

### Minor Changes

- 84cbb7c: Content branches (git-for-content). Opt in with `branches: true` and get a named workspace where edits are STAGED as a copy-on-write overlay (the live document is never touched), previewed and diffed, then merged or discarded. `kernel.createBranch`, `listBranches`, `stageChange({ branch, collection, id, data })`, `previewBranch` (the live access-checked doc with the staged overlay applied), `diffBranch`, `mergeBranch` → `{ merged, failed }`, `discardBranch`. REST (reviewer-gated): `GET/POST /api/_admin/branches`, `GET /api/_admin/branches/:name/diff`, `GET .../preview?collection=&id=`, `POST .../stage`, `POST .../merge`, `POST .../discard`.

  Staging requires update access to the target document; merging replays each staged change through the normal access-checked `update`, so the publish gate (incl. the agent draft-only brake), field-level access, and validation all apply — a branch can never bypass them. System columns (`_status`, `id`, …) and auth fields can't be staged; create/merge/discard are reviewer-gated (admin/editor) and audited; `_branches`/`_branch_docs` are unreachable via generic CRUD. This is field-level staged overlays + replayed merge (last-write-wins over the current live doc), not a three-way git merge; a partial merge reports per-change failures in `failed[]`.

## 0.39.0

### Minor Changes

- 97c5705: Content snippets / reusable blocks. Mark a collection `snippet: true` to make it a library of reusable content fragments — a CTA, a promo banner, legal text — and reference a fragment from another collection with a `snippet`-typed field (`{ type: 'snippet', snippet: 'snippets', hasMany? }`). On read the field transcludes the fragment's **live** content (pass `depth: 1` / `?depth=1`), so editing the fragment once is reflected by every referencing document. Transclusion is access-checked — a fragment the reader can't read falls back to its raw id, never the content (and field-access on the fragment still applies); it is depth-bounded (cyclic snippet graphs can't infinite-loop), N+1-safe (batched populate), and a `snippet` field may only reference a `snippet: true` collection (validated at config load, at any nesting depth). With `depth: 0` the field stays the id.

## 0.38.0

### Minor Changes

- 8d1baf8: Saved-search alerts / content subscriptions. Opt in with `subscriptions: true` (requires `realtime: { enabled: true }` and a configured `webhooks` target) and an editor can subscribe to a standing query — a collection plus an optional `where` — and be notified via a webhook when matching content changes. `kernel.createSubscription({ collection, where?, webhook })`, `listSubscriptions`, `deleteSubscription`, and the cron drain `kernel.processSubscriptions()` (wired into `kernel jobs:run`, or standalone `kernel subscriptions:run`). REST (owner-scoped, auth-required): `GET/POST /api/_admin/subscriptions`, `DELETE /api/_admin/subscriptions/:id`.

  The drain reads the change feed since each subscription's cursor and **re-evaluates every change as the OWNER** — an access-checked document reload plus the `where` match — so an alert never fires for content the owner can't currently read, and the delivered payload is field-access-stripped and encrypted-field-redacted exactly like a normal read. A subscription is owned by its creator (recorded from the principal, never client input); only the owner or an admin can manage it; the delivery target must be a configured webhook slug (so a subscriber can never aim an alert at an arbitrary URL — the webhook URLs are SSRF-guarded at config load). The cursor starts at "now" (no history backfill), deletes don't alert, the per-drain scan is bounded, and `_subscriptions` is unreachable via generic CRUD. Create/delete are audited. Tip: give a subscription-only webhook `collections: []` so it never also fires on content writes (no double-send).

## 0.37.0

### Minor Changes

- 2dd54b6: Document activity timeline. `kernel.documentActivity({ collection, id, types?, limit? })` (and REST `GET /api/:collection/:id/activity`) returns one merged, newest-first feed of everything that happened to a document — version snapshots, editorial comments, review decisions, and audit-log entries — instead of querying four sources separately. Each event is `{ type, at, actor, action, data }`. The whole feed is gated on the document's read access (a caller who can't read it gets Forbidden/NotFound), and each source keeps its own rules: version + comment events are shown to any reader, while the reviewer-only sources (review, audit) are included only for an admin/editor principal — a non-reviewer gets `includesReviewerEvents: false` and no audit/review detail (the `types` filter can't bypass that gate). Field-access stripping is inherited (a read-denied field never appears in `changedFields`), each source is skipped cleanly when its feature is off, and `limit` is clamped (default 100, max 500). Read-only — it performs no writes.

## 0.36.0

### Minor Changes

- 5807660: Field-level encryption at rest. Mark any storage field `encrypted: true` and KernelCMS transparently encrypts it with AES-256-GCM — encrypted on write, decrypted on read — so plaintext only ever lives in the application layer and the storage column holds an authenticated `enc:1:<iv>:<tag>:<ciphertext>` envelope (a fresh 96-bit IV per value; the same plaintext encrypts differently each time). Requires `config.encryption: { key }` (any sufficiently-random secret ≥16 chars; a 256-bit key is SHA-256-derived from it; read from env). Works for any storage field type (the plaintext is JSON-serialized before encryption).

  Because ciphertext is opaque and non-deterministic, an encrypted field can't be `unique`, `index`ed, filtered/sorted on, full-text searched, `localized`, `personalized`, a relationship, or nested in a group/array/blocks — each is rejected at config load. Encryption is also kept out of every anonymous/at-rest leak surface: version snapshots store ciphertext (decrypted on version read), webhook payloads redact encrypted fields, and JSON-LD / structured data / discoverability (llms.txt) never publish an encrypted field's value. Field read-access still applies on top (a denied reader gets null, never ciphertext). Tampering or a wrong key is a hard, detectable `DecryptionError`, never silent garbage; the key is server-only and never logged or returned. Also: deleting an upload document already swept its binary (0.35.0); this release additionally hardens the field pipeline so no decrypted value escapes to a version, webhook, or SEO surface. **Key-loss warning:** rotating or losing the key makes existing ciphertext unreadable — treat it like a database credential. Helpers `createFieldCipher` / `DecryptionError` are exported for advanced use.

## 0.35.0

### Minor Changes

- d5627a5: Signed, expiring asset URLs — capability links for private uploads. `kernel.signedAssetUrl({ collection, id, ttl? })` (and REST `GET /api/:collection/:id/signed-url?ttl=`) mints a URL `"<servePath>/<key>?exp=<unix>&sig=<hmac>"` that fetches one private file **without a session** until it expires — for emailing a download, embedding a time-limited image, or handing a file to a service that can't authenticate. Minting is access-checked (you can only link a file you can read); the HMAC is keyed by the server-only `config.secret`, covers both the storage key and the expiry (neither can be swapped or extended), is compared constant-time, and the secret never appears in the URL. The server file route serves a `?exp=&sig=` request when the signature is valid and unexpired (else `403`), with no silent fallback; a request without a signature keeps the normal per-session access check. When the storage adapter mints its own signed URLs (e.g. S3 presign), that is delegated to instead. Helpers `signAssetUrl` / `verifyAssetUrl` are exported for custom verification. Also: deleting an upload document now sweeps its binary (and image derivatives) from storage, so bytes never outlive the row and a signed link can't serve a deleted file.

## 0.34.0

### Minor Changes

- 377ae08: Durable webhook delivery + SSRF hardening. The existing outbound-webhook feature gains an at-least-once durable mode: set `durable: true` on a webhook and content writes enqueue to a `_webhook_deliveries` outbox delivered by the cron drain `kernel.processWebhooks()` (wired into `kernel jobs:run`, or standalone `kernel webhooks:run`) with exponential backoff up to `maxAttempts` — so a slow or down receiver no longer drops events or slows the write. Inline best-effort delivery remains the default and is unchanged.

  Adds an **SSRF egress guard**: a webhook `url` must be `http(s)` and is rejected at config load if its host is loopback/private/link-local/CGNAT/cloud-metadata (including IPv4-mapped and NAT64 IPv6 forms like `[::ffff:169.254.169.254]`), unless the endpoint sets `allowPrivateNetwork: true`. Deliveries now use `redirect: 'manual'` so a receiver can't 3xx-redirect a POST into a private host after the guard. Adds an admin-only REST surface (`GET /api/_admin/webhooks` redacted config, `GET /api/_admin/webhooks/deliveries` log, `POST /api/_admin/webhooks/deliveries/:id/retry`) and the Local-API ops `kernel.processWebhooks`, `listWebhooks`, `webhookDeliveries`, `retryWebhookDelivery`. The signing secret and custom headers are never returned or logged; deliveries are audited (`webhook.deliver`/`webhook.fail`); the `_webhook_deliveries` outbox is unreachable via generic CRUD. Webhook config gains `slug`, `durable`, `maxAttempts`, and `allowPrivateNetwork`.

## 0.33.0

### Minor Changes

- 938f413: Saved views / smart collections — named, reusable query presets. Opt in with `views: true` and editors can save a `where` + `sort` + display `columns` for a collection ("Published this month", "My drafts", "Out of stock") and re-apply it in one click. Adds `kernel.saveView`, `listViews`, `getView`, `updateView`, `deleteView`, `applyView`, the `_views` system table (unreachable via generic CRUD), and REST routes (`/api/_admin/views`, `/api/_admin/views/:id`, `/api/_admin/views/:id/apply`). A view is owned by its creator (owner recorded from the authenticated principal, never client input) and private unless `shared`; a shared view is visible only to those who can read its collection. Applying a view runs the normal access-checked `find` and the stored `where`/`sort` are re-validated on save and apply — so a saved view can only ever narrow results within the caller's access, never widen or bypass it. Owner-or-admin only for update/delete; create/update/delete are audited. Also hardens the shared `where` validator with a recursion-depth cap.

## 0.32.0

### Minor Changes

- 1ac6fb5: Editorial comments — threaded review annotations on documents. Opt in with `comments: true` and editors can leave field-anchored or document-level comments, thread replies, and resolve them. Gated by the target document's read access (rule + row-scope) on every operation — including the anonymous Local-API path — so the comment surface never leaks a document you can't read. The author is recorded from the authenticated principal (never the client body); resolve is limited to the author or a reviewer (`admin`/`editor`), delete to the author or an `admin`. Adds `kernel.addComment`, `listComments`, `commentCount`, `resolveComment`, `deleteComment`, the `_comments` system table (unreachable via generic CRUD), and REST routes (`/:collection/:id/comments`, `/_admin/comments/:commentId`). Create/resolve/delete are audited.

## 0.31.0

### Minor Changes

- **Content templates: a "New from template" that pre-fills a document in one click.** Define reusable document skeletons — a landing-page layout, a standard article shell, a press-release format — and editors start from them instead of a blank screen, with all your access rules and validation intact.
  - **Define skeletons in config.** `templates: [{ slug: 'landing', collection: 'pages', name: 'Landing page', data: { title: 'Untitled', layout: [{ blockType: 'hero', heading: 'Headline' }] } }]`. The `data` is the document's default field values — including a full blocks `layout` — and it's deep-frozen, so one instantiation can never alter the next.
  - **Instantiate in one call.** `kernel.createFromTemplate({ template: 'landing', data })` deep-merges the template defaults with any overrides you pass (your `data` wins on conflicts) and creates the document. `kernel.listTemplates({ collection })` lists the available templates (metadata only — never the raw defaults). Over REST: `GET /api/_admin/templates` and `POST /api/:collection/from-template`.
  - **It's a normal, governed create.** Creating from a template goes through the exact create pipeline as any write — a caller who can't create can't use it, out-of-scope fields are stripped for a scoped agent, and the agent draft-only brake holds (a template that sets `_status: 'published'` never publishes for an agent). The caller's override `data` is prototype-pollution-guarded, and a template can only ever create into its configured collection (the route's `:collection` is authoritative). Red-teamed exhaustively — **Risk: LOW** — verified by a live harness and a Playwright end-to-end test.

  Opt-in via `templates`; fully backward-compatible.

## 0.30.0

### Minor Changes

- **Content lifecycle: set an expiry, and content retires itself.** The inverse of scheduled publish — when content's time is up, KernelCMS automatically unpublishes, archives, or deletes it. For embargoes, time-limited campaigns, retention/compliance, and auto-clearing stale content.
  - **Declare an expiry policy.** `lifecycle: { collections: [{ slug: 'promos', expireField: 'expire_at', onExpire: 'unpublish' }] }`. Editors set the `expire_at` date on a document; when it passes, the next drain retires it: `unpublish` → back to draft; `archive` → draft plus a server-managed `_archived_at` timestamp (hidden from public reads, distinguishable from a plain draft); `delete` → removed.
  - **Cron-driven.** `kernel.processContentLifecycle()` is a trusted maintenance operation — run it from a cron via `kernel jobs:run` (which now also drains scheduled publishes and releases) or the dedicated `kernel lifecycle:run`. Every retirement is audited (`content.expire`), bounded, and resilient per-document.
  - **Safe by construction.** The drain is operator/cron-only — there's no HTTP trigger, so it can run with full authority without an exposed attack surface. The `_archived_at` marker is server-managed and **client-immutable**: a normal user can never fake-archive or un-archive content through the API. The `expireField` is an ordinary editor field (you can only set an expiry on content you can write), and the drain only ever touches the collections you configure. Red-teamed — **Risk: LOW** — verified by a live harness and a Playwright end-to-end test (proving `_archived_at` immutability over HTTP).

  Opt-in via `lifecycle`; you own the date-field schema; fully backward-compatible.

## 0.29.0

### Minor Changes

- **Content intelligence: related-content recommendations and near-duplicate detection, straight from your embeddings.** The vectors you already index for semantic search power two more things content teams want.
  - **More like this.** `kernel.relatedContent({ collection, id })` returns the documents most semantically similar to a given one (the seed is re-embedded from its current content, excluding itself) — perfect for "related articles", internal linking, and recommendation rails. Over REST: `GET /api/:collection/:id/related?limit=`.
  - **Find redundant content.** `kernel.findDuplicates({ collection, threshold })` returns pairs of documents whose embeddings are near-identical (default cosine ≥ 0.9, with scores) — surface accidental re-publishes, overlapping pages to consolidate, and stale duplicates for a content-quality cleanup. Over REST (admin/editor): `GET /api/_admin/duplicates?collection=&threshold=`.
  - **Access-checked and bounded.** Every result goes through the normal access-control read path: a related document you can't read is dropped, and a duplicate pair is returned only when you can read **both** documents — so dedup can never reveal the id or even the existence of hidden content. The scan is bounded (it caps the documents compared and pairs returned — it's an admin operation, not a hot path), `threshold` is clamped to `[0,1]`, filters are validated, and the embedding provider's key/text never leaks. Red-teamed exhaustively (including the duplicate-pair leak angle) — **Risk: LOW, zero leaks** — verified by a live harness and a Playwright end-to-end test.

  Builds on the semantic-search layer (configure `embeddings`); read-only and fully backward-compatible.

## 0.28.0

### Minor Changes

- **AI-assisted translation: auto-fill every locale, with the provider of your choice.** Your localized content already stores a value per locale — now KernelCMS can translate the gaps for you, while keeping access control, strict-mode validation, and your human-review workflow fully intact.
  - **Bring any translator.** Set `translation: { translate }` with a function that maps source strings → translations (DeepL, OpenAI, Google, a local model — your choice; no hard dependency). `kernel.translateDocument({ collection, id, from: 'en', to: 'es' })` reads the document's English values for its localized fields, translates them, and writes them into Spanish — merging, never clobbering other locales, and filling only the missing values by default (`overwrite: true` replaces). `kernel.translateMissing({ collection, to: 'fr' })` bulk-fills every document missing a locale. Over REST: `POST /api/:collection/:id/translate` and `POST /api/_admin/translate-missing`.
  - **It's a normal, governed write.** Translation goes through the standard access-checked update — the caller must be able to update the document, strict-mode per-locale required validation still applies, and the agent draft-only brake still holds, so a translation **never** auto-publishes. It pairs with the localization strict mode and the translation-status dashboard: see what's missing, fill it, review it.
  - **Safe with external providers.** The provider may hold an API key — its text and errors never leak (a failure surfaces a generic message; source and translated text are never logged), a provider failure can never leave a document half-translated (no partial write), `from`/`to` must be configured locales (prototype-pollution-guarded), a read-denied localized field is never sent to the provider, and per-field input is bounded. Red-teamed exhaustively — **Risk: LOW** — verified by a live harness and a Playwright end-to-end test driving the translate endpoint over HTTP.

  Opt-in via `translation` (needs `localization`); fully backward-compatible.

## 0.27.0

### Minor Changes

- **Multi-tenancy: run many clients on one instance with airtight isolation — zero boilerplate.** For SaaS built on KernelCMS, or an agency managing dozens of sites, every tenant must see only their own content. KernelCMS now does that automatically, enforced through the same access pipeline that protects everything else.
  - **One line of config.** `tenancy: { field: 'tenant' }` auto-adds a server-managed tenant field to your scoped collections and auto-injects a tenant scope into their read/create/update/delete access — AND-combined with your own rules (it never widens them). Every find/findByID/update/delete/count is then transparently filtered to the caller's tenant. On create the tenant is stamped automatically; on update it's immutable. No per-collection access code.
  - **The tenant comes from the principal, never the client.** It's resolved from `req.user.tenant` (put a tenant on your user records, or supply a `resolve` from verified state) — never a query param, body field, or header. So a tenant-A user can never read, list, count, update, or delete tenant-B content, and a client can never create or move a document into another tenant (the value is stamped on create and stripped on update). A tenant-less principal sees nothing in scoped collections (fail-closed); cross-tenant content never leaks through relationship populate.
  - **Safe escape hatch.** `overrideAccess` / system calls (migrations, admin tooling) see across all tenants — the single, documented bypass.

  Red-teamed with 35 cross-tenant attacks (IDOR, `where`-widening, spoofing, populate leaks, bulk ops) — **Risk: LOW, zero leaks** — verified by a live harness and a Playwright end-to-end test where two authenticated tenants each see only their own data over HTTP. Opt-in via `tenancy`; fully backward-compatible.

## 0.26.0

### Minor Changes

- **Edge delivery: cache hard at the CDN, purge exactly what changed.** Cache your content at the edge for instant global delivery, and invalidate precisely the affected pages the moment anything changes — provider-agnostically.
  - **Surrogate cache tags on every public read.** Turn on `edge: { enabled: true, cacheControl: 'public, s-maxage=31536000, stale-while-revalidate=60' }` and `GET /api/:collection/:id` (and list reads) carry your `Cache-Control` plus a `Surrogate-Key` header tagging the response (`<collection>`, `<collection>:<id>`, and — by default — the documents it references, so changing an author purges their posts). Your CDN caches by those keys.
  - **Change-driven purge feed.** `kernel.purgeFeed({ since })` maps recent content changes (from the real-time change feed) to the exact cache tags to invalidate — including documents that _reference_ a changed one — and returns a cursor to poll from. A small CDN worker polls `GET /api/_edge/purge` (admin-gated) and purges those surrogate keys, or subscribe in-process with `kernel.onPurge(fn)`. Works with Cloudflare cache-tags, Fastly surrogate keys, etc.
  - **Private content is NEVER cached at the edge.** This is the make-or-break, and it's enforced by construction: only an anonymous, published, non-time-travel read gets a public `Cache-Control` + surrogate key. Every authenticated, access-scoped, draft, `asOf`, or override response gets `Cache-Control: private, no-store` and no cache tag — so a CDN can never serve one user's private content to another. Cache tags only ever contain ids from the access-checked returned documents, header values are sanitized against injection, and the purge feed is admin-gated and bounded. Red-teamed exhaustively across every auth/draft/scope/override combination — **Risk: LOW, zero leaks** — verified by a live harness and a Playwright end-to-end test.

  Opt-in via `edge` (the purge feed also needs `realtime`); the CDN wiring is yours; fully backward-compatible.

## 0.25.0

### Minor Changes

- **Content analytics & insights — see how your content performs, and how AI uses it. No third-party tracker, no PII.** Built into the same model, privacy-first.
  - **Capture events.** `kernel.track({ type, collection, documentId, query?, value?, meta? })` records a content event (`view`, `search`, `ai_retrieval`, `citation`, `variant_impression`, `conversion`, `custom`). It never throws into your code, and over REST it's `POST /api/_analytics/track`.
  - **See how AI uses your content (opt-in auto-capture).** Turn on `analytics: { enabled: true, autoCapture: true }` and every semantic / hybrid / graph search emits an `ai_retrieval` event for the documents it returned, and every A/B assignment emits a `variant_impression` — automatically, with zero added latency. The `ai_retrieval_leaderboard` insight then shows exactly which content your RAG and AI features surface most.
  - **Aggregate insights.** `kernel.insights({ metric })` gives `top_content`, `top_queries`, `variant_performance` (impressions, conversions, rate), `activity` (over time), and `ai_retrieval_leaderboard`. Admin/editor-gated over `GET /api/_admin/insights`.
  - **Privacy-first by construction.** There is no user, IP, visitor-key, email, or token column — the event row physically can't hold PII; `track` strips PII-ish and prototype-pollution keys from `meta` and never records the authenticated principal. `track` can only ever write the analytics table (never another collection). Insights are aggregates only, filtered to collections the caller can read (a hidden collection's counts never leak), with bounded retention and scan. Red-teamed exhaustively — **Risk: LOW, zero findings** — verified by a live harness and a Playwright end-to-end test.

  Opt-in via `analytics`; auto-capture off by default; fully backward-compatible.

## 0.24.0

### Minor Changes

- **Content releases: ship a coordinated set of changes as one atomic unit.** A launch or a campaign is rarely one document — it's a bundle of edits that should go live together, or not at all. KernelCMS now stages drafts into a named release and publishes them atomically, optionally on a schedule.
  - **Stage, preview, publish together.** `kernel.createRelease({ name })`, then `addToRelease({ release, collection, id })` for each draft. `previewRelease(...)` shows the whole bundle in its draft state before you ship; `publishRelease(...)` publishes every member as a unit. Admin/editor-gated REST under `/api/_admin/releases` (create, items, preview, publish, schedule).
  - **All-or-nothing — no partial go-live.** Before publishing anything, the release dry-runs the publish gate for _every_ member: the per-document publish access check, the agent draft-only brake, and your blocking content-CI evals against current draft content. If any member would fail, **none** are published (you get the reasons; the release stays open). A campaign never ships half-broken.
  - **Schedule a launch.** `scheduleRelease({ release, at })` sets it to go live at a future time; a cron drain (`processScheduledReleases()`, alongside `processScheduledPublishes()`) publishes it when due, re-checking the eval gate. Like scheduled per-document publishes, publishability is gate-checked at schedule time.
  - **Same gates, no shortcuts.** Publishing a release goes through the exact per-document publish gate as a direct publish — a caller can only publish a release whose every member they could publish directly, an agent can never publish a release, and you can't pull a document you can't read into a release. Red-teamed exhaustively — **Risk: LOW** — verified by a live harness and a Playwright end-to-end test driving the real release routes over HTTP. This release also hardens the core publish gate to enforce a row-scoped `access.publish` rule against the target row (parity with `access.update`).

  Opt-in via `releases: true`; fully backward-compatible.

## 0.23.0

### Minor Changes

- **Knowledge graph + GraphRAG: retrieve connected context, not just matching documents.** Your typed relationships already form a graph. KernelCMS now traverses it — and combines it with semantic search for GraphRAG, the cutting-edge retrieval technique that grounds AI on a _connected subgraph_ of your content instead of a flat list of hits.
  - **Walk the graph.** `kernel.graph({ collection, id, depth })` does a bounded breadth-first walk from a document, following both outbound relationship/upload fields and inbound reverse-relationship (`join`) fields, and returns typed `{ nodes, edges }` (each edge labeled with its field and `kind: 'relationship' | 'reverse'`). Over REST: `GET /api/:collection/:id/graph?depth=`.
  - **GraphRAG retrieval.** `kernel.graphSearch({ query, collection })` uses semantic/hybrid search to find the best seed documents, expands each through the graph to gather their connected neighbors, and returns the seeds, the subgraph, and a ready-to-ground `context` array (label + text per node). It's the retrieval half — feed `context` to your model. Over REST: `GET /api/graph-search?q=&collection=`.
  - **Access-checked and bounded.** Every node loads through the normal access-control path: a document you can't read is dropped _and the edge to it is omitted_, so the graph never even reveals that a hidden document is connected; read-denied fields never appear in labels or context. Depth (max 10), node count (default 100, hard cap 500), per-node fan-out, and cycles are all bounded — a hub or a deep graph can't blow up the traversal. Red-teamed exhaustively — **Risk: LOW, zero leaks** — verified by a live harness and a Playwright end-to-end test.

  `graphSearch` builds on the semantic-search layer (configure `embeddings`); `graph` works on any collection with relationships. Read-only and fully backward-compatible.

## 0.22.0

### Minor Changes

- **Personalization + A/B experiments: content that adapts to who's asking.** Tomorrow's content isn't one-size-fits-all — it's micro-experiences assembled per audience. KernelCMS builds that in, no separate personalization platform: it works exactly like localization, but keyed by audience instead of locale.
  - **Audience-targeted fields.** Define `audiences: { segments: ['default', 'vip', 'beta'], default: 'default' }`, then mark any field `personalized: true`. It stores a variant per segment; a request resolves the field to its audience's value (via `req.audience` or `?audience=vip`) and falls back to the default segment. Writing a variant (`?audience=vip`) merges into the field without clobbering the other segments — just like per-locale writes.
  - **Built-in A/B testing.** `experiments: [{ slug: 'hero', variants: ['default', 'vip'], weights? }]` + `kernel.assignVariant({ experiment, key })` deterministically and stickily buckets a visitor (the same key always gets the same variant; distribution matches your weights). The assigned variant _is_ a segment — set it as the request audience and the visitor sees that variant's content. Public REST: `GET /api/_experiments/:slug/assign?key=`. Only a hash of the visitor key is ever recorded — no raw key, no PII at rest.
  - **Safe by construction.** A personalized field still goes through field-level read access (a read-denied variant is stripped for every audience); an untrusted `audience` is honored only if it's a configured segment; segment keys are guarded against prototype pollution; per-segment writes never lose other segments. Red-teamed exhaustively — **Risk: LOW** — verified by a live harness and a Playwright end-to-end test driving `?audience=` and the assign endpoint over HTTP.

  Opt-in via `audiences`/`experiments`; fully backward-compatible. (A field can be `localized` or `personalized`, not both.)

## 0.21.0

### Minor Changes

- **Automatic schema.org JSON-LD — content that search engines and AI parse with explicit semantics.** Structured data is how Google rich results, and increasingly AI answer engines, _understand_ your content. KernelCMS generates valid schema.org JSON-LD straight from your typed model — completing the discoverability trio with semantic search and llms.txt/GEO.
  - **Map a collection to a schema.org type.** `structuredData: { collections: [{ slug: 'articles', type: 'Article', urlPattern: '/blog/:slug' }] }`. With no explicit `mapping`, smart defaults do the work: your title → `name`/`headline`, rich-text body → `articleBody` (+ a `description`), publish/updated dates → `datePublished`/`dateModified`, an author relationship → `author`, an image field → `image`. Override any property with an explicit `mapping`.
  - **Generate or embed it.** `kernel.jsonLd({ collection, id })` returns the JSON-LD object (`{ '@context': 'https://schema.org', '@type': 'Article', '@id': <canonical url>, … }`); `kernel.jsonLdScript({ collection, id })` returns the ready-to-embed `<script type="application/ld+json">…</script>`. Over REST: `GET /api/:collection/:id/jsonld` (`application/ld+json`).
  - **Safe by construction.** Generation goes through the access-checked read path — a draft, private, or read-denied document or field is never emitted (public callers get only published, publicly-readable content). The `<script>` embedding HTML-escapes content so it can't break out of the tag (no JSON-LD XSS), and `@id`/`image` URLs are injection-safe (no `javascript:`/`data:`/traversal). Red-teamed exhaustively — **Risk: LOW** — verified by a live harness and a Playwright end-to-end test.

  Opt-in via `structuredData`; fully backward-compatible.

## 0.20.0

### Minor Changes

- **Real-time content: a durable change feed + live SSE stream.** Make your CMS reactive — frontends that update the instant content changes, AI agents that act on new content, and downstream systems that stay in sync (real-time indexing is increasingly a requirement for agent workflows).
  - **Pull (durable CDC).** `kernel.changes({ since, collection })` returns ordered change events after a cursor — `{ seq, at, collection, documentId, event, principalType }` — and a `cursor` to poll from. Over REST: `GET /api/changes?since=&collection=`. Perfect for a change-data-capture pipeline or a reliable catch-up after downtime.
  - **Push (SSE).** `GET /api/changes/stream` is a `text/event-stream` that emits change events as they happen, with heartbeats and `Last-Event-ID` resume — wire it straight to an `EventSource` for a live UI, no polling.
  - **In-process.** `kernel.subscribe(fn)` gives server code, workflows, and live re-indexers a direct subscription (returns an unsubscribe fn).
  - **Metadata-only and access-filtered by construction.** Events carry only metadata — never document bodies — and every event is filtered per subscriber: you are **never** told that a document you can't read changed (the event is dropped entirely, fail-closed; the client re-fetches the doc through the normal access-checked API). Both endpoints require auth; retention and concurrent-stream counts are bounded; a feed write can never break or roll back the content write that triggered it. Red-teamed with 38 attacks across pull, SSE, and the in-process bus — **Risk: LOW, zero leaks** — verified by a live harness and a Playwright end-to-end test driving the real feed over HTTP.

  Opt in with `realtime: { enabled: true }`; fully backward-compatible. (Current scope: the hook-based feed emits create/update/delete — a publish reads as `update`; the sequence counter is per-node.)

## 0.19.0

### Minor Changes

- **Content time-machine: view, diff, and restore your content as it existed at any point in time.** KernelCMS already snapshots every change — now that history is a navigable timeline (a top "git-for-content" ask).
  - **Point-in-time reads.** Pass `asOf: <ISO timestamp>` to `kernel.findByID` or `kernel.find` (and `GET /api/:collection/:id?asOf=` / `GET /api/:collection?asOf=`) to reconstruct a document — or an entire collection — exactly as it existed at that instant. `null` if it didn't exist yet; the live document when omitted.
  - **Change timeline + field-level diffs.** `kernel.history({ collection, id })` returns the ordered change log (who, when, status, and the `changedFields` versus the previous snapshot); `kernel.diffVersions({ collection, id, from, to })` gives a field-level before/after between any two points (each a version id or a timestamp). Over REST: `GET /api/:collection/:id/history` and `/diff?from=&to=`.
  - **One-call reversion.** `kernel.restoreAsOf({ collection, id, asOf })` (or `POST /api/:collection/:id/restore-as-of?asOf=`) restores a document to a past state by writing that content through the normal validated update path — content fields only, so a restore is never a sneaky publish, the agent draft-only brake still applies, and it records a new version.
  - **Not a read-access bypass.** Every historical read and diff goes through the same access check + field redaction as a live read: if you can't read the document now, you can't read its history, diffs, or past states (the check is against current access — no time-travelling around revoked permissions), read-denied fields never appear in an `asOf` read or a `changedFields`/diff, and historical drafts stay hidden unless `draft:true`. Red-teamed exhaustively — **Risk: LOW, zero historical leaks** — verified by a live harness and a Playwright end-to-end test.

  Works on any collection with `versions` enabled. Fully backward-compatible.

## 0.18.0

### Minor Changes

- **The agentic CMS: autonomous content workflows with hard guardrails.** The defining shift of 2026 is AI agents acting as members of the content team. KernelCMS makes that _safe_ — you define a pipeline, an agent runs it autonomously, and nothing it produces can go live unchecked.
  - **Declarative pipelines.** `workflows: [{ slug, agent, trigger: { on: 'create'|'update'|'manual', collection }, steps }]`. Each step is a function that operates through `ctx.kernel` — a Local-API surface **pinned to the workflow's scoped agent principal**. A step physically cannot publish (draft-only brake), cannot write fields outside the agent's `fieldScope`, and cannot pass `overrideAccess` or a forged principal. The autonomy is real; the blast radius is zero.
  - **Quality + human gates are the only way content advances.** `await ctx.evalGate({ collection, id })` runs your content-CI evals and fails the run on a blocking violation. `await ctx.requestReview({ collection, id })` submits the draft to the review inbox and pauses the run as `awaiting_review` — it goes live only when a human approves. An agent drafts; a human (or a passing eval) decides.
  - **Durable + observable.** `create`/`update` triggers enqueue the run on the jobs queue (drained by `kernel jobs:run`), so a slow agent step never blocks the content write and a failed run is retryable. Every run is recorded in `_workflow_runs` with per-step status (`pending → running → completed | failed | awaiting_review`), queryable via `kernel.workflowRuns(...)` and the admin-gated `GET /api/_admin/workflow-runs` / `POST /api/_admin/workflows/:slug/run`. Run logs carry error messages only — never stacks or secrets. Self-triggering loops are guarded.

  Built on the existing agent principals, review inbox, evals, and jobs system. Red-teamed with deliberately hostile steps — **Risk: LOW, zero guardrail breaches** (a step cannot publish, escape scope, or override) — verified by a live harness and a Playwright end-to-end test driving the real workflow routes. Opt-in via `workflows`; fully backward-compatible.

## 0.17.0

### Minor Changes

- **Be found and cited by AI answer engines: native llms.txt + GEO.** As people increasingly get answers from ChatGPT, Claude, Perplexity, and Google AI instead of clicking links, your content has to be ingestible and citable by machines. KernelCMS now generates that layer from your live content — no extra pipeline.
  - **`llms.txt` + `llms-full.txt`, generated.** `kernel.llmsTxt()` produces the standard index (title, description, per-collection link lists); `kernel.llmsFullTxt()` produces the full content corpus as clean markdown, each document a titled section with a provenance/citation footer. Over REST: `GET /api/llms.txt` and `GET /api/llms-full.txt` (proxy them to your site root).
  - **RAG-ready chunks + per-document GEO markdown.** `kernel.contentChunks()` returns retrieval-ready chunks (title, url, text, token estimate, provenance) to feed a RAG pipeline; `kernel.geoDocument({ collection, id })` (and `GET /api/:collection/:id/geo`) renders one document as GEO-optimized markdown with a citation block — author, last-updated, canonical URL, and a signature-verified note when content credentials are enabled (built on the provenance + signing layer).
  - **Published-only by construction.** Every generator reads through the access-control pipeline as an anonymous principal filtering to published content — drafts, scheduled-but-unpublished documents, access-restricted collections, and read-denied fields can never appear in any output. No `overrideAccess`, anywhere. Output is size-bounded. Red-teamed exhaustively across all four outputs on both the Local API and the public HTTP routes — **Risk: LOW, zero leaks** — and verified by a live harness plus a Playwright end-to-end test driving the real endpoints unauthenticated.

  Also exports `toMarkdown(richTextDoc)` from `kernelcms/richtext`. Opt-in via `discoverability` config; fully backward-compatible.

## 0.16.0

### Minor Changes

- **RAG-native: built-in semantic + hybrid search. Your CMS _is_ your RAG knowledge base.** Instead of stitching together a CMS + a serverless function + a separate vector database (Pinecone/etc.), KernelCMS indexes your content for AI retrieval natively — on the same typed, access-controlled engine.
  - **Bring any embedder.** Set `embeddings: { embed }` with a function that maps text → vectors (OpenAI, Cohere, a local model — your choice; KernelCMS has zero hard embedding dependency). Mark a collection `search: { fields, semantic: true }` and those fields are embedded on **every write** — real-time indexing, which is a governance requirement for AI agents, not a nightly batch.
  - **Semantic + hybrid out of the box.** `kernel.semanticSearch({ collection, query })` does vector top-K; `kernel.hybridSearch({ collection, query })` fuses keyword + vector with Reciprocal Rank Fusion (RRF, k=60) — the 2026-standard retrieval that beats pure-semantic. Both over REST too: `GET /api/:collection/semantic?q=` and `/hybrid?q=`. Graceful degradation in both directions.
  - **Access-checked by construction.** Every vector hit is loaded through the same access-control pipeline as a normal read — a semantic match for a document the caller can't read is dropped, never leaked. `limit` is clamped, `filter` is validated to real columns (no injection / prototype pollution), and an embedder that throws is logged (never with your text or API key) without breaking the content write.

  Ships with an in-process `memoryVector()` store (great for a single node); a pgvector-backed adapter is the documented production follow-up — the `VectorAdapter` interface is ready. Red-teamed to **Risk: LOW** (the access-leak surface was attacked exhaustively and held), verified by a live harness AND a Playwright end-to-end test that drives the real `/semantic` + `/hybrid` endpoints over HTTP. Fully opt-in and backward-compatible.

## 0.15.0

### Minor Changes

- **Types that actually reach your frontend, and a content model in minutes.**
  - **Bulletproof end-to-end types.** Generated types now cover the hard cases other CMSes get wrong (Strapi's are famously "off"): a **`blocks` page-builder field generates a discriminated union** — `Array<{ blockType: 'hero' } & {…} | { blockType: 'cta' } & {…}>` — so narrowing on `blockType` gives you each block's exact shape on the frontend. **Relationships generate `Relationship<T> = string | T`**, so the SAME field type-checks whether you read it shallow (an id) or populated (the related document), including `hasMany` and polymorphic targets. The typed client (`createTypedClient`) infers all of it with zero casts — proven by `expectTypeOf` type-level tests that fail the build if inference regresses.
  - **Instant setup with real starter models.** `create-kernel` ships four ready content models — `blog`, `shop`, `docs`, `portfolio` — each a correct, wired, seed-able schema. `create-kernel my-app --model shop` (or `--from-brief "an online store"`, which maps your description to the closest model offline) scaffolds a running TanStack Start app with that model in one unattended command. Every starter model is verified to actually boot a real kernel, migrate, seed, and populate a relationship — not just copy files. Still zero-dependency (Node built-ins only).

  (The "from a brief" mapping is deterministic and offline — curated models, not a live LLM; the agent/MCP layer remains the live-AI path.) Pure additions, fully backward-compatible.

## 0.14.0

### Minor Changes

- **It just works at scale and on serverless — now tested promises, not claims.**
  - **No artificial ceilings.** Other systems cap you (Contentful's 48 content types; Payload has been reported to struggle past ~100 collections). KernelCMS has no per-collection limit in the engine — you're bound only by your database and hardware. This is now proven by a harness that boots a real kernel with **200 collections** (deep relationship chains, drafts, a blocks page-builder) in ~30ms, migrates all 200 tables, and runs correct CRUD + relationship population across them — plus a 201st for good measure.
  - **Serverless / connection-pool sanity.** The Postgres adapter is hardened for edge/serverless where connection mismanagement bites (the footgun Payload hits on Vercel): one module-scoped pool is reused across invocations, **every** checked-out client is released in a `finally` (audited path by path — the init probe was the one gap, now fixed), `idleTimeoutMillis` drains idle clients between invocations, `max` stays low-tunable, and shutdown is idempotent. Backed by a unit test with an instrumented pool proving **zero leaked clients** across migrate/CRUD/transactions (even when a transaction throws mid-flight), that the pool is created exactly once, and that shutting down twice is safe.

  Both are pure hardening/proof — no API changes, fully backward-compatible.

## 0.13.0

### Minor Changes

- **AI-era content trust: provenance, content credentials, and pre-publish evals ("content CI").** When humans and AI agents co-author content, "who made this, and can I trust it?" becomes a first-class question. This answers it.
  - **Provenance.** `kernel.provenance({ collection, id })` returns the full authorship chain for a document — every version with its author (human vs `agent` vs `system`), the approver who published it, and rolled-up `createdBy` / `lastEditedBy` / `contributors`. Human-vs-agent authorship is explicit, derived from the version history (and the review approver), access-checked so it never leaks for a doc you can't read.
  - **Content credentials / signing (C2PA-style, tamper-evident).** Configure `signing: { secret }` (HMAC-SHA256) or an ed25519 `{ privateKey, publicKey }`, and every publish is cryptographically signed: a canonical manifest of claims (content hash, author, approver, publishedAt) plus a signature, stored as a content credential. `kernel.verifyContentCredential({ collection, id })` recomputes the hash and re-verifies the signature — so **any modification to published content after signing is detected** (`valid: false` with a tamper reason). Signatures made under a different key are rejected; key material never appears in any output, manifest, credential, or error; comparisons are constant-time.
  - **Automated pre-publish evals ("content CI").** Define `evals: [...]` — rules that run on the to-be-published document at the single publish chokepoint. A **blocking** rule that fails stops the publish (the document stays a draft and no credential is signed), exactly like a failing CI check; warnings are recorded but don't block. Crucially, evals run on **every** publish path — interactive, review-approval, born-published, scheduled, and override — so nothing reaches production unchecked, not even a timer-driven scheduled publish. Ships with composable built-ins: `a11yEval`, `seoEval`, `policyEval`, `brandEval`. An AI agent's page must pass content CI before a human can approve it live.

  The cryptography was red-teamed hard (forgery, canonicalization collisions, alg-confusion, key-leak — all blocked); an initial pass found scheduled/override publishes skipping the eval gate and a deep-recursion DoS — **both fixed and re-attacked to PASS (no CRITICAL/HIGH)**. Default-off and fully backward-compatible. Verified end-to-end against a live kernel.

## 0.12.0

### Minor Changes

- **Stop editors (and agents) from clobbering each other: presence, soft locks, optimistic concurrency.** As humans and AI agents edit the same content, "last write silently wins" becomes a real data-loss bug. This adds the lightweight safety net — DB-backed, no real-time server required.
  - **Optimistic concurrency (the hard guarantee).** Pass the `updatedAt` you last read as `expectedUpdatedAt` on an update; if the document moved on since (someone else saved first), the write is **rejected with a 409 conflict** instead of silently overwriting their work. The `ConflictError` carries the current document and the exact fields that diverged, so the client can diff, merge, and retry with the fresh token. Over REST it's standard `If-Match` / `If-Unmodified-Since` headers and an `ETag` on reads. Opt-in and backward-compatible — omit the token and you keep last-write-wins.
  - **Soft locks (advisory).** `kernel.acquireLock({ collection, id })` signals "I'm editing this"; others see `heldBy: 'other'` with the holder, so two people don't unknowingly start editing the same doc. Locks auto-expire (TTL, refreshed by re-acquiring), can't be stolen from an active holder, and only the holder or an admin can release one. Crucially, locks are **advisory, never authorizing** — a lock can't grant or deny a write that access control wouldn't; authorization stays in one place.
  - **Presence (live, lightweight).** `kernel.heartbeat({ collection, id, kind })` + `kernel.getPresence(...)` show who's currently viewing or editing a document (active set by TTL), over a simple `GET/POST /api/_presence/:collection/:id` — poll or wire to SSE. No CRDT, no always-on socket server.

  Presence and lock reads are access-scoped (you can't see who's editing a document you can't read), identity always comes from the authenticated principal (never client input), TTLs are clamped, and every system-table write is parameterized. Red-teamed hard — an initial pass found a conflict-payload field leak and a presence authz leak; **both fixed and re-attacked to PASS (no CRITICAL/HIGH remain)**. Verified end-to-end against a live kernel.

## 0.11.0

### Minor Changes

- **Migrations you can trust in production: preview, rollback, backfill, zero-downtime.** "I'm scared to change my schema" is the quiet reason teams stay on a CMS. This removes the fear.
  - **Dry-run preview.** `kernel migrate --dry-run` (alias `migrate:plan`) prints the exact SQL it _would_ run — CREATE TABLE / ALTER ADD COLUMN / CREATE INDEX — alongside the risk-classified change plan, and touches the database **zero** times. See precisely what will happen before it happens.
  - **Journaled rollback.** Every applied migration is recorded in a `_migrations` journal. `kernel migrate:rollback [--steps N] [--dry-run] [--force]` reverses the last migration — dropping exactly (and only) the tables and columns that migration added, in reverse order. It refuses to run without `--force`, and the safety invariant is absolute: it can only ever drop what it recorded as added, and **never** a system table. Rollback is wrapped in a transaction — a failure rolls back the rollback, leaving the journal entry intact to retry.
  - **Backfills.** `kernel backfill --collection posts --field tier --value free` (or a computed `set(doc)`) populates a new field across **every** existing row — drafts included — in batches. This is the missing piece of the safe online change: add a nullable column → backfill it → tighten it to required, with no downtime and no half-populated rows.
  - **Zero-downtime classification.** Real migrations run in a single transaction (all-or-nothing), and every change is labeled online-safe or not (add-nullable-column / create-table / create-index are safe to run live; add-required-column, drops, and retypes need the expand→backfill→contract flow), with the guidance printed right in the plan.

  Backfill and rollback run as trusted maintenance with no access bypass into user data, reject system/authority fields and prototype-pollution keys, and quote every identifier (no SQL injection via table/column names). Red-teamed to **Risk: LOW** (33 attack vectors, zero bypasses — including forged-journal attempts to drop system tables). SQLite verified end-to-end; Postgres implemented by parity. Backward-compatible: existing `migrate`/`migrate:status`/`migrate:snapshot` are unchanged.

## 0.10.0

### Minor Changes

- **Localization grows up: strict mode, bulk multi-locale, and translation status.** KernelCMS already stores every locale of every field; this exposes the three things Payload users ask for.
  - **Strict mode** (`localization: { strict: true }`). Stops silently masking untranslated content: a field with no value for the requested locale returns `null` instead of quietly falling back to another language — so your API (and your readers) see the truth, not English wearing a French label. Strict also enforces required localized fields per locale on write, and **gates publishing**: you can't publish a document whose default-locale required fields are empty (the error lists exactly which `locale.field` pairs are missing). A caller can still opt into fallback explicitly per request.
  - **Bulk multi-locale.** `kernel.updateLocales({ collection, id, locales: { en: {...}, fr: {...}, de: {...} } })` fills or updates many locales in one call, merging into each locale's slot — it never clobbers a locale you didn't pass. Read every locale at once with `locale: 'all'` (or `?locale=all`), which returns each localized field as its full `{ en, fr, de }` map.
  - **Translation status.** `kernel.translationStatus({ collection, id })` reports, per locale, whether it's complete and which required fields are missing; `kernel.translationStatusList({ collection })` powers a translation dashboard (completeLocales / incompleteLocales per doc), and an admin/editor route at `/api/_admin/translation-status/:collection` exposes it. Field names and counts only — never field values.

  Untrusted locale keys are validated against your configured locales and prototype-pollution-guarded; every new read/write runs the normal access + field-scope pipeline with no override. Red-teamed to **Risk: LOW** (7 attack classes, zero bypasses). Fully backward-compatible — non-strict behavior is unchanged. Verified end-to-end against a live kernel.

## 0.9.0

### Minor Changes

- **One-command importers — leave any CMS without the pain.** `kernel import --from wordpress|contentful|sanity|strapi|payload --file <export>` pulls your content out of another CMS and into KernelCMS in a single command. Migration is the lock-in moat competitors rely on; this dissolves it.
  - **Dry-run by default.** The command previews exactly what it would do — docs to create per collection, fields it will drop (anything not in your schema), and any relationships that won't resolve — and writes **nothing** until you pass `--apply`. No surprise mutations.
  - **Real relationship resolution.** A two-pass, id-mapped engine creates every record, then rewires references (post→author, entry→linked entry, document→`_ref`) to the newly-created ids. Unresolvable references are reported, never silently dropped.
  - **Five adapters, fixture-verified end-to-end:** WordPress (WXR XML export), Contentful (`contentful-export` JSON, locale-aware), Sanity (NDJSON export), Strapi (v4 JSON export), Payload (JSON export). Each parses the source's real export format — no new runtime dependencies, a dependency-free XML reader that resolves no external entities (XXE-safe).
  - **Safe by construction.** Imports validate every target collection against your config (unknown types are skipped, never auto-created), guard against prototype-pollution keys, refuse to steer references into authority/system fields, cap file size, and never log a source `--token`. Hardened and red-teamed to **Risk: LOW** (XXE, entity-expansion, nested prototype pollution, target spoofing, and `_status` injection all attempted and blocked).

  The previous portable-JSON importer is preserved as `kernel import:json`. Verified end-to-end against a live kernel.

## 0.8.0

### Minor Changes

- **Agent review inbox + AI page composition — hand the CMS to an AI, safely.** KernelCMS already makes an AI agent a first-class, access-controlled, draft-only principal. This adds the human approval layer that makes it production-safe, plus a one-call page composer.
  - **Review inbox.** `kernel.findReviewQueue()` lists every agent-authored draft awaiting review (across all drafts-enabled collections, scoped to the reviewer's read access), and `kernel.submitReview({ collection, id, decision, note })` either **approves** (publishes) or **requests changes** (keeps it a draft and leaves a note the agent can act on). Approval reuses the existing publish access gate under the reviewer's own identity — a reviewer without publish rights is rejected, and an agent can never approve its own work. Admin-or-editor-gated HTTP routes at `/api/_admin/reviews`. Every decision is recorded in the audit log (`review.approve` / `review.request_changes`).
  - **AI page composition.** `kernel.composePage({ collection, blocks: [{ type, data }], data? })` — and the matching `<collection>_compose_page` MCP tool — assemble a `blocks` page layout from a structured spec, validated against the collection schema (every block type and field must exist; prototype-pollution keys rejected), and create it through the normal pipeline. So an AI composes a whole page in a single call that **cannot** produce an invalid layout, and — because it runs as the agent — the result lands as a draft in the review inbox rather than going live.

  Nothing an agent writes reaches production until a human approves it — a hard guarantee enforced by the core engine, not the surface. Security-reviewed and red-teamed to **Risk: LOW** (38 adversarial probes, zero bypasses; self-approval, draft-only-bypass, and prototype-pollution all defended), with bounds on compose size and note length. Verified end-to-end against a live kernel. Fully backward-compatible: the inbox provisions only when `agents` are configured or `review: true` is set.

## 0.7.0

### Minor Changes

- **True inline visual editing — edit content directly on the rendered page.** KernelCMS's live preview was one-way: you edited in the admin and watched the page update. Now it's bidirectional. Double-click any text the frontend marks editable (`kernelEditable(path)` → `data-kernel-path` + `data-kernel-editable`) and type directly on the page — headings, labels, CTAs, any plain-text field — and the change patches straight back into the document and the side-panel field. Save works exactly as before.

  This closes the most common complaint about preview in other config-as-code CMSes ("preview is one-way; you can't edit on the page"). It's built on a small, framework-agnostic postMessage protocol (`@kernel/visual-editing`): the preview posts `edit-start` / `patch` / `edit-end` up to the editor, the editor pauses its data echo for the path being edited (no caret clobber), then re-syncs on commit.

  Hardened against the untrusted preview→editor channel: the editor applies a patch only when the dot-path already resolves to a primitive leaf in the document (no key creation, no prototype pollution, no collapsing an object subtree), values are primitive-only, the message origin and source are both checked, and stale markup whose path has drifted from the schema can't enter edit mode. Red-teamed to Risk: LOW; verified end-to-end.

## 0.6.0

### Minor Changes

- **Governance, free in core: SSO, RBAC, and an audit log.** The three things teams are forced onto Enterprise plans for elsewhere ship in MIT core here — no seat metering, no add-on tier.
  - **SSO via OpenID Connect.** `oidcProvider({ issuer, clientId, clientSecret })` plus presets for `oktaSSO`, `auth0SSO`, `entraSSO` (Microsoft), `googleWorkspaceSSO`, and `oneLoginSSO`. The `id_token` is verified strictly — asymmetric-only algorithm allowlist (RS/ES; `alg:none` and HMAC alg-confusion rejected before any key work), JWKS signature check with bounded refresh, and `iss`/`aud`/`azp`/`exp`/`nbf`/`nonce` all enforced. State, nonce, and PKCE are server-generated and bound to an HttpOnly+Secure cookie, never the front channel. No new dependencies — `node:crypto` + `fetch`.
  - **Granular, runtime-editable RBAC.** Define roles as `role → permission grants` (`{ admin?, collections, globals }`, ops `read|create|update|delete|publish`) in config, or edit them live via `kernel.createRole/updateRole/deleteRole` and the admin-gated `/api/_admin/roles` API — changes take effect on the next access check, no redeploy. Deny-by-default for unknown roles; explicit collection `access` rules always win; nothing is injected when `rbac` is unset (fully backward-compatible).
  - **Append-only audit log.** Opt in with `audit: true`. Every create/update/delete/publish/unpublish/login — and every role mutation — is recorded with who, what (changed field names, never values), and when. Query it with `kernel.findAuditLog(...)` or the admin-only `/api/_admin/audit` endpoint (with CSV export, formula-injection-guarded). Failed-login records store a non-reversible email digest rather than raw addresses.

  Security-reviewed and red-teamed to **Risk: LOW** (no critical/high findings; the full id_token forgery playbook was attempted and defended), and verified end-to-end against a live kernel.

## 0.5.0

### Minor Changes

- 7d1c8a7: **Agent-native: hand your content to an AI agent, safely.** An AI agent can now be
  a first-class, access-controlled principal that flows through the exact same
  per-operation permission pipeline as a human. Agents are scoped by a field
  allow/deny list, are draft-only (they physically cannot publish — that's a hard
  guarantee, not a config option), authenticate with their own constant-time-checked
  token, and never run with elevated access. Every agent write is attributed in
  version history.

  A new `@kernel/mcp` package (also at `kernelcms/mcp`) exposes a kernel as a Model
  Context Protocol (MCP) server whose tools are auto-generated from the same
  descriptor that generates the OpenAPI spec. Every tool call is routed through the
  in-process Local API with the agent principal, so access control, field scoping,
  and the draft-only brake are enforced by the core engine — the MCP layer enforces
  nothing on its own. It includes:
  - CRUD + `count` + version-history tools per collection, global tools, and MCP
    safety annotations (read-only / destructive hints).
  - **Opt-in custom-endpoint tools** (`mcp: true` on a `defineEndpoint`) so an agent
    can call your business logic, gated by that endpoint's own access rule.
  - **Schema resources** (`kernel://schema`, `kernel://collections/<slug>`) so an
    agent can introspect the content model (visible collections only).
  - A **multi-agent HTTP transport** with per-request, constant-time-authenticated,
    scoped principals — plus a `kernel mcp` CLI command to serve over stdio (Claude
    Desktop / Cursor) or HTTP. The MCP SDK is an optional peer dependency, so the
    base install stays lean.

  Also in this release:
  - **Referential integrity:** relationship/upload fields take an `onDelete` option
    (`setNull` | `cascade` | `restrict`) with cycle protection. Agent-initiated
    cascades are access-checked and fail closed.
  - **Publish is now a distinct, access-controlled transition.** Add
    `access.publish` to a collection to gate the draft → published edge separately
    from `update`; the previous "anyone who can update can publish" behavior is
    preserved by default.
  - **Faster reads:** relationship population is now batched, eliminating the N+1
    query pattern on list endpoints while preserving per-document access checks.
  - Relationship/foreign-key columns are indexed by default.
  - Relationship populate depth is bounded to prevent runaway recursion.
  - The admin live preview coalesces updates per frame instead of posting on every
    keystroke.

## 0.4.0

### Minor Changes

- b857ba6: Rich text editing is now powered by ProseMirror, replacing the deprecated
  `execCommand`/contentEditable editor. The stored `KernelRichText` model and the
  per-field feature allow-list are unchanged, and every change is still run through
  `sanitizeRichText` (link hrefs are additionally guarded against unsafe schemes at
  the editor boundary).

  Adds click-to-edit live preview. A new visual-editing SDK, shipped at the
  `kernelcms/visual-editing` and `kernelcms/visual-editing/react` subpaths
  (`kernelEditable(path)`, `useKernelPreview()`), lets any frontend become editable
  inside the admin's live-preview iframe, and the built-in preview now focuses the
  matching field when you click an element, with hover outlines — over an
  origin-validated postMessage channel.
