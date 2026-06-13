import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { DatabaseAdapter, PaginatedResult, Row, SortSpec, Where } from '@kernel/db'
import { extForFormat, generateKey, isContentTypeConsistent, sniffMimeType, type StorageAdapter } from '@kernel/storage'
import type {
  AuthResult,
  AuthUser,
  CollectionConfig,
  ConfigField,
  CountOptions,
  CreateOptions,
  DeleteOptions,
  Doc,
  FindByIDOptions,
  FindGlobalOptions,
  FindOptions,
  FindVersionsOptions,
  ForgotPasswordOptions,
  GlobalConfig,
  LoginOptions,
  VerifyOptions,
  PublishOptions,
  RequestContext,
  RestoreVersionOptions,
  BulkResult,
  CreateAPIKeyOptions,
  DeleteManyOptions,
  EnqueueOptions,
  ProcessScheduledOptions,
  RunJobsOptions,
  RunJobsResult,
  SanitizedConfig,
  UpdateGlobalOptions,
  UpdateManyOptions,
  UpdateOptions,
  UploadConfig,
  UploadDocOptions,
  VersionDoc,
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
} from './fields'
import { evalAccess, isAllowed, asWhere } from './access'
import { JOBS_SLUG } from './config'
import { matchesWhere, mergeWhere, parseSort } from './query'
import { GLOBAL_ROW_ID, resolveVersions, tableForGlobal, tableForVersions } from './schema'

export interface OperationCtx {
  config: SanitizedConfig
  db: DatabaseAdapter
}

const MAX_LIMIT = 1000
const DEFAULT_LIMIT = 25

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
  const { config, db } = ctx

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

  function buildReq(partial?: Partial<RequestContext>): RequestContext {
    const defaultLocale = config.localization ? config.localization.defaultLocale : 'en'
    const fallback = config.localization
      ? config.localization.fallback
        ? config.localization.defaultLocale
        : false
      : false
    return {
      user: partial?.user ?? null,
      locale: partial?.locale ?? defaultLocale,
      fallbackLocale: partial?.fallbackLocale ?? fallback,
      context: partial?.context ?? {},
    }
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

  function rowToDoc(collection: CollectionConfig, row: Row, req: RequestContext): Doc {
    const body = deserializeDoc(collection.fields, row, {
      locale: req.locale,
      fallbackLocale: req.fallbackLocale,
    })
    const doc: Doc = { id: String(row.id), ...body }
    if (row.createdAt !== undefined) doc.createdAt = row.createdAt
    if (row.updatedAt !== undefined) doc.updatedAt = row.updatedAt
    if (row._status !== undefined) doc._status = row._status
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
    for (const f of storageFields(collection.fields)) set.add(f.name)
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
    const walk = (node: Where): void => {
      for (const [key, value] of Object.entries(node)) {
        if (key === 'and' || key === 'or') {
          if (Array.isArray(value)) for (const sub of value) walk(sub as Where)
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
    walk(where)
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
  }

  /** Append a snapshot of `doc` to the collection's version table, trimming to maxPerDoc. */
  async function snapshotVersion(
    collection: CollectionConfig,
    doc: Doc,
    status: 'draft' | 'published',
    req: RequestContext,
    autosave = false,
  ): Promise<void> {
    const v = versionsOf(collection)
    if (!v.enabled) return
    const table = tableForVersions(collection.slug)
    await db.create({
      collection: table,
      data: {
        id: randomUUID(),
        parent: String(doc.id),
        version: doc,
        status,
        autosave,
        createdBy: req.user?.id ?? null,
        // Attribute the snapshot to the principal kind so "review agent changes" is
        // queryable; humans (and system/override writes) record 'user'.
        createdByType: req.user?.principalType ?? 'user',
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
    if (!override) {
      for (const v of result.docs) {
        if (v.version && typeof v.version === 'object') {
          await applyReadFieldAccess(collection.fields, v.version as Row, req, opts.id)
        }
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
    const content = (vrow.version ?? {}) as Row
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

  async function publish<T extends Doc = Doc>(opts: PublishOptions): Promise<T | null> {
    const collection = collectionOrThrow(opts.collection)
    if (!draftsOn(collection))
      throw new BadRequestError(`Collection "${opts.collection}" does not have drafts enabled.`)
    // A future `publishAt` schedules the publish (stays a draft until then);
    // otherwise publish immediately and clear any pending schedule.
    const at = opts.publishAt ? new Date(opts.publishAt) : null
    const scheduled = at && !Number.isNaN(at.getTime()) && at.getTime() > Date.now()
    return update<T>({
      collection: opts.collection,
      id: opts.id,
      data: scheduled
        ? ({ _status: 'draft', _scheduled_at: at.toISOString() } as Row)
        : ({ _status: 'published', _scheduled_at: null } as Row),
      req: opts.req,
      overrideAccess: opts.overrideAccess,
      depth: opts.depth,
    })
  }

  /** Publish all drafts whose scheduled time has arrived. Drive from a cron/job. */
  async function processScheduledPublishes(opts: ProcessScheduledOptions = {}): Promise<{ published: string[] }> {
    const nowIso = (opts.now ? new Date(opts.now) : new Date()).toISOString()
    const published: string[] = []
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
        await update({
          collection: collection.slug,
          id: String(row.id),
          data: { _status: 'published', _scheduled_at: null } as Row,
          overrideAccess: true,
        })
        published.push(String(row.id))
      }
    }
    return { published }
  }

  async function unpublish<T extends Doc = Doc>(opts: PublishOptions): Promise<T | null> {
    const collection = collectionOrThrow(opts.collection)
    if (!draftsOn(collection))
      throw new BadRequestError(`Collection "${opts.collection}" does not have drafts enabled.`)
    return update<T>({
      collection: opts.collection,
      id: opts.id,
      data: { _status: 'draft' } as Row,
      req: opts.req,
      overrideAccess: opts.overrideAccess,
      depth: opts.depth,
    })
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

    const row = serializeDoc(collection.fields, data, { locale: req.locale })
    row.id = randomUUID()
    if (draftsOn(collection)) {
      row._status = statusFromData(opts.data as Row, 'draft')
      // Born-published: a new doc whose status is 'published' is a publish transition.
      if (!override && row._status === 'published') await assertCanPublish(collection, req, undefined, opts.data as Row)
      // Agent draft-only brake, scheduled-publish variant: a non-null `_scheduled_at` on
      // create schedules a publish processScheduledPublishes() runs under override — a
      // publish by proxy. An agent can never schedule one (mirrors the update() guard).
      const sched = (opts.data as Row)._scheduled_at
      if (!override && sched != null && req.user?.principalType === 'agent') throw new ForbiddenError()
    }

    const created = await db.create({ collection: collection.slug, data: row })
    let doc = rowToDoc(collection, created, req)
    if (versionsOf(collection).enabled) {
      const status = draftsOn(collection) ? statusFromData(created as Row, 'draft') : 'published'
      await snapshotVersion(collection, rowToDoc(collection, created, req), status, req)
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

  async function update<T extends Doc = Doc>(opts: UpdateOptions): Promise<T | null> {
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

    const filtered: Row = { ...opts.data }
    if (!override) await applyFieldAccess(collection.fields, filtered, 'update', req, opts.id)
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
    const row = serializeDoc(collection.fields, merged, { locale: req.locale, existingRow: existing })
    if (draftsOn(collection)) {
      row._status = statusFromData(opts.data as Row, (existing._status as string) ?? 'draft')
      // Publish transition: becoming published when not already. Covers publish()→update(),
      // a raw PATCH `{ _status: 'published' }`, and restoreVersion of a published snapshot.
      if (!override && row._status === 'published' && existing._status !== 'published') {
        await assertCanPublish(collection, req, opts.id, opts.data as Row)
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
    }
    const updated = await db.update({ collection: collection.slug, id: opts.id, data: row })
    if (!updated) return null

    let doc = rowToDoc(collection, updated, req)
    if (versionsOf(collection).enabled) {
      const status = draftsOn(collection) ? statusFromData(updated as Row, 'draft') : 'published'
      await snapshotVersion(collection, rowToDoc(collection, updated, req), status, req, opts.autosave === true)
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
    if (doc) for (const hook of collection.hooks?.afterDelete ?? []) await hook({ req, id: opts.id, doc })
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
  }): Promise<AuthResult> {
    const collection = collectionOrThrow(opts.collection)
    if (!collection.auth) throw new BadRequestError(`Collection "${opts.collection}" is not an auth collection.`)
    const provider = (config.oauth ?? []).find((p) => p.name === opts.provider)
    if (!provider) throw new BadRequestError(`No OAuth provider "${opts.provider}" is configured.`)

    const profile = await provider.exchangeCode({ code: opts.code, redirectUri: opts.redirectUri })
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
      return deserializeDoc(global.fields, defaults, {
        locale: req.locale,
        fallbackLocale: req.fallbackLocale,
      })
    }
    const body = deserializeDoc(global.fields, row, {
      locale: req.locale,
      fallbackLocale: req.fallbackLocale,
    })
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
    const row = serializeDoc(global.fields, merged, { locale: req.locale, existingRow: existing })
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

  return {
    create,
    upload,
    find,
    findByID,
    update,
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
    publish,
    unpublish,
    processScheduledPublishes,
    enqueue,
    runDueJobs,
  }
}

export type Operations = ReturnType<typeof createOperations>
