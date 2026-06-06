// Lightweight typed client for the KernelCMS REST API (admin-facing).

export interface AdminFieldOption {
  label: string
  value: string
}

export interface AdminRichTextSchema {
  marks: string[]
  nodes: string[]
  headingLevels: number[]
  lists: { ordered: boolean; unordered: boolean }
  link: { enabled: boolean; allowNewTab: boolean; internalCollections: string[] }
  relationshipCollections: string[]
  uploadCollections: string[]
  blockSlugs: string[]
}

export interface AdminBlockMeta {
  slug: string
  labels: { singular: string; plural: string }
  fields: AdminFieldMeta[]
  group?: string
  description?: string
  thumbnail?: string
}

export interface AdminFieldMeta {
  name: string
  type: string
  label: string
  required: boolean
  unique: boolean
  localized: boolean
  hasMany?: boolean
  relationTo?: string | string[]
  options?: AdminFieldOption[]
  fields?: AdminFieldMeta[]
  blocks?: AdminBlockMeta[]
  defaultValue?: unknown
  min?: number
  max?: number
  minLength?: number
  maxLength?: number
  richText?: AdminRichTextSchema
  admin?: {
    description?: string
    placeholder?: string
    readOnly?: boolean
    hidden?: boolean
    position?: 'main' | 'sidebar'
    tab?: string
    section?: string
    width?: number
    /** Key of a custom component registered on `window.KernelCMS.fields`. */
    component?: string
  }
}

export interface AdminCollection {
  slug: string
  labels: { singular: string; plural: string }
  useAsTitle: string
  defaultColumns?: string[]
  group?: string
  description?: string
  auth: boolean
  hidden: boolean
  upload: boolean
  livePreview?: { url: string }
  versions?: { enabled: boolean; drafts: boolean }
  fields: AdminFieldMeta[]
}

export interface AdminGlobal {
  slug: string
  label: string
  fields: AdminFieldMeta[]
}

export interface AdminSchema {
  collections: AdminCollection[]
  globals: AdminGlobal[]
  localization: { locales: string[]; defaultLocale: string } | null
  routes: { api: string }
  attribution: boolean
}

export type Doc = Record<string, unknown> & { id: string }

export interface Paginated<T> {
  docs: T[]
  totalDocs: number
  limit: number
  page: number
  totalPages: number
  hasNextPage: boolean
  hasPrevPage: boolean
}

// Default to same-origin (the kernel server serves this admin), so a relative
// `/api` is used. Set VITE_KERNEL_API only for standalone Vite dev against a
// remote server.
const API_BASE = (import.meta.env.VITE_KERNEL_API ?? '').replace(/\/$/, '')
const ROOT = `${API_BASE}/api`
const TOKEN_KEY = 'kernel_token'

// Token storage is best-effort and must never throw: localStorage can be full
// (dev origins are shared across projects), disabled, or quota-exhausted. Keep
// an in-memory copy so the session always works, and try localStorage then
// sessionStorage for persistence across reloads.
let memToken: string | null = null
export const getToken = (): string | null => {
  if (memToken) return memToken
  try {
    const v = localStorage.getItem(TOKEN_KEY)
    if (v) return v
  } catch {
    /* storage unavailable */
  }
  try {
    return sessionStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}
export const setToken = (token: string | null): void => {
  memToken = token
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
    return
  } catch {
    /* fall through to sessionStorage */
  }
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token)
    else sessionStorage.removeItem(TOKEN_KEY)
  } catch {
    /* in-memory only */
  }
}

export interface FieldErrorDetail {
  path: string
  message: string
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: FieldErrorDetail[] | undefined
  constructor(status: number, code: string, message: string, details?: FieldErrorDetail[]) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

async function req<T>(method: string, path: string, body?: Record<string, unknown>): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const token = getToken()
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(ROOT + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) {
    const err = (data?.error ?? {}) as { code?: string; message?: string; details?: FieldErrorDetail[] }
    throw new ApiError(res.status, err.code ?? 'ERROR', err.message ?? res.statusText, err.details)
  }
  return data as T
}

// Active locale for localized reads/writes. A module-level value (like the token)
// so it's appended automatically — callers don't thread it through every request.
let activeLocale: string | null = null
export const setActiveLocale = (locale: string | null): void => {
  activeLocale = locale
}
export const getActiveLocale = (): string | null => activeLocale
/** `?`/`&`-prefixed locale query fragment, or '' when no locale is active. */
const localeQS = (sep: '?' | '&'): string => (activeLocale ? `${sep}locale=${encodeURIComponent(activeLocale)}` : '')

export const fetchSchema = (): Promise<AdminSchema> => req('GET', '/_config')

export interface SetupRuntime {
  db: string
  secretSet: boolean
  storage: boolean
  email: boolean
  collections: number
  node: string
  version: string
  graphql: boolean
}

export interface AdminStatus {
  needsSetup: boolean
  authCollection: string | null
  /** Present only during first-run setup. */
  runtime?: SetupRuntime
}

export const adminStatus = (): Promise<AdminStatus> => req('GET', '/_admin/status')

export interface ConnectorStatus {
  db: string
  storage: { configured: boolean; kind: string | null }
  email: { configured: boolean; kind: string | null }
  oauth: string[]
  image: boolean
  graphql: boolean
}

export const getConnectors = (): Promise<ConnectorStatus> => req('GET', '/_admin/connectors')

/** Persist connector settings to the project .env (first-run setup only). */
export const writeSetupEnv = (values: Record<string, string>): Promise<{ ok: boolean; written: string[] }> =>
  req('POST', '/_admin/env', { values })

export async function setupAdmin(email: string, password: string): Promise<{ token: string; user: Doc }> {
  const result = await req<{ token: string; user: Doc }>('POST', '/_admin/setup', { email, password })
  setToken(result.token)
  return result
}

export async function login(
  collection: string,
  email: string,
  password: string,
): Promise<{ token: string; user: Doc }> {
  const result = await req<{ token: string; user: Doc }>('POST', `/${collection}/login`, { email, password })
  setToken(result.token)
  return result
}

export const me = (collection: string): Promise<{ user: Doc }> => req('GET', `/${collection}/me`)
export const logout = (): void => setToken(null)

export const forgotPassword = (collection: string, email: string): Promise<{ success: true }> =>
  req('POST', `/${collection}/forgot-password`, { email })

export async function resetPassword(
  collection: string,
  token: string,
  password: string,
): Promise<{ token: string; user: Doc }> {
  const result = await req<{ token: string; user: Doc }>('POST', `/${collection}/reset-password`, { token, password })
  setToken(result.token)
  return result
}

export const verifyEmail = (collection: string, token: string): Promise<{ verified: true }> =>
  req('POST', `/${collection}/verify-email`, { token })

/** A filter map: field → { operator: value }, e.g. `{ title: { like: 'hello' } }`. */
export type WhereClause = Record<string, Record<string, unknown>>

export interface ListParams {
  page?: number
  limit?: number
  sort?: string
  depth?: number
  /** Include drafts (latest content) for drafts-enabled collections. */
  draft?: boolean
  /** Server-side filter, serialized as a JSON `where` query parameter. */
  where?: WhereClause
}

export function listDocs(slug: string, params: ListParams = {}): Promise<Paginated<Doc>> {
  const q = new URLSearchParams()
  if (params.page) q.set('page', String(params.page))
  q.set('limit', String(params.limit ?? 20))
  if (params.sort) q.set('sort', params.sort)
  if (params.depth) q.set('depth', String(params.depth))
  if (params.draft) q.set('draft', 'true')
  if (params.where && Object.keys(params.where).length > 0) q.set('where', JSON.stringify(params.where))
  if (activeLocale) q.set('locale', activeLocale)
  return req('GET', `/${slug}?${q.toString()}`)
}

export interface BulkResult {
  docs: Doc[]
  count: number
}

/** Delete every document matching `where` (server enforces access). */
export const deleteManyDocs = (slug: string, where: WhereClause): Promise<BulkResult> =>
  req('DELETE', `/${slug}?where=${encodeURIComponent(JSON.stringify(where))}`)

export const getDoc = (slug: string, id: string, depth = 1, draft = false): Promise<Doc> =>
  req('GET', `/${slug}/${id}?depth=${depth}${draft ? '&draft=true' : ''}${localeQS('&')}`)

/** Multipart upload to an upload collection. `data` carries the user-authored fields. */
export async function uploadFile(slug: string, file: File, data: Record<string, unknown>): Promise<Doc> {
  const form = new FormData()
  form.set('file', file)
  form.set('_data', JSON.stringify(data))
  const headers: Record<string, string> = {}
  const token = getToken()
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${ROOT}/${slug}${localeQS('?')}`, { method: 'POST', headers, body: form })
  const text = await res.text()
  const parsed = text ? JSON.parse(text) : null
  if (!res.ok) {
    const err = (parsed?.error ?? {}) as { code?: string; message?: string; details?: FieldErrorDetail[] }
    throw new ApiError(res.status, err.code ?? 'ERROR', err.message ?? res.statusText, err.details)
  }
  return parsed as Doc
}
export const createDoc = (slug: string, data: Record<string, unknown>): Promise<Doc> =>
  req('POST', `/${slug}${localeQS('?')}`, data)
export const updateDoc = (slug: string, id: string, data: Record<string, unknown>): Promise<Doc> =>
  req('PATCH', `/${slug}/${id}${localeQS('?')}`, data)
export const deleteDoc = (slug: string, id: string): Promise<Doc> => req('DELETE', `/${slug}/${id}`)
export const getGlobal = (slug: string): Promise<Doc> => req('GET', `/globals/${slug}${localeQS('?')}`)
export const updateGlobal = (slug: string, data: Record<string, unknown>): Promise<Doc> =>
  req('POST', `/globals/${slug}${localeQS('?')}`, data)

// ── Versions & drafts ────────────────────────────────────────────────────────

export interface VersionEntry {
  id: string
  parent: string
  version: Doc
  status: 'draft' | 'published'
  createdAt: string
  updatedAt: string
}

export const listVersions = (
  slug: string,
  id: string,
  params: { page?: number; limit?: number } = {},
): Promise<Paginated<VersionEntry>> => {
  const q = new URLSearchParams()
  if (params.page) q.set('page', String(params.page))
  q.set('limit', String(params.limit ?? 20))
  return req('GET', `/${slug}/${id}/versions?${q.toString()}`)
}

export const publishDoc = (slug: string, id: string): Promise<Doc> => req('POST', `/${slug}/${id}/publish`)
export const unpublishDoc = (slug: string, id: string): Promise<Doc> => req('POST', `/${slug}/${id}/unpublish`)
export const restoreVersion = (slug: string, id: string, versionId: string): Promise<Doc> =>
  req('POST', `/${slug}/${id}/versions/${versionId}/restore`)
