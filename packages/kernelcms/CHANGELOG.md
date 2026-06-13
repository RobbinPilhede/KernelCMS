# kernelcms

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
