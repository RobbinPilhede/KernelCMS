/**
 * HTTP rate limiting. A fixed-window counter per client key, with a pluggable
 * store (in-memory by default; swap in a shared store for multi-node). The
 * server applies a general limit to every request and a stricter limit to
 * auth-sensitive routes (login, password reset, verification, 2FA, OAuth).
 */

export interface RateLimitResult {
  allowed: boolean
  /** Seconds until the window resets (set when not allowed). */
  retryAfter: number
  /** Requests remaining in the current window. */
  remaining: number
}

export interface RateLimitStore {
  /** Record a hit for `key` in a `windowMs` window; return the running count and reset time. */
  hit(key: string, windowMs: number): Promise<{ count: number; resetAt: number }>
}

/** In-memory fixed-window store. Per-process; adequate for a single node. */
export function memoryRateLimitStore(): RateLimitStore {
  const windows = new Map<string, { count: number; resetAt: number }>()
  // Opportunistic sweep so the map cannot grow without bound under churn.
  let lastSweep = 0
  function sweep(now: number): void {
    if (now - lastSweep < 30_000) return
    lastSweep = now
    for (const [key, rec] of windows) if (rec.resetAt <= now) windows.delete(key)
  }
  return {
    async hit(key: string, windowMs: number) {
      const now = Date.now()
      sweep(now)
      const rec = windows.get(key)
      if (!rec || rec.resetAt <= now) {
        const fresh = { count: 1, resetAt: now + windowMs }
        windows.set(key, fresh)
        return fresh
      }
      rec.count += 1
      return rec
    },
  }
}

export interface RateLimitOptions {
  /** Master switch. Default true. */
  enabled?: boolean
  /** Window length in ms. Default 60000. */
  windowMs?: number
  /** Max requests per window per client for general traffic. Default 300. */
  max?: number
  /** Max requests per window per client for auth-sensitive routes. Default 20. */
  authMax?: number
  /** Trust `x-forwarded-for` for the client IP (only behind a trusted proxy).
   *  Default false. NOTE: this takes the *first* hop of `x-forwarded-for`, which a
   *  client can spoof if your proxy *appends* rather than *overwrites* the header.
   *  Behind a platform that sets a trusted single-value header (e.g. `x-real-ip`,
   *  `cf-connecting-ip`), prefer `clientKey` to pin to that header instead. */
  trustProxy?: boolean
  /** Resolve the client identifier (usually an IP) from the request yourself.
   *  Use this when embedding the handler behind a platform/proxy (Next.js, Vercel,
   *  Cloudflare) where the socket peer address never reaches the handler — return,
   *  e.g., `request.headers.get('x-real-ip')`. Takes precedence over `trustProxy`.
   *  Return `null`/`undefined` to fall through to the built-in resolution. Without
   *  it (and outside the bundled Node listener), every client collapses into a
   *  single shared bucket — the limiter warns once so that trap is visible. */
  clientKey?: (request: Request) => string | null | undefined
  /** Shared store (e.g. Redis-backed) for multi-node; defaults to in-memory. */
  store?: RateLimitStore
}

export interface ResolvedRateLimit {
  enabled: boolean
  windowMs: number
  max: number
  authMax: number
  trustProxy: boolean
  clientKey?: (request: Request) => string | null | undefined
  store: RateLimitStore
}

export function resolveRateLimit(opts: RateLimitOptions | undefined): ResolvedRateLimit {
  return {
    enabled: opts?.enabled ?? true,
    windowMs: opts?.windowMs ?? 60_000,
    max: opts?.max ?? 300,
    authMax: opts?.authMax ?? 20,
    trustProxy: opts?.trustProxy ?? false,
    clientKey: opts?.clientKey,
    store: opts?.store ?? memoryRateLimitStore(),
  }
}

const HEADER_REMOTE_ADDR = 'x-kernel-remote-addr'

// Warn at most once per process when the client identifier collapses to a shared
// value — otherwise rate limiting silently degrades into one global bucket.
let warnedCollapse = false

/** Best-effort client identifier. Prefers a caller-supplied resolver, then
 *  `x-forwarded-for` (only when `trustProxy`), then the socket address the bundled
 *  listener attaches. Returns `'unknown'` (shared bucket) as a last resort. */
export function clientKey(request: Request, cfg: Pick<ResolvedRateLimit, 'trustProxy' | 'clientKey'>): string {
  const custom = cfg.clientKey?.(request)
  if (custom) return custom
  if (cfg.trustProxy) {
    const fwd = request.headers.get('x-forwarded-for')
    if (fwd) return fwd.split(',')[0]!.trim()
  }
  const remote = request.headers.get(HEADER_REMOTE_ADDR)
  if (remote) return remote
  if (!warnedCollapse) {
    warnedCollapse = true
    console.warn(
      '[kernel] rate limiting cannot identify the client: no socket address is present ' +
        '(handler is embedded outside the bundled Node listener). All requests share one ' +
        'bucket. Pass rateLimit.clientKey to resolve the IP from your platform headers, or ' +
        'set rateLimit.trustProxy behind a trusted proxy that sets x-forwarded-for.',
    )
  }
  return 'unknown'
}

const AUTH_ACTIONS = new Set([
  'login',
  'forgot-password',
  'reset-password',
  'verify-email',
  'resend-verification',
  '2fa-setup',
  '2fa-enable',
  '2fa-disable',
  'oauth',
])

/** True for auth-sensitive routes that warrant the stricter limit. */
export function isAuthRoute(pathname: string, apiBase: string): boolean {
  if (!pathname.startsWith(apiBase)) return false
  const rest = pathname.slice(apiBase.length).split('/').filter(Boolean)
  // <api>/<collection>/<action> -> the action is the third segment.
  const action = rest[1]
  return action ? AUTH_ACTIONS.has(action) : false
}

/** Check (and record) a request against the appropriate window. */
export async function rateLimitCheck(
  cfg: ResolvedRateLimit,
  request: Request,
  apiBase: string,
): Promise<RateLimitResult> {
  const { pathname } = new URL(request.url)
  const auth = isAuthRoute(pathname, apiBase)
  const limit = auth ? cfg.authMax : cfg.max
  const bucket = auth ? 'auth' : 'gen'
  const key = `${bucket}:${clientKey(request, cfg)}`
  const { count, resetAt } = await cfg.store.hit(key, cfg.windowMs)
  const remaining = Math.max(0, limit - count)
  if (count > limit) {
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)), remaining: 0 }
  }
  return { allowed: true, retryAfter: 0, remaining }
}

export { HEADER_REMOTE_ADDR }
