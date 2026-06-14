/**
 * @kernel/server — a web-standard (Request -> Response) handler that exposes the
 * Kernel Local API over REST, plus a Node http adapter. The fetch handler is the
 * exact shape a TanStack Start server route / server function wraps.
 */
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { AuthUser, Kernel, Row, Where } from '@kernel/core'
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  PayloadTooLargeError,
  UnauthorizedError,
  createLogger,
  describeConfig,
  connectorStatus,
  isKernelError,
  matchEndpoint,
  invokeEndpoint,
  renderErrorMessage,
  setupRuntime,
  pkceVerifier,
  pkceChallenge,
  cacheTagsHeader,
  verifyAssetUrl,
  KERNEL_VERSION,
} from '@kernel/core'
import type { AgentConfig, AuditDoc, Doc, EndpointConfig, RequestContext, RoleDef } from '@kernel/core'
import { createGraphQL } from '@kernel/graphql'
import { buildOpenApiSpec, scalarHtml } from './openapi'
import {
  HEADER_REMOTE_ADDR,
  rateLimitCheck,
  resolveRateLimit,
  type RateLimitOptions,
  type ResolvedRateLimit,
} from './rate-limit'
import { ADMIN_HTML } from './admin-assets.generated'

// One generated GraphQL executor per kernel, built lazily on first use.
const gqlExecutors = new WeakMap<Kernel, ReturnType<typeof createGraphQL>>()
function graphqlExecutor(kernel: Kernel): ReturnType<typeof createGraphQL> {
  let exec = gqlExecutors.get(kernel)
  if (!exec) {
    exec = createGraphQL(kernel)
    gqlExecutors.set(kernel, exec)
  }
  return exec
}

export interface HandlerOptions {
  /** Shared secret; a request with `Authorization: Bearer <apiKey>` runs as a trusted system caller. */
  apiKey?: string
  /** Resolve the authenticated user for a request (sessions, JWT, etc.). */
  getUser?: (request: Request) => Promise<AuthUser | null> | AuthUser | null
  /** CORS: true reflects the request origin; an array allow-lists origins. */
  cors?: boolean | string[]
  /**
   * Serve the built-in admin UI. `true` mounts it at `/admin` (and `/login`);
   * pass `{ path }` to change the base, and `{ scripts }` to inject extra
   * `<script src>` tags into the shell — the override hook for custom field
   * components, which register themselves on `window.KernelCMS.fields`. Disabled
   * when omitted.
   */
  admin?: boolean | { path?: string; scripts?: string[] }
  /** Allow UNAUTHENTICATED `POST /api/_analytics/track` calls (e.g. a public site tracking
   *  page views). Default false: tracking then requires an authenticated principal. Even
   *  when true, `track` can ONLY ever write the `_analytics` table (never a content
   *  collection) and NO PII is stored — the request principal is never recorded. */
  publicTrack?: boolean
  /** Expose a generated GraphQL endpoint at `<api>/graphql` (POST). */
  graphql?: boolean
  /** Serve an OpenAPI spec at `<api>/openapi` and a Scalar API reference at
   *  `<api>/docs`. Defaults to true. */
  openapi?: boolean
  /** HTTP rate limiting. Enabled by default with conservative limits; pass
   *  `{ enabled: false }` to disable, or tune `windowMs`/`max`/`authMax`. Set
   *  `trustProxy: true` only behind a trusted proxy that sets `x-forwarded-for`. */
  rateLimit?: RateLimitOptions
  /**
   * Issue the session token as an `HttpOnly` cookie on login/setup (and accept it
   * from that cookie on later requests), so the admin never keeps the token in
   * `localStorage` — closing the XSS token-theft vector. The token is still
   * returned in the login response and `Authorization: Bearer` keeps working for
   * API clients. CSRF is mitigated by `SameSite=Lax` plus a same-origin check on
   * cookie-authenticated unsafe requests. Default true; set false to opt out.
   */
  cookieAuth?: boolean
}

/** The auth collection the admin UI logs into: configured admin.user, else the first auth collection. */
export function authCollectionSlug(kernel: Kernel): string | null {
  const configured = kernel.config.admin?.user
  if (configured && kernel.config.collectionsBySlug[configured]?.auth) return configured
  const found = kernel.config.collections.find((c) => c.auth)
  return found ? found.slug : null
}

function adminBaseOf(options: HandlerOptions): string | null {
  if (!options.admin) return null
  if (options.admin === true) return '/admin'
  return options.admin.path ?? '/admin'
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } })
}

/** Inject project-supplied `<script src>` tags before `</body>` so custom field
 *  components can register on `window.KernelCMS` before the admin app boots. */
function adminShell(options: HandlerOptions): string {
  const scripts = typeof options.admin === 'object' ? (options.admin.scripts ?? []) : []
  if (scripts.length === 0) return ADMIN_HTML
  const escAttr = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const tags = scripts.map((src) => `<script src="${escAttr(src)}" type="module"></script>`).join('')
  return ADMIN_HTML.includes('</body>') ? ADMIN_HTML.replace('</body>', `${tags}</body>`) : ADMIN_HTML + tags
}

/** sha256-base64 CSP source tokens for every inline `<script>` in the admin shell.
 *  Computed once from the built HTML so the policy allows exactly those scripts
 *  without `'unsafe-inline'`/`'unsafe-eval'` (the bundle uses neither eval nor
 *  `new Function`). External `<script src>` blocks carry no body and are covered
 *  by `'self'` / their origin instead. */
const ADMIN_SCRIPT_HASHES: string[] = (() => {
  const out: string[] = []
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(ADMIN_HTML))) {
    const body = m[1] ?? ''
    if (!body.trim()) continue
    out.push(`'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`)
  }
  return out
})()

/** Same-origin custom scripts are covered by `'self'`; absolute URLs need their
 *  origin allow-listed in `script-src` so injected field components still load. */
function extraScriptOrigins(options: HandlerOptions): string[] {
  const scripts = typeof options.admin === 'object' ? (options.admin.scripts ?? []) : []
  const origins = new Set<string>()
  for (const src of scripts) {
    try {
      origins.add(new URL(src).origin)
    } catch {
      // Relative URL — same-origin, already covered by 'self'.
    }
  }
  return [...origins]
}

/**
 * Content-Security-Policy for the admin HTML shell. `script-src` is locked to
 * `'self'` plus the inline bundle's hash (XSS defense-in-depth — no inline/eval).
 * `style-src` keeps `'unsafe-inline'` (the inlined stylesheet + runtime style
 * injection; far lower risk than scripts) and allows the Google Fonts stylesheet.
 * No `default-src` is set, so images, API (`connect`), and the live-preview
 * iframe (`frame-src`) stay unrestricted and keep working across origins.
 */
function adminCsp(options: HandlerOptions): string {
  const scriptSrc = ["'self'", ...ADMIN_SCRIPT_HASHES, ...extraScriptOrigins(options)].join(' ')
  return [
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    // The admin can only be framed by its own origin (live preview iframe), never
    // by a third party (clickjacking); plugin <base>/<object> tricks are blocked.
    "frame-ancestors 'self'",
    "object-src 'none'",
    "base-uri 'self'",
  ].join('; ')
}

// Env keys the first-run setup is allowed to write — the connector settings only.
const ALLOWED_ENV_KEYS = new Set([
  'DATABASE_URL',
  'MYSQL_URL',
  'MONGODB_URI',
  'REDIS_URL',
  'KERNEL_SECRET',
  'S3_BUCKET',
  'AWS_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'R2_ENDPOINT',
  'R2_PUBLIC_BASE_URL',
  'EMAIL_API_KEY',
  'EMAIL_FROM',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
])

/** Merge whitelisted, single-line key/values into the project's .env, preserving
 *  existing lines and comments. Returns the keys actually written. */
function writeEnvFile(values: Record<string, unknown>): string[] {
  const path = resolve(process.cwd(), '.env')
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : []
  const written: string[] = []
  for (const [key, raw] of Object.entries(values)) {
    if (!ALLOWED_ENV_KEYS.has(key)) throw new BadRequestError(`Env key "${key}" is not allowed.`)
    const value = String(raw ?? '')
    if (value === '') continue
    if (/[\r\n]/.test(value)) throw new BadRequestError(`Env value for "${key}" must be a single line.`)
    const line = `${key}=${value}`
    const idx = lines.findIndex((l) => l.startsWith(`${key}=`))
    if (idx >= 0) lines[idx] = line
    else lines.push(line)
    written.push(key)
  }
  // Normalize to a single trailing newline.
  writeFileSync(path, `${lines.join('\n').replace(/\n+$/, '')}\n`)
  return written
}

const OAUTH_STATE_COOKIE = 'kernel_oauth_state'

/** Read a single cookie value from the request's Cookie header. */
function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return null
}

/** Constant-time string comparison that never short-circuits on length. */
function timingEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/**
 * Resolve a presented bearer token to a configured agent, comparing every candidate
 * with a constant-time check and never short-circuiting on the first match — so the
 * response can't reveal which agent (if any) a token belongs to. Returns the matched
 * agent or null.
 */
function matchAgent(agents: readonly AgentConfig[], token: string): AgentConfig | null {
  let found: AgentConfig | null = null
  for (const agent of agents) {
    if (timingEqual(token, agent.token) && !found) found = agent
  }
  return found
}

/** A web-standard request handler: the value returned by `createRequestHandler`. */
export type RequestHandler = (request: Request) => Promise<Response>

export function createRequestHandler(kernel: Kernel, options: HandlerOptions = {}): RequestHandler {
  const apiBase = kernel.config.routes.api
  const adminBase = adminBaseOf(options)
  const rateLimit: ResolvedRateLimit = resolveRateLimit(options.rateLimit)
  const finish = (response: Response, request: Request): Response =>
    withSecurityHeaders(withCors(response, options, request))
  return async function handle(request: Request): Promise<Response> {
    if (request.method === 'OPTIONS') return finish(new Response(null, { status: 204 }), request)

    // Rate limit before any work. The admin HTML shell and static file delivery
    // are cheap and same-origin, so the general limit covers them too; auth
    // routes get a much stricter budget. 429 carries Retry-After.
    if (rateLimit.enabled) {
      const verdict = await rateLimitCheck(rateLimit, request, apiBase)
      if (!verdict.allowed) {
        const res = json({ error: { code: 'TOO_MANY_REQUESTS', message: 'Too many requests.' } }, 429)
        res.headers.set('retry-after', String(verdict.retryAfter))
        return finish(res, request)
      }
    }

    // Built-in admin UI (same-origin HTML shell). The SPA decides setup/login/
    // dashboard from auth state, so every admin path returns the same document.
    if (adminBase && request.method === 'GET') {
      const { pathname } = new URL(request.url)
      if (pathname === '/login' || pathname === adminBase || pathname.startsWith(adminBase + '/')) {
        const shell = html(adminShell(options))
        shell.headers.set('content-security-policy', adminCsp(options))
        return finish(shell, request)
      }
    }

    // Local-disk delivery: stream stored bytes from the adapter's servePath.
    const fileResponse = await maybeServeFile(kernel, options, request)
    if (fileResponse) return finish(fileResponse, request)

    try {
      const response = await route(kernel, options, request, apiBase)
      return finish(response, request)
    } catch (err) {
      return finish(errorResponse(err, request), request)
    }
  }
}

// The admin session cookie. HttpOnly so JS (and thus XSS) can never read it.
const SESSION_COOKIE = 'kernel_token'

/** True when the request reached us over TLS (directly or via a trusted proxy),
 *  so the `Secure` cookie attribute is safe to set without breaking http://localhost. */
function isHttps(request: Request): boolean {
  const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
  if (proto) return proto === 'https'
  try {
    return new URL(request.url).protocol === 'https:'
  } catch {
    return false
  }
}

/** Build the Set-Cookie value for the session (`maxAgeSec <= 0` clears it). */
function sessionCookie(token: string, request: Request, apiBase: string, maxAgeSec: number): string {
  const attrs = [
    `${SESSION_COOKIE}=${maxAgeSec > 0 ? encodeURIComponent(token) : ''}`,
    'HttpOnly',
    'SameSite=Lax',
    `Path=${apiBase || '/'}`,
    `Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`,
  ]
  // Secure only over HTTPS, so local http dev still receives the cookie.
  if (isHttps(request)) attrs.push('Secure')
  return attrs.join('; ')
}

/** Attach the session cookie to a login/setup response when cookie auth is on. */
function attachSessionCookie(
  res: Response,
  result: { token: string; exp?: number },
  options: HandlerOptions,
  request: Request,
  apiBase: string,
): Response {
  if (options.cookieAuth === false) return res
  const nowSec = Math.floor(Date.now() / 1000)
  const maxAge = typeof result.exp === 'number' ? result.exp - nowSec : 3600
  res.headers.append('set-cookie', sessionCookie(result.token, request, apiBase, maxAge))
  return res
}

/** Baseline hardening headers applied to every response. */
function withSecurityHeaders(response: Response): Response {
  if (!response.headers.has('x-content-type-options')) response.headers.set('x-content-type-options', 'nosniff')
  // SAMEORIGIN (not DENY) so the admin's same-origin live-preview iframe still works.
  response.headers.set('x-frame-options', 'SAMEORIGIN')
  response.headers.set('referrer-policy', 'no-referrer')
  // HSTS is honoured only over HTTPS (browsers ignore it on plain HTTP), so it is
  // safe to always emit; it pins TLS for two years once seen over https.
  if (!response.headers.has('strict-transport-security')) {
    response.headers.set('strict-transport-security', 'max-age=63072000; includeSubDomains')
  }
  // Drop powerful features by default; the admin never needs them.
  if (!response.headers.has('permissions-policy')) {
    response.headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=(), browsing-topics=()')
  }
  return response
}

const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
}

// Content types safe to render inline. Notably excludes image/svg+xml: SVG is an
// active document (can carry <script>) and must never be served inline same-origin.
const INLINE_CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/**
 * Serve a stored object when the request targets the storage adapter's servePath.
 * Delivery is proxy-mode: the owning collection's `read` access is re-evaluated
 * per request by looking the document up through the normal access pipeline, so
 * private media stays private even when the URL is known.
 */
async function maybeServeFile(kernel: Kernel, options: HandlerOptions, request: Request): Promise<Response | null> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null
  const adapters = collectAdapters(kernel)
  const url = new URL(request.url)
  const { pathname } = url
  for (const adapter of adapters) {
    const base = adapter.servePath
    if (!base || base.includes('://')) continue
    const prefix = base.endsWith('/') ? base : base + '/'
    if (!pathname.startsWith(prefix)) continue
    const key = decodeURIComponent(pathname.slice(prefix.length))

    // The key is prefixed with the owning collection's slug (see generateKey).
    const slug = key.split('/')[0] ?? ''
    const collection = kernel.config.collectionsBySlug[slug]
    if (!collection?.upload) return new Response('Not found', { status: 404 })

    let allowed = false
    const exp = url.searchParams.get('exp')
    const sig = url.searchParams.get('sig')
    if (sig != null || exp != null) {
      // A signed capability URL: the HMAC over (key, exp) IS the authorization — no session
      // needed. A present-but-invalid or expired signature is rejected (no silent fallback).
      const secret = kernel.config.secret
      const { valid, expired } = secret
        ? verifyAssetUrl(secret, key, exp, sig, Math.floor(Date.now() / 1000))
        : { valid: false, expired: false }
      if (!valid || expired) return new Response('Forbidden', { status: 403 })
      allowed = true
    } else {
      // No signature: re-check access by resolving the document with the caller's identity.
      const { user, overrideAccess } = await resolveAuth(kernel, options, request)
      try {
        const found = await kernel.find({
          collection: slug,
          where: { storage_key: { equals: key } },
          limit: 1,
          overrideAccess,
          req: { user },
        })
        allowed = found.docs.length > 0
      } catch {
        allowed = false
      }
    }
    if (!allowed) return new Response('Not found', { status: 404 })

    try {
      const head = await adapter.head(key)
      if (!head) return new Response('Not found', { status: 404 })
      if (request.method === 'HEAD') {
        return new Response(null, { status: 200, headers: { 'content-length': String(head.size) } })
      }
      const bytes = await adapter.get(key)
      const ext = key.slice(key.lastIndexOf('.') + 1).toLowerCase()
      const contentType = EXT_MIME[ext] ?? 'application/octet-stream'
      // Only raster images are ever served inline. SVG, PDF, video and anything
      // unknown is forced to download (`attachment`) so a hostile uploaded SVG or
      // HTML-polyglot can never execute script on our own origin where the admin
      // session lives. `nosniff` stops browsers from re-guessing a dangerous type.
      const disposition = INLINE_CONTENT_TYPES.has(contentType) ? 'inline' : 'attachment'
      return new Response(bytes, {
        status: 200,
        headers: {
          'content-type': contentType,
          'content-disposition': disposition,
          'x-content-type-options': 'nosniff',
          'cache-control': 'private, max-age=31536000, immutable',
        },
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  }
  return null
}

function collectAdapters(kernel: Kernel): {
  servePath?: string
  head: (k: string) => Promise<{ size: number } | null>
  get: (k: string) => Promise<Buffer>
}[] {
  const storage = kernel.config.storage
  if (!storage) return []
  if (typeof (storage as { put?: unknown }).put === 'function') return [storage as never]
  return Object.values(storage as Record<string, never>)
}

async function route(kernel: Kernel, options: HandlerOptions, request: Request, apiBase: string): Promise<Response> {
  const url = new URL(request.url)
  if (!url.pathname.startsWith(apiBase)) {
    return json({ error: { code: 'NOT_FOUND', message: `No route for ${url.pathname}` } }, 404)
  }

  const segments = url.pathname.slice(apiBase.length).split('/').filter(Boolean)
  const { user, overrideAccess, viaCookie } = await resolveAuth(kernel, options, request)
  // CSRF: a cookie-authenticated state-changing request must be same-origin.
  if (!passesCsrf(request, viaCookie)) {
    return json({ error: { code: 'FORBIDDEN', message: 'Cross-origin request rejected.' } }, 403)
  }
  const locale = url.searchParams.get('locale') ?? undefined
  // Personalization: the requested audience segment. Untrusted — core resolves an unknown
  // segment to the configured default and guards prototype-pollution keys.
  const audience = url.searchParams.get('audience') ?? undefined
  const depth = toNum(url.searchParams.get('depth'))
  const draft = url.searchParams.get('draft') === 'true'
  const base = {
    req: { user, ...(locale ? { locale } : {}), ...(audience ? { audience } : {}) },
    overrideAccess,
    ...(depth !== undefined ? { depth } : {}),
    ...(draft ? { draft: true } : {}),
  }
  const method = request.method

  // /  -> API descriptor
  if (segments.length === 0) {
    return json({
      name: 'KernelCMS',
      collections: kernel.config.collections.map((c) => c.slug),
      globals: kernel.config.globals.map((g) => g.slug),
    })
  }

  // /health
  if (segments.length === 1 && segments[0] === 'health') {
    const health = await kernel.db.health()
    return json({ status: 'ok', db: health }, health.status === 'ok' ? 200 : 503)
  }

  // AI-discoverability / GEO surface. ALL of these are PUBLIC (no auth) but emit ONLY
  // PUBLISHED, publicly-readable content: core generates them as an anonymous principal
  // through the access pipeline, so drafts/private docs can never appear. Users typically
  // proxy GET /api/llms.txt to their site root /llms.txt.
  if (
    segments.length === 1 &&
    method === 'GET' &&
    (segments[0] === 'llms.txt' || segments[0] === 'llms-full.txt' || segments[0] === 'content-chunks')
  ) {
    if (!kernel.config.discoverability.enabled) {
      return json({ error: { code: 'NOT_FOUND', message: 'Discoverability is not enabled.' } }, 404)
    }
    const limit = toNum(url.searchParams.get('limit'))
    if (segments[0] === 'llms.txt') {
      return textResponse(
        await kernel.llmsTxt({ ...(limit !== undefined ? { limit } : {}) }),
        'text/plain; charset=utf-8',
      )
    }
    if (segments[0] === 'llms-full.txt') {
      return textResponse(
        await kernel.llmsFullTxt({ ...(limit !== undefined ? { limit } : {}) }),
        'text/plain; charset=utf-8',
      )
    }
    // /content-chunks?collection=&limit= -> JSON array of retrieval-ready chunks.
    const collectionParam = url.searchParams.get('collection')
    const chunks = await kernel.contentChunks({
      ...(collectionParam ? { collection: collectionParam } : {}),
      ...(limit !== undefined ? { limit } : {}),
    })
    return json({ chunks })
  }

  // /_config -> serializable admin schema descriptor
  if (segments.length === 1 && segments[0] === '_config') {
    return json(describeConfig(kernel.config))
  }

  // GET /graph-search?q=&collection=&depth=&limit= -> GraphRAG retrieval: semantic seed
  // documents for `q` plus their connected, ACCESS-CHECKED subgraph (nodes + edges) and a
  // plain-text `context` array for grounding an LLM. Runs as the REQUEST principal, so only
  // content the caller may read contributes — no node, edge, or snippet leaks a hidden doc.
  if (segments.length === 1 && segments[0] === 'graph-search' && method === 'GET') {
    const q = url.searchParams.get('q')
    if (typeof q !== 'string' || q.trim().length === 0) {
      throw new BadRequestError('`q` (the search query) is required.')
    }
    const collectionParam = url.searchParams.get('collection')
    const result = await kernel.graphSearch({
      query: q,
      ...(collectionParam ? { collection: collectionParam } : {}),
      depth: toNum(url.searchParams.get('depth')),
      limit: toNum(url.searchParams.get('limit')),
      maxNodes: toNum(url.searchParams.get('maxNodes')),
      req: base.req,
      overrideAccess: base.overrideAccess,
    })
    return json(result)
  }

  // POST/GET /_experiments/:slug/assign -> deterministically bucket a visitor `key` into
  // an experiment variant. PUBLIC: bucketing is not secret, and only the HASH of `key` is
  // ever used/recorded (never the raw key). The returned `segment` is fed back as
  // `?audience=` on subsequent reads to serve that variant's personalized content.
  if (segments[0] === '_experiments' && segments[2] === 'assign' && segments.length === 3) {
    if (!kernel.config.experiments.length) {
      return json({ error: { code: 'NOT_FOUND', message: 'Experiments are not enabled.' } }, 404)
    }
    const slug = decodeURIComponent(segments[1]!)
    let key: unknown
    if (method === 'POST') {
      key = (await readBody(request)).key
    } else if (method === 'GET') {
      key = url.searchParams.get('key') ?? undefined
    } else {
      return methodNotAllowed()
    }
    if (typeof key !== 'string' || key.length === 0) {
      return json({ error: { code: 'VALIDATION_ERROR', message: '`key` is required.' } }, 400)
    }
    return json(kernel.assignVariant({ experiment: slug, key }))
  }

  // POST /_analytics/track -> capture ONE content-usage event into the bounded
  // `_analytics` table. NO PII is ever stored: the request principal is NEVER recorded,
  // and a client `meta` is sanitized (PII-ish + proto keys stripped). `track` can ONLY
  // write `_analytics` — a `type`/`collection` value can never redirect the write to a
  // content collection. Gating: by default requires an authenticated principal; set
  // `publicTrack: true` to allow anonymous tracking (a public site recording views).
  // Resilient: a tracking failure never surfaces — the response is always 202 Accepted.
  if (segments[0] === '_analytics' && segments[1] === 'track' && segments.length === 2) {
    if (method !== 'POST') return methodNotAllowed()
    if (!kernel.config.analytics.enabled) {
      return json({ error: { code: 'NOT_FOUND', message: 'Analytics is not enabled.' } }, 404)
    }
    if (!user && options.publicTrack !== true) throw new UnauthorizedError()
    const body = await readBody(request)
    const type = String(body.type ?? '')
    // The body is fully untrusted: only the allowed scalar dimensions are forwarded, and
    // NO principal/identity field is ever passed through (core also never reads one).
    await kernel.track({
      type: type as never,
      ...(typeof body.collection === 'string' ? { collection: body.collection } : {}),
      ...(typeof body.documentId === 'string' ? { documentId: body.documentId } : {}),
      ...(typeof body.query === 'string' ? { query: body.query } : {}),
      ...(typeof body.experiment === 'string' ? { experiment: body.experiment } : {}),
      ...(typeof body.variant === 'string' ? { variant: body.variant } : {}),
      ...(typeof body.value === 'number' ? { value: body.value } : {}),
      ...(body.meta && typeof body.meta === 'object' && !Array.isArray(body.meta)
        ? { meta: body.meta as Record<string, unknown> }
        : {}),
    })
    return json({ accepted: true }, 202)
  }

  // /openapi -> machine-readable contract; /docs -> Scalar API reference UI.
  // The path stays reserved whether or not the feature is on: when disabled it
  // 404s (rather than disclosing the spec) instead of falling through to a
  // collection lookup. Disable in production — it maps every collection + field.
  if (segments.length === 1 && method === 'GET' && (segments[0] === 'openapi' || segments[0] === 'docs')) {
    if (options.openapi === false) {
      return json({ error: { code: 'NOT_FOUND', message: 'Not found.' } }, 404)
    }
    if (segments[0] === 'openapi') {
      return json(buildOpenApiSpec(kernel, { apiBase, title: 'KernelCMS API' }))
    }
    if (segments[0] === 'docs') {
      const docs = html(scalarHtml(`${apiBase}/openapi`))
      // The docs page is same-origin with the admin (token in localStorage), so
      // lock script execution to the pinned Scalar CDN only — any other injected
      // script is blocked. (For zero third-party trust, self-host Scalar or set
      // `openapi: false`.)
      docs.headers.set(
        'content-security-policy',
        "default-src 'none'; script-src https://cdn.jsdelivr.net 'unsafe-inline'; " +
          "style-src https://cdn.jsdelivr.net 'unsafe-inline'; img-src 'self' data: https:; " +
          "font-src https://cdn.jsdelivr.net data:; connect-src 'self'",
      )
      return docs
    }
  }

  // /graphql -> generated GraphQL endpoint (POST { query, variables, operationName })
  if (segments.length === 1 && segments[0] === 'graphql') {
    if (!options.graphql) return json({ error: { code: 'NOT_FOUND', message: 'GraphQL is not enabled.' } }, 404)
    if (method !== 'POST') return methodNotAllowed()
    const body = await readBody(request)
    const result = await graphqlExecutor(kernel)({
      query: String(body.query ?? ''),
      variables: (body.variables as Record<string, unknown> | null) ?? null,
      operationName: (body.operationName as string | null) ?? null,
      context: { user, overrideAccess },
    })
    return json(result) // GraphQL convention: 200 even when `errors` is present
  }

  // /_admin/* -> bootstrap surface for the built-in admin UI
  if (segments[0] === '_admin') {
    const slug = authCollectionSlug(kernel)

    // GET /_admin/status -> is first-run setup needed? Returns non-sensitive
    // runtime facts (db kind, secret-set, storage/email booleans) ONLY during the
    // first-run window so the welcome screen can explain how the instance is
    // running. Once an admin exists it returns the minimal status.
    if (segments[1] === 'status' && segments.length === 2 && method === 'GET') {
      const needsSetup = slug ? (await kernel.count({ collection: slug, overrideAccess: true })) === 0 : false
      if (needsSetup) {
        return json({
          needsSetup,
          authCollection: slug,
          runtime: { ...setupRuntime(kernel), graphql: Boolean(options.graphql) },
        })
      }
      return json({ needsSetup, authCollection: slug })
    }

    // GET /_admin/connectors -> connector inventory for the Connectors panel
    // (authenticated admins only; non-sensitive kinds/booleans/provider names).
    if (segments[1] === 'connectors' && segments.length === 2 && method === 'GET') {
      if (!user) throw new UnauthorizedError()
      return json({ ...connectorStatus(kernel), graphql: Boolean(options.graphql) })
    }

    // GET /_admin/metrics -> runtime observability for authenticated admins:
    // adapter health, cache hit/miss counters, uptime. Non-sensitive operational
    // facts only (no connection strings or secrets).
    if (segments[1] === 'metrics' && segments.length === 2 && method === 'GET') {
      if (!user) throw new UnauthorizedError()
      const [dbHealth, cacheHealth, searchHealth] = await Promise.all([
        kernel.db.health(),
        kernel.cache ? kernel.cache.health() : Promise.resolve(null),
        kernel.search ? kernel.search.health() : Promise.resolve(null),
      ])
      const uptimeMs =
        typeof process !== 'undefined' && typeof process.uptime === 'function' ? Math.round(process.uptime() * 1000) : 0
      return json({
        version: KERNEL_VERSION,
        uptimeMs,
        collections: kernel.config.collections.length,
        db: { name: kernel.db.name, health: dbHealth },
        cache: kernel.cache ? { name: kernel.cache.name, health: cacheHealth, stats: kernel.cache.stats() } : null,
        search: kernel.search ? { name: kernel.search.name, health: searchHealth } : null,
      })
    }

    // GET /_admin/audit -> query/export the append-only governance audit log.
    // ADMIN-ONLY: an authenticated principal whose roles include 'admin' (the same
    // convention the core access layer trusts). Supports filtering by collection,
    // principal id, action, and an ISO `from`/`to` range on `at`, with pagination.
    // `?format=csv` streams a CSV export. Returns empty when auditing is disabled.
    if (segments[1] === 'audit' && segments.length === 2 && method === 'GET') {
      if (!user) throw new UnauthorizedError()
      if (!isAdmin(user)) throw new ForbiddenError('Audit log access requires an admin role.')
      const q = url.searchParams
      const where = auditWhere(q)
      const result = await kernel.findAuditLog({
        ...(where ? { where } : {}),
        limit: toNum(q.get('limit')) ?? 100,
        page: toNum(q.get('page')) ?? 1,
      })
      if (q.get('format') === 'csv') return auditCsvResponse(result.docs)
      return json(result)
    }

    // GET /_admin/insights -> aggregate content insights (top content, top queries,
    // variant performance, activity over time, the AI-retrieval leaderboard). REVIEWER-
    // gated (admin OR editor; never an agent). Every result is an AGGREGATE over content
    // events — there is no per-user data to leak (none is stored). Core additionally
    // filters insight rows to the collections THIS reviewer can read (the request `user`
    // is passed, never overrideAccess), so an editor never sees a hidden collection's
    // counts. Returns an empty result when analytics is disabled.
    if (segments[1] === 'insights' && segments.length === 2 && method === 'GET') {
      if (!user) throw new UnauthorizedError()
      if (!isReviewer(user)) throw new ForbiddenError('Insights access requires an admin or editor role.')
      const q = url.searchParams
      const metric = String(q.get('metric') ?? 'top_content')
      const result = await kernel.insights({
        metric: metric as never,
        ...(q.get('collection') ? { collection: q.get('collection')! } : {}),
        ...(q.get('type') ? { type: q.get('type')! as never } : {}),
        ...(q.get('from') ? { from: q.get('from')! } : {}),
        ...(q.get('to') ? { to: q.get('to')! } : {}),
        ...(toNum(q.get('limit')) !== undefined ? { limit: toNum(q.get('limit')) } : {}),
        req: { user },
      })
      return json(result)
    }

    // GET /_admin/duplicates?collection=&threshold=&limit= -> near-duplicate detection: the
    // pairs of documents in a collection whose embeddings are ≥ `threshold` cosine similar.
    // REVIEWER-gated (admin OR editor; never an agent), a content-quality tool. Core access-
    // checks BOTH ids of every pair with this reviewer's principal, so a pair touching a doc
    // they can't read is dropped — it can't be used to infer hidden content/ids. `threshold`
    // is clamped to [0,1] and the O(n²) scan is bounded in core.
    if (segments[1] === 'duplicates' && segments.length === 2 && method === 'GET') {
      if (!user) throw new UnauthorizedError()
      if (!isReviewer(user)) throw new ForbiddenError('Duplicate detection requires an admin or editor role.')
      const q = url.searchParams
      const collection = q.get('collection')
      if (!collection) throw new BadRequestError('A `collection` query parameter is required.')
      const result = await kernel.findDuplicates({
        collection,
        ...(toNum(q.get('threshold')) !== undefined ? { threshold: toNum(q.get('threshold')) } : {}),
        ...(toNum(q.get('limit')) !== undefined ? { limit: toNum(q.get('limit')) } : {}),
        req: { user },
      })
      return json(result)
    }

    // /_admin/roles -> manage runtime-editable RBAC roles. ADMIN-ONLY (same gate as
    // /_admin/audit): the future role-builder UI calls these. GET lists, POST creates,
    // PATCH /:name replaces, DELETE /:name removes. Each mutation persists to `_roles`
    // and updates the live store, so enforcement changes immediately.
    // /_admin/webhooks -> outbound webhook config (redacted) + the durable delivery log.
    // ADMIN-ONLY: webhook endpoints are sensitive egress infrastructure. Secrets/custom
    // headers are never returned. The acting identity is the server-resolved `user`.
    if (segments[1] === 'webhooks') {
      if (!user) throw new UnauthorizedError()
      if (!isAdmin(user)) throw new ForbiddenError('Webhook management requires an admin role.')
      const q = url.searchParams

      // GET /_admin/webhooks -> redacted config summaries.
      if (segments.length === 2 && method === 'GET') {
        return json({ webhooks: kernel.listWebhooks() })
      }

      // GET /_admin/webhooks/deliveries?webhook=&status=&since=&limit=&page= -> the delivery log.
      if (segments.length === 3 && segments[2] === 'deliveries' && method === 'GET') {
        return json(
          await kernel.webhookDeliveries({
            ...(q.get('webhook') ? { webhook: q.get('webhook')! } : {}),
            ...(q.get('status') ? { status: q.get('status') as never } : {}),
            ...(q.get('since') ? { since: q.get('since')! } : {}),
            ...(toNum(q.get('limit')) !== undefined ? { limit: toNum(q.get('limit')) } : {}),
            ...(toNum(q.get('page')) !== undefined ? { page: toNum(q.get('page')) } : {}),
            req: { user },
          }),
        )
      }

      // POST /_admin/webhooks/deliveries/:id/retry -> requeue a failed/exhausted delivery.
      if (segments.length === 5 && segments[2] === 'deliveries' && segments[4] === 'retry' && method === 'POST') {
        return json(await kernel.retryWebhookDelivery({ deliveryId: decodeURIComponent(segments[3]!), req: { user } }))
      }
      return methodNotAllowed()
    }

    if (segments[1] === 'roles') {
      if (!user) throw new UnauthorizedError()
      if (!isAdmin(user)) throw new ForbiddenError('Role management requires an admin role.')

      // GET /_admin/roles, POST /_admin/roles
      if (segments.length === 2) {
        if (method === 'GET') return json({ roles: await kernel.findRoles() })
        if (method === 'POST') {
          const body = await readBody(request)
          const name = typeof body.name === 'string' ? body.name : ''
          const def = (body.def ?? {}) as RoleDef
          return json({ role: await kernel.createRole(name, def, { req: { user } }) }, 201)
        }
        return methodNotAllowed()
      }

      // PATCH /_admin/roles/:name, DELETE /_admin/roles/:name
      if (segments.length === 3) {
        const name = decodeURIComponent(segments[2]!)
        if (method === 'PATCH') {
          const body = await readBody(request)
          const def = (body.def ?? {}) as RoleDef
          return json({ role: await kernel.updateRole(name, def, { req: { user } }) })
        }
        if (method === 'DELETE') return json(await kernel.deleteRole(name, { req: { user } }))
        return methodNotAllowed()
      }
    }

    // GET /_admin/templates?collection= -> list the available content templates (named
    // document skeletons), optionally for one collection. REVIEWER-gated (admin OR editor;
    // never an agent) — templates are an editorial productivity surface. Metadata only
    // (slug/collection/name/description); the raw default `data` is never returned. Empty
    // when no templates are configured. Instantiate one via POST /:collection/from-template.
    if (segments[1] === 'templates' && segments.length === 2 && method === 'GET') {
      if (!user) throw new UnauthorizedError()
      if (!isReviewer(user)) throw new ForbiddenError('Template access requires an admin or editor role.')
      const collection = url.searchParams.get('collection')
      const templates = await kernel.listTemplates({
        ...(collection ? { collection } : {}),
        req: { user },
      })
      return json({ templates })
    }

    // /_admin/reviews -> the agent review inbox. REVIEWER-gated (admin OR editor): a
    // reviewer isn't always an admin, but they must be a trusted human (never an agent).
    // GET lists the queue (optional ?collection=); POST submits a decision. The reviewer
    // identity is the server-resolved `user` ONLY — the client-supplied body is treated as
    // untrusted and never names the reviewer. Approve reuses the publish access gate, so a
    // reviewer lacking publish access is rejected by core (Forbidden -> 403).
    if (segments[1] === 'reviews' && segments.length === 2) {
      if (!user) throw new UnauthorizedError()
      if (!isReviewer(user)) throw new ForbiddenError('Review inbox access requires an admin or editor role.')
      if (method === 'GET') {
        const collection = url.searchParams.get('collection')
        return json(
          await kernel.findReviewQueue({
            ...(collection ? { collection } : {}),
            limit: toNum(url.searchParams.get('limit')) ?? undefined,
            page: toNum(url.searchParams.get('page')) ?? undefined,
            req: { user },
          }),
        )
      }
      if (method === 'POST') {
        const body = await readBody(request)
        const decision = body.decision === 'approve' || body.decision === 'request_changes' ? body.decision : null
        if (!decision) throw new BadRequestError('`decision` must be "approve" or "request_changes".')
        return json(
          await kernel.submitReview({
            collection: String(body.collection ?? ''),
            id: String(body.id ?? ''),
            decision,
            ...(typeof body.note === 'string' ? { note: body.note } : {}),
            req: { user },
          }),
        )
      }
      return methodNotAllowed()
    }

    // /_admin/comments/:commentId -> resolve / delete an editorial comment. AUTH-REQUIRED
    // only here; the AUTHORIZATION is enforced in core against the server-resolved principal:
    // PATCH (resolve/unresolve) requires the comment's author OR a reviewer (admin/editor);
    // DELETE requires the author OR an admin. Both re-check the target document's read access.
    // The client body never names the principal. 404 when comments are disabled.
    if (segments[1] === 'comments' && segments.length === 3) {
      if (!kernel.config.comments.enabled) {
        return json({ error: { code: 'NOT_FOUND', message: 'Comments are not enabled.' } }, 404)
      }
      if (!user) throw new UnauthorizedError()
      const commentId = segments[2]!
      if (method === 'PATCH') {
        const body = await readBody(request)
        return json(
          await kernel.resolveComment({
            commentId,
            ...(typeof body.resolved === 'boolean' ? { resolved: body.resolved } : {}),
            req: { user },
          }),
        )
      }
      if (method === 'DELETE') {
        return json(await kernel.deleteComment({ commentId, req: { user } }))
      }
      return methodNotAllowed()
    }

    // /_admin/views -> saved views / smart collections (named query presets). AUTH-REQUIRED
    // (any authenticated principal manages THEIR OWN views; a shared view is visible to those
    // who can read its collection). The acting/owner identity is the server-resolved `user`
    // ONLY — the client body never names the owner. Applying a view runs the normal
    // access-checked find, so it can never widen visibility. 404 when views are disabled.
    // /_admin/subscriptions -> saved-search alerts. AUTH-REQUIRED; owner-scoped (you manage
    // only your OWN subscriptions). The owner identity is the server-resolved `user`.
    if (segments[1] === 'subscriptions') {
      if (!kernel.config.subscriptions.enabled) {
        return json({ error: { code: 'NOT_FOUND', message: 'Saved-search alerts are not enabled.' } }, 404)
      }
      if (!user) throw new UnauthorizedError()
      const q = url.searchParams
      const asWhere = (v: unknown): Where | undefined =>
        v != null && typeof v === 'object' && !Array.isArray(v) ? (v as Where) : undefined

      // GET /_admin/subscriptions?collection= , POST /_admin/subscriptions
      if (segments.length === 2) {
        if (method === 'GET') {
          const collection = q.get('collection')
          return json({
            subscriptions: await kernel.listSubscriptions({ ...(collection ? { collection } : {}), req: { user } }),
          })
        }
        if (method === 'POST') {
          const body = await readBody(request)
          const where = asWhere(body.where)
          return json(
            await kernel.createSubscription({
              collection: String(body.collection ?? ''),
              webhook: String(body.webhook ?? ''),
              ...(where ? { where } : {}),
              req: { user },
            }),
            201,
          )
        }
        return methodNotAllowed()
      }
      // DELETE /_admin/subscriptions/:id
      if (segments.length === 3 && method === 'DELETE') {
        return json(
          await kernel.deleteSubscription({ subscriptionId: decodeURIComponent(segments[2]!), req: { user } }),
        )
      }
      return methodNotAllowed()
    }

    if (segments[1] === 'views') {
      if (!kernel.config.views.enabled) {
        return json({ error: { code: 'NOT_FOUND', message: 'Saved views are not enabled.' } }, 404)
      }
      if (!user) throw new UnauthorizedError()
      const q = url.searchParams
      // A `where` from a JSON body must be a plain object (not array/primitive); the core op
      // validates its fields/operators. We only gate the shape here to fail fast and cleanly.
      const asWhere = (v: unknown): Where | undefined =>
        v != null && typeof v === 'object' && !Array.isArray(v) ? (v as Where) : undefined

      // GET /_admin/views?collection= , POST /_admin/views
      if (segments.length === 2) {
        if (method === 'GET') {
          const collection = q.get('collection')
          return json({
            views: await kernel.listViews({ ...(collection ? { collection } : {}), req: { user } }),
          })
        }
        if (method === 'POST') {
          const body = await readBody(request)
          const where = asWhere(body.where)
          return json(
            await kernel.saveView({
              collection: String(body.collection ?? ''),
              name: String(body.name ?? ''),
              ...(where ? { where } : {}),
              ...(body.sort !== undefined ? { sort: body.sort as string | string[] } : {}),
              ...(Array.isArray(body.columns) ? { columns: body.columns as string[] } : {}),
              ...(typeof body.shared === 'boolean' ? { shared: body.shared } : {}),
              req: { user },
            }),
            201,
          )
        }
        return methodNotAllowed()
      }

      const viewId = decodeURIComponent(segments[2]!)

      // GET /_admin/views/:id , PATCH /_admin/views/:id , DELETE /_admin/views/:id
      if (segments.length === 3) {
        if (method === 'GET') {
          const view = await kernel.getView({ viewId, req: { user } })
          if (!view) throw new NotFoundError()
          return json(view)
        }
        if (method === 'PATCH') {
          const body = await readBody(request)
          return json(
            await kernel.updateView({
              viewId,
              ...(typeof body.name === 'string' ? { name: body.name } : {}),
              ...('where' in body ? { where: asWhere(body.where) ?? null } : {}),
              ...('sort' in body ? { sort: (body.sort ?? null) as string | string[] | null } : {}),
              ...('columns' in body
                ? { columns: (Array.isArray(body.columns) ? body.columns : null) as string[] | null }
                : {}),
              ...(typeof body.shared === 'boolean' ? { shared: body.shared } : {}),
              req: { user },
            }),
          )
        }
        if (method === 'DELETE') {
          return json(await kernel.deleteView({ viewId, req: { user } }))
        }
        return methodNotAllowed()
      }

      // POST /_admin/views/:id/apply -> run the view (the access-checked find).
      if (segments.length === 4 && segments[3] === 'apply' && method === 'POST') {
        const body = await readBody(request)
        const where = asWhere(body.where)
        return json(
          await kernel.applyView({
            viewId,
            ...(where ? { where } : {}),
            ...(body.sort !== undefined ? { sort: body.sort as string | string[] } : {}),
            ...(typeof body.draft === 'boolean' ? { draft: body.draft } : {}),
            ...(toNum(String(body.limit ?? '')) !== undefined ? { limit: toNum(String(body.limit)) } : {}),
            ...(toNum(String(body.page ?? '')) !== undefined ? { page: toNum(String(body.page)) } : {}),
            req: { user },
          }),
        )
      }
      return methodNotAllowed()
    }

    // /_admin/releases -> content releases (a named bundle of drafts published as a unit).
    // REVIEWER-gated (admin OR editor; never an agent): the same trusted-human gate as the
    // review inbox. The acting identity is the server-resolved `user` ONLY — the client
    // body never names the principal. Publishing a release routes EVERY member through the
    // normal per-doc publish gate with this `user`, so a caller can only publish a release
    // whose every member they could publish directly (an agent can never publish — the
    // per-doc brake), and the all-or-nothing pre-flight stops a partial go-live.
    if (segments[1] === 'releases') {
      if (!user) throw new UnauthorizedError()
      if (!isReviewer(user)) throw new ForbiddenError('Release management requires an admin or editor role.')
      const q = url.searchParams

      // GET /_admin/releases, POST /_admin/releases
      if (segments.length === 2) {
        if (method === 'GET') {
          const status = q.get('status')
          return json(
            await kernel.listReleases({
              ...(status ? { status: status as never } : {}),
              limit: toNum(q.get('limit')) ?? undefined,
              page: toNum(q.get('page')) ?? undefined,
              req: { user },
            }),
          )
        }
        if (method === 'POST') {
          const body = await readBody(request)
          return json({ release: await kernel.createRelease({ name: String(body.name ?? ''), req: { user } }) }, 201)
        }
        return methodNotAllowed()
      }

      const releaseId = decodeURIComponent(segments[2]!)

      // GET /_admin/releases/:id, DELETE /_admin/releases/:id (cancel)
      if (segments.length === 3) {
        if (method === 'GET') {
          const release = await kernel.getRelease({ release: releaseId, req: { user } })
          if (!release) throw new NotFoundError()
          return json({ release })
        }
        if (method === 'DELETE') return json(await kernel.cancelRelease({ release: releaseId, req: { user } }))
        return methodNotAllowed()
      }

      if (segments.length >= 4) {
        const action = segments[3]!

        // POST /_admin/releases/:id/items  — add a member.
        // DELETE /_admin/releases/:id/items/:collection/:docId — remove a member.
        if (action === 'items') {
          if (segments.length === 4 && method === 'POST') {
            const body = await readBody(request)
            return json({
              release: await kernel.addToRelease({
                release: releaseId,
                collection: String(body.collection ?? ''),
                id: String(body.id ?? ''),
                req: { user },
              }),
            })
          }
          if (segments.length === 6 && method === 'DELETE') {
            return json({
              release: await kernel.removeFromRelease({
                release: releaseId,
                collection: decodeURIComponent(segments[4]!),
                id: decodeURIComponent(segments[5]!),
                req: { user },
              }),
            })
          }
          return methodNotAllowed()
        }

        // GET /_admin/releases/:id/preview
        if (action === 'preview' && segments.length === 4 && method === 'GET') {
          return json(await kernel.previewRelease({ release: releaseId, req: { user } }))
        }

        // POST /_admin/releases/:id/publish
        if (action === 'publish' && segments.length === 4 && method === 'POST') {
          return json(await kernel.publishRelease({ release: releaseId, req: { user } }))
        }

        // POST /_admin/releases/:id/schedule  { at }
        if (action === 'schedule' && segments.length === 4 && method === 'POST') {
          const body = await readBody(request)
          if (typeof body.at !== 'string') throw new BadRequestError('`at` (ISO timestamp) is required.')
          return json({ release: await kernel.scheduleRelease({ release: releaseId, at: body.at, req: { user } }) })
        }
      }

      return methodNotAllowed()
    }

    // /_admin/workflow-runs -> the agentic-workflow run log. REVIEWER-gated (admin OR
    // editor; never an agent) — operators monitor autonomous runs here. GET lists runs
    // (optional ?slug= / ?status= / pagination). Read-only. Returns empty when workflows
    // are not configured.
    if (segments[1] === 'workflow-runs' && segments.length === 2 && method === 'GET') {
      if (!user) throw new UnauthorizedError()
      if (!isReviewer(user)) throw new ForbiddenError('Workflow run access requires an admin or editor role.')
      const q = url.searchParams
      const slug = q.get('slug')
      const status = q.get('status')
      return json(
        await kernel.workflowRuns({
          ...(slug ? { slug } : {}),
          ...(status ? { status: status as never } : {}),
          limit: toNum(q.get('limit')) ?? undefined,
          page: toNum(q.get('page')) ?? undefined,
        }),
      )
    }

    // POST /_admin/workflows/:slug/run -> manually start a workflow run. REVIEWER-gated
    // (admin OR editor; never an agent). The run still executes AS the workflow's scoped
    // agent principal — this route only authorizes WHO may start it; it never becomes the
    // principal that runs the steps. The body's `input` is an untrusted manual payload.
    if (segments[1] === 'workflows' && segments.length === 4 && segments[3] === 'run' && method === 'POST') {
      if (!user) throw new UnauthorizedError()
      if (!isReviewer(user)) throw new ForbiddenError('Starting a workflow requires an admin or editor role.')
      const slug = decodeURIComponent(segments[2]!)
      const body = await readBody(request)
      return json(
        await kernel.runWorkflow({
          slug,
          ...(body.input !== undefined ? { input: body.input } : {}),
          req: { user },
        }),
      )
    }

    // /_admin/locks -> advisory soft locks, for the collaboration UI. REVIEWER-gated
    // (admin OR editor; never an agent) — the same coarse door as the review inbox. Locks
    // are ADVISORY: listing/acquiring/releasing here never changes write authorization.
    //   GET    /_admin/locks            -> every unexpired lock (optional ?collection=)
    //   POST   /_admin/locks            -> acquire/refresh { collection, id, ttlMs?, label? }
    //   DELETE /_admin/locks/:coll/:id  -> release (holder/admin only)
    if (segments[1] === 'locks') {
      if (!user) throw new UnauthorizedError()
      if (!isReviewer(user)) throw new ForbiddenError('Lock management requires an admin or editor role.')
      if (segments.length === 2) {
        if (method === 'GET') {
          const collection = url.searchParams.get('collection')
          return json({
            locks: await kernel.listLocks({ ...(collection ? { collection } : {}), req: { user } }),
          })
        }
        if (method === 'POST') {
          const body = await readBody(request)
          const result = await kernel.acquireLock({
            collection: String(body.collection ?? ''),
            id: String(body.id ?? ''),
            ...(typeof body.ttlMs === 'number' ? { ttlMs: body.ttlMs } : {}),
            ...(typeof body.label === 'string' ? { label: body.label } : {}),
            req: { user },
          })
          // A respected (not stolen) lock held by someone else is a 409 so the client can
          // surface "locked by …"; acquiring/refreshing your own returns 200.
          return json(result, result.heldBy === 'other' ? 409 : 200)
        }
        return methodNotAllowed()
      }
      if (segments.length === 4 && method === 'DELETE') {
        return json(
          await kernel.releaseLock({
            collection: decodeURIComponent(segments[2]!),
            id: decodeURIComponent(segments[3]!),
            req: { user },
          }),
        )
      }
      return methodNotAllowed()
    }

    // GET /_admin/translation-status/:collection -> the localization dashboard: per-locale
    // completeness across a collection (optional ?id= for one document). REVIEWER-gated
    // (admin OR editor); core scopes the listing by the reviewer's own read access, so it
    // never widens what they could read directly. No-op shape when localization is off.
    if (segments[1] === 'translation-status' && segments.length === 3 && method === 'GET') {
      if (!user) throw new UnauthorizedError()
      if (!isReviewer(user)) throw new ForbiddenError('Translation dashboard access requires an admin or editor role.')
      const collection = segments[2]!
      const id = url.searchParams.get('id')
      if (id) {
        return json(await kernel.translationStatus({ collection, id, req: { user } }))
      }
      return json(
        await kernel.translationStatusList({
          collection,
          limit: toNum(url.searchParams.get('limit')) ?? undefined,
          page: toNum(url.searchParams.get('page')) ?? undefined,
          req: { user },
        }),
      )
    }

    // POST /_admin/translate-missing -> batch-fill a collection's missing target-locale
    // translations from a source locale via the configured provider. REVIEWER-gated (admin
    // OR editor; never an agent). Core scopes candidate docs by the reviewer's own read
    // access AND enforces write access per doc, so it never widens what they could change
    // directly; bounded by `limit`. 400 when translation/localization is not configured.
    if (segments[1] === 'translate-missing' && segments.length === 2 && method === 'POST') {
      if (!user) throw new UnauthorizedError()
      if (!isReviewer(user)) throw new ForbiddenError('Translation requires an admin or editor role.')
      const body = await readBody(request)
      const collection = String(body.collection ?? '')
      if (!collection) throw new BadRequestError('`collection` is required.')
      return json(
        await kernel.translateMissing({
          collection,
          to: String(body.to ?? ''),
          ...(typeof body.from === 'string' ? { from: body.from } : {}),
          ...(Array.isArray(body.fields) ? { fields: body.fields.map(String) } : {}),
          ...(typeof body.limit === 'number' ? { limit: body.limit } : {}),
          req: { user },
        }),
      )
    }

    // POST /_admin/env -> persist chosen connector settings to the project .env.
    // Strictly first-run only (no admin yet = local operator) AND never in
    // production. Only whitelisted, single-line keys are written. Applies on the
    // next `kernel` start (the CLI loads .env).
    if (segments[1] === 'env' && segments.length === 2 && method === 'POST') {
      const noUsers = slug ? (await kernel.count({ collection: slug, overrideAccess: true })) === 0 : true
      if (!noUsers) throw new ForbiddenError('Environment can only be configured during first-run setup.')
      if (process.env.NODE_ENV === 'production') {
        throw new ForbiddenError('Environment cannot be written in production. Edit your .env directly.')
      }
      const body = await readBody(request)
      const values = (body.values ?? {}) as Record<string, unknown>
      const written = writeEnvFile(values)
      return json({ ok: true, written })
    }

    // POST /_admin/setup -> create the FIRST admin, only while none exist.
    // Guarded by a server-side count so it can never create a second account
    // or be used to take over an existing install.
    if (segments[1] === 'setup' && segments.length === 2 && method === 'POST') {
      if (!slug) throw new BadRequestError('No auth collection is configured.')
      const existing = await kernel.count({ collection: slug, overrideAccess: true })
      if (existing > 0) throw new ForbiddenError('Setup has already been completed.')
      const body = await readBody(request)
      const email = String(body.email ?? '')
      const password = String(body.password ?? '')
      const collection = kernel.config.collectionsBySlug[slug]
      const data: Row = { email, password }
      const hasField = (name: string) => collection?.fields.some((f) => 'name' in f && f.name === name)
      if (hasField('roles')) data.roles = ['admin']
      // The bootstrap admin is trusted — skip email verification so setup can sign in.
      if (hasField('email_verified')) data.email_verified = true
      await kernel.create({ collection: slug, data, overrideAccess: true })
      const result = await kernel.login({ collection: slug, email, password })
      return attachSessionCookie(json(result, 201), result, options, request, apiBase)
    }

    return json({ error: { code: 'NOT_FOUND', message: `No route for ${url.pathname}` } }, 404)
  }

  // /_presence/:collection/:id -> lightweight presence for the collaboration UI.
  // AUTH-REQUIRED (any signed-in principal — humans and agents both report presence).
  //   GET  -> the active participants on the document (within the TTL)
  //   POST -> a heartbeat { kind: 'viewing' | 'editing' }
  if (segments[0] === '_presence' && segments.length === 3) {
    if (!user) throw new UnauthorizedError()
    const presenceCollection = segments[1]!
    const presenceId = segments[2]!
    if (method === 'GET') {
      const ttlMs = toNum(url.searchParams.get('ttlMs'))
      return json({
        presence: await kernel.getPresence({
          collection: presenceCollection,
          id: presenceId,
          ...(ttlMs !== undefined ? { ttlMs } : {}),
          req: { user },
        }),
      })
    }
    if (method === 'POST') {
      const body = await readBody(request)
      const kind = body.kind === 'editing' ? 'editing' : 'viewing'
      await kernel.heartbeat({ collection: presenceCollection, id: presenceId, kind, req: { user } })
      return json({ ok: true })
    }
    return methodNotAllowed()
  }

  // Real-time change feed. AUTH-REQUIRED on both surfaces; every event is metadata-only
  // and access-filtered per the connection's principal (a subscriber NEVER learns that a
  // document they can't read changed). 404 when realtime is disabled (rather than falling
  // through to a `changes` collection lookup).
  // /_edge/purge -> the CDN purge feed: cache tags to invalidate for changes since a
  // cursor, derived from the change feed. ADMIN-ONLY (it reveals which document ids
  // changed — the same access model as the change feed's operator surface). 404 when
  // edge delivery is disabled.
  if (segments[0] === '_edge') {
    if (!kernel.config.edge.enabled) {
      return json({ error: { code: 'NOT_FOUND', message: 'Edge delivery is not enabled.' } }, 404)
    }
    if (segments[1] === 'purge' && segments.length === 2 && method === 'GET') {
      if (!user) throw new UnauthorizedError()
      if (!isAdmin(user)) throw new ForbiddenError('Purge feed access requires an admin role.')
      const since = toNum(url.searchParams.get('since'))
      const result = await kernel.purgeFeed({
        ...(since !== undefined ? { since } : {}),
        limit: toNum(url.searchParams.get('limit')) ?? undefined,
      })
      return json(result)
    }
    return methodNotAllowed()
  }

  if (segments[0] === 'changes') {
    if (!kernel.config.realtime.enabled) {
      return json({ error: { code: 'NOT_FOUND', message: 'Real-time is not enabled.' } }, 404)
    }
    if (!user) throw new UnauthorizedError()

    // GET /changes?since=&collection=&limit= -> the durable, access-filtered pull feed.
    if (segments.length === 1 && method === 'GET') {
      const since = toNum(url.searchParams.get('since'))
      const collectionParam = url.searchParams.get('collection')
      const result = await kernel.changes({
        ...(since !== undefined ? { since } : {}),
        ...(collectionParam ? { collection: collectionParam } : {}),
        limit: toNum(url.searchParams.get('limit')) ?? undefined,
        req: { user },
      })
      return json(result)
    }

    // GET /changes/stream?collection= -> a live SSE stream (text/event-stream). Each event
    // is access-filtered with the SAME filter as the pull feed; resume via Last-Event-ID.
    if (segments.length === 2 && segments[1] === 'stream' && method === 'GET') {
      return changeStream(kernel, request, url, user)
    }
    return methodNotAllowed()
  }

  // Custom endpoints (config.endpoints) — matched before the generic collection
  // CRUD so a module can extend or intentionally override the resource space.
  // Access, validation, and errors all flow through the same pipeline as core.
  const customEndpoints = kernel.config.endpoints ?? []
  if (customEndpoints.length > 0) {
    const match = matchEndpoint(customEndpoints, method, segments)
    if (match) return runEndpoint(kernel, request, url, match.endpoint, match.params, { user, locale, audience })
  }

  // /globals/:slug
  if (segments[0] === 'globals' && segments.length === 2) {
    const slug = segments[1]!
    if (method === 'GET') return json(await kernel.findGlobal({ slug, ...base }))
    if (method === 'POST' || method === 'PATCH') {
      const data = await readBody(request)
      return json(await kernel.updateGlobal({ slug, data, ...base }))
    }
    return methodNotAllowed()
  }

  const collection = segments[0]!

  // Auth sub-routes for auth collections: login, me, and the email flows.
  const AUTH_ACTIONS = new Set([
    'login',
    'logout',
    'me',
    'forgot-password',
    'reset-password',
    'verify-email',
    'resend-verification',
    '2fa-setup',
    '2fa-enable',
    '2fa-disable',
  ])
  if (segments.length === 2 && AUTH_ACTIONS.has(segments[1]!)) {
    const authColl = kernel.config.collectionsBySlug[collection]
    if (authColl?.auth) {
      const action = segments[1]!
      if (action === 'login' && method === 'POST') {
        const body = await readBody(request)
        const result = await kernel.login({
          collection,
          email: String(body.email ?? ''),
          password: String(body.password ?? ''),
          ...(body.code !== undefined ? { code: String(body.code) } : {}),
        })
        return attachSessionCookie(json(result), result, options, request, apiBase)
      }
      if (action === 'logout' && method === 'POST') {
        // Clear the session cookie. (JWTs are stateless; this ends the browser
        // session — full revocation across devices is a password/epoch change.)
        const res = json({ success: true })
        if (options.cookieAuth !== false) {
          res.headers.append('set-cookie', sessionCookie('', request, apiBase, 0))
        }
        return res
      }
      if (action === 'me' && method === 'GET') {
        if (!user) throw new UnauthorizedError()
        return json({ user })
      }
      // Generic success for forgot/resend so an attacker can't probe which emails exist.
      if (action === 'forgot-password' && method === 'POST') {
        const body = await readBody(request)
        await kernel.forgotPassword({ collection, email: String(body.email ?? '') })
        return json({ success: true })
      }
      if (action === 'reset-password' && method === 'POST') {
        const body = await readBody(request)
        const result = await kernel.resetPassword({
          collection,
          token: String(body.token ?? ''),
          password: String(body.password ?? ''),
        })
        return attachSessionCookie(json(result), result, options, request, apiBase)
      }
      if (action === 'verify-email' && method === 'POST') {
        const body = await readBody(request)
        return json(await kernel.verifyEmail({ collection, token: String(body.token ?? '') }))
      }
      if (action === 'resend-verification' && method === 'POST') {
        const body = await readBody(request)
        await kernel.requestEmailVerification({ collection, email: String(body.email ?? '') })
        return json({ success: true })
      }
      // Two-factor enrolment acts on the signed-in user's own record.
      if (action === '2fa-setup' && method === 'POST') {
        if (!user) throw new UnauthorizedError()
        return json(await kernel.setupTwoFactor({ collection, id: String(user.id) }))
      }
      if (action === '2fa-enable' && method === 'POST') {
        if (!user) throw new UnauthorizedError()
        const body = await readBody(request)
        return json(await kernel.enableTwoFactor({ collection, id: String(user.id), code: String(body.code ?? '') }))
      }
      if (action === '2fa-disable' && method === 'POST') {
        if (!user) throw new UnauthorizedError()
        return json(await kernel.disableTwoFactor({ collection, id: String(user.id) }))
      }
    }
  }

  // OAuth: GET /:collection/oauth/:provider (start) and …/callback (complete).
  if (segments[1] === 'oauth' && method === 'GET') {
    const provider = segments[2]!
    const providers = kernel.config.oauth ?? []
    const def = providers.find((p) => p.name === provider)
    if (!def) throw new BadRequestError(`No OAuth provider "${provider}" is configured.`)
    const redirectUri = `${url.origin}${apiBase}/${collection}/oauth/${provider}/callback`

    if (segments.length === 3) {
      // CSRF defence: bind a random `state` to an httpOnly, SameSite=Lax cookie.
      // The callback must echo the same value, so a forged callback (login CSRF /
      // session fixation) without the cookie is rejected. For OIDC providers we
      // also bind a one-time `nonce` (replay defence) and a PKCE `code_verifier`
      // (auth-code interception defence) into the SAME cookie — never the URL —
      // so they're inaccessible to JS and to the front channel.
      const state = globalThis.crypto.randomUUID()
      let cookieValue = state
      let location: string
      if (def.needsNonce) {
        const nonce = globalThis.crypto.randomUUID()
        const codeVerifier = pkceVerifier()
        // state.nonce.verifier — none of these tokens contain a '.'.
        cookieValue = `${state}.${nonce}.${codeVerifier}`
        location = def.authorizationUrl({ redirectUri, state, nonce, codeChallenge: pkceChallenge(codeVerifier) })
      } else {
        location = def.authorizationUrl({ redirectUri, state })
      }
      const cookie = `${OAUTH_STATE_COOKIE}=${cookieValue}; HttpOnly; Secure; SameSite=Lax; Path=${apiBase}/${collection}/oauth/${provider}; Max-Age=600`
      return new Response(null, { status: 302, headers: { location, 'set-cookie': cookie } })
    }
    if (segments.length === 4 && segments[3] === 'callback') {
      const code = url.searchParams.get('code')
      if (!code) throw new BadRequestError('Missing OAuth `code`.')
      const returned = url.searchParams.get('state') ?? ''
      const stored = readCookie(request, OAUTH_STATE_COOKIE)
      if (!stored) throw new BadRequestError('Invalid OAuth `state`.')
      const [expectedState, nonce, codeVerifier] = stored.split('.') as [string, string?, string?]
      if (!timingEqual(returned, expectedState)) {
        throw new BadRequestError('Invalid OAuth `state`.')
      }
      // An OIDC provider MUST have nonce + verifier bound; refuse if the cookie
      // was tampered to drop them (which would skip replay/PKCE checks).
      if (def.needsNonce && (!nonce || !codeVerifier)) {
        throw new BadRequestError('Invalid OAuth `state`.')
      }
      const res = json(await kernel.loginWithOAuth({ collection, provider, code, redirectUri, nonce, codeVerifier }))
      // Burn the one-time state cookie.
      res.headers.set(
        'set-cookie',
        `${OAUTH_STATE_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=${apiBase}/${collection}/oauth/${provider}; Max-Age=0`,
      )
      return res
    }
  }

  // /:collection
  if (segments.length === 1) {
    if (method === 'GET') {
      // Time-machine list: `?asOf=<iso>` returns every document's as-of state at that instant.
      const asOf = url.searchParams.get('asOf') ?? undefined
      const result = await kernel.find({
        collection,
        where: parseWhere(url.searchParams),
        sort: url.searchParams.get('sort') ?? undefined,
        limit: toNum(url.searchParams.get('limit')),
        page: toNum(url.searchParams.get('page')),
        ...(asOf !== undefined ? { asOf } : {}),
        ...base,
      })
      // Edge delivery: cacheable only for an anonymous, non-override, published
      // (no draft / no time-travel) list read. Tags = collection + each returned doc.
      const listCacheable = !user && !overrideAccess && !draft && asOf === undefined
      const listDocs = (result as { docs?: Doc[] }).docs ?? []
      return withEdgeHeaders(json(result), kernel, { collection, docs: listDocs, cacheable: listCacheable })
    }
    if (method === 'POST') {
      const collConfig = kernel.config.collectionsBySlug[collection]
      const contentType = request.headers.get('content-type') ?? ''
      // Upload collections accept multipart/form-data with a `file` part.
      if (collConfig?.upload && contentType.includes('multipart/form-data')) {
        // Reject oversized uploads by Content-Length before buffering the body
        // (guards the runtime-agnostic fetch path; the Node adapter also caps).
        const uploadCfg = typeof collConfig.upload === 'object' ? collConfig.upload : {}
        const maxFile = typeof uploadCfg.maxFileSize === 'number' ? uploadCfg.maxFileSize : DEFAULT_MAX_BODY_BYTES
        assertBodyWithinLimit(request, maxFile + 1024 * 1024)
        const form = await request.formData()
        const filePart = form.get('file')
        if (!(filePart instanceof File)) throw new BadRequestError('Expected a "file" part in the form data.')
        const data: Row = {}
        for (const [k, v] of form.entries()) {
          if (k === 'file') continue
          if (k === '_data' && typeof v === 'string') Object.assign(data, JSON.parse(v) as Row)
          else if (typeof v === 'string') data[k] = v
        }
        const doc = await kernel.upload({
          collection,
          file: {
            data: Buffer.from(await filePart.arrayBuffer()),
            name: filePart.name || 'upload',
            mimeType: filePart.type || 'application/octet-stream',
          },
          data,
          ...base,
        })
        return json(doc, 201)
      }
      const data = await readBody(request)
      return json(await kernel.create({ collection, data, ...base }), 201)
    }
    // Bulk operations require an explicit `where` so an unscoped mass write is never accidental.
    if (method === 'PATCH') {
      const where = parseWhere(url.searchParams)
      if (!where) throw new BadRequestError('Bulk update requires a `where` query parameter.')
      const data = await readBody(request)
      return json(await kernel.updateMany({ collection, where, data, ...base }))
    }
    if (method === 'DELETE') {
      const where = parseWhere(url.searchParams)
      if (!where) throw new BadRequestError('Bulk delete requires a `where` query parameter.')
      return json(await kernel.deleteMany({ collection, where, ...base }))
    }
    return methodNotAllowed()
  }

  // /:collection/search?q=...  (reserved subpath; document ids are UUIDs)
  if (segments.length === 2 && segments[1] === 'search' && method === 'GET') {
    const result = await kernel.searchDocs({
      collection,
      query: url.searchParams.get('q') ?? '',
      limit: toNum(url.searchParams.get('limit')),
      ...base,
    })
    return json(result)
  }

  // /:collection/semantic?q=...  (vector search; access-checked load)
  if (segments.length === 2 && segments[1] === 'semantic' && method === 'GET') {
    const result = await kernel.semanticSearch({
      collection,
      query: url.searchParams.get('q') ?? '',
      limit: toNum(url.searchParams.get('limit')),
      ...base,
    })
    return json(result)
  }

  // /:collection/hybrid?q=...  (full-text + semantic, fused with RRF)
  if (segments.length === 2 && segments[1] === 'hybrid' && method === 'GET') {
    const result = await kernel.hybridSearch({
      collection,
      query: url.searchParams.get('q') ?? '',
      limit: toNum(url.searchParams.get('limit')),
      ...base,
    })
    return json(result)
  }

  // POST /:collection/from-template  { template, data? } -> create a document from a named
  // template. The template's `collection` MUST equal this route's `:collection` (a template
  // can't be used to create into a different collection). Runs through the NORMAL create
  // pipeline with the request principal — access, field scope, validation, and the agent
  // draft-only brake all apply. (Reserved subpath; document ids are UUIDs.)
  if (segments.length === 2 && segments[1] === 'from-template' && method === 'POST') {
    const body = await readBody(request)
    const template = typeof body.template === 'string' ? body.template : ''
    if (!template) throw new BadRequestError('A `template` slug is required.')
    // Own-property lookup so an inherited key (`__proto__`/`constructor`) can't resolve to
    // a truthy prototype member — an unknown slug falls through to core's clean 404.
    const tmpl = Object.prototype.hasOwnProperty.call(kernel.config.templatesBySlug, template)
      ? kernel.config.templatesBySlug[template]
      : undefined
    // Reject a slug whose template targets a DIFFERENT collection than this route, so the
    // route's `:collection` is authoritative (a template can't smuggle a cross-collection
    // create).
    if (tmpl && tmpl.collection !== collection) {
      throw new BadRequestError(`Template "${template}" does not belong to collection "${collection}".`)
    }
    const data = (body.data ?? undefined) as Row | undefined
    return json(await kernel.createFromTemplate({ template, ...(data !== undefined ? { data } : {}), ...base }), 201)
  }

  // /:collection/:id
  if (segments.length === 2) {
    const id = segments[1]!
    if (method === 'GET') {
      // Time-machine: `?asOf=<iso>` reconstructs the document as it existed at that instant
      // (latest snapshot <= asOf). Core access-checks + field-strips it exactly like a live
      // read; an unversioned collection / bad timestamp -> a clean 400.
      const asOf = url.searchParams.get('asOf') ?? undefined
      const doc = await kernel.findByID({ collection, id, ...(asOf !== undefined ? { asOf } : {}), ...base })
      if (!doc) throw new NotFoundError()
      // Hand the client a concurrency token (ETag/Last-Modified = current updatedAt) so
      // it can send it back as If-Match on its next save and get a 409 instead of a
      // silent clobber if someone else edited in the meantime.
      // Edge delivery: a response is CACHEABLE only when produced for an ANONYMOUS,
      // non-override, published (no draft / no time-travel) read — otherwise it gets
      // `private, no-store` so a CDN never caches a per-user / point-in-time response.
      const cacheable = !user && !overrideAccess && !draft && asOf === undefined
      return withEdgeHeaders(withConcurrencyHeaders(json(doc), doc), kernel, { collection, doc, cacheable })
    }
    if (method === 'PATCH' || method === 'PUT') {
      const data = await readBody(request)
      // Optimistic concurrency: a conditional save carries the token via If-Match /
      // If-Unmodified-Since, or a body `_expectedUpdatedAt`. Strip the body sentinel so
      // it never reaches the document data. A stale token throws ConflictError -> 409
      // (carrying the current doc) from core.
      const expectedUpdatedAt = expectedUpdatedAtFrom(request, data)
      delete data._expectedUpdatedAt
      const doc = await kernel.update({
        collection,
        id,
        data,
        ...(expectedUpdatedAt != null ? { expectedUpdatedAt } : {}),
        ...base,
      })
      if (!doc) throw new NotFoundError()
      return withConcurrencyHeaders(json(doc), doc)
    }
    if (method === 'DELETE') {
      const doc = await kernel.delete({ collection, id, ...base })
      if (!doc) throw new NotFoundError()
      return json(doc)
    }
    return methodNotAllowed()
  }

  // /:collection/:id/versions  ·  /:collection/:id/publish  ·  /:collection/:id/unpublish
  if (segments.length === 3) {
    const id = segments[1]!
    if (segments[2] === 'versions' && method === 'GET') {
      return json(
        await kernel.findVersions({
          collection,
          id,
          limit: toNum(url.searchParams.get('limit')),
          page: toNum(url.searchParams.get('page')),
          ...base,
        }),
      )
    }
    // Time-machine: the document's change timeline (oldest -> newest), access-checked.
    if (segments[2] === 'history' && method === 'GET') {
      return json(await kernel.history({ collection, id, ...base }))
    }
    // Activity feed: a merged, time-ordered timeline (versions + comments for any reader;
    // reviews + audit for reviewers). Gated on the document's read access.
    if (segments[2] === 'activity' && method === 'GET') {
      const typesParam = url.searchParams.get('types')
      const limit = toNum(url.searchParams.get('limit'))
      return json(
        await kernel.documentActivity({
          collection,
          id,
          ...(typesParam ? { types: typesParam.split(',') as never } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...base,
        }),
      )
    }
    // Time-machine: field-level diff between two points. `from`/`to` are each a versionId or
    // an ISO timestamp. Both are required; only fields the caller may read appear.
    if (segments[2] === 'diff' && method === 'GET') {
      const from = url.searchParams.get('from')
      const to = url.searchParams.get('to')
      if (!from || !to) throw new BadRequestError('Both `from` and `to` query parameters are required.')
      return json(await kernel.diffVersions({ collection, id, from, to, ...base }))
    }
    // Time-machine: restore the document to its state at `?asOf=<iso>` through the normal
    // update path (access + agent brake + validation all apply; no override). Gated like update.
    if (segments[2] === 'restore-as-of' && method === 'POST') {
      const asOf = url.searchParams.get('asOf') ?? (await readBody(request))._asOf
      if (typeof asOf !== 'string') throw new BadRequestError('`asOf` is required (query param or body `_asOf`).')
      const doc = await kernel.restoreAsOf({ collection, id, asOf, ...base })
      if (!doc) throw new NotFoundError()
      return withConcurrencyHeaders(json(doc), doc)
    }
    // GET /:collection/:id/signed-url?ttl= -> mint a signed, expiring capability URL for an
    // upload document's file. Access-checked as the caller (they must be able to read the doc).
    if (segments[2] === 'signed-url' && method === 'GET') {
      const ttlRaw = toNum(url.searchParams.get('ttl'))
      const signedUrl = await kernel.signedAssetUrl({
        collection,
        id,
        ...(ttlRaw !== undefined ? { ttl: ttlRaw } : {}),
        ...base,
      })
      return json({ url: signedUrl })
    }
    if (segments[2] === 'publish' && method === 'POST') {
      const doc = await kernel.publish({ collection, id, ...base })
      if (!doc) throw new NotFoundError()
      return json(doc)
    }
    if (segments[2] === 'unpublish' && method === 'POST') {
      const doc = await kernel.unpublish({ collection, id, ...base })
      if (!doc) throw new NotFoundError()
      return json(doc)
    }
    // POST /:collection/:id/translate { from, to, fields?, overwrite? } -> AI-translate this
    // document's localized fields from `from` into `to` via the configured provider, written
    // through the normal access-checked update (the caller must be able to UPDATE the doc;
    // the agent draft-only brake + strict per-locale validation still apply — a translation
    // never auto-publishes). Unknown/illegal locales are rejected by core (400).
    if (segments[2] === 'translate' && method === 'POST') {
      const body = await readBody(request)
      const doc = await kernel.translateDocument({
        collection,
        id,
        from: String(body.from ?? ''),
        to: String(body.to ?? ''),
        ...(Array.isArray(body.fields) ? { fields: body.fields.map(String) } : {}),
        ...(body.overwrite === true ? { overwrite: true } : {}),
        ...base,
      })
      if (!doc) throw new NotFoundError()
      return withConcurrencyHeaders(json(doc), doc)
    }
    // GET /:collection/:id/geo -> one published doc as GEO-optimized markdown. PUBLIC,
    // published-only: core resolves it as an anonymous principal, so a draft/private id
    // yields null -> 404 (never leaked).
    if (segments[2] === 'geo' && method === 'GET') {
      if (!kernel.config.discoverability.enabled) {
        return json({ error: { code: 'NOT_FOUND', message: 'Discoverability is not enabled.' } }, 404)
      }
      const markdown = await kernel.geoDocument({ collection, id })
      if (markdown == null) throw new NotFoundError()
      return textResponse(markdown, 'text/markdown; charset=utf-8')
    }
    // GET /:collection/:id/jsonld -> one document as a schema.org JSON-LD object, served as
    // `application/ld+json`. Access-checked with the REQUEST principal (anonymous for public
    // SEO embedding), so a draft/private/read-denied doc yields null -> 404 (never leaked).
    if (segments[2] === 'jsonld' && method === 'GET') {
      if (!kernel.config.structuredData.enabled) {
        return json({ error: { code: 'NOT_FOUND', message: 'Structured data is not enabled.' } }, 404)
      }
      const obj = await kernel.jsonLd({ collection, id, ...base })
      if (obj == null) throw new NotFoundError()
      return textResponse(JSON.stringify(obj), 'application/ld+json; charset=utf-8')
    }
    // GET /:collection/:id/graph?depth=&maxNodes= -> the content knowledge graph around a
    // document: a bounded, ACCESS-CHECKED BFS over typed relationships. Resolved with the
    // REQUEST principal, so a node (or even an edge to one) the caller can't read never
    // appears. `depth`/`maxNodes` are graph-specific and clamped in core.
    if (segments[2] === 'graph' && method === 'GET') {
      const result = await kernel.graph({
        collection,
        id,
        depth: toNum(url.searchParams.get('depth')),
        maxNodes: toNum(url.searchParams.get('maxNodes')),
        req: base.req,
        overrideAccess: base.overrideAccess,
      })
      return json(result)
    }
    // GET /:collection/:id/related?limit= -> related content (more-like-this): re-embed the
    // seed and return its nearest neighbours, access-checked with the REQUEST principal so a
    // related doc the caller can't read never appears (and an unreadable seed yields []).
    if (segments[2] === 'related' && method === 'GET') {
      const result = await kernel.relatedContent({
        collection,
        id,
        limit: toNum(url.searchParams.get('limit')),
        ...base,
      })
      return json(result)
    }
    // /:collection/:id/comments -> editorial comments / annotations on a document.
    // AUTH-REQUIRED and gated by the document's READ access in core: a caller who can't read
    // the document gets Forbidden/NotFound (never the comments). The author is recorded from
    // the server-resolved principal ONLY — the client body never names the author.
    //   GET  ?field=&includeResolved= -> the document's comments, oldest -> newest
    //   POST { body, field?, parentId? } -> add a comment (or threaded reply)
    if (segments[2] === 'comments') {
      if (!kernel.config.comments.enabled) {
        return json({ error: { code: 'NOT_FOUND', message: 'Comments are not enabled.' } }, 404)
      }
      if (!user) throw new UnauthorizedError()
      if (method === 'GET') {
        const field = url.searchParams.get('field')
        const includeResolved = url.searchParams.get('includeResolved') === 'true'
        return json({
          comments: await kernel.listComments({
            collection,
            id,
            ...(field ? { field } : {}),
            ...(includeResolved ? { includeResolved: true } : {}),
            req: { user },
          }),
        })
      }
      if (method === 'POST') {
        const body = await readBody(request)
        return json(
          await kernel.addComment({
            collection,
            id,
            body: typeof body.body === 'string' ? body.body : '',
            ...(typeof body.field === 'string' ? { field: body.field } : {}),
            ...(typeof body.parentId === 'string' ? { parentId: body.parentId } : {}),
            req: { user },
          }),
          201,
        )
      }
      return methodNotAllowed()
    }
    return methodNotAllowed()
  }

  // /:collection/:id/versions/:versionId/restore
  if (segments.length === 5 && segments[2] === 'versions' && segments[4] === 'restore' && method === 'POST') {
    const doc = await kernel.restoreVersion({ collection, id: segments[1]!, versionId: segments[3]!, ...base })
    if (!doc) throw new NotFoundError()
    return json(doc)
  }

  return json({ error: { code: 'NOT_FOUND', message: `No route for ${url.pathname}` } }, 404)
}

// The base logger; each request gets a child tagged with its request id.
const baseLogger = createLogger()
type ServerLogger = ReturnType<typeof createLogger>

/** A request-scoped logger: every line is tagged with the request id for tracing. */
function requestScopedLogger(base: ServerLogger, requestId: string): ServerLogger {
  const tag = (m: string) => `[req:${requestId}] ${m}`
  return {
    debug: (m, meta) => base.debug(tag(m), meta),
    info: (m, meta) => base.info(tag(m), meta),
    warn: (m, meta) => base.warn(tag(m), meta),
    error: (m, meta) => base.error(tag(m), meta),
  }
}

/**
 * Run a matched custom endpoint through the shared pipeline: authorize (explicit
 * rule, else authenticated-only), validate declared input (failures become a
 * ValidationError), invoke the handler with a typed context, and serialize the
 * result. Thrown KernelErrors propagate to the central error handler.
 */
async function runEndpoint(
  kernel: Kernel,
  request: Request,
  url: URL,
  endpoint: EndpointConfig,
  params: Record<string, string>,
  auth: { user: AuthUser | null; locale?: string; audience?: string },
): Promise<Response> {
  const { user } = auth
  const requestId = randomUUID()
  const logger = requestScopedLogger(baseLogger, requestId)
  const defaultLocale = kernel.config.localization ? kernel.config.localization.defaultLocale : 'en'
  const req: RequestContext = {
    user,
    locale: auth.locale ?? defaultLocale,
    fallbackLocale: false,
    ...(auth.audience ? { audience: auth.audience } : {}),
    context: { requestId },
  }

  // HTTP-bound: read the JSON body only when the endpoint declares a body validator.
  // Enforce the same size ceiling core JSON routes use — check the declared
  // Content-Length first, then the actual bytes (a chunked request omits
  // Content-Length, so the header alone isn't enough on the fetch/edge path).
  let body: unknown
  if (endpoint.input?.body) {
    assertBodyWithinLimit(request, MAX_JSON_BODY_BYTES)
    let text: string
    try {
      text = await request.text()
    } catch {
      throw new BadRequestError('Request body must be valid JSON.')
    }
    if (text.length > MAX_JSON_BODY_BYTES) throw new PayloadTooLargeError('Request body too large.')
    if (text) {
      try {
        body = JSON.parse(text)
      } catch {
        throw new BadRequestError('Request body must be valid JSON.')
      }
    }
  }
  const query = Object.fromEntries(url.searchParams.entries())

  // Authorize + validate input + run the handler via the shared transport-agnostic
  // core. The handler still sees the real `request` because we route through ctx
  // below — here we pass the parsed parts and let invokeEndpoint enforce access and
  // re-validate (identical ValidationError shape).
  const result = await invokeEndpoint(kernel, endpoint, {
    input: { params, query, body },
    req,
    logger,
    request,
  })
  if (result instanceof Response) return result
  return json(result ?? null)
}

// Bound concurrent SSE streams per process (DoS guard): each holds an open connection +
// a bus listener. A new stream past the cap is refused with 503 rather than unbounded.
const MAX_SSE_STREAMS = 1000
let openStreams = 0

// SSE heartbeat interval: a comment frame keeps the connection (and any proxy) alive.
const SSE_HEARTBEAT_MS = 25_000

/**
 * A live Server-Sent-Events stream over the change feed. On connect it subscribes to the
 * in-process bus; for each event it applies the SAME access filter as the pull feed (per
 * this connection's principal) and writes an SSE frame `id: <seq>\n data: <metadata>\n\n`.
 * A `Last-Event-ID` header (or `?lastEventId=`) replays any changes missed since that seq
 * via the access-filtered pull feed before live delivery begins, so a reconnect loses
 * nothing. A periodic `: ping` comment is a heartbeat. On cancel/disconnect the listener
 * is removed and the stream count decremented. Auth is enforced by the caller.
 */
function changeStream(kernel: Kernel, request: Request, url: URL, user: AuthUser): Response {
  if (openStreams >= MAX_SSE_STREAMS) {
    return json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Too many open streams.' } }, 503)
  }
  const collectionParam = url.searchParams.get('collection') ?? undefined
  // Resume point: Last-Event-ID header (standard EventSource reconnect) or ?lastEventId=.
  const lastEventIdRaw = request.headers.get('last-event-id') ?? url.searchParams.get('lastEventId')
  const lastEventId = toNum(lastEventIdRaw)

  const encoder = new TextEncoder()
  let unsubscribe: (() => void) | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let closed = false
  // Shared between start() and cancel() without referencing `stream` (which is in its TDZ
  // while the ReadableStream constructor runs start()).
  const cleanupRef: { fn: () => void } = { fn: () => {} }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      openStreams++
      const send = (chunk: string): void => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(chunk))
        } catch {
          // Controller already closed (client gone) — stop pushing.
          cleanup()
        }
      }
      const frame = (event: {
        seq: number
        collection: string
        documentId: string
        event: string
        at: string
        principalType: string
      }): string => `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`

      const cleanup = (): void => {
        if (closed) return
        closed = true
        if (unsubscribe) unsubscribe()
        if (heartbeat) clearInterval(heartbeat)
        openStreams = Math.max(0, openStreams - 1)
      }
      // Expose cleanup to cancel() below.
      cleanupRef.fn = cleanup

      // Open the stream with a comment so proxies flush headers immediately.
      send(': connected\n\n')

      // Replay anything missed since Last-Event-ID via the access-filtered pull feed, so a
      // reconnect resumes exactly where it left off. Bounded by the pull feed's own limit.
      let resumeCursor = lastEventId
      if (lastEventId !== undefined) {
        try {
          const missed = await kernel.changes({
            since: lastEventId,
            ...(collectionParam ? { collection: collectionParam } : {}),
            req: { user },
          })
          for (const ev of missed.changes) send(frame(ev))
          resumeCursor = missed.cursor
        } catch {
          // Replay is best-effort; live delivery below still proceeds.
        }
      }

      // Live delivery: subscribe to the bus, access-filter each event for THIS principal,
      // and frame the visible ones. Events at/below the replayed cursor are skipped so a
      // reconnect never double-delivers. A throwing/slow filter is isolated per event.
      try {
        unsubscribe = kernel.subscribe((event) => {
          void (async () => {
            if (closed) return
            if (resumeCursor !== undefined && event.seq <= resumeCursor) return
            if (collectionParam && event.collection !== collectionParam) return
            let visible = false
            try {
              visible = await kernel.changeVisibleTo(event, { req: { user } })
            } catch {
              visible = false
            }
            if (visible) send(frame(event))
          })()
        })
      } catch {
        // Listener bound exceeded — close cleanly rather than hang.
        cleanup()
        try {
          controller.close()
        } catch {
          /* already closed */
        }
        return
      }

      heartbeat = setInterval(() => send(': ping\n\n'), SSE_HEARTBEAT_MS)
      // Unref so the heartbeat timer never keeps the process alive on its own.
      ;(heartbeat as unknown as { unref?: () => void }).unref?.()
    },
    cancel() {
      cleanupRef.fn()
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  })
}

async function resolveAuth(
  kernel: Kernel,
  options: HandlerOptions,
  request: Request,
): Promise<{ user: AuthUser | null; overrideAccess: boolean; viaCookie: boolean }> {
  const auth = request.headers.get('authorization')
  if (options.apiKey && auth?.startsWith('Bearer ') && timingEqual(auth.slice('Bearer '.length), options.apiKey)) {
    return { user: { id: 'system', roles: ['admin'], collection: 'system' }, overrideAccess: true, viaCookie: false }
  }
  // Configured agents: a non-human, access-controlled principal. Resolved from a
  // bearer token (Authorization: Bearer <token>, or x-kernel-agent: <token>) and run
  // with overrideAccess:FALSE — agents go through the full access chain, NEVER the
  // god-mode apiKey path above. The brake in core forbids them publishing; their
  // fieldScope restricts which fields they may write. Checked after the apiKey so a
  // misconfigured shared secret can't be shadowed, but before user tokens.
  const agentToken = auth?.startsWith('Bearer ')
    ? auth.slice('Bearer '.length)
    : (request.headers.get('x-kernel-agent') ?? null)
  if (agentToken) {
    const agent = matchAgent(kernel.config.agents, agentToken)
    if (agent) {
      return {
        user: {
          id: agent.id,
          principalType: 'agent',
          roles: agent.roles ?? [],
          ...(agent.fieldScope ? { fieldScope: agent.fieldScope } : {}),
          collection: undefined,
        },
        overrideAccess: false,
        viaCookie: false,
      }
    }
  }
  if (options.getUser) {
    const user = await options.getUser(request)
    if (user) return { user, overrideAccess: false, viaCookie: false }
  }
  // Per-collection API keys: `Authorization: <collection> API-Key <key>`.
  const apiKeyMatch = auth?.match(/^(\w+) API-Key (\S{1,512})$/)
  if (apiKeyMatch) {
    const user = await kernel.authenticateAPIKey(apiKeyMatch[1]!, apiKeyMatch[2]!)
    if (user) return { user, overrideAccess: false, viaCookie: false }
  }
  if (auth?.startsWith('Bearer ')) {
    const user = await kernel.authenticate(auth.slice('Bearer '.length))
    if (user) return { user, overrideAccess: false, viaCookie: false }
  }
  // Cookie session (admin). Tracked separately so unsafe cookie-auth requests can
  // be CSRF-checked — a Bearer token cannot be sent cross-site, but a cookie can.
  if (options.cookieAuth !== false) {
    const cookieToken = readCookie(request, SESSION_COOKIE)
    if (cookieToken) {
      const user = await kernel.authenticate(cookieToken)
      if (user) return { user, overrideAccess: false, viaCookie: true }
    }
  }
  return { user: null, overrideAccess: false, viaCookie: false }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * CSRF guard for cookie-authenticated mutations. A cross-site `fetch`/form POST
 * carries the cookie (unless SameSite blocks it) but the browser always stamps an
 * `Origin` from the attacker's site, so a present-and-mismatched Origin on an
 * unsafe, cookie-authenticated request is rejected. Bearer/API-key callers are
 * exempt (their credential can't be sent cross-site). Returns true if allowed.
 */
function passesCsrf(request: Request, viaCookie: boolean): boolean {
  if (!viaCookie || SAFE_METHODS.has(request.method)) return true
  const origin = request.headers.get('origin')
  if (!origin) return true // SameSite=Lax already blocks cross-site cookie sends.
  try {
    return new URL(origin).host === new URL(request.url).host
  } catch {
    return false
  }
}

/** Ceiling for JSON request bodies on the runtime-agnostic fetch path (the Node
 *  adapter has its own streaming cap). Multipart uploads use a larger cap. */
const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024

/** Reject by Content-Length before reading the stream, so a host that wires the
 *  fetch handler directly (serverless/edge) still gets a body-size guard. */
function assertBodyWithinLimit(request: Request, limit: number): void {
  const len = Number(request.headers.get('content-length'))
  if (Number.isFinite(len) && len > limit) {
    throw new PayloadTooLargeError('Request body too large.')
  }
}

async function readBody(request: Request): Promise<Row> {
  assertBodyWithinLimit(request, MAX_JSON_BODY_BYTES)
  let parsed: unknown
  try {
    parsed = await request.json()
  } catch {
    throw new BadRequestError('Request body must be valid JSON.')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BadRequestError('Request body must be a JSON object.')
  }
  return parsed as Row
}

// ---------------------------------------------------------------------------
// Query string -> Where
// ---------------------------------------------------------------------------

function coerce(value: string): unknown {
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === 'null') return null
  if (value !== '' && /^-?\d+(\.\d+)?$/.test(value)) return Number(value)
  return value
}

// Keys that would let a crafted `where` reach Object.prototype (prototype
// pollution) — rejected on every path before any object walk.
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
// Bounds on a client-supplied `where` so a deeply nested or enormous filter
// can't blow the stack / pin the CPU in the recursive query matcher (DoS).
const MAX_WHERE_DEPTH = 12
const MAX_WHERE_NODES = 500

function setDeep(root: Record<string, unknown>, path: string[], value: unknown): void {
  for (const key of path) {
    if (FORBIDDEN_KEYS.has(key)) throw new BadRequestError('Invalid `where` key.')
  }
  let node: Record<string, unknown> = root
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!
    if (typeof node[key] !== 'object' || node[key] === null) node[key] = {}
    node = node[key] as Record<string, unknown>
  }
  node[path[path.length - 1]!] = value
}

/** Reject dangerous keys and over-large/over-deep structures in a parsed `where`. */
function assertSafeWhere(value: unknown, depth: number, counter: { n: number }): void {
  if (depth > MAX_WHERE_DEPTH) throw new BadRequestError('`where` is nested too deeply.')
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) {
      if (++counter.n > MAX_WHERE_NODES) throw new BadRequestError('`where` is too large.')
      assertSafeWhere(item, depth + 1, counter)
    }
    return
  }
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) throw new BadRequestError('Invalid `where` key.')
    if (++counter.n > MAX_WHERE_NODES) throw new BadRequestError('`where` is too large.')
    assertSafeWhere((value as Record<string, unknown>)[key], depth + 1, counter)
  }
}

export function parseWhere(params: URLSearchParams): Where | undefined {
  const raw = params.get('where')
  if (raw) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new BadRequestError('`where` must be valid JSON.')
    }
    assertSafeWhere(parsed, 0, { n: 0 })
    return parsed as Where
  }
  const root: Record<string, unknown> = {}
  let found = false
  for (const [key, value] of params) {
    if (!key.startsWith('where[')) continue
    found = true
    const path = key
      .slice('where'.length)
      .split(/[[\]]+/)
      .filter(Boolean)
    setDeep(root, path, coerce(value))
  }
  if (!found) return undefined
  // Apply the same depth/size bounds to the bracket form as the JSON form.
  assertSafeWhere(root, 0, { n: 0 })
  return root as Where
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/** The admin convention the core access layer trusts: a `roles` list with 'admin'. */
function isAdmin(user: AuthUser): boolean {
  return Array.isArray(user.roles) && user.roles.includes('admin')
}

/**
 * May this principal use the review inbox? Reviewers approve/publish agent content but
 * aren't always admins, so an `editor` role qualifies too. An AGENT is never a reviewer
 * (the whole point is a human approves agent work) — its writes are gated elsewhere, but
 * we also refuse it the inbox surface here. The publish access gate still independently
 * rejects an approve from anyone lacking publish access, so this is the coarse door only.
 */
function isReviewer(user: AuthUser): boolean {
  if (user.principalType === 'agent') return false
  return Array.isArray(user.roles) && (user.roles.includes('admin') || user.roles.includes('editor'))
}

/** Build a `Where` for the audit log from the supported query params. Returns
 *  undefined when no filter is supplied (the whole, paginated log). */
function auditWhere(q: URLSearchParams): Where | undefined {
  const and: Where[] = []
  const collection = q.get('collection')
  if (collection) and.push({ collection: { equals: collection } })
  const principal = q.get('principal')
  if (principal) and.push({ principalId: { equals: principal } })
  const action = q.get('action')
  if (action) and.push({ action: { equals: action } })
  const from = q.get('from')
  if (from) and.push({ at: { greater_than_equal: from } })
  const to = q.get('to')
  if (to) and.push({ at: { less_than_equal: to } })
  if (and.length === 0) return undefined
  return and.length === 1 ? and[0] : { and }
}

const AUDIT_CSV_COLUMNS = [
  'id',
  'at',
  'action',
  'collection',
  'documentId',
  'principalId',
  'principalType',
  'fields',
  'meta',
] as const

/** RFC 4180 field escaping: wrap in quotes and double any embedded quote when the
 *  value contains a comma, quote, or newline. */
function csvCell(value: unknown): string {
  let s: string
  if (value === null || value === undefined) s = ''
  else if (typeof value === 'object') s = JSON.stringify(value)
  else s = String(value)
  // CSV injection guard: a cell beginning with = + - @ (or a tab/CR) is treated as a
  // formula by Excel/Sheets. Audit cells carry user-controlled strings (field names,
  // ids), so prefix a single quote to neutralize execution on export.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

function auditCsvResponse(docs: AuditDoc[]): Response {
  const lines = [AUDIT_CSV_COLUMNS.join(',')]
  for (const doc of docs) {
    lines.push(AUDIT_CSV_COLUMNS.map((col) => csvCell((doc as Record<string, unknown>)[col])).join(','))
  }
  return new Response(lines.join('\r\n'), {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="audit-log.csv"',
    },
  })
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

/** A plain-text/markdown body response (llms.txt / geo). `nosniff` is added by the
 *  shared security-header pass; the explicit content-type keeps AI crawlers happy. */
function textResponse(body: string, contentType: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': contentType } })
}

/**
 * Resolve the optimistic-concurrency token a client sends for a conditional update:
 * the strong `If-Match` ETag (preferred), else the `If-Unmodified-Since` date, else a
 * body `_expectedUpdatedAt`. The ETag is the JSON-quoted `updatedAt` we emit on reads
 * (see {@link withConcurrencyHeaders}); we strip the quotes/weak prefix to recover the
 * raw token. Returns undefined when none is present (last-write-wins, the default).
 */
function expectedUpdatedAtFrom(request: Request, body?: Row): string | undefined {
  const ifMatch = request.headers.get('if-match')
  if (ifMatch && ifMatch.trim() !== '*') {
    return ifMatch.trim().replace(/^W\//, '').replace(/^"|"$/g, '')
  }
  const ifUnmodified = request.headers.get('if-unmodified-since')
  if (ifUnmodified) return ifUnmodified
  if (body && typeof body._expectedUpdatedAt === 'string') return body._expectedUpdatedAt
  return undefined
}

/** Stamp the current `updatedAt` as `ETag` + `Last-Modified` on a successful read/write
 *  so a client always has the freshest concurrency token to send back on its next save. */
function withConcurrencyHeaders(res: Response, doc: unknown): Response {
  const updatedAt = doc && typeof doc === 'object' ? (doc as Row).updatedAt : undefined
  if (updatedAt != null) {
    res.headers.set('etag', `"${String(updatedAt)}"`)
    res.headers.set('last-modified', String(updatedAt))
  }
  return res
}

/**
 * Stamp edge-delivery cache headers on a content GET response. This is the
 * SECURITY-CRITICAL chokepoint: aggressive (`s-maxage`/public) caching is set ONLY when
 * the response is CACHEABLE — i.e. produced for an ANONYMOUS principal (`!user`) over a
 * publicly-readable read (`!overrideAccess`). For such a response we set the configured
 * public `Cache-Control` plus the surrogate-key header listing the response's cache tags
 * (derived from the RETURNED, access-checked docs only, so no hidden id leaks).
 *
 * For ANY authenticated or access-scoped (or trusted-override) response we instead set
 * `Cache-Control: private, no-store` and emit NO tag header — so a CDN is never told to
 * cache a per-user / private response at the edge (a wrong header = a content leak).
 *
 * No-op (returns the response untouched) when edge delivery is disabled.
 */
function withEdgeHeaders(
  res: Response,
  kernel: Kernel,
  args: {
    collection: string
    /** A single-document response (its returned doc), for detail routes. */
    doc?: Doc | null
    /** A list response's returned docs, for collection routes. */
    docs?: Doc[]
    /** True only when the response was produced for an anonymous, non-override read. */
    cacheable: boolean
  },
): Response {
  if (!kernel.config.edge.enabled) return res
  if (!args.cacheable) {
    // Authenticated / scoped / trusted response: NEVER hand it to a shared cache.
    res.headers.set('cache-control', 'private, no-store')
    return res
  }
  res.headers.set('cache-control', kernel.config.edge.cacheControl)
  const tags = args.docs
    ? kernel.cacheTags({ collection: args.collection, docs: args.docs })
    : args.doc
      ? kernel.cacheTags({ collection: args.collection, id: String(args.doc.id), doc: args.doc })
      : kernel.cacheTags({ collection: args.collection })
  const header = cacheTagsHeader(tags)
  if (header) res.headers.set(kernel.config.edge.tagHeader, header)
  return res
}

function methodNotAllowed(): Response {
  return json({ error: { code: 'BAD_REQUEST', message: 'Method not allowed.' } }, 405)
}

/** Pick the response locale from `?locale` then `Accept-Language`, else 'en'. */
function localeFromRequest(request?: Request): string {
  if (!request) return 'en'
  try {
    const q = new URL(request.url).searchParams.get('locale')
    if (q) return q
  } catch {
    // ignore malformed URL
  }
  const header = request.headers.get('accept-language')
  if (header) {
    const first = header.split(',')[0]?.trim()
    if (first) return first
  }
  return 'en'
}

function errorResponse(err: unknown, request?: Request): Response {
  if (isKernelError(err)) {
    const payload = err.toJSON()
    // Render the localized message at the boundary when the error declares a key,
    // so throw sites stay locale-agnostic. Falls back to the baked-in message.
    if (err.messageKey) {
      payload.error.message = renderErrorMessage(err.messageKey, localeFromRequest(request), err.context, err.message)
    }
    const response = json(payload, err.status)
    const retryAfter = (err as { retryAfter?: unknown }).retryAfter
    if (typeof retryAfter === 'number') response.headers.set('retry-after', String(retryAfter))
    return response
  }
  // Never leak internals.
  console.error('[kernel] unhandled error:', err)
  return json({ error: { code: 'INTERNAL', message: 'Internal server error.' } }, 500)
}

function withCors(response: Response, options: HandlerOptions, request: Request): Response {
  if (!options.cors) return response
  const origin = request.headers.get('origin')

  // Credentials may only ride on an origin that came from an explicit allow-list.
  // `cors: true` reflects any origin, so it MUST NOT carry credentials — pairing a
  // reflected/wildcard origin with allow-credentials lets any site read an
  // authenticated user's responses. Use an allow-list array when you need cookies.
  let allow: string | null = null
  let credentials = false
  if (Array.isArray(options.cors)) {
    if (origin && options.cors.includes(origin)) {
      allow = origin
      credentials = true
    }
  } else {
    // options.cors === true
    allow = origin ?? '*'
  }

  if (!allow) return response
  response.headers.set('access-control-allow-origin', allow)
  if (credentials) response.headers.set('access-control-allow-credentials', 'true')
  response.headers.set('access-control-allow-headers', 'Content-Type, Authorization')
  response.headers.set('access-control-allow-methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS')
  response.headers.set('vary', 'Origin')
  return response
}

function toNum(value: string | null): number | undefined {
  if (value === null) return undefined
  const n = Number(value)
  return Number.isNaN(n) ? undefined : n
}

// ---------------------------------------------------------------------------
// Node http adapter
// ---------------------------------------------------------------------------

/** Default ceiling on a single request body (covers uploads); overridable. */
export const DEFAULT_MAX_BODY_BYTES = 50 * 1024 * 1024

// Methods the WHATWG Request constructor refuses to build (a TypeError), which
// must be answered with 405 rather than bubbling up as a 500.
const FORBIDDEN_METHODS = new Set(['TRACE', 'TRACK', 'CONNECT'])

export function toNodeListener(handler: RequestHandler, opts: { maxBodyBytes?: number } = {}) {
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  return (req: IncomingMessage, res: ServerResponse): void => {
    const chunks: Buffer[] = []
    let size = 0
    let aborted = false
    req.on('data', (chunk: Buffer) => {
      if (aborted) return
      size += chunk.length
      // Reject oversized bodies before buffering them all into memory (DoS).
      if (size > maxBodyBytes) {
        aborted = true
        res.statusCode = 413
        res.setHeader('content-type', 'application/json')
        res.setHeader('x-content-type-options', 'nosniff')
        res.end(JSON.stringify({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large.' } }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', () => {
      res.statusCode = 400
      res.end()
    })
    req.on('end', () => {
      if (aborted) return
      void (async () => {
        const headers = new Headers()
        for (const [key, value] of Object.entries(req.headers)) {
          if (typeof value === 'string') headers.set(key, value)
          else if (Array.isArray(value)) headers.set(key, value.join(', '))
        }
        const url = `http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`
        const method = req.method ?? 'GET'
        // The WHATWG Request constructor throws on the forbidden methods
        // (TRACE/TRACK/CONNECT), which would otherwise surface as a 500. Reject
        // them up front with a proper 405 (no body is ever echoed, so no XST).
        if (FORBIDDEN_METHODS.has(method.toUpperCase())) {
          res.statusCode = 405
          res.setHeader('content-type', 'application/json')
          res.setHeader('x-content-type-options', 'nosniff')
          res.setHeader('allow', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS')
          res.end(JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'Method not allowed.' } }))
          return
        }
        // Expose the socket peer address for rate limiting. A client cannot set
        // this header itself (we overwrite any incoming value); x-forwarded-for is
        // only consulted when the operator opts into trustProxy.
        const remote = req.socket?.remoteAddress
        if (remote) headers.set(HEADER_REMOTE_ADDR, remote)
        else headers.delete(HEADER_REMOTE_ADDR)
        const hasBody = method !== 'GET' && method !== 'HEAD' && chunks.length > 0
        const request = new Request(url, {
          method,
          headers,
          body: hasBody ? Buffer.concat(chunks) : undefined,
        })
        try {
          const response = await handler(request)
          res.statusCode = response.status
          response.headers.forEach((value, key) => res.setHeader(key, value))
          const body = Buffer.from(await response.arrayBuffer())
          res.end(body)
        } catch (err) {
          console.error('[kernel] listener error:', err)
          res.statusCode = 500
          res.setHeader('content-type', 'application/json')
          res.setHeader('x-content-type-options', 'nosniff')
          res.end(JSON.stringify({ error: { code: 'INTERNAL', message: 'Internal server error.' } }))
        }
      })()
    })
  }
}

export interface ServeOptions extends HandlerOptions {
  port?: number
  /** Max bytes accepted for a single request body. Defaults to 50 MB. */
  maxBodyBytes?: number
}

export interface RunningServer {
  url: string
  port: number
  close: () => Promise<void>
}

// Rate-limiting types and helpers, surfaced so embedders can supply a shared
// store (multi-node) or a custom client-key resolver (behind a proxy/platform).
export { memoryRateLimitStore } from './rate-limit'
export type { RateLimitOptions, RateLimitStore, RateLimitResult } from './rate-limit'

export async function serve(kernel: Kernel, options: ServeOptions = {}): Promise<RunningServer> {
  const handler = createRequestHandler(kernel, options)
  const server = createServer(toNodeListener(handler, { maxBodyBytes: options.maxBodyBytes }))
  const requested = options.port ?? 3000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(requested, () => resolve())
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : requested
  return {
    url: `http://localhost:${port}`,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
