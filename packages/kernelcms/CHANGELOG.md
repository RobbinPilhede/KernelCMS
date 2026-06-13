# kernelcms

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
