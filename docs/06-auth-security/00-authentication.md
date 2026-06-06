# Authentication

Authentication in KernelCMS is one concern handled by a swappable adapter, exposed through `@kernel/auth`. It governs two distinct audiences: human operators using the TanStack Start admin panel, and programmatic API consumers hitting REST, GraphQL, or typed RPC. The same operation core that enforces [access control](./01-authorization-and-access-control.md) sits behind both, so an authenticated principal — whether a session-backed admin user or a token-bearing service — resolves to the same `User` shape and the same authorization evaluation. Nothing here is hard-wired: strategies, hashing, and session transport are all configured in `kernel.config.ts` and backed by your chosen database adapter.

## Strategies

Payload bakes in local (email + password) and JWT, with OAuth bolted on through plugins. Strapi ships a users-permissions plugin plus a separate admin auth system — two parallel models that confuse newcomers. Sanity outsources auth entirely to its hosted SSO. KernelCMS unifies all of this under a single strategy registry. Each strategy implements one contract and contributes routes, callbacks, and a credential verifier.

```ts
// kernel.config.ts
import { defineConfig } from '@kernel/core'
import { local, oauth, apiKey, magicLink } from '@kernel/auth/strategies'

export default defineConfig({
  auth: {
    strategies: [
      local({ identifierField: 'email', allowSignup: false }),
      oauth({
        providers: {
          github: { clientId: process.env.GITHUB_CLIENT_ID!, clientSecret: process.env.GITHUB_CLIENT_SECRET! },
          google: { clientId: process.env.GOOGLE_CLIENT_ID!, clientSecret: process.env.GOOGLE_CLIENT_SECRET! },
        },
        linkBy: 'email', // attach OAuth identity to existing user with matching email
      }),
      apiKey({ collection: 'users', scopePrefix: 'kc_' }),
      magicLink({ ttl: '15m' }),
    ],
    sessionStrategy: 'session', // 'session' | 'token'
  },
})
```

| Strategy    | Audience    | Use case                          | Notes                                    |
| ----------- | ----------- | --------------------------------- | ---------------------------------------- |
| `local`     | Admin + API | Email/password login              | Default; `allowSignup` is off by default |
| `oauth`     | Admin       | SSO via GitHub, Google, OIDC      | Identity linking by verified email       |
| `apiKey`    | API         | Server-to-server, CI, build hooks | Long-lived, scoped, revocable            |
| `magicLink` | Admin       | Passwordless, low-friction teams  | Single-use, short TTL                    |

Strategies are additive. A user can hold a `local` password and a linked `oauth` identity and several `apiKey` rows simultaneously. The auth collection (any collection flagged `auth: true`, conventionally `users`) stores password hashes and verification state; OAuth identities and API keys live in adapter-managed satellite tables so the user document stays clean.

```ts
// collections/users.ts
import { defineCollection } from '@kernel/core'

export const Users = defineCollection({
  slug: 'users',
  auth: {
    strategies: ['local', 'oauth'],
    verify: true, // require verified email before login
    maxLoginAttempts: 5, // lock after N failures
    lockTime: '10m',
  },
  fields: [
    { name: 'email', type: 'email', required: true, unique: true },
    { name: 'name', type: 'text' },
    { name: 'roles', type: 'select', hasMany: true, options: ['admin', 'editor', 'viewer'] },
  ],
})
```

## Password hashing with argon2 and bcrypt

Passwords are never reversible and never logged. KernelCMS hashes with **argon2id by default** and supports **bcrypt** for compatibility with migrations from Payload or Strapi (both default to bcrypt). The hasher is an adapter, so you can pin parameters to your hardware or swap algorithms without touching application code.

```ts
import { argon2, bcrypt } from '@kernel/auth/hashing'

export default defineConfig({
  auth: {
    hashing: argon2({
      // OWASP-aligned baseline; tune memoryCost up if your hosts allow it
      memoryCost: 19456, // 19 MiB
      timeCost: 2,
      parallelism: 1,
    }),
    // hashing: bcrypt({ cost: 12 }), // for parity with an existing Payload deploy
  },
})
```

Argon2id is preferred because it resists both GPU and side-channel attacks; bcrypt remains acceptable but caps input at 72 bytes and offers no memory hardness. The hasher records which algorithm and parameters produced each hash, encoded in the standard PHC string (`$argon2id$v=19$m=19456,t=2,p=1$...`). This enables transparent rehashing.

```
Login flow with transparent rehash
───────────────────────────────────
  password + stored PHC hash
        │
        ▼
   verify(pw, hash) ──► false ──► reject (constant-time)
        │ true
        ▼
   needsRehash(hash, currentParams)?
        │
   ┌────┴────┐
  yes        no
   │          │
   ▼          ▼
 rehash &   issue
 persist    session
```

When a user authenticates against a bcrypt hash (imported from another CMS) but the active config is argon2id, KernelCMS re-hashes their password on that successful login and writes the new PHC string back. Over a migration window, your entire user base upgrades silently with zero forced resets — something neither Payload nor Strapi does out of the box. `verify` is always constant-time, and a failed lookup still runs a dummy hash to keep timing uniform and defeat user-enumeration probes.

## Sessions versus tokens

The single most important auth decision is session transport. KernelCMS supports both and lets you choose per deployment via `sessionStrategy`. The trade-off is revocation versus statelessness.

|            | Sessions (default)                     | Tokens (JWT)                    |
| ---------- | -------------------------------------- | ------------------------------- |
| Storage    | Server-side record + opaque cookie     | Stateless, signed claims        |
| Revocation | Instant (delete the row)               | Hard; needs a denylist          |
| Best for   | Admin panel, browsers                  | Edge, multi-service, mobile     |
| Cookie     | `Secure` + `HttpOnly` + `SameSite=Lax` | Same, or `Authorization` header |
| Cost       | One DB read per request                | Signature verify, no DB read    |

The admin panel defaults to **server-side sessions**. A login creates a `sessions` row keyed by a high-entropy opaque token; the browser receives it as an `HttpOnly`, `Secure`, `SameSite=Lax` cookie. TanStack Query attaches it automatically because cookies ride along with same-origin requests. Because the session is a database row, revocation is immediate — logging out, rotating, or an admin force-killing a session takes effect on the next request. This is how KernelCMS beats stateless-JWT CMS setups where a stolen token stays valid until expiry.

```ts
// In-process Local API — full type inference, no HTTP round trip
import { getKernel } from '@kernel/server'

const kernel = await getKernel()
const { user, session } = await kernel.auth.login({
  strategy: 'local',
  email: 'ada@example.com',
  password: req.body.password,
})
// session.token is opaque; set it as an HttpOnly cookie
```

For service-to-service and edge deployments, switch to **tokens**. KernelCMS issues short-lived access JWTs (verified algorithm pinned to EdDSA, `iss`/`aud`/`exp` checked) paired with rotating refresh tokens stored server-side. Refresh tokens are single-use and rotated on every exchange; reuse of a consumed refresh token is treated as theft and revokes the whole family.

```ts
// Edge runtime: stateless access token verification
import { verifyAccessToken } from '@kernel/auth/tokens'

const claims = await verifyAccessToken(req.headers.get('authorization'))
// { sub, roles, exp, iss: 'kernelcms', aud: 'api' }
```

API keys (`kc_...`) are the third path: opaque, hashed at rest with the same argon2 hasher, scoped, and revocable from the admin or via `@kernel/client`. They never expire unless you set a TTL and carry no session — each request is independently authorized.

```
Principal resolution (one path for every surface)
─────────────────────────────────────────────────
  REST / GraphQL / RPC / Local API
        │
        ▼
  cookie session ─┐
  bearer JWT  ────┼─► resolvePrincipal() ─► User + roles
  kc_ API key ────┘                          │
                                             ▼
                                   access control (op/doc/field)
```

## Email verification and reset

Email-bearing flows route through the email adapter (`@kernel/email`), so verification, reset, and magic links use whatever provider you configured — Resend, SES, SMTP — with no provider lock-in.

**Verification.** When `auth.verify` is true, signup creates the user in an unverified state and dispatches a single-use token (hashed at rest, default TTL 24h). Login is rejected with a typed `EmailNotVerifiedError` until the link is clicked. This blocks throwaway-email signups that plague open Strapi instances.

**Reset.** A reset request always returns `202 Accepted` regardless of whether the email exists — no enumeration leak. A valid request mints a single-use, short-TTL token; consuming it sets the new password (re-hashed with the active hasher) and, critically, **revokes all existing sessions and refresh-token families** so a compromised account can't keep a stolen session alive.

```ts
await kernel.auth.requestPasswordReset({ email }) // always 202
await kernel.auth.resetPassword({ token, newPassword }) // single-use, revokes sessions
await kernel.auth.verifyEmail({ token }) // single-use, flips verified flag
```

All tokens are stored hashed, are single-use, and are rate-limited per identifier and per IP. Reset and verification share one `auth_tokens` table with a `purpose` discriminator, indexed for cheap cleanup of expired rows.

## Open questions

- **WebAuthn/passkeys**: planned as a `passkey()` strategy, but the credential-storage shape and cross-device sync UX in the admin are not finalized.
- **Session storage backend**: sessions live in the primary DB by default; a pluggable cache adapter (Redis via `@kernel/cache`) for session reads is desirable but the invalidation contract on revocation needs design.
- **MFA enrollment policy**: TOTP is on the roadmap; whether MFA is enforced per-role or per-collection, and how recovery codes are surfaced, is undecided.
- **Cloud SSO**: how self-hosted OAuth config maps onto KernelCMS Cloud's managed identity provider — and whether tenants can bring their own IdP — is still being specified.
