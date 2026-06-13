# kernelcms

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
