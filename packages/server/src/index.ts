/**
 * @kernel/server — a web-standard (Request -> Response) handler that exposes the
 * Kernel Local API over REST, plus a Node http adapter. The fetch handler is the
 * exact shape a TanStack Start server route / server function wraps.
 */
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AuthUser, Kernel, Row, Where } from '@kernel/core'
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  describeConfig,
  isKernelError,
} from '@kernel/core'
import { createGraphQL } from '@kernel/graphql'
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
  const tags = scripts.map((src) => `<script src="${src.replace(/"/g, '&quot;')}" type="module"></script>`).join('')
  return ADMIN_HTML.includes('</body>') ? ADMIN_HTML.replace('</body>', `${tags}</body>`) : ADMIN_HTML + tags
}

type RequestHandler = (request: Request) => Promise<Response>

export function createRequestHandler(kernel: Kernel, options: HandlerOptions = {}): RequestHandler {
  const apiBase = kernel.config.routes.api
  const adminBase = adminBaseOf(options)
  return async function handle(request: Request): Promise<Response> {
    if (request.method === 'OPTIONS') return withCors(new Response(null, { status: 204 }), options, request)

    // Built-in admin UI (same-origin HTML shell). The SPA decides setup/login/
    // dashboard from auth state, so every admin path returns the same document.
    if (adminBase && request.method === 'GET') {
      const { pathname } = new URL(request.url)
      if (pathname === '/login' || pathname === adminBase || pathname.startsWith(adminBase + '/')) {
        return withCors(html(adminShell(options)), options, request)
      }
    }

    // Local-disk delivery: stream stored bytes from the adapter's servePath.
    const fileResponse = await maybeServeFile(kernel, options, request)
    if (fileResponse) return withCors(fileResponse, options, request)

    try {
      const response = await route(kernel, options, request, apiBase)
      return withCors(response, options, request)
    } catch (err) {
      return withCors(errorResponse(err), options, request)
    }
  }
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
      return new Response(bytes, {
        status: 200,
        headers: {
          'content-type': EXT_MIME[ext] ?? 'application/octet-stream',
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
  const { user, overrideAccess } = await resolveAuth(kernel, options, request)
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

    // GET /_admin/status -> is first-run setup needed? (public, leaks nothing)
    if (segments[1] === 'status' && segments.length === 2 && method === 'GET') {
      const needsSetup = slug ? (await kernel.count({ collection: slug, overrideAccess: true })) === 0 : false
      return json({ needsSetup, authCollection: slug })
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
      return json(await kernel.login({ collection: slug, email, password }), 201)
    }

    return json({ error: { code: 'NOT_FOUND', message: `No route for ${url.pathname}` } }, 404)
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
        return json(
          await kernel.login({
            collection,
            email: String(body.email ?? ''),
            password: String(body.password ?? ''),
            ...(body.code !== undefined ? { code: String(body.code) } : {}),
          }),
        )
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
        return json(
          await kernel.resetPassword({
            collection,
            token: String(body.token ?? ''),
            password: String(body.password ?? ''),
          }),
        )
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
      // Note: CSRF `state` validation needs a session store — tracked as a follow-up.
      const location = def.authorizationUrl({ redirectUri, state: globalThis.crypto.randomUUID() })
      return new Response(null, { status: 302, headers: { location } })
    }
    if (segments.length === 4 && segments[3] === 'callback') {
      const code = url.searchParams.get('code')
      if (!code) throw new BadRequestError('Missing OAuth `code`.')
      return json(await kernel.loginWithOAuth({ collection, provider, code, redirectUri }))
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

async function resolveAuth(
  kernel: Kernel,
  options: HandlerOptions,
  request: Request,
): Promise<{ user: AuthUser | null; overrideAccess: boolean }> {
  const auth = request.headers.get('authorization')
  if (options.apiKey && auth === `Bearer ${options.apiKey}`) {
    return { user: { id: 'system', roles: ['admin'], collection: 'system' }, overrideAccess: true }
  }
  if (options.getUser) {
    const user = await options.getUser(request)
    if (user) return { user, overrideAccess: false }
  }
  // Per-collection API keys: `Authorization: <collection> API-Key <key>`.
  const apiKeyMatch = auth?.match(/^(\w+) API-Key (.+)$/)
  if (apiKeyMatch) {
    const user = await kernel.authenticateAPIKey(apiKeyMatch[1]!, apiKeyMatch[2]!)
    if (user) return { user, overrideAccess: false }
  }
  if (auth?.startsWith('Bearer ')) {
    const user = await kernel.authenticate(auth.slice('Bearer '.length))
    if (user) return { user, overrideAccess: false }
  }
  return { user: null, overrideAccess: false }
}

async function readBody(request: Request): Promise<Row> {
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

function setDeep(root: Record<string, unknown>, path: string[], value: unknown): void {
  let node: Record<string, unknown> = root
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!
    if (typeof node[key] !== 'object' || node[key] === null) node[key] = {}
    node = node[key] as Record<string, unknown>
  }
  node[path[path.length - 1]!] = value
}

export function parseWhere(params: URLSearchParams): Where | undefined {
  const raw = params.get('where')
  if (raw) {
    try {
      return JSON.parse(raw) as Where
    } catch {
      throw new BadRequestError('`where` must be valid JSON.')
    }
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
  return found ? (root as Where) : undefined
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

function errorResponse(err: unknown): Response {
  if (isKernelError(err)) {
    const response = json(err.toJSON(), err.status)
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

export function toNodeListener(handler: RequestHandler) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('error', () => {
      res.statusCode = 400
      res.end()
    })
    req.on('end', () => {
      void (async () => {
        const headers = new Headers()
        for (const [key, value] of Object.entries(req.headers)) {
          if (typeof value === 'string') headers.set(key, value)
          else if (Array.isArray(value)) headers.set(key, value.join(', '))
        }
        const url = `http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`
        const method = req.method ?? 'GET'
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
          res.end(JSON.stringify({ error: { code: 'INTERNAL', message: 'Internal server error.' } }))
        }
      })()
    })
  }
}

export interface ServeOptions extends HandlerOptions {
  port?: number
}

export interface RunningServer {
  url: string
  port: number
  close: () => Promise<void>
}

export async function serve(kernel: Kernel, options: ServeOptions = {}): Promise<RunningServer> {
  const handler = createRequestHandler(kernel, options)
  const server = createServer(toNodeListener(handler))
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
