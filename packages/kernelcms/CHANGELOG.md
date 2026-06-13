# kernelcms

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
