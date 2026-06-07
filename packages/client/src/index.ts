/**
 * @kernel/client — a tiny, typed fetch client for the KernelCMS REST API.
 * Works in the browser, on the edge, and in Node (global fetch).
 */
import type { PaginatedResult, Row, Where } from '@kernel/db'

export interface ClientOptions {
  /** Origin of the KernelCMS server, e.g. "http://localhost:3000". */
  baseURL: string
  /** API route prefix. Default "/api". */
  apiRoute?: string
  /** System API key (sent as a bearer token). */
  apiKey?: string
  /** End-user auth token (sent as a bearer token). Takes precedence over apiKey. */
  token?: string
  /** Custom fetch implementation (defaults to global fetch). */
  fetch?: typeof fetch
  /** Extra headers attached to every request. */
  headers?: Record<string, string>
}

export interface FindQuery {
  where?: Where
  sort?: string | string[]
  limit?: number
  page?: number
  depth?: number
  locale?: string
}

export interface ByIdQuery {
  depth?: number
  locale?: string
}

export class KernelClientError extends Error {
  readonly status: number
  readonly code: string
  readonly details: unknown
  constructor(status: number, code: string, message: string, details: unknown) {
    super(message)
    this.name = 'KernelClientError'
    this.status = status
    this.code = code
    this.details = details
  }
}

function buildSearch(query: FindQuery | ByIdQuery | undefined): string {
  if (!query) return ''
  const params = new URLSearchParams()
  if ('where' in query && query.where) params.set('where', JSON.stringify(query.where))
  if ('sort' in query && query.sort) params.set('sort', Array.isArray(query.sort) ? query.sort.join(',') : query.sort)
  if ('limit' in query && query.limit !== undefined) params.set('limit', String(query.limit))
  if ('page' in query && query.page !== undefined) params.set('page', String(query.page))
  if (query.depth !== undefined) params.set('depth', String(query.depth))
  if (query.locale) params.set('locale', query.locale)
  const qs = params.toString()
  return qs ? `?${qs}` : ''
}

/** Serialize an arbitrary query map (objects/arrays become JSON) for an endpoint. */
function buildQuery(query: Record<string, unknown> | undefined): string {
  if (!query) return ''
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue
    params.set(key, typeof value === 'string' ? value : JSON.stringify(value))
  }
  const qs = params.toString()
  return qs ? `?${qs}` : ''
}

/** Call a custom endpoint (`config.endpoints`). `:param` placeholders in `path`
 *  are filled from `params`; `query` is appended; `body` is JSON-encoded. */
export interface EndpointCall {
  params?: Record<string, string | number>
  query?: Record<string, unknown>
  body?: unknown
}

export interface KernelClient {
  find: <T extends Row = Row>(collection: string, query?: FindQuery) => Promise<PaginatedResult<T>>
  findByID: <T extends Row = Row>(collection: string, id: string, query?: ByIdQuery) => Promise<T>
  create: <T extends Row = Row>(collection: string, data: Row, query?: ByIdQuery) => Promise<T>
  update: <T extends Row = Row>(collection: string, id: string, data: Row, query?: ByIdQuery) => Promise<T>
  remove: <T extends Row = Row>(collection: string, id: string) => Promise<T>
  findGlobal: <T extends Row = Row>(slug: string, query?: ByIdQuery) => Promise<T>
  updateGlobal: <T extends Row = Row>(slug: string, data: Row) => Promise<T>
  /** Call a custom endpoint by method + path template. */
  endpoint: <TResponse = unknown>(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    call?: EndpointCall,
  ) => Promise<TResponse>
  health: () => Promise<{ status: string; db: { status: string } }>
}

/**
 * The shape of the generated `KernelTypes` registry (from `kernel generate:types`):
 * `{ collections: { <slug>: Interface }, globals: { <slug>: Interface } }`. The
 * member types are plain interfaces with no index signature, so the constraint is
 * `object` (not `Row`) — this is exactly why the untyped client's `<T extends Row>`
 * rejected them. See {@link createTypedClient}.
 */
export interface KernelTypeRegistry {
  collections: object
  globals: object
}

/**
 * A slug-inferred client: `find('matches')` returns `PaginatedResult<Matches>` and
 * `findGlobal('hero')` returns `Hero`, straight from the generated `KernelTypes` —
 * no per-call generic and no `as unknown as` cast. Slugs are checked against the
 * registry, so a typo is a compile error.
 */
export interface TypedKernelClient<T extends KernelTypeRegistry> {
  find: <S extends keyof T['collections'] & string>(
    collection: S,
    query?: FindQuery,
  ) => Promise<PaginatedResult<T['collections'][S]>>
  findByID: <S extends keyof T['collections'] & string>(
    collection: S,
    id: string,
    query?: ByIdQuery,
  ) => Promise<T['collections'][S]>
  create: <S extends keyof T['collections'] & string>(
    collection: S,
    data: Partial<T['collections'][S]>,
    query?: ByIdQuery,
  ) => Promise<T['collections'][S]>
  update: <S extends keyof T['collections'] & string>(
    collection: S,
    id: string,
    data: Partial<T['collections'][S]>,
    query?: ByIdQuery,
  ) => Promise<T['collections'][S]>
  remove: <S extends keyof T['collections'] & string>(collection: S, id: string) => Promise<T['collections'][S]>
  findGlobal: <S extends keyof T['globals'] & string>(slug: S, query?: ByIdQuery) => Promise<T['globals'][S]>
  updateGlobal: <S extends keyof T['globals'] & string>(
    slug: S,
    data: Partial<T['globals'][S]>,
  ) => Promise<T['globals'][S]>
  endpoint: KernelClient['endpoint']
  health: KernelClient['health']
}

/**
 * Like {@link createClient}, but typed against your generated `KernelTypes`:
 *
 * ```ts
 * import type { KernelTypes } from './kernel-types'
 * const client = createTypedClient<KernelTypes>({ baseURL })
 * const hero = await client.findGlobal('hero')   // Hero
 * const { docs } = await client.find('matches')  // Matches[]
 * ```
 *
 * Runtime behaviour is identical to `createClient`; this only refines the types.
 */
export function createTypedClient<T extends KernelTypeRegistry>(options: ClientOptions): TypedKernelClient<T> {
  return createClient(options) as unknown as TypedKernelClient<T>
}

export function createClient(options: ClientOptions): KernelClient {
  const doFetch = options.fetch ?? globalThis.fetch
  const apiRoute = options.apiRoute ?? '/api'
  const root = options.baseURL.replace(/\/$/, '') + apiRoute

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...options.headers }
    const bearer = options.token ?? options.apiKey
    if (bearer) headers.authorization = `Bearer ${bearer}`

    const response = await doFetch(root + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })

    const text = await response.text()
    const payload = text ? JSON.parse(text) : null
    if (!response.ok) {
      const err = payload?.error ?? {}
      throw new KernelClientError(response.status, err.code ?? 'ERROR', err.message ?? response.statusText, err.details)
    }
    return payload as T
  }

  return {
    find: (collection, query) => request('GET', `/${collection}${buildSearch(query)}`),
    findByID: (collection, id, query) => request('GET', `/${collection}/${id}${buildSearch(query)}`),
    create: (collection, data, query) => request('POST', `/${collection}${buildSearch(query)}`, data),
    update: (collection, id, data, query) => request('PATCH', `/${collection}/${id}${buildSearch(query)}`, data),
    remove: (collection, id) => request('DELETE', `/${collection}/${id}`),
    findGlobal: (slug, query) => request('GET', `/globals/${slug}${buildSearch(query)}`),
    updateGlobal: (slug, data) => request('POST', `/globals/${slug}`, data),
    endpoint: (method, path, call) => {
      let resolved = path
      if (call?.params) {
        for (const [key, value] of Object.entries(call.params)) {
          resolved = resolved.replace(`:${key}`, encodeURIComponent(String(value)))
        }
      }
      return request(method, `${resolved}${buildQuery(call?.query)}`, call?.body)
    },
    health: () => request('GET', '/health'),
  }
}
