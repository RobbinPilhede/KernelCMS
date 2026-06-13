# kernelcms

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
