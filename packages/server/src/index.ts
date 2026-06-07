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
  parseEndpointInput,
  renderErrorMessage,
  setupRuntime,
  KERNEL_VERSION,
} from '@kernel/core'
import type { EndpointConfig, RequestContext } from '@kernel/core'
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
  const { pathname } = new URL(request.url)
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

    // Re-check access by resolving the document with the caller's identity.
    const { user, overrideAccess } = await resolveAuth(kernel, options, request)
    let allowed = false
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
  const depth = toNum(url.searchParams.get('depth'))
  const draft = url.searchParams.get('draft') === 'true'
  const base = {
    req: { user, ...(locale ? { locale } : {}) },
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

  // /_config -> serializable admin schema descriptor
  if (segments.length === 1 && segments[0] === '_config') {
    return json(describeConfig(kernel.config))
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

  // Custom endpoints (config.endpoints) — matched before the generic collection
  // CRUD so a module can extend or intentionally override the resource space.
  // Access, validation, and errors all flow through the same pipeline as core.
  const customEndpoints = kernel.config.endpoints ?? []
  if (customEndpoints.length > 0) {
    const match = matchEndpoint(customEndpoints, method, segments)
    if (match) return runEndpoint(kernel, request, url, match.endpoint, match.params, { user, locale })
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
      // session fixation) without the cookie is rejected.
      const state = globalThis.crypto.randomUUID()
      const location = def.authorizationUrl({ redirectUri, state })
      const cookie = `${OAUTH_STATE_COOKIE}=${state}; HttpOnly; Secure; SameSite=Lax; Path=${apiBase}/${collection}/oauth/${provider}; Max-Age=600`
      return new Response(null, { status: 302, headers: { location, 'set-cookie': cookie } })
    }
    if (segments.length === 4 && segments[3] === 'callback') {
      const code = url.searchParams.get('code')
      if (!code) throw new BadRequestError('Missing OAuth `code`.')
      const returned = url.searchParams.get('state') ?? ''
      const expected = readCookie(request, OAUTH_STATE_COOKIE)
      if (!expected || !timingEqual(returned, expected)) {
        throw new BadRequestError('Invalid OAuth `state`.')
      }
      const res = json(await kernel.loginWithOAuth({ collection, provider, code, redirectUri }))
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
      const result = await kernel.find({
        collection,
        where: parseWhere(url.searchParams),
        sort: url.searchParams.get('sort') ?? undefined,
        limit: toNum(url.searchParams.get('limit')),
        page: toNum(url.searchParams.get('page')),
        ...base,
      })
      return json(result)
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

  // /:collection/:id
  if (segments.length === 2) {
    const id = segments[1]!
    if (method === 'GET') {
      const doc = await kernel.findByID({ collection, id, ...base })
      if (!doc) throw new NotFoundError()
      return json(doc)
    }
    if (method === 'PATCH' || method === 'PUT') {
      const data = await readBody(request)
      const doc = await kernel.update({ collection, id, data, ...base })
      if (!doc) throw new NotFoundError()
      return json(doc)
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
  auth: { user: AuthUser | null; locale?: string },
): Promise<Response> {
  const { user } = auth
  const requestId = randomUUID()
  const logger = requestScopedLogger(baseLogger, requestId)
  const defaultLocale = kernel.config.localization ? kernel.config.localization.defaultLocale : 'en'
  const req: RequestContext = {
    user,
    locale: auth.locale ?? defaultLocale,
    fallbackLocale: false,
    context: { requestId },
  }

  // Authorize: explicit access rule, else secure-by-default (authenticated only).
  const allowed = endpoint.access ? await endpoint.access({ req, request }) : Boolean(user)
  if (!allowed) throw user ? new ForbiddenError() : new UnauthorizedError()

  // Read the JSON body only when the endpoint declares a body validator. Enforce
  // the same size ceiling core JSON routes use — check the declared Content-Length
  // first, then the actual bytes (a chunked request omits Content-Length, so the
  // header alone isn't enough on the fetch/edge path).
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
  const input = parseEndpointInput(endpoint, { params, query, body }) as {
    params: unknown
    query: unknown
    body: unknown
  }

  const result = await endpoint.handler({
    input,
    ctx: { req, user, local: kernel, logger, request },
  })
  if (result instanceof Response) return result
  return json(result ?? null)
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

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
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
