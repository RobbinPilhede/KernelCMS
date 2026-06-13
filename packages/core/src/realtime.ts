/**
 * Real-time content: a durable change feed (CDC, pull) + an in-process event bus
 * (push / `subscribe`) + the access-filter that powers both the pull feed and SSE.
 *
 * Mirrors the webhooks pattern: `attachChangeFeed` appends afterChange/afterDelete
 * hooks to every non-system collection so the normal operation pipeline (access,
 * validation, hooks) runs FIRST and the feed only sees a committed change. Each hook
 * writes ONE metadata-only row to the `_changes` outbox, trims the outbox to `retain`
 * (oldest first, like version maxPerDoc), and emits the event to in-process listeners.
 *
 * SECURITY — events are metadata-only AND access-filtered per subscriber:
 *  - A `_changes` row holds `{ seq, at, collection, documentId, event, principalId,
 *    principalType }` — NEVER the document body. A change event can't leak a field a
 *    subscriber can't read.
 *  - Every event a subscriber sees passes {@link makeChangeFilter}: for a non-delete
 *    event the document is re-loaded through the access-checked read path (null/throws
 *    → dropped); for a delete (the doc is gone) the collection's `read` access is
 *    evaluated. A forbidden event is DROPPED ENTIRELY — a subscriber never even learns
 *    that a document they can't read changed.
 *
 * RESILIENCE — a feed-write/emit failure must never break the content write it records
 * (try/catch + log, like the audit pattern).
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseAdapter, Logger, SortSpec } from '@kernel/db'
import type {
  ChangeEvent,
  ChangeEventType,
  ChangesOptions,
  ChangesResult,
  CollectionConfig,
  Doc,
  RequestContext,
  SanitizedConfig,
} from './types'
import { CHANGES_TABLE } from './schema'
import { evalAccess, isAllowed } from './access'

/** Max in-process listeners on one kernel's bus (DoS guard — a runaway caller can't
 *  register unbounded listeners). Generous for real fan-out (UIs, SSE conns, re-index). */
export const MAX_CHANGE_LISTENERS = 1000

/** Default + hard bounds on the `_changes` outbox retention (rows kept). */
export const DEFAULT_CHANGE_RETAIN = 10_000
export const MAX_CHANGE_RETAIN = 1_000_000
export const MIN_CHANGE_RETAIN = 1

/** Default + max events one `changes()` pull may return (clamps a hostile `limit`). */
export const DEFAULT_CHANGES_LIMIT = 100
export const MAX_CHANGES_LIMIT = 1000

/** Clamp the configured retention into `[MIN, MAX]` with the default fallback. */
export function clampRetain(value: number | undefined): number {
  const n = Math.floor(Number(value ?? DEFAULT_CHANGE_RETAIN))
  if (!Number.isFinite(n)) return DEFAULT_CHANGE_RETAIN
  return Math.min(Math.max(n, MIN_CHANGE_RETAIN), MAX_CHANGE_RETAIN)
}

/** A lightweight, per-kernel in-process event bus. Listeners receive every recorded
 *  change event (metadata only); access-filtering is the caller's responsibility (the
 *  pull feed + SSE share one filter). The listener set is bounded. */
export interface ChangeBus {
  /** Register a listener; returns an unsubscribe fn. Throws past {@link MAX_CHANGE_LISTENERS}. */
  subscribe(listener: (event: ChangeEvent) => void): () => void
  /** Deliver an event to every current listener. A throwing listener is isolated +
   *  logged so one bad subscriber can't starve the others (or break the write). */
  emit(event: ChangeEvent): void
  /** Current listener count (for tests / bounds). */
  size(): number
}

export function createChangeBus(logger?: Logger): ChangeBus {
  const listeners = new Set<(event: ChangeEvent) => void>()
  return {
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('subscribe(listener) requires a function.')
      if (listeners.size >= MAX_CHANGE_LISTENERS) {
        throw new Error(`Too many change-feed listeners (max ${MAX_CHANGE_LISTENERS}).`)
      }
      listeners.add(listener)
      let active = true
      return () => {
        if (!active) return
        active = false
        listeners.delete(listener)
      }
    },
    emit(event) {
      // Snapshot so a listener that (un)subscribes during delivery can't mutate the
      // set mid-iteration. A throwing listener is isolated — never breaks the others.
      for (const listener of [...listeners]) {
        try {
          listener(event)
        } catch (err) {
          logger?.warn('Change-feed listener threw (isolated)', err)
        }
      }
    },
    size() {
      return listeners.size
    },
  }
}

/** A monotonic per-kernel sequence counter for the change feed. Seeded from the max
 *  `seq` already in `_changes` at boot (so cursors stay ordered across restarts) and
 *  incremented in-process for every new row. In-process + per-node — adequate for a
 *  single node; a multi-node deployment would front this with a shared sequence. */
export interface SeqCounter {
  next(): number
}

export async function createSeqCounter(db: DatabaseAdapter): Promise<SeqCounter> {
  let current = 0
  try {
    const res = await db.find({
      collection: CHANGES_TABLE,
      sort: [{ field: 'seq', direction: 'desc' }],
      limit: 1,
      page: 1,
    })
    const top = res.docs[0]?.seq
    const n = Math.floor(Number(top))
    if (Number.isFinite(n) && n > current) current = n
  } catch {
    // No `_changes` table yet (not migrated) — start at 0; the first write seeds it.
  }
  return {
    next() {
      current += 1
      return current
    },
  }
}

/** Coerce a stored principal-type column into the closed union (defaults to 'user'). */
function normalizePrincipalType(value: unknown): ChangeEvent['principalType'] {
  return value === 'agent' || value === 'system' ? value : 'user'
}

/** Map a raw `_changes` row to the public, metadata-only {@link ChangeEvent}. */
function rowToChangeEvent(row: Record<string, unknown>): ChangeEvent {
  return {
    seq: Math.floor(Number(row.seq)),
    at: String(row.at ?? ''),
    collection: String(row.collection ?? ''),
    documentId: String(row.documentId ?? ''),
    event: String(row.event ?? 'update') as ChangeEventType,
    principalType: normalizePrincipalType(row.principalType),
  }
}

/**
 * The context an emitter needs to write + fan out a change. Built once per kernel.
 * The emitter is resilient: any failure is caught + logged and never propagates into
 * the content write that triggered it.
 */
export interface ChangeFeedCtx {
  db: DatabaseAdapter
  bus: ChangeBus
  seq: SeqCounter
  retain: number
  logger?: Logger
}

/**
 * Record + fan out one change. Writes a metadata-only row to `_changes`, trims the
 * outbox to `retain` (oldest seq dropped first), and emits to the bus. Never throws —
 * a feed failure must not break the content write (try/catch + log, like audit).
 */
export async function emitChange(
  ctx: ChangeFeedCtx,
  args: {
    collection: string
    documentId: string
    event: ChangeEventType
    principalId: string | null
    principalType: ChangeEvent['principalType']
  },
): Promise<void> {
  try {
    const seq = ctx.seq.next()
    const at = new Date().toISOString()
    await ctx.db.create({
      collection: CHANGES_TABLE,
      data: {
        id: randomUUID(),
        seq,
        at,
        collection: args.collection,
        documentId: args.documentId,
        event: args.event,
        principalId: args.principalId,
        principalType: args.principalType,
      },
    })
    await trimChanges(ctx)
    ctx.bus.emit({
      seq,
      at,
      collection: args.collection,
      documentId: args.documentId,
      event: args.event,
      principalType: args.principalType,
    })
  } catch (err) {
    // The content write already committed — a feed-write failure is best-effort
    // observability and must never propagate (mirrors the audit pattern).
    ctx.logger?.warn('Failed to record change-feed event', err)
  }
}

/** Trim the `_changes` outbox to at most `retain` rows, dropping the oldest `seq` first
 *  (a ring buffer, like version maxPerDoc). Best-effort: a trim failure is logged, not
 *  fatal — the outbox just grows until the next successful trim. */
async function trimChanges(ctx: ChangeFeedCtx): Promise<void> {
  try {
    const total = await ctx.db.count({ collection: CHANGES_TABLE })
    if (total <= ctx.retain) return
    const excess = total - ctx.retain
    // Oldest first by seq, only as many as we must remove.
    const oldest = await ctx.db.find({
      collection: CHANGES_TABLE,
      sort: [{ field: 'seq', direction: 'asc' }],
      limit: excess,
      page: 1,
    })
    for (const row of oldest.docs) {
      await ctx.db.delete({ collection: CHANGES_TABLE, id: String(row.id) })
    }
  } catch (err) {
    ctx.logger?.warn('Failed to trim change feed', err)
  }
}

/** The acting principal id/kind for a change, derived from the request (mirrors the
 *  audit principalKindFor). A content write with no user is a trusted server/system
 *  write (overrideAccess) by definition → 'system'. */
function principalFor(req: RequestContext | undefined): { id: string | null; type: ChangeEvent['principalType'] } {
  const user = req?.user
  if (user) return { id: user.id ?? null, type: user.principalType ?? 'user' }
  return { id: null, type: 'system' }
}

/**
 * Append change-feed hooks to every non-system collection (mirrors `attachWebhooks`).
 * An afterChange hook records create/update; an afterDelete hook records delete. System
 * collections (jobs queue, cache table, and the `_changes` outbox itself) are excluded so
 * internal writes never emit (and the feed can't feed itself). Mutates collections in place.
 *
 * Publish/unpublish are NOT distinguished here: the afterChange hook args don't carry the
 * prior `_status`, so a publish reads as 'update' (the documented tradeoff). The event
 * TYPE union + table still support publish/unpublish for a future operations-level emit.
 */
export function attachChangeFeed(
  collections: CollectionConfig[],
  ctx: ChangeFeedCtx,
  systemSlugs: ReadonlySet<string>,
): void {
  for (const collection of collections) {
    if (systemSlugs.has(collection.slug)) continue
    const slug = collection.slug
    const hooks = (collection.hooks ??= {})

    const onChange = async (args: { operation: 'create' | 'update'; doc: Doc; req?: RequestContext }): Promise<Doc> => {
      const principal = principalFor(args.req)
      await emitChange(ctx, {
        collection: slug,
        documentId: String(args.doc.id),
        event: args.operation,
        principalId: principal.id,
        principalType: principal.type,
      })
      return args.doc
    }
    hooks.afterChange = [...(hooks.afterChange ?? []), onChange as never]

    const onDelete = async (args: { id: string; req?: RequestContext }): Promise<void> => {
      const principal = principalFor(args.req)
      await emitChange(ctx, {
        collection: slug,
        documentId: String(args.id),
        event: 'delete',
        principalId: principal.id,
        principalType: principal.type,
      })
    }
    hooks.afterDelete = [...(hooks.afterDelete ?? []), onDelete as never]
  }
}

/**
 * Build the per-subscriber access filter shared by the pull feed AND the SSE stream.
 * Returns a predicate that decides whether a caller may LEARN that a change happened:
 *  - non-delete event → re-load the document through the access-checked read path. If the
 *    load returns a doc, the caller may read it → allowed. If it returns null, the doc is
 *    EITHER access-denied OR has since been deleted; we can't tell those apart from a null,
 *    so we fall back to the collection-level read gate below (the same gate a delete uses).
 *    Either way a doc the caller cannot read is never surfaced.
 *  - delete event / absent doc → evaluate the collection's `read` access for the principal.
 *    A boolean `true` (globally readable) is allowed; `false` is denied; a row-scoped
 *    `Where` result can't be matched against a gone document, so it FAILS CLOSED (dropped)
 *    — a change to a row-scoped collection is never leaked once the doc is unreadable/gone.
 *
 * An overrideAccess (trusted server) caller sees everything. Unknown collections are
 * dropped (defensive — a stale change row for a removed collection never surfaces).
 */
export function makeChangeFilter(
  config: SanitizedConfig,
  load: (collection: string, id: string, req: RequestContext | undefined) => Promise<Doc | null>,
): (event: ChangeEvent, req: RequestContext | undefined, override: boolean) => Promise<boolean> {
  // Gate by the collection's READ access rule alone (used for deletes and for a non-delete
  // whose doc is gone). Only a globally-readable (`true`) collection passes; a row-scoped
  // (`Where`) or denied (`false`) rule fails closed, since there is no live row to match.
  const collectionReadable = async (
    collection: CollectionConfig,
    req: RequestContext | undefined,
    id: string,
  ): Promise<boolean> => {
    const decision = await evalAccess(collection.access?.read, { req: req as RequestContext, id })
    return decision === true
  }

  return async (event, req, override) => {
    if (override) return true
    const collection = config.collectionsBySlug[event.collection]
    if (!collection) return false
    if (event.event === 'delete') {
      return collectionReadable(collection, req, event.documentId)
    }
    // Non-delete: the access-checked read path is the chokepoint. A live, readable doc →
    // allowed. A null means access-denied OR deleted-since; fall back to the collection
    // read gate so a public doc's history survives a later delete while a scoped doc stays
    // hidden. Both branches guarantee a doc the caller can't read is never surfaced.
    const doc = await load(event.collection, event.documentId, req).catch(() => null)
    if (doc != null) return true
    return collectionReadable(collection, req, event.documentId)
  }
}

/**
 * The durable pull feed. Reads `_changes` rows with `seq > since` (optionally for one
 * collection), oldest → newest, access-filters each per the caller, and returns the
 * visible events plus the cursor (highest seq returned, so the client polls `since=cursor`).
 * Over-fetches so access filtering doesn't starve the page. No-op when realtime is off.
 */
export async function readChanges(
  config: SanitizedConfig,
  db: DatabaseAdapter,
  filter: (event: ChangeEvent, req: RequestContext | undefined, override: boolean) => Promise<boolean>,
  buildReq: (partial?: Partial<RequestContext>) => RequestContext,
  opts: ChangesOptions,
): Promise<ChangesResult> {
  const since = sinceCursor(opts.since)
  if (!config.realtime.enabled) return { changes: [], cursor: since }

  const limit = clampChangesLimit(opts.limit)
  const override = opts.overrideAccess === true
  const req = buildReq(opts.req)

  // Validate the collection filter (unknown collection → clean empty result, not a leak).
  const collectionFilter = opts.collection
  if (collectionFilter !== undefined && !config.collectionsBySlug[collectionFilter]) {
    return { changes: [], cursor: since }
  }

  const where = {
    and: [
      { seq: { greater_than: since } },
      ...(collectionFilter ? [{ collection: { equals: collectionFilter } }] : []),
    ],
  }
  const sort: SortSpec[] = [{ field: 'seq', direction: 'asc' }]

  const visible: ChangeEvent[] = []
  let cursor = since
  let page = 1
  // Over-fetch in pages until we have `limit` visible events or the feed is exhausted.
  for (;;) {
    const res = await db.find({ collection: CHANGES_TABLE, where, sort, limit: Math.max(limit * 4, limit), page })
    if (res.docs.length === 0) break
    for (const row of res.docs) {
      const event = rowToChangeEvent(row)
      // Advance the cursor over EVERY scanned row (even filtered-out ones): the client
      // must never re-scan a row it was denied, and a denied row carries no information.
      if (event.seq > cursor) cursor = event.seq
      if (await filter(event, req, override)) {
        visible.push(event)
        if (visible.length >= limit) return { changes: visible, cursor }
      }
    }
    if (!res.hasNextPage) break
    page++
  }
  return { changes: visible, cursor }
}

/** Clamp the `since` cursor to a finite non-negative integer (default 0). */
function sinceCursor(value: number | undefined): number {
  const n = Math.floor(Number(value ?? 0))
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** Clamp the pull `limit` into `[1, MAX_CHANGES_LIMIT]` with the default fallback. */
export function clampChangesLimit(value: number | undefined): number {
  const n = Math.floor(Number(value ?? DEFAULT_CHANGES_LIMIT))
  if (!Number.isFinite(n)) return DEFAULT_CHANGES_LIMIT
  return Math.min(Math.max(n, 1), MAX_CHANGES_LIMIT)
}
