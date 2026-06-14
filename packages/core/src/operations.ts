import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { DatabaseAdapter, Logger, PaginatedResult, Row, SortSpec, Where } from '@kernel/db'
import { extForFormat, generateKey, isContentTypeConsistent, sniffMimeType, type StorageAdapter } from '@kernel/storage'
import type {
  AssignVariantOptions,
  AssignVariantResult,
  AuditAction,
  AuditDoc,
  AuthResult,
  AuthUser,
  BlockDef,
  BlocksField,
  CollectionConfig,
  ComposePageOptions,
  FindAuditLogOptions,
  FindReviewQueueOptions,
  ReviewDecision,
  ReviewDoc,
  ReviewQueueItem,
  SubmitReviewOptions,
  SubmitReviewResult,
  ConfigField,
  CountOptions,
  CreateOptions,
  DeleteOptions,
  Doc,
  FindByIDOptions,
  FindGlobalOptions,
  FindOptions,
  FindVersionsOptions,
  HistoryEntry,
  HistoryOptions,
  DiffVersionsOptions,
  VersionDiff,
  RestoreAsOfOptions,
  ForgotPasswordOptions,
  GlobalConfig,
  LoginOptions,
  VerifyOptions,
  PublishOptions,
  RequestContext,
  RestoreVersionOptions,
  RoleDef,
  RoleMutationOptions,
  AcquireLockOptions,
  AcquireLockResult,
  ReleaseLockOptions,
  ReleaseLockResult,
  GetLockOptions,
  ListLocksOptions,
  LockDoc,
  HeartbeatOptions,
  GetPresenceOptions,
  PresenceEntry,
  PresenceKind,
  BulkResult,
  CreateAPIKeyOptions,
  CreateFromTemplateOptions,
  ListTemplatesOptions,
  TemplateSummary,
  ContentLifecycleAction,
  DeleteManyOptions,
  EnqueueOptions,
  ProcessContentLifecycleOptions,
  ProcessContentLifecycleResult,
  ProcessScheduledOptions,
  ProcessScheduledResult,
  RunJobsOptions,
  RunJobsResult,
  SanitizedConfig,
  UpdateGlobalOptions,
  UpdateLocalesOptions,
  UpdateManyOptions,
  UpdateOptions,
  TranslationStatusOptions,
  TranslationStatusListOptions,
  TranslateDocumentOptions,
  TranslateMissingOptions,
  UploadConfig,
  UploadDocOptions,
  VersionDoc,
  ProvenanceOptions,
  Provenance,
  ProvenanceEntry,
  PrincipalRef,
  GetCredentialOptions,
  CredentialDoc,
  VerifyCredentialOptions,
  VerifyCredentialResult,
  Release,
  ReleaseItem,
  ReleaseStatus,
  ReleaseWithItems,
  CreateReleaseOptions,
  ReleaseMemberOptions,
  GetReleaseOptions,
  ListReleasesOptions,
  PreviewReleaseResult,
  ReleasePreviewItem,
  PublishReleaseOptions,
  PublishReleaseResult,
  ScheduleReleaseOptions,
  CancelReleaseOptions,
  ProcessScheduledReleasesOptions,
  ProcessScheduledReleasesResult,
  CommentDoc,
  AddCommentOptions,
  ListCommentsOptions,
  ResolveCommentOptions,
  DeleteCommentOptions,
  CommentCountOptions,
  ViewDoc,
  SaveViewOptions,
  ListViewsOptions,
  GetViewOptions,
  UpdateViewOptions,
  DeleteViewOptions,
  ApplyViewOptions,
  ProcessWebhooksOptions,
  ProcessWebhooksResult,
  WebhookDeliveryDoc,
  WebhookDeliveriesOptions,
  RetryWebhookDeliveryOptions,
  WebhookSummary,
  WebhookEvent,
  SignedAssetUrlOptions,
  DocumentActivityOptions,
  DocumentActivityResult,
  DocumentActivityEvent,
  DocumentActivityType,
  SubscriptionDoc,
  CreateSubscriptionOptions,
  ListSubscriptionsOptions,
  DeleteSubscriptionOptions,
  ProcessSubscriptionsOptions,
  ProcessSubscriptionsResult,
} from './types'
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  TooManyRequestsError,
  UnauthorizedError,
  ValidationError,
  isKernelError,
} from './errors'
import {
  generateOpaqueToken,
  generateTotpSecret,
  hashOpaqueToken,
  hashPassword,
  otpauthURL,
  signToken,
  verifyPassword,
  verifyToken,
  verifyTotpStep,
} from './auth'
import {
  applyDefaults,
  deserializeDoc,
  effectiveFields,
  joinFields,
  relationshipFields,
  serializeDoc,
  storageFields,
  validateFields,
  validateLocaleRequired,
} from './fields'
import { evalAccess, isAllowed, asWhere } from './access'
import { bucketVariant, fnv1a32 } from './personalization'
import { JOBS_SLUG } from './config'
import { ROLES_TABLE, cloneRoleDef, assertValidRoleDef } from './rbac'
import { resolveTenant } from './tenancy'
import { mergeTemplateData, TemplateMergeError } from './templates'
import { matchesWhere, mergeWhere, parseSort } from './query'
import { deliverWebhook, type WebhookPayload } from './webhooks'
import { signAssetUrl } from './asset-urls'
import { createFieldCipher } from './encryption'
import {
  AUDIT_TABLE,
  COMMENTS_TABLE,
  CREDENTIALS_TABLE,
  GLOBAL_ROW_ID,
  LOCKS_TABLE,
  PRESENCE_TABLE,
  RELEASES_TABLE,
  RELEASE_ITEMS_TABLE,
  REVIEWS_TABLE,
  VIEWS_TABLE,
  WEBHOOK_DELIVERIES_TABLE,
  SUBSCRIPTIONS_TABLE,
  CHANGES_TABLE,
  resolveVersions,
  tableForGlobal,
  tableForVersions,
} from './schema'
import { createSigner, hashContent, signManifest, verifyManifest, type Signer, type ContentManifest } from './signing'
import { runEvals } from './evals'
import { changedFieldNames, diffDocs, parseTimestamp } from './timemachine'

export interface OperationCtx {
  config: SanitizedConfig
  db: DatabaseAdapter
  /** Optional logger; audit-write failures are warned through it (never thrown). */
  logger?: Logger
}

/** Arguments for {@link Operations.recordAudit}. */
export interface RecordAuditArgs {
  action: AuditAction
  collection?: string | null
  documentId?: string | null
  /** Request context — its `user` supplies the default principal id/kind. */
  req?: RequestContext
  overrideAccess?: boolean
  /** Explicit principal id, overriding `req.user.id` (used by auth events). */
  principalId?: string | null
  /** Explicit principal kind, overriding the req-derived default. */
  principalType?: AuditDoc['principalType']
  fields?: string[] | null
  meta?: Record<string, unknown> | null
}

const MAX_LIMIT = 1000
const DEFAULT_LIMIT = 25
/** Max `and`/`or` nesting depth a `where` filter may have — bounds the validator's
 *  recursion so a pathologically deep client filter can't exhaust the stack. */
const MAX_WHERE_DEPTH = 30
/** Signed-asset-URL lifetime: default 1 hour, max 7 days. */
const DEFAULT_ASSET_TTL = 3600
const MAX_ASSET_TTL = 7 * 24 * 3600
// Bounds on agent/MCP-reachable review surfaces (storage-growth guard, not auth).
const MAX_COMPOSE_BLOCKS = 200
const MAX_REVIEW_NOTE = 10_000
// Bound on an editorial comment body (untrusted, agent/MCP-reachable storage-growth guard).
const MAX_COMMENT_BODY = 10_000
// Per-field cap for AI translation input (the provider is billed/external).
const MAX_TRANSLATE_CHARS = 50_000

// Hard cap on relationship populate recursion. `depth` flows uncapped from the
// Local API / REST / MCP into the recursive populate; an unbounded value over a
// cyclic relation graph (e.g. a self-referential `comments.parent`) recurses
// ~depth levels with one batched DB read per level → resource-exhaustion DoS.
// Mirrors GraphQL's DEFAULT_MAX_DEPTH so both surfaces bound identically. Clamped
// at the single populate chokepoint, so EVERY caller (find/findByID/create/update,
// REST, MCP) is bounded. Normal depths (0,1,2…) are unaffected.
export const MAX_POPULATE_DEPTH = 10

// Login brute-force protection. A per-identifier failure counter with a sliding
// window: too many failures within the window locks further attempts until it
// elapses. In-memory and per-process — adequate for a single node; a multi-node
// deployment should front this with a shared store (Redis) via a future adapter.
const LOGIN_MAX_FAILURES = 10
const LOGIN_WINDOW_MS = 15 * 60 * 1000

// Throttle unauthenticated, email-sending actions (forgot-password, resend
// verification) so they can't be used to mail-bomb an address or run up the email
// provider bill. Same in-memory/per-process caveat as the login limiter.
const EMAIL_ACTION_MAX = 3
const EMAIL_ACTION_WINDOW_MS = 15 * 60 * 1000

// Auth columns the server owns end-to-end. They are stripped from untrusted
// create/update input so a row owner can't self-grant verification, keys, or 2FA
// state, or tamper with the session epoch. Set only via trusted (overrideAccess)
// paths and the dedicated auth operations.
const SYSTEM_AUTH_FIELDS = [
  'hash',
  'api_key',
  'email_verified',
  'verification_token',
  'verification_token_expiry',
  'reset_token',
  'reset_token_expiry',
  'totp_secret',
  'totp_enabled',
  'totp_last_step',
  'token_version',
  'oauth_provider',
  'oauth_subject',
] as const

// The complete set of query operators the adapters understand. A `where` using
// anything else is a client error (400), not an adapter crash (500).
const WHERE_OPERATORS = new Set([
  'equals',
  'not_equals',
  'in',
  'not_in',
  'greater_than',
  'greater_than_equal',
  'less_than',
  'less_than_equal',
  'like',
  'contains',
  'exists',
])

export function createOperations(ctx: OperationCtx) {
  const { config, db, logger } = ctx

  // Content-credential signer, built once from sanitized signing material. Null when
  // signing is disabled. The key material lives only inside this closure — it is never
  // read back out, logged, or serialized into a manifest/credential/error.
  const signer: Signer | null = createSigner(config.signing)

  // identifier -> { failures, windowStart }. Scoped to this kernel instance.
  const loginFailures = new Map<string, { count: number; windowStart: number }>()

  function loginKey(slug: string, email: string): string {
    return `${slug}:${email.trim().toLowerCase()}`
  }

  function assertLoginAllowed(key: string): void {
    const rec = loginFailures.get(key)
    if (!rec) return
    const elapsed = Date.now() - rec.windowStart
    if (elapsed > LOGIN_WINDOW_MS) {
      loginFailures.delete(key)
      return
    }
    if (rec.count >= LOGIN_MAX_FAILURES) {
      const retryAfter = Math.ceil((LOGIN_WINDOW_MS - elapsed) / 1000)
      throw new TooManyRequestsError('Too many failed login attempts. Please try again later.', retryAfter)
    }
  }

  function recordLoginFailure(key: string): void {
    const now = Date.now()
    const rec = loginFailures.get(key)
    if (!rec || now - rec.windowStart > LOGIN_WINDOW_MS) {
      loginFailures.set(key, { count: 1, windowStart: now })
    } else {
      rec.count += 1
    }
  }

  // A real (but useless) password hash, computed once, used to equalize login
  // timing for non-existent accounts.
  let dummyHashCache: string | null = null
  async function dummyHash(): Promise<string> {
    if (!dummyHashCache) dummyHashCache = await hashPassword('timing-equalizer-not-a-real-password')
    return dummyHashCache
  }

  // action:slug:email -> sliding window, for email-sending throttles.
  const emailActionAttempts = new Map<string, { count: number; windowStart: number }>()
  function throttleEmailAction(action: string, slug: string, email: string): void {
    const key = `${action}:${slug}:${email.trim().toLowerCase()}`
    const now = Date.now()
    const rec = emailActionAttempts.get(key)
    if (!rec || now - rec.windowStart > EMAIL_ACTION_WINDOW_MS) {
      emailActionAttempts.set(key, { count: 1, windowStart: now })
      return
    }
    rec.count += 1
    if (rec.count > EMAIL_ACTION_MAX) {
      const retryAfter = Math.ceil((EMAIL_ACTION_WINDOW_MS - (now - rec.windowStart)) / 1000)
      throw new TooManyRequestsError('Too many requests. Please try again later.', retryAfter)
    }
  }

  /**
   * Field-level write access. Document access has already passed; this strips any
   * field the current user may not set for this operation, in place. Without it,
   * anyone who can update a row can write *every* column — e.g. escalate their own
   * `roles`. Fields with no rule stay writable (doc access is the gate); rules are
   * only consulted when present, so the secure-by-default user check never fires
   * here. Recurses into group/array sub-fields. Skipped entirely when access is
   * overridden (trusted server/system calls).
   */
  async function applyFieldAccess(
    fields: ConfigField[],
    data: Row,
    operation: 'create' | 'update',
    req: RequestContext,
    id?: string,
  ): Promise<void> {
    // Scoped principals (agents) are deny-by-default at the field level: enforce the
    // allow/deny list at the TOP LEVEL of the write before any per-field rule runs,
    // so an unscoped field (e.g. `roles`, `_status` siblings) can never be written
    // even when the collection declares no rule for it. Humans (no fieldScope) are
    // untouched — their existing opt-in rule path below is the only gate. Matching is
    // by top-level field name (a permitted group/array passes its subfields through).
    const scope = req.user?.fieldScope
    if (scope) {
      const allow = scope.allow ? new Set(scope.allow) : null
      const deny = scope.deny ? new Set(scope.deny) : null
      for (const field of effectiveFields(fields)) {
        if (!Object.prototype.hasOwnProperty.call(data, field.name)) continue
        if (allow ? !allow.has(field.name) : deny ? deny.has(field.name) : false) {
          delete data[field.name]
        }
      }
    }
    for (const field of effectiveFields(fields)) {
      if (!Object.prototype.hasOwnProperty.call(data, field.name)) continue
      const rule = field.access?.[operation]
      if (rule) {
        const decision = await evalAccess(rule, { req, id, data })
        if (!isAllowed(decision)) {
          delete data[field.name]
          continue
        }
      }
      const value = data[field.name]
      if (field.type === 'group' && value && typeof value === 'object' && !Array.isArray(value)) {
        await applyFieldAccess(field.fields, value as Row, operation, req, id)
      } else if (field.type === 'array' && Array.isArray(value)) {
        for (const row of value) {
          if (row && typeof row === 'object') {
            await applyFieldAccess(field.fields, row as Row, operation, req, id)
          }
        }
      } else if (field.type === 'blocks' && Array.isArray(value)) {
        // Mirror the read path: enforce write access on fields nested in blocks too,
        // otherwise a guarded field inside a block would always be writable.
        for (const row of value) {
          if (!row || typeof row !== 'object') continue
          const def = field.blocks.find((b) => b.slug === (row as Row).blockType)
          if (def) await applyFieldAccess(def.fields, row as Row, operation, req, id)
        }
      }
    }
  }

  /**
   * Evaluate computed (`virtual`) fields on a read document. Runs after populate
   * (so siblings/relations are resolved) and before read-field-access (so virtual
   * fields can still be access-stripped). "Views as contract" at the field level.
   */
  async function applyComputed(fields: ConfigField[], doc: Row, req: RequestContext): Promise<void> {
    for (const field of effectiveFields(fields)) {
      if (field.virtual && typeof field.compute === 'function') {
        doc[field.name] = await field.compute({ doc: doc as Doc, req })
      }
    }
  }

  /**
   * Stored computed fields: a field with a `compute` function but `virtual !== true`.
   * Unlike a virtual field (derived on every read, never stored, not sortable), the
   * value is derived here at WRITE time and persisted to a real column — so it is
   * sortable and filterable. The computed value always wins over any client-supplied
   * value, so it cannot be forged. Mutates `doc` in place; call after beforeChange
   * hooks (so hooks can influence the inputs) and before validate/serialize.
   */
  async function applyStoredComputed(fields: ConfigField[], doc: Row, req: RequestContext): Promise<void> {
    for (const field of effectiveFields(fields)) {
      if (!field.virtual && typeof field.compute === 'function') {
        doc[field.name] = await field.compute({ doc: doc as Doc, req })
      }
    }
  }

  /**
   * Field-level READ access. After a document is read, strip any field the
   * current user may not see (rule present and not allowed). Recurses into
   * group/array/blocks sub-fields. Skipped when access is overridden. Without
   * this, field `access.read` rules would be silently ignored on output.
   */
  async function applyReadFieldAccess(
    fields: ConfigField[],
    doc: Row,
    req: RequestContext,
    id?: string,
  ): Promise<void> {
    for (const field of effectiveFields(fields)) {
      if (!Object.prototype.hasOwnProperty.call(doc, field.name)) continue
      const rule = field.access?.read
      if (rule) {
        const decision = await evalAccess(rule, { req, id, data: doc })
        if (!isAllowed(decision)) {
          delete doc[field.name]
          continue
        }
      }
      const value = doc[field.name]
      if (field.type === 'group' && value && typeof value === 'object' && !Array.isArray(value)) {
        await applyReadFieldAccess(field.fields, value as Row, req, id)
      } else if (field.type === 'array' && Array.isArray(value)) {
        for (const row of value) {
          if (row && typeof row === 'object') await applyReadFieldAccess(field.fields, row as Row, req, id)
        }
      } else if (field.type === 'blocks' && Array.isArray(value)) {
        for (const row of value) {
          if (!row || typeof row !== 'object') continue
          const def = field.blocks.find((b) => b.slug === (row as Row).blockType)
          if (def) await applyReadFieldAccess(def.fields, row as Row, req, id)
        }
      }
    }
  }

  const loc = config.localization || false
  const strictLoc = loc ? loc.strict : false
  const audiences = config.audiences
  // Field-level encryption cipher (undefined when no field is `encrypted`).
  const fieldCipher = config.encryption ? createFieldCipher(config.encryption.key) : undefined

  // Prototype-pollution guard for an untrusted `audience` segment used as a map key.
  const FORBIDDEN_SEGMENT_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

  /** Resolve an untrusted `req.audience` to a KNOWN segment id. Anything not configured
   *  (absent, unknown, or a prototype-pollution key) collapses to the default segment, so
   *  a hostile `audience` can never inject a map key or read another segment's content. */
  function resolveSegment(partial?: Partial<RequestContext>): string {
    if (!audiences.enabled) return ''
    const raw = partial?.audience
    if (typeof raw === 'string' && !FORBIDDEN_SEGMENT_KEYS.has(raw) && audiences.segments.includes(raw)) {
      return raw
    }
    return audiences.default
  }

  function buildReq(partial?: Partial<RequestContext>): RequestContext {
    const defaultLocale = loc ? loc.defaultLocale : 'en'
    // Under strict localization the DEFAULT request behaviour is no-fallback (so an
    // untranslated field never masquerades as present). A caller may still opt in by
    // passing an explicit `fallbackLocale`; we record that opt-in via the context so the
    // deserialize path can honour it. Non-strict keeps the historical fallback default.
    const callerSetFallback = partial ? Object.prototype.hasOwnProperty.call(partial, 'fallbackLocale') : false
    const configFallback = loc ? (loc.fallback ? loc.defaultLocale : false) : false
    const fallback = callerSetFallback
      ? (partial!.fallbackLocale as string | false)
      : strictLoc
        ? false
        : configFallback
    const context = partial?.context ?? {}
    return {
      user: partial?.user ?? null,
      locale: partial?.locale ?? defaultLocale,
      fallbackLocale: fallback,
      // Untrusted audience resolved to a known segment (unknown → default). Only set when
      // personalization is enabled so non-personalized configs stay byte-identical.
      ...(audiences.enabled ? { audience: resolveSegment(partial) } : {}),
      context: callerSetFallback && strictLoc ? { ...context, __strictFallbackOptIn: true } : context,
    }
  }

  /** The single locale a write targets. `'all'` is a READ sentinel only — a write must
   *  name one concrete locale (use `updateLocales` to write many at once). */
  function writeLocale(req: RequestContext): string {
    if (loc !== false && req.locale === 'all') {
      throw new BadRequestError('locale "all" is read-only; write one locale at a time (or use updateLocales).')
    }
    return req.locale
  }

  /** Strict per-locale required check: every required localized field must have a value
   *  for each `locales` written. No-op unless strict localization is on. */
  function assertLocaleRequired(collection: CollectionConfig, row: Row, locales: string[]): void {
    if (!strictLoc) return
    const errors = validateLocaleRequired(collection.fields, row, locales)
    if (errors.length) throw new ValidationError(errors)
  }

  /** Strict publish gate: reject a publish when the DEFAULT locale is missing any required
   *  localized field, listing the offending `locale.field` pairs. No-op unless strict. */
  function assertDefaultLocaleComplete(collection: CollectionConfig, row: Row): void {
    if (!strictLoc || loc === false) return
    const errors = validateLocaleRequired(collection.fields, row, [loc.defaultLocale])
    if (errors.length) {
      const pairs = errors.map((e) => e.path).join(', ')
      throw new ValidationError([
        {
          path: '_status',
          message: `Cannot publish: the default locale "${loc.defaultLocale}" is missing required field(s): ${pairs}.`,
        },
        ...errors,
      ])
    }
  }

  /** Build the deserialize options for a request: strict no-fallback, the per-request
   *  fallback opt-in, and `locale:'all'` whole-map reads. */
  function deserializeOptsFor(req: RequestContext) {
    return {
      locale: req.locale,
      fallbackLocale: req.fallbackLocale,
      strict: strictLoc,
      strictFallbackOptIn: req.context?.__strictFallbackOptIn === true,
      allLocales: loc !== false && req.locale === 'all',
      // Personalization: resolve personalized fields to the request's audience segment,
      // falling back to the configured default segment. Both are already-validated ids.
      ...(audiences.enabled ? { segment: req.audience ?? audiences.default, defaultSegment: audiences.default } : {}),
      // Decrypt `encrypted` fields after read (no-op when encryption is unconfigured).
      ...(fieldCipher ? { cipher: fieldCipher } : {}),
    }
  }

  /** The audience segment a write targets — the resolved request segment, or the default
   *  when personalization is off / unset. Mirrors `writeLocale` for personalized fields. */
  function writeSegment(req: RequestContext): string {
    return audiences.enabled ? (req.audience ?? audiences.default) : ''
  }

  function collectionOrThrow(slug: string): CollectionConfig {
    const collection = config.collectionsBySlug[slug]
    if (!collection) throw new BadRequestError(`Unknown collection "${slug}".`)
    return collection
  }

  function globalOrThrow(slug: string): GlobalConfig {
    const global = config.globalsBySlug[slug]
    if (!global) throw new BadRequestError(`Unknown global "${slug}".`)
    return global
  }

  /** Whether a collection is tenant-scoped under the active tenancy config. */
  function isTenantScoped(collection: CollectionConfig): boolean {
    return config.tenancy.enabled && config.tenancy.collections.includes(collection.slug)
  }

  /**
   * Auto-stamp the tenant field on a NON-override create into a scoped collection. The
   * tenant is resolved from the trusted PRINCIPAL (never the client body): any client-
   * supplied tenant value in `data` is OVERWRITTEN with the principal's tenant, so a tenant
   * A caller can never create a doc under tenant B. A tenant-less principal under
   * `requireTenant` is rejected (it has no tenant to own the row). Mutates `data` in place.
   * No-op under `overrideAccess` (trusted server seeds the tenant directly) and for
   * non-scoped collections. The injected create access scope already denies a cross-tenant
   * create; this guarantees the STORED value is the acting tenant regardless.
   */
  function stampTenantOnCreate(collection: CollectionConfig, data: Row, req: RequestContext): void {
    if (!isTenantScoped(collection)) return
    const tenant = resolveTenant(config.tenancy, req)
    if (tenant === null) {
      if (config.tenancy.requireTenant) {
        throw new ForbiddenError('A tenant is required to create this document.')
      }
      return
    }
    data[config.tenancy.field] = tenant
  }

  /**
   * Anti-spoof on update: the tenant field is server-managed, so a NON-override client can
   * never change which tenant owns a document (no "move a doc across tenants"). Strip the
   * field from the incoming write so the stored value is preserved as-is. The injected
   * update access scope already prevents touching another tenant's row at all; this stops a
   * same-tenant caller from re-stamping their own row to a different tenant. No-op under
   * `overrideAccess` and for non-scoped collections.
   */
  function stripTenantOnUpdate(collection: CollectionConfig, data: Row): void {
    if (!isTenantScoped(collection)) return
    delete data[config.tenancy.field]
  }

  function rowToDoc(collection: CollectionConfig, row: Row, req: RequestContext): Doc {
    const body = deserializeDoc(collection.fields, row, deserializeOptsFor(req))
    const doc: Doc = { id: String(row.id), ...body }
    if (row.createdAt !== undefined) doc.createdAt = row.createdAt
    if (row.updatedAt !== undefined) doc.updatedAt = row.updatedAt
    if (row._status !== undefined) doc._status = row._status
    // Surface the content-lifecycle archive marker so an archived doc is distinguishable
    // from a plain draft on read (both are `_status:'draft'`; an archived one carries a
    // non-null `_archived_at`). Server-managed — it is only ever WRITTEN by the drain.
    if (row._archived_at !== undefined) doc._archived_at = row._archived_at
    if (collection.auth) {
      delete doc.hash
      delete doc.api_key
      // Never expose verification/reset secrets (the public-safe `email_verified` stays).
      delete doc.verification_token
      delete doc.verification_token_expiry
      delete doc.reset_token
      delete doc.reset_token_expiry
      // The TOTP secret must never leave the server (the `totp_enabled` flag is fine).
      delete doc.totp_secret
      // Internal replay watermark — not meaningful or safe to expose.
      delete doc.totp_last_step
      // Internal session epoch — server-only.
      delete doc.token_version
    }
    return doc
  }

  function authTtl(collection: CollectionConfig): number {
    const auth = collection.auth
    return typeof auth === 'object' && auth.tokenExpiration ? auth.tokenExpiration : 3600
  }

  /** Hash an incoming password into `hash`, strip raw credentials, never trust client `hash`. */
  async function prepareAuthInput(
    collection: CollectionConfig,
    data: Row,
    operation: 'create' | 'update',
    override = false,
  ): Promise<Row> {
    if (!collection.auth) return data
    const next: Row = { ...data }
    delete next.hash
    // Server-managed auth columns must never be set from untrusted client input —
    // otherwise a caller with write access to their own row could self-verify
    // (`email_verified`), grant a key, disable 2FA, or desync the session epoch.
    // Trusted internal calls (overrideAccess) still set these directly.
    if (!override) for (const f of SYSTEM_AUTH_FIELDS) delete next[f]
    const password = next.password
    delete next.password
    if (typeof password === 'string' && password.length > 0) {
      if (password.length < 8) {
        throw new ValidationError([{ path: 'password', message: 'Password must be at least 8 characters.' }])
      }
      next.hash = await hashPassword(password)
    } else if (operation === 'create') {
      throw new ValidationError([{ path: 'password', message: 'Password is required.' }])
    }
    return next
  }

  async function runHooks(
    hooks: ReadonlyArray<(args: never) => Row | Promise<Row>> | undefined,
    args: Record<string, unknown>,
    key: 'data' | 'doc',
  ): Promise<Row> {
    let current = args[key] as Row
    if (!hooks) return current
    for (const hook of hooks) {
      current = await (hook as (a: Record<string, unknown>) => Row | Promise<Row>)({ ...args, [key]: current })
    }
    return current
  }

  /**
   * Finish a raw storage row into a public read document: the per-doc pipeline
   * shared by `findByID` and the batched relationship loader. Returns null when the
   * row is filtered (draft hidden, read denied, or row-scope mismatch) — exactly the
   * cases `findByID` turns into null/Forbidden. Populate of THIS doc's own relations
   * is the caller's responsibility (so it can be batched across a level), hence the
   * `depth`-aware recursion is driven externally; here we only run the leaf pipeline
   * (afterRead hook + field-access + computed). Access parity with the old per-id
   * `findByID` populate path is preserved bit-for-bit: same draft check, same
   * `evalAccess(read,{req,id})`, same scope `matchesWhere`. Only the DB row fetch is
   * hoisted out and batched.
   */
  async function finishReadDoc(
    collection: CollectionConfig,
    row: Row,
    req: RequestContext,
    override: boolean,
    draft: boolean,
  ): Promise<Doc | null> {
    // Published-only view unless drafts are explicitly requested.
    if (draftsOn(collection) && !draft && row._status !== 'published') return null
    if (!override) {
      const access = await evalAccess(collection.access?.read, { req, id: String(row.id) })
      if (!isAllowed(access)) return null
      const scope = asWhere(access)
      if (scope && !matchesWhere(row, scope)) return null
    }
    let doc = rowToDoc(collection, row, req)
    doc = (await runHooks(collection.hooks?.afterRead, { req, operation: 'read', doc }, 'doc')) as Doc
    return doc
  }

  /** Strip read-restricted fields + run computed fields on a finished doc (the tail of
   *  the read pipeline). Mirrors the strip→compute→strip order used everywhere else. */
  async function applyReadTail(
    collection: CollectionConfig,
    doc: Doc,
    req: RequestContext,
    override: boolean,
  ): Promise<void> {
    if (!override) await applyReadFieldAccess(collection.fields, doc, req)
    await applyComputed(collection.fields, doc, req)
    if (!override) await applyReadFieldAccess(collection.fields, doc, req)
  }

  /**
   * Batched relationship population. Resolves every relationship/upload + reverse-join
   * field across ALL `docs` at this level, recursing per depth level — but issuing ONE
   * access-checked read per (related collection) per level instead of one per id per doc.
   *
   * This is the N+1 fix: a 20-row page with a hasMany relation used to fan out into
   * 20×N `findByID` calls; now it's O(collections × depth) batched `db.find`s. Output
   * shape, order, polymorphic `{relationTo,value}`, dangling-id fallback (`related ?? id`),
   * and per-doc ACCESS decisions are identical to the old per-id path — each fetched row
   * still goes through `finishReadDoc` (same draft/access/scope checks with the row's id).
   */
  async function populateMany(
    collection: CollectionConfig,
    docs: Doc[],
    depth: number,
    req: RequestContext,
  ): Promise<void> {
    // Single chokepoint clamp: bound runaway depth before any recursion. Every
    // populate caller funnels through here (populate() wraps it; the join path
    // re-enters via find()), so this one line caps the whole read populate tree.
    // Re-clamping on the depth-1 recursion is a no-op (value already ≤ cap).
    depth = Math.min(Math.max(depth ?? 0, 0), MAX_POPULATE_DEPTH)
    if (depth <= 0 || docs.length === 0) return

    const rels = relationshipFields(collection.fields)
    const joins = joinFields(collection.fields)
    if (rels.length === 0 && joins.length === 0) return

    // 1) Collect the set of ids needed per related collection across every doc + field.
    const idsByCollection = new Map<string, Set<string>>()
    const need = (slug: string, id: unknown): void => {
      if (id == null || !config.collectionsBySlug[slug]) return
      let set = idsByCollection.get(slug)
      if (!set) idsByCollection.set(slug, (set = new Set()))
      set.add(String(id))
    }
    for (const doc of docs) {
      for (const rel of rels) {
        const value = doc[rel.name]
        if (rel.polymorphic) {
          const refs = rel.hasMany ? (Array.isArray(value) ? value : []) : value != null ? [value] : []
          for (const ref of refs) {
            if (ref && typeof ref === 'object') {
              const { relationTo, value: id } = ref as { relationTo?: string; value?: unknown }
              if (relationTo) need(relationTo, id)
            }
          }
        } else {
          const relTo = rel.relationTo as string
          const ids = rel.hasMany ? (Array.isArray(value) ? value : []) : value != null ? [value] : []
          for (const id of ids) need(relTo, id)
        }
      }
    }

    // 2) One batched, access-checked read per related collection; build id→doc maps.
    //    Recurse INTO the related docs (depth-1) as another batched level — so depth>1
    //    is still O(collections×depth), not exponential. Dangling/denied ids are simply
    //    absent from the map, yielding the `related ?? id` fallback at stitch time.
    const resolved = new Map<string, Map<string, Doc>>()
    for (const [slug, idSet] of idsByCollection) {
      const related = collectionOrThrow(slug)
      const ids = [...idSet]
      const rows = await fetchRowsByIds(related, ids)
      const byId = new Map<string, Doc>()
      const finished: Doc[] = []
      for (const r of rows) {
        const finishedDoc = await finishReadDoc(related, r, req, false, false)
        if (finishedDoc) {
          byId.set(String(r.id), finishedDoc)
          finished.push(finishedDoc)
        }
      }
      // Recurse one level deeper across all related docs of this collection at once.
      await populateMany(related, finished, depth - 1, req)
      for (const d of finished) await applyReadTail(related, d, req, false)
      resolved.set(slug, byId)
    }

    // 3) Stitch resolved docs back into each parent, preserving shape + order.
    for (const doc of docs) {
      for (const rel of rels) {
        const value = doc[rel.name]
        if (rel.polymorphic) {
          const resolveRef = (ref: unknown): unknown => {
            if (!ref || typeof ref !== 'object') return ref
            const { relationTo, value: id } = ref as { relationTo?: string; value?: unknown }
            if (!relationTo || id == null || !config.collectionsBySlug[relationTo]) return ref
            const related = resolved.get(relationTo)?.get(String(id))
            return { relationTo, value: related ?? id }
          }
          if (rel.hasMany && Array.isArray(value)) doc[rel.name] = value.map(resolveRef)
          else if (!rel.hasMany && value != null) doc[rel.name] = resolveRef(value)
        } else {
          const relTo = rel.relationTo as string
          if (!config.collectionsBySlug[relTo]) continue
          const byId = resolved.get(relTo)
          if (rel.hasMany && Array.isArray(value)) {
            doc[rel.name] = value.map((id) => byId?.get(String(id)) ?? id)
          } else if (!rel.hasMany && value != null) {
            doc[rel.name] = byId?.get(String(value)) ?? value
          }
        }
      }
    }

    // Reverse relationships (joins) remain per-parent: each is a distinct `on = doc.id`
    // query and they're rare relative to forward relations. Routed through `find` so the
    // join target's own read access + scope still apply (a caller can't read back-refs
    // they couldn't read directly).
    for (const doc of docs) {
      for (const join of joins) {
        if (!config.collectionsBySlug[join.collection]) {
          doc[join.name] = []
          continue
        }
        try {
          const related = await find({
            collection: join.collection,
            where: { [join.on]: { equals: doc.id } },
            limit: join.limit,
            depth: depth - 1,
            req,
          })
          doc[join.name] = related.docs
        } catch (err) {
          if (isKernelError(err)) doc[join.name] = []
          else throw err
        }
      }
    }
  }

  /** Single-doc populate — thin wrapper over the batched path. */
  async function populate(collection: CollectionConfig, doc: Doc, depth: number, req: RequestContext): Promise<Doc> {
    await populateMany(collection, [doc], depth, req)
    return doc
  }

  /** Fetch many rows by id in as few queries as possible (chunked to the adapter cap).
   *  The adapter applies `id IN (...)`; access is enforced afterwards per row by
   *  `finishReadDoc`, so this raw fetch never widens what a caller can see. */
  async function fetchRowsByIds(collection: CollectionConfig, ids: string[]): Promise<Row[]> {
    if (ids.length === 0) return []
    const out: Row[] = []
    for (let i = 0; i < ids.length; i += MAX_LIMIT) {
      const chunk = ids.slice(i, i + MAX_LIMIT)
      const res = await db.find({
        collection: collection.slug,
        where: { id: { in: chunk } },
        limit: MAX_LIMIT,
        page: 1,
      })
      out.push(...res.docs)
    }
    return out
  }

  // -------------------------------------------------------------------------
  // Collection operations
  // -------------------------------------------------------------------------

  function versionsOf(collection: CollectionConfig) {
    return resolveVersions(collection.versions)
  }

  function draftsOn(collection: CollectionConfig): boolean {
    return resolveVersions(collection.versions).drafts
  }

  /** The columns a caller may filter on — mirrors the adapter's allow-list exactly
   *  (system columns + storage fields + draft columns). */
  function filterableFields(collection: CollectionConfig): Set<string> {
    const set = new Set<string>(['id', 'createdAt', 'updatedAt'])
    // An encrypted field stores opaque, non-deterministic ciphertext — it can't be filtered
    // or sorted on (that would only ever match the ciphertext, never the plaintext).
    for (const f of storageFields(collection.fields)) if (!f.encrypted) set.add(f.name)
    if (draftsOn(collection)) {
      set.add('_status')
      set.add('_scheduled_at')
    }
    return set
  }

  /**
   * Reject a `where` that references a field the collection does not have, or uses
   * an operator the adapters do not implement, with a 400 rather than letting the
   * adapter raise a generic 500. Walks `and`/`or` groups recursively. Validates the
   * caller-supplied filter only, so legitimate access-rule internals are never
   * second-guessed.
   */
  function assertWhereFields(collection: CollectionConfig, where: Where | undefined): void {
    if (!where) return
    const allowed = filterableFields(collection)
    const walk = (node: Where, depth: number): void => {
      // Bound recursion so a pathologically deep `and`/`or` body can't exhaust the stack.
      if (depth > MAX_WHERE_DEPTH) {
        throw new BadRequestError('Filter is nested too deeply.')
      }
      for (const [key, value] of Object.entries(node)) {
        if (key === 'and' || key === 'or') {
          if (Array.isArray(value)) for (const sub of value) walk(sub as Where, depth + 1)
          continue
        }
        if (value === undefined) continue
        if (!allowed.has(key)) {
          throw new BadRequestError(`Cannot filter on unknown field "${key}" of "${collection.slug}".`)
        }
        // The condition is `{ <operator>: value }`; reject unknown operators.
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          for (const op of Object.keys(value)) {
            if (!WHERE_OPERATORS.has(op)) {
              throw new BadRequestError(`Unsupported filter operator "${op}" on "${key}".`)
            }
          }
        }
      }
    }
    walk(where, 0)
  }

  function statusFromData(data: Row | undefined, fallback: string): 'draft' | 'published' {
    const s = data?._status as string | undefined
    if (s === 'published') return 'published'
    if (s === 'draft') return 'draft'
    return fallback === 'published' ? 'published' : 'draft'
  }

  /**
   * Gate the draft → published transition. `_status` is a system column that
   * bypasses field-level access, so without this anyone with `update` could publish
   * a draft via a raw `{ _status: 'published' }`. Call at the single write chokepoint
   * (create/update) only when the resulting status BECOMES published and wasn't
   * already. Falls back to the collection's `update` rule when no explicit `publish`
   * rule is set, so existing configs keep working — only an explicit `publish` rule
   * narrows it. Skipped under `overrideAccess` (system/scheduled publishes).
   */
  async function assertCanPublish(
    collection: CollectionConfig,
    req: RequestContext,
    id: string | undefined,
    data: Row | undefined,
    row?: Row,
  ): Promise<void> {
    // Hard draft-only brake: an agent principal can never publish, regardless of any
    // `access.publish`/`access.update` rule or role. Agents create/edit drafts and may
    // unpublish, but `_status:'published'` is forbidden — a guarantee that does not
    // depend on config. (`_status` is a system column outside field scope, so this
    // brake — not fieldScope — is what stops agents publishing.)
    if (req.user?.principalType === 'agent') throw new ForbiddenError()
    const rule = collection.access?.publish ?? collection.access?.update
    const decision = await evalAccess(rule, { req, id, data })
    if (!isAllowed(decision)) throw new ForbiddenError()
    // A row-scoped publish rule (returning a `Where`) restricts WHICH rows the caller may
    // publish — match it against the target row, exactly as update access does. Without
    // this, a `publish: () => ({ owner: { equals: req.user.id } })` rule would act as a
    // blanket allow. Only enforced when the row is available to the caller.
    const scope = asWhere(decision)
    if (scope && row && !matchesWhere(row, scope)) throw new ForbiddenError()
  }

  /** Append a snapshot of `doc` to the collection's version table, trimming to maxPerDoc.
   *  On a publish transition, `approver` records who approved/published it (the publishing
   *  principal — which, for a review-approval, is the reviewer threaded through). */
  /** Top-level storage fields of a collection marked `encrypted`. */
  function encryptedFieldNames(collection: CollectionConfig): string[] {
    if (!fieldCipher) return []
    return storageFields(collection.fields)
      .filter((f) => f.encrypted)
      .map((f) => f.name)
  }

  /** A version-snapshot copy of a (decrypted) doc with its encrypted fields RE-ENCRYPTED, so
   *  the `_versions` table stores ciphertext at rest just like the live row — never plaintext. */
  function encodeVersionContent(collection: CollectionConfig, doc: Doc): Doc {
    const names = encryptedFieldNames(collection)
    if (!fieldCipher || names.length === 0) return doc
    const out: Doc = { ...doc }
    for (const name of names) {
      if (name in out) out[name] = fieldCipher.encrypt(out[name])
    }
    return out
  }

  /** Decrypt the encrypted fields of a stored version snapshot back to plaintext on read.
   *  Non-ciphertext values (legacy snapshots written before encryption) pass through. */
  function decodeVersionContent(collection: CollectionConfig, version: unknown): Row {
    const content = (version ?? {}) as Row
    const names = encryptedFieldNames(collection)
    if (!fieldCipher || names.length === 0) return content
    const out: Row = { ...content }
    for (const name of names) {
      if (name in out) out[name] = fieldCipher.decrypt(out[name])
    }
    return out
  }

  async function snapshotVersion(
    collection: CollectionConfig,
    doc: Doc,
    status: 'draft' | 'published',
    req: RequestContext,
    autosave = false,
    approver?: { id: string | null; type: string } | null,
  ): Promise<string | null> {
    const v = versionsOf(collection)
    if (!v.enabled) return null
    const table = tableForVersions(collection.slug)
    const versionId = randomUUID()
    await db.create({
      collection: table,
      data: {
        id: versionId,
        parent: String(doc.id),
        version: encodeVersionContent(collection, doc),
        status,
        autosave,
        createdBy: req.user?.id ?? null,
        // Attribute the snapshot to the principal kind so "review agent changes" is
        // queryable; humans (and system/override writes) record 'user'.
        createdByType: req.user?.principalType ?? 'user',
        // Provenance: who approved this publish (null for a non-publish snapshot).
        approvedBy: approver ? approver.id : null,
        approvedByType: approver ? approver.type : null,
      },
    })
    if (v.maxPerDoc > 0) {
      const total = await db.count({ collection: table, where: { parent: { equals: doc.id } } })
      if (total > v.maxPerDoc) {
        const oldest = await db.find({
          collection: table,
          where: { parent: { equals: doc.id } },
          sort: [{ field: 'createdAt', direction: 'asc' }],
          limit: total - v.maxPerDoc,
          page: 1,
        })
        for (const row of oldest.docs) await db.delete({ collection: table, id: String(row.id) })
      }
    }
    return versionId
  }

  // -------------------------------------------------------------------------
  // Pre-publish evals ("content CI") + content credentials (signing)
  // -------------------------------------------------------------------------

  /**
   * Run the configured pre-publish evals against the to-be-published document. A
   * BLOCKING rule that returns an `ok:false` `error` finding REJECTS the publish with a
   * ValidationError carrying every blocking finding. Non-blocking / warn / info findings
   * are returned (so the caller can record them in the audit meta) but never block.
   * No-op (returns no findings) when no evals are configured.
   */
  async function runPrePublishEvals(
    collection: CollectionConfig,
    doc: Row,
    req: RequestContext,
  ): Promise<{ findings: import('./types').EvalFinding[] }> {
    if (config.evals.length === 0) return { findings: [] }
    // Pass the collection's schema fields so schema-aware built-ins (a11y/policy/brand)
    // can locate richText/upload fields on the to-be-published doc.
    const { results, blocking } = await runEvals(config.evals, {
      doc,
      collection: collection.slug,
      req,
      fields: collection.fields,
    })
    if (blocking.length > 0) {
      throw new ValidationError(
        blocking.map((b) => ({ path: b.field ?? '_status', message: `[${b.rule}] ${b.message}` })),
      )
    }
    // Strip the internal rule/blocking bookkeeping from what we hand back as findings.
    return { findings: results.map(({ ok, severity, message, field }) => ({ ok, severity, message, field })) }
  }

  /**
   * Sign a content credential for a freshly-published document and store it in the
   * `_credentials` table. No-op when signing is disabled. The manifest embeds the
   * content hash (so tampering is detectable) + who/what/when; the signature covers the
   * canonical manifest. Best-effort: a credential-write failure is warned, never thrown,
   * so it can't roll back the publish it records. NO key material is ever written.
   */
  async function signContentCredential(
    collection: CollectionConfig,
    row: Row,
    req: RequestContext,
    approver: PrincipalRef | null,
    versionId: string | null,
  ): Promise<void> {
    if (!signer) return
    try {
      const manifest: ContentManifest = {
        collection: collection.slug,
        documentId: String(row.id),
        // Hash the RAW stored row (locale-independent, deterministic) so verify can
        // recompute the identical surface from the persisted row regardless of locale.
        contentHash: hashContent(row as Record<string, unknown>),
        author: { id: req.user?.id ?? null, type: req.user?.principalType ?? 'user' },
        approver,
        publishedAt: new Date().toISOString(),
        versionId,
      }
      const signature = signManifest(signer, manifest)
      await db.create({
        collection: CREDENTIALS_TABLE,
        data: {
          id: randomUUID(),
          collection: collection.slug,
          documentId: String(row.id),
          versionId,
          manifest,
          signature,
          algorithm: signer.algorithm,
          signedAt: manifest.publishedAt,
        },
      })
    } catch (err) {
      logger?.warn('Failed to write content credential', err)
    }
  }

  /** The latest credential row for a (collection, documentId), or null. */
  async function latestCredentialRow(collection: string, documentId: string): Promise<CredentialDoc | null> {
    const res = await db.find({
      collection: CREDENTIALS_TABLE,
      where: { and: [{ collection: { equals: collection } }, { documentId: { equals: documentId } }] },
      sort: [{ field: 'signedAt', direction: 'desc' }],
      limit: 1,
      page: 1,
    })
    return (res.docs[0] as CredentialDoc | undefined) ?? null
  }

  // -------------------------------------------------------------------------
  // Append-only audit log
  // -------------------------------------------------------------------------

  /**
   * Resolve the principal kind for an audit row. A request carries the kind
   * directly for users/agents; a trusted (overrideAccess) call with no user is a
   * system principal. Mirrors the version-table attribution but adds 'system'.
   */
  function principalKindFor(req: RequestContext, overrideAccess: boolean): AuditDoc['principalType'] {
    return req.user?.principalType ?? (overrideAccess ? 'system' : 'user')
  }

  /** Coerce a stored principal-type column into the closed union (defaults to 'user'). */
  function normalizePrincipalType(value: unknown): PrincipalRef['type'] {
    return value === 'agent' || value === 'system' ? value : 'user'
  }

  /** The principal acting on `req`, as a provenance ref. A request with a user resolves
   *  to its id + kind (defaulting to 'user'); a user-less (system/override) call is the
   *  'system' principal. */
  function principalRefOf(req: RequestContext): PrincipalRef {
    if (req.user) return { id: req.user.id ?? null, type: req.user.principalType ?? 'user' }
    return { id: null, type: 'system' }
  }

  /**
   * Append one row to the `_audit` table. No-op unless auditing is enabled. The
   * write is wrapped so an audit failure can NEVER break or roll back the operation
   * it records — any error is swallowed with a warning. Append-only by contract:
   * nothing in the engine updates or deletes audit rows.
   */
  async function recordAudit(args: RecordAuditArgs): Promise<void> {
    if (!config.audit.enabled) return
    try {
      const principalId = args.principalId !== undefined ? args.principalId : (args.req?.user?.id ?? null)
      const principalType =
        args.principalType ?? (args.req ? principalKindFor(args.req, args.overrideAccess ?? false) : 'system')
      await db.create({
        collection: AUDIT_TABLE,
        data: {
          id: randomUUID(),
          at: new Date().toISOString(),
          action: args.action,
          collection: args.collection ?? null,
          documentId: args.documentId ?? null,
          principalId,
          principalType,
          fields: args.fields ?? null,
          meta: args.meta ?? null,
        },
      })
    } catch (err) {
      // An audit write is best-effort observability — it must never propagate.
      logger?.warn('Failed to write audit log entry', err)
    }
  }

  // System keys excluded from the recorded `fields` list — they are server-owned,
  // not user-meaningful change attribution.
  const AUDIT_FIELD_SKIP = new Set(['id', '_status', '_scheduled_at', '_archived_at', 'createdAt', 'updatedAt'])

  /** The user-meaningful field names written in a create/update, for the audit row. */
  function auditedFields(data: Row): string[] {
    return Object.keys(data).filter((k) => !AUDIT_FIELD_SKIP.has(k))
  }

  async function findAuditLog(opts: FindAuditLogOptions = {}): Promise<{ docs: AuditDoc[]; count: number }> {
    if (!config.audit.enabled) return { docs: [], count: 0 }
    const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
    const page = Math.max(opts.page ?? 1, 1)
    let sort: SortSpec[] = parseSort(opts.sort)
    if (sort.length === 0) sort = [{ field: 'at', direction: 'desc' }]
    const result = await db.find({ collection: AUDIT_TABLE, where: opts.where, sort, limit, page })
    return { docs: result.docs as AuditDoc[], count: result.totalDocs }
  }

  // -------------------------------------------------------------------------
  // Agent review inbox
  //
  // The human approval layer over agent-authored content. The queue is DERIVED, not
  // a new `_status` value: an item is PENDING when the document's CURRENT row was
  // agent-authored (`createdByType==='agent'`), is still a `draft` (drafts-enabled
  // collections only), AND has not been approved — i.e. there is no review row, OR the
  // latest review requested changes and the agent has since revised the doc
  // (`updatedAt` is strictly after that review's `at`). Decisions live in `_reviews`.
  // -------------------------------------------------------------------------

  /** The single blocks field on a collection, or the named one. Errors when the field
   *  is missing, not a blocks field, or (no name given) the collection has 0 or >1. */
  function resolveBlocksField(collection: CollectionConfig, name: string | undefined): BlocksField {
    const blockFields = storageFields(collection.fields).filter((f): f is BlocksField => f.type === 'blocks')
    if (name) {
      const field = blockFields.find((f) => f.name === name)
      if (!field) throw new BadRequestError(`Collection "${collection.slug}" has no blocks field "${name}".`)
      return field
    }
    if (blockFields.length === 0) throw new BadRequestError(`Collection "${collection.slug}" has no blocks field.`)
    if (blockFields.length > 1) {
      throw new BadRequestError(
        `Collection "${collection.slug}" has multiple blocks fields; specify which one with \`field\`.`,
      )
    }
    return blockFields[0]!
  }

  /** The latest review row for a (collection, documentId), or null. */
  async function latestReview(collection: string, documentId: string): Promise<ReviewDoc | null> {
    const res = await db.find({
      collection: REVIEWS_TABLE,
      where: { and: [{ collection: { equals: collection } }, { documentId: { equals: documentId } }] },
      sort: [{ field: 'at', direction: 'desc' }],
      limit: 1,
      page: 1,
    })
    return (res.docs[0] as ReviewDoc | undefined) ?? null
  }

  /**
   * Whether a document was AGENT-AUTHORED. Attribution lives on the version snapshots
   * (`createdByType`), not the main collection row — see `snapshotVersion`. A document
   * is agent-authored when its CREATE snapshot (the earliest version) was made by an
   * agent. Returns false when versions are unavailable (history-only off, or no rows),
   * so a collection without snapshot attribution simply yields no agent queue items.
   */
  async function authoredByAgent(collection: CollectionConfig, documentId: string): Promise<boolean> {
    if (!versionsOf(collection).enabled) return false
    const res = await db.find({
      collection: tableForVersions(collection.slug),
      where: { parent: { equals: documentId } },
      sort: [{ field: 'createdAt', direction: 'asc' }],
      limit: 1,
      page: 1,
    })
    return res.docs[0]?.createdByType === 'agent'
  }

  /**
   * Whether an agent-authored draft is still PENDING review. An item leaves the queue
   * only when its latest decision is `approved`. With no review it is pending; with a
   * `changes_requested` it stays pending — the reviewer keeps seeing it (with the note)
   * and it remains actionable after the agent revises. `revisedSince` distinguishes
   * "revised after the last changes-request" (freshly actionable) from "awaiting the
   * agent" — surfaced on the item, not used to remove it from the queue.
   */
  function isPending(review: ReviewDoc | null): boolean {
    return !review || review.decision !== 'approved'
  }

  /** True when the draft's last write is strictly after the given review — i.e. the
   *  agent has revised it since the reviewer's last decision. */
  function revisedSince(updatedAt: string | null, review: ReviewDoc | null): boolean {
    if (!review || updatedAt == null) return false
    const updated = new Date(updatedAt).getTime()
    const reviewedAt = review.at != null ? new Date(String(review.at)).getTime() : NaN
    return Number.isFinite(updated) && Number.isFinite(reviewedAt) && updated > reviewedAt
  }

  async function findReviewQueue(
    opts: FindReviewQueueOptions = {},
  ): Promise<{ docs: ReviewQueueItem[]; count: number }> {
    if (!config.review.enabled) return { docs: [], count: 0 }

    // Only collections that have drafts can hold a "draft pending review".
    const targets = opts.collection ? [collectionOrThrow(opts.collection)] : config.collections
    const draftCollections = targets.filter((c) => draftsOn(c))

    // Gather every agent-authored draft, scoped by the REVIEWER's read access. Each draft
    // is loaded through the access-checked `find` path (overrideAccess:false) — a reviewer
    // can only ever see drafts they could read directly, so the queue never widens access.
    // Agent-authorship is derived from the create version snapshot (`authoredByAgent`),
    // since the main row carries no `createdByType` column.
    const items: ReviewQueueItem[] = []
    for (const collection of draftCollections) {
      let found
      try {
        found = await find({
          collection: collection.slug,
          where: { _status: { equals: 'draft' } },
          draft: true,
          sort: '-updatedAt',
          limit: MAX_LIMIT,
          page: 1,
          req: opts.req,
        })
      } catch (err) {
        // When scanning the whole inbox, a single collection the reviewer can't
        // read must not 403 the entire queue — skip it. An explicitly requested
        // collection still surfaces the access error to the caller.
        if (!opts.collection && err instanceof ForbiddenError) continue
        throw err
      }
      for (const doc of found.docs) {
        if (!(await authoredByAgent(collection, doc.id))) continue
        const updatedAt = doc.updatedAt != null ? String(doc.updatedAt) : null
        const review = await latestReview(collection.slug, doc.id)
        if (!isPending(review)) continue
        items.push({
          collection: collection.slug,
          id: doc.id,
          doc,
          createdBy: await creatorOf(collection, doc.id),
          updatedAt,
          ...(review && review.decision === 'changes_requested'
            ? { revisedSince: revisedSince(updatedAt, review) }
            : {}),
          ...(review
            ? {
                lastReview: {
                  decision: review.decision,
                  note: review.note ?? null,
                  at: review.at,
                  reviewerId: review.reviewerId ?? null,
                },
              }
            : {}),
        })
      }
    }

    // Newest revision first across the whole queue, then paginate in-memory (the queue
    // is bounded per-collection by MAX_LIMIT and is an operator-facing inbox, not a hot
    // read path). count is the full pending set; docs is the requested page.
    items.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
    const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
    const page = Math.max(opts.page ?? 1, 1)
    const start = (page - 1) * limit
    return { docs: items.slice(start, start + limit), count: items.length }
  }

  /** The principal id that created `documentId`, read from its earliest version snapshot
   *  (`createdBy`). Null when no snapshot exists. */
  async function creatorOf(collection: CollectionConfig, documentId: string): Promise<string | null> {
    if (!versionsOf(collection).enabled) return null
    const res = await db.find({
      collection: tableForVersions(collection.slug),
      where: { parent: { equals: documentId } },
      sort: [{ field: 'createdAt', direction: 'asc' }],
      limit: 1,
      page: 1,
    })
    const v = res.docs[0]
    return v?.createdBy != null ? String(v.createdBy) : null
  }

  async function submitReview(opts: SubmitReviewOptions): Promise<SubmitReviewResult> {
    if (!config.review.enabled) throw new BadRequestError('The review inbox is not enabled (set `config.review`).')
    if (opts.decision !== 'approve' && opts.decision !== 'request_changes') {
      throw new BadRequestError('`decision` must be "approve" or "request_changes".')
    }
    if (opts.note != null && String(opts.note).length > MAX_REVIEW_NOTE) {
      throw new BadRequestError(`\`note\` too long (max ${MAX_REVIEW_NOTE} characters).`)
    }
    const collection = collectionOrThrow(opts.collection)
    if (!draftsOn(collection)) {
      throw new BadRequestError(`Collection "${opts.collection}" does not have drafts enabled.`)
    }
    const req = buildReq(opts.req)

    // The target must exist and be an agent-authored draft. This path is exclusively for
    // reviewing AGENT content; reviewing a human draft through it is rejected so the
    // approval inbox can't be repurposed to publish arbitrary documents. Agent-authorship
    // is derived from the create snapshot (the main row carries no `createdByType`).
    const existing = await db.findByID({ collection: collection.slug, id: opts.id })
    if (!existing) throw new NotFoundError()
    if (existing._status !== 'draft') {
      throw new BadRequestError('Only draft documents can be reviewed.')
    }
    if (!(await authoredByAgent(collection, opts.id))) {
      throw new BadRequestError('Only agent-authored documents can be reviewed.')
    }

    const reviewerType = principalKindFor(req, false)
    const decision: ReviewDecision = opts.decision === 'approve' ? 'approved' : 'changes_requested'

    if (opts.decision === 'approve') {
      // Reuse the EXISTING publish op with the reviewer's req, so a reviewer who lacks
      // publish access is rejected by `assertCanPublish` exactly as a direct publish
      // would be. No override — the publish access gate is the single source of truth.
      const published = await publish({ collection: opts.collection, id: opts.id, req: opts.req })
      if (!published) throw new NotFoundError()
    }

    // Persist the decision (after a successful publish on approve, so a rejected publish
    // never records an "approved" row). Note is a free-form string from the reviewer.
    const note = typeof opts.note === 'string' && opts.note.length > 0 ? opts.note : null
    await db.create({
      collection: REVIEWS_TABLE,
      data: {
        id: randomUUID(),
        at: new Date().toISOString(),
        collection: collection.slug,
        documentId: opts.id,
        decision,
        reviewerId: req.user?.id ?? null,
        reviewerType,
        note,
      },
    })

    await recordAudit({
      action: opts.decision === 'approve' ? 'review.approve' : 'review.request_changes',
      collection: collection.slug,
      documentId: opts.id,
      req,
      ...(note ? { meta: { note } } : {}),
    })

    return { decision, documentId: opts.id }
  }

  // -------------------------------------------------------------------------
  // Content releases
  //
  // A release is a NAMED bundle of draft documents published as a UNIT. It layers over
  // the existing drafts + publish + scheduled-publish machinery without rewriting any op:
  // publishing a release publishes each member through the SAME `publish` op the caller
  // would call directly, so `assertCanPublish` (publish access + the agent draft-only
  // brake + the pre-publish eval gate) governs every member. A release therefore can
  // never widen publish authorization. Pre-flight is ALL-OR-NOTHING — if any member would
  // fail the gate, none are published and the release stays `open` (no half go-live).
  // -------------------------------------------------------------------------

  // Bounds on the untrusted release name + membership size (storage-growth guards).
  const MAX_RELEASE_NAME = 200
  const MAX_RELEASE_ITEMS = 1000
  // Prototype-pollution guard for any untrusted release string used downstream.
  const RELEASE_FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype'])

  function assertReleasesEnabled(): void {
    if (!config.releases.enabled) {
      throw new BadRequestError('Content releases are not enabled (set `config.releases: true`).')
    }
  }

  /** Coerce a stored `_releases` row into the public {@link Release} shape. */
  function rowToRelease(row: Row): Release {
    return {
      id: String(row.id),
      name: typeof row.name === 'string' ? row.name : '',
      status: normalizeReleaseStatus(row.status),
      scheduledAt: row.scheduledAt != null ? String(row.scheduledAt) : null,
      createdBy: row.createdBy != null ? String(row.createdBy) : null,
      createdByType: normalizePrincipalType(row.createdByType),
      createdAt: row.createdAt != null ? String(row.createdAt) : '',
      publishedAt: row.publishedAt != null ? String(row.publishedAt) : null,
    }
  }

  function normalizeReleaseStatus(value: unknown): ReleaseStatus {
    return value === 'scheduled' || value === 'published' || value === 'failed' ? value : 'open'
  }

  /** Load a release row by id, or throw NotFound. Releases are admin/editor-gated at the
   *  route layer; the ops trust the resolved `req` (like the review ops). */
  async function releaseRowOrThrow(id: string): Promise<Row> {
    if (typeof id !== 'string' || id.length === 0 || RELEASE_FORBIDDEN.has(id)) {
      throw new BadRequestError('A release id is required.')
    }
    const row = await db.findByID({ collection: RELEASES_TABLE, id })
    if (!row) throw new NotFoundError()
    return row
  }

  /** The member rows of a release, oldest-first. */
  async function releaseItemRows(releaseId: string): Promise<Row[]> {
    const res = await db.find({
      collection: RELEASE_ITEMS_TABLE,
      where: { release: { equals: releaseId } },
      sort: [{ field: 'createdAt', direction: 'asc' }],
      limit: MAX_RELEASE_ITEMS,
      page: 1,
    })
    return res.docs
  }

  function rowToReleaseItem(row: Row): ReleaseItem {
    return {
      id: String(row.id),
      release: String(row.release),
      collection: String(row.collection),
      documentId: String(row.documentId),
    }
  }

  /** Validate that a member's collection is a real, NON-system, drafts-enabled collection.
   *  A release publishes via the per-doc publish op, which requires drafts; and a member
   *  can never be another release or a system table (those aren't in `collectionsBySlug`). */
  function memberCollectionOrThrow(slug: string): CollectionConfig {
    if (typeof slug !== 'string' || RELEASE_FORBIDDEN.has(slug)) {
      throw new BadRequestError('A valid collection slug is required.')
    }
    const collection = collectionOrThrow(slug)
    if (!draftsOn(collection)) {
      throw new BadRequestError(`Collection "${slug}" does not have drafts enabled; it cannot join a release.`)
    }
    return collection
  }

  /** Read-gate a member document with the caller's req — a member can only be added/
   *  previewed/published if the caller could read it directly. Returns the row when
   *  readable; null when the caller can't see it; throws NotFound when it's absent. */
  async function readMemberRow(
    collection: CollectionConfig,
    id: string,
    req: RequestContext,
    override: boolean,
  ): Promise<Row | null> {
    if (typeof id !== 'string' || id.length === 0 || RELEASE_FORBIDDEN.has(id)) {
      throw new BadRequestError('A document id is required.')
    }
    const row = await db.findByID({ collection: collection.slug, id })
    if (!row) throw new NotFoundError()
    if (override) return row
    const access = await evalAccess(collection.access?.read, { req, id })
    if (!isAllowed(access)) return null
    const scope = asWhere(access)
    if (scope && !matchesWhere(row, scope)) return null
    return row
  }

  async function createRelease(opts: CreateReleaseOptions): Promise<Release> {
    assertReleasesEnabled()
    const req = buildReq(opts.req)
    const name = typeof opts.name === 'string' ? opts.name.trim() : ''
    if (name.length === 0) throw new BadRequestError('A release `name` is required.')
    if (name.length > MAX_RELEASE_NAME) {
      throw new BadRequestError(`Release \`name\` too long (max ${MAX_RELEASE_NAME} characters).`)
    }
    const override = opts.overrideAccess ?? false
    const id = randomUUID()
    const created = await db.create({
      collection: RELEASES_TABLE,
      data: {
        id,
        name,
        status: 'open',
        scheduledAt: null,
        createdBy: req.user?.id ?? null,
        createdByType: principalKindFor(req, override),
        publishedAt: null,
      },
    })
    return rowToRelease(created)
  }

  /** Shared member-mutation path for add/remove. Only `open` releases are editable; the
   *  caller must be able to READ the member document (so a release can't reference content
   *  the caller can't see). De-dupes on (release, collection, documentId). */
  async function mutateReleaseMember(opts: ReleaseMemberOptions, action: 'add' | 'remove'): Promise<ReleaseWithItems> {
    assertReleasesEnabled()
    const req = buildReq(opts.req)
    const override = opts.overrideAccess ?? false
    const releaseRow = await releaseRowOrThrow(opts.release)
    const status = normalizeReleaseStatus(releaseRow.status)
    if (status !== 'open') {
      throw new BadRequestError(`Release is "${status}"; only an open release can be edited.`)
    }
    const collection = memberCollectionOrThrow(opts.collection)
    // The member must exist AND be readable by the caller (no leaking foreign content
    // into a release the caller assembles).
    const memberRow = await readMemberRow(collection, opts.id, req, override)
    if (!memberRow) throw new ForbiddenError()

    const existing = await db.find({
      collection: RELEASE_ITEMS_TABLE,
      where: {
        and: [
          { release: { equals: opts.release } },
          { collection: { equals: collection.slug } },
          { documentId: { equals: opts.id } },
        ],
      },
      limit: 1,
      page: 1,
    })
    const present = existing.docs[0]

    if (action === 'add') {
      if (!present) {
        const items = await releaseItemRows(opts.release)
        if (items.length >= MAX_RELEASE_ITEMS) {
          throw new BadRequestError(`Release has too many items (max ${MAX_RELEASE_ITEMS}).`)
        }
        await db.create({
          collection: RELEASE_ITEMS_TABLE,
          data: { id: randomUUID(), release: opts.release, collection: collection.slug, documentId: opts.id },
        })
      }
    } else if (present) {
      await db.delete({ collection: RELEASE_ITEMS_TABLE, id: String(present.id) })
    }

    const items = await releaseItemRows(opts.release)
    return { ...rowToRelease(releaseRow), items: items.map(rowToReleaseItem) }
  }

  function addToRelease(opts: ReleaseMemberOptions): Promise<ReleaseWithItems> {
    return mutateReleaseMember(opts, 'add')
  }

  function removeFromRelease(opts: ReleaseMemberOptions): Promise<ReleaseWithItems> {
    return mutateReleaseMember(opts, 'remove')
  }

  async function listReleases(opts: ListReleasesOptions = {}): Promise<{ docs: Release[]; count: number }> {
    if (!config.releases.enabled) return { docs: [], count: 0 }
    const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
    const page = Math.max(opts.page ?? 1, 1)
    const where = opts.status ? { status: { equals: opts.status } } : undefined
    const res = await db.find({
      collection: RELEASES_TABLE,
      ...(where ? { where } : {}),
      sort: [{ field: 'createdAt', direction: 'desc' }],
      limit,
      page,
    })
    return { docs: res.docs.map(rowToRelease), count: res.totalDocs }
  }

  async function getRelease(opts: GetReleaseOptions): Promise<ReleaseWithItems | null> {
    assertReleasesEnabled()
    const row = await db.findByID({ collection: RELEASES_TABLE, id: opts.release })
    if (!row) return null
    const items = await releaseItemRows(opts.release)
    return { ...rowToRelease(row), items: items.map(rowToReleaseItem) }
  }

  async function previewRelease(opts: PublishReleaseOptions): Promise<PreviewReleaseResult> {
    assertReleasesEnabled()
    const req = buildReq(opts.req)
    const override = opts.overrideAccess ?? false
    await releaseRowOrThrow(opts.release)
    const itemRows = await releaseItemRows(opts.release)
    const items: ReleasePreviewItem[] = []
    for (const item of itemRows) {
      const collection = config.collectionsBySlug[String(item.collection)]
      if (!collection) continue
      // Load the member in its CURRENT (draft) state through the access-checked read.
      // A member the caller can't read is silently dropped — never leaked. findByID
      // throws ForbiddenError on a denied/scoped-out read, so catch it and skip that
      // member (so one unreadable member can't 403 the whole preview).
      let doc: Doc | null = null
      try {
        doc = await findByID({
          collection: collection.slug,
          id: String(item.documentId),
          draft: true,
          req: opts.req,
          ...(override ? { overrideAccess: true } : {}),
        })
      } catch (err) {
        if (!isKernelError(err)) throw err
      }
      if (doc) items.push({ collection: collection.slug, id: String(item.documentId), doc })
    }
    return { items }
  }

  /**
   * Dry-run the publish gate for one member with the caller's req: the per-doc publish
   * access gate + agent brake (`assertCanPublish`) AND the blocking eval gate
   * (`runPrePublishEvals`) against the member's CURRENT draft content. Returns a reason
   * string when the member would NOT publish, or null when it would. Never writes.
   */
  async function preflightMember(
    collection: CollectionConfig,
    id: string,
    req: RequestContext,
    override: boolean,
  ): Promise<string | null> {
    const row = await db.findByID({ collection: collection.slug, id })
    if (!row) return 'document no longer exists'
    if (!override) {
      // The publish path runs through update(), which first requires UPDATE access to the
      // row; mirror that so a caller who can't even update the doc fails pre-flight here.
      const access = await evalAccess(collection.access?.update, { req, id, data: { _status: 'published' } })
      if (!isAllowed(access)) return 'no update access'
      const scope = asWhere(access)
      if (scope && !matchesWhere(row, scope)) return 'no update access'
    }
    try {
      if (!override) await assertCanPublish(collection, req, id, { _status: 'published' } as Row, row)
    } catch (err) {
      if (err instanceof ForbiddenError) return 'publish access denied'
      throw err
    }
    // Eval gate (content CI). Runs regardless of override — evals are server config, not
    // user input — exactly as the real publish path enforces them. A blocking finding
    // throws ValidationError; surface its message as the failure reason.
    const content = deserializeDoc(collection.fields, row, deserializeOptsFor(req)) as Row
    try {
      await runPrePublishEvals(collection, content, req)
    } catch (err) {
      if (err instanceof ValidationError) {
        return err.errors.map((e) => e.message).join('; ')
      }
      throw err
    }
    return null
  }

  async function publishRelease(opts: PublishReleaseOptions): Promise<PublishReleaseResult> {
    assertReleasesEnabled()
    const req = buildReq(opts.req)
    const override = opts.overrideAccess ?? false
    const releaseRow = await releaseRowOrThrow(opts.release)
    const status = normalizeReleaseStatus(releaseRow.status)
    if (status === 'published') {
      throw new BadRequestError('Release is already published.')
    }
    if (status !== 'open' && status !== 'scheduled') {
      throw new BadRequestError(`Release is "${status}"; it cannot be published.`)
    }
    const itemRows = await releaseItemRows(opts.release)
    const members = itemRows
      .map((r) => ({ collection: config.collectionsBySlug[String(r.collection)], id: String(r.documentId) }))
      .filter((m): m is { collection: CollectionConfig; id: string } => Boolean(m.collection))

    // ALL-OR-NOTHING pre-flight: gate-check every member FIRST. If any would fail (publish
    // access, the agent brake, or a blocking eval), publish NONE and leave the release
    // `open`. A release must not go half-live.
    const failed: PublishReleaseResult['failed'] = []
    for (const m of members) {
      const reason = await preflightMember(m.collection, m.id, req, override)
      if (reason) failed.push({ collection: m.collection.slug, id: m.id, reason })
    }
    if (failed.length > 0) {
      return { status: 'open', published: [], failed }
    }

    // Pre-flight passed: publish every member through the EXISTING publish op with the
    // caller's req (so each re-runs assertCanPublish + the eval gate — the gate is the
    // single source of truth; this is no override for an interactive publish). Best-effort
    // atomic: a mid-publish DB error marks the release `failed` and reports the survivors.
    const published: string[] = []
    for (const m of members) {
      try {
        await publish({
          collection: m.collection.slug,
          id: m.id,
          req: opts.req,
          ...(override ? { overrideAccess: true } : {}),
        })
        published.push(`${m.collection.slug}/${m.id}`)
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        failed.push({ collection: m.collection.slug, id: m.id, reason })
        await db.update({
          collection: RELEASES_TABLE,
          id: opts.release,
          data: { status: 'failed' },
        })
        await recordAudit({
          action: 'release.publish',
          documentId: opts.release,
          req,
          overrideAccess: override,
          meta: { status: 'failed', published, failed },
        })
        return { status: 'failed', published, failed }
      }
    }

    const publishedAt = new Date().toISOString()
    await db.update({
      collection: RELEASES_TABLE,
      id: opts.release,
      data: { status: 'published', publishedAt, scheduledAt: null },
    })
    await recordAudit({
      action: 'release.publish',
      documentId: opts.release,
      req,
      overrideAccess: override,
      meta: { status: 'published', published, count: published.length },
    })
    return { status: 'published', published, failed }
  }

  async function scheduleRelease(opts: ScheduleReleaseOptions): Promise<Release> {
    assertReleasesEnabled()
    const req = buildReq(opts.req)
    const override = opts.overrideAccess ?? false
    const releaseRow = await releaseRowOrThrow(opts.release)
    const status = normalizeReleaseStatus(releaseRow.status)
    if (status !== 'open' && status !== 'scheduled') {
      throw new BadRequestError(`Release is "${status}"; only an open release can be scheduled.`)
    }
    const at = new Date(opts.at)
    if (Number.isNaN(at.getTime())) throw new BadRequestError('`at` must be a valid date/time.')
    if (at.getTime() <= Date.now()) throw new BadRequestError('`at` must be in the future.')

    // Gate-check publishability NOW (at schedule time), exactly like a scheduled per-doc
    // publish: the drain later publishes the recorded members under override, so the gate
    // is enforced here, against the CALLER, while they are present. A failing member
    // refuses the schedule (it would only fail again at drain time).
    const itemRows = await releaseItemRows(opts.release)
    for (const item of itemRows) {
      const collection = config.collectionsBySlug[String(item.collection)]
      if (!collection) continue
      const reason = await preflightMember(collection, String(item.documentId), req, override)
      if (reason) {
        throw new BadRequestError(
          `Cannot schedule: member ${collection.slug}/${String(item.documentId)} would not publish (${reason}).`,
        )
      }
    }

    const scheduledAt = at.toISOString()
    const updated = await db.update({
      collection: RELEASES_TABLE,
      id: opts.release,
      data: { status: 'scheduled', scheduledAt },
    })
    await recordAudit({
      action: 'release.schedule',
      documentId: opts.release,
      req,
      overrideAccess: override,
      meta: { scheduledAt, items: itemRows.length },
    })
    return rowToRelease(updated ?? { ...releaseRow, status: 'scheduled', scheduledAt })
  }

  async function cancelRelease(opts: CancelReleaseOptions): Promise<{ id: string }> {
    assertReleasesEnabled()
    const req = buildReq(opts.req)
    const override = opts.overrideAccess ?? false
    const releaseRow = await releaseRowOrThrow(opts.release)
    const status = normalizeReleaseStatus(releaseRow.status)
    if (status === 'published') {
      throw new BadRequestError('A published release is immutable and cannot be cancelled.')
    }
    // Delete the membership rows then the release header.
    const itemRows = await releaseItemRows(opts.release)
    for (const item of itemRows) await db.delete({ collection: RELEASE_ITEMS_TABLE, id: String(item.id) })
    await db.delete({ collection: RELEASES_TABLE, id: opts.release })
    await recordAudit({
      action: 'release.cancel',
      documentId: opts.release,
      req,
      overrideAccess: override,
      meta: { previousStatus: status },
    })
    return { id: opts.release }
  }

  /**
   * Drain due scheduled releases. Mirrors `processScheduledPublishes`: a scheduled
   * release is published under OVERRIDE for the exact member ids recorded — publishability
   * was gate-checked at SCHEDULE time (see `scheduleRelease`), so this is the documented
   * tradeoff (scheduled releases are gate-checked at schedule time, like scheduled
   * publishes). A release whose pre-flight now fails (content changed to violate an eval)
   * is marked `failed` and reported, never silently published. Drive from a cron/job.
   */
  async function processScheduledReleases(
    opts: ProcessScheduledReleasesOptions = {},
  ): Promise<ProcessScheduledReleasesResult> {
    if (!config.releases.enabled) return { published: [] }
    const nowIso = (opts.now ? new Date(opts.now) : new Date()).toISOString()
    const published: string[] = []
    const failed: NonNullable<ProcessScheduledReleasesResult['failed']> = []
    const due = await db.find({
      collection: RELEASES_TABLE,
      where: {
        and: [
          { status: { equals: 'scheduled' } },
          { scheduledAt: { less_than_equal: nowIso } },
          { scheduledAt: { exists: true } },
        ],
      },
      limit: opts.limit ?? 1000,
      page: 1,
    })
    for (const row of due.docs) {
      const id = String(row.id)
      // Publish under override — gate-checked at schedule time. A blocking eval that the
      // content NOW violates still re-fires inside publishRelease's pre-flight (which runs
      // evals regardless of override), so a release that became invalid is reported failed.
      const result = await publishRelease({ release: id, overrideAccess: true })
      if (result.status === 'published') {
        published.push(id)
      } else {
        failed.push({
          release: id,
          reason: result.failed.map((f) => `${f.collection}/${f.id}: ${f.reason}`).join('; '),
        })
        // Pre-flight left it `open`; mark it `failed` so the drain doesn't retry it forever.
        if (result.status === 'open') {
          await db.update({ collection: RELEASES_TABLE, id, data: { status: 'failed' } })
        }
      }
    }
    return failed.length > 0 ? { published, failed } : { published }
  }

  // Keys that must never reach a serialized document via block data — guarding the
  // assembled object against prototype pollution from untrusted block.data keys.
  const COMPOSE_FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

  async function composePage<T extends Doc = Doc>(opts: ComposePageOptions): Promise<T> {
    const collection = collectionOrThrow(opts.collection)
    const field = resolveBlocksField(collection, opts.field)
    if (!Array.isArray(opts.blocks)) throw new BadRequestError('`blocks` must be an array.')
    // Bound the spec: compose is agent/MCP-reachable, so an unbounded blocks array
    // would let a client push arbitrarily large payloads into storage in one call.
    if (opts.blocks.length > MAX_COMPOSE_BLOCKS) {
      throw new BadRequestError(`Too many blocks (${opts.blocks.length}); max ${MAX_COMPOSE_BLOCKS}.`)
    }

    // The value: validate the spec against the schema so an AI can compose a page in one
    // call and never produce an invalid layout. Every block.type must be a known
    // BlockDef.slug on this field; every key in block.data must be a field of that block.
    const blockBySlug = new Map<string, BlockDef>(field.blocks.map((b) => [b.slug, b]))
    const assembled: Row[] = []
    for (let i = 0; i < opts.blocks.length; i++) {
      const block = opts.blocks[i]!
      if (!block || typeof block !== 'object') throw new BadRequestError(`Block at index ${i} must be an object.`)
      const def = blockBySlug.get(block.type)
      if (!def) {
        throw new BadRequestError(
          `Unknown block type "${block.type}" at index ${i} for field "${field.name}". ` +
            `Allowed: ${field.blocks.map((b) => b.slug).join(', ') || '(none)'}.`,
        )
      }
      const data = block.data ?? {}
      if (typeof data !== 'object' || Array.isArray(data)) {
        throw new BadRequestError(`Block "${block.type}" at index ${i}: \`data\` must be an object.`)
      }
      const allowedKeys = new Set(effectiveFields(def.fields).map((f) => f.name))
      const row: Row = { blockType: def.slug }
      for (const key of Object.keys(data)) {
        // Reject prototype-pollution keys outright; then reject any field not declared
        // on the block (a clear BadRequest — an AI can't smuggle an unknown field).
        if (COMPOSE_FORBIDDEN_KEYS.has(key)) throw new BadRequestError(`Illegal block field key "${key}".`)
        if (!allowedKeys.has(key)) {
          throw new BadRequestError(
            `Block "${block.type}" at index ${i} has no field "${key}". ` +
              `Allowed: ${[...allowedKeys].join(', ') || '(none)'}.`,
          )
        }
        row[key] = (data as Row)[key]
      }
      assembled.push(row)
    }

    // Merge any other top-level fields with the assembled layout, then create through the
    // NORMAL pipeline — so the agent draft-only brake, field scope, and access all apply
    // (no override). `field`/`blocks`/`data` are untrusted; top-level data keys are also
    // guarded against prototype pollution before they reach the document.
    const top = opts.data ?? {}
    if (typeof top !== 'object' || Array.isArray(top)) throw new BadRequestError('`data` must be an object.')
    const docData: Row = {}
    for (const key of Object.keys(top)) {
      if (COMPOSE_FORBIDDEN_KEYS.has(key)) throw new BadRequestError(`Illegal data key "${key}".`)
      docData[key] = (top as Row)[key]
    }
    docData[field.name] = assembled

    return create<T>({ collection: opts.collection, data: docData, req: opts.req })
  }

  // -------------------------------------------------------------------------
  // Content templates — named document skeletons + create-from-template
  // -------------------------------------------------------------------------

  /**
   * List the available content templates as METADATA ONLY (slug/collection/name/description —
   * never the raw `data` blob), optionally filtered to one collection. Templates are TRUSTED
   * config skeletons (not stored content), so the list is non-sensitive: it is NOT scoped per
   * row by the caller's read access (there is no per-document data to leak — instantiating one
   * still goes through the full create access gate). Empty when no templates are configured.
   */
  async function listTemplates(opts: ListTemplatesOptions = {}): Promise<TemplateSummary[]> {
    return config.templates
      .filter((t) => (opts.collection ? t.collection === opts.collection : true))
      .map((t) => ({
        slug: t.slug,
        collection: t.collection,
        ...(t.name !== undefined ? { name: t.name } : {}),
        ...(t.description !== undefined ? { description: t.description } : {}),
      }))
  }

  /**
   * Instantiate a content template into a fully pre-filled document. Looks the template up by
   * slug (unknown → a clean BadRequest, no injection via the lookup), deep-merges its TRUSTED
   * default `data` with the caller's UNTRUSTED `data` override (caller wins; nested objects
   * deep-merge; the merge is prototype-pollution-guarded), then creates through the NORMAL
   * `create()` path — NO `overrideAccess`. So the caller needs create access, field scope
   * strips out-of-scope fields, validation runs, and the agent draft-only brake holds (a
   * template that sets `_status:'published'` can NEVER let an agent publish). Audited as a
   * `create` with the template slug in `meta` (the underlying `create` records the row).
   */
  async function createFromTemplate<T extends Doc = Doc>(opts: CreateFromTemplateOptions): Promise<T> {
    if (typeof opts.template !== 'string' || opts.template.length === 0) {
      throw new BadRequestError('A `template` slug is required.')
    }
    // Own-property lookup only: never reach a key inherited from Object.prototype
    // (e.g. a `template:'constructor'` slug must 404, not resolve to a function).
    const template = Object.prototype.hasOwnProperty.call(config.templatesBySlug, opts.template)
      ? config.templatesBySlug[opts.template]
      : undefined
    if (!template) throw new NotFoundError(`Unknown template "${opts.template}".`)

    // Merge trusted defaults with the untrusted override (caller wins). A pollution key in
    // the override is rejected as a clean 400 rather than leaking a 500 / poisoning a proto.
    let data: Row
    try {
      data = mergeTemplateData(template.data, opts.data)
    } catch (err) {
      if (err instanceof TemplateMergeError) throw new BadRequestError(err.message)
      throw err
    }

    // The NORMAL create — access, field scope, validation, and the agent draft-only brake
    // all apply (no override). A template can only ever create into ITS OWN collection.
    const doc = await create<T>({
      collection: template.collection,
      data,
      ...(opts.req ? { req: opts.req } : {}),
      ...(opts.overrideAccess !== undefined ? { overrideAccess: opts.overrideAccess } : {}),
    })
    // Record the template provenance (the create itself is already audited by `create`).
    await recordAudit({
      action: 'create',
      collection: template.collection,
      documentId: String(doc.id),
      req: buildReq(opts.req),
      overrideAccess: opts.overrideAccess ?? false,
      meta: { template: template.slug },
    })
    return doc
  }

  async function findVersions(opts: FindVersionsOptions): Promise<PaginatedResult<VersionDoc>> {
    const collection = collectionOrThrow(opts.collection)
    if (!versionsOf(collection).enabled) {
      throw new BadRequestError(`Collection "${opts.collection}" does not have versions enabled.`)
    }
    const req = buildReq(opts.req)
    const override = opts.overrideAccess ?? false
    if (!override) {
      const access = await evalAccess(collection.access?.read, { req, id: opts.id })
      if (!isAllowed(access)) throw new ForbiddenError()
      // Row-level scope must be enforced against the PARENT, exactly like findByID —
      // otherwise any reader can list another tenant's version history (IDOR).
      const scope = asWhere(access)
      if (scope) {
        const parent = await db.findByID({ collection: collection.slug, id: opts.id })
        if (!parent || !matchesWhere(parent, scope)) throw new ForbiddenError()
      }
    }
    const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
    const page = Math.max(opts.page ?? 1, 1)
    // Optionally narrow to one principal kind ("review agent changes").
    const where: Where = opts.createdByType
      ? { and: [{ parent: { equals: opts.id } }, { createdByType: { equals: opts.createdByType } }] }
      : { parent: { equals: opts.id } }
    const result = await db.find({
      collection: tableForVersions(collection.slug),
      where,
      sort: [{ field: 'createdAt', direction: 'desc' }],
      limit,
      page,
    })
    // Snapshots embed the full document; field-level read access must still apply
    // so a restricted field can't be read out of the version history.
    for (const v of result.docs) {
      if (v.version && typeof v.version === 'object') {
        // Decrypt encrypted fields (the snapshot stores them as ciphertext at rest), THEN
        // apply field-access — so a denied reader gets null, never ciphertext or plaintext.
        v.version = decodeVersionContent(collection, v.version)
        if (!override) await applyReadFieldAccess(collection.fields, v.version as Row, req, opts.id)
      }
    }
    return { ...result, docs: result.docs as VersionDoc[] }
  }

  async function restoreVersion<T extends Doc = Doc>(opts: RestoreVersionOptions): Promise<T | null> {
    const collection = collectionOrThrow(opts.collection)
    if (!versionsOf(collection).enabled) {
      throw new BadRequestError(`Collection "${opts.collection}" does not have versions enabled.`)
    }
    // Enforce read access + row scope on the parent before reading any snapshot
    // content; the subsequent update() re-checks write access independently.
    if (!(opts.overrideAccess ?? false)) {
      const req = buildReq(opts.req)
      const access = await evalAccess(collection.access?.read, { req, id: opts.id })
      if (!isAllowed(access)) throw new ForbiddenError()
      const scope = asWhere(access)
      if (scope) {
        const parent = await db.findByID({ collection: collection.slug, id: opts.id })
        if (!parent || !matchesWhere(parent, scope)) throw new ForbiddenError()
      }
    }
    const vrow = await db.findByID({ collection: tableForVersions(collection.slug), id: opts.versionId })
    if (!vrow || String(vrow.parent) !== String(opts.id)) throw new NotFoundError('Version not found.')
    const content = decodeVersionContent(collection, vrow.version)
    const data: Row = {}
    for (const f of effectiveFields(collection.fields)) {
      if (Object.prototype.hasOwnProperty.call(content, f.name)) data[f.name] = content[f.name]
    }
    // Route through update so access, validation, and a new snapshot all apply.
    return update<T>({
      collection: opts.collection,
      id: opts.id,
      data,
      req: opts.req,
      overrideAccess: opts.overrideAccess,
      depth: opts.depth,
    })
  }

  // -------------------------------------------------------------------------
  // Content time-machine — point-in-time reads, history timeline, diff, restore
  //
  // A navigable timeline over the existing version snapshots. Every surface enforces
  // the SAME access read-check + field stripping as a live read, so the time-machine
  // can never become a read-access bypass: a caller who can't read the current doc
  // can't read its history/diff/as-of state, and a read-denied field never appears in
  // any reconstructed doc, `changedFields`, or diff.
  // -------------------------------------------------------------------------

  /** Require `versions` enabled for the time-machine, else a clear 400. */
  function assertVersioned(collection: CollectionConfig): void {
    if (!versionsOf(collection).enabled) {
      throw new BadRequestError(`Collection "${collection.slug}" does not have versions enabled.`)
    }
  }

  /** Top-level user-meaningful field names of a collection (the diffable surface). System
   *  columns (`_status`, timestamps, …) are excluded — they are not user content and aren't
   *  attributed as field changes (mirrors the audit field skip). */
  function contentFieldNames(collection: CollectionConfig): string[] {
    return effectiveFields(collection.fields)
      .map((f) => f.name)
      .filter((n) => !AUDIT_FIELD_SKIP.has(n))
  }

  /** The version snapshot rows for one document, oldest → newest. Bounded by MAX_LIMIT. */
  async function snapshotsOf(collection: CollectionConfig, id: string): Promise<Row[]> {
    const res = await db.find({
      collection: tableForVersions(collection.slug),
      where: { parent: { equals: id } },
      sort: [{ field: 'createdAt', direction: 'asc' }],
      limit: MAX_LIMIT,
      page: 1,
    })
    return res.docs
  }

  /** The latest snapshot row with `createdAt <= asOfMs`, or null when the doc did not exist
   *  yet. Linear over the (bounded) ascending snapshot list — picks the last qualifying row. */
  function pickAsOf(snapshots: Row[], asOfMs: number): Row | null {
    let chosen: Row | null = null
    for (const s of snapshots) {
      const t = s.createdAt != null ? new Date(String(s.createdAt)).getTime() : NaN
      if (Number.isFinite(t) && t <= asOfMs) chosen = s
      else if (Number.isFinite(t) && t > asOfMs) break
    }
    return chosen
  }

  /** Enforce the doc's read access + row scope before exposing ANY historical data, exactly
   *  like a live read. Returns false when the document does not exist (so callers can map to
   *  null/empty); throws Forbidden when it exists but the caller may not read it. */
  async function canReadDocForHistory(
    collection: CollectionConfig,
    id: string,
    req: RequestContext,
    override: boolean,
  ): Promise<boolean> {
    const row = await db.findByID({ collection: collection.slug, id })
    if (!row) return false
    if (override) return true
    const access = await evalAccess(collection.access?.read, { req, id })
    if (!isAllowed(access)) throw new ForbiddenError()
    const scope = asWhere(access)
    if (scope && !matchesWhere(row, scope)) throw new ForbiddenError()
    return true
  }

  /** Reconstruct a document from a version snapshot row, applying the read tail (field-access
   *  strip → computed → strip) so a historical read can never reveal a read-denied field. The
   *  snapshot's `version` JSON is the full doc at that point; we re-derive a clean Doc from it. */
  async function reconstructFromSnapshot(
    collection: CollectionConfig,
    snapshot: Row,
    req: RequestContext,
    override: boolean,
  ): Promise<Doc> {
    const content = decodeVersionContent(collection, snapshot.version)
    const doc: Doc = { ...content, id: String(snapshot.parent) }
    // Read-field-access strip BEFORE computed (so a virtual field can't observe a sibling the
    // caller may not read), then strip again to honour any rule on the virtual fields.
    if (!override) await applyReadFieldAccess(collection.fields, doc, req, doc.id)
    await applyComputed(collection.fields, doc, req)
    if (!override) await applyReadFieldAccess(collection.fields, doc, req, doc.id)
    return doc
  }

  /** Point-in-time read of one document (the `asOf` branch of findByID). Access read-check is
   *  enforced against the CURRENT row first (never leak history for a doc the caller can't
   *  read), then the snapshot `<= asOf` is reconstructed + field-stripped. Null when the doc
   *  did not exist at `asOf`, or its current row is gone / unreadable. */
  async function findByIDAsOf<T extends Doc = Doc>(
    collection: CollectionConfig,
    opts: FindByIDOptions,
    req: RequestContext,
    override: boolean,
  ): Promise<T | null> {
    const asOfMs = parseTimestamp(opts.asOf, (v) => {
      throw new BadRequestError(`Invalid \`asOf\` timestamp: ${JSON.stringify(v)}.`)
    })
    if (!(await canReadDocForHistory(collection, opts.id, req, override))) return null
    const snapshot = pickAsOf(await snapshotsOf(collection, opts.id), asOfMs)
    if (!snapshot) return null
    // Published-only by default, exactly like a live read: the as-of snapshot's OWN status at
    // that instant must have been 'published' unless drafts were explicitly requested. This
    // stops the time-machine surfacing a historical draft a live read would have hidden.
    if (draftsOn(collection) && !(opts.draft ?? false) && snapshot.status !== 'published') return null
    return (await reconstructFromSnapshot(collection, snapshot, req, override)) as T
  }

  /**
   * Point-in-time `find`: every document's as-of state at `opts.asOf`. The candidate id set
   * is the distinct `parent` of the version table (every doc that ever had a snapshot). Each
   * candidate is reconstructed through `findByIDAsOf`, which enforces the SAME read-access gate
   * against the CURRENT row as a live read — so a doc the caller can't read, a doc whose current
   * row is gone (deleted), or a doc not yet created at `asOf` simply yields null and is dropped.
   * Pagination is applied AFTER access filtering over the assembled, deterministically-ordered
   * (newest snapshot first) set. `where` is applied to the reconstructed as-of docs.
   */
  async function findAsOf<T extends Doc = Doc>(
    collection: CollectionConfig,
    opts: FindOptions,
    req: RequestContext,
    override: boolean,
  ): Promise<PaginatedResult<T>> {
    assertWhereFields(collection, opts.where)
    // Fail fast on a garbage timestamp before scanning the version table (the per-id path
    // re-validates too, but rejecting here avoids a wasted scan).
    parseTimestamp(opts.asOf, (v) => {
      throw new BadRequestError(`Invalid \`asOf\` timestamp: ${JSON.stringify(v)}.`)
    })
    const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
    const page = Math.max(opts.page ?? 1, 1)

    // Distinct parent ids across the (bounded) version table. The table is per-collection,
    // so this is the full id universe that ever existed; we cap the scan at MAX_LIMIT rows
    // per page and walk pages until exhausted or a hard ceiling, keeping it bounded.
    const ids = new Set<string>()
    for (let p = 1; p <= 50; p++) {
      const res = await db.find({
        collection: tableForVersions(collection.slug),
        where: { parent: { exists: true } },
        sort: [{ field: 'parent', direction: 'asc' }],
        limit: MAX_LIMIT,
        page: p,
      })
      for (const r of res.docs) if (r.parent != null) ids.add(String(r.parent))
      if (res.docs.length < MAX_LIMIT) break
    }

    const matched: Doc[] = []
    for (const id of ids) {
      // A doc the caller can't read throws Forbidden in the per-id path; in a LIST it must be
      // silently dropped (parity with `find`'s scope-filtering), never surfaced or 403-ing the
      // whole page — so the time-machine list never leaks another tenant's existence.
      let doc: Doc | null
      try {
        doc = await findByIDAsOf<Doc>(
          collection,
          {
            collection: collection.slug,
            id,
            asOf: opts.asOf,
            ...(opts.draft !== undefined ? { draft: opts.draft } : {}),
          },
          req,
          override,
        )
      } catch (err) {
        if (err instanceof ForbiddenError) continue
        throw err
      }
      if (!doc) continue
      if (opts.where && !matchesWhere(doc as Row, opts.where)) continue
      matched.push(doc)
    }
    // Deterministic order: newest as-of `createdAt` first (fall back to id for stability).
    matched.sort((a, b) => {
      const at = String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''))
      return at !== 0 ? at : String(a.id).localeCompare(String(b.id))
    })

    const totalDocs = matched.length
    const start = (page - 1) * limit
    const docs = matched.slice(start, start + limit)
    const totalPages = Math.max(1, Math.ceil(totalDocs / limit))
    const hasNextPage = start + limit < totalDocs
    const hasPrevPage = page > 1
    return {
      docs: docs as T[],
      totalDocs,
      limit,
      page,
      totalPages,
      hasNextPage,
      hasPrevPage,
      prevPage: hasPrevPage ? page - 1 : null,
      nextPage: hasNextPage ? page + 1 : null,
      pagingCounter: start + 1,
    }
  }

  async function history(opts: HistoryOptions): Promise<HistoryEntry[]> {
    const collection = collectionOrThrow(opts.collection)
    assertVersioned(collection)
    const req = buildReq(opts.req)
    const override = opts.overrideAccess ?? false
    // Must be able to read the live doc; otherwise history would leak it.
    if (!(await canReadDocForHistory(collection, opts.id, req, override))) return []

    const snapshots = await snapshotsOf(collection, opts.id)
    // The diffable field surface, minus any field the caller may not read — so a read-denied
    // field never surfaces as "changed". Evaluated against the latest snapshot's content.
    const fieldNames = await readableFieldNames(collection, snapshots, req, override)

    const entries: HistoryEntry[] = []
    let prev: Row | null = null
    for (const s of snapshots) {
      const content = decodeVersionContent(collection, s.version)
      const changedFields = prev === null ? [...fieldNames] : changedFieldNames(prev, content, fieldNames)
      entries.push({
        versionId: String(s.id),
        at: s.createdAt != null ? String(s.createdAt) : '',
        by: s.createdBy != null ? String(s.createdBy) : null,
        byType: normalizePrincipalType(s.createdByType),
        status: typeof s.status === 'string' ? s.status : 'draft',
        autosave: s.autosave === true,
        changedFields,
      })
      prev = content
    }
    return entries
  }

  /** The content field names the caller may READ, derived from a representative snapshot
   *  (the latest). A field whose `access.read` denies the caller is dropped, so neither
   *  `changedFields` nor a diff can reveal it. Override sees all content fields. */
  async function readableFieldNames(
    collection: CollectionConfig,
    snapshots: Row[],
    req: RequestContext,
    override: boolean,
  ): Promise<string[]> {
    const all = contentFieldNames(collection)
    if (override) return all
    const sample = snapshots.length ? decodeVersionContent(collection, snapshots[snapshots.length - 1]!.version) : {}
    const readable: string[] = []
    for (const field of effectiveFields(collection.fields)) {
      if (!all.includes(field.name)) continue
      const rule = field.access?.read
      if (rule) {
        const decision = await evalAccess(rule, { req, id: String(snapshots[0]?.parent ?? ''), data: sample })
        if (!isAllowed(decision)) continue
      }
      readable.push(field.name)
    }
    return readable
  }

  /** Resolve a `from`/`to` selector — a versionId OR an ISO timestamp — to a snapshot row.
   *  A versionId must belong to THIS document (a foreign/forged id → NotFound, never a leak).
   *  A timestamp resolves to the latest snapshot `<= it` (null when before creation). */
  function resolveSnapshotSelector(snapshots: Row[], selector: string): Row | null {
    if (typeof selector !== 'string' || selector.length === 0) {
      throw new BadRequestError('A diff selector must be a versionId or an ISO timestamp.')
    }
    const byId = snapshots.find((s) => String(s.id) === selector)
    if (byId) return byId
    // Not an id of this doc — try to read it as a timestamp.
    const t = new Date(selector).getTime()
    if (!Number.isFinite(t)) {
      throw new NotFoundError('Diff selector did not match a version of this document, nor a valid timestamp.')
    }
    return pickAsOf(snapshots, t)
  }

  async function diffVersions(opts: DiffVersionsOptions): Promise<VersionDiff> {
    const collection = collectionOrThrow(opts.collection)
    assertVersioned(collection)
    const req = buildReq(opts.req)
    const override = opts.overrideAccess ?? false
    if (!(await canReadDocForHistory(collection, opts.id, req, override))) return {}

    const snapshots = await snapshotsOf(collection, opts.id)
    const fromSnap = resolveSnapshotSelector(snapshots, opts.from)
    const toSnap = resolveSnapshotSelector(snapshots, opts.to)
    // A selector before the document existed yields no snapshot → treat its side as empty,
    // so a diff "from before creation to now" shows every field appearing.
    const fromContent = decodeVersionContent(collection, fromSnap?.version)
    const toContent = decodeVersionContent(collection, toSnap?.version)
    const fieldNames = await readableFieldNames(collection, snapshots, req, override)
    return diffDocs(fromContent, toContent, fieldNames)
  }

  async function restoreAsOf<T extends Doc = Doc>(opts: RestoreAsOfOptions): Promise<T | null> {
    const collection = collectionOrThrow(opts.collection)
    assertVersioned(collection)
    const req = buildReq(opts.req)
    const override = opts.overrideAccess ?? false
    const asOfMs = parseTimestamp(opts.asOf, (v) => {
      throw new BadRequestError(`Invalid \`asOf\` timestamp: ${JSON.stringify(v)}.`)
    })
    // Read-gate the document first (parity with restoreVersion); the update() below
    // re-checks WRITE access + the agent draft-only brake independently.
    if (!(await canReadDocForHistory(collection, opts.id, req, override))) return null

    const snapshot = pickAsOf(await snapshotsOf(collection, opts.id), asOfMs)
    if (!snapshot) return null
    const content = decodeVersionContent(collection, snapshot.version)
    // Restore ONLY real schema fields (never system/auth columns or `_status`) — the as-of
    // state is content, not a publish action. Routing through update() means access control,
    // validation, the agent brake, and a fresh snapshot all apply with NO override bypass.
    const data: Row = {}
    for (const f of effectiveFields(collection.fields)) {
      if (AUDIT_FIELD_SKIP.has(f.name)) continue
      if (Object.prototype.hasOwnProperty.call(content, f.name)) data[f.name] = content[f.name]
    }
    return update<T>({
      collection: opts.collection,
      id: opts.id,
      data,
      req: opts.req,
      overrideAccess: opts.overrideAccess,
      depth: opts.depth,
    })
  }

  async function publish<T extends Doc = Doc>(opts: PublishOptions): Promise<T | null> {
    const collection = collectionOrThrow(opts.collection)
    if (!draftsOn(collection))
      throw new BadRequestError(`Collection "${opts.collection}" does not have drafts enabled.`)
    // A future `publishAt` schedules the publish (stays a draft until then);
    // otherwise publish immediately and clear any pending schedule.
    const at = opts.publishAt ? new Date(opts.publishAt) : null
    const scheduled = at && !Number.isNaN(at.getTime()) && at.getTime() > Date.now()
    return update<T>(
      {
        collection: opts.collection,
        id: opts.id,
        data: scheduled
          ? ({ _status: 'draft', _scheduled_at: at.toISOString() } as Row)
          : ({ _status: 'published', _scheduled_at: null } as Row),
        req: opts.req,
        overrideAccess: opts.overrideAccess,
        depth: opts.depth,
        ...(opts.expectedUpdatedAt != null ? { expectedUpdatedAt: opts.expectedUpdatedAt } : {}),
      },
      'publish',
    )
  }

  /** Publish all drafts whose scheduled time has arrived. Drive from a cron/job. */
  async function processScheduledPublishes(opts: ProcessScheduledOptions = {}): Promise<ProcessScheduledResult> {
    const nowIso = (opts.now ? new Date(opts.now) : new Date()).toISOString()
    const published: string[] = []
    const skipped: ProcessScheduledResult['skipped'] = []
    for (const collection of config.collections) {
      if (!draftsOn(collection)) continue
      const due = await db.find({
        collection: collection.slug,
        where: {
          and: [{ _scheduled_at: { less_than_equal: nowIso } }, { _scheduled_at: { exists: true } }],
        },
        limit: opts.limit ?? 1000,
        page: 1,
      })
      for (const row of due.docs) {
        if (row._status === 'published') continue
        try {
          await update(
            {
              collection: collection.slug,
              id: String(row.id),
              data: { _status: 'published', _scheduled_at: null } as Row,
              overrideAccess: true,
            },
            'publish',
          )
          published.push(String(row.id))
        } catch (err) {
          // A blocking pre-publish eval rejects with a ValidationError BEFORE the write +
          // signing (see update()), so the doc is untouched: still a draft, still carrying
          // its `_scheduled_at`, with NO content credential. That's an expected skip — log
          // it, record it, and keep draining the queue. Any OTHER error is unexpected and
          // must surface, not be silently swallowed.
          if (err instanceof ValidationError) {
            logger?.warn(`Scheduled publish skipped (blocking eval): ${collection.slug}/${String(row.id)}`, err.message)
            skipped.push({ id: String(row.id), collection: collection.slug, reason: err.message })
            continue
          }
          throw err
        }
      }
    }
    return skipped.length > 0 ? { published, skipped } : { published }
  }

  /**
   * Retire expired content — the INVERSE of `processScheduledPublishes`. For each
   * `config.lifecycle` collection, find every PUBLISHED document whose expiry date
   * (`expireField`) is at or before `now` and apply the collection's `onExpire` action:
   *   - 'unpublish' → set `_status:'draft'` (via the unpublish path)
   *   - 'archive'   → set `_status:'draft'` AND stamp `_archived_at = now`
   *   - 'delete'    → remove the document
   * A TRUSTED system/cron maintenance op: every action runs under `overrideAccess:true`,
   * exactly like `processScheduledPublishes` (the expiry date itself was set by an editor
   * through normal field access). Confined to the configured collections; bounded by
   * `limit` per collection; resilient per-doc (one failure is logged and the loop
   * continues, so a single bad row never aborts the drain). Each retirement is audited
   * (`content.expire`, with the action + expiry in meta). Drive from a cron/job.
   */
  async function processContentLifecycle(
    opts: ProcessContentLifecycleOptions = {},
  ): Promise<ProcessContentLifecycleResult> {
    const processed: ContentLifecycleAction[] = []
    if (!config.lifecycle.enabled) return { processed }
    const now = opts.now ? new Date(opts.now) : new Date()
    // An invalid `now` would make `<= NaN` match nothing AND poison an archive stamp —
    // fail closed to the current time rather than silently no-op / write a bad timestamp.
    const nowMs = now.getTime()
    const nowIso = (Number.isFinite(nowMs) ? now : new Date()).toISOString()
    const limit = Math.min(Math.max(opts.limit ?? MAX_LIMIT, 1), MAX_LIMIT)

    for (const entry of config.lifecycle.collections) {
      const collection = config.collectionsBySlug[entry.slug]
      // Defensive: sanitize already validated the slug + drafts; skip if somehow absent.
      if (!collection || !draftsOn(collection)) continue
      // Only PUBLISHED docs are due, and only when their expiry has passed. For 'archive'
      // also require `_archived_at` to be unset, so a doc is never re-archived (idempotent).
      const conditions: Where[] = [
        { _status: { equals: 'published' } },
        { [entry.expireField]: { less_than_equal: nowIso } },
        { [entry.expireField]: { exists: true } },
      ]
      if (entry.onExpire === 'archive') conditions.push({ _archived_at: { exists: false } })
      const due = await db.find({
        collection: collection.slug,
        where: { and: conditions },
        limit,
        page: 1,
      })
      for (const row of due.docs) {
        const id = String(row.id)
        try {
          if (entry.onExpire === 'delete') {
            await deleteOne({ collection: collection.slug, id, overrideAccess: true })
          } else if (entry.onExpire === 'archive') {
            await update(
              {
                collection: collection.slug,
                id,
                data: { _status: 'draft', _archived_at: nowIso } as Row,
                overrideAccess: true,
              },
              'unpublish',
            )
          } else {
            await update(
              {
                collection: collection.slug,
                id,
                data: { _status: 'draft' } as Row,
                overrideAccess: true,
              },
              'unpublish',
            )
          }
          await recordAudit({
            action: 'content.expire',
            collection: collection.slug,
            documentId: id,
            overrideAccess: true,
            meta: { action: entry.onExpire, expireField: entry.expireField, expiredAt: nowIso },
          })
          processed.push({ collection: collection.slug, id, action: entry.onExpire })
        } catch (err) {
          // Resilient drain: a single doc failing (a hook throwing, a referential restrict
          // on delete, …) is logged and skipped so the rest of the queue still drains. The
          // underlying op is transactional per-doc, so a failure never leaves a half-write.
          logger?.warn(
            `Content lifecycle skipped (${entry.onExpire}): ${collection.slug}/${id}`,
            err instanceof Error ? err.message : String(err),
          )
        }
      }
    }
    return { processed }
  }

  // -------------------------------------------------------------------------
  // Durable webhook delivery (the outbox drain + admin surface)
  // -------------------------------------------------------------------------

  /** Back-off before the next attempt of a failed durable delivery: exponential in the
   *  attempt count, capped at 1 hour. attempt 1 → 2s, 2 → 4s, … 12+ → 3600s. */
  function webhookBackoffMs(attempts: number): number {
    return Math.min(2 ** attempts, 3600) * 1000
  }

  /** A do-nothing logger for the drain when the kernel was created without one. */
  const NOOP_LOGGER: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

  function durableWebhooksConfigured(): boolean {
    // The outbox is also the delivery channel for saved-search alerts, so the drain runs when
    // subscriptions are enabled even if no webhook opted into `durable`.
    return config.webhooks.some((w) => w.durable) || config.subscriptions.enabled
  }

  /** Shape a raw `_webhook_deliveries` row into a public WebhookDeliveryDoc. */
  function rowToDelivery(row: Row): WebhookDeliveryDoc {
    return {
      id: String(row.id),
      webhook: String(row.webhook),
      event: String(row.event) as WebhookEvent,
      collection: String(row.collection),
      documentId: String(row.documentId),
      status: String(row.status) as WebhookDeliveryDoc['status'],
      attempts: Number(row.attempts ?? 0),
      lastStatus: row.lastStatus == null ? null : String(row.lastStatus),
      nextAttemptAt: row.nextAttemptAt == null ? null : String(row.nextAttemptAt),
      deliveredAt: row.deliveredAt == null ? null : String(row.deliveredAt),
      createdAt: String(row.createdAt),
      updatedAt: String(row.updatedAt),
    }
  }

  async function processWebhooks(opts: ProcessWebhooksOptions = {}): Promise<ProcessWebhooksResult> {
    const result: ProcessWebhooksResult = { delivered: [], retried: [], exhausted: [] }
    if (!durableWebhooksConfigured()) return result
    const now = opts.now ?? new Date()
    const nowIso = now.toISOString()
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), MAX_LIMIT)

    // Due deliveries: still pending or in retry, with their next attempt time reached.
    const due = await db.find({
      collection: WEBHOOK_DELIVERIES_TABLE,
      where: { and: [{ status: { in: ['pending', 'failed'] } }, { nextAttemptAt: { less_than_equal: nowIso } }] },
      sort: [{ field: 'nextAttemptAt', direction: 'asc' }],
      limit,
      page: 1,
    })

    for (const row of due.docs) {
      const id = String(row.id)
      const cfg = config.webhooks.find((w) => w.slug === String(row.webhook))
      // Endpoint removed from config since enqueue: retire the delivery (don't deliver to an
      // unknown/possibly-reused target), mark exhausted.
      if (!cfg) {
        await db.update({
          collection: WEBHOOK_DELIVERIES_TABLE,
          id,
          data: { status: 'exhausted', nextAttemptAt: null, lastStatus: 'webhook no longer configured' },
        })
        result.exhausted.push(id)
        continue
      }

      const payload = (row.payload ?? {}) as WebhookPayload
      let outcome: { ok: boolean; status?: number; error?: string }
      try {
        outcome = await deliverWebhook(cfg, payload, logger ?? NOOP_LOGGER)
      } catch (err) {
        // deliverWebhook never throws, but be defensive — a thrown error is a failed attempt.
        outcome = { ok: false, error: err instanceof Error ? err.message : 'delivery threw' }
      }
      const attempts = Number(row.attempts ?? 0) + 1
      const lastStatus = outcome.ok
        ? String(outcome.status ?? 200)
        : (outcome.error ?? String(outcome.status ?? 'error'))

      if (outcome.ok) {
        await db.update({
          collection: WEBHOOK_DELIVERIES_TABLE,
          id,
          data: { status: 'delivered', attempts, lastStatus, deliveredAt: nowIso, nextAttemptAt: null },
        })
        result.delivered.push(id)
        await recordAudit({
          action: 'webhook.deliver',
          collection: String(row.collection),
          documentId: String(row.documentId),
          overrideAccess: true,
          meta: { webhook: cfg.slug, attempts, status: outcome.status ?? null },
        })
      } else if (attempts >= cfg.maxAttempts) {
        await db.update({
          collection: WEBHOOK_DELIVERIES_TABLE,
          id,
          data: { status: 'exhausted', attempts, lastStatus, nextAttemptAt: null },
        })
        result.exhausted.push(id)
        await recordAudit({
          action: 'webhook.fail',
          collection: String(row.collection),
          documentId: String(row.documentId),
          overrideAccess: true,
          meta: { webhook: cfg.slug, attempts, exhausted: true, lastStatus },
        })
      } else {
        const next = new Date(now.getTime() + webhookBackoffMs(attempts)).toISOString()
        await db.update({
          collection: WEBHOOK_DELIVERIES_TABLE,
          id,
          data: { status: 'failed', attempts, lastStatus, nextAttemptAt: next },
        })
        result.retried.push(id)
        await recordAudit({
          action: 'webhook.fail',
          collection: String(row.collection),
          documentId: String(row.documentId),
          overrideAccess: true,
          meta: { webhook: cfg.slug, attempts, nextAttemptAt: next, lastStatus },
        })
      }
    }
    return result
  }

  /** REDACTED summaries of the configured webhooks — never the secret or custom headers. */
  function listWebhooks(): WebhookSummary[] {
    return config.webhooks.map((w) => ({
      slug: w.slug,
      url: w.url,
      events: w.events ?? ['create', 'update', 'delete'],
      collections: w.collections ?? null,
      durable: w.durable === true,
      signed: Boolean(w.secret),
    }))
  }

  async function webhookDeliveries(
    opts: WebhookDeliveriesOptions = {},
  ): Promise<{ docs: WebhookDeliveryDoc[]; count: number }> {
    if (!durableWebhooksConfigured()) return { docs: [], count: 0 }
    const and: Where[] = []
    if (opts.webhook != null) and.push({ webhook: { equals: String(opts.webhook) } })
    if (opts.status != null) and.push({ status: { equals: String(opts.status) } })
    if (opts.since != null) and.push({ createdAt: { greater_than: String(opts.since) } })
    const where = and.length ? { and } : undefined
    const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
    const page = Math.max(opts.page ?? 1, 1)
    const res = await db.find({
      collection: WEBHOOK_DELIVERIES_TABLE,
      ...(where ? { where } : {}),
      sort: [{ field: 'createdAt', direction: 'desc' }],
      limit,
      page,
    })
    const count = await db.count({ collection: WEBHOOK_DELIVERIES_TABLE, ...(where ? { where } : {}) })
    return { docs: res.docs.map(rowToDelivery), count }
  }

  async function retryWebhookDelivery(opts: RetryWebhookDeliveryOptions): Promise<WebhookDeliveryDoc> {
    if (!durableWebhooksConfigured()) {
      throw new BadRequestError('No durable webhooks are configured.')
    }
    const { deliveryId } = opts
    if (typeof deliveryId !== 'string' || deliveryId.length === 0 || COMMENT_FORBIDDEN_KEYS.has(deliveryId)) {
      throw new BadRequestError('A valid `deliveryId` is required.')
    }
    const row = await db.findByID({ collection: WEBHOOK_DELIVERIES_TABLE, id: deliveryId })
    if (!row) throw new NotFoundError()
    // Requeue: due immediately, status pending. Keeps the attempt count (history), so a
    // manually-retried delivery still respects maxAttempts on the next drain.
    await db.update({
      collection: WEBHOOK_DELIVERIES_TABLE,
      id: String(row.id),
      data: { status: 'pending', nextAttemptAt: new Date().toISOString(), deliveredAt: null },
    })
    const saved = await db.findByID({ collection: WEBHOOK_DELIVERIES_TABLE, id: String(row.id) })
    return rowToDelivery(saved ?? row)
  }

  async function unpublish<T extends Doc = Doc>(opts: PublishOptions): Promise<T | null> {
    const collection = collectionOrThrow(opts.collection)
    if (!draftsOn(collection))
      throw new BadRequestError(`Collection "${opts.collection}" does not have drafts enabled.`)
    return update<T>(
      {
        collection: opts.collection,
        id: opts.id,
        data: { _status: 'draft' } as Row,
        req: opts.req,
        overrideAccess: opts.overrideAccess,
        depth: opts.depth,
        ...(opts.expectedUpdatedAt != null ? { expectedUpdatedAt: opts.expectedUpdatedAt } : {}),
      },
      'unpublish',
    )
  }

  async function create<T extends Doc = Doc>(opts: CreateOptions): Promise<T> {
    const collection = collectionOrThrow(opts.collection)
    const req = buildReq(opts.req)
    const override = opts.overrideAccess ?? false

    if (!override) {
      const access = await evalAccess(collection.access?.create, { req, data: opts.data })
      if (!isAllowed(access)) throw new ForbiddenError()
    }

    const incoming: Row = { ...opts.data }
    if (!override) await applyFieldAccess(collection.fields, incoming, 'create', req)
    // Multi-tenancy: auto-stamp the owning tenant from the trusted principal, overriding any
    // client-supplied value (anti-spoof). Rejects a tenant-less create under requireTenant.
    if (!override) stampTenantOnCreate(collection, incoming, req)
    let data = applyDefaults(collection.fields, incoming)
    data = await prepareAuthInput(collection, data, 'create', override)
    // Email verification: seed a hashed, expiring token for a fresh signup. Trusted
    // creates (e.g. first-admin setup) pass `email_verified: true` and skip this.
    const pendingVerification = maybeStartVerification(collection, data)
    data = await runHooks(collection.hooks?.beforeChange, { req, operation: 'create', data }, 'data')
    // Stored computed fields are derived from the post-hook document and overwrite
    // any client value, so they persist (and stay sortable/filterable).
    await applyStoredComputed(collection.fields, data, req)

    const errors = await validateFields(collection.fields, data, { req, operation: 'create' })
    if (errors.length) throw new ValidationError(errors)

    const localeWritten = writeLocale(req)
    const row = serializeDoc(collection.fields, data, {
      locale: localeWritten,
      segment: writeSegment(req),
      ...(fieldCipher ? { cipher: fieldCipher } : {}),
    })
    // Strict: a newly-written locale must satisfy required localized fields for itself.
    assertLocaleRequired(collection, row, [localeWritten])
    row.id = randomUUID()
    let bornPublished = false
    let evalFindings: import('./types').EvalFinding[] = []
    if (draftsOn(collection)) {
      row._status = statusFromData(opts.data as Row, 'draft')
      // Born-published: a new doc whose status is 'published' is a publish transition.
      if (row._status === 'published') {
        bornPublished = true
        if (!override) {
          await assertCanPublish(collection, req, undefined, opts.data as Row, row)
          // Strict publish gate also applies to a born-published create.
          assertDefaultLocaleComplete(collection, row)
        }
        // Content CI gates a born-published create exactly like an update→publish, and
        // runs REGARDLESS of `override`: evals are server-defined config (not user input),
        // so a scheduled / system / overrideAccess publish must not bypass a blocking
        // eval. A blocking finding throws ValidationError here, BEFORE the DB write +
        // signing — so a doc that fails content CI never goes live and never gets signed.
        evalFindings = (await runPrePublishEvals(collection, data, req)).findings
      }
      // Agent draft-only brake, scheduled-publish variant: a non-null `_scheduled_at` on
      // create schedules a publish processScheduledPublishes() runs under override — a
      // publish by proxy. An agent can never schedule one (mirrors the update() guard).
      const sched = (opts.data as Row)._scheduled_at
      if (!override && sched != null && req.user?.principalType === 'agent') throw new ForbiddenError()
    }

    const created = await db.create({ collection: collection.slug, data: row })
    const nonOkFindings = evalFindings.filter((f) => !f.ok)
    await recordAudit({
      action: 'create',
      collection: collection.slug,
      documentId: String(created.id),
      req,
      overrideAccess: override,
      fields: auditedFields(opts.data as Row),
      ...(nonOkFindings.length > 0 ? { meta: { evalFindings: nonOkFindings } } : {}),
    })
    let doc = rowToDoc(collection, created, req)
    const approver: PrincipalRef | null = bornPublished ? principalRefOf(req) : null
    let publishedVersionId: string | null = null
    if (versionsOf(collection).enabled) {
      const status = draftsOn(collection) ? statusFromData(created as Row, 'draft') : 'published'
      publishedVersionId = await snapshotVersion(
        collection,
        rowToDoc(collection, created, req),
        status,
        req,
        false,
        approver,
      )
    }
    // Content credential for a born-published create.
    if (bornPublished) {
      await signContentCredential(collection, created, req, approver, publishedVersionId)
    }
    doc = (await runHooks(collection.hooks?.afterChange, { req, operation: 'create', doc }, 'doc')) as Doc
    doc = (await runHooks(collection.hooks?.afterRead, { req, operation: 'read', doc }, 'doc')) as Doc
    doc = await populate(collection, doc, opts.depth ?? 0, req)
    // Strip read-restricted fields BEFORE computing, so a virtual field's `compute`
    // cannot observe (and thus cannot leak) a sibling the caller may not read; then
    // strip again to apply any access rule on the virtual fields themselves.
    if (!override) await applyReadFieldAccess(collection.fields, doc, req)
    await applyComputed(collection.fields, doc, req)
    if (!override) await applyReadFieldAccess(collection.fields, doc, req)
    if (pendingVerification) await sendVerificationEmail(collection, doc, pendingVerification)
    return doc as T
  }

  async function find<T extends Doc = Doc>(opts: FindOptions): Promise<PaginatedResult<T>> {
    const collection = collectionOrThrow(opts.collection)
    const req = buildReq(opts.req)
    const override = opts.overrideAccess ?? false

    // Time-machine: every document's as-of state. Delegated to a dedicated path so the live
    // read below stays untouched when `asOf` is omitted.
    if (opts.asOf !== undefined) {
      assertVersioned(collection)
      return findAsOf<T>(collection, opts, req, override)
    }

    assertWhereFields(collection, opts.where)
    let where = opts.where
    if (!override) {
      const access = await evalAccess(collection.access?.read, { req })
      if (!isAllowed(access)) throw new ForbiddenError()
      where = mergeWhere(where, asWhere(access))
    }
    // Published-only view unless drafts are explicitly requested.
    if (draftsOn(collection) && !(opts.draft ?? false)) {
      where = mergeWhere(where, { _status: { equals: 'published' } })
    }

    const timestamps = collection.timestamps ?? true
    // Caller sort wins; then the collection's configured default; then newest-first.
    let sort: SortSpec[] = parseSort(opts.sort)
    if (sort.length === 0) sort = parseSort(collection.admin?.defaultSort)
    if (sort.length === 0) {
      sort.push(timestamps ? { field: 'createdAt', direction: 'desc' } : { field: 'id', direction: 'asc' })
    }

    const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
    const page = Math.max(opts.page ?? 1, 1)

    const result = await db.find({ collection: collection.slug, where, sort, limit, page })
    const docs: Doc[] = []
    for (const row of result.docs) {
      let doc = rowToDoc(collection, row, req)
      doc = (await runHooks(collection.hooks?.afterRead, { req, operation: 'read', doc }, 'doc')) as Doc
      docs.push(doc)
    }
    // Populate the whole page in one batched pass (O(collections×depth) reads), then
    // run the read tail per doc. Each doc is independent, so doing populate-all-then-
    // tail-all is observably identical to the old per-doc populate→tail loop.
    await populateMany(collection, docs, opts.depth ?? 0, req)
    for (const doc of docs) await applyReadTail(collection, doc, req, override)
    return { ...result, docs: docs as T[] }
  }

  async function findByID<T extends Doc = Doc>(opts: FindByIDOptions): Promise<T | null> {
    const collection = collectionOrThrow(opts.collection)
    const req = buildReq(opts.req)
    const override = opts.overrideAccess ?? false

    // Time-machine: reconstruct from the snapshot `<= asOf` instead of the live row. Requires
    // versions; access read-check + field stripping apply exactly like the live path below.
    if (opts.asOf !== undefined) {
      assertVersioned(collection)
      return findByIDAsOf<T>(collection, opts, req, override)
    }

    const row = await db.findByID({ collection: collection.slug, id: opts.id })
    if (!row) return null
    // Published-only view unless drafts are explicitly requested.
    if (draftsOn(collection) && !(opts.draft ?? false) && row._status !== 'published') return null

    if (!override) {
      const access = await evalAccess(collection.access?.read, { req, id: opts.id })
      if (!isAllowed(access)) throw new ForbiddenError()
      const scope = asWhere(access)
      if (scope && !matchesWhere(row, scope)) throw new ForbiddenError()
    }

    let doc = rowToDoc(collection, row, req)
    doc = (await runHooks(collection.hooks?.afterRead, { req, operation: 'read', doc }, 'doc')) as Doc
    doc = await populate(collection, doc, opts.depth ?? 0, req)
    // Strip read-restricted fields BEFORE computing, so a virtual field's `compute`
    // cannot observe (and thus cannot leak) a sibling the caller may not read; then
    // strip again to apply any access rule on the virtual fields themselves.
    await applyReadTail(collection, doc, req, override)
    return doc as T
  }

  async function update<T extends Doc = Doc>(opts: UpdateOptions, auditAs?: AuditAction): Promise<T | null> {
    const collection = collectionOrThrow(opts.collection)
    const req = buildReq(opts.req)
    const override = opts.overrideAccess ?? false

    const existing = await db.findByID({ collection: collection.slug, id: opts.id })
    if (!existing) throw new NotFoundError()

    if (!override) {
      const access = await evalAccess(collection.access?.update, { req, id: opts.id, data: opts.data })
      if (!isAllowed(access)) throw new ForbiddenError()
      const scope = asWhere(access)
      if (scope && !matchesWhere(existing, scope)) throw new ForbiddenError()
    }

    // Optimistic concurrency: when the caller passes the `updatedAt` it last read, reject
    // the write if the server's row has moved on since (another editor/agent got there
    // first) — never write on conflict. Placed AFTER the access check so it can't be used
    // to probe documents the caller can't update. Opt-in: omitting the token keeps the
    // historical last-write-wins behaviour. The thrown ConflictError carries the current
    // doc + updatedAt so a client can diff/merge and retry with the fresh token.
    if (opts.expectedUpdatedAt != null && String(existing.updatedAt) !== String(opts.expectedUpdatedAt)) {
      const current = rowToDoc(collection, existing, req)
      // Strip fields the caller may not READ before returning the current doc in the
      // error — the conflict payload must never leak a value the normal read path hides.
      if (!override) await applyReadFieldAccess(collection.fields, current, req, opts.id)
      // The incoming fields whose CURRENT (readable) server value differs from what the
      // client is sending — the concrete cells that need a merge decision (system keys
      // and read-denied fields, now stripped from `current`, excluded). A read-denied field
      // is no longer in `current`, so it must NOT surface as a conflicting field either —
      // even its NAME (and the inferred "it differs") is a leak the read path would hide.
      const readDenied = new Set<string>()
      if (!override) {
        for (const field of effectiveFields(collection.fields)) {
          const rule = field.access?.read
          if (!rule) continue
          const decision = await evalAccess(rule, { req, id: opts.id, data: current })
          if (!isAllowed(decision)) readDenied.add(field.name)
        }
      }
      const attemptedFields = Object.keys(opts.data)
        .filter((k) => !AUDIT_FIELD_SKIP.has(k) && !readDenied.has(k))
        .filter((k) => JSON.stringify((current as Row)[k]) !== JSON.stringify((opts.data as Row)[k]))
      throw new ConflictError('The document was modified since you last read it.', {
        reason: 'stale_update',
        currentUpdatedAt: existing.updatedAt != null ? String(existing.updatedAt) : null,
        expectedUpdatedAt: String(opts.expectedUpdatedAt),
        current,
        attemptedFields,
      })
    }

    const filtered: Row = { ...opts.data }
    if (!override) await applyFieldAccess(collection.fields, filtered, 'update', req, opts.id)
    // Multi-tenancy: the tenant field is server-managed — a client can never move a doc to
    // another tenant. Strip any incoming value so the stored tenant is preserved.
    if (!override) stripTenantOnUpdate(collection, filtered)
    const input = await prepareAuthInput(collection, filtered, 'update', override)
    // A password change invalidates existing sessions (bump the session epoch).
    if (collection.auth && typeof input.hash === 'string') {
      input.token_version = tokenVersionOf(existing) + 1
    }
    const existingDoc = rowToDoc(collection, existing, req)
    let merged: Row = { ...existingDoc, ...input }
    merged = await runHooks(
      collection.hooks?.beforeChange,
      { req, operation: 'update', data: merged, originalDoc: existingDoc },
      'data',
    )

    // Stored computed fields are derived from the post-hook document and overwrite
    // any client value, so they persist (and stay sortable/filterable) on update.
    await applyStoredComputed(collection.fields, merged, req)

    const errors = await validateFields(collection.fields, merged, { req, operation: 'update' })
    if (errors.length) throw new ValidationError(errors)

    // Serialize the post-hook, post-compute document — NOT the raw input — so any
    // field a beforeChange hook (or a stored compute) added/changed is persisted.
    const localeWritten = writeLocale(req)
    const row = serializeDoc(collection.fields, merged, {
      locale: localeWritten,
      segment: writeSegment(req),
      existingRow: existing,
      ...(fieldCipher ? { cipher: fieldCipher } : {}),
    })
    // Strict: only the locale being written must satisfy its required localized fields;
    // locales already stored are never retroactively failed.
    assertLocaleRequired(collection, row, [localeWritten])
    // True when this write transitions the doc into the published state — the single
    // gate where evals run and a content credential is signed. Blocking evals run on
    // EVERY publish transition (system/override included); only the access gates
    // (assertCanPublish / default-locale completeness) are skipped under override.
    let isPublishTransition = false
    let evalFindings: import('./types').EvalFinding[] = []
    if (draftsOn(collection)) {
      row._status = statusFromData(opts.data as Row, (existing._status as string) ?? 'draft')
      // Publish transition: becoming published when not already. Covers publish()→update(),
      // a raw PATCH `{ _status: 'published' }`, and restoreVersion of a published snapshot.
      if (row._status === 'published' && existing._status !== 'published') {
        isPublishTransition = true
        if (!override) {
          await assertCanPublish(collection, req, opts.id, opts.data as Row, existing)
          // Strict publish gate: the DEFAULT locale must be complete (no required localized
          // field missing) — you can't publish a doc whose primary language is unfinished.
          assertDefaultLocaleComplete(collection, row)
        }
        // Content CI: run pre-publish evals on the to-be-published doc. A blocking
        // `error` finding throws ValidationError here, BEFORE the write — so a doc that
        // fails content CI stays a draft. Runs REGARDLESS of `override`: evals are
        // server-defined config (not user input), so a scheduled publish (via
        // processScheduledPublishes → overrideAccess:true) or any direct overrideAccess
        // publish must NOT bypass a blocking eval. The throw lands before the DB write +
        // signing, so an eval-failing doc never goes live and never gets a credential.
        evalFindings = (await runPrePublishEvals(collection, merged, req)).findings
      }
      // Scheduled-publish time is a system column; let publish()/processScheduled set it.
      if (Object.prototype.hasOwnProperty.call(opts.data, '_scheduled_at')) {
        const at = (opts.data as Row)._scheduled_at
        // Agent draft-only brake, scheduled-publish variant: a non-null `_scheduled_at`
        // schedules a publish that processScheduledPublishes() later runs under override
        // — a publish by proxy. Treat it like `_status:'published'`: an agent can never
        // schedule one. Clearing it to null is harmless and stays allowed.
        if (!override && at != null && req.user?.principalType === 'agent') throw new ForbiddenError()
        row._scheduled_at = at == null ? null : new Date(String(at)).toISOString()
      }
      // Content-lifecycle archive marker. `_archived_at` is a SERVER-MANAGED system column:
      // it is written ONLY by the trusted (overrideAccess) expiry drain, never by a client.
      // A non-override caller can never set or clear it — any incoming value is ignored, so
      // the column is field-locked (a client can't fake "archived", nor un-archive a doc).
      if (override && Object.prototype.hasOwnProperty.call(opts.data, '_archived_at')) {
        const archivedAt = (opts.data as Row)._archived_at
        row._archived_at = archivedAt == null ? null : new Date(String(archivedAt)).toISOString()
      }
    }
    const updated = await db.update({ collection: collection.slug, id: opts.id, data: row })
    if (!updated) return null

    // Record AFTER the write succeeds. publish()/unpublish() route through here and
    // pass their own action so the log reads 'publish'/'unpublish', not 'update'.
    // Non-blocking eval findings (warn/info, or errors from non-blocking rules) ride
    // along in the audit meta so the content-CI result is observable.
    const nonOkFindings = evalFindings.filter((f) => !f.ok)
    await recordAudit({
      action: auditAs ?? 'update',
      collection: collection.slug,
      documentId: opts.id,
      req,
      overrideAccess: override,
      fields: auditAs ? null : auditedFields(opts.data as Row),
      ...(nonOkFindings.length > 0 ? { meta: { evalFindings: nonOkFindings } } : {}),
    })

    let doc = rowToDoc(collection, updated, req)
    // The approver of a publish is the publishing principal (for a review-approval, the
    // reviewer is threaded in as that principal). Recorded on the published snapshot and
    // in the credential manifest. Null for non-publish snapshots.
    const approver: PrincipalRef | null = isPublishTransition ? principalRefOf(req) : null
    let publishedVersionId: string | null = null
    if (versionsOf(collection).enabled) {
      const status = draftsOn(collection) ? statusFromData(updated as Row, 'draft') : 'published'
      publishedVersionId = await snapshotVersion(
        collection,
        rowToDoc(collection, updated, req),
        status,
        req,
        opts.autosave === true,
        approver,
      )
    }
    // Content credential: sign a tamper-evident manifest of the published doc. Only on a
    // real publish transition, and only when signing is enabled (else a no-op). Hashes the
    // raw stored row so verify can recompute the same surface.
    if (isPublishTransition) {
      await signContentCredential(collection, updated, req, approver, publishedVersionId)
    }
    doc = (await runHooks(collection.hooks?.afterChange, { req, operation: 'update', doc }, 'doc')) as Doc
    doc = (await runHooks(collection.hooks?.afterRead, { req, operation: 'read', doc }, 'doc')) as Doc
    doc = await populate(collection, doc, opts.depth ?? 0, req)
    // Strip read-restricted fields BEFORE computing, so a virtual field's `compute`
    // cannot observe (and thus cannot leak) a sibling the caller may not read; then
    // strip again to apply any access rule on the virtual fields themselves.
    if (!override) await applyReadFieldAccess(collection.fields, doc, req)
    await applyComputed(collection.fields, doc, req)
    if (!override) await applyReadFieldAccess(collection.fields, doc, req)
    return doc as T
  }

  // -------------------------------------------------------------------------
  // Localization: bulk multi-locale writes + translation status
  // -------------------------------------------------------------------------

  // Keys that must never be treated as a locale code (prototype pollution guard).
  const FORBIDDEN_LOCALE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

  /**
   * Write several locales of one document in a single call. Each locale's partial flows
   * through the NORMAL `update()` pipeline (access, field-access, hooks, validation,
   * strict per-locale required checks) under a req pinned to that locale — so nothing is
   * bypassed and `serializeDoc`'s per-locale merge preserves every untouched locale.
   * Untrusted: keys are validated against the configured locale set and prototype-
   * pollution keys are rejected before any write.
   */
  async function updateLocales<T extends Doc = Doc>(opts: UpdateLocalesOptions): Promise<T | null> {
    const collection = collectionOrThrow(opts.collection)
    if (loc === false) throw new BadRequestError('Localization is not enabled (set `config.localization`).')
    const map = opts.locales
    if (!map || typeof map !== 'object' || Array.isArray(map)) {
      throw new BadRequestError('`locales` must be an object keyed by locale code.')
    }
    const allowed = new Set(loc.locales)
    // Validate EVERY key up front so a bad code can't partially apply (some locales
    // written, then a reject) — fail before the first write.
    const codes = Object.keys(map)
    if (codes.length === 0) throw new BadRequestError('`locales` must name at least one locale.')
    for (const code of codes) {
      if (FORBIDDEN_LOCALE_KEYS.has(code)) throw new BadRequestError(`Illegal locale key "${code}".`)
      if (!allowed.has(code)) {
        throw new BadRequestError(`Unknown locale "${code}". Configured: ${loc.locales.join(', ')}.`)
      }
    }

    // Apply each locale via the access-checked update path. Sequential (not parallel) so
    // each write sees the prior write's merged per-locale maps — keeping the storage row
    // the single source of truth and avoiding lost updates. Any rejection (access /
    // validation / strict) propagates and aborts the remaining locales.
    let last: T | null = null
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i]!
      const partial = map[code]
      if (!partial || typeof partial !== 'object' || Array.isArray(partial)) {
        throw new BadRequestError(`Locale "${code}" partial must be an object.`)
      }
      // Optimistic concurrency is checked ONLY on the first locale write: the token is the
      // `updatedAt` the client read before this whole call, and each locale write advances
      // `updatedAt`, so re-asserting it on later locales would self-conflict. The first
      // write detecting a stale token aborts before any locale is persisted.
      last = await update<T>({
        collection: opts.collection,
        id: opts.id,
        data: partial,
        req: { ...opts.req, locale: code },
        overrideAccess: opts.overrideAccess,
        depth: opts.depth,
        ...(i === 0 && opts.expectedUpdatedAt != null ? { expectedUpdatedAt: opts.expectedUpdatedAt } : {}),
      })
    }
    return last
  }

  /** Required localized field names on a collection (strict and non-strict alike). */
  function requiredLocalizedFields(collection: CollectionConfig): string[] {
    return storageFields(collection.fields)
      .filter((f) => f.localized && f.required)
      .map((f) => f.name)
  }

  /** All localized field names on a collection. */
  function localizedFields(collection: CollectionConfig): string[] {
    return storageFields(collection.fields)
      .filter((f) => f.localized)
      .map((f) => f.name)
  }

  /** True when a stored per-locale map holds a non-empty value for `locale`. */
  function localeHasValue(raw: unknown, locale: string): boolean {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
    const value = (raw as Record<string, unknown>)[locale]
    return value !== undefined && value !== null && value !== ''
  }

  /** Compute the per-locale completeness map for a single STORAGE row. */
  function statusForRow(collection: CollectionConfig, row: Row): import('./types').TranslationStatus {
    if (loc === false) return {}
    const required = requiredLocalizedFields(collection)
    const localized = localizedFields(collection)
    const status: import('./types').TranslationStatus = {}
    for (const locale of loc.locales) {
      const missingRequired = required.filter((name) => !localeHasValue(row[name], locale))
      const filled = localized.filter((name) => localeHasValue(row[name], locale)).length
      status[locale] = {
        complete: missingRequired.length === 0,
        missingRequired,
        filled,
        totalLocalized: localized.length,
      }
    }
    return status
  }

  /**
   * Per-locale translation completeness for one document. Access-checked through the
   * read path: a caller who can't read the doc gets a Forbidden/Not-found, never status.
   * Returns an empty object when localization is off or the collection has no localized
   * fields. Reads the RAW per-locale maps via a `locale:'all'` read so every locale is
   * inspected regardless of the request's active locale.
   */
  async function translationStatus(opts: TranslationStatusOptions): Promise<import('./types').TranslationStatus> {
    const collection = collectionOrThrow(opts.collection)
    if (loc === false || localizedFields(collection).length === 0) return {}
    const req = buildReq(opts.req)
    const override = opts.overrideAccess ?? false
    const row = await db.findByID({ collection: collection.slug, id: opts.id })
    if (!row) throw new NotFoundError()
    // Published-only unless drafts requested — parity with findByID.
    if (draftsOn(collection) && !(opts.draft ?? false) && row._status !== 'published') throw new NotFoundError()
    if (!override) {
      const access = await evalAccess(collection.access?.read, { req, id: opts.id })
      if (!isAllowed(access)) throw new ForbiddenError()
      const scope = asWhere(access)
      if (scope && !matchesWhere(row, scope)) throw new ForbiddenError()
    }
    return statusForRow(collection, row)
  }

  /**
   * Translation dashboard: per-locale completeness across a collection's documents,
   * scoped by the caller's read access (no override widening). Empty when localization
   * is off or the collection has no localized fields. Computes status from the raw
   * stored per-locale maps, so it never depends on the active request locale.
   */
  async function translationStatusList(
    opts: TranslationStatusListOptions,
  ): Promise<{ docs: import('./types').TranslationStatusItem[]; count: number }> {
    const collection = collectionOrThrow(opts.collection)
    if (loc === false || localizedFields(collection).length === 0) return { docs: [], count: 0 }
    const req = buildReq(opts.req)
    const override = opts.overrideAccess ?? false

    assertWhereFields(collection, opts.where)
    let where = opts.where
    if (!override) {
      const access = await evalAccess(collection.access?.read, { req })
      if (!isAllowed(access)) throw new ForbiddenError()
      where = mergeWhere(where, asWhere(access))
    }
    // A dashboard spans drafts + published, so include drafts when the collection has them.
    const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
    const page = Math.max(opts.page ?? 1, 1)
    const result = await db.find({ collection: collection.slug, where, sort: undefined, limit, page })
    const docs: import('./types').TranslationStatusItem[] = []
    for (const row of result.docs) {
      const status = statusForRow(collection, row)
      const completeLocales = loc.locales.filter((l) => status[l]?.complete)
      const incompleteLocales = loc.locales.filter((l) => status[l] && !status[l]!.complete)
      docs.push({ id: String(row.id), status, completeLocales, incompleteLocales })
    }
    return { docs, count: result.totalDocs }
  }

  // -------------------------------------------------------------------------
  // AI-assisted translation (pluggable provider)
  //
  // Auto-fill untranslated locales of a document's LOCALIZED text fields. The source
  // values are read through the NORMAL access-checked read (so a read-denied field is
  // never sent to the provider), the provider maps them to the target locale, and the
  // results are written back via `updateLocales` — i.e. the NORMAL access-checked update,
  // so field/doc access, strict per-locale required validation, and the agent draft-only
  // brake all apply and a translation NEVER auto-publishes. A provider failure throws a
  // GENERIC error (the closure may hold an API key; its message/inputs/outputs are never
  // logged or surfaced) and writes nothing — the doc is left unchanged on any failure.
  // -------------------------------------------------------------------------

  /** Resolve + validate a single locale code against the configured set, guarding against
   *  prototype-pollution keys. Throws a 400 for an unknown/illegal code. */
  function assertLocale(code: unknown, label: string): string {
    if (typeof code !== 'string' || code.length === 0) throw new BadRequestError(`\`${label}\` is required.`)
    if (FORBIDDEN_LOCALE_KEYS.has(code)) throw new BadRequestError(`Illegal locale key "${code}".`)
    if (loc === false || !loc.locales.includes(code)) {
      const configured = loc === false ? '(none)' : loc.locales.join(', ')
      throw new BadRequestError(`Unknown locale "${code}". Configured: ${configured}.`)
    }
    return code
  }

  /** Run the pluggable translate provider, converting ANY thrown error into a generic one.
   *  The provider closure may hold an API key and its message could carry it (or the source
   *  text) — so the original error is never propagated to the request boundary (which logs
   *  it). Also validates the provider returned one translation per input string. */
  async function runTranslate(texts: string[], from: string, to: string): Promise<string[]> {
    const provider = config.translation
    if (!provider) throw new BadRequestError('Translation is not enabled (set `config.translation`).')
    // Bound the input handed to the (billed, external) provider so a pathological
    // field value can't blow up cost/latency. The cap is generous for real content.
    if (texts.some((t) => t.length > MAX_TRANSLATE_CHARS)) {
      throw new BadRequestError(`A field exceeds the ${MAX_TRANSLATE_CHARS}-character translation limit.`)
    }
    let out: string[]
    try {
      out = await provider.translate({ texts, from, to })
    } catch {
      throw new Error('Translation provider failed.')
    }
    // A well-behaved provider returns exactly N strings. Reject anything else rather
    // than stringifying garbage (e.g. a number/null) into stored content.
    if (!Array.isArray(out) || out.length !== texts.length || out.some((s) => typeof s !== 'string')) {
      throw new Error('Translation provider returned an unexpected result.')
    }
    return out
  }

  /** Core translate: returns the resulting doc plus whether a write actually happened.
   *  `wrote` is false when there was no source text to translate (or every target was
   *  already filled and `overwrite` is off) — no provider call, no write. */
  async function doTranslate<T extends Doc = Doc>(
    opts: TranslateDocumentOptions,
  ): Promise<{ doc: T | null; wrote: boolean }> {
    const collection = collectionOrThrow(opts.collection)
    if (loc === false) throw new BadRequestError('Localization is not enabled (set `config.localization`).')
    if (!config.translation) throw new BadRequestError('Translation is not enabled (set `config.translation`).')
    const from = assertLocale(opts.from, 'from')
    const to = assertLocale(opts.to, 'to')
    if (from === to) throw new BadRequestError('`from` and `to` must be different locales.')

    const localized = new Set(localizedFields(collection))
    if (localized.size === 0) return { doc: null, wrote: false }
    // Restrict to the requested fields when given; an unknown/non-localized name is simply
    // ignored (translation only ever touches real localized fields).
    const targetFields = opts.fields ? opts.fields.filter((f) => localized.has(f)) : [...localized]

    // Read EVERY locale through the access-checked read path. `locale:'all'` returns the
    // full per-locale maps; read-field-access has already stripped any field the caller may
    // not read, so a read-denied field is never present here (and thus never translated /
    // sent to the provider). Drafts included so an editor can translate work-in-progress.
    const all = await findByID<Doc>({
      collection: opts.collection,
      id: opts.id,
      req: { ...opts.req, locale: 'all' },
      overrideAccess: opts.overrideAccess,
      draft: true,
    })
    if (!all) throw new NotFoundError()

    // Collect the source strings to translate: a field is eligible when its `from` value is
    // a non-empty string AND (overwrite OR the `to` value is missing/empty). Non-text and
    // empty source values are skipped. Order is fixed so provider outputs map back 1:1.
    const names: string[] = []
    const sources: string[] = []
    for (const name of targetFields) {
      const map = all[name]
      if (!map || typeof map !== 'object' || Array.isArray(map)) continue
      const src = (map as Record<string, unknown>)[from]
      if (typeof src !== 'string' || src.length === 0) continue
      const dst = (map as Record<string, unknown>)[to]
      const hasTarget = typeof dst === 'string' && dst.length > 0
      if (hasTarget && !opts.overwrite) continue
      names.push(name)
      sources.push(src)
    }
    // Nothing to translate → no provider call, no write. Return the current doc unchanged.
    if (names.length === 0) {
      const doc = await findByID<T>({
        collection: opts.collection,
        id: opts.id,
        req: opts.req,
        overrideAccess: opts.overrideAccess,
        depth: opts.depth,
        draft: true,
      })
      return { doc: doc ?? null, wrote: false }
    }

    // Provider call BEFORE any write — if it throws (wrapped generic), nothing is persisted.
    const translated = await runTranslate(sources, from, to)

    // Write the target locale via the NORMAL access-checked update (merge — other locales
    // untouched). Strict per-locale required validation + the agent draft-only brake apply.
    const partial: Row = {}
    for (let i = 0; i < names.length; i++) partial[names[i]!] = translated[i]
    const doc = await updateLocales<T>({
      collection: opts.collection,
      id: opts.id,
      locales: { [to]: partial },
      req: opts.req,
      overrideAccess: opts.overrideAccess,
      depth: opts.depth,
    })
    return { doc, wrote: true }
  }

  /**
   * Translate one document's localized text fields from `from` into `to` and write the
   * results through the normal access-checked update. Returns the updated doc, or — when
   * there is nothing to translate (no source text, or every target already filled and
   * `overwrite` is off) — the current doc unchanged (no write, no provider call).
   */
  async function translateDocument<T extends Doc = Doc>(opts: TranslateDocumentOptions): Promise<T | null> {
    return (await doTranslate<T>(opts)).doc
  }

  /**
   * Batch-fill a collection's missing `to`-locale translations from a source locale.
   * Reuses `translationStatusList` (access-scoped — only docs the caller can READ are
   * considered) to find documents whose `to` locale is incomplete, then `translateDocument`
   * each (which enforces WRITE access). Bounded by `limit`. Reports translated vs skipped.
   */
  async function translateMissing(opts: TranslateMissingOptions): Promise<import('./types').TranslateMissingResult> {
    const collection = collectionOrThrow(opts.collection)
    if (loc === false) throw new BadRequestError('Localization is not enabled (set `config.localization`).')
    if (!config.translation) throw new BadRequestError('Translation is not enabled (set `config.translation`).')
    const to = assertLocale(opts.to, 'to')
    const from = assertLocale(opts.from ?? loc.defaultLocale, 'from')
    if (from === to) throw new BadRequestError('`from` and `to` must be different locales.')

    const limit = Math.min(Math.max(opts.limit ?? 50, 1), MAX_LIMIT)
    const list = await translationStatusList({
      collection: opts.collection,
      limit,
      req: opts.req,
      overrideAccess: opts.overrideAccess,
    })

    const translated: string[] = []
    const skipped: string[] = []
    for (const item of list.docs) {
      // Skip docs whose `to` locale is already complete (every required localized field set).
      if (item.status[to]?.complete && !item.incompleteLocales.includes(to)) {
        skipped.push(item.id)
        continue
      }
      try {
        const { wrote } = await doTranslate({
          collection: opts.collection,
          id: item.id,
          from,
          to,
          ...(opts.fields ? { fields: opts.fields } : {}),
          req: opts.req,
          overrideAccess: opts.overrideAccess,
        })
        // `doTranslate` reports whether a write actually happened — a doc with no source
        // text to translate writes nothing and is counted as skipped, not translated.
        if (wrote) translated.push(item.id)
        else skipped.push(item.id)
      } catch (err) {
        // A per-doc access/validation failure (e.g. the caller can read but not WRITE this
        // doc, or strict required validation rejects it) skips that doc without aborting the
        // batch. A provider failure has already been wrapped generic by `runTranslate`.
        if (isKernelError(err)) skipped.push(item.id)
        else throw err
      }
    }
    return { translated, skipped }
  }

  // -------------------------------------------------------------------------
  // Referential integrity (onDelete)
  //
  // No adapter enforces real FK constraints — relationship ids live in TEXT/JSON
  // columns — so deleting a referenced doc silently dangles every referrer. A
  // relationship field may opt into a cleanup action via `onDelete`. The action is
  // declared on the REFERRING field and governs what happens to its document when
  // the target is removed. Unset = legacy behaviour (leave dangling).
  // -------------------------------------------------------------------------

  /** A referring field that opted into an onDelete action for `targetSlug`. */
  interface ReferrerRule {
    collection: CollectionConfig
    field: { name: string; hasMany: boolean; polymorphic: boolean; onDelete: 'setNull' | 'cascade' | 'restrict' }
  }

  /** Every relationship/upload field across the config that points at `targetSlug`
   *  and declares an `onDelete` action. Drives cleanup when a target is deleted. */
  function referrerRules(targetSlug: string): ReferrerRule[] {
    const rules: ReferrerRule[] = []
    for (const coll of config.collections) {
      for (const rel of relationshipFields(coll.fields)) {
        if (!rel.onDelete) continue
        const targets = Array.isArray(rel.relationTo) ? rel.relationTo : [rel.relationTo]
        if (!targets.includes(targetSlug)) continue
        rules.push({
          collection: coll,
          field: { name: rel.name, hasMany: rel.hasMany, polymorphic: rel.polymorphic, onDelete: rel.onDelete },
        })
      }
    }
    return rules
  }

  /** True when a stored relationship value (raw row column) references `targetSlug`/`id`.
   *  Handles single + hasMany, monomorphic ids and polymorphic `{ relationTo, value }`. */
  function refMatchesOne(ref: unknown, field: ReferrerRule['field'], targetSlug: string, id: string): boolean {
    if (ref == null) return false
    if (field.polymorphic) {
      if (typeof ref !== 'object') return false
      const r = ref as { relationTo?: unknown; value?: unknown }
      return r.relationTo === targetSlug && String(r.value) === id
    }
    return String(ref) === id
  }

  function refMatches(value: unknown, field: ReferrerRule['field'], targetSlug: string, id: string): boolean {
    if (field.hasMany) return Array.isArray(value) && value.some((ref) => refMatchesOne(ref, field, targetSlug, id))
    return refMatchesOne(value, field, targetSlug, id)
  }

  /** A new field value with every reference to `targetSlug`/`id` removed: null for a
   *  single ref, the id pulled from a hasMany list. */
  function pullRef(value: unknown, field: ReferrerRule['field'], targetSlug: string, id: string): unknown {
    if (field.hasMany) {
      if (!Array.isArray(value)) return value
      return value.filter((ref) => !refMatchesOne(ref, field, targetSlug, id))
    }
    return null
  }

  /**
   * Enforce onDelete actions before a target document is removed. Scans the config
   * for referring fields, finds the docs holding the reference, and applies their
   * declared action: `restrict` aborts (ConflictError) if any referrer exists;
   * `setNull` clears/pulls the reference via the Local API (hooks + versions fire);
   * `cascade` deletes the referrer, recursing so ITS onDelete rules run too. `visited`
   * tracks `slug:id` to break reference cycles (a self/mutual cascade can't loop).
   *
   * Atomicity caveat: the operations facade closes over a single `db` handle, so a
   * multi-step cascade/setNull is NOT wrapped in `db.transaction` — an error partway
   * through can leave some referrers cleaned and others not. Restrict is checked first
   * (and aborts before any write), so the common guard is safe; a fully-atomic cascade
   * would require threading a tx-bound facade and is left as a follow-up.
   */
  async function applyOnDelete(
    targetSlug: string,
    id: string,
    req: RequestContext,
    visited: Set<string>,
  ): Promise<void> {
    // Resolve every rule's matching referrers up front. Scan rows by raw stored value —
    // works regardless of adapter JSON-query support and across single/hasMany/polymorphic
    // shapes. Capped like other bulk ops.
    const resolved: Array<{ rule: ReferrerRule; matches: Row[] }> = []
    for (const rule of referrerRules(targetSlug)) {
      const rows = await db.find({ collection: rule.collection.slug, where: undefined, limit: MAX_LIMIT, page: 1 })
      const matches = rows.docs.filter((row) => refMatches(row[rule.field.name], rule.field, targetSlug, id))
      if (matches.length) resolved.push({ rule, matches })
    }

    // Restrict is a hard pre-check across ALL rules: abort before any setNull/cascade
    // write runs, so a blocking referrer can never leave a partial cleanup behind.
    for (const { rule, matches } of resolved) {
      if (rule.field.onDelete === 'restrict') {
        throw new ConflictError(
          `Cannot delete "${targetSlug}" ${id}: ${matches.length} document(s) in "${rule.collection.slug}" still reference it.`,
        )
      }
    }

    // Per-principal override for the cascade/setNull writes. For a HUMAN this is
    // config-declared referential integrity they already hold the delete grant for,
    // so the writes run trusted (overrideAccess:true) — unchanged behaviour. For an
    // AGENT, one authorized delete must NOT fan out into referrer docs the agent has
    // no access to: run each referrer write access-checked (overrideAccess:false)
    // under the agent's own req, so a missing grant throws ForbiddenError and aborts
    // the whole delete (fail-closed). The agent's req is reused either way.
    const overrideCascade = req.user?.principalType !== 'agent'
    for (const { rule, matches } of resolved) {
      for (const row of matches) {
        const refId = String(row.id)
        if (rule.field.onDelete === 'cascade') {
          const key = `${rule.collection.slug}:${refId}`
          if (visited.has(key)) continue // cycle guard: already being deleted
          await deleteOne(
            { collection: rule.collection.slug, id: refId, req, overrideAccess: overrideCascade },
            visited,
          )
        } else {
          // setNull: clear the single ref, or pull the id from a hasMany list. Routed
          // through update() so hooks/versions fire and the value is re-validated.
          const next = pullRef(row[rule.field.name], rule.field, targetSlug, id)
          await update({
            collection: rule.collection.slug,
            id: refId,
            data: { [rule.field.name]: next } as Row,
            req,
            overrideAccess: overrideCascade,
          })
        }
      }
    }
  }

  async function deleteOne<T extends Doc = Doc>(opts: DeleteOptions, visited?: Set<string>): Promise<T | null> {
    const collection = collectionOrThrow(opts.collection)
    const req = buildReq(opts.req)
    const override = opts.overrideAccess ?? false

    const existing = await db.findByID({ collection: collection.slug, id: opts.id })
    if (!existing) throw new NotFoundError()

    if (!override) {
      const access = await evalAccess(collection.access?.delete, { req, id: opts.id })
      if (!isAllowed(access)) throw new ForbiddenError()
      const scope = asWhere(access)
      if (scope && !matchesWhere(existing, scope)) throw new ForbiddenError()
    }

    // Referential integrity: settle referrers (restrict/setNull/cascade) BEFORE the
    // row leaves, so `restrict` can still abort and a cascade sees the target intact.
    // `visited` carries the in-flight delete set across a recursive cascade to break
    // reference cycles; seed it with this doc so a back-reference can't loop into it.
    const tracked = visited ?? new Set<string>()
    tracked.add(`${collection.slug}:${opts.id}`)
    await applyOnDelete(collection.slug, opts.id, req, tracked)

    for (const hook of collection.hooks?.beforeDelete ?? []) await hook({ req, id: opts.id })
    const removed = await db.delete({ collection: collection.slug, id: opts.id })
    const doc = removed ? rowToDoc(collection, removed, req) : null
    if (doc && removed) {
      // Sweep the upload binary so bytes never outlive the row (and no signed link survives it).
      await sweepUploadBinary(collection, removed)
      await recordAudit({
        action: 'delete',
        collection: collection.slug,
        documentId: opts.id,
        req,
        overrideAccess: override,
      })
      for (const hook of collection.hooks?.afterDelete ?? []) await hook({ req, id: opts.id, doc })
    }
    return doc as T | null
  }

  /** Resolve the ids matching `where` under the given access scope (capped). */
  async function matchingIds(
    collection: CollectionConfig,
    access: 'update' | 'delete',
    where: Where | undefined,
    req: RequestContext,
    override: boolean,
    limit: number,
  ): Promise<string[]> {
    assertWhereFields(collection, where)
    let scoped = where
    if (!override) {
      const result = await evalAccess(collection.access?.[access], { req })
      if (!isAllowed(result)) throw new ForbiddenError()
      scoped = mergeWhere(where, asWhere(result))
    }
    const rows = await db.find({ collection: collection.slug, where: scoped, limit, page: 1 })
    return rows.docs.map((r) => String(r.id))
  }

  async function updateMany<T extends Doc = Doc>(opts: UpdateManyOptions): Promise<BulkResult<T>> {
    const collection = collectionOrThrow(opts.collection)
    const req = buildReq(opts.req)
    const override = opts.overrideAccess ?? false
    const limit = opts.limit ?? 1000
    const ids = await matchingIds(collection, 'update', opts.where, req, override, limit)
    const docs: T[] = []
    // Each id flows through the full single-doc pipeline (access, hooks, validation, versions).
    for (const id of ids) {
      const doc = await update<T>({
        collection: opts.collection,
        id,
        data: opts.data,
        req: opts.req,
        overrideAccess: override,
        depth: opts.depth,
      })
      if (doc) docs.push(doc)
    }
    return { docs, count: docs.length }
  }

  async function deleteMany<T extends Doc = Doc>(opts: DeleteManyOptions): Promise<BulkResult<T>> {
    const collection = collectionOrThrow(opts.collection)
    const req = buildReq(opts.req)
    const override = opts.overrideAccess ?? false
    const limit = opts.limit ?? 1000
    const ids = await matchingIds(collection, 'delete', opts.where, req, override, limit)
    const docs: T[] = []
    // Share one visited set across the batch so a cascade triggered by an earlier id
    // (which may have already removed a later id in this same list) doesn't re-delete it.
    const visited = new Set<string>()
    for (const id of ids) {
      if (visited.has(`${collection.slug}:${id}`)) continue
      const doc = await deleteOne<T>(
        {
          collection: opts.collection,
          id,
          req: opts.req,
          overrideAccess: override,
        },
        visited,
      )
      if (doc) docs.push(doc)
    }
    return { docs, count: docs.length }
  }

  async function count(opts: CountOptions): Promise<number> {
    const collection = collectionOrThrow(opts.collection)
    const req = buildReq(opts.req)
    assertWhereFields(collection, opts.where)
    let where = opts.where
    if (!(opts.overrideAccess ?? false)) {
      const access = await evalAccess(collection.access?.read, { req })
      if (!isAllowed(access)) throw new ForbiddenError()
      where = mergeWhere(where, asWhere(access))
    }
    return db.count({ collection: collection.slug, where })
  }

  // -------------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------------

  async function login(opts: LoginOptions): Promise<AuthResult> {
    const collection = collectionOrThrow(opts.collection)
    if (!collection.auth) throw new BadRequestError(`Collection "${opts.collection}" is not an auth collection.`)

    const key = loginKey(collection.slug, opts.email)
    assertLoginAllowed(key)

    const result = await db.find({
      collection: collection.slug,
      where: { email: { equals: opts.email } },
      sort: [{ field: 'id', direction: 'asc' }],
      limit: 1,
      page: 1,
    })
    const row = result.docs[0]
    let passwordOk = false
    if (row && typeof row.hash === 'string') {
      passwordOk = await verifyPassword(opts.password, row.hash)
    } else {
      // Burn equivalent work for a non-existent account so response latency can't
      // be used to enumerate valid emails (timing oracle).
      await verifyPassword(opts.password, await dummyHash())
    }
    if (!row || !passwordOk) {
      recordLoginFailure(key)
      await recordAudit({
        action: 'login_failed',
        collection: collection.slug,
        principalId: null,
        principalType: 'user',
        // A failed attempt carries an *attacker-supplied* address, possibly for an
        // account that doesn't exist. Store a non-reversible digest so investigators
        // can still correlate repeated attempts on the same address without the audit
        // log accumulating raw PII for arbitrary email guesses.
        meta: { emailHash: createHash('sha256').update(String(opts.email).toLowerCase()).digest('hex') },
      })
      throw new UnauthorizedError('Invalid email or password.')
    }
    loginFailures.delete(key)
    // Block sign-in until the address is verified, when verification is required.
    if (verifyOptions(collection) && !isVerified(row)) {
      throw new ForbiddenError('Please verify your email address before signing in.')
    }
    // Two-factor: require a valid current code once the user has enabled 2FA.
    if (twoFactorEnabled(collection) && (row.totp_enabled === true || row.totp_enabled === 1)) {
      const secret = typeof row.totp_secret === 'string' ? row.totp_secret : ''
      const step = opts.code && secret ? verifyTotpStep(secret, opts.code) : null
      if (step === null) {
        throw new UnauthorizedError('A valid two-factor code is required.')
      }
      // Replay defence: a code may be used once. Reject any step at or below the
      // last accepted one (RFC 6238 §5.2), and record the step we just consumed.
      const lastStep = typeof row.totp_last_step === 'number' ? row.totp_last_step : Number(row.totp_last_step ?? 0)
      if (Number.isFinite(lastStep) && step <= lastStep) {
        throw new UnauthorizedError('That two-factor code has already been used.')
      }
      await db.update({ collection: collection.slug, id: String(row.id), data: { totp_last_step: step } })
    }
    const user = rowToDoc(collection, row, buildReq()) as AuthUser
    user.collection = collection.slug
    await recordAudit({
      action: 'login',
      collection: collection.slug,
      documentId: String(row.id),
      principalId: String(row.id),
      principalType: 'user',
      meta: { email: opts.email },
    })
    const ttl = authTtl(collection)
    const token = issueToken(user.id, collection.slug, row, ttl)
    return { user, token, exp: Math.floor(Date.now() / 1000) + ttl }
  }

  // Current session epoch for a row (defaults to 0 for legacy rows/tokens).
  const tokenVersionOf = (row: Row): number => {
    const v = Number(row.token_version ?? 0)
    return Number.isFinite(v) ? v : 0
  }
  const issueToken = (sub: string, slug: string, row: Row, ttl: number): string =>
    signToken({ sub, collection: slug, tv: tokenVersionOf(row) }, config.secret, ttl)

  async function authenticate(token: string): Promise<AuthUser | null> {
    const payload = verifyToken(token, config.secret)
    if (!payload) return null
    const collection = config.collectionsBySlug[payload.collection]
    if (!collection?.auth) return null
    const row = await db.findByID({ collection: collection.slug, id: payload.sub })
    if (!row) return null
    // Reject tokens minted before the account's current session epoch (e.g. issued
    // before a password reset / change), so those sessions can't outlive the change.
    if (Number(payload.tv ?? 0) !== tokenVersionOf(row)) return null
    const user = rowToDoc(collection, row, buildReq()) as AuthUser
    user.collection = collection.slug
    return user
  }

  function apiKeyEnabled(collection: CollectionConfig): boolean {
    return typeof collection.auth === 'object' && Boolean(collection.auth.useAPIKey)
  }
  const hashKey = (key: string): string => createHash('sha256').update(key).digest('hex')

  /** Generate (or rotate) a user's API key. The plaintext is returned once and never stored. */
  async function createAPIKey(opts: CreateAPIKeyOptions): Promise<{ key: string }> {
    const collection = collectionOrThrow(opts.collection)
    if (!apiKeyEnabled(collection))
      throw new BadRequestError(`Collection "${opts.collection}" does not have API keys enabled.`)
    const existing = await db.findByID({ collection: collection.slug, id: opts.id })
    if (!existing) throw new NotFoundError()
    const key = `${collection.slug}_${randomBytes(24).toString('base64url')}`
    await db.update({ collection: collection.slug, id: opts.id, data: { api_key: hashKey(key) } })
    return { key }
  }

  /** Resolve a user from a presented API key. Constant work whether or not it matches. */
  async function authenticateAPIKey(collectionSlug: string, key: string): Promise<AuthUser | null> {
    const collection = config.collectionsBySlug[collectionSlug]
    if (!collection?.auth || !apiKeyEnabled(collection)) return null
    const result = await db.find({
      collection: collection.slug,
      where: { api_key: { equals: hashKey(key) } },
      limit: 1,
      page: 1,
    })
    const row = result.docs[0]
    if (!row) return null
    const user = rowToDoc(collection, row, buildReq()) as AuthUser
    user.collection = collection.slug
    return user
  }

  // -------------------------------------------------------------------------
  // Email verification & password reset
  // -------------------------------------------------------------------------

  const nowSec = (): number => Math.floor(Date.now() / 1000)

  function verifyOptions(collection: CollectionConfig): VerifyOptions | null {
    const a = collection.auth
    if (typeof a === 'object' && a.verify) return a.verify === true ? {} : a.verify
    return null
  }

  function forgotOptions(collection: CollectionConfig): ForgotPasswordOptions | null {
    const a = collection.auth
    if (typeof a === 'object' && a.forgotPassword) return a.forgotPassword === true ? {} : a.forgotPassword
    return null
  }

  // SQLite stores booleans as 0/1; accept either truthy representation.
  function isVerified(row: Row): boolean {
    return row.email_verified === true || row.email_verified === 1
  }

  function twoFactorEnabled(collection: CollectionConfig): boolean {
    return typeof collection.auth === 'object' && Boolean(collection.auth.twoFactor)
  }

  /** Generate (or rotate) a user's TOTP secret. Not active until `enableTwoFactor`. */
  async function setupTwoFactor(opts: {
    collection: string
    id: string
  }): Promise<{ secret: string; otpauthURL: string }> {
    const collection = collectionOrThrow(opts.collection)
    if (!twoFactorEnabled(collection))
      throw new BadRequestError(`Collection "${opts.collection}" does not have two-factor enabled.`)
    const row = await db.findByID({ collection: collection.slug, id: opts.id })
    if (!row) throw new NotFoundError()
    const secret = generateTotpSecret()
    await db.update({ collection: collection.slug, id: opts.id, data: { totp_secret: secret, totp_enabled: false } })
    return { secret, otpauthURL: otpauthURL(secret, String(row.email ?? opts.id)) }
  }

  /** Confirm enrolment by verifying a code against the pending secret. */
  async function enableTwoFactor(opts: { collection: string; id: string; code: string }): Promise<{ enabled: true }> {
    const collection = collectionOrThrow(opts.collection)
    if (!twoFactorEnabled(collection))
      throw new BadRequestError(`Collection "${opts.collection}" does not have two-factor enabled.`)
    const row = await db.findByID({ collection: collection.slug, id: opts.id })
    const secret = typeof row?.totp_secret === 'string' ? row.totp_secret : ''
    if (!secret) throw new BadRequestError('Set up two-factor before enabling it.')
    if (verifyTotpStep(secret, opts.code) === null) throw new BadRequestError('That code is invalid or expired.')
    // Replay tracking starts at login (the enrolment code may legitimately be the
    // user's first login code in the same time-step); each login code is single-use.
    await db.update({ collection: collection.slug, id: opts.id, data: { totp_enabled: true } })
    return { enabled: true }
  }

  async function disableTwoFactor(opts: { collection: string; id: string }): Promise<{ enabled: false }> {
    const collection = collectionOrThrow(opts.collection)
    if (!twoFactorEnabled(collection))
      throw new BadRequestError(`Collection "${opts.collection}" does not have two-factor enabled.`)
    await db.update({
      collection: collection.slug,
      id: opts.id,
      data: { totp_secret: null, totp_enabled: false, totp_last_step: null },
    })
    return { enabled: false }
  }

  /** Complete an OAuth sign-in: exchange the code for a profile, find-or-create the
   *  matching user (by email), and issue a session token. */
  async function loginWithOAuth(opts: {
    collection: string
    provider: string
    code: string
    redirectUri: string
    /** OIDC replay nonce; verified against the id_token by the provider. */
    nonce?: string
    /** PKCE verifier matching the challenge sent at authorization time. */
    codeVerifier?: string
  }): Promise<AuthResult> {
    const collection = collectionOrThrow(opts.collection)
    if (!collection.auth) throw new BadRequestError(`Collection "${opts.collection}" is not an auth collection.`)
    const provider = (config.oauth ?? []).find((p) => p.name === opts.provider)
    if (!provider) throw new BadRequestError(`No OAuth provider "${opts.provider}" is configured.`)

    const profile = await provider.exchangeCode({
      code: opts.code,
      redirectUri: opts.redirectUri,
      nonce: opts.nonce,
      codeVerifier: opts.codeVerifier,
    })
    if (!profile.email) throw new BadRequestError('The OAuth provider did not return an email address.')

    const hasField = (name: string) => collection.fields.some((f) => 'name' in f && f.name === name)
    const canLinkIdentity = hasField('oauth_provider') && hasField('oauth_subject')

    // 1) Returning user: match on the stable provider identity, never on email
    //    alone. This is spoof-proof — the provider asserts the subject id.
    let row: Row | undefined
    if (canLinkIdentity && profile.id) {
      row = (
        await db.find({
          collection: collection.slug,
          where: { and: [{ oauth_provider: { equals: opts.provider } }, { oauth_subject: { equals: profile.id } }] },
          limit: 1,
          page: 1,
        })
      ).docs[0]
    }

    if (!row) {
      const existing = (
        await db.find({ collection: collection.slug, where: { email: { equals: profile.email } }, limit: 1, page: 1 })
      ).docs[0]
      if (existing) {
        // 2) Linking a provider to a PRE-EXISTING account (e.g. a password user).
        //    Only safe when the provider has VERIFIED the email — otherwise an
        //    attacker who sets their provider email to a victim's could take over.
        if (!profile.emailVerified) {
          throw new ForbiddenError('This email is already registered. Sign in with your password to link OAuth.')
        }
        // OAuth carries no second factor, so it must never bypass an account's 2FA.
        if (twoFactorEnabled(collection) && (existing.totp_enabled === true || existing.totp_enabled === 1)) {
          throw new ForbiddenError('This account has two-factor enabled. Sign in with your password and code.')
        }
        if (canLinkIdentity) {
          await db.update({
            collection: collection.slug,
            id: String(existing.id),
            data: { oauth_provider: opts.provider, oauth_subject: profile.id },
          })
        }
        row = (await db.findByID({ collection: collection.slug, id: String(existing.id) })) ?? undefined
      } else {
        // 3) First sign-in → create the account. A random password satisfies the
        //    auth pipeline; the user can set one later via forgot-password. Only
        //    mark the email verified when the provider actually verified it.
        const data: Row = { email: profile.email, password: randomBytes(24).toString('base64url') }
        if (profile.name && hasField('name')) data.name = profile.name
        if (hasField('email_verified')) data.email_verified = profile.emailVerified === true
        if (canLinkIdentity) {
          data.oauth_provider = opts.provider
          data.oauth_subject = profile.id
        }
        const created = await create({ collection: collection.slug, data, overrideAccess: true })
        row = (await db.findByID({ collection: collection.slug, id: created.id })) ?? undefined
      }
    }
    if (!row) throw new BadRequestError('Could not resolve the OAuth user.')

    const user = rowToDoc(collection, row, buildReq()) as AuthUser
    user.collection = collection.slug
    const ttl = authTtl(collection)
    const token = issueToken(user.id, collection.slug, row, ttl)
    return { user, token, exp: nowSec() + ttl }
  }

  /** On a fresh signup, seed a hashed verification token + expiry. Returns the raw
   *  token to email, or null when verification isn't required / is pre-satisfied. */
  function maybeStartVerification(collection: CollectionConfig, data: Row): string | null {
    const opt = verifyOptions(collection)
    if (!opt) return null
    if (data.email_verified === true) return null // trusted create (e.g. first-admin setup)
    const raw = generateOpaqueToken()
    data.email_verified = false
    data.verification_token = hashOpaqueToken(raw)
    data.verification_token_expiry = nowSec() + (opt.tokenExpiration ?? 86400)
    return raw
  }

  function resetLink(slug: string, token: string): string {
    return `${config.serverURL}/admin/#/reset-password?collection=${slug}&token=${encodeURIComponent(token)}`
  }
  function verifyLink(slug: string, token: string): string {
    return `${config.serverURL}/admin/#/verify-email?collection=${slug}&token=${encodeURIComponent(token)}`
  }

  function defaultResetEmail(token: string, slug: string): { subject: string; html: string; text: string } {
    const link = resetLink(slug, token)
    return {
      subject: 'Reset your password',
      html: `<p>We received a request to reset your password.</p><p><a href="${link}">Choose a new password</a></p><p>If you didn't request this, you can ignore this email. The link expires soon.</p>`,
      text: `Reset your password: ${link}\n\nIf you didn't request this, ignore this email.`,
    }
  }
  function defaultVerifyEmail(token: string, slug: string): { subject: string; html: string; text: string } {
    const link = verifyLink(slug, token)
    return {
      subject: 'Verify your email address',
      html: `<p>Welcome! Please confirm your email address.</p><p><a href="${link}">Verify email</a></p>`,
      text: `Verify your email: ${link}`,
    }
  }

  async function sendVerificationEmail(collection: CollectionConfig, user: Doc, rawToken: string): Promise<void> {
    if (!config.email) return
    const opt = verifyOptions(collection) ?? {}
    const built = opt.generateEmail
      ? opt.generateEmail({ token: rawToken, user })
      : defaultVerifyEmail(rawToken, collection.slug)
    await config.email.send({ to: String(user.email), ...built })
  }

  /** Begin a password reset. Always resolves (no user enumeration) — only sends mail
   *  when the address actually exists. */
  async function forgotPassword(opts: { collection: string; email: string }): Promise<void> {
    const collection = collectionOrThrow(opts.collection)
    const opt = forgotOptions(collection)
    if (!opt) throw new BadRequestError(`Collection "${opts.collection}" does not have forgotPassword enabled.`)
    // Throttle before any DB/email work to blunt mail-bombing and cost abuse.
    throttleEmailAction('forgot', collection.slug, opts.email)
    const result = await db.find({
      collection: collection.slug,
      where: { email: { equals: opts.email } },
      limit: 1,
      page: 1,
    })
    const row = result.docs[0]
    if (!row) return
    const raw = generateOpaqueToken()
    await db.update({
      collection: collection.slug,
      id: String(row.id),
      data: { reset_token: hashOpaqueToken(raw), reset_token_expiry: nowSec() + (opt.tokenExpiration ?? 3600) },
    })
    const user = rowToDoc(collection, row, buildReq())
    const built = opt.generateEmail ? opt.generateEmail({ token: raw, user }) : defaultResetEmail(raw, collection.slug)
    await config.email?.send({ to: String(user.email), ...built })
  }

  /** Complete a password reset with the emailed token, then sign the user in. */
  async function resetPassword(opts: { collection: string; token: string; password: string }): Promise<AuthResult> {
    const collection = collectionOrThrow(opts.collection)
    if (!forgotOptions(collection)) {
      throw new BadRequestError(`Collection "${opts.collection}" does not have forgotPassword enabled.`)
    }
    if (typeof opts.password !== 'string' || opts.password.length < 8) {
      throw new ValidationError([{ path: 'password', message: 'Password must be at least 8 characters.' }])
    }
    const hashed = hashOpaqueToken(opts.token)
    const result = await db.find({
      collection: collection.slug,
      where: { reset_token: { equals: hashed } },
      limit: 1,
      page: 1,
    })
    const row = result.docs[0]
    const exp = typeof row?.reset_token_expiry === 'number' ? row.reset_token_expiry : 0
    if (!row || exp < nowSec()) {
      throw new BadRequestError('This password reset link is invalid or has expired.')
    }
    // Bump the session epoch so every token issued before this reset stops working.
    const nextVersion = tokenVersionOf(row) + 1
    await db.update({
      collection: collection.slug,
      id: String(row.id),
      data: {
        hash: await hashPassword(opts.password),
        reset_token: null,
        reset_token_expiry: null,
        token_version: nextVersion,
      },
    })
    const user = rowToDoc(collection, { ...row, hash: undefined }, buildReq()) as AuthUser
    user.collection = collection.slug
    const ttl = authTtl(collection)
    const token = issueToken(user.id, collection.slug, { ...row, token_version: nextVersion }, ttl)
    return { user, token, exp: nowSec() + ttl }
  }

  /** Confirm an email address from the emailed verification token. */
  async function verifyEmail(opts: { collection: string; token: string }): Promise<{ verified: true }> {
    const collection = collectionOrThrow(opts.collection)
    if (!verifyOptions(collection)) {
      throw new BadRequestError(`Collection "${opts.collection}" does not have email verification enabled.`)
    }
    const hashed = hashOpaqueToken(opts.token)
    const result = await db.find({
      collection: collection.slug,
      where: { verification_token: { equals: hashed } },
      limit: 1,
      page: 1,
    })
    const row = result.docs[0]
    const exp = typeof row?.verification_token_expiry === 'number' ? row.verification_token_expiry : 0
    if (!row || exp < nowSec()) {
      throw new BadRequestError('This verification link is invalid or has expired.')
    }
    await db.update({
      collection: collection.slug,
      id: String(row.id),
      data: { email_verified: true, verification_token: null, verification_token_expiry: null },
    })
    return { verified: true }
  }

  /** Re-send a verification email. Always resolves (no enumeration); no-op if already verified. */
  async function requestEmailVerification(opts: { collection: string; email: string }): Promise<void> {
    const collection = collectionOrThrow(opts.collection)
    const opt = verifyOptions(collection)
    if (!opt) throw new BadRequestError(`Collection "${opts.collection}" does not have email verification enabled.`)
    throttleEmailAction('verify', collection.slug, opts.email)
    const result = await db.find({
      collection: collection.slug,
      where: { email: { equals: opts.email } },
      limit: 1,
      page: 1,
    })
    const row = result.docs[0]
    if (!row || isVerified(row)) return
    const raw = generateOpaqueToken()
    await db.update({
      collection: collection.slug,
      id: String(row.id),
      data: {
        verification_token: hashOpaqueToken(raw),
        verification_token_expiry: nowSec() + (opt.tokenExpiration ?? 86400),
      },
    })
    await sendVerificationEmail(collection, rowToDoc(collection, row, buildReq()), raw)
  }

  // -------------------------------------------------------------------------
  // Background jobs
  // -------------------------------------------------------------------------

  /** The Local-API subset handed to job handlers. */
  const jobLocalApi = (): import('./types').JobLocalApi => ({
    find,
    findByID,
    create,
    update,
    updateMany,
    delete: deleteOne,
    deleteMany,
    count,
    findGlobal,
    updateGlobal,
  })

  async function enqueue(opts: EnqueueOptions): Promise<Doc> {
    if (!config.jobs || config.jobs.length === 0) throw new BadRequestError('No jobs are configured.')
    const def = config.jobs.find((j) => j.slug === opts.task)
    if (!def) throw new BadRequestError(`No job handler is registered for task "${opts.task}".`)
    const runAt = opts.runAt ? new Date(opts.runAt) : new Date()
    return create({
      collection: JOBS_SLUG,
      data: {
        task: opts.task,
        status: 'pending',
        input: opts.input ?? null,
        run_at: runAt.toISOString(),
        attempts: 0,
        max_attempts: opts.maxAttempts ?? def.maxAttempts ?? 3,
      },
      overrideAccess: true,
    })
  }

  /** Claim and run every pending job whose `run_at` has arrived. Drive from a cron. */
  async function runDueJobs(opts: RunJobsOptions = {}): Promise<RunJobsResult> {
    const ran: string[] = []
    const failed: string[] = []
    if (!config.jobs || config.jobs.length === 0) return { ran, failed }
    const nowIso = (opts.now ? new Date(opts.now) : new Date()).toISOString()
    const due = await find({
      collection: JOBS_SLUG,
      where: { and: [{ status: { equals: 'pending' } }, { run_at: { less_than_equal: nowIso } }] },
      sort: 'run_at',
      limit: opts.limit ?? 100,
      overrideAccess: true,
    })
    const local = jobLocalApi()
    for (const job of due.docs) {
      const attempts = (Number(job.attempts) || 0) + 1
      await update({ collection: JOBS_SLUG, id: job.id, data: { status: 'running', attempts }, overrideAccess: true })
      const def = config.jobs.find((j) => j.slug === job.task)
      if (!def) {
        await update({
          collection: JOBS_SLUG,
          id: job.id,
          data: { status: 'failed', last_error: `No handler for task "${String(job.task)}".` },
          overrideAccess: true,
        })
        failed.push(job.id)
        continue
      }
      try {
        const result = await def.handler({ input: job.input, job, local, email: config.email })
        await update({
          collection: JOBS_SLUG,
          id: job.id,
          data: { status: 'completed', result: result ?? null, last_error: null },
          overrideAccess: true,
        })
        ran.push(job.id)
      } catch (err) {
        const maxAttempts = Number(job.max_attempts) || 3
        const message = err instanceof Error ? err.message : String(err)
        // Retry until attempts are exhausted, then mark failed.
        await update({
          collection: JOBS_SLUG,
          id: job.id,
          data: { status: attempts >= maxAttempts ? 'failed' : 'pending', last_error: message },
          overrideAccess: true,
        })
        failed.push(job.id)
      }
    }
    return { ran, failed }
  }

  // -------------------------------------------------------------------------
  // Global operations
  // -------------------------------------------------------------------------

  function globalDoc(global: GlobalConfig, row: Row | null, req: RequestContext): Row {
    if (!row) {
      const defaults = applyDefaults(global.fields, {})
      return deserializeDoc(global.fields, defaults, deserializeOptsFor(req))
    }
    const body = deserializeDoc(global.fields, row, deserializeOptsFor(req))
    if (row.updatedAt !== undefined) body.updatedAt = row.updatedAt
    return body
  }

  async function findGlobal<T extends Row = Row>(opts: FindGlobalOptions): Promise<T> {
    const global = globalOrThrow(opts.slug)
    const req = buildReq(opts.req)
    if (!(opts.overrideAccess ?? false)) {
      const access = await evalAccess(global.access?.read, { req })
      if (!isAllowed(access)) throw new ForbiddenError()
    }
    const table = tableForGlobal(global.slug)
    const row = await db.findByID({ collection: table, id: GLOBAL_ROW_ID })
    let doc = globalDoc(global, row, req)
    doc = await runHooks(global.hooks?.afterRead, { req, operation: 'read', doc }, 'doc')
    // Field-level read access must apply to globals too, exactly as it does for
    // collection reads — otherwise a `field.access.read` rule is silently ignored.
    if (!(opts.overrideAccess ?? false)) await applyReadFieldAccess(global.fields, doc, req)
    await applyComputed(global.fields, doc, req)
    if (!(opts.overrideAccess ?? false)) await applyReadFieldAccess(global.fields, doc, req)
    return doc as T
  }

  async function updateGlobal<T extends Row = Row>(opts: UpdateGlobalOptions): Promise<T> {
    const global = globalOrThrow(opts.slug)
    const req = buildReq(opts.req)
    if (!(opts.overrideAccess ?? false)) {
      const access = await evalAccess(global.access?.update, { req, data: opts.data })
      if (!isAllowed(access)) throw new ForbiddenError()
    }
    const table = tableForGlobal(global.slug)
    const existing = await db.findByID({ collection: table, id: GLOBAL_ROW_ID })
    const existingDoc = globalDoc(global, existing, req)

    const incoming: Row = { ...opts.data }
    if (!(opts.overrideAccess ?? false)) await applyFieldAccess(global.fields, incoming, 'update', req)

    let merged: Row = { ...existingDoc, ...incoming }
    merged = await runHooks(global.hooks?.beforeChange, { req, operation: 'update', data: merged }, 'data')
    await applyStoredComputed(global.fields, merged, req)

    const errors = await validateFields(global.fields, merged, { req, operation: 'update' })
    if (errors.length) throw new ValidationError(errors)

    // Persist the post-hook, post-compute document (see collection update).
    const row = serializeDoc(global.fields, merged, {
      locale: req.locale,
      segment: writeSegment(req),
      existingRow: existing,
      ...(fieldCipher ? { cipher: fieldCipher } : {}),
    })
    let saved: Row | null
    if (existing) {
      saved = await db.update({ collection: table, id: GLOBAL_ROW_ID, data: row })
    } else {
      row.id = GLOBAL_ROW_ID
      saved = await db.create({ collection: table, data: row })
    }
    let doc = globalDoc(global, saved, req)
    doc = await runHooks(global.hooks?.afterChange, { req, operation: 'update', doc }, 'doc')
    if (!(opts.overrideAccess ?? false)) await applyReadFieldAccess(global.fields, doc, req)
    await applyComputed(global.fields, doc, req)
    if (!(opts.overrideAccess ?? false)) await applyReadFieldAccess(global.fields, doc, req)
    return doc as T
  }

  function resolveStore(uploadCfg: UploadConfig): StorageAdapter {
    const storage = config.storage
    if (!storage) throw new BadRequestError('No storage adapter configured (config.storage).')
    if (typeof (storage as StorageAdapter).put === 'function') return storage as StorageAdapter
    const map = storage as Record<string, StorageAdapter>
    const name = uploadCfg.store ?? 'default'
    const adapter = map[name]
    if (!adapter) throw new BadRequestError(`Storage store "${name}" is not configured.`)
    return adapter
  }

  /** Best-effort sweep of an upload document's binary (and image derivatives) when the
   *  document is deleted, so bytes never outlive the row — and a signed capability URL can't
   *  keep serving a "deleted" file until its TTL. Never throws into the delete path. */
  async function sweepUploadBinary(collection: CollectionConfig, row: Row): Promise<void> {
    if (!collection.upload) return
    const key = typeof row.storage_key === 'string' ? row.storage_key : ''
    if (!key) return
    const uploadCfg: UploadConfig = collection.upload === true ? {} : collection.upload
    let store: StorageAdapter
    try {
      store = resolveStore(uploadCfg)
    } catch {
      return
    }
    const filename = typeof row.filename === 'string' ? row.filename : key
    const keys = [key]
    for (const def of uploadCfg.imageSizes ?? []) {
      const ext = def.format ? extForFormat(def.format) : fileExtension(filename)
      keys.push(derivativeKey(key, def.name, ext))
    }
    await Promise.all(keys.map((k) => store.delete(k).catch(() => {})))
  }

  function mimeAllowed(declared: string, patterns: string[] | undefined): boolean {
    if (!patterns || patterns.length === 0) return true
    return patterns.some((p) => {
      if (p.endsWith('/*')) return declared.startsWith(p.slice(0, -1)) // 'image/*' → 'image/'
      return p === declared
    })
  }

  /** Validate a file, persist its bytes, then create the upload document. */
  async function upload<T extends Doc = Doc>(opts: UploadDocOptions): Promise<T> {
    const collection = collectionOrThrow(opts.collection)
    if (!collection.upload) throw new BadRequestError(`Collection "${opts.collection}" is not an upload collection.`)
    const uploadCfg: UploadConfig = collection.upload === true ? {} : collection.upload
    const { file } = opts
    if (!file || !Buffer.isBuffer(file.data)) {
      throw new ValidationError([{ path: 'file', message: 'A file buffer is required.' }])
    }

    // ① size + declared-type allow-list
    if (uploadCfg.maxFileSize && file.data.length > uploadCfg.maxFileSize) {
      throw new ValidationError([
        { path: 'file', message: `File exceeds the maximum size of ${uploadCfg.maxFileSize} bytes.` },
      ])
    }
    if (!mimeAllowed(file.mimeType, uploadCfg.mimeTypes)) {
      throw new ValidationError([{ path: 'file', message: `File type "${file.mimeType}" is not allowed.` }])
    }

    // ② magic-byte sniff — never trust the client-declared Content-Type
    const sniffed = sniffMimeType(file.data)
    if (!isContentTypeConsistent(file.mimeType, sniffed)) {
      throw new ValidationError([
        {
          path: 'file',
          message: `File content (${sniffed ?? 'unknown'}) does not match its declared type "${file.mimeType}".`,
        },
      ])
    }

    // ③ metadata + ④ persist bytes (before the document write, so the DB is the source of truth)
    const checksum = createHash('sha256').update(file.data).digest('hex')
    const store = resolveStore(uploadCfg)
    const key = generateKey(collection.slug, file.name)
    await store.put(key, file.data, { contentType: file.mimeType, contentLength: file.data.length })
    const url = await store.url(key)

    // ④b image derivatives + dimensions — only when a processor is configured and
    // the upload is an image. Every persisted byte is tracked for cleanup on failure.
    const derivativeKeys: string[] = []
    let dimensions: { width?: number; height?: number } = {}
    let sizes: Record<string, unknown> | undefined
    if (config.image && file.mimeType.startsWith('image/')) {
      try {
        const probed = await config.image.probe(file.data)
        if (probed) dimensions = { width: probed.width, height: probed.height }
        const sizeDefs = uploadCfg.imageSizes ?? []
        if (sizeDefs.length > 0) {
          const incoming = (opts.data ?? {}) as Row
          const fx = Number(incoming.focal_x)
          const fy = Number(incoming.focal_y)
          const focalPoint =
            uploadCfg.focalPoint && Number.isFinite(fx) && Number.isFinite(fy) ? { x: fx, y: fy } : undefined
          const generated: Record<string, unknown> = {}
          for (const def of sizeDefs) {
            const result = await config.image.resize(file.data, {
              width: def.width,
              height: def.height,
              fit: def.fit,
              format: def.format,
              quality: def.quality,
              focalPoint,
            })
            const ext = def.format ? extForFormat(def.format) : fileExtension(file.name)
            const dKey = derivativeKey(key, def.name, ext)
            const dType = def.format ? `image/${def.format}` : file.mimeType
            await store.put(dKey, result.data, { contentType: dType, contentLength: result.data.length })
            derivativeKeys.push(dKey)
            generated[def.name] = {
              url: await store.url(dKey),
              width: result.info.width,
              height: result.info.height,
              filename: derivativeName(file.name, def.name, ext),
              filesize: result.data.length,
              mime_type: dType,
            }
          }
          sizes = generated
        }
      } catch (err) {
        await store.delete(key).catch(() => {})
        await Promise.all(derivativeKeys.map((k) => store.delete(k).catch(() => {})))
        throw err
      }
    }

    // ⑤ create the document through the normal pipeline (access, hooks, validation)
    const data: Row = {
      ...(opts.data ?? {}),
      filename: file.name,
      mime_type: file.mimeType,
      filesize: file.data.length,
      checksum,
      storage_key: key,
      url,
      ...dimensions,
      ...(sizes ? { sizes } : {}),
    }
    try {
      return await create<T>({
        collection: opts.collection,
        data,
        req: opts.req,
        overrideAccess: opts.overrideAccess,
        depth: opts.depth,
      })
    } catch (err) {
      // Sweep the orphaned binary (and any derivatives) so bytes never outlive the doc.
      await store.delete(key).catch(() => {})
      await Promise.all(derivativeKeys.map((k) => store.delete(k).catch(() => {})))
      throw err
    }
  }

  /** Mint a signed, expiring capability URL for an upload document's file. Access-checked:
   *  the caller must be able to READ the document (you can't link a file you can't see). The
   *  link carries `?exp=<unix>&sig=<hmac>` keyed by `config.secret`, covering the storage key
   *  and the expiry so neither can be swapped/extended. When the adapter mints its own signed
   *  URLs (S3 presign), that is delegated to instead. */
  async function signedAssetUrl(opts: SignedAssetUrlOptions): Promise<string> {
    const collection = collectionOrThrow(opts.collection)
    if (!collection.upload) {
      throw new BadRequestError(`Collection "${opts.collection}" is not an upload collection.`)
    }
    // Authorize via the normal access-checked read; only mint for a readable document.
    const doc = await findByID({
      collection: collection.slug,
      id: opts.id,
      req: opts.req,
      overrideAccess: opts.overrideAccess,
    })
    if (!doc) throw new NotFoundError()
    // Read the storage key from the raw row (it may be field-access-hidden on the doc).
    const raw = await db.findByID({ collection: collection.slug, id: opts.id })
    const key = raw && typeof raw.storage_key === 'string' ? raw.storage_key : ''
    if (!key) throw new NotFoundError()

    const uploadCfg: UploadConfig = collection.upload === true ? {} : collection.upload
    const store = resolveStore(uploadCfg)
    const servePath = store.servePath
    const ttl = Math.min(Math.max(Math.trunc(opts.ttl ?? DEFAULT_ASSET_TTL), 1), MAX_ASSET_TTL)
    // An adapter that serves over an absolute base (e.g. S3) mints its own signed URL.
    if (!servePath || servePath.includes('://')) {
      return store.url(key, { ttl })
    }
    if (!config.secret) {
      throw new BadRequestError('Signed asset URLs require `config.secret`.')
    }
    const exp = Math.floor(Date.now() / 1000) + ttl
    const sig = signAssetUrl(config.secret, key, exp)
    const path = key.split('/').map(encodeURIComponent).join('/')
    return `${servePath}/${path}?exp=${exp}&sig=${sig}`
  }

  function fileExtension(name: string): string {
    const dot = name.lastIndexOf('.')
    const raw = dot > 0 ? name.slice(dot + 1).toLowerCase() : 'bin'
    // Clamp to a safe, bounded token so a crafted filename extension can never
    // shape the storage key (path separators, dots, length abuse).
    const cleaned = raw.replace(/[^a-z0-9]/g, '').slice(0, 8)
    return cleaned || 'bin'
  }
  function derivativeKey(originalKey: string, sizeName: string, ext: string): string {
    const dot = originalKey.lastIndexOf('.')
    const base = dot > 0 ? originalKey.slice(0, dot) : originalKey
    return `${base}-${sizeName}.${ext}`
  }
  function derivativeName(originalName: string, sizeName: string, ext: string): string {
    const dot = originalName.lastIndexOf('.')
    const base = dot > 0 ? originalName.slice(0, dot) : originalName
    return `${base}-${sizeName}.${ext}`
  }

  // -------------------------------------------------------------------------
  // RBAC roles (runtime-editable)
  //
  // The live store (config.rbacStore) is captured by reference by the injected
  // access rules, so every mutation here changes enforcement on the NEXT access
  // check. Each write persists to the `_roles` table AND updates the store, keeping
  // them in lockstep. Admin-gating happens at the HTTP layer (and the Local API can
  // be called from trusted server code); these are plain store+table operations.
  // -------------------------------------------------------------------------

  function assertRbacEnabled(): void {
    if (!config.rbac.enabled) throw new BadRequestError('RBAC is not enabled (set `config.rbac`).')
  }

  /** Validate a runtime role def, mapping a structural failure to a 400 (BadRequest). */
  function validateRole(name: string, def: RoleDef): void {
    try {
      assertValidRoleDef(name, def)
    } catch (err) {
      throw new BadRequestError(err instanceof Error ? err.message : 'Invalid role definition.')
    }
  }

  /** List roles from the live store (the authoritative in-memory view, kept in sync
   *  with `_roles`). Returns `[]` when RBAC is disabled rather than throwing, so a UI
   *  can probe safely. */
  async function findRoles(): Promise<import('./types').RoleDoc[]> {
    if (!config.rbac.enabled) return []
    return Object.entries(config.rbacStore.roles)
      .map(([name, def]) => ({ name, def: cloneRoleDef(def) }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  // The grant keys recorded in a role-mutation audit row — enough to reconstruct
  // who-changed-what (incl. the sensitive `admin` flag) without dumping full defs.
  function roleGrantFields(def: RoleDef): string[] {
    const keys: string[] = []
    if (def.admin) keys.push('admin')
    if (def.collections) keys.push(...Object.keys(def.collections).map((c) => `collections.${c}`))
    if (def.globals) keys.push(...Object.keys(def.globals).map((g) => `globals.${g}`))
    return keys
  }

  async function createRole(
    name: string,
    def: RoleDef,
    opts: RoleMutationOptions = {},
  ): Promise<import('./types').RoleDoc> {
    assertRbacEnabled()
    validateRole(name, def)
    if (config.rbacStore.roles[name]) throw new ConflictError(`Role "${name}" already exists.`)
    const stored = cloneRoleDef(def)
    await db.create({ collection: ROLES_TABLE, data: { id: name, name, def: stored } })
    // Update the live store only AFTER the persist succeeds (fail-closed: a failed
    // write must not leave a phantom grant in memory).
    config.rbacStore.roles[name] = stored
    await recordAudit({
      action: 'role.create',
      documentId: name,
      req: opts.req as RequestContext | undefined,
      fields: roleGrantFields(stored),
    })
    return { name, def: cloneRoleDef(stored) }
  }

  async function updateRole(
    name: string,
    def: RoleDef,
    opts: RoleMutationOptions = {},
  ): Promise<import('./types').RoleDoc> {
    assertRbacEnabled()
    validateRole(name, def)
    if (!config.rbacStore.roles[name]) throw new NotFoundError(`Role "${name}" not found.`)
    const stored = cloneRoleDef(def)
    await db.update({ collection: ROLES_TABLE, id: name, data: { name, def: stored } })
    config.rbacStore.roles[name] = stored
    await recordAudit({
      action: 'role.update',
      documentId: name,
      req: opts.req as RequestContext | undefined,
      fields: roleGrantFields(stored),
    })
    return { name, def: cloneRoleDef(stored) }
  }

  async function deleteRole(name: string, opts: RoleMutationOptions = {}): Promise<{ name: string }> {
    assertRbacEnabled()
    if (!config.rbacStore.roles[name]) throw new NotFoundError(`Role "${name}" not found.`)
    await db.delete({ collection: ROLES_TABLE, id: name })
    delete config.rbacStore.roles[name]
    await recordAudit({ action: 'role.delete', documentId: name, req: opts.req as RequestContext | undefined })
    return { name }
  }

  // -------------------------------------------------------------------------
  // Collaboration: advisory soft locks + lightweight presence
  //
  // Lightweight, DB-backed coordination so two editors (or an agent + a human) on the
  // same document can see each other — NOT a CRDT. SECURITY: locks are ADVISORY. They
  // signal intent and never gate writes; a writer who ignores a lock still goes through
  // the SAME access control. So these ops deliberately do NOT consult collection access
  // — they're a presence/coordination layer, not an authorization layer. Callers are the
  // already-authenticated principals the rest of the API trusts (the HTTP layer requires
  // auth for the presence/lock routes). `now` is injectable for deterministic expiry.
  // -------------------------------------------------------------------------

  const DEFAULT_LOCK_TTL_MS = 120_000
  // Upper bound on a lock's lifetime. Clamps hostile/garbage `ttlMs` (NaN, Infinity, or
  // values so large that `now + ttl` overflows a JS Date) to a finite range so the date
  // math below can never throw a RangeError into a 500.
  const MAX_LOCK_TTL_MS = 24 * 60 * 60 * 1000
  const DEFAULT_PRESENCE_TTL_MS = 30_000

  /** The principal id/kind for a collaboration op, derived from the request user. An
   *  anonymous principal collapses to a stable 'anonymous'/'system' identity. */
  function principalOf(req: RequestContext): { id: string; type: 'user' | 'agent' | 'system' } {
    const user = req.user
    if (!user) return { id: 'anonymous', type: 'system' }
    return { id: String(user.id), type: user.principalType ?? 'user' }
  }

  /** Validate that the target collection + document exist (and reject prototype-pollution
   *  ids), so a lock/presence row can never be created for a bogus or hostile key. Then
   *  access-check READ on the target exactly like `update()` does: a caller who can't read
   *  the document must not be able to lock it, heartbeat on it, or learn who is editing it.
   *  Denial throws NotFound (never Forbidden) so presence/locks can't be used to probe the
   *  existence of documents outside the caller's read scope. A trusted call (overrideAccess,
   *  or no `req.user`) skips the check — that's the existing server-internal contract. */
  async function assertTarget(collection: string, id: string, req: RequestContext): Promise<CollectionConfig> {
    const coll = collectionOrThrow(collection)
    if (typeof id !== 'string' || id.length === 0 || COMPOSE_FORBIDDEN_KEYS.has(id)) {
      throw new BadRequestError('A valid document `id` is required.')
    }
    const row = await db.findByID({ collection: coll.slug, id })
    if (!row) throw new NotFoundError()
    if (req.user) {
      const access = await evalAccess(coll.access?.read, { req, id })
      if (!isAllowed(access)) throw new NotFoundError()
      const scope = asWhere(access)
      if (scope && !matchesWhere(row, scope)) throw new NotFoundError()
    }
    return coll
  }

  /** Shape a raw `_locks` row into a public LockDoc. */
  function rowToLock(row: Row): LockDoc {
    return {
      id: String(row.id),
      collection: String(row.collection),
      documentId: String(row.documentId),
      principalId: String(row.principalId),
      principalType: (row.principalType as LockDoc['principalType']) ?? 'user',
      acquiredAt: String(row.acquiredAt),
      expiresAt: String(row.expiresAt),
      label: row.label != null ? String(row.label) : null,
    }
  }

  /** True when a lock row is still in force at `now` (epoch ms). */
  function lockUnexpired(row: Row, now: number): boolean {
    const exp = new Date(String(row.expiresAt)).getTime()
    return Number.isFinite(exp) && exp > now
  }

  async function acquireLock(opts: AcquireLockOptions): Promise<AcquireLockResult> {
    const req = buildReq(opts.req)
    const coll = await assertTarget(opts.collection, opts.id, req)
    const me = principalOf(req)
    const now = opts.now ?? Date.now()
    // Clamp `ttlMs` to a finite, bounded range: garbage from the wire (NaN, Infinity, or a
    // value so large it overflows `new Date(now + ttl)`) must not throw a RangeError 500.
    const raw = Math.floor(Number(opts.ttlMs))
    const ttl = Math.min(Math.max(Number.isFinite(raw) ? raw : DEFAULT_LOCK_TTL_MS, 1), MAX_LOCK_TTL_MS)
    const lockId = `${coll.slug}:${opts.id}`

    const existing = await db.findByID({ collection: LOCKS_TABLE, id: lockId })
    // A different principal holding an UNEXPIRED lock is respected — never stolen.
    if (existing && lockUnexpired(existing, now) && String(existing.principalId) !== me.id) {
      return { lock: rowToLock(existing), heldBy: 'other' }
    }

    // Free, expired, or already ours → (re)acquire. A re-acquire by the same principal
    // refreshes `expiresAt` (and updates the label), which is how a holder keeps a lock
    // alive while editing.
    const acquiredAt = new Date(now).toISOString()
    const expiresAt = new Date(now + ttl).toISOString()
    const data: Row = {
      collection: coll.slug,
      documentId: opts.id,
      principalId: me.id,
      principalType: me.type,
      acquiredAt,
      expiresAt,
      label: typeof opts.label === 'string' ? opts.label : null,
    }
    if (existing) await db.update({ collection: LOCKS_TABLE, id: lockId, data })
    else await db.create({ collection: LOCKS_TABLE, data: { id: lockId, ...data } })
    const saved = (await db.findByID({ collection: LOCKS_TABLE, id: lockId })) ?? { id: lockId, ...data }
    return { lock: rowToLock(saved), heldBy: 'you' }
  }

  async function releaseLock(opts: ReleaseLockOptions): Promise<ReleaseLockResult> {
    const req = buildReq(opts.req)
    const coll = await assertTarget(opts.collection, opts.id, req)
    const me = principalOf(req)
    const now = opts.now ?? Date.now()
    const lockId = `${coll.slug}:${opts.id}`

    const existing = await db.findByID({ collection: LOCKS_TABLE, id: lockId })
    if (!existing) return { released: false }
    // An UNEXPIRED lock may only be released by its holder, an admin, or a system
    // override. An already-expired lock is fair game for anyone to clear.
    const isHolder = String(existing.principalId) === me.id
    const isAdmin = Array.isArray(req.user?.roles) && req.user!.roles!.includes('admin')
    if (lockUnexpired(existing, now) && !isHolder && !isAdmin) {
      throw new ForbiddenError('Only the lock holder can release this lock.')
    }
    await db.delete({ collection: LOCKS_TABLE, id: lockId })
    return { released: true }
  }

  async function getLock(opts: GetLockOptions): Promise<LockDoc | null> {
    const req = buildReq(opts.req)
    // Access-check READ first: a caller who can't read the target gets NotFound (matching
    // the 404 the rest of the API returns for out-of-scope documents), never the lock.
    const coll = await assertTarget(opts.collection, opts.id, req)
    const now = opts.now ?? Date.now()
    const row = await db.findByID({ collection: LOCKS_TABLE, id: `${coll.slug}:${opts.id}` })
    if (!row || !lockUnexpired(row, now)) return null
    return rowToLock(row)
  }

  async function listLocks(opts: ListLocksOptions = {}): Promise<LockDoc[]> {
    const req = buildReq(opts.req)
    const now = opts.now ?? Date.now()
    const where = opts.collection ? { collection: { equals: collectionOrThrow(opts.collection).slug } } : undefined
    const res = await db.find({ collection: LOCKS_TABLE, where, limit: MAX_LIMIT, page: 1 })
    const unexpired = res.docs.filter((row) => lockUnexpired(row, now))
    // Trusted server call (no principal) sees every lock. An authenticated principal only
    // sees locks on documents they can READ — otherwise the lock table leaks who is editing
    // documents outside their read scope. Locks are few, so a per-lock check is bounded.
    if (!req.user) return unexpired.map(rowToLock)
    const visible: Row[] = []
    for (const row of unexpired) {
      const slug = String(row.collection)
      const coll = config.collectionsBySlug[slug]
      if (!coll) continue
      const access = await evalAccess(coll.access?.read, { req, id: String(row.documentId) })
      if (!isAllowed(access)) continue
      const scope = asWhere(access)
      if (scope) {
        const target = await db.findByID({ collection: slug, id: String(row.documentId) })
        if (!target || !matchesWhere(target, scope)) continue
      }
      visible.push(row)
    }
    return visible.map(rowToLock)
  }

  /** Validate a presence kind, defaulting to 'viewing' for anything unexpected. */
  function presenceKind(kind: unknown): PresenceKind {
    return kind === 'editing' ? 'editing' : 'viewing'
  }

  async function heartbeat(opts: HeartbeatOptions): Promise<void> {
    const req = buildReq(opts.req)
    const coll = await assertTarget(opts.collection, opts.id, req)
    const me = principalOf(req)
    const now = opts.now ?? Date.now()
    const rowId = `${coll.slug}:${opts.id}:${me.id}`
    const data: Row = {
      collection: coll.slug,
      documentId: opts.id,
      principalId: me.id,
      principalType: me.type,
      kind: presenceKind(opts.kind),
      lastSeen: new Date(now).toISOString(),
    }
    // The row key is one slot per principal per document (upsert), so the table grows only
    // with the number of DISTINCT concurrent principals on a doc — not with heartbeat rate.
    // Stale rows are lazily pruned on the next `getPresence` read (below), so growth stays
    // bounded without a background sweeper.
    const existing = await db.findByID({ collection: PRESENCE_TABLE, id: rowId })
    if (existing) await db.update({ collection: PRESENCE_TABLE, id: rowId, data })
    else await db.create({ collection: PRESENCE_TABLE, data: { id: rowId, ...data } })
  }

  async function getPresence(opts: GetPresenceOptions): Promise<PresenceEntry[]> {
    const req = buildReq(opts.req)
    // Access-check READ first: a caller who can't read the target gets NotFound, so presence
    // can't reveal who is on a document outside the caller's read scope.
    const coll = await assertTarget(opts.collection, opts.id, req)
    const now = opts.now ?? Date.now()
    // Finite-guard the liveness window: NaN/Infinity from the wire must not poison `cutoff`.
    const rawTtl = Math.floor(Number(opts.ttlMs))
    const ttl = Math.min(Math.max(Number.isFinite(rawTtl) ? rawTtl : DEFAULT_PRESENCE_TTL_MS, 1), MAX_LOCK_TTL_MS)
    const cutoff = now - ttl
    const res = await db.find({
      collection: PRESENCE_TABLE,
      where: { and: [{ collection: { equals: coll.slug } }, { documentId: { equals: opts.id } }] },
      limit: MAX_LIMIT,
      page: 1,
    })
    const active: PresenceEntry[] = []
    for (const row of res.docs) {
      const seen = new Date(String(row.lastSeen)).getTime()
      if (!Number.isFinite(seen) || seen < cutoff) {
        // Stale: lazily prune so the table doesn't accumulate dead heartbeats.
        await db.delete({ collection: PRESENCE_TABLE, id: String(row.id) })
        continue
      }
      active.push({
        principalId: String(row.principalId),
        principalType: (row.principalType as PresenceEntry['principalType']) ?? 'user',
        kind: presenceKind(row.kind),
        lastSeen: new Date(seen).toISOString(),
      })
    }
    return active
  }

  // -------------------------------------------------------------------------
  // Editorial comments / annotations
  //
  // Threaded review feedback on content documents, persisted in `_comments` (never on the
  // document, never reachable via generic CRUD). The security model is "you can only
  // comment on / see comments for a document you can READ": every op resolves the target
  // document through the ACCESS-CHECKED read path first, so a comment never leaks content
  // (body/author/even existence) the caller couldn't otherwise see. The author is recorded
  // from the authenticated principal — NEVER client input — so a comment can't be forged.
  // -------------------------------------------------------------------------

  /** Prototype-pollution guard for an untrusted id/field string used as a key/lookup. */
  const COMMENT_FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

  /** Shape a raw `_comments` row into a public CommentDoc. */
  function rowToComment(row: Row): CommentDoc {
    return {
      id: String(row.id),
      collection: String(row.collection),
      documentId: String(row.documentId),
      field: row.field != null ? String(row.field) : null,
      parentId: row.parentId != null ? String(row.parentId) : null,
      body: String(row.body ?? ''),
      authorId: row.authorId != null ? String(row.authorId) : null,
      authorType: normalizePrincipalType(row.authorType),
      resolved: row.resolved === true,
      createdAt: row.createdAt != null ? String(row.createdAt) : '',
      updatedAt: row.updatedAt != null ? String(row.updatedAt) : '',
    }
  }

  /**
   * Access-check a READ on the target document, exactly like `assertTarget`/the read path:
   * the document must exist AND the caller must be able to read it (rule + row-scope). A
   * denial (or a missing doc) throws — so a caller can never add/list/resolve comments for a
   * document outside their read scope, and the comment surface can't be used to probe for
   * hidden documents. Only an `overrideAccess` (service/internal) call skips the check —
   * an anonymous Local-API caller (no `req.user`) is still held to the document's read rule,
   * exactly like `assertCanReadDoc`, so comment bodies/authors/counts never leak.
   */
  async function assertCanCommentOn(
    collection: CollectionConfig,
    id: string,
    req: RequestContext,
    override: boolean,
  ): Promise<void> {
    if (typeof id !== 'string' || id.length === 0 || COMMENT_FORBIDDEN_KEYS.has(id)) {
      throw new BadRequestError('A valid document `id` is required.')
    }
    const row = await db.findByID({ collection: collection.slug, id })
    if (!row) throw new NotFoundError()
    if (override) return
    const access = await evalAccess(collection.access?.read, { req, id })
    if (!isAllowed(access)) throw new ForbiddenError()
    const scope = asWhere(access)
    if (scope && !matchesWhere(row, scope)) throw new ForbiddenError()
  }

  /** Whether `user` is a reviewer (admin or editor) — the role allowed to resolve any
   *  comment on a document they can read (an author can always resolve their own). */
  function isReviewerPrincipal(req: RequestContext): boolean {
    const roles = req.user?.roles
    return Array.isArray(roles) && (roles.includes('admin') || roles.includes('editor'))
  }

  /** Whether `user` is an admin — the role allowed to delete any comment (beyond its author). */
  function isAdminPrincipal(req: RequestContext): boolean {
    const roles = req.user?.roles
    return Array.isArray(roles) && roles.includes('admin')
  }

  /** The single comment row by id, or null. */
  async function commentRowById(commentId: string): Promise<Row | null> {
    if (typeof commentId !== 'string' || commentId.length === 0 || COMMENT_FORBIDDEN_KEYS.has(commentId)) {
      throw new BadRequestError('A valid `commentId` is required.')
    }
    return (await db.findByID({ collection: COMMENTS_TABLE, id: commentId })) ?? null
  }

  async function addComment(opts: AddCommentOptions): Promise<CommentDoc> {
    if (!config.comments.enabled) {
      throw new BadRequestError('Editorial comments are not enabled (set `config.comments`).')
    }
    const collection = collectionOrThrow(opts.collection)
    const req = buildReq(opts.req)
    const override = opts.overrideAccess ?? false

    // Anonymous principals can't comment — a comment must be attributable to a user/agent.
    if (!override && !req.user) throw new UnauthorizedError('Authentication is required to comment.')

    // Gate on the TARGET DOCUMENT's read access. A caller who can't read it gets
    // Forbidden/NotFound — never a stored comment, and never a hint the doc exists.
    await assertCanCommentOn(collection, opts.id, req, override)

    // Body is untrusted: require a non-empty trimmed string, bound its length.
    const body = typeof opts.body === 'string' ? opts.body.trim() : ''
    if (body.length === 0) throw new ValidationError([{ path: 'body', message: 'A comment `body` is required.' }])
    if (body.length > MAX_COMMENT_BODY) {
      throw new ValidationError([
        { path: 'body', message: `Comment is too long (max ${MAX_COMMENT_BODY} characters).` },
      ])
    }

    // `field` (if given) must be a REAL field of the collection — reject prototype-pollution
    // keys and any name that isn't an actual field so the anchor can't be a poisoned key or
    // a probe. We match against the storage fields (the columns content actually has).
    let field: string | null = null
    if (opts.field != null) {
      const name = String(opts.field)
      if (COMMENT_FORBIDDEN_KEYS.has(name) || !storageFields(collection.fields).some((f) => f.name === name)) {
        throw new ValidationError([{ path: 'field', message: `"${name}" is not a field of "${collection.slug}".` }])
      }
      field = name
    }

    // `parentId` (if given) must be an EXISTING comment on the SAME (collection, document) —
    // no cross-document/cross-collection threading (which would leak ids / attach a reply to
    // a doc the caller couldn't otherwise touch).
    let parentId: string | null = null
    if (opts.parentId != null) {
      const parent = await commentRowById(String(opts.parentId))
      if (!parent || String(parent.collection) !== collection.slug || String(parent.documentId) !== String(opts.id)) {
        throw new ValidationError([{ path: 'parentId', message: 'Parent comment must be on the same document.' }])
      }
      parentId = String(parent.id)
    }

    // Author is the AUTHENTICATED PRINCIPAL — never client input. A forged `authorId` in the
    // call has no effect (we don't read it); the stored author is `principalOf(req)`.
    const me = principalOf(req)
    const id = randomUUID()
    await db.create({
      collection: COMMENTS_TABLE,
      data: {
        id,
        collection: collection.slug,
        documentId: String(opts.id),
        field,
        parentId,
        body,
        authorId: override ? null : me.id,
        authorType: override ? 'system' : me.type,
        resolved: false,
      },
    })

    await recordAudit({
      action: 'comment.create',
      collection: collection.slug,
      documentId: String(opts.id),
      req,
      overrideAccess: override,
      ...(field ? { fields: [field] } : {}),
      meta: { commentId: id, ...(parentId ? { parentId } : {}) },
    })

    const saved = await db.findByID({ collection: COMMENTS_TABLE, id })
    return rowToComment(saved ?? { id })
  }

  async function listComments(opts: ListCommentsOptions): Promise<CommentDoc[]> {
    if (!config.comments.enabled) return []
    const collection = collectionOrThrow(opts.collection)
    const req = buildReq(opts.req)
    const override = opts.overrideAccess ?? false

    // NEVER list comments for a document the caller can't read (Forbidden — no leak).
    await assertCanCommentOn(collection, opts.id, req, override)

    const and: Where[] = [{ collection: { equals: collection.slug } }, { documentId: { equals: String(opts.id) } }]
    if (opts.field != null) and.push({ field: { equals: String(opts.field) } })
    // Resolved comments are hidden unless explicitly requested.
    if (opts.includeResolved !== true) and.push({ resolved: { not_equals: true } })

    const res = await db.find({
      collection: COMMENTS_TABLE,
      where: { and },
      sort: [{ field: 'createdAt', direction: 'asc' }],
      limit: MAX_LIMIT,
      page: 1,
    })
    return res.docs.map(rowToComment)
  }

  async function resolveComment(opts: ResolveCommentOptions): Promise<CommentDoc> {
    if (!config.comments.enabled) {
      throw new BadRequestError('Editorial comments are not enabled (set `config.comments`).')
    }
    const req = buildReq(opts.req)
    const override = opts.overrideAccess ?? false
    const row = await commentRowById(opts.commentId)
    if (!row) throw new NotFoundError()

    const collection = collectionOrThrow(String(row.collection))
    // Re-check the document read access (the comment's doc could now be out of scope).
    await assertCanCommentOn(collection, String(row.documentId), req, override)

    // Only the comment's AUTHOR or a reviewer (admin/editor) may resolve it. A random user
    // who merely shares read access to the document cannot touch someone else's comment.
    if (!override) {
      const me = principalOf(req)
      const isAuthor = row.authorId != null && String(row.authorId) === me.id
      if (!isAuthor && !isReviewerPrincipal(req)) {
        throw new ForbiddenError('Only the comment author or a reviewer can resolve this comment.')
      }
    }

    const resolved = opts.resolved !== false
    await db.update({ collection: COMMENTS_TABLE, id: String(row.id), data: { resolved } })

    await recordAudit({
      action: 'comment.resolve',
      collection: collection.slug,
      documentId: String(row.documentId),
      req,
      overrideAccess: override,
      meta: { commentId: String(row.id), resolved },
    })

    const saved = await db.findByID({ collection: COMMENTS_TABLE, id: String(row.id) })
    return rowToComment(saved ?? row)
  }

  async function deleteComment(opts: DeleteCommentOptions): Promise<{ id: string }> {
    if (!config.comments.enabled) {
      throw new BadRequestError('Editorial comments are not enabled (set `config.comments`).')
    }
    const req = buildReq(opts.req)
    const override = opts.overrideAccess ?? false
    const row = await commentRowById(opts.commentId)
    if (!row) throw new NotFoundError()

    const collection = collectionOrThrow(String(row.collection))
    await assertCanCommentOn(collection, String(row.documentId), req, override)

    // Only the comment's AUTHOR or an admin may delete it.
    if (!override) {
      const me = principalOf(req)
      const isAuthor = row.authorId != null && String(row.authorId) === me.id
      if (!isAuthor && !isAdminPrincipal(req)) {
        throw new ForbiddenError('Only the comment author or an admin can delete this comment.')
      }
    }

    await db.delete({ collection: COMMENTS_TABLE, id: String(row.id) })

    await recordAudit({
      action: 'comment.delete',
      collection: collection.slug,
      documentId: String(row.documentId),
      req,
      overrideAccess: override,
      meta: { commentId: String(row.id) },
    })

    return { id: String(row.id) }
  }

  async function commentCount(opts: CommentCountOptions): Promise<number> {
    if (!config.comments.enabled) return 0
    const collection = collectionOrThrow(opts.collection)
    const req = buildReq(opts.req)
    const override = opts.overrideAccess ?? false
    await assertCanCommentOn(collection, opts.id, req, override)

    const and: Where[] = [{ collection: { equals: collection.slug } }, { documentId: { equals: String(opts.id) } }]
    if (opts.includeResolved !== true) and.push({ resolved: { not_equals: true } })
    return db.count({ collection: COMMENTS_TABLE, where: { and } })
  }

  // -------------------------------------------------------------------------
  // Saved views / smart collections
  //
  // A view stores a named (`where` + `sort` + `columns`) preset for one collection. It is
  // owned by its creator (owner from the principal, never client input) and private unless
  // `shared`. The stored `where`/`sort` are validated against the collection on save AND on
  // apply; applying runs the NORMAL access-checked `find`, so a view can only ever narrow
  // within the caller's read access — it can never widen or bypass it.
  // -------------------------------------------------------------------------

  const VIEW_NAME_MAX = 200

  /** Shape a raw `_views` row into a public ViewDoc. The `where`/`sort`/`columns` columns are
   *  `json`, which the storage adapter already decodes on read — so they come back as the
   *  original JS value (object / string / array) and must NOT be parsed again. */
  function rowToView(row: Row): ViewDoc {
    return {
      id: String(row.id),
      collection: String(row.collection),
      name: String(row.name),
      where: (row.where ?? null) as Where | null,
      sort: (row.sort ?? null) as string | string[] | null,
      columns: (row.columns ?? null) as string[] | null,
      ownerId: row.ownerId == null ? null : String(row.ownerId),
      shared: row.shared === true,
      createdAt: String(row.createdAt),
      updatedAt: String(row.updatedAt),
    }
  }

  /** The single view row by id, or null. Rejects a non-string / prototype-pollution id. */
  async function viewRowById(viewId: string): Promise<Row | null> {
    if (typeof viewId !== 'string' || viewId.length === 0 || COMMENT_FORBIDDEN_KEYS.has(viewId)) {
      throw new BadRequestError('A valid `viewId` is required.')
    }
    return (await db.findByID({ collection: VIEWS_TABLE, id: viewId })) ?? null
  }

  /** A caller may READ a collection (the collection-level gate, no specific row). Throws
   *  Forbidden when the read rule denies. A trusted (override) call skips the check. */
  async function assertCanReadCollection(
    collection: CollectionConfig,
    req: RequestContext,
    override: boolean,
  ): Promise<void> {
    if (override) return
    const access = await evalAccess(collection.access?.read, { req })
    if (!isAllowed(access)) throw new ForbiddenError()
  }

  /** Validate that every field a stored `sort` references is a real, filterable column of
   *  the collection — the same allow-list `where` is held to. Keeps a saved sort from
   *  referencing a renamed/removed field (or an injected key) at apply time. */
  function assertSortFields(collection: CollectionConfig, sort: string | string[] | null | undefined): void {
    if (sort == null) return
    const allowed = filterableFields(collection)
    for (const spec of parseSort(sort)) {
      if (!allowed.has(spec.field)) {
        throw new BadRequestError(`Cannot sort on unknown field "${spec.field}" of "${collection.slug}".`)
      }
    }
  }

  /** Normalize + validate the columns hint: a bounded list of real field names. Non-security
   *  (display only), but kept clean so the stored payload can't carry junk/injection keys. */
  function sanitizeViewColumns(collection: CollectionConfig, columns: string[] | null | undefined): string[] | null {
    if (columns == null) return null
    if (!Array.isArray(columns)) throw new BadRequestError('`columns` must be an array of field names.')
    const allowed = filterableFields(collection)
    const out: string[] = []
    for (const c of columns) {
      if (typeof c !== 'string' || !allowed.has(c)) {
        throw new BadRequestError(`Unknown column "${String(c)}" of "${collection.slug}".`)
      }
      if (!out.includes(c)) out.push(c)
    }
    return out
  }

  function assertViewName(name: unknown): string {
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new BadRequestError('A view `name` is required.')
    }
    if (name.length > VIEW_NAME_MAX) {
      throw new BadRequestError(`A view name must be at most ${VIEW_NAME_MAX} characters.`)
    }
    return name.trim()
  }

  async function saveView(opts: SaveViewOptions): Promise<ViewDoc> {
    if (!config.views.enabled) {
      throw new BadRequestError('Saved views are not enabled (set `config.views`).')
    }
    const collection = collectionOrThrow(opts.collection)
    const req = buildReq(opts.req)
    const override = opts.overrideAccess ?? false

    // A view must be attributable to a principal — anonymous callers can't save one.
    if (!override && !req.user) throw new UnauthorizedError('Authentication is required to save a view.')
    // You can only build a view for a collection you can READ.
    await assertCanReadCollection(collection, req, override)

    const name = assertViewName(opts.name)
    // Validate the stored filter/sort/columns against the collection up front — a malformed
    // preset is rejected at save, never silently stored to fail (or escalate) on apply.
    assertWhereFields(collection, opts.where)
    assertSortFields(collection, opts.sort)
    const columns = sanitizeViewColumns(collection, opts.columns)

    const me = principalOf(req)
    const id = randomUUID()
    const created = await db.create({
      collection: VIEWS_TABLE,
      data: {
        id,
        collection: collection.slug,
        name,
        where: opts.where ?? null,
        sort: opts.sort ?? null,
        columns,
        // The owner is the trusted principal, NEVER a client-supplied value. Under override
        // (a trusted server call) there's no human owner → null (a system/global view).
        ownerId: override ? null : me.id,
        shared: opts.shared === true,
      },
    })

    await recordAudit({
      action: 'view.create',
      collection: collection.slug,
      documentId: String(created.id),
      req,
      overrideAccess: override,
      meta: { viewId: String(created.id), shared: opts.shared === true },
    })

    return rowToView(created)
  }

  /** Whether the caller may SEE a view: its owner, or a `shared` view on a collection the
   *  caller can currently read. A trusted (override) call sees everything. */
  async function canSeeView(row: Row, req: RequestContext, override: boolean): Promise<boolean> {
    if (override) return true
    const me = principalOf(req)
    if (row.ownerId != null && String(row.ownerId) === me.id) return true
    if (row.shared !== true) return false
    const collection = config.collectionsBySlug[String(row.collection)]
    if (!collection) return false
    const access = await evalAccess(collection.access?.read, { req })
    return isAllowed(access)
  }

  async function listViews(opts: ListViewsOptions = {}): Promise<ViewDoc[]> {
    if (!config.views.enabled) return []
    const req = buildReq(opts.req)
    const override = opts.overrideAccess ?? false
    if (opts.collection != null) collectionOrThrow(opts.collection) // validate slug if given

    const and: Where[] = []
    if (opts.collection != null) and.push({ collection: { equals: String(opts.collection) } })
    const res = await db.find({
      collection: VIEWS_TABLE,
      where: and.length ? { and } : undefined,
      sort: [{ field: 'createdAt', direction: 'desc' }],
      limit: MAX_LIMIT,
      page: 1,
    })
    // Filter to what the caller may see (own + shared-on-readable-collection). Done in code
    // because visibility depends on the live per-collection read rule, not a static column.
    const out: ViewDoc[] = []
    for (const row of res.docs) {
      if (await canSeeView(row, req, override)) out.push(rowToView(row))
    }
    return out
  }

  async function getView(opts: GetViewOptions): Promise<ViewDoc | null> {
    if (!config.views.enabled) return null
    const req = buildReq(opts.req)
    const override = opts.overrideAccess ?? false
    const row = await viewRowById(opts.viewId)
    if (!row) return null
    if (!(await canSeeView(row, req, override))) return null
    return rowToView(row)
  }

  /** Whether the caller may MUTATE a view (update/delete): its owner, or an admin. A shared
   *  view is still owned — sharing grants visibility, never edit rights. */
  function canEditView(row: Row, req: RequestContext, override: boolean): boolean {
    if (override) return true
    const me = principalOf(req)
    if (row.ownerId != null && String(row.ownerId) === me.id) return true
    return isAdminPrincipal(req)
  }

  async function updateView(opts: UpdateViewOptions): Promise<ViewDoc> {
    if (!config.views.enabled) {
      throw new BadRequestError('Saved views are not enabled (set `config.views`).')
    }
    const req = buildReq(opts.req)
    const override = opts.overrideAccess ?? false
    const row = await viewRowById(opts.viewId)
    // Invisible views are indistinguishable from missing ones (NotFound, no existence oracle);
    // a view the caller CAN see but doesn't own gets a clear Forbidden.
    if (!row || !(await canSeeView(row, req, override))) throw new NotFoundError()
    if (!canEditView(row, req, override)) {
      throw new ForbiddenError('Only the view owner or an admin can update this view.')
    }
    const collection = collectionOrThrow(String(row.collection))

    const data: Row = {}
    if (opts.name !== undefined) data.name = assertViewName(opts.name)
    if (opts.where !== undefined) {
      assertWhereFields(collection, opts.where ?? undefined)
      data.where = opts.where ?? null
    }
    if (opts.sort !== undefined) {
      assertSortFields(collection, opts.sort)
      data.sort = opts.sort ?? null
    }
    if (opts.columns !== undefined) data.columns = sanitizeViewColumns(collection, opts.columns)
    if (opts.shared !== undefined) data.shared = opts.shared === true

    if (Object.keys(data).length > 0) {
      await db.update({ collection: VIEWS_TABLE, id: String(row.id), data })
    }
    await recordAudit({
      action: 'view.update',
      collection: collection.slug,
      documentId: String(row.id),
      req,
      overrideAccess: override,
      meta: { viewId: String(row.id) },
    })
    const saved = await db.findByID({ collection: VIEWS_TABLE, id: String(row.id) })
    return rowToView(saved ?? row)
  }

  async function deleteView(opts: DeleteViewOptions): Promise<{ id: string }> {
    if (!config.views.enabled) {
      throw new BadRequestError('Saved views are not enabled (set `config.views`).')
    }
    const req = buildReq(opts.req)
    const override = opts.overrideAccess ?? false
    const row = await viewRowById(opts.viewId)
    if (!row || !(await canSeeView(row, req, override))) throw new NotFoundError()
    if (!canEditView(row, req, override)) {
      throw new ForbiddenError('Only the view owner or an admin can delete this view.')
    }
    await db.delete({ collection: VIEWS_TABLE, id: String(row.id) })
    await recordAudit({
      action: 'view.delete',
      collection: String(row.collection),
      documentId: String(row.id),
      req,
      overrideAccess: override,
      meta: { viewId: String(row.id) },
    })
    return { id: String(row.id) }
  }

  async function applyView<T extends Doc = Doc>(opts: ApplyViewOptions): Promise<PaginatedResult<T>> {
    if (!config.views.enabled) {
      throw new BadRequestError('Saved views are not enabled (set `config.views`).')
    }
    const req = buildReq(opts.req)
    const override = opts.overrideAccess ?? false
    const row = await viewRowById(opts.viewId)
    if (!row) throw new NotFoundError()
    // Visibility gate: you can only apply a view you can see (own or shared-on-readable).
    if (!(await canSeeView(row, req, override))) throw new NotFoundError()

    const collection = collectionOrThrow(String(row.collection))
    const view = rowToView(row)
    // Re-validate the stored filter/sort at apply time too (defence in depth: the schema may
    // have drifted since save, or the row could have been tampered with out-of-band).
    assertWhereFields(collection, view.where ?? undefined)
    assertSortFields(collection, view.sort)

    // The view's stored where, AND-combined with any extra caller filter (further narrows).
    const where = mergeWhere(view.where ?? undefined, opts.where)
    // Caller's per-application sort overrides the stored one; else use the saved sort.
    const sort = opts.sort ?? view.sort ?? undefined

    // Run the NORMAL access-checked find — the read rule + row-scope are AND-combined there,
    // so a saved view can only ever narrow results within the caller's access, never widen.
    return find<T>({
      collection: collection.slug,
      ...(where ? { where } : {}),
      ...(sort != null ? { sort } : {}),
      ...(opts.draft !== undefined ? { draft: opts.draft } : {}),
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      ...(opts.page !== undefined ? { page: opts.page } : {}),
      req: opts.req,
      overrideAccess: override,
    })
  }

  // -------------------------------------------------------------------------
  // Saved-search alerts / content subscriptions
  //
  // A subscription is a standing (collection + where) query owned by a principal. The drain
  // reads the change feed since the subscription's cursor and, for each change, RE-LOADS the
  // document AS THE OWNER (the access-checked read) and matches it against the stored `where`
  // — so an alert only ever fires for content the owner can currently read, and the webhook
  // payload is field-access-stripped + encrypted-field-redacted exactly like a normal read.
  // -------------------------------------------------------------------------

  function rowToSubscription(row: Row): SubscriptionDoc {
    return {
      id: String(row.id),
      ownerId: row.ownerId == null ? null : String(row.ownerId),
      ownerType: normalizePrincipalType(row.ownerType),
      collection: String(row.collection),
      where: (row.where ?? null) as Where | null,
      webhook: String(row.webhook),
      active: row.active === true,
      lastSeq: Number(row.lastSeq ?? 0),
      createdAt: String(row.createdAt),
      updatedAt: String(row.updatedAt),
    }
  }

  /** The highest change-feed seq right now (a new subscription starts from here, so it never
   *  back-fills the entire history on its first drain). */
  async function currentMaxChangeSeq(): Promise<number> {
    const res = await db.find({
      collection: CHANGES_TABLE,
      sort: [{ field: 'seq', direction: 'desc' }],
      limit: 1,
      page: 1,
    })
    return res.docs.length ? Number(res.docs[0]!.seq ?? 0) : 0
  }

  async function createSubscription(opts: CreateSubscriptionOptions): Promise<SubscriptionDoc> {
    if (!config.subscriptions.enabled) {
      throw new BadRequestError('Saved-search alerts are not enabled (set `config.subscriptions`).')
    }
    const collection = collectionOrThrow(opts.collection)
    const req = buildReq(opts.req)
    const override = opts.overrideAccess ?? false
    if (!override && !req.user) throw new UnauthorizedError('Authentication is required to subscribe.')
    // You can only subscribe to a collection you can READ.
    await assertCanReadCollection(collection, req, override)
    // Validate the standing filter up front (rejected here, never silently stored to fail).
    assertWhereFields(collection, opts.where)
    // The delivery target must be a configured webhook.
    const webhook = String(opts.webhook ?? '')
    if (!config.webhooks.some((w) => w.slug === webhook)) {
      throw new BadRequestError(`Unknown webhook "${webhook}" — configure it in \`config.webhooks\`.`)
    }

    const me = principalOf(req)
    const id = randomUUID()
    const created = await db.create({
      collection: SUBSCRIPTIONS_TABLE,
      data: {
        id,
        // Owner is the trusted principal, never client input; the owner's roles are
        // snapshotted so the drain can re-evaluate the read access as the owner. A claim NOT
        // captured (e.g. a tenant) fails CLOSED on the drain (under-notify). The snapshot is
        // point-in-time: a role REMOVED after subscribing stays in the snapshot until the
        // subscription is recreated (a bounded, owner-only over-notify window — no cross-user
        // leak, since the doc is still re-loaded through the live read rule).
        ownerId: override ? null : me.id,
        ownerType: override ? 'system' : me.type,
        ownerRoles: override ? [] : (req.user?.roles ?? []),
        collection: collection.slug,
        where: opts.where ?? null,
        webhook,
        active: true,
        // Start from "now" so the first drain doesn't back-fill the whole history.
        lastSeq: await currentMaxChangeSeq(),
      },
    })
    await recordAudit({
      action: 'subscription.create',
      collection: collection.slug,
      documentId: String(created.id),
      req,
      overrideAccess: override,
      meta: { subscriptionId: String(created.id), webhook },
    })
    return rowToSubscription(created)
  }

  async function listSubscriptions(opts: ListSubscriptionsOptions = {}): Promise<SubscriptionDoc[]> {
    if (!config.subscriptions.enabled) return []
    const req = buildReq(opts.req)
    const override = opts.overrideAccess ?? false
    const me = principalOf(req)
    const and: Where[] = []
    // Owner-scoped: you see only your OWN subscriptions (an override/admin call sees all).
    if (!override) and.push({ ownerId: { equals: me.id } })
    if (opts.collection != null) and.push({ collection: { equals: String(opts.collection) } })
    const res = await db.find({
      collection: SUBSCRIPTIONS_TABLE,
      where: and.length ? { and } : undefined,
      sort: [{ field: 'createdAt', direction: 'desc' }],
      limit: MAX_LIMIT,
      page: 1,
    })
    return res.docs.map(rowToSubscription)
  }

  async function deleteSubscription(opts: DeleteSubscriptionOptions): Promise<{ id: string }> {
    if (!config.subscriptions.enabled) {
      throw new BadRequestError('Saved-search alerts are not enabled (set `config.subscriptions`).')
    }
    const req = buildReq(opts.req)
    const override = opts.overrideAccess ?? false
    const { subscriptionId } = opts
    if (
      typeof subscriptionId !== 'string' ||
      subscriptionId.length === 0 ||
      COMMENT_FORBIDDEN_KEYS.has(subscriptionId)
    ) {
      throw new BadRequestError('A valid `subscriptionId` is required.')
    }
    const row = await db.findByID({ collection: SUBSCRIPTIONS_TABLE, id: subscriptionId })
    if (!row) throw new NotFoundError()
    // Only the owner (or an admin / override) may delete it.
    const me = principalOf(req)
    const isOwner = row.ownerId != null && String(row.ownerId) === me.id
    if (!override && !isOwner && !isAdminPrincipal(req)) {
      throw new ForbiddenError('Only the subscription owner or an admin can delete it.')
    }
    await db.delete({ collection: SUBSCRIPTIONS_TABLE, id: subscriptionId })
    await recordAudit({
      action: 'subscription.delete',
      collection: String(row.collection),
      documentId: subscriptionId,
      req,
      overrideAccess: override,
      meta: { subscriptionId },
    })
    return { id: subscriptionId }
  }

  async function processSubscriptions(opts: ProcessSubscriptionsOptions = {}): Promise<ProcessSubscriptionsResult> {
    if (!config.subscriptions.enabled) return { scanned: 0, delivered: 0 }
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), MAX_LIMIT)
    const subs = await db.find({
      collection: SUBSCRIPTIONS_TABLE,
      where: { active: { equals: true } },
      limit: MAX_LIMIT,
      page: 1,
    })
    let delivered = 0
    let scanned = 0

    for (const subRow of subs.docs) {
      const sub = rowToSubscription(subRow)
      // A subscription with no owner can't be re-evaluated against an access rule — skip it
      // (fail closed).
      if (!sub.ownerId) continue
      scanned++
      const collection = config.collectionsBySlug[sub.collection]
      if (!collection) continue

      // Rebuild the owner's request context from the snapshot (id + kind + roles). The reload
      // below runs the LIVE read rule, so this never over-notifies for an id/row-scoped rule;
      // an uncaptured claim (e.g. tenant) makes that rule deny → under-notify.
      const ownerReq = {
        user: {
          id: sub.ownerId,
          principalType: sub.ownerType,
          roles: Array.isArray(subRow.ownerRoles) ? (subRow.ownerRoles as string[]) : [],
        },
      } as Partial<RequestContext>

      const changes = await db.find({
        collection: CHANGES_TABLE,
        where: { and: [{ seq: { greater_than: sub.lastSeq } }, { collection: { equals: sub.collection } }] },
        sort: [{ field: 'seq', direction: 'asc' }],
        limit,
        page: 1,
      })

      const encrypted = encryptedFieldNames(collection)
      let maxSeq = sub.lastSeq
      for (const ch of changes.docs) {
        const seq = Number(ch.seq ?? 0)
        if (seq > maxSeq) maxSeq = seq
        const event = String(ch.event)
        const documentId = String(ch.documentId)
        // Deletes have no live row to match a `where` against — skip (no notification).
        if (event === 'delete') continue

        // Reload AS THE OWNER (access-checked + field-stripped). Returns null if the owner
        // can't read it (or it's gone) → no alert.
        let doc: Doc | null = null
        try {
          doc = await findByID({ collection: sub.collection, id: documentId, req: ownerReq })
        } catch {
          doc = null
        }
        if (!doc) continue
        if (!matchesWhere(doc, sub.where ?? undefined)) continue

        // Redact encrypted fields from the delivered payload (their plaintext must not egress).
        let payloadDoc: Doc = doc
        if (encrypted.length > 0) {
          payloadDoc = { ...doc }
          for (const name of encrypted) delete payloadDoc[name]
        }
        const payload: WebhookPayload = {
          event: event as WebhookPayload['event'],
          collection: sub.collection,
          id: documentId,
          doc: payloadDoc,
          timestamp: Date.now(),
        }
        await db.create({
          collection: WEBHOOK_DELIVERIES_TABLE,
          data: {
            id: randomUUID(),
            webhook: sub.webhook,
            event,
            collection: sub.collection,
            documentId,
            payload,
            status: 'pending',
            attempts: 0,
            lastStatus: null,
            nextAttemptAt: new Date().toISOString(),
            deliveredAt: null,
          },
        })
        delivered++
      }

      if (maxSeq > sub.lastSeq) {
        await db.update({ collection: SUBSCRIPTIONS_TABLE, id: sub.id, data: { lastSeq: maxSeq } })
      }
    }
    return { scanned, delivered }
  }

  // -------------------------------------------------------------------------
  // Provenance + content credentials (read/verify surface)
  // -------------------------------------------------------------------------

  /**
   * Access-check a READ on a document before exposing provenance/credential data about
   * it. Returns the collection when the caller may read the doc; throws Forbidden when
   * not, and NotFound when the document doesn't exist. Drafts are visible to this gate
   * (a draft still has provenance), but the row-scope + field access of the read path
   * still apply — so provenance never leaks for a doc the caller couldn't read.
   */
  async function assertCanReadDoc(
    collection: CollectionConfig,
    id: string,
    req: RequestContext,
    override: boolean,
  ): Promise<void> {
    if (override) {
      const row = await db.findByID({ collection: collection.slug, id })
      if (!row) throw new NotFoundError()
      return
    }
    const row = await db.findByID({ collection: collection.slug, id })
    if (!row) throw new NotFoundError()
    const access = await evalAccess(collection.access?.read, { req, id })
    if (!isAllowed(access)) throw new ForbiddenError()
    const scope = asWhere(access)
    if (scope && !matchesWhere(row, scope)) throw new ForbiddenError()
  }

  async function provenance(opts: ProvenanceOptions): Promise<Provenance> {
    const collection = collectionOrThrow(opts.collection)
    const req = buildReq(opts.req)
    const override = opts.overrideAccess ?? false
    // Never leak provenance for a doc the caller can't read.
    await assertCanReadDoc(collection, opts.id, req, override)

    const chain: ProvenanceEntry[] = []
    let createdBy: PrincipalRef | null = null
    let lastEditedBy: PrincipalRef | null = null
    const contributors: PrincipalRef[] = []
    const seen = new Set<string>()

    if (versionsOf(collection).enabled) {
      // Oldest-first: version 1 is the create, the last is the latest edit.
      const res = await db.find({
        collection: tableForVersions(collection.slug),
        where: { parent: { equals: opts.id } },
        sort: [{ field: 'createdAt', direction: 'asc' }],
        limit: MAX_LIMIT,
        page: 1,
      })
      let n = 0
      for (const v of res.docs) {
        n += 1
        const author: PrincipalRef = {
          id: v.createdBy != null ? String(v.createdBy) : null,
          type: normalizePrincipalType(v.createdByType),
        }
        const entry: ProvenanceEntry = {
          version: n,
          status: typeof v.status === 'string' ? v.status : 'draft',
          at: v.createdAt != null ? String(v.createdAt) : '',
          author,
          autosave: v.autosave === true,
        }
        if (v.approvedBy != null || v.approvedByType != null) {
          entry.approver = {
            id: v.approvedBy != null ? String(v.approvedBy) : null,
            type: normalizePrincipalType(v.approvedByType),
          }
        }
        chain.push(entry)
        if (n === 1) createdBy = author
        lastEditedBy = author
        const key = `${author.type}:${author.id ?? ''}`
        if (!seen.has(key)) {
          seen.add(key)
          contributors.push(author)
        }
      }
    }

    return { documentId: opts.id, collection: collection.slug, chain, createdBy, lastEditedBy, contributors }
  }

  /** A single, time-ordered activity feed for one document. Gated on the document's READ
   *  access; versions + comments are shown to any reader, while the reviewer-only sources
   *  (audit, reviews) are added only for a reviewer principal — so the feed never leaks
   *  audit/review detail to a non-reviewer. */
  async function documentActivity(opts: DocumentActivityOptions): Promise<DocumentActivityResult> {
    const collection = collectionOrThrow(opts.collection)
    const req = buildReq(opts.req)
    const override = opts.overrideAccess ?? false
    // The whole feed is gated on reading the document (throws Forbidden/NotFound — no leak).
    await assertCanReadDoc(collection, opts.id, req, override)

    const docId = String(opts.id)
    const isReviewer = override || isReviewerPrincipal(req)
    const want = (t: DocumentActivityType): boolean => !opts.types || opts.types.includes(t)
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500)
    const events: DocumentActivityEvent[] = []

    // Versions (any reader; field-stripped + doc-read-gated by `history`).
    if (want('version') && versionsOf(collection).enabled) {
      for (const h of await history({
        collection: collection.slug,
        id: docId,
        req: opts.req,
        overrideAccess: override,
      })) {
        events.push({
          type: 'version',
          at: h.at,
          actor: { id: h.by, type: h.byType },
          action: h.autosave ? 'autosave' : h.status,
          data: { versionId: h.versionId, status: h.status, autosave: h.autosave, changedFields: h.changedFields },
        })
      }
    }

    // Comments (any reader; doc-read-gated by `listComments`). Include resolved for the feed.
    if (want('comment') && config.comments.enabled) {
      for (const c of await listComments({
        collection: collection.slug,
        id: docId,
        includeResolved: true,
        req: opts.req,
        overrideAccess: override,
      })) {
        events.push({
          type: 'comment',
          at: c.createdAt,
          actor: { id: c.authorId, type: c.authorType },
          action: 'comment',
          data: { commentId: c.id, body: c.body, field: c.field, resolved: c.resolved, parentId: c.parentId },
        })
      }
    }

    // Reviews + audit are reviewer-only (admin/editor) — omitted for a non-reviewer.
    if (isReviewer) {
      if (want('review') && config.review.enabled) {
        const reviewRows = await db.find({
          collection: REVIEWS_TABLE,
          where: { and: [{ collection: { equals: collection.slug } }, { documentId: { equals: docId } }] },
          sort: [{ field: 'at', direction: 'desc' }],
          limit,
          page: 1,
        })
        for (const r of reviewRows.docs) {
          events.push({
            type: 'review',
            at: r.at != null ? String(r.at) : '',
            actor: {
              id: r.reviewerId != null ? String(r.reviewerId) : null,
              type: normalizePrincipalType(r.reviewerType),
            },
            action: typeof r.decision === 'string' ? r.decision : 'review',
            data: { note: r.note != null ? String(r.note) : null },
          })
        }
      }
      if (want('audit') && config.audit.enabled) {
        const auditRows = await findAuditLog({
          where: { and: [{ collection: { equals: collection.slug } }, { documentId: { equals: docId } }] },
          limit,
        })
        for (const a of auditRows.docs) {
          events.push({
            type: 'audit',
            at: a.at,
            actor: { id: a.principalId, type: a.principalType },
            action: a.action,
            data: { fields: a.fields, meta: a.meta },
          })
        }
      }
    }

    // Newest-first, capped.
    events.sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0))
    return { events: events.slice(0, limit), includesReviewerEvents: isReviewer }
  }

  async function getContentCredential(opts: GetCredentialOptions): Promise<CredentialDoc | null> {
    const collection = collectionOrThrow(opts.collection)
    const req = buildReq(opts.req)
    const override = opts.overrideAccess ?? false
    await assertCanReadDoc(collection, opts.id, req, override)
    return latestCredentialRow(collection.slug, opts.id)
  }

  async function verifyContentCredential(opts: VerifyCredentialOptions): Promise<VerifyCredentialResult> {
    const collection = collectionOrThrow(opts.collection)
    const req = buildReq(opts.req)
    const override = opts.overrideAccess ?? false
    await assertCanReadDoc(collection, opts.id, req, override)

    const cred = await latestCredentialRow(collection.slug, opts.id)
    if (!cred) return { valid: false, reason: 'no content credential for this document', manifest: null }
    const manifest = cred.manifest as ContentManifest
    if (!signer) {
      // A credential exists but signing is now disabled — we can't re-verify it.
      return { valid: false, reason: 'signing is not enabled; cannot verify', manifest }
    }
    // Verify against the CURRENT stored row so a post-sign edit is detected. We hash the
    // RAW stored row (the same surface signed at publish), so this is locale-independent
    // and any direct mutation of the persisted content changes the hash. The doc's
    // READABILITY was already gated above.
    const row = await db.findByID({ collection: collection.slug, id: opts.id })
    if (!row) return { valid: false, reason: 'document no longer exists', manifest }
    const result = verifyManifest(signer, manifest, cred.signature, row as Record<string, unknown>)
    return { ...result, manifest }
  }

  /**
   * Deterministically bucket a visitor `key` into an experiment variant. The same key
   * always maps to the same variant (sticky), and the spread over many keys matches the
   * configured weights — see {@link bucketVariant}. ONLY the hash of the key is used or
   * (optionally) recorded; the raw visitor key is never stored (no PII at rest). The
   * returned `variant`/`segment` is an audience segment, so a caller sets
   * `req.audience = result.segment` to read that variant's personalized content.
   */
  function assignVariant(opts: AssignVariantOptions): AssignVariantResult {
    const experiment = config.experimentsBySlug[opts.experiment]
    if (!experiment) {
      throw new BadRequestError(`Unknown experiment "${opts.experiment}".`)
    }
    if (typeof opts.key !== 'string' || opts.key.length === 0) {
      throw new BadRequestError('`key` must be a non-empty string.')
    }
    const variant = bucketVariant(experiment, opts.key)
    // Record a metadata-only assignment when auditing is on — the HASH of the key, never
    // the raw key. Best-effort: an audit-write failure must never fail the assignment.
    if (config.audit.enabled) {
      void recordAudit({
        action: 'experiment.assign',
        principalType: 'system',
        meta: { experiment: experiment.slug, variant, keyHash: fnv1a32(opts.key).toString(16) },
      }).catch(() => {})
    }
    return { experiment: experiment.slug, variant, segment: variant }
  }

  return {
    create,
    assignVariant,
    upload,
    signedAssetUrl,
    find,
    findByID,
    update,
    updateLocales,
    translationStatus,
    translationStatusList,
    translateDocument,
    translateMissing,
    updateMany,
    delete: deleteOne,
    deleteMany,
    count,
    login,
    authenticate,
    createAPIKey,
    authenticateAPIKey,
    forgotPassword,
    resetPassword,
    verifyEmail,
    requestEmailVerification,
    setupTwoFactor,
    enableTwoFactor,
    disableTwoFactor,
    loginWithOAuth,
    findGlobal,
    updateGlobal,
    findVersions,
    restoreVersion,
    history,
    documentActivity,
    diffVersions,
    restoreAsOf,
    publish,
    unpublish,
    processScheduledPublishes,
    processContentLifecycle,
    findAuditLog,
    recordAudit,
    enqueue,
    runDueJobs,
    findRoles,
    createRole,
    updateRole,
    deleteRole,
    findReviewQueue,
    submitReview,
    addComment,
    listComments,
    resolveComment,
    deleteComment,
    commentCount,
    saveView,
    listViews,
    getView,
    updateView,
    deleteView,
    applyView,
    createSubscription,
    listSubscriptions,
    deleteSubscription,
    processSubscriptions,
    processWebhooks,
    listWebhooks,
    webhookDeliveries,
    retryWebhookDelivery,
    createRelease,
    addToRelease,
    removeFromRelease,
    listReleases,
    getRelease,
    previewRelease,
    publishRelease,
    scheduleRelease,
    cancelRelease,
    processScheduledReleases,
    composePage,
    listTemplates,
    createFromTemplate,
    acquireLock,
    releaseLock,
    getLock,
    listLocks,
    heartbeat,
    getPresence,
    provenance,
    getContentCredential,
    verifyContentCredential,
  }
}

export type Operations = ReturnType<typeof createOperations>
