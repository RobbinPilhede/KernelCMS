/**
 * OAuth sign-in is an *adapter*: a provider exposes an authorization URL and a
 * code→profile exchange, both `fetch`-based (no SDK), so `@kernel/core` stays
 * dependency-free. Wire providers via `config.oauth` and complete sign-in with
 * `kernel.loginWithOAuth`.
 */

export interface OAuthProfile {
  /** Stable provider-side id. */
  id: string
  email: string
  /** Whether the provider has verified the email belongs to this account.
   *  When false/undefined, `loginWithOAuth` will not link to an existing user. */
  emailVerified?: boolean
  name?: string
}

export interface OAuthProvider {
  /** Stable name used in routes and `loginWithOAuth({ provider })`. */
  name: string
  authorizationUrl(opts: { redirectUri: string; state: string }): string
  exchangeCode(opts: { code: string; redirectUri: string }): Promise<OAuthProfile>
}

/** Build a standard authorization-code provider from its endpoints. */
export function oauthProvider(cfg: {
  name: string
  authorizationEndpoint: string
  tokenEndpoint: string
  clientId: string
  clientSecret: string
  scope: string
  /** Fetch the user profile given an access token. */
  profile: (accessToken: string) => Promise<OAuthProfile>
}): OAuthProvider {
  return {
    name: cfg.name,
    authorizationUrl({ redirectUri, state }) {
      const params = new URLSearchParams({
        client_id: cfg.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: cfg.scope,
        state,
      })
      return `${cfg.authorizationEndpoint}?${params.toString()}`
    },
    async exchangeCode({ code, redirectUri }) {
      const res = await fetch(cfg.tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
        }).toString(),
      })
      if (!res.ok) throw new Error(`OAuth token exchange failed (${res.status}).`)
      const token = (await res.json()) as { access_token?: string }
      if (!token.access_token) throw new Error('OAuth token exchange returned no access_token.')
      return cfg.profile(token.access_token)
    },
  }
}

/** Google OAuth 2.0 preset. */
export function googleOAuth(opts: { clientId: string; clientSecret: string }): OAuthProvider {
  return oauthProvider({
    name: 'google',
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
    scope: 'openid email profile',
    async profile(accessToken) {
      const res = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { authorization: `Bearer ${accessToken}` },
      })
      if (!res.ok) throw new Error(`Google userinfo failed (${res.status}).`)
      const u = (await res.json()) as { sub: string; email: string; email_verified?: boolean | string; name?: string }
      // Google returns email_verified as a boolean (or the string "true").
      const verified = u.email_verified === true || u.email_verified === 'true'
      return { id: u.sub, email: u.email, emailVerified: verified, name: u.name }
    },
  })
}

/** GitHub OAuth preset. */
export function githubOAuth(opts: { clientId: string; clientSecret: string }): OAuthProvider {
  return oauthProvider({
    name: 'github',
    authorizationEndpoint: 'https://github.com/login/oauth/authorize',
    tokenEndpoint: 'https://github.com/login/oauth/access_token',
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
    scope: 'read:user user:email',
    async profile(accessToken) {
      const headers = { authorization: `Bearer ${accessToken}`, accept: 'application/json' }
      const res = await fetch('https://api.github.com/user', { headers })
      if (!res.ok) throw new Error(`GitHub user fetch failed (${res.status}).`)
      const u = (await res.json()) as { id: number; email: string | null; name?: string; login: string }
      // The /user email can be unverified or hidden. Resolve the verified primary
      // address from /user/emails so we never trust an attacker-set unverified email.
      let email = u.email ?? `${u.login}@users.noreply.github.com`
      let emailVerified = false
      try {
        const emailsRes = await fetch('https://api.github.com/user/emails', { headers })
        if (emailsRes.ok) {
          const emails = (await emailsRes.json()) as { email: string; primary: boolean; verified: boolean }[]
          const primary = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified)
          if (primary) {
            email = primary.email
            emailVerified = true
          }
        }
      } catch {
        emailVerified = false
      }
      return { id: String(u.id), email, emailVerified, name: u.name ?? u.login }
    },
  })
}
