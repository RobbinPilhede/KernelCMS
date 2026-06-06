# Threat Model (STRIDE)

This document is the STRIDE threat model for KernelCMS across both deployment modes — self-host and KernelCMS Cloud. It identifies the assets worth protecting, draws the trust boundaries that separate attacker-controlled input from trusted execution, walks STRIDE (Spoofing, Tampering, Repudiation, Information disclosure, Denial of service, Elevation of privilege) per component, ranks the concrete risks, and states the residual risk we knowingly accept. It assumes the security defaults described in Security Model and [Access Control](../06-auth-security/01-authorization-and-access-control.md), and is meant to be revisited whenever a new adapter, surface, or trust boundary lands.

## Assets and trust boundaries

KernelCMS has a small number of high-value assets. Everything else is a delivery mechanism for compromising one of them.

| Asset                                                       | Why it matters                                                           | Primary owner                      |
| ----------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------- |
| Content (collections, globals, drafts, versions)            | The product. Tampering or leakage is the worst-case outcome.             | `@kernel/server` operation core    |
| Auth credentials and sessions                               | Compromise yields impersonation and privilege escalation.                | `@kernel/auth`                     |
| Access-control logic                                        | Defines who can read/write which document and field.                     | `@kernel/core` config              |
| Adapter secrets (DB URL, S3 keys, SMTP creds, queue tokens) | Pivot point to the rest of the infrastructure.                           | env / `@kernel/cloud` secret store |
| Media blobs                                                 | May be private, may be malware vectors on upload.                        | `@kernel/storage`                  |
| The admin app bundle and `kernel.config.ts`                 | Config-as-code is the source of truth; tamper it and you own everything. | build pipeline                     |

The architecture has five trust boundaries. Data crossing a boundary inward is untrusted until validated.

```
            ┌──────────── Boundary A: network edge ────────────┐
 Browser ──▶│ TanStack Start (SSR, server fns) — @kernel/server │
 (untrusted)│   REST · GraphQL · typed RPC                      │
            │        │                                          │
            │        ▼  Boundary B: operation core              │
            │   access control · validation · hooks (@kernel/core)
            │        │                                          │
            │   ┌────┴─────┬──────────┬──────────┐              │
            │   ▼          ▼          ▼          ▼              │
            │  DB        Storage     Email      Queue           │
            │ adapter    adapter    adapter    adapter          │
            └───┼──────────┼──────────┼──────────┼─────────────┘
                ▼          ▼          ▼          ▼
          Boundary C: adapter ↔ external infra (Postgres, S3, SMTP, Redis)
```

- **Boundary A — network edge.** Every byte from a browser or API client is hostile. The Local API runs in-process and skips the wire, but it does _not_ skip access control — same operation core, same checks.
- **Boundary B — operation core.** The single chokepoint where access control and validation run. Payload and Strapi both let you reach the ORM from custom code and bypass document/field rules; KernelCMS routes REST, GraphQL, RPC, and the Local API through the same `@kernel/core` operations so the policy is unforgeable from a feature's perspective.
- **Boundary C — adapter to infra.** Adapters hold secrets and speak to Postgres/SQLite/MySQL/MongoDB, S3-compatible storage, SMTP, search, cache, and queue. A compromised adapter config is a full breach.
- **Boundary D — Cloud tenant isolation** (KernelCMS Cloud only). Multi-tenant control plane separating one customer's content and secrets from another's. See [multi-tenant isolation](../10-cloud-operations/03-multi-tenancy-and-isolation.md).
- **Boundary E — build/supply chain.** `create-kernel` output, the `kernel` CLI, plugins via `@kernel/plugin-sdk`, and the `@kernel/*` dependency tree.

## STRIDE per component

### Edge / API host (`@kernel/server`, REST, GraphQL, RPC)

| Threat              | Vector                                                           | Mitigation                                                                                        |
| ------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **S**poofing        | Forged session cookie or bearer token                            | `@kernel/auth` verifies signature, expiry, issuer; cookies are `Secure + HttpOnly + SameSite=Lax` |
| **T**ampering       | Mass-assignment of protected fields via REST/GraphQL body        | Field-level access strips writes before they reach the adapter                                    |
| **R**epudiation     | "I didn't publish that"                                          | Version history with actor + timestamp per mutation; audit log is append-only                     |
| **I**nfo disclosure | GraphQL introspection or deep `depth` leaks restricted relations | Read access evaluated per resolved document; `depth` capped; introspection off in production      |
| **D**oS             | Expensive GraphQL nesting, unbounded `where`, login flooding     | Query cost limits, pagination caps, per-route rate limits (stricter on auth)                      |
| **E**levation       | Reaching the ORM directly from a server function                 | Server functions call `@kernel/core` operations, never the adapter directly                       |

The shared query language (`where` / `sort` / pagination / `depth`) is parsed and bounded once, so a hostile query cannot mean different things on REST versus GraphQL versus RPC — a class of inconsistency bug that bites Strapi's separate REST and GraphQL plugins.

### Operation core and access control (`@kernel/core`)

Access control is evaluated at three granularities — operation, document, and field — and it is the keystone of the whole model. A subtle bug here is a privilege-escalation bug.

```typescript
// kernel.config.ts — access runs server-side, on every surface
export const Posts = defineCollection({
  slug: 'posts',
  access: {
    read: ({ req }) => (req.user?.role === 'editor' ? true : { status: { equals: 'published' } }), // returns a where-filter, not a boolean
    update: ({ req, id }) => isOwnerOrEditor(req.user, id),
  },
  fields: [
    { name: 'title', type: 'text', required: true },
    {
      name: 'internalNotes',
      type: 'textarea',
      access: { read: ({ req }) => req.user?.role === 'editor' },
    },
  ],
})
```

Returning a `where` filter instead of a boolean means a denied read narrows results rather than throwing — the filter is composed into the DB query, so unauthorized rows never load into memory. **T**ampering and **E**levation here are mitigated by making access functions pure and by snapshotting the resolved policy in tests. Cross-field and async validators run inside the same boundary, so an attacker cannot satisfy a sync rule and skip the async one.

### Auth (`@kernel/auth`)

| Threat              | Mitigation                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------ |
| **S**poofing        | argon2id password hashing; constant-time compare; optional MFA/passkeys                                |
| **R**epudiation     | Login, logout, and password-reset events logged with IP and UA                                         |
| **I**nfo disclosure | Generic "invalid credentials" — never reveal which factor failed; no user enumeration on reset         |
| **D**oS             | Per-account and per-IP throttle with exponential backoff on auth routes                                |
| **E**levation       | Role/permission claims resolved server-side from the DB per request, never trusted from the token body |

### Persistence (`@kernel/db-*`)

SQL injection is structurally prevented: Drizzle parameterizes every query and the `where` language compiles to bound parameters, never string concatenation. The MongoDB adapter rejects operator injection (`$where`, `$function`) at the query-language boundary before building the filter. **T**ampering via migrations is gated — migrations are generated from schema diffs and reviewed, never applied from untrusted input.

### Storage and uploads (`@kernel/storage`)

Uploads are the classic CMS foothold. Mitigations: server-side MIME sniffing (not trusting the extension or client `Content-Type`), size limits, EXIF stripping on images, and serving user content from a separate origin with `Content-Disposition: attachment` for non-renderables to neutralize stored XSS. Signed, expiring URLs for private media. This is stricter than Strapi's default upload provider, which has historically served user files from the app origin.

### Admin app (`@kernel/admin`, `@kernel/ui`)

Built on TanStack Start/Router/Query/Form/Table/Store/Virtual. **T**ampering and **I**nfo disclosure: the admin is a thin client — it never holds authorization logic; every list and form re-checks server-side. React's default escaping plus a strict CSP (no `unsafe-inline`/`unsafe-eval`) contains XSS; the block-based rich-text editor sanitizes on serialize _and_ on render. Live preview with visual editing runs in a sandboxed frame with `postMessage` origin checks.

### Cloud control plane (`@kernel/cloud`)

Boundary D. **E**levation across tenants and **I**nfo disclosure between tenants are the dominant threats. Mitigations: per-tenant credential scoping, row-level isolation enforced below the operation core, encrypted-at-rest secret storage, and tenant-scoped CDN signing keys. Billing and observability run in a control plane that cannot read tenant content payloads.

## Top risks and mitigations

Ranked by `likelihood × impact`. These are the issues that get fixed before ship, per the security gate.

| #   | Risk                                                          | STRIDE | Severity | Mitigation status                                                                                             |
| --- | ------------------------------------------------------------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------- |
| 1   | Access-control bypass via a surface that skips `@kernel/core` | E / T  | Critical | All surfaces forced through operation core; lint rule bans direct adapter import outside `@kernel/db-*`       |
| 2   | Field-level read leak through GraphQL `depth`/relations       | I      | High     | Per-document field read checks on every resolved node; `depth` capped at 10                                   |
| 3   | Stored XSS via rich-text or upload served on app origin       | T / I  | High     | Sanitize-on-serialize-and-render; separate media origin; strict CSP                                           |
| 4   | Malicious plugin via `@kernel/plugin-sdk`                     | E      | High     | Plugins declare a capability manifest; no ambient DB/secret access; reviewed before Cloud marketplace listing |
| 5   | Cross-tenant data access on Cloud                             | I / E  | High     | Row-level isolation + per-tenant keys; isolation tests in CI                                                  |
| 6   | Auth brute force / credential stuffing                        | S / D  | Medium   | argon2id, throttle + backoff, optional MFA                                                                    |
| 7   | GraphQL/`where` query-cost DoS                                | D      | Medium   | Cost analysis, pagination caps, statement timeouts                                                            |
| 8   | Secret leakage in logs or error responses                     | I      | Medium   | Structured logging with redaction allowlist; generic client errors                                            |

A representative hardening snippet:

```typescript
// kernel.config.ts
export default defineConfig({
  security: {
    rateLimit: { window: '1m', max: 120, auth: { max: 5 } },
    graphql: { maxDepth: 10, maxComplexity: 1000, introspection: false },
    cors: { origins: ['https://admin.example.com'], credentials: true },
    csp: { directives: { 'script-src': ["'self'"], 'object-src': ["'none'"] } },
    upload: { maxBytes: 25_000_000, sniffMime: true, stripExif: true },
  },
})
```

## Residual risk

What we knowingly accept after the mitigations above:

- **Operator misconfiguration.** A self-host operator can disable rate limiting, widen CORS to `*`, or expose introspection. We ship safe defaults and a `kernel doctor` audit, but config-as-code means the operator owns the final word. This is an escape-hatch tradeoff we accept.
- **Custom hook code.** Hooks and custom field types run with full server privileges by design. A `beforeChange` hook that reaches outside the operation core can bypass field access. We document this sharp edge; we do not sandbox first-party hooks.
- **Compromised adapter infrastructure.** If Postgres, S3, or the SMTP relay is breached directly, KernelCMS cannot defend Boundary C from inside Boundary B. Defense is delegated to infra controls (network policy, IAM, encryption at rest).
- **Supply chain.** We pin and audit `@kernel/*` and lock the dependency tree, but a compromised upstream transitive dependency remains a residual risk shared by every Node CMS, Payload and Strapi included.
- **Social engineering of human admins.** MFA reduces but does not eliminate account takeover via phishing.

## Open questions

- Should first-party hooks run in a capability-restricted sandbox (Boundary B sub-isolation), or does that break the "always provide escape hatches" tenet? Leaning toward documenting the risk over sandboxing, but undecided for Cloud.
- Do we sign and verify the resolved `kernel.config.ts` artifact at boot to detect build-time tampering (Boundary E), or treat that as the deployment pipeline's responsibility?
- Whether plugin capability manifests should be enforced at runtime via a permission broker, or only reviewed statically before marketplace listing.
