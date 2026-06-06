# Security Model & Hardening

KernelCMS treats security as a property of the operation core, not a middleware afterthought. Every read and write — REST, GraphQL, RPC, or in-process Local API — passes through the same access-control evaluation, the same input parsing, and the same output encoding. This document specifies the threat surface KernelCMS defends, how input validation and output encoding are wired into the data layer, and the concrete defenses against CSRF, XSS, and SSRF. It closes with the CSP and security-header policy and how secrets are loaded and isolated. Authentication mechanics (sessions, JWT, providers) live in [04-authentication.md](./00-authentication.md); the field- and document-level authorization model lives in [05-access-control.md](./01-authorization-and-access-control.md).

## Threat Surface

A headless CMS is an attractive target because it sits between untrusted public traffic and a privileged data store, and because it generates APIs automatically from config. The surfaces KernelCMS must defend:

| Surface                 | Entry points                                  | Primary threats                                              |
| ----------------------- | --------------------------------------------- | ------------------------------------------------------------ |
| Public content APIs     | `@kernel/rest`, `@kernel/graphql`, public RPC | Unauthorized read, enumeration, query-cost abuse, injection  |
| Admin app               | `@kernel/admin` (TanStack Start)              | CSRF, XSS via rich text, session theft, privilege escalation |
| Authoring writes        | mutations across all surfaces                 | Injection, mass-assignment, stored XSS, IDOR                 |
| Uploads & media         | `@kernel/storage` adapters                    | SSRF (remote-URL ingest), malicious files, path traversal    |
| Server functions        | TanStack Start RPC                            | Forged calls, deserialization abuse                          |
| Webhooks & integrations | outbound hooks, OAuth callbacks               | SSRF, signature forgery, secret leakage                      |
| Config & deploy         | `kernel.config.ts`, env, adapters             | Hardcoded secrets, insecure adapter defaults                 |

The defining property of KernelCMS's surface is that **the API shape is derived from `kernel.config.ts`**. Payload, Sanity, and Strapi share this generative model and inherit the same risk: a field added in config silently becomes queryable and writable. KernelCMS's answer is that generation never produces an open default — every generated endpoint is denied until an access rule grants it. Strapi historically shipped with permissive defaults on its public role, which produced a long tail of accidental data exposure; KernelCMS inverts that. Unspecified access is `false`.

```
  Untrusted traffic
        │
        ▼
  ┌───────────────┐   parse + validate   ┌──────────────┐
  │ REST/GraphQL/ │ ───────────────────▶ │  Operation   │
  │ RPC adapters  │                      │  core        │
  └───────────────┘                      │ (access →    │
        ▲                                │  hooks →     │
   encode on egress                      │  adapter)    │
        │                                └──────────────┘
  ┌───────────────┐                             │
  │  Response      │ ◀────────────────────────  │
  │  (typed)       │      encode for context    ▼
  └───────────────┘                      Drizzle / Mongo
```

Every surface funnels into the same operation core. That convergence is the security win: there is exactly one place where authorization and validation are enforced, so a new transport (say, a future gRPC adapter) cannot bypass the controls by accident.

## Input Validation and Output Encoding

Validation is part of the field definition, not bolted on at the route. Each field type in `@kernel/core` carries a parser that runs before any value reaches an adapter. The query language (`where` / `sort` / pagination / `depth`) is parsed into a typed AST and compiled to parameterized Drizzle predicates — never string-concatenated SQL.

```ts
// kernel.config.ts
import { defineCollection, fields } from '@kernel/core'

export const posts = defineCollection({
  slug: 'posts',
  fields: {
    title: fields.text({ required: true, maxLength: 200 }),
    slug: fields.text({
      required: true,
      validate: (v) => /^[a-z0-9-]+$/.test(v) || 'slug must be kebab-case',
    }),
    excerpt: fields.textarea({ maxLength: 500 }),
    canonicalUrl: fields.text({
      validate: async (v) => (await isHttpsUrl(v)) || 'must be an https URL',
    }),
    body: fields.richText(),
  },
})
```

Three rules hold across the data layer:

- **Whitelist, not blacklist.** Unknown fields in a write payload are rejected, not silently dropped. This closes mass-assignment: a client cannot set `author`, `publishedAt`, or `_id` unless the field exists _and_ the field-level access rule permits writing it. Strapi's older content API allowed populating relations a caller shouldn't see; KernelCMS resolves `depth` expansion through the same access checks as a direct read.
- **Parse at the boundary, trust internally.** By the time a value reaches a `beforeChange` hook it is already typed and range-checked. Hooks operate on validated data, so business logic never re-parses untrusted strings.
- **Query cost is bounded.** Pagination has a hard server `maxLimit`, `depth` has a configurable ceiling, and the GraphQL adapter enforces query depth and complexity limits. This blunts the resource-exhaustion vector that unbounded `populate`/`depth` queries create.

Output encoding is contextual and happens on egress, not in storage. KernelCMS stores rich text as a structured JSON AST (`@kernel/richtext`), never as raw HTML. The admin renders the AST through React, which escapes text nodes by default; the serializer that emits HTML for frontends walks the same AST and encodes per node type. There is no path where a stored string is interpolated into markup. This is the same architectural choice Sanity makes with Portable Text and a deliberate divergence from CMSs that persist HTML blobs and must sanitize on every read.

```ts
// @kernel/richtext — allowlist enforced at serialize time
import { serializeHtml, defaultSchema } from '@kernel/richtext'

const html = serializeHtml(doc.body, {
  schema: defaultSchema, // nodes/marks allowlist
  allowedHref: (href) => /^(https?:|mailto:|\/)/.test(href),
  // unknown nodes are dropped, not rendered
})
```

## CSRF, XSS, and SSRF Defenses

These three get explicit, separate treatment because they target different layers.

### CSRF

The admin authenticates with cookie-based sessions issued by `@kernel/auth`. Cookies are `HttpOnly`, `Secure`, and `SameSite=Lax`, which already neutralizes top-level cross-site form posts. On top of that, all admin mutations go through TanStack Start **server functions**, which require a same-origin custom header and a double-submit CSRF token bound to the session. State-changing requests carrying only ambient cookies (no token, no `Origin`/`Sec-Fetch-Site` match) are rejected at the adapter before reaching the operation core.

```ts
// kernel.config.ts
export default defineConfig({
  security: {
    csrf: {
      enabled: true, // on by default for cookie auth
      sameSite: 'lax',
      trustedOrigins: ['https://admin.example.com'],
    },
  },
})
```

Token-authenticated API clients (Bearer/API key) are exempt from CSRF checks because they don't ride ambient cookies — there is nothing for a cross-site request to forge.

### XSS

The structured-AST approach above is the primary defense: stored content cannot become script. The remaining XSS vectors are admin-side, and KernelCMS closes them with a strict CSP (next section), React's default escaping, and a hard rule that no field renderer uses `dangerouslySetInnerHTML` on user content without passing through the `@kernel/richtext` serializer. Custom field components — an escape hatch users will reach for — are documented to receive already-encoded values and are linted against raw HTML injection. Live preview, which renders draft content into an iframe, sandboxes that frame (`sandbox="allow-scripts allow-same-origin"` scoped to the preview origin only) so a malicious draft cannot reach the admin session.

### SSRF

SSRF is the under-discussed CMS vector: remote-image ingest, webhook delivery, and OAuth discovery all make the server fetch attacker-influenced URLs. KernelCMS routes every server-initiated outbound request through a single guarded fetch in `@kernel/server`.

```ts
// @kernel/server — outbound request guard
import { guardedFetch } from '@kernel/server'

await guardedFetch(remoteUrl, {
  allowPrivateNetwork: false, // blocks 10/8, 127/8, 169.254/16, fc00::/7, ::1
  allowedProtocols: ['https:'],
  maxRedirects: 2, // each hop re-validated post-DNS-resolution
  timeoutMs: 5000,
  maxBytes: 25 * 1024 * 1024,
})
```

The guard resolves DNS first and validates the _resolved_ IP against the private-range denylist, which defeats DNS-rebinding and `http://localhost` tricks. Redirects are followed manually and re-checked at every hop. Webhook destinations are restricted to an operator-configured allowlist, and outbound calls never inherit ambient cloud credentials — relevant on KernelCMS Cloud, where an unguarded fetch to `169.254.169.254` would expose the instance metadata service.

## CSP and Security Headers

The admin and the API host ship a strict, nonce-based Content Security Policy by default. No `unsafe-inline`, no `unsafe-eval` in production. TanStack Start emits a per-request nonce that the SSR layer threads into every inline script tag, so the admin runs with a genuinely strict `script-src`.

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self' 'nonce-{random}';
  style-src 'self' 'nonce-{random}';
  img-src 'self' data: https://cdn.example.com;
  connect-src 'self' https://api.example.com;
  frame-ancestors 'none';
  base-uri 'self';
  form-action 'self';
  object-src 'none'
```

The full header set, applied by `@kernel/server`:

| Header                                | Value                                          | Purpose                  |
| ------------------------------------- | ---------------------------------------------- | ------------------------ |
| `Content-Security-Policy`             | strict, nonce-based                            | XSS containment          |
| `Strict-Transport-Security`           | `max-age=63072000; includeSubDomains; preload` | force HTTPS              |
| `X-Content-Type-Options`              | `nosniff`                                      | block MIME sniffing      |
| `Referrer-Policy`                     | `strict-origin-when-cross-origin`              | limit referrer leakage   |
| `X-Frame-Options` / `frame-ancestors` | `DENY` / `'none'`                              | clickjacking             |
| `Permissions-Policy`                  | deny camera, geolocation, etc.                 | reduce feature surface   |
| `Cross-Origin-Opener-Policy`          | `same-origin`                                  | isolate browsing context |

```ts
// kernel.config.ts — headers are configurable but secure by default
export default defineConfig({
  security: {
    headers: {
      csp: {
        directives: {
          imgSrc: ["'self'", 'data:', 'https://cdn.example.com'],
          connectSrc: ["'self'", 'https://api.example.com'],
        },
      },
      hsts: { maxAge: 63072000, includeSubDomains: true, preload: true },
    },
  },
})
```

CORS is explicit-allowlist only. A wildcard origin combined with credentials is a configuration error that `@kernel/server` refuses to start with — you cannot accidentally ship `Access-Control-Allow-Origin: *` alongside cookie auth. This is stricter than the defaults several competing CMSs ship for local development and then forget to tighten.

## Secrets Handling

Secrets are never literals in `kernel.config.ts`. Config reads them from the environment through a typed loader that fails fast at boot if a required secret is missing or malformed, so a misconfigured deploy crashes loudly instead of running insecurely.

```ts
// kernel.config.ts
import { defineConfig, env } from '@kernel/core'

export default defineConfig({
  secret: env.required('KERNEL_SECRET'), // throws at boot if absent
  db: postgres({ url: env.required('DATABASE_URL') }),
  storage: s3({
    accessKeyId: env.required('S3_ACCESS_KEY_ID'),
    secretAccessKey: env.required('S3_SECRET_ACCESS_KEY'),
  }),
  email: resend({ apiKey: env.required('RESEND_API_KEY') }),
})
```

Handling rules:

- **Server-only boundary.** `@kernel/core` config marked as secret is stripped from any payload serialized to the admin client. The TanStack Start build separates server and client bundles, and the secrets loader is server-only — importing it client-side is a build error.
- **Redaction in logs and errors.** The structured logger and error serializer scrub known secret keys and Bearer/Authorization values before anything is written or returned. No secret reaches a stack trace sent to the browser.
- **At rest.** Session secrets and OAuth client secrets live in env or a secret manager. On KernelCMS Cloud, secrets are stored encrypted and injected at runtime, never written to the project's config repo — preserving the config-as-code portability guarantee without committing credentials.
- **Rotation.** `KERNEL_SECRET` supports a primary/previous pair so signing keys rotate without invalidating every active session at once.

The principle: config-as-code is the source of truth for _shape_, never for _secrets_. The shape is committed; the values are injected.

## Open Questions

- **CSP for third-party admin plugins.** `@kernel/plugin-sdk` components may need external `script-src`/`connect-src` entries. Whether plugins declare CSP additions in a manifest that the host merges (and how to prevent a plugin from weakening the policy) is undecided.
- **Default rich-text serializer hardening.** Whether the HTML serializer should additionally run a DOMPurify-equivalent pass as defense-in-depth, given the AST is already an allowlist, is an open trade-off against bundle size and serialize latency.
- **SSRF allowlist UX.** Whether webhook/remote-ingest allowlists belong in `kernel.config.ts` (code-reviewed, static) or in the admin (operator-editable, audited) — or both — is still being weighed.
