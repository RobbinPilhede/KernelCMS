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

export interface KernelClient {
  find: <T extends Row = Row>(collection: string, query?: FindQuery) => Promise<PaginatedResult<T>>
  findByID: <T extends Row = Row>(collection: string, id: string, query?: ByIdQuery) => Promise<T>
  create: <T extends Row = Row>(collection: string, data: Row, query?: ByIdQuery) => Promise<T>
  update: <T extends Row = Row>(collection: string, id: string, data: Row, query?: ByIdQuery) => Promise<T>
  remove: <T extends Row = Row>(collection: string, id: string) => Promise<T>
  findGlobal: <T extends Row = Row>(slug: string, query?: ByIdQuery) => Promise<T>
  updateGlobal: <T extends Row = Row>(slug: string, data: Row) => Promise<T>
  health: () => Promise<{ status: string; db: { status: string } }>
}

export function createClient(options: ClientOptions): KernelClient {
  const doFetch = options.fetch ?? globalThis.fetch
  const apiRoute = options.apiRoute ?? '/api'
  const root = options.baseURL.replace(/\/$/, '') + apiRoute

  async function request<T>(method: string, path: string, body?: Row): Promise<T> {
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
    health: () => request('GET', '/health'),
  }
}
