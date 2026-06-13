import type {
  AccessFn,
  AgentConfig,
  AnyField,
  CollectionConfig,
  ConfigField,
  DiscoverabilityCollectionConfig,
  EvalRule,
  GlobalConfig,
  KernelConfig,
  SanitizedConfig,
  SanitizedDiscoverability,
  SanitizedLocalization,
  SanitizedSigningConfig,
} from './types'
import { effectiveFields, joinFields } from './fields'
import { consoleEmail, type EmailAdapter } from './email'
import { createRbacStore, injectRbac } from './rbac'
import { resolveVersions } from './schema'
import { memoryVector } from './vector'

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

/**
 * Field names that confer privilege. On an auth collection these are write-locked
 * to admins by default (see `guardAuthorityFields`) so a user can never edit their
 * own record to escalate their authority.
 */
const AUTHORITY_FIELDS = new Set(['roles', 'role', 'permissions', 'is_admin', 'is_staff', 'is_superuser'])

/** KernelCMS's built-in admin convention: a signed-in user whose `roles` includes 'admin'. */
const isAdminUser: AccessFn = ({ req }) => Boolean(req.user?.roles?.includes('admin'))

/**
 * Secure-by-default privilege fields. Field-level access is the only thing that
 * stops a row's owner from writing a given field — and auth collections almost
 * always let a user update their OWN record. Without a default, an unguarded
 * `roles` field would let any such user `PATCH` themselves to `{ roles: ['admin'] }`
 * and self-promote (vertical privilege escalation).
 *
 * So: any authority-named field that doesn't already declare its own create/update
 * access defaults to admin-only for those operations. Reads are left untouched
 * (the admin UI still shows roles), and an explicit field `access` rule always
 * wins. Trusted server paths (overrideAccess: seed, first-admin setup, OAuth
 * provisioning) skip field access entirely, so bootstrapping still works.
 */
function guardAuthorityFields(fields: ConfigField[]): ConfigField[] {
  return fields.map((field) => {
    // Only real storage fields carry write access; skip ui/join containers.
    if (field.type === 'ui' || field.type === 'join') return field
    if (!('name' in field) || !AUTHORITY_FIELDS.has(field.name)) return field
    const access = field.access
    // Respect an explicit rule for an operation; only fill the gaps.
    return {
      ...field,
      access: {
        ...access,
        create: access?.create ?? isAdminUser,
        update: access?.update ?? isAdminUser,
      },
    }
  })
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
  // Write-lock privilege fields to admins unless the field opts out with its own rule.
  return { ...collection, fields: guardAuthorityFields(fields) }
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

/** Minimum length for a production token-signing secret (a short one is brute-forceable). */
const MIN_PRODUCTION_SECRET_LENGTH = 16

/** Minimum length for an HMAC content-credential secret (a short MAC key is weak). */
const MIN_SIGNING_SECRET_LENGTH = 16

/** Identity helper that gives `kernel.config.ts` full type-checking and inference. */
export function defineConfig(config: KernelConfig): KernelConfig {
  return config
}

/**
 * Fail closed on an unsafe production secret. In `NODE_ENV=production` this throws
 * when the resolved secret (config.secret ?? KERNEL_SECRET) is missing/empty, the
 * public dev default, or shorter than {@link MIN_PRODUCTION_SECRET_LENGTH} — any of
 * which would let an attacker forge admin sessions. No-op outside production.
 *
 * Called by `sanitizeConfig` (so `initKernel`, including the embedded path, is
 * gated) and again by `kernel start`. Embedders rely on this; do not bypass it.
 */
export function assertProductionSecret(config: Pick<KernelConfig, 'secret'>): void {
  if (process.env.NODE_ENV !== 'production') return
  const secret = config.secret ?? process.env.KERNEL_SECRET
  if (!secret) {
    throw new Error(
      '[KernelCMS] No `secret` or KERNEL_SECRET is set. A strong secret is required in production ' +
        '(NODE_ENV=production); the built-in development secret is public and would let anyone forge sessions.',
    )
  }
  if (secret === DEV_SECRET) {
    throw new Error('[KernelCMS] The development secret must not be used in production. Set a unique KERNEL_SECRET.')
  }
  if (secret.length < MIN_PRODUCTION_SECRET_LENGTH) {
    throw new Error(
      `[KernelCMS] The configured secret is too short (<${MIN_PRODUCTION_SECRET_LENGTH} chars) for production. ` +
        'Set KERNEL_SECRET to a long, random value.',
    )
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`KernelCMS config error: ${message}`)
}

const NAMING_RULE = 'snake_case (lowercase letter, then letters/digits/underscores)'

/** Collect snake_case + duplicate violations for a field list, recursing into
 *  group/array/blocks children so nested names are validated too. */
function collectFieldNameErrors(fields: ConfigField[], path: string, errors: string[]): void {
  const seen = new Set<string>()
  for (const field of effectiveFields(fields)) {
    const fp = `${path}.${field.name}`
    if (!IDENT_RE.test(field.name)) errors.push(`field "${fp}" must be ${NAMING_RULE}`)
    if (seen.has(field.name)) errors.push(`duplicate field "${fp}"`)
    seen.add(field.name)
    if (field.type === 'group' || field.type === 'array') {
      collectFieldNameErrors(field.fields, fp, errors)
    } else if (field.type === 'blocks') {
      for (const block of field.blocks) collectFieldNameErrors(block.fields, `${fp}.${block.slug}`, errors)
    }
  }
  for (const join of joinFields(fields)) {
    const jp = `${path}.${join.name}`
    if (!IDENT_RE.test(join.name)) errors.push(`join field "${jp}" must be ${NAMING_RULE}`)
    if (seen.has(join.name)) errors.push(`join field "${jp}" collides with a stored field`)
    seen.add(join.name)
  }
}

/** Validate slugs + field names across the whole config, returning ALL violations
 *  at once (with field paths) so every offender is fixable in one pass. */
function collectNamingErrors(collections: CollectionConfig[], globals: GlobalConfig[]): string[] {
  const errors: string[] = []
  for (const c of collections) {
    if (!IDENT_RE.test(c.slug)) errors.push(`collection slug "${c.slug}" must be ${NAMING_RULE}`)
    collectFieldNameErrors(c.fields, c.slug, errors)
  }
  for (const g of globals) {
    if (!IDENT_RE.test(g.slug)) errors.push(`global slug "${g.slug}" must be ${NAMING_RULE}`)
    // Globals are validated the same as collections (previously slug-only).
    collectFieldNameErrors(g.fields, g.slug, errors)
  }
  return errors
}

/**
 * Validate non-human principals. Each needs a unique, non-empty id and a non-empty
 * token (the bearer credential — authors source it from env). The real guard on an
 * agent is its `fieldScope.allow` plus the hard draft-only brake in operations; do
 * NOT give an agent an `admin` role (it would widen the access rules it passes —
 * the field scope still constrains writes, but role-gated rules would open up).
 */
function sanitizeAgents(agents: AgentConfig[] | undefined): AgentConfig[] {
  if (!agents || agents.length === 0) return []
  const ids = new Set<string>()
  const tokens = new Set<string>()
  for (const agent of agents) {
    assert(typeof agent.id === 'string' && agent.id.length > 0, 'every agent needs a non-empty `id`')
    assert(!ids.has(agent.id), `duplicate agent id "${agent.id}"`)
    ids.add(agent.id)
    assert(
      typeof agent.token === 'string' && agent.token.length > 0,
      `agent "${agent.id}" needs a non-empty \`token\` (source it from env)`,
    )
    assert(!tokens.has(agent.token), `two agents share the same token ("${agent.id}")`)
    tokens.add(agent.token)
    // Security boundary: 'admin' is the canonical role the auth layer trusts
    // (see `isAdminUser`). Granting it to an agent would widen every role-gated
    // read/access rule for a non-human caller. Fail-fast at startup.
    assert(
      !(agent.roles ?? []).includes('admin'),
      `agent "${agent.id}" must not be granted the 'admin' role (it would widen role-gated access rules)`,
    )
  }
  return agents
}

/** Normalize the opt-in audit setting. Disabled unless explicitly turned on. */
function sanitizeAudit(audit: KernelConfig['audit']): { enabled: boolean } {
  if (audit === true) return { enabled: true }
  if (audit && typeof audit === 'object') return { enabled: audit.enabled === true }
  return { enabled: false }
}

/**
 * Resolve the content-credential signing setting. OFF by default. A `secret` selects
 * HMAC-SHA256; a `{ privateKey, publicKey }` pair selects the asymmetric algorithm
 * (ed25519). Validated for SHAPE only — the key material is carried through verbatim
 * and is server-only (it is never logged or returned anywhere). Disabled when unset.
 */
function sanitizeSigning(signing: KernelConfig['signing']): SanitizedSigningConfig {
  if (!signing) return { enabled: false, algorithm: 'hmac-sha256' }
  if ('secret' in signing) {
    assert(
      typeof signing.secret === 'string' && signing.secret.length >= MIN_SIGNING_SECRET_LENGTH,
      `signing.secret must be at least ${MIN_SIGNING_SECRET_LENGTH} characters`,
    )
    return { enabled: true, algorithm: 'hmac-sha256', secret: signing.secret }
  }
  assert(
    typeof signing.privateKey === 'string' && signing.privateKey.length > 0,
    'signing requires a `privateKey` (or a `secret`)',
  )
  assert(typeof signing.publicKey === 'string' && signing.publicKey.length > 0, 'signing requires a `publicKey`')
  const algorithm = signing.algorithm ?? 'ed25519'
  assert(algorithm === 'ed25519', `unsupported signing algorithm "${algorithm}" (only 'ed25519' is supported)`)
  return { enabled: true, algorithm: 'ed25519', privateKey: signing.privateKey, publicKey: signing.publicKey }
}

/** Validate the pre-publish eval rules: each needs a non-empty unique name and a
 *  `run` function. The rules themselves run later at the publish chokepoint. */
function sanitizeEvals(evals: KernelConfig['evals']): EvalRule[] {
  if (!evals || evals.length === 0) return []
  const names = new Set<string>()
  for (const rule of evals) {
    assert(typeof rule.name === 'string' && rule.name.length > 0, 'every eval rule needs a non-empty `name`')
    assert(!names.has(rule.name), `duplicate eval rule name "${rule.name}"`)
    names.add(rule.name)
    assert(typeof rule.run === 'function', `eval rule "${rule.name}" needs a \`run\` function`)
  }
  return evals
}

/**
 * Resolve the agent-review inbox setting. The inbox exists to gate agent-authored
 * content, so it defaults ON when any `agents` are configured. An explicit `review`
 * boolean always wins (`true` forces it on even without agents; `false` forces it off
 * even with agents). With neither agents nor `review`, it stays off — fully
 * backward-compatible (no `_reviews` table, ops return empty / throw disabled).
 */
function sanitizeReview(review: KernelConfig['review'], hasAgents: boolean): { enabled: boolean } {
  if (review === true) return { enabled: true }
  if (review === false) return { enabled: false }
  return { enabled: hasAgents }
}

/** Default per-collection document cap for discoverability output (DoS guard). */
const DEFAULT_DISCO_DOCS_PER_COLLECTION = 1000
/** Default whole-corpus document cap for discoverability output (DoS guard). */
const DEFAULT_DISCO_DOCS_TOTAL = 5000

/** A positive, finite integer clamp with a fallback (for the output-size bounds). */
function clampPositiveInt(value: unknown, fallback: number): number {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * Resolve the AI-discoverability / GEO setting. OFF by default. When configured,
 * collections are selected by an opt-in/opt-out list merged with a safe default:
 * a collection is exposed only if it is NOT an auth/upload/system collection and is
 * not admin-hidden — the kinds of content a site would never publish to an AI engine.
 * The REAL security boundary is the anonymous access pipeline at generation time; this
 * selection just bounds WHICH collections are even considered. Per-collection entries
 * are validated against real collections (unknown slugs rejected fail-fast).
 */
function sanitizeDiscoverability(
  config: KernelConfig,
  collections: CollectionConfig[],
  collectionsBySlug: Record<string, CollectionConfig>,
): SanitizedDiscoverability {
  const disco = config.discoverability
  if (!disco) {
    return {
      enabled: false,
      collections: [],
      maxDocsPerCollection: DEFAULT_DISCO_DOCS_PER_COLLECTION,
      maxDocsTotal: DEFAULT_DISCO_DOCS_TOTAL,
    }
  }

  const overrides = new Map<string, DiscoverabilityCollectionConfig>()
  for (const entry of disco.collections ?? []) {
    assert(
      typeof entry.slug === 'string' && Boolean(collectionsBySlug[entry.slug]),
      `discoverability references unknown collection "${entry.slug}"`,
    )
    overrides.set(entry.slug, entry)
  }

  // System collections are never exposed. Auth (user accounts) and upload (binary
  // metadata) collections are excluded by default but MAY be force-included via an
  // explicit `{ include: true }` override (the anonymous read still gates content).
  const SYSTEM_SLUGS = new Set([JOBS_SLUG, CACHE_SLUG])
  const resolved: DiscoverabilityCollectionConfig[] = []
  for (const c of collections) {
    if (SYSTEM_SLUGS.has(c.slug)) continue
    const override = overrides.get(c.slug)
    const defaultInclude = !c.auth && !c.upload && !c.admin?.hidden
    const include = override?.include ?? defaultInclude
    if (!include) continue
    resolved.push({
      slug: c.slug,
      ...(override?.titleField ? { titleField: override.titleField } : {}),
      ...(override?.descriptionField ? { descriptionField: override.descriptionField } : {}),
      ...(override?.bodyField ? { bodyField: override.bodyField } : {}),
      ...(override?.urlPattern ? { urlPattern: override.urlPattern } : {}),
    })
  }

  // baseUrl falls back to serverURL; strip a trailing slash so URL joins are clean.
  const baseUrl = (disco.baseUrl ?? config.serverURL ?? 'http://localhost:3000').replace(/\/+$/, '')

  return {
    enabled: true,
    ...(disco.title ? { title: disco.title } : {}),
    ...(disco.description ? { description: disco.description } : {}),
    baseUrl,
    collections: resolved,
    maxDocsPerCollection: clampPositiveInt(disco.maxDocsPerCollection, DEFAULT_DISCO_DOCS_PER_COLLECTION),
    maxDocsTotal: clampPositiveInt(disco.maxDocsTotal, DEFAULT_DISCO_DOCS_TOTAL),
  }
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

  // Report every naming violation (slugs + field names, collections + globals) in
  // one shot, with field paths — instead of failing one error at a time.
  const namingErrors = collectNamingErrors(collections, globals)
  if (namingErrors.length > 0) {
    throw new Error(
      `KernelCMS config error: ${namingErrors.length} naming violation(s):\n  - ${namingErrors.join('\n  - ')}`,
    )
  }

  const collectionsBySlug: Record<string, CollectionConfig> = {}
  for (const collection of collections) {
    assert(!collectionsBySlug[collection.slug], `duplicate collection slug "${collection.slug}"`)
    collectionsBySlug[collection.slug] = collection
  }

  const globalsBySlug: Record<string, GlobalConfig> = {}
  for (const global of globals) {
    assert(!globalsBySlug[global.slug], `duplicate global slug "${global.slug}"`)
    assert(!collectionsBySlug[global.slug], `global "${global.slug}" collides with a collection slug`)
    globalsBySlug[global.slug] = global
  }

  let localization: SanitizedLocalization | false = false
  if (config.localization) {
    const { locales, defaultLocale, fallback, strict } = config.localization
    assert(locales.length > 0, 'localization.locales must not be empty')
    assert(locales.includes(defaultLocale), `localization.defaultLocale "${defaultLocale}" must be in locales`)
    localization = { locales, defaultLocale, fallback: fallback ?? true, strict: strict === true }
  }

  // Gate the production secret. This runs inside sanitizeConfig, so every boot
  // path — including the embedded `initKernel()` recipe that never calls doctor —
  // is protected: a missing/dev/weak secret fails closed in production.
  assertProductionSecret(config)
  const secret = config.secret ?? process.env.KERNEL_SECRET ?? devSecret()

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

  // Resolve per-collection searchable fields (only when a search adapter is set).
  const searchableFields: Record<string, string[]> = {}
  if (config.search) {
    for (const collection of collections) {
      if (collection.slug === JOBS_SLUG || collection.slug === CACHE_SLUG) continue
      const s = collection.search
      if (s && Array.isArray(s.fields) && s.fields.length > 0) searchableFields[collection.slug] = s.fields
    }
  }

  // Resolve semantic (vector) search. A collection opts in with `search.semantic`,
  // but it only takes effect when an embeddings provider is configured. The vector
  // store defaults to an in-memory cosine adapter (mirroring how `search` works),
  // so `embeddings` alone is enough to get working semantic search. Validate the
  // `embed` shape fail-fast at boot.
  const semanticFields: Record<string, string[]> = {}
  let vector = config.vector
  if (config.embeddings) {
    assert(
      typeof config.embeddings.embed === 'function',
      'config.embeddings.embed must be a function (texts) => Promise<number[][]>',
    )
    for (const collection of collections) {
      if (collection.slug === JOBS_SLUG || collection.slug === CACHE_SLUG) continue
      const s = collection.search
      if (s && s.semantic === true && Array.isArray(s.fields) && s.fields.length > 0) {
        semanticFields[collection.slug] = s.fields
      }
    }
    if (Object.keys(semanticFields).length > 0 && !vector) vector = memoryVector()
  }

  // Granular RBAC (opt-in via config.rbac). Create the mutable runtime store, seed it
  // from config, and INJECT a default access rule for every collection×op / global×op
  // that has no explicit rule. Explicit rules are left untouched (they win). The
  // injected closures capture `rbacStore` by reference, so runtime role edits take
  // effect immediately. When config.rbac is absent this is skipped entirely — nothing
  // changes, so the deny-by-default-with-no-rule behaviour is fully preserved.
  const rbacEnabled = Boolean(config.rbac)
  const rbacStore = createRbacStore(config.rbac)
  if (rbacEnabled) {
    injectRbac(rbacStore, collections, globals, (c) => resolveVersions(c.versions).drafts)
  }

  const agents = sanitizeAgents(config.agents)

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
    searchableFields,
    semanticFields,
    agents,
    audit: sanitizeAudit(config.audit),
    rbac: { enabled: rbacEnabled },
    rbacStore,
    review: sanitizeReview(config.review, agents.length > 0),
    signing: sanitizeSigning(config.signing),
    evals: sanitizeEvals(config.evals),
    discoverability: sanitizeDiscoverability(config, collections, collectionsBySlug),
    ...(config.search ? { search: config.search } : {}),
    ...(config.embeddings ? { embeddings: config.embeddings } : {}),
    ...(vector ? { vector } : {}),
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
