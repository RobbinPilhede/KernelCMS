# SSO, OAuth & Social Login

KernelCMS treats federated identity as a first-class authentication strategy, not a bolt-on. The `@kernel/auth` package ships a provider model where OAuth/OIDC, SAML, and social login all resolve to the same internal identity, feed the same session machinery, and respect the same access control evaluated at the operation, document, and field level. This document specifies how providers are configured in `kernel.config.ts`, how enterprise SSO is wired, how social buttons appear in the admin and your frontend, and how a single human ends up as a single account regardless of how many credentials they bring.

## Where this fits

Federated identity is one of several strategies registered on the `auth` block. It sits alongside local password login (see [Authentication Strategies](./00-authentication.md)) and shares the session and token model documented in Sessions & Tokens. Every authenticated principal — local or federated — is subject to the rules in [Access Control](./01-authorization-and-access-control.md). Providers never get their own authorization path.

```
 ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
 │ OAuth / OIDC │   │     SAML     │   │   Social     │
 └──────┬───────┘   └──────┬───────┘   └──────┬───────┘
        │                  │                  │
        └────────┬─────────┴─────────┬────────┘
                 ▼                   ▼
          normalizeProfile    accountLinking
                 │                   │
                 └─────────┬─────────┘
                           ▼
                   @kernel/auth session
                   (cookie + typed RPC)
```

Payload exposes OAuth only through community plugins and leaves SAML to you. Strapi gates SSO behind its Enterprise tier and routes everything through `users-permissions`. Sanity hardwires login to its own SSO product. KernelCMS keeps the provider contract in the open-source core under MIT, so OIDC, SAML, and social login behave identically self-hosted and on KernelCMS Cloud.

## OAuth and OIDC

OAuth 2.0 with OpenID Connect is the default federation path. KernelCMS uses the **authorization code flow with PKCE** for every provider — no implicit flow, no client-side token handling. The redirect, state, nonce, and code-verifier are managed by TanStack Start server functions, so secrets never reach the browser.

```ts
// kernel.config.ts
import { defineConfig } from '@kernel/core'
import { oidcProvider } from '@kernel/auth'

export default defineConfig({
  auth: {
    providers: [
      oidcProvider({
        id: 'okta',
        label: 'Okta',
        issuer: 'https://acme.okta.com',          // OIDC discovery document is fetched from /.well-known
        clientId: process.env.OKTA_CLIENT_ID!,
        clientSecret: process.env.OKTA_CLIENT_SECRET!,
        scopes: ['openid', 'profile', 'email', 'groups'],
        pkce: true,
        // Map provider claims onto the KernelCMS user shape.
        profile: (claims) => ({
          email: claims.email,
          name: claims.name,
          // Drive role assignment from an IdP group claim.
          roles: mapGroupsToRoles(claims.groups),
        }),
      }),
    ],
  },
})
```

`issuer` triggers OIDC discovery: KernelCMS fetches `/.well-known/openid-configuration`, caches the JWKS, and verifies the `id_token` signature, `iss`, `aud`, `exp`, and `nonce` on every callback. For plain OAuth 2.0 providers without discovery, pass `authorizationUrl`, `tokenUrl`, and `userinfoUrl` explicitly.

The callback route is mounted automatically at `/api/auth/callback/:providerId`. You register one redirect URI per provider in the IdP and KernelCMS handles the rest.

```
Browser            KernelCMS (TanStack Start)        IdP
  │  GET /api/auth/signin/okta │                       │
  │ ─────────────────────────► │  build state+PKCE     │
  │  302 → IdP authorize       │ ─────────────────────►│
  │ ◄───────────────────────── │                       │
  │  ... user authenticates ...                        │
  │  302 → /callback/okta?code │ ─────────────────────►│ exchange code
  │ ─────────────────────────► │ ◄───────────────────── id_token + access
  │  Set-Cookie: session       │  verify + link account│
  │ ◄───────────────────────── │                       │
```

### Token handling and refresh

KernelCMS does not forward IdP access tokens to the client. After verification it mints its own session (see Sessions & Tokens). If you need the provider's access token for downstream API calls — say, to read the user's calendar — set `storeTokens: true` and KernelCMS persists the encrypted access/refresh pair against the linked account, rotating it on expiry.

```ts
oidcProvider({
  id: 'google-workspace',
  issuer: 'https://accounts.google.com',
  clientId: process.env.GOOGLE_CLIENT_ID!,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
  scopes: ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/calendar.readonly'],
  storeTokens: true,
  access: { offline: true }, // request a refresh token
})
```

## SAML for enterprise

Large customers still mandate SAML 2.0, and it is the one protocol Strapi reserves for its paid tier and Payload does not ship at all. KernelCMS provides `samlProvider` in the same `@kernel/auth` package, with no edition gate.

```ts
import { samlProvider } from '@kernel/auth'

samlProvider({
  id: 'corp-saml',
  label: 'Corporate SSO',
  // Service Provider (KernelCMS) identity
  entityId: 'https://cms.acme.com/saml/metadata',
  acsUrl: 'https://cms.acme.com/api/auth/saml/corp-saml/acs',
  // Identity Provider metadata — paste a URL or inline XML
  idp: {
    metadataUrl: process.env.SAML_IDP_METADATA_URL!,
  },
  // SP signing/encryption keys
  signing: {
    cert: process.env.SAML_SP_CERT!,
    key: process.env.SAML_SP_KEY!,
  },
  wantAssertionsSigned: true,
  wantAuthnResponseSigned: true,
  // Map SAML attributes to the user shape.
  profile: (assertion) => ({
    email: assertion.attributes['email'],
    name: assertion.attributes['displayName'],
    roles: mapGroupsToRoles(assertion.attributes['memberOf']),
  }),
})
```

KernelCMS implements the **SP-initiated POST binding** for the AuthnRequest and the **HTTP-POST binding** for the assertion response. It validates the response signature against the IdP certificate from metadata, checks `Conditions/NotBefore` and `NotOnOrAfter`, enforces a one-time-use `InResponseTo`/`ID` to block replay, and rejects unsigned assertions when `wantAssertionsSigned` is true.

A machine-readable SP metadata document is served at `/api/auth/saml/:providerId/metadata` so the IdP admin can configure the connection by URL rather than by hand.

| Concern | OIDC | SAML 2.0 |
| --- | --- | --- |
| Token format | JWT (`id_token`) | XML assertion |
| Discovery | `.well-known` + JWKS | IdP metadata XML |
| Signature | JWS over JWT | XML-DSig over assertion |
| Replay defense | `nonce` + `exp` | `ID`/`InResponseTo` + `NotOnOrAfter` |
| Initiated by | SP (code flow) | SP-initiated POST |
| Logout | RP-initiated / front-channel | SLO (`LogoutRequest`/`LogoutResponse`) |

Single Logout (SLO) is opt-in via `slo: true`. When enabled, signing out of KernelCMS issues a `LogoutRequest` to the IdP, and inbound `LogoutRequest` messages terminate the local session.

## Social providers

Social login is OAuth/OIDC with provider-specific quirks pre-baked. Rather than make you hand-roll Google, GitHub, GitLab, Microsoft, or Apple, `@kernel/auth` ships thin presets that set the correct endpoints, default scopes, and claim mappings.

```ts
import { google, github, microsoft } from '@kernel/auth/social'

export default defineConfig({
  auth: {
    providers: [
      google({ clientId: env.GOOGLE_ID, clientSecret: env.GOOGLE_SECRET }),
      github({ clientId: env.GH_ID, clientSecret: env.GH_SECRET }),
      microsoft({
        clientId: env.MS_ID,
        clientSecret: env.MS_SECRET,
        tenant: 'common', // or a specific Entra tenant id
      }),
    ],
  },
})
```

Each preset is a `oidcProvider`/`oauthProvider` under the hood, so anything you can override on the base provider — `scopes`, `profile`, `access`, `storeTokens` — works on a social preset too. GitHub, which is not a true OIDC provider, ships with a custom `userinfo` resolver that also pulls the user's primary verified email from `/user/emails`.

The admin login screen renders a button per provider in config order, respecting your design tokens and white-label theme. On your public frontend, drive the same flow with `@kernel/client`:

```ts
import { createAuthClient } from '@kernel/client'

const auth = createAuthClient({ baseURL: '/api' })

// kicks off the redirect; PKCE/state handled server-side
await auth.signIn.social({ provider: 'github', callbackURL: '/dashboard' })
```

### Restricting who gets in

Federated authentication is not authorization. Use the `signIn` hook to reject identities that authenticated successfully but should not have an account — for example, anyone outside your verified domain.

```ts
auth: {
  hooks: {
    signIn: async ({ profile, provider }) => {
      if (provider === 'google' && !profile.email?.endsWith('@acme.com')) {
        return { allow: false, reason: 'domain_not_allowed' }
      }
      return { allow: true }
    },
  },
}
```

## Account linking

A single human authenticating through Okta on Monday and GitHub on Tuesday must resolve to **one** KernelCMS user, or you fragment content ownership and audit trails. KernelCMS models this with a `users` collection and a related `accounts` collection — one user, many linked external identities.

```
users (1) ───< accounts (N)
  id            id
  email         userId
  name          provider     ("github" | "okta" | "corp-saml")
  roles         providerAccountId
                accessToken?  (encrypted)
                refreshToken? (encrypted)
```

The default linking strategy is **verified-email matching**: when a federated profile arrives, KernelCMS looks for an existing user whose email matches *and* where the incoming provider asserts the email is verified. If both hold, it attaches a new `accounts` row to that user. If no user matches, it provisions one.

```ts
auth: {
  accountLinking: {
    strategy: 'verified-email',   // 'verified-email' | 'manual' | 'never'
    trustedProviders: ['okta', 'corp-saml'], // skip extra verification for IdPs you control
  },
}
```

| Strategy | Behavior | Use when |
| --- | --- | --- |
| `verified-email` | Auto-link if emails match and provider verified it | Default; balances UX and safety |
| `manual` | New identities stay unlinked until the signed-in user confirms in account settings | High-security tenants |
| `never` | Every provider account is a distinct user | Strict isolation |

The `manual` flow exists because automatic linking on an *unverified* email is an account-takeover vector: an attacker registers an OAuth app, sets the email to your victim's, and inherits their account. KernelCMS refuses to link on unverified email regardless of strategy unless the provider is in `trustedProviders`. This is the trap Strapi's `users-permissions` historically fell into; KernelCMS closes it by default.

Authenticated users link additional providers from account settings, which calls a typed RPC server function:

```ts
// From the admin, while already signed in
await auth.linkAccount({ provider: 'gitlab', callbackURL: '/account/security' })
```

Unlinking is symmetric, with one guard: KernelCMS blocks removal of a user's last remaining credential, so nobody can accidentally lock themselves out of an account that has no password and no other linked identity.

## Open questions

- **SCIM provisioning.** SSO covers authentication; enterprises also want automated user lifecycle (deprovisioning on offboard). Whether SCIM 2.0 lands in `@kernel/auth` core or as a `@kernel/plugin-*` add-on is undecided.
- **Group/role sync cadence.** Roles can be derived from IdP claims at login, but should KernelCMS re-evaluate `roles` on every session refresh, or only at sign-in? Continuous sync is safer but couples session liveness to IdP availability.
- **SAML in edge runtimes.** XML-DSig validation has heavier crypto dependencies than JWT verification. Confirming the SAML path runs unmodified on edge runtimes, or fencing it to Node/Bun hosts, is still open.
