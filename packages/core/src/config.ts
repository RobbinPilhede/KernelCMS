import type {
  AccessFn,
  AgentConfig,
  AnyField,
  EncryptionConfig,
  SanitizedAnalytics,
  CollectionConfig,
  ConfigField,
  DiscoverabilityCollectionConfig,
  EvalRule,
  GlobalConfig,
  KernelConfig,
  OnExpireAction,
  SanitizedAudiences,
  SanitizedConfig,
  SanitizedLifecycle,
  SanitizedLifecycleCollection,
  SanitizedDiscoverability,
  SanitizedEdge,
  SanitizedExperiment,
  SanitizedStructuredData,
  StructuredDataCollectionConfig,
  SanitizedLocalization,
  SanitizedRealtime,
  SanitizedSigningConfig,
  SanitizedTenancy,
  SanitizedWebhook,
  TranslationConfig,
  WorkflowDefinition,
} from './types'
import { clampRetain } from './realtime'
import { clampAnalyticsRetain } from './analytics'
import { effectiveFields, joinFields } from './fields'
import { FORBIDDEN_SEGMENT_KEYS } from './personalization'
import { consoleEmail, type EmailAdapter } from './email'
import { createRbacStore, injectRbac } from './rbac'
import { injectTenancy, sanitizeTenancy } from './tenancy'
import { sanitizeTemplates } from './templates'
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

/**
 * Inject the server-managed tenant column into a tenant-scoped collection. The field is a
 * plain indexed text column (auto-stamped on create, immutable to clients on update). It is
 * write-locked at the field level to an unsatisfiable rule on BOTH create and update so a
 * client can never set or change it through the field-access path — the engine stamps it
 * directly via `overrideAccess`-free server logic in `create`/`update`. Read is left open
 * so the admin can display the owning tenant. Skipped when the field already exists.
 */
function withTenantField(collection: CollectionConfig, field: string): CollectionConfig {
  if (effectiveFields(collection.fields).some((f) => f.name === field)) return collection
  const tenantField: AnyField = {
    name: field,
    type: 'text',
    index: true,
    admin: { readOnly: true },
    // Server-managed: a client write of the tenant field is always denied at the field
    // level (defence in depth — the create/update ops also stamp/strip it directly).
    access: { create: () => false, update: () => false },
  }
  return { ...collection, fields: [...collection.fields, tenantField] }
}

/** Reserved slug for the injected background-jobs queue collection. */
export const JOBS_SLUG = 'kernel_jobs'

/** Reserved background-job task the workflow engine enqueues when a trigger fires.
 *  Draining it (via `runDueJobs` / `kernel jobs:run`) executes the workflow run durably,
 *  so a slow agent step never blocks the content write that triggered it. */
export const WORKFLOW_JOB_TASK = 'kernel_run_workflow'

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

/** Resolve the opt-in real-time setting. Disabled unless explicitly turned on. When on,
 *  `retain` (the `_changes` outbox cap) is clamped to a sane bound. */
function sanitizeRealtime(realtime: KernelConfig['realtime']): SanitizedRealtime {
  if (!realtime || realtime.enabled !== true) return { enabled: false, retain: clampRetain(undefined) }
  return { enabled: true, retain: clampRetain(realtime.retain) }
}

/** Default `Cache-Control` for a CACHEABLE (anonymous, public-read) content GET response:
 *  the browser always revalidates (`max-age=0`) while the CDN caches for a year
 *  (`s-maxage`) and serves stale while revalidating — combined with the purge feed this is
 *  effectively "cache forever at the edge, purge on change". */
const DEFAULT_EDGE_CACHE_CONTROL = 'public, max-age=0, s-maxage=31536000, stale-while-revalidate=60'
/** Default surrogate-key header name (the Fastly convention; Cloudflare uses `Cache-Tag`). */
const DEFAULT_EDGE_TAG_HEADER = 'Surrogate-Key'

/** A header NAME is used verbatim in an HTTP response; strip anything that isn't a valid
 *  token char so a misconfigured `tagHeader` can't inject a second header. Falls back to
 *  the default when nothing valid remains. */
function sanitizeHeaderName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const cleaned = value.replace(/[^A-Za-z0-9-]/g, '')
  return cleaned.length > 0 ? cleaned : fallback
}

/** Remove ASCII control chars (0x00–0x1f, 0x7f), including CR/LF, from a string — done by
 *  char-code filter to avoid embedding raw control chars in a regex (and an encoding hazard). */
function stripControlChars(value: string): string {
  let out = ''
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code > 0x1f && code !== 0x7f) out += value[i]
  }
  return out
}

/** A `Cache-Control` VALUE is set verbatim on a response; strip CR/LF/control chars so a
 *  hostile config value can't inject a header. Falls back to the default when empty. */
function sanitizeHeaderValue(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const cleaned = stripControlChars(value).trim()
  return cleaned.length > 0 ? cleaned : fallback
}

/** Resolve the opt-in edge content-delivery setting. Disabled unless explicitly turned on.
 *  When on, `cacheControl` + `tagHeader` are sanitized (they are written verbatim into HTTP
 *  responses) and `includeRelationships` defaults ON. The cacheControl value here is only
 *  ever applied to a CACHEABLE (anonymous, public-read) response — the server marks
 *  authenticated/scoped responses `private, no-store` regardless. */
function sanitizeEdge(edge: KernelConfig['edge']): SanitizedEdge {
  if (!edge || edge.enabled !== true) {
    return {
      enabled: false,
      cacheControl: DEFAULT_EDGE_CACHE_CONTROL,
      tagHeader: DEFAULT_EDGE_TAG_HEADER,
      includeRelationships: true,
    }
  }
  return {
    enabled: true,
    cacheControl: sanitizeHeaderValue(edge.cacheControl, DEFAULT_EDGE_CACHE_CONTROL),
    tagHeader: sanitizeHeaderName(edge.tagHeader, DEFAULT_EDGE_TAG_HEADER),
    includeRelationships: edge.includeRelationships !== false,
  }
}

/** Resolve the opt-in content-analytics setting. Disabled unless explicitly turned on.
 *  When on, `retain` (the `_analytics` row cap) is clamped to a sane bound and
 *  `autoCapture` (search / assignVariant auto-emit) defaults OFF. */
function sanitizeAnalytics(analytics: KernelConfig['analytics']): SanitizedAnalytics {
  if (!analytics || analytics.enabled !== true) {
    return { enabled: false, retain: clampAnalyticsRetain(undefined), autoCapture: false }
  }
  return {
    enabled: true,
    retain: clampAnalyticsRetain(analytics.retain),
    autoCapture: analytics.autoCapture === true,
  }
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

const MIN_ENCRYPTION_KEY_LENGTH = 16

/**
 * Validate field-level encryption. Every field marked `encrypted` is checked for an
 * incompatible flag (ciphertext is opaque + non-deterministic, so it can't be unique,
 * indexed, filtered/sorted, full-text searched, localized, or personalized), and the
 * encryption key is required + length-checked whenever any field is encrypted. Returns the
 * encryption config to thread into the cipher, or undefined when nothing is encrypted.
 */
function sanitizeEncryption(config: KernelConfig): EncryptionConfig | undefined {
  let any = false
  const checkField = (where: string, field: AnyField, searchFields: Set<string>): void => {
    if (!field.encrypted) return
    any = true
    assert(!field.unique, `field "${where}" cannot be both encrypted and unique (ciphertext is non-deterministic)`)
    assert(!field.index, `field "${where}" cannot be both encrypted and indexed (ciphertext is opaque)`)
    assert(!field.localized, `field "${where}" cannot be both encrypted and localized`)
    assert(!field.personalized, `field "${where}" cannot be both encrypted and personalized`)
    assert(field.type !== 'relationship', `field "${where}" cannot be encrypted (relationships must stay queryable)`)
    assert(!searchFields.has(field.name), `encrypted field "${where}" cannot be a search field (ciphertext is opaque)`)
  }
  // Reject `encrypted` on a field nested inside a group/array/blocks (or any non-top-level
  // position): the encrypt/decrypt chokepoint operates on top-level storage columns only, so
  // a nested `encrypted` flag would be a SILENT no-op storing plaintext. Fail loud instead.
  const rejectNestedEncrypted = (where: string, fields: ConfigField[] | undefined, insideNesting: boolean): void => {
    for (const field of fields ?? []) {
      const f = field as AnyField & { fields?: ConfigField[]; blocks?: { slug: string; fields: ConfigField[] }[] }
      const name = (f as AnyField).name ?? f.type
      if (insideNesting && (f as AnyField).encrypted) {
        assert(false, `field "${where}.${name}" cannot be encrypted (nested fields are not supported)`)
      }
      // group/array introduce a real nesting boundary; row/tabs/collapsible are presentational
      // (their children are top-level storage fields, already validated by checkField).
      const boundary = f.type === 'group' || f.type === 'array'
      if (Array.isArray(f.fields)) rejectNestedEncrypted(`${where}.${name}`, f.fields, insideNesting || boundary)
      if (Array.isArray(f.blocks)) {
        for (const block of f.blocks) rejectNestedEncrypted(`${where}.${name}.${block.slug}`, block.fields, true)
      }
      // A `tabs` field carries its children under `tabs[].fields` (presentational like row/tabs —
      // direct children are top-level, but a group/array INSIDE a tab is still a boundary).
      const tabs = (f as { tabs?: { fields?: ConfigField[] }[] }).tabs
      if (Array.isArray(tabs))
        for (const tab of tabs) rejectNestedEncrypted(`${where}.${name}`, tab.fields, insideNesting)
    }
  }
  for (const collection of config.collections ?? []) {
    const search = (collection as { search?: { fields?: string[] } }).search
    const searchFields = new Set(Array.isArray(search?.fields) ? search.fields : [])
    for (const field of effectiveFields(collection.fields ?? []))
      checkField(`${collection.slug}.${field.name}`, field, searchFields)
    rejectNestedEncrypted(collection.slug, collection.fields, false)
  }
  for (const global of config.globals ?? []) {
    for (const field of effectiveFields(global.fields ?? []))
      checkField(`${global.slug}.${field.name}`, field, new Set())
    rejectNestedEncrypted(global.slug, global.fields, false)
  }
  if (!any) return undefined
  assert(
    typeof config.encryption?.key === 'string' && config.encryption.key.length >= MIN_ENCRYPTION_KEY_LENGTH,
    `config.encryption.key (at least ${MIN_ENCRYPTION_KEY_LENGTH} chars) is required when a field is \`encrypted\``,
  )
  return { key: config.encryption.key }
}

/**
 * Resolve the AI-translation provider. OFF by default. When set, `translate` must be a
 * function (the pluggable provider) AND `localization` must be configured — a translation
 * targets a configured locale, so without localization there is nothing to translate.
 * Shape-only validation; the closure may hold an API key and is carried through verbatim
 * (never logged or returned). Disabled when unset.
 */
function sanitizeTranslation(
  translation: KernelConfig['translation'],
  hasLocalization: boolean,
): TranslationConfig | undefined {
  if (!translation) return undefined
  assert(
    typeof translation.translate === 'function',
    'config.translation.translate must be a function ({ texts, from, to }) => Promise<string[]>',
  )
  assert(hasLocalization, 'config.translation requires `localization` to be configured (it fills configured locales)')
  return { translate: translation.translate }
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

/**
 * Resolve the editorial-comments setting. OPT-IN and disabled by default — `true`
 * provisions the `_comments` table and enables the comment ops; anything else (absent /
 * `false`) stays off, fully backward-compatible (no table, the ops throw a clean
 * "disabled" error / return empty, exactly like releases/review when off).
 */
function sanitizeComments(comments: KernelConfig['comments']): { enabled: boolean } {
  return { enabled: comments === true }
}

/**
 * Resolve the saved-views setting. OPT-IN and disabled by default — `true` provisions the
 * `_views` table and enables the view ops; anything else (absent / `false`) stays off,
 * fully backward-compatible (no table, the ops throw a clean "disabled" error / return
 * empty, exactly like comments/releases when off).
 */
function sanitizeViews(views: KernelConfig['views']): { enabled: boolean } {
  return { enabled: views === true }
}

/**
 * Resolve the content-releases setting. OPT-IN and disabled by default — `true`
 * provisions the `_releases` + `_release_items` tables and the release ops; anything
 * else (absent / `false`) stays off, fully backward-compatible (no tables, ops throw a
 * clean "disabled" error or return empty, exactly like RBAC/review when off).
 */
function sanitizeReleases(releases: KernelConfig['releases']): { enabled: boolean } {
  return { enabled: releases === true }
}

/** Default expiry date field for a lifecycle-managed collection. */
const DEFAULT_LIFECYCLE_EXPIRE_FIELD = 'expire_at'

/**
 * Resolve the opt-in content-lifecycle setting (automatic expiry). OFF by default — when
 * omitted nothing changes (no `_archived_at` column, the drain is a no-op). When set, each
 * listed collection is validated FAIL-FAST:
 *  - the slug must be a real, non-system collection;
 *  - it must have DRAFTS enabled — every `onExpire` action (`unpublish`/`archive` move the
 *    draft|published state machine, `delete` removes the doc) is only meaningful with the
 *    draft lifecycle, and `_status` only exists on a drafts collection;
 *  - the declared `expireField` (default `expire_at`) must already be declared on the
 *    collection as a `date` field (the developer owns the schema — we never auto-add it,
 *    so the field flows through normal field access, validation, and types).
 * Each entry is fully defaulted; `archiveSlugs` lists the collections that take the
 * `archive` action (the schema injects a server-managed `_archived_at` column for them).
 */
function sanitizeLifecycle(
  lifecycle: KernelConfig['lifecycle'],
  collectionsBySlug: Record<string, CollectionConfig>,
  systemSlugs: Set<string>,
): SanitizedLifecycle {
  if (!lifecycle || !Array.isArray(lifecycle.collections) || lifecycle.collections.length === 0) {
    return { enabled: false, collections: [], archiveSlugs: [] }
  }
  const seen = new Set<string>()
  const resolved: SanitizedLifecycleCollection[] = []
  const archiveSlugs: string[] = []
  for (const entry of lifecycle.collections) {
    const slug = entry.slug
    assert(typeof slug === 'string' && slug.length > 0, 'every lifecycle collection needs a `slug`')
    assert(!seen.has(slug), `duplicate lifecycle collection "${slug}"`)
    seen.add(slug)
    const collection = collectionsBySlug[slug]
    assert(Boolean(collection) && !systemSlugs.has(slug), `lifecycle references unknown collection "${slug}"`)
    assert(
      resolveVersions(collection!.versions).drafts,
      `lifecycle collection "${slug}" must have drafts enabled (versions: { drafts: true })`,
    )
    const onExpire: OnExpireAction = entry.onExpire ?? 'unpublish'
    assert(
      onExpire === 'unpublish' || onExpire === 'archive' || onExpire === 'delete',
      `lifecycle collection "${slug}" has invalid onExpire "${onExpire}" (use 'unpublish' | 'archive' | 'delete')`,
    )
    const expireField = entry.expireField ?? DEFAULT_LIFECYCLE_EXPIRE_FIELD
    assert(
      typeof expireField === 'string' && expireField.length > 0,
      `lifecycle collection "${slug}" has an invalid \`expireField\``,
    )
    const field = effectiveFields(collection!.fields).find((f) => 'name' in f && f.name === expireField)
    assert(
      Boolean(field),
      `lifecycle collection "${slug}" has no field "${expireField}" — declare it as a \`date\` field (or set \`expireField\`)`,
    )
    assert(
      field!.type === 'date',
      `lifecycle collection "${slug}" field "${expireField}" must be a \`date\` field (got "${field!.type}")`,
    )
    resolved.push({ slug, expireField, onExpire })
    if (onExpire === 'archive') archiveSlugs.push(slug)
  }
  return { enabled: true, collections: resolved, archiveSlugs }
}

/**
 * Validate autonomous workflows. Each needs a unique snake_case slug and at least one
 * named step with a `run` function. A workflow's `agent` (when set) must name a real
 * configured agent — and that agent must NOT hold the 'admin' role (consistency with
 * the agent rules: an admin agent would widen role-gated access, defeating the brake).
 * A create/update trigger must name a real, non-system collection. The steps themselves
 * run later through the engine; here we only fail-fast on a misconfiguration.
 */
function sanitizeWorkflows(
  workflows: WorkflowDefinition[] | undefined,
  agents: AgentConfig[],
  collectionSlugs: ReadonlySet<string>,
  systemSlugs: ReadonlySet<string>,
): WorkflowDefinition[] {
  if (!workflows || workflows.length === 0) return []
  const agentsById = new Map(agents.map((a) => [a.id, a]))
  const slugs = new Set<string>()
  for (const wf of workflows) {
    assert(typeof wf.slug === 'string' && IDENT_RE.test(wf.slug), `workflow slug "${wf.slug}" must be ${NAMING_RULE}`)
    assert(!slugs.has(wf.slug), `duplicate workflow slug "${wf.slug}"`)
    slugs.add(wf.slug)
    assert(Array.isArray(wf.steps) && wf.steps.length > 0, `workflow "${wf.slug}" needs at least one step`)
    const stepNames = new Set<string>()
    for (const step of wf.steps) {
      assert(typeof step.name === 'string' && step.name.length > 0, `workflow "${wf.slug}" has a step with no \`name\``)
      assert(!stepNames.has(step.name), `workflow "${wf.slug}" has duplicate step "${step.name}"`)
      stepNames.add(step.name)
      assert(typeof step.run === 'function', `workflow "${wf.slug}" step "${step.name}" needs a \`run\` function`)
    }
    if (wf.agent !== undefined) {
      const agent = agentsById.get(wf.agent)
      assert(agent !== undefined, `workflow "${wf.slug}" references unknown agent "${wf.agent}"`)
      assert(
        !(agent!.roles ?? []).includes('admin'),
        `workflow "${wf.slug}" agent "${wf.agent}" must not have the 'admin' role`,
      )
    }
    const trigger = wf.trigger
    if (trigger && (trigger.on === 'create' || trigger.on === 'update')) {
      assert(
        typeof trigger.collection === 'string' && trigger.collection.length > 0,
        `workflow "${wf.slug}" ${trigger.on} trigger needs a \`collection\``,
      )
      assert(
        collectionSlugs.has(trigger.collection!) && !systemSlugs.has(trigger.collection!),
        `workflow "${wf.slug}" trigger collection "${trigger.collection}" does not exist`,
      )
    }
  }
  return workflows
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

/** Mapping keys that would be prototype-pollution vectors if used as object property
 *  names when building the JSON-LD output. A configured `mapping` is trusted config, but
 *  we still reject these fail-closed so a copy-pasted hostile config can't poison output. */
const FORBIDDEN_JSONLD_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Resolve the schema.org structured-data (JSON-LD) setting. OFF by default. When
 * configured, each listed collection must reference a real collection and carry a
 * non-empty `type` (a schema.org type, trusted config). An explicit `mapping`'s keys
 * (schema.org property names, used as output object keys) are validated against
 * prototype-pollution vectors. `baseUrl` falls back to `serverURL` (trailing slash
 * stripped) so canonical `@id` URLs join cleanly.
 */
function sanitizeStructuredData(
  config: KernelConfig,
  collectionsBySlug: Record<string, CollectionConfig>,
): SanitizedStructuredData {
  const sd = config.structuredData
  const baseUrl = (sd?.baseUrl ?? config.serverURL ?? 'http://localhost:3000').replace(/\/+$/, '')
  if (!sd) {
    return { enabled: false, baseUrl, collections: [] }
  }

  const seen = new Set<string>()
  const resolved: StructuredDataCollectionConfig[] = []
  for (const entry of sd.collections ?? []) {
    assert(
      typeof entry.slug === 'string' && Boolean(collectionsBySlug[entry.slug]),
      `structuredData references unknown collection "${entry.slug}"`,
    )
    assert(
      typeof entry.type === 'string' && entry.type.trim().length > 0,
      `structuredData collection "${entry.slug}" requires a non-empty schema.org \`type\``,
    )
    assert(!seen.has(entry.slug), `structuredData lists collection "${entry.slug}" more than once`)
    seen.add(entry.slug)
    let mapping: Record<string, string> | undefined
    if (entry.mapping) {
      const encryptedNames = new Set(
        effectiveFields(collectionsBySlug[entry.slug]?.fields ?? [])
          .filter((f) => f.encrypted)
          .map((f) => f.name),
      )
      const clean: Record<string, string> = {}
      for (const [property, field] of Object.entries(entry.mapping)) {
        assert(
          !FORBIDDEN_JSONLD_KEYS.has(property),
          `structuredData mapping for "${entry.slug}" uses an illegal property key "${property}"`,
        )
        // An encrypted field's plaintext must never be published into anonymous JSON-LD.
        assert(
          !encryptedNames.has(field),
          `structuredData mapping for "${entry.slug}" cannot map "${property}" to the encrypted field "${field}"`,
        )
        if (typeof field === 'string' && field.length > 0) clean[property] = field
      }
      mapping = clean
    }
    resolved.push({
      slug: entry.slug,
      type: entry.type.trim(),
      ...(mapping ? { mapping } : {}),
      ...(entry.urlPattern ? { urlPattern: entry.urlPattern } : {}),
    })
  }

  return { enabled: true, baseUrl, collections: resolved }
}

/**
 * Resolve the audience-segments config (the personalization parallel of localization).
 * OFF by default. When set: `segments` must be a non-empty list of safe, unique ids
 * (prototype-pollution keys rejected — a segment id becomes a map key), and `default`
 * must be one of them. `personalized` fields require this to be enabled.
 */
function sanitizeAudiences(audiences: KernelConfig['audiences']): SanitizedAudiences {
  if (!audiences) return { enabled: false, segments: [], default: '' }
  assert(
    Array.isArray(audiences.segments) && audiences.segments.length > 0,
    'audiences.segments must be a non-empty array',
  )
  const seen = new Set<string>()
  for (const segment of audiences.segments) {
    assert(typeof segment === 'string' && segment.length > 0, 'every audience segment must be a non-empty string')
    assert(!FORBIDDEN_SEGMENT_KEYS.has(segment), `audience segment "${segment}" is a reserved key and cannot be used`)
    assert(!seen.has(segment), `duplicate audience segment "${segment}"`)
    seen.add(segment)
  }
  assert(
    typeof audiences.default === 'string' && seen.has(audiences.default),
    `audiences.default "${audiences.default}" must be one of audiences.segments`,
  )
  return { enabled: true, segments: [...audiences.segments], default: audiences.default }
}

/**
 * Validate A/B experiments. Each needs a unique snake_case slug and at least two
 * variants, every variant a configured audience segment. `weights` (when given) must be
 * one-per-variant, finite, non-negative, and sum > 0; default is equal weights. `seed`
 * defaults to the slug. Requires `audiences` enabled (a variant IS a segment).
 */
function sanitizeExperiments(
  experiments: KernelConfig['experiments'],
  audiences: SanitizedAudiences,
): SanitizedExperiment[] {
  if (!experiments || experiments.length === 0) return []
  assert(audiences.enabled, 'experiments require `audiences` to be configured (a variant is an audience segment)')
  const segments = new Set(audiences.segments)
  const slugs = new Set<string>()
  const resolved: SanitizedExperiment[] = []
  for (const exp of experiments) {
    assert(
      typeof exp.slug === 'string' && IDENT_RE.test(exp.slug),
      `experiment slug "${exp.slug}" must be ${NAMING_RULE}`,
    )
    assert(!slugs.has(exp.slug), `duplicate experiment slug "${exp.slug}"`)
    slugs.add(exp.slug)
    assert(
      Array.isArray(exp.variants) && exp.variants.length >= 2,
      `experiment "${exp.slug}" needs at least two variants`,
    )
    for (const variant of exp.variants) {
      assert(
        segments.has(variant),
        `experiment "${exp.slug}" variant "${variant}" is not a configured audience segment`,
      )
    }
    let weights: number[]
    if (exp.weights !== undefined) {
      assert(
        Array.isArray(exp.weights) && exp.weights.length === exp.variants.length,
        `experiment "${exp.slug}" weights must have one entry per variant`,
      )
      for (const w of exp.weights) {
        assert(typeof w === 'number' && Number.isFinite(w) && w >= 0, `experiment "${exp.slug}" has an invalid weight`)
      }
      assert(
        exp.weights.reduce((sum, w) => sum + w, 0) > 0,
        `experiment "${exp.slug}" weights must sum to a positive number`,
      )
      weights = [...exp.weights]
    } else {
      weights = exp.variants.map(() => 1)
    }
    resolved.push({ slug: exp.slug, variants: [...exp.variants], weights, seed: exp.seed ?? exp.slug })
  }
  return resolved
}

/**
 * Whether a URL host is a literal loopback / private / link-local / cloud-metadata
 * address that an outbound webhook must NOT reach by default (SSRF egress guard). Covers
 * the common literal-IP and localhost cases; DNS-rebind (a public name resolving to a
 * private IP at delivery time) is out of scope and documented as such.
 */
function isPrivateWebhookHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '') // strip IPv6 brackets
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return true
  }
  // IPv6 loopback / unspecified / unique-local (fc00::/7) / link-local (fe80::/10).
  if (host === '::1' || host === '::' || host.startsWith('fc') || host.startsWith('fd')) return true
  if (/^fe[89ab]/.test(host)) return true // fe80::/10 (fe80–febf), not just fe8
  // Any IPv6 form that embeds an IPv4 in its low 32 bits — IPv4-mapped (`::ffff:127.0.0.1`
  // and the hex-compressed form Node emits, `::ffff:a9fe:a9fe`), IPv4-compatible (`::7f00:1`),
  // or NAT64 (`64:ff9b::a9fe:a9fe`). Decode the embedded v4 and run the v4 check on it: a
  // dotted-decimal-only tail check was the SSRF hole both red-teams found (`[::ffff:a9fe:a9fe]`
  // = 169.254.169.254 metadata slipped through).
  let target = host
  const embedded = host.match(/^(?:::(?:ffff:)?|64:ff9b::)([0-9a-f.:]+)$/)
  if (embedded) {
    const tail = embedded[1]!
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(tail)) {
      target = tail // dotted form, e.g. ::ffff:127.0.0.1
    } else if (/^[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*$/.test(tail)) {
      // Hex groups — the embedded v4 is the last 32 bits (two 16-bit groups).
      const groups = tail.split(':').filter(Boolean)
      const hi = parseInt(groups[groups.length - 2] ?? '0', 16)
      const lo = parseInt(groups[groups.length - 1] ?? '0', 16)
      target = `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`
    } else {
      return true // an embedded-v4 form we can't confidently decode → deny by default
    }
  }
  const m = target.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  if (a === 127 || a === 10 || a === 0) return true // loopback / private / "this host"
  if (a === 169 && b === 254) return true // link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
  if (a === 192 && b === 168) return true // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 CGNAT
  return false
}

/**
 * Normalize the configured outbound webhooks: validate each URL is a real `http(s)` URL,
 * enforce the SSRF egress guard (reject private/loopback/metadata hosts unless the endpoint
 * opts into `allowPrivateNetwork`), assign a unique stable `slug` (derived from the URL when
 * absent), and default/clamp `maxAttempts`. Throws on a malformed or unsafe endpoint.
 */
function sanitizeWebhooks(
  webhooks: KernelConfig['webhooks'],
  collectionsBySlug: Record<string, unknown>,
): SanitizedWebhook[] {
  if (!webhooks || webhooks.length === 0) return []
  const slugs = new Set<string>()
  const out: SanitizedWebhook[] = []
  for (const [i, w] of webhooks.entries()) {
    let parsed: URL
    try {
      parsed = new URL(w.url)
    } catch {
      throw new Error(`KernelCMS config error: webhook ${i} has an invalid url "${w.url}".`)
    }
    assert(
      parsed.protocol === 'http:' || parsed.protocol === 'https:',
      `webhook ${i} url must be http(s), got "${parsed.protocol}".`,
    )
    if (!w.allowPrivateNetwork) {
      assert(
        !isPrivateWebhookHost(parsed.hostname),
        `webhook ${i} url "${w.url}" targets a private/loopback host; set allowPrivateNetwork to permit it (SSRF guard).`,
      )
    }
    if (w.collections) {
      for (const slug of w.collections) {
        assert(
          Object.prototype.hasOwnProperty.call(collectionsBySlug, slug),
          `webhook ${i} references unknown collection "${slug}".`,
        )
      }
    }
    // A stable slug: explicit, else derived from host+path so the delivery log is keyable.
    let slug = w.slug
    if (slug != null) {
      assert(IDENT_RE.test(slug), `webhook slug "${slug}" must be ${NAMING_RULE}.`)
    } else {
      const base = `${parsed.hostname}${parsed.pathname}`
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
      slug = `wh_${base || 'endpoint'}`.slice(0, 60)
    }
    let unique = slug
    let n = 2
    while (slugs.has(unique)) unique = `${slug}_${n++}`
    slugs.add(unique)
    const maxAttempts = Math.min(Math.max(Math.trunc(w.maxAttempts ?? 5), 1), 20)
    out.push({ ...w, slug: unique, maxAttempts })
  }
  return out
}

/**
 * Reject a field that is BOTH `localized` and `personalized`: they are parallel,
 * mutually-exclusive per-key storage models (one keyed by locale, one by segment) and a
 * single JSON column can't be both. Also reject a `personalized` field when no
 * `audiences` are configured (it would have no segments to key by). Recurses into
 * group/array/blocks children, mirroring `collectFieldNameErrors`.
 */
function collectPersonalizationErrors(
  fields: ConfigField[],
  path: string,
  audiencesEnabled: boolean,
  errors: string[],
): void {
  for (const field of effectiveFields(fields)) {
    const fp = `${path}.${field.name}`
    if (field.localized && field.personalized) {
      errors.push(`field "${fp}" cannot be both \`localized\` and \`personalized\``)
    }
    if (field.personalized && !audiencesEnabled) {
      errors.push(`field "${fp}" is \`personalized\` but no \`audiences\` are configured`)
    }
    if (field.type === 'group' || field.type === 'array') {
      collectPersonalizationErrors(field.fields, fp, audiencesEnabled, errors)
    } else if (field.type === 'blocks') {
      for (const block of field.blocks) {
        collectPersonalizationErrors(block.fields, `${fp}.${block.slug}`, audiencesEnabled, errors)
      }
    }
  }
}

export function sanitizeConfig(config: KernelConfig): SanitizedConfig {
  assert(config.db, 'a database adapter is required (config.db)')
  assert(Array.isArray(config.collections), 'config.collections must be an array')

  const baseCollections = [...config.collections]
  // Background jobs: inject the reserved queue collection (guard against collision).
  // Workflows ride the same durable queue (triggers enqueue runs), so its presence also
  // provisions the jobs collection — even when the project defines no `jobs` of its own.
  const hasWorkflows = Boolean(config.workflows && config.workflows.length > 0)
  if ((config.jobs && config.jobs.length > 0) || hasWorkflows) {
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
  let collections = baseCollections.map((c) => {
    let out = c
    if (out.auth) out = withAuthFields(out, hasOAuth)
    if (out.upload) out = withUploadFields(out)
    return out
  })
  const globals = config.globals ?? []

  // Multi-tenancy (opt-in). Resolve the scoped collections + tenant field FIRST (validated
  // against the real, non-system collection list), then inject the server-managed tenant
  // column into each scoped collection — like rbac/audit add columns. The access scope is
  // injected later (after rbac), so the tenant scope wraps the collection's own rule.
  const SYSTEM_SLUGS = new Set([JOBS_SLUG, CACHE_SLUG])
  const tenancy = sanitizeTenancy(config.tenancy, collections, SYSTEM_SLUGS, assert)
  if (tenancy.enabled) {
    const scoped = new Set(tenancy.collections)
    collections = collections.map((c) => (scoped.has(c.slug) ? withTenantField(c, tenancy.field) : c))
  }

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

  // Personalization: resolve audience segments + A/B experiments, then validate every
  // field's localized/personalized combo across collections AND globals in one shot.
  const audiences = sanitizeAudiences(config.audiences)
  const experiments = sanitizeExperiments(config.experiments, audiences)
  const experimentsBySlug: Record<string, SanitizedExperiment> = {}
  for (const exp of experiments) experimentsBySlug[exp.slug] = exp
  const personalizationErrors: string[] = []
  for (const c of collections) collectPersonalizationErrors(c.fields, c.slug, audiences.enabled, personalizationErrors)
  for (const g of globals) collectPersonalizationErrors(g.fields, g.slug, audiences.enabled, personalizationErrors)
  if (personalizationErrors.length > 0) {
    throw new Error(
      `KernelCMS config error: ${personalizationErrors.length} personalization violation(s):\n  - ${personalizationErrors.join('\n  - ')}`,
    )
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

  // AI-assisted translation (opt-in). Validate the provider is a function and that
  // localization is configured (a translation targets a configured locale).
  const translation = sanitizeTranslation(config.translation, Boolean(localization))

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

  // Multi-tenancy access scope. Injected AFTER rbac so the tenant scope wraps whatever rule
  // governs the collection (explicit OR rbac-injected OR the secure-by-default base),
  // AND-combining a per-tenant `Where` so the existing find/findByID/update/delete/count
  // pipeline auto-filters by tenant. No-op when tenancy is disabled.
  injectTenancy(tenancy, collections)

  const agents = sanitizeAgents(config.agents)
  const collectionSlugSet = new Set(collections.map((c) => c.slug))
  const workflows = sanitizeWorkflows(config.workflows, agents, collectionSlugSet, new Set([JOBS_SLUG, CACHE_SLUG]))

  // Resolve the registered job handlers. When workflows are configured they ride the
  // durable queue, so append a placeholder for the reserved drain task — its handler is
  // bound by `initKernel` once the engine (which needs the ops) exists. The placeholder
  // throws if somehow invoked before binding, so a misordered boot fails loudly.
  let jobs = config.jobs && config.jobs.length > 0 ? [...config.jobs] : []
  if (workflows.length > 0) {
    assert(
      !jobs.some((j) => j.slug === WORKFLOW_JOB_TASK),
      `job task "${WORKFLOW_JOB_TASK}" is reserved for the workflow engine`,
    )
    jobs = [
      ...jobs,
      {
        slug: WORKFLOW_JOB_TASK,
        maxAttempts: 1,
        handler: () => {
          throw new Error('The workflow drain job is not bound yet (initKernel wires it).')
        },
      },
    ]
  }

  // Content templates (opt-in): named document skeletons. Validated against real,
  // non-system collections; `data` deep-cloned + frozen (no prototype-pollution keys).
  const { templates, templatesBySlug } = sanitizeTemplates(config.templates, collectionsBySlug, SYSTEM_SLUGS, assert)

  return {
    serverURL: config.serverURL ?? 'http://localhost:3000',
    db: config.db,
    collections,
    globals,
    localization,
    audiences,
    experiments,
    experimentsBySlug,
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
    realtime: sanitizeRealtime(config.realtime),
    edge: sanitizeEdge(config.edge),
    analytics: sanitizeAnalytics(config.analytics),
    rbac: { enabled: rbacEnabled },
    rbacStore,
    tenancy,
    review: sanitizeReview(config.review, agents.length > 0),
    comments: sanitizeComments(config.comments),
    views: sanitizeViews(config.views),
    releases: sanitizeReleases(config.releases),
    lifecycle: sanitizeLifecycle(config.lifecycle, collectionsBySlug, SYSTEM_SLUGS),
    signing: sanitizeSigning(config.signing),
    ...(sanitizeEncryption(config) ? { encryption: sanitizeEncryption(config) } : {}),
    evals: sanitizeEvals(config.evals),
    workflows,
    discoverability: sanitizeDiscoverability(config, collections, collectionsBySlug),
    structuredData: sanitizeStructuredData(config, collectionsBySlug),
    templates,
    templatesBySlug,
    ...(config.search ? { search: config.search } : {}),
    ...(config.embeddings ? { embeddings: config.embeddings } : {}),
    ...(vector ? { vector } : {}),
    ...(translation ? { translation } : {}),
    ...(config.storage ? { storage: config.storage } : {}),
    ...(config.image ? { image: config.image } : {}),
    ...(email ? { email } : {}),
    ...(config.cache ? { cache: config.cache } : {}),
    webhooks: sanitizeWebhooks(config.webhooks, collectionsBySlug),
    ...(jobs.length > 0 ? { jobs } : {}),
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
