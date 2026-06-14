import { randomUUID } from 'node:crypto'
import type { PaginatedResult, Row, Where } from '@kernel/db'
import { evalAccess, isAllowed } from '../access'
import { parseSort, mergeWhere } from '../query'
import { VIEWS_TABLE } from '../schema'
import { BadRequestError, ForbiddenError, NotFoundError, UnauthorizedError } from '../errors'
import type {
  ApplyViewOptions,
  CollectionConfig,
  DeleteViewOptions,
  Doc,
  GetViewOptions,
  ListViewsOptions,
  RequestContext,
  SaveViewOptions,
  UpdateViewOptions,
  ViewDoc,
} from '../types'
import type { OpsContext } from './context'

/**
 * Saved views / smart collections.
 *
 * A view stores a named (`where` + `sort` + `columns`) preset for one collection. It is
 * owned by its creator (owner from the principal, never client input) and private unless
 * `shared`. The stored `where`/`sort` are validated against the collection on save AND on
 * apply; applying runs the NORMAL access-checked `find`, so a view can only ever narrow
 * within the caller's read access — it can never widen or bypass it.
 */
export function createViewOps(ctx: OpsContext) {
  const {
    config,
    db,
    MAX_LIMIT,
    collectionOrThrow,
    buildReq,
    principalOf,
    find,
    recordAudit,
    assertWhereFields,
    filterableFields,
    isAdminPrincipal,
    assertCanReadCollection,
  } = ctx

  const VIEW_NAME_MAX = 200
  // Prototype-pollution guard for an untrusted id used as a key/lookup.
  const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

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
    if (typeof viewId !== 'string' || viewId.length === 0 || FORBIDDEN_KEYS.has(viewId)) {
      throw new BadRequestError('A valid `viewId` is required.')
    }
    return (await db.findByID({ collection: VIEWS_TABLE, id: viewId })) ?? null
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

  return { saveView, listViews, getView, updateView, deleteView, applyView }
}
