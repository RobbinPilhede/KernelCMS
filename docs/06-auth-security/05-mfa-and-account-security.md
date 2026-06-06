# MFA & Account Security

KernelCMS treats multi-factor authentication and account hardening as first-class concerns in `@kernel/auth`, not as a plugin you bolt on later. The authentication core ships TOTP and WebAuthn enrollment, recovery codes, rate limiting with progressive lockout, and a structured audit log out of the box, all wired into the same server-side operation pipeline that powers every REST, GraphQL, and RPC surface. This document specifies how those mechanisms work, how they are configured in `kernel.config.ts`, and where the design is deliberately stricter than what Payload, Sanity, or Strapi give you by default.

## Where MFA Lives in the Stack

Account security is enforced where it cannot be bypassed: server-side, inside `@kernel/auth`, before any operation reaches a collection or global. The admin app (TanStack Start) only renders enrollment and challenge UI; it never makes the trust decision.

```
 login ──▶ password verify ──▶ MFA required? ──┬─ no ─▶ session issued
                                               │
                                               └─ yes ─▶ second-factor challenge
                                                          (TOTP | WebAuthn | recovery)
                                                              │
                                                       verified ─▶ step-up session issued
                                                              │
                                                       failed ──▶ rate limiter + audit event
```

Compare this to the field: Strapi ships no MFA in its open-source admin at all — it is a paid Enterprise feature gated behind SSO. Payload has community plugins but no canonical, type-safe MFA contract. Sanity delegates entirely to its hosted identity provider, so self-hosters get nothing. KernelCMS makes MFA part of the open-source MIT core because an admin panel that can publish to production is a credential worth protecting regardless of who hosts it.

## Configuration

MFA policy is config-as-code. You declare it once and it applies uniformly to the admin app and any authenticated API client.

```ts
// kernel.config.ts
import { defineConfig } from '@kernel/core'
import { authAdapter } from '@kernel/auth'

export default defineConfig({
  auth: authAdapter({
    mfa: {
      // 'optional' lets users self-enroll; 'required' blocks login until enrolled
      policy: 'required',
      methods: {
        totp: { issuer: 'KernelCMS', algorithm: 'SHA1', digits: 6, period: 30 },
        webauthn: {
          rpName: 'KernelCMS Admin',
          rpID: 'admin.example.com',
          userVerification: 'preferred',
          residentKey: 'required', // enables passkeys / usernameless flows
        },
      },
      recoveryCodes: { count: 10, length: 10 },
      stepUp: {
        // operations that demand a fresh second factor even mid-session
        maxAge: '15m',
        require: ['users.update', 'globals.update:security'],
      },
    },
    lockout: {
      window: '15m',
      maxAttempts: 5,
      strategy: 'exponential',
      baseDelay: '1s',
      hardLockAfter: 20,
    },
  }),
})
```

The `mfa.policy` field can also be a function evaluated per user, so you can require MFA only for users holding privileged roles while leaving read-only editors on password-only login. This mirrors how access control is evaluated at the operation level elsewhere in KernelCMS — see [Access Control](./01-authorization-and-access-control.md).

## TOTP and WebAuthn

KernelCMS supports two enrollment families. TOTP (RFC 6238) covers the universal case — Google Authenticator, 1Password, Authy — and works fully offline. WebAuthn covers hardware security keys and platform authenticators (Touch ID, Windows Hello, passkeys), giving phishing-resistant, origin-bound credentials.

| Property | TOTP | WebAuthn |
| --- | --- | --- |
| Phishing-resistant | No (shared secret) | Yes (origin-bound) |
| Offline | Yes | Platform-dependent |
| Secret storage | Encrypted secret in DB | Public key only in DB |
| Replay protection | Time window + last-used counter | Signature counter |
| Best for | Universal fallback | Primary high-trust factor |

### TOTP enrollment

Enrollment goes through the typed Local API. The server generates the secret, returns a provisioning URI for the QR code, and only commits the factor once the user proves possession with a valid code. The secret is encrypted at rest using the configured KMS key; we never store it in plaintext, and it is never exposed again after the provisioning step.

```ts
import { kernel } from '@kernel/client'

// 1. Begin enrollment — returns otpauth:// URI + QR data, persists nothing trusted yet
const { uri, factorId } = await kernel.auth.mfa.totp.begin()

// 2. User scans QR, enters a 6-digit code; server verifies before activating
await kernel.auth.mfa.totp.confirm({ factorId, code: '492013' })
```

We default to `SHA1` / 6 digits / 30s because that is the interoperable set every authenticator app supports; `SHA256` is available but breaks several popular apps, so it is opt-in. The verifier accepts a ±1 step window to tolerate clock drift and records the last-used time step to reject replays within the same window.

### WebAuthn enrollment

WebAuthn uses the standard two-call ceremony. `@kernel/auth` produces the registration options (including a server-issued challenge bound to the session), the browser invokes `navigator.credentials.create`, and the server verifies the attestation and stores only the public key and signature counter.

```ts
// admin client — TanStack Query mutation wrapping the ceremony
const options = await kernel.auth.mfa.webauthn.registerOptions()
const attestation = await startRegistration(options) // @simplewebauthn/browser
await kernel.auth.mfa.webauthn.registerVerify({ attestation })
```

With `residentKey: 'required'`, credentials are discoverable, enabling passkey-style usernameless login. The signature counter is checked on every assertion; a counter that fails to advance signals a cloned authenticator and the assertion is rejected and audited. Users may enroll multiple authenticators and name them, so losing one key never locks them out.

## Recovery Codes

Recovery codes are the break-glass path when a user loses every active factor. KernelCMS generates them once at first MFA enrollment, shows them exactly once, and stores only their hashes — using the same Argon2id parameters as password storage, never a fast hash. A code is single-use and is consumed atomically on redemption to prevent double-spend under concurrent requests.

```ts
// Returned once, in plaintext, at enrollment — never retrievable again
const { codes } = await kernel.auth.mfa.recoveryCodes.generate()
// => ['7gk2-9fa1', 'm4qz-0xv8', ...]

// Regeneration invalidates all prior codes in a single transaction
await kernel.auth.mfa.recoveryCodes.regenerate()
```

Design rules we enforce:

- **Hashed at rest.** Recovery codes are credentials. Payload's plugin ecosystem frequently stores them reversibly; we refuse to.
- **Single-use, transactional consumption.** Redemption marks the code used inside the same DB transaction that issues the session, so a replayed code in a race loses.
- **Low-water alerting.** When a user drops below two unused codes, the admin surfaces a prompt and an audit event fires.
- **Redemption is a high-signal event.** Using a recovery code always emits an audit record and can optionally trigger an email through `@kernel/auth`'s notification hook, because legitimate recovery-code use is rare and worth a human glance.

## Rate Limiting and Lockout

Every credential-checking endpoint is rate limited at the operation boundary, not at the HTTP edge alone, so the same protection applies whether the attacker hits REST, GraphQL, or RPC. Counters are keyed on a composite of identifier (account) and source (IP / fingerprint) so a single hot IP cannot lock out an entire org, and a distributed attack against one account still trips the per-account limiter.

```
attempts:  1    2    3    4    5         6 ...
delay:     0    1s   2s   4s   8s    →   hard lock (admin unlock)
                └──── exponential backoff ────┘
```

| Layer | Trigger | Effect |
| --- | --- | --- |
| Soft throttle | per-IP burst | exponential backoff delay |
| Account lockout | `maxAttempts` in `window` | temporary lock, auto-clears after window |
| Hard lock | `hardLockAfter` total failures | requires admin unlock |
| MFA challenge limiter | failed second factors | separate, stricter budget |

The MFA challenge limiter is intentionally separate from the password limiter: a correct password followed by repeated TOTP failures is a distinct threat signal and gets a tighter budget. Lockout state lives in the configured cache adapter (`@kernel/auth` reuses the cache adapter, so Redis-backed deployments get distributed counters for free across instances). This is a concrete advantage over stock Strapi, whose brute-force protection is minimal and per-instance.

```ts
// Server-side unlock operation — itself an audited, access-controlled action
await kernel.auth.admin.unlockAccount({ userId, reason: 'verified via support ticket' })
```

## Audit Logging

Every security-relevant action emits a structured, append-only audit event. The audit log is a system-managed collection in `@kernel/db`, so it is queryable through the same where/sort/pagination query language as any content, and it inherits your chosen database adapter. Events are immutable — there is no update or delete operation exposed, and access control denies writes from anything but the auth core.

```ts
interface AuditEvent {
  id: string
  type:
    | 'login.success' | 'login.failure'
    | 'mfa.enrolled' | 'mfa.challenge.success' | 'mfa.challenge.failure'
    | 'recovery.redeemed' | 'recovery.regenerated'
    | 'account.locked' | 'account.unlocked'
    | 'session.revoked'
  actorId: string | null
  ip: string
  userAgent: string
  method: 'totp' | 'webauthn' | 'recovery' | 'password' | null
  outcome: 'success' | 'failure'
  metadata: Record<string, unknown> // never contains secrets or codes
  createdAt: Date
}
```

We guarantee that audit metadata never carries a secret, recovery code, or token — values are redacted at the emit boundary, not the storage boundary, so a misconfigured sink cannot leak them. For compliance workflows the log can stream to an external SIEM via the same notification hook used for emails; see Audit Logging for retention and export.

Sanity's audit trail is hosted-only and not exportable on lower tiers; Strapi's lives behind Enterprise. KernelCMS keeps the audit log in your database, under your adapter, queryable with your tooling — consistent with the no-lock-in tenet that lets content and config move freely between self-host and KernelCMS Cloud.

## Open Questions

- **Step-up UX vs. friction.** `stepUp.require` is operation-keyed today. We have not settled whether per-field step-up (e.g. editing only the `apiKeys` field of a global) is worth the added complexity in TanStack Form binding.
- **Passkey-only accounts.** With discoverable credentials we could allow accounts with no password at all. The recovery story for a lost-only-passkey account without a fallback factor is unresolved.
- **Audit log retention defaults.** Whether the core ships a default TTL/rotation or leaves retention entirely to the deployment is still open; SIEM-streaming users want it short, compliance users want it long.
