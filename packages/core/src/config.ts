import type {
  AnyField,
  CollectionConfig,
  ConfigField,
  GlobalConfig,
  KernelConfig,
  SanitizedConfig,
  SanitizedLocalization,
} from './types'
import { effectiveFields, joinFields } from './fields'
import { consoleEmail, type EmailAdapter } from './email'

let warnedNoEmail = false
function consoleEmailFallback(): EmailAdapter {
  if (!warnedNoEmail) {
    warnedNoEmail = true

    console.warn(
      '[KernelCMS] An auth collection enables verify/forgotPassword but no `email` adapter is configured — using a console adapter (emails are logged, not sent). Configure `email` in production.',
    )
  }
  return consoleEmail()
}

/** Inject email + password-hash fields into auth-enabled collections. */
function withAuthFields(collection: CollectionConfig, hasOAuth = false): CollectionConfig {
  const fields: ConfigField[] = [...collection.fields]
  const has = (name: string) => fields.some((f) => 'name' in f && f.name === name)
  if (!has('email')) {
    fields.unshift({ name: 'email', type: 'email', required: true, unique: true, index: true })
  }
  if (!has('hash')) {
    fields.push({ name: 'hash', type: 'text', admin: { hidden: true } })
  }
  // Session epoch: embedded in issued tokens and bumped on password change/reset
  // so previously-issued JWTs stop authenticating. Server-managed.
  if (!has('token_version')) {
    fields.push({ name: 'token_version', type: 'number', integer: true, defaultValue: 0, admin: { hidden: true } })
  }
  // API-key auth stores only a hash of the key (never the key itself).
  const auth = collection.auth
  if (typeof auth === 'object' && auth.useAPIKey && !has('api_key')) {
    fields.push({ name: 'api_key', type: 'text', unique: true, index: true, admin: { hidden: true } })
  }
  // Email verification: a public-safe `email_verified` flag plus a hashed,
  // expiring verification token (never returned by the API).
  if (typeof auth === 'object' && auth.verify) {
    if (!has('email_verified')) {
      fields.push({ name: 'email_verified', type: 'boolean', defaultValue: false, admin: { readOnly: true } })
    }
    if (!has('verification_token')) {
      fields.push({ name: 'verification_token', type: 'text', admin: { hidden: true } })
    }
    if (!has('verification_token_expiry')) {
      fields.push({ name: 'verification_token_expiry', type: 'number', integer: true, admin: { hidden: true } })
    }
  }
  // Forgot-password: a hashed, expiring reset token (never returned by the API).
  if (typeof auth === 'object' && auth.forgotPassword) {
    if (!has('reset_token')) {
      fields.push({ name: 'reset_token', type: 'text', admin: { hidden: true } })
    }
    if (!has('reset_token_expiry')) {
      fields.push({ name: 'reset_token_expiry', type: 'number', integer: true, admin: { hidden: true } })
    }
  }
  // Two-factor: the TOTP secret (never returned) + a public-safe enabled flag.
  if (typeof auth === 'object' && auth.twoFactor) {
    if (!has('totp_secret')) {
      fields.push({ name: 'totp_secret', type: 'text', admin: { hidden: true } })
    }
    if (!has('totp_enabled')) {
      fields.push({ name: 'totp_enabled', type: 'boolean', defaultValue: false, admin: { readOnly: true } })
    }
    // The last accepted TOTP step — used to reject code replay. Server-managed.
    if (!has('totp_last_step')) {
      fields.push({ name: 'totp_last_step', type: 'number', integer: true, admin: { hidden: true } })
    }
  }
  // OAuth identity: returning users are matched by the stable provider+subject so
  // a re-login never relies on email (which an attacker could spoof). Set on the
  // account the first time it signs in via a provider.
  if (hasOAuth) {
    if (!has('oauth_provider')) {
      fields.push({ name: 'oauth_provider', type: 'text', index: true, admin: { hidden: true } })
    }
    if (!has('oauth_subject')) {
      fields.push({ name: 'oauth_subject', type: 'text', index: true, admin: { hidden: true } })
    }
  }
  return { ...collection, fields }
}

/** Inject the system fields every upload collection stores alongside user fields. */
function withUploadFields(collection: CollectionConfig): CollectionConfig {
  const sys: AnyField[] = [
    { name: 'filename', type: 'text', admin: { readOnly: true } },
    { name: 'mime_type', type: 'text', admin: { readOnly: true } },
    { name: 'filesize', type: 'number', integer: true, admin: { readOnly: true } },
    { name: 'checksum', type: 'text', admin: { readOnly: true, hidden: true } },
    { name: 'storage_key', type: 'text', admin: { hidden: true } },
    { name: 'url', type: 'text', admin: { readOnly: true } },
    { name: 'width', type: 'number', integer: true, admin: { readOnly: true } },
    { name: 'height', type: 'number', integer: true, admin: { readOnly: true } },
    // Map of generated derivatives: { [sizeName]: { url, width, height, filename, filesize } }.
    { name: 'sizes', type: 'json', admin: { readOnly: true } },
  ]
  const cfg = collection.upload
  // Focal point (0–100). The crop anchor for `cover`-fit sizes; editable in the admin.
  if (typeof cfg === 'object' && cfg.focalPoint) {
    sys.push(
      { name: 'focal_x', type: 'number', defaultValue: 50 },
      { name: 'focal_y', type: 'number', defaultValue: 50 },
    )
  }
  const existing = new Set(effectiveFields(collection.fields).map((f) => f.name))
  const injected = sys.filter((f) => !existing.has(f.name))
  return { ...collection, fields: [...collection.fields, ...injected] }
}

/** Reserved slug for the injected background-jobs queue collection. */
export const JOBS_SLUG = 'kernel_jobs'

/** The hidden collection that stores queued/processed background jobs. */
function jobsCollection(): CollectionConfig {
  return {
    slug: JOBS_SLUG,
    labels: { singular: 'Job', plural: 'Jobs' },
    // System-only: no public access. enqueue/runDueJobs use overrideAccess.
    access: { read: () => false, create: () => false, update: () => false, delete: () => false },
    admin: { hidden: true, useAsTitle: 'task' },
    fields: [
      { name: 'task', type: 'text', required: true, index: true },
      {
        name: 'status',
        type: 'select',
        options: ['pending', 'running', 'completed', 'failed'],
        defaultValue: 'pending',
        index: true,
      },
      { name: 'input', type: 'json' },
      { name: 'result', type: 'json' },
      { name: 'run_at', type: 'date', index: true },
      { name: 'attempts', type: 'number', integer: true, defaultValue: 0 },
      { name: 'max_attempts', type: 'number', integer: true, defaultValue: 3 },
      { name: 'last_error', type: 'text' },
    ],
  }
}

/** Reserved slug for the database-backed cache table (used by `dbCache()`). */
export const CACHE_SLUG = 'kernel_cache'

/** The hidden collection backing `dbCache()`. The cache key is the row id. */
function cacheCollection(): CollectionConfig {
  return {
    slug: CACHE_SLUG,
    labels: { singular: 'Cache entry', plural: 'Cache' },
    access: { read: () => false, create: () => false, update: () => false, delete: () => false },
    admin: { hidden: true },
    timestamps: false,
    fields: [
      { name: 'value', type: 'json' },
      { name: 'expires_at', type: 'number', integer: true, defaultValue: 0, index: true },
      // Comma-delimited tag list (",posts,users,") for substring tag matching.
      { name: 'tags_csv', type: 'text', index: true },
    ],
  }
}

const IDENT_RE = /^[a-z][a-z0-9_]*$/

/** Identity helper that gives `kernel.config.ts` full type-checking and inference. */
export function defineConfig(config: KernelConfig): KernelConfig {
  return config
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`KernelCMS config error: ${message}`)
}

function validateCollection(collection: CollectionConfig): void {
  assert(
    IDENT_RE.test(collection.slug),
    `collection slug "${collection.slug}" must be snake_case starting with a letter`,
  )
  const seen = new Set<string>()
  // Validate the effective (storage-bearing) fields — `row`/`tabs` are flattened,
  // `ui` is dropped — so presentational containers don't need a `name`.
  for (const field of effectiveFields(collection.fields)) {
    assert(IDENT_RE.test(field.name), `field "${field.name}" in "${collection.slug}" must be snake_case`)
    assert(!seen.has(field.name), `duplicate field "${field.name}" in collection "${collection.slug}"`)
    seen.add(field.name)
  }
  // Virtual `join` (reverse-relationship) fields: valid, non-colliding names.
  for (const join of joinFields(collection.fields)) {
    assert(IDENT_RE.test(join.name), `join field "${join.name}" in "${collection.slug}" must be snake_case`)
    assert(!seen.has(join.name), `join field "${join.name}" collides with a stored field in "${collection.slug}"`)
    seen.add(join.name)
  }
}

function validateGlobal(global: GlobalConfig): void {
  assert(IDENT_RE.test(global.slug), `global slug "${global.slug}" must be snake_case starting with a letter`)
}

export function sanitizeConfig(config: KernelConfig): SanitizedConfig {
  assert(config.db, 'a database adapter is required (config.db)')
  assert(Array.isArray(config.collections), 'config.collections must be an array')

  const baseCollections = [...config.collections]
  // Background jobs: inject the reserved queue collection (guard against collision).
  if (config.jobs && config.jobs.length > 0) {
    assert(
      !baseCollections.some((c) => c.slug === JOBS_SLUG),
      `collection slug "${JOBS_SLUG}" is reserved for the background-jobs queue`,
    )
    baseCollections.push(jobsCollection())
  }
  // A database-backed cache (`dbCache()`) marks itself so we provision its table.
  if (config.cache && (config.cache as { __needsTable?: string }).__needsTable === CACHE_SLUG) {
    assert(
      !baseCollections.some((c) => c.slug === CACHE_SLUG),
      `collection slug "${CACHE_SLUG}" is reserved for the database cache`,
    )
    baseCollections.push(cacheCollection())
  }
  const hasOAuth = Boolean(config.oauth && config.oauth.length > 0)
  const collections = baseCollections.map((c) => {
    let out = c
    if (out.auth) out = withAuthFields(out, hasOAuth)
    if (out.upload) out = withUploadFields(out)
    return out
  })
  const globals = config.globals ?? []

  const collectionsBySlug: Record<string, CollectionConfig> = {}
  for (const collection of collections) {
    validateCollection(collection)
    assert(!collectionsBySlug[collection.slug], `duplicate collection slug "${collection.slug}"`)
    collectionsBySlug[collection.slug] = collection
  }

  const globalsBySlug: Record<string, GlobalConfig> = {}
  for (const global of globals) {
    validateGlobal(global)
    assert(!globalsBySlug[global.slug], `duplicate global slug "${global.slug}"`)
    assert(!collectionsBySlug[global.slug], `global "${global.slug}" collides with a collection slug`)
    globalsBySlug[global.slug] = global
  }

  let localization: SanitizedLocalization | false = false
  if (config.localization) {
    const { locales, defaultLocale, fallback } = config.localization
    assert(locales.length > 0, 'localization.locales must not be empty')
    assert(locales.includes(defaultLocale), `localization.defaultLocale "${defaultLocale}" must be in locales`)
    localization = { locales, defaultLocale, fallback: fallback ?? true }
  }

  const configuredSecret = config.secret ?? process.env.KERNEL_SECRET
  // Refuse to boot in production with no real secret: the dev fallback is a public
  // constant, so anyone could forge a valid admin session JWT against it.
  if (!configuredSecret && process.env.NODE_ENV === 'production') {
    throw new Error(
      '[KernelCMS] No `secret` or KERNEL_SECRET is set. A strong secret is required in production ' +
        '(NODE_ENV=production); the built-in development secret is public and would let anyone forge sessions.',
    )
  }
  // Also reject explicitly pinning the known-insecure constant in production.
  if (configuredSecret === DEV_SECRET && process.env.NODE_ENV === 'production') {
    throw new Error('[KernelCMS] The development secret must not be used in production. Set a unique KERNEL_SECRET.')
  }
  const secret = configuredSecret ?? devSecret()

  const adminUser = config.admin?.user ?? collections.find((c) => c.auth)?.slug ?? 'users'

  // Auth flows that send mail need an email adapter. If the project enables
  // verify/forgotPassword but configures none, fall back to a console adapter so
  // local dev keeps working — with a one-time warning so it's never silent in prod.
  const needsEmail = collections.some((c) => typeof c.auth === 'object' && (c.auth.verify || c.auth.forgotPassword))
  let email = config.email
  if (!email && needsEmail) {
    email = consoleEmailFallback()
  }

  // Validate custom endpoints: known method, rooted path, no duplicate method+path,
  // and no collision with reserved system routes or per-auth-collection
  // auth/OAuth routes — so a (possibly third-party) module can't shadow and
  // intercept login/reset/OAuth flows.
  const endpoints = config.endpoints ?? []
  if (endpoints.length > 0) {
    const reservedFirst = new Set(['health', '_config', '_admin', 'openapi', 'docs', 'graphql', 'globals'])
    const authActions = new Set([
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
    const authSlugs = new Set(collections.filter((c) => c.auth).map((c) => c.slug))
    const seen = new Set<string>()
    for (const ep of endpoints) {
      assert(
        ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(ep.method),
        `endpoint "${ep.method} ${ep.path}" has an unsupported method`,
      )
      assert(ep.path.startsWith('/'), `endpoint path "${ep.path}" must start with "/"`)
      const key = `${ep.method} ${ep.path}`
      assert(!seen.has(key), `duplicate endpoint "${key}"`)
      seen.add(key)
      const segs = ep.path.split('/').filter(Boolean)
      assert(!reservedFirst.has(segs[0] ?? ''), `endpoint path "${ep.path}" collides with a reserved route`)
      if (segs[0] && authSlugs.has(segs[0]) && segs[1] && (authActions.has(segs[1]) || segs[1] === 'oauth')) {
        assert(false, `endpoint path "${ep.path}" collides with a built-in auth route`)
      }
    }
  }

  // Resolve per-collection caching. Only meaningful when a cache adapter is set;
  // the jobs queue is never cached (it changes constantly and must read fresh).
  const cacheDefaultTtl = config.cacheDefaults?.ttl ?? 0
  const cacheableSlugs: string[] = []
  const cacheTtlBySlug: Record<string, number> = {}
  if (config.cache) {
    for (const collection of collections) {
      if (collection.slug === JOBS_SLUG || collection.slug === CACHE_SLUG) continue
      // Never cache auth collections: session epoch (token_version) and TOTP
      // replay defence rely on fresh reads, and stale auth state is a security risk.
      if (collection.auth) continue
      const c = collection.cache
      if (!c) continue
      cacheableSlugs.push(collection.slug)
      if (typeof c === 'object' && typeof c.ttl === 'number') cacheTtlBySlug[collection.slug] = c.ttl
    }
  }

  return {
    serverURL: config.serverURL ?? 'http://localhost:3000',
    db: config.db,
    collections,
    globals,
    localization,
    routes: { api: config.routes?.api ?? '/api' },
    admin: { user: adminUser },
    secret,
    collectionsBySlug,
    globalsBySlug,
    attribution: config.attribution ?? true,
    cacheableSlugs,
    cacheTtlBySlug,
    cacheDefaultTtl,
    ...(config.storage ? { storage: config.storage } : {}),
    ...(config.image ? { image: config.image } : {}),
    ...(email ? { email } : {}),
    ...(config.cache ? { cache: config.cache } : {}),
    ...(config.webhooks && config.webhooks.length > 0 ? { webhooks: config.webhooks } : {}),
    ...(config.jobs && config.jobs.length > 0 ? { jobs: config.jobs } : {}),
    ...(endpoints.length > 0 ? { endpoints } : {}),
    ...(config.oauth && config.oauth.length > 0 ? { oauth: config.oauth } : {}),
  }
}

/** The insecure fallback secret used when none is configured (dev only). */
export const DEV_SECRET = 'kernel-dev-insecure-secret-do-not-use-in-production'

let warned = false
function devSecret(): string {
  if (!warned) {
    warned = true

    console.warn(
      '[KernelCMS] No `secret` or KERNEL_SECRET set — using an insecure development secret. Set KERNEL_SECRET in production.',
    )
  }
  return DEV_SECRET
}

export function defaultLocaleOf(config: SanitizedConfig): string {
  return config.localization ? config.localization.defaultLocale : 'en'
}
