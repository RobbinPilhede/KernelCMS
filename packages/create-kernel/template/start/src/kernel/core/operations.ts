import { randomUUID } from 'node:crypto'
import type { DatabaseAdapter, PaginatedResult, Row, SortSpec } from '@kernel/db'
import type {
  AnyField,
  AuthResult,
  AuthUser,
  CollectionConfig,
  CountOptions,
  CreateOptions,
  DeleteOptions,
  Doc,
  FindByIDOptions,
  FindGlobalOptions,
  FindOptions,
  GlobalConfig,
  LoginOptions,
  RequestContext,
  SanitizedConfig,
  UpdateGlobalOptions,
  UpdateOptions,
} from './types'
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  TooManyRequestsError,
  UnauthorizedError,
  ValidationError,
  isKernelError,
} from './errors'
import { hashPassword, signToken, verifyPassword, verifyToken } from './auth'
import {
  applyDefaults,
  deserializeDoc,
  relationshipFields,
  serializeDoc,
  validateFields,
} from './fields'
import { evalAccess, isAllowed, asWhere } from './access'
import { matchesWhere, mergeWhere, parseSort } from './query'
import { GLOBAL_ROW_ID, tableForGlobal } from './schema'

export interface OperationCtx {
  config: SanitizedConfig
  db: DatabaseAdapter
}

const MAX_LIMIT = 1000
const DEFAULT_LIMIT = 25

// Login brute-force protection. A per-identifier failure counter with a sliding
// window: too many failures within the window locks further attempts until it
// elapses. In-memory and per-process — adequate for a single node; a multi-node
// deployment should front this with a shared store (Redis) via a future adapter.
const LOGIN_MAX_FAILURES = 10
const LOGIN_WINDOW_MS = 15 * 60 * 1000

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
    fields: AnyField[],
    data: Row,
    operation: 'create' | 'update',
    req: RequestContext,
    id?: string,
  ): Promise<void> {
    for (const field of fields) {
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
    if (collection.auth) delete doc.hash
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
  ): Promise<Row> {
    if (!collection.auth) return data
    const next: Row = { ...data }
    delete next.hash
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

  async function populate(
    collection: CollectionConfig,
    doc: Doc,
    depth: number,
    req: RequestContext,
  ): Promise<Doc> {
    if (depth <= 0) return doc
    for (const rel of relationshipFields(collection.fields)) {
      if (!config.collectionsBySlug[rel.relationTo]) continue
      const value = doc[rel.name]
      if (rel.hasMany && Array.isArray(value)) {
        const out: unknown[] = []
        for (const id of value) {
          const related = await safeFindByID(rel.relationTo, String(id), depth - 1, req)
          out.push(related ?? id)
        }
        doc[rel.name] = out
      } else if (!rel.hasMany && value != null) {
        const related = await safeFindByID(rel.relationTo, String(value), depth - 1, req)
        doc[rel.name] = related ?? value
      }
    }
    return doc
  }

  async function safeFindByID(
    slug: string,
    id: string,
    depth: number,
    req: RequestContext,
  ): Promise<Doc | null> {
    try {
      return await findByID({ collection: slug, id, depth, req })
    } catch (err) {
      if (isKernelError(err)) return null
      throw err
    }
  }

  // -------------------------------------------------------------------------
  // Collection operations
  // -------------------------------------------------------------------------

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
    data = await prepareAuthInput(collection, data, 'create')
    data = await runHooks(collection.hooks?.beforeChange, { req, operation: 'create', data }, 'data')

    const errors = await validateFields(collection.fields, data, { req, operation: 'create' })
    if (errors.length) throw new ValidationError(errors)

    const row = serializeDoc(collection.fields, data, { locale: req.locale })
    row.id = randomUUID()

    const created = await db.create({ collection: collection.slug, data: row })
    let doc = rowToDoc(collection, created, req)
    doc = (await runHooks(collection.hooks?.afterChange, { req, operation: 'create', doc }, 'doc')) as Doc
    doc = (await runHooks(collection.hooks?.afterRead, { req, operation: 'read', doc }, 'doc')) as Doc
    doc = await populate(collection, doc, opts.depth ?? 0, req)
    return doc as T
  }

  async function find<T extends Doc = Doc>(opts: FindOptions): Promise<PaginatedResult<T>> {
    const collection = collectionOrThrow(opts.collection)
    const req = buildReq(opts.req)
    const override = opts.overrideAccess ?? false

    let where = opts.where
    if (!override) {
      const access = await evalAccess(collection.access?.read, { req })
      if (!isAllowed(access)) throw new ForbiddenError()
      where = mergeWhere(where, asWhere(access))
    }

    const timestamps = collection.timestamps ?? true
    const sort: SortSpec[] = parseSort(opts.sort)
    if (sort.length === 0) {
      sort.push(timestamps ? { field: 'createdAt', direction: 'desc' } : { field: 'id', direction: 'asc' })
    }

    const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
    const page = Math.max(opts.page ?? 1, 1)

    const result = await db.find({ collection: collection.slug, where, sort, limit, page })
    const docs: T[] = []
    for (const row of result.docs) {
      let doc = rowToDoc(collection, row, req)
      doc = (await runHooks(collection.hooks?.afterRead, { req, operation: 'read', doc }, 'doc')) as Doc
      doc = await populate(collection, doc, opts.depth ?? 0, req)
      docs.push(doc as T)
    }
    return { ...result, docs }
  }

  async function findByID<T extends Doc = Doc>(opts: FindByIDOptions): Promise<T | null> {
    const collection = collectionOrThrow(opts.collection)
    const req = buildReq(opts.req)
    const override = opts.overrideAccess ?? false

    const row = await db.findByID({ collection: collection.slug, id: opts.id })
    if (!row) return null

    if (!override) {
      const access = await evalAccess(collection.access?.read, { req, id: opts.id })
      if (!isAllowed(access)) throw new ForbiddenError()
      const scope = asWhere(access)
      if (scope && !matchesWhere(row, scope)) throw new ForbiddenError()
    }

    let doc = rowToDoc(collection, row, req)
    doc = (await runHooks(collection.hooks?.afterRead, { req, operation: 'read', doc }, 'doc')) as Doc
    doc = await populate(collection, doc, opts.depth ?? 0, req)
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
    const input = await prepareAuthInput(collection, filtered, 'update')
    const existingDoc = rowToDoc(collection, existing, req)
    let merged: Row = { ...existingDoc, ...input }
    merged = await runHooks(
      collection.hooks?.beforeChange,
      { req, operation: 'update', data: merged, originalDoc: existingDoc },
      'data',
    )

    const errors = await validateFields(collection.fields, merged, { req, operation: 'update' })
    if (errors.length) throw new ValidationError(errors)

    const row = serializeDoc(collection.fields, input, { locale: req.locale, existingRow: existing })
    const updated = await db.update({ collection: collection.slug, id: opts.id, data: row })
    if (!updated) return null

    let doc = rowToDoc(collection, updated, req)
    doc = (await runHooks(collection.hooks?.afterChange, { req, operation: 'update', doc }, 'doc')) as Doc
    doc = (await runHooks(collection.hooks?.afterRead, { req, operation: 'read', doc }, 'doc')) as Doc
    doc = await populate(collection, doc, opts.depth ?? 0, req)
    return doc as T
  }

  async function deleteOne<T extends Doc = Doc>(opts: DeleteOptions): Promise<T | null> {
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

    for (const hook of collection.hooks?.beforeDelete ?? []) await hook({ req, id: opts.id })
    const removed = await db.delete({ collection: collection.slug, id: opts.id })
    const doc = removed ? rowToDoc(collection, removed, req) : null
    if (doc) for (const hook of collection.hooks?.afterDelete ?? []) await hook({ req, id: opts.id, doc })
    return doc as T | null
  }

  async function count(opts: CountOptions): Promise<number> {
    const collection = collectionOrThrow(opts.collection)
    const req = buildReq(opts.req)
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
    const passwordOk =
      !!row && typeof row.hash === 'string' && (await verifyPassword(opts.password, row.hash))
    if (!row || !passwordOk) {
      recordLoginFailure(key)
      throw new UnauthorizedError('Invalid email or password.')
    }
    loginFailures.delete(key)
    const user = rowToDoc(collection, row, buildReq()) as AuthUser
    user.collection = collection.slug
    const ttl = authTtl(collection)
    const token = signToken({ sub: user.id, collection: collection.slug }, config.secret, ttl)
    return { user, token, exp: Math.floor(Date.now() / 1000) + ttl }
  }

  async function authenticate(token: string): Promise<AuthUser | null> {
    const payload = verifyToken(token, config.secret)
    if (!payload) return null
    const collection = config.collectionsBySlug[payload.collection]
    if (!collection?.auth) return null
    const row = await db.findByID({ collection: collection.slug, id: payload.sub })
    if (!row) return null
    const user = rowToDoc(collection, row, buildReq()) as AuthUser
    user.collection = collection.slug
    return user
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

    const errors = await validateFields(global.fields, merged, { req, operation: 'update' })
    if (errors.length) throw new ValidationError(errors)

    const row = serializeDoc(global.fields, incoming, { locale: req.locale, existingRow: existing })
    let saved: Row | null
    if (existing) {
      saved = await db.update({ collection: table, id: GLOBAL_ROW_ID, data: row })
    } else {
      row.id = GLOBAL_ROW_ID
      saved = await db.create({ collection: table, data: row })
    }
    let doc = globalDoc(global, saved, req)
    doc = await runHooks(global.hooks?.afterChange, { req, operation: 'update', doc }, 'doc')
    return doc as T
  }

  return { create, find, findByID, update, delete: deleteOne, count, login, authenticate, findGlobal, updateGlobal }
}

export type Operations = ReturnType<typeof createOperations>
