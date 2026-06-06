# Sessions, JWT & API Keys

KernelCMS supports three credential types, each tuned to a distinct caller. Session cookies authenticate humans in the admin panel. JWTs authenticate short-lived programmatic requests where a stateless bearer token is convenient. API keys authenticate long-lived machine integrations — build pipelines, server-to-server fetches, webhooks. All three resolve to the same `Identity` object that [Access Control](./01-authorization-and-access-control.md) evaluates at the operation, document, and field level, so the rest of the system never branches on _how_ a request authenticated. This document specifies how each credential is minted, transported, validated, rotated, and revoked.

## The shared identity contract

Every credential, regardless of type, is exchanged for an `Identity` before any access rule runs. The resolver is an adapter (see Auth Adapters); the contract below is what the rest of `@kernel/server` consumes.

```ts
// @kernel/auth
export interface Identity {
  type: 'session' | 'jwt' | 'api-key'
  user: { id: string; collection: string } | null // null for anonymous + pure API-key callers
  scopes: ReadonlyArray<Scope> // empty for full-user identities (governed by access control instead)
  tokenId: string | null // jti / session id / key id — used for revocation
  expiresAt: Date | null
  raw: unknown // adapter-specific payload, never trusted by core
}
```

The split matters: a logged-in editor carries `scopes: []` and is governed entirely by access-control functions, while an API key carries explicit `scopes` _and_ may resolve to a service user. KernelCMS does not let a token's claims silently expand a user's permissions — scopes can only narrow, never widen, what the underlying user could already do.

## Session cookies

The admin panel is a TanStack Start app, so authentication state lives in an `httpOnly` cookie set by a server function — never in `localStorage` and never in a JWT readable by client JS. This is the same posture Payload took after its early-v1 JWT-in-localStorage approach; we start here rather than migrate to it.

### Cookie attributes

```ts
// kernel.config.ts
export default defineConfig({
  auth: {
    session: {
      cookieName: 'kernel-session',
      ttl: '7d', // absolute lifetime
      rolling: true, // sliding expiry on activity
      rollingWindow: '30m', // only re-issue if <30m of TTL was consumed
      cookie: {
        secure: true, // forced true in production regardless of this value
        httpOnly: true, // always on — not configurable
        sameSite: 'lax', // "lax" default; "strict" if no cross-site OAuth callback
        path: '/',
        domain: undefined, // host-only by default; set for subdomain sharing
      },
    },
  },
})
```

Hard rules enforced by `@kernel/auth` regardless of config:

| Attribute        | Value                                   | Why it cannot be weakened                                   |
| ---------------- | --------------------------------------- | ----------------------------------------------------------- |
| `HttpOnly`       | always `true`                           | Defeats token theft via XSS                                 |
| `Secure`         | `true` in production                    | No session cookies over plaintext HTTP, ever                |
| `SameSite`       | `Lax` minimum                           | Blocks the bulk of CSRF; `None` is rejected unless `Secure` |
| `__Host-` prefix | applied when `path:"/"` and no `domain` | Browser-enforced binding to origin                          |

`SameSite=Lax` covers state-changing requests because mutations go through TanStack Start server functions (POST), which Lax does not auto-send cross-site. For defense in depth we still issue a double-submit CSRF token on the admin origin; see [Access Control](./01-authorization-and-access-control.md). Sanity sidesteps CSRF by using bearer tokens against a separate API origin; our admin and API can share an origin, so cookie hardening plus CSRF tokens is the correct trade.

### Session storage and the rolling window

Sessions are stateful. The cookie carries an opaque, random 256-bit session id — not a JWT — and the server looks it up in the configured session store (the cache adapter by default, Postgres if you want durability across cache flushes).

```
Browser                     @kernel/server                  Session store
  | --- POST /login ------->  verify password
  |                           create session row ----------> { sid, userId, exp }
  | <-- Set-Cookie: sid ----  (HttpOnly, Secure, Lax)
  | --- GET /admin/... ---->  lookup sid -------------------> hit
  |                           if rolling && exp-now<window:
  | <-- Set-Cookie: sid ----  refresh exp
```

Opaque session ids give us instant server-side revocation, which a stateless JWT cannot. Strapi's admin uses a JWT and therefore cannot truly revoke a session before expiry without a denylist; KernelCMS revokes by deleting one store row.

## JWT handling

JWTs exist for programmatic callers that want a stateless bearer token — typically a service exchanging an API key or OAuth grant for a short-lived access token, or a frontend using [TanStack DB](../05-api/03-typed-rpc-and-local-api.md) live queries. They are **not** used for admin sessions.

### Algorithm and claims policy

```ts
auth: {
  jwt: {
    alg: "EdDSA",                 // Ed25519; HS256 allowed only for single-process dev
    issuer: "https://cms.acme.com",
    audience: "kernel-api",
    accessTtl: "15m",
    keyRotation: { activeKid: "2026-05", graceKids: ["2026-04"] },
  },
}
```

Validation in `@kernel/auth` is strict and non-negotiable:

- **Algorithm is pinned** to the configured `alg`. The `alg` header from the token is _ignored for selection_ — we look up the key by `kid` and verify with the configured algorithm. This kills the `alg: none` and RS/HS confusion attacks that have repeatedly bitten naive JWT setups.
- `exp`, `nbf`, `iss`, `aud` are all checked. A token missing any required claim is rejected.
- `jti` is mandatory so individual tokens can be denylisted (see Revocation).
- Clock skew tolerance is fixed at 60s.

```ts
// @kernel/auth — conceptual verify path
const header = decodeProtectedHeader(token)
const key = keyring.get(header.kid) // unknown kid -> reject
if (!key) throw new InvalidTokenError('unknown kid')
const { payload } = await jwtVerify(token, key, {
  algorithms: [config.jwt.alg], // pinned, not header-derived
  issuer: config.jwt.issuer,
  audience: config.jwt.audience,
  clockTolerance: 60,
})
if (await denylist.has(payload.jti)) throw new RevokedTokenError()
```

### Why short TTLs plus a denylist

We keep access-token TTL at 15 minutes precisely so the stateless validation path stays fast (no store lookup on the happy path) while the blast radius of a leaked token is bounded. Refresh tokens, where used, are opaque and stored server-side exactly like sessions — long-lived secrets are never stateless. This is the inverse of Strapi's default long-lived admin JWT, and a deliberate one.

## API keys and scopes

API keys are the credential for machine integrations: a Next.js ISR build fetching published content, a webhook receiver, a migration script. Unlike JWTs they are long-lived and human-managed, so the security model leans on **scoping, hashing, and per-key revocation** rather than short expiry.

### Format and storage

A key is shown **once** at creation and never again. We store only a hash.

```
kbk_live_8f2c....e91a
└┬┘ └┬─┘ └────┬────┘
 │   │        └── 256 bits of CSPRNG entropy, base62
 │   └── environment segment: live | test
 └── fixed prefix so secret scanners (GitHub, gitleaks) can detect leaks
```

```ts
// @kernel/auth — creation
const secret = `kbk_${env}_${base62(randomBytes(32))}`
await db.insert(apiKeys).values({
  id,
  name,
  hash: await argon2id(secret), // never store the raw key
  scopes,
  collections, // optional resource narrowing
  lastFourChars: secret.slice(-4),
  expiresAt, // optional; null = non-expiring
  createdBy: actor.id,
})
return { id, secret } // caller's only chance to copy it
```

We hash with argon2id, not a fast hash, even though the entropy is high — it costs nothing on the rare creation path and makes a stolen database table useless. Payload's API keys are encrypted (reversible) so they can be displayed in the admin; KernelCMS deliberately uses one-way hashing and shows the key once, because a CMS admin panel should never be able to surface a live credential.

### Scopes

Scopes are the mechanism that makes a long-lived key safe. A scope is `action:resource`, optionally constrained to named collections/globals.

```ts
auth: {
  apiKeys: {
    scopes: {
      "read:content":   "GET on any collection/global REST + GraphQL query",
      "write:content":  "create/update/delete documents",
      "read:media":     "download from @kernel/storage",
      "publish:content":"transition drafts to published",
      "admin:full":     "equivalent to a user identity (discouraged)",
    },
  },
}
```

The transport is a bearer header, distinguished from JWTs by prefix:

```
Authorization: Bearer kbk_live_8f2c....e91a
```

Resolution: hash the presented secret, look up the row, and build an `Identity` whose `scopes` are the _intersection_ of the key's scopes and what the key's `createdBy` user is allowed to do today. If the creating user lost a permission, every key they minted loses it too — keys never outlive their grantor's authority. This is stricter than Strapi's API tokens, which carry a standalone permission set decoupled from any user.

## Rotation and revocation

```
                 ┌──────────── credential lifecycle ────────────┐
   create ──▶ active ──▶ (rotate: new active + grace overlap) ──▶ retired
                │                                                   ▲
                └──── revoke (immediate) ───────────────────────────┘
```

### JWT signing-key rotation

Signing keys rotate on a schedule via overlapping `kid`s. The `activeKid` signs new tokens; `graceKids` still verify until every token signed under them has expired (active TTL + skew). This is zero-downtime: no in-flight token is ever invalidated by a rotation.

```ts
// kernel rotate-keys --grace 15m
keyring.promote('2026-06') // new active kid
keyring.retire('2026-04', { after: '16m' }) // drop once max TTL elapsed
```

### API-key rotation

Keys are rotated by issuing a replacement and deprecating the old one with a grace window, so a deploy can swap the secret without a hard cutover.

```ts
// @kernel/client / kernel CLI
const next = await kernel.apiKeys.rotate(keyId, { grace: '24h' })
// old key: revokeAt = now + 24h; new key active immediately
```

### Revocation

| Credential | Revoke mechanism                                     | Latency                          |
| ---------- | ---------------------------------------------------- | -------------------------------- |
| Session    | delete session-store row                             | next request                     |
| JWT        | add `jti` to denylist (TTL = token's remaining life) | next request, denylist cache TTL |
| API key    | flip `revokedAt` on the row                          | next request                     |

The JWT denylist is the one place we accept eventual consistency: entries self-expire at the token's `exp`, so the denylist never grows unbounded, and the only window of exposure equals the cache propagation delay (single-digit seconds across nodes). For sessions and API keys, revocation is strongly consistent because both already hit a store on every request.

A `auth.revokeAllForUser(userId)` operation cascades across all three: it deletes the user's sessions, denylists any outstanding JWT `jti`s tied to the user, and marks their API keys revoked — the action a "log out everywhere" button or a compromised-account incident triggers. This is exposed over the typed [RPC/Local API](../05-api/03-typed-rpc-and-local-api.md) and audit-logged.

## Open questions

- **Refresh-token rotation reuse detection.** Should a replayed (already-rotated) refresh token revoke the entire family immediately, or just reject? Leaning toward family revocation, pending false-positive analysis on flaky-network clients.
- **API-key IP allowlists.** Worth offering per-key CIDR pinning as a Cloud-tier feature, or does it create more support load than security value for self-hosters?
- **Passkeys for admin sessions.** WebAuthn would let us drop password storage entirely for the admin panel; the open question is the recovery-flow UX, not the cryptography.
