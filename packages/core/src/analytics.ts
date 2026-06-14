/**
 * Content analytics & insights — a privacy-first capture + aggregate layer.
 *
 * Mirrors the audit / change-feed pattern: content EVENTS (a view, a search, an
 * AI/RAG retrieval, a variant impression, a conversion) are appended to a single
 * `_analytics` system table as metadata-only rows, then answered with AGGREGATE
 * insights (top content, top queries, variant performance, activity over time, the
 * "AI retrieval leaderboard"). It ties together the realtime feed, experiments, and
 * semantic search shipped earlier: `autoCapture` opt-in auto-emits an `ai_retrieval`
 * event per doc a semantic/hybrid/graph search returns, and a `variant_impression`
 * when `assignVariant` runs.
 *
 * PRIVACY-FIRST — there is NO PII at rest, by construction:
 *  - An `_analytics` row holds ONLY content/event metadata: `{ seq, at, type,
 *    collection, documentId, query, experiment, variant, value, meta }`. It NEVER
 *    stores a user id, IP, raw visitor key, email, or any auth token. `query` is the
 *    SEARCH TERMS (what content was retrieved), never a user identity.
 *  - A caller-supplied `meta` is sanitized: prototype-pollution keys AND obvious
 *    PII-ish keys (userId, ip, email, token, …) are STRIPPED, values are coerced to
 *    primitives and string-bounded, and the result is a null-prototype object. `meta`
 *    is for non-PII aggregate dimensions only (e.g. `{ source: 'rag', locale: 'en' }`).
 *
 * RESILIENCE — a tracking-write failure must NEVER break the content op it records
 * (try/catch + log, exactly like audit / the change feed).
 *
 * SECURITY — `track` can ONLY ever write the `_analytics` table; a `type`/`collection`
 * value can never redirect the write to another collection. `_analytics` is never
 * reachable via generic CRUD (it is not a configured collection). Insights are
 * AGGREGATES and admin/editor-gated at the HTTP layer; the scan + result size are
 * bounded (DoS guard).
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseAdapter, Logger, SortSpec, Where } from '@kernel/db'
import type { AnalyticsEventType, InsightsOptions, InsightsResult, SanitizedAnalytics, TrackOptions } from './types'
import { ANALYTICS_TABLE } from './schema'

/** The closed set of analytics event types. A `track` with anything else is rejected. */
export const ANALYTICS_EVENT_TYPES = [
  'view',
  'search',
  'ai_retrieval',
  'citation',
  'variant_impression',
  'conversion',
  'custom',
] as const

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(ANALYTICS_EVENT_TYPES)

/** Default + hard bounds on the `_analytics` retention (rows kept, oldest trimmed first). */
export const DEFAULT_ANALYTICS_RETAIN = 100_000
export const MAX_ANALYTICS_RETAIN = 5_000_000
export const MIN_ANALYTICS_RETAIN = 1

/** Default + max rows one `insights` query may scan (bounds the aggregate cost — DoS guard). */
export const DEFAULT_INSIGHTS_SCAN = 50_000
export const MAX_INSIGHTS_SCAN = 200_000

/** Default + max result rows an `insights` query returns (bounds the response size). */
export const DEFAULT_INSIGHTS_LIMIT = 20
export const MAX_INSIGHTS_LIMIT = 500

/** Max stored length of any single string dimension (query / collection / documentId /
 *  experiment / variant) and of a `meta` string value — clamps a hostile oversized write. */
const MAX_STRING_LEN = 1024
/** Max number of keys kept from a caller-supplied `meta` object (storage-growth guard). */
const MAX_META_KEYS = 32

/** Clamp the configured retention into `[MIN, MAX]` with the default fallback. */
export function clampAnalyticsRetain(value: number | undefined): number {
  const n = Math.floor(Number(value ?? DEFAULT_ANALYTICS_RETAIN))
  if (!Number.isFinite(n)) return DEFAULT_ANALYTICS_RETAIN
  return Math.min(Math.max(n, MIN_ANALYTICS_RETAIN), MAX_ANALYTICS_RETAIN)
}

/** Clamp an insights `limit` into `[1, MAX]` with the default fallback. */
export function clampInsightsLimit(value: number | undefined): number {
  const n = Math.floor(Number(value ?? DEFAULT_INSIGHTS_LIMIT))
  if (!Number.isFinite(n)) return DEFAULT_INSIGHTS_LIMIT
  return Math.min(Math.max(n, 1), MAX_INSIGHTS_LIMIT)
}

/** Whether `type` is one of the closed analytics event types. */
export function isAnalyticsEventType(type: unknown): type is AnalyticsEventType {
  return typeof type === 'string' && EVENT_TYPE_SET.has(type)
}

/** Trim a string dimension to a bounded length, or null when absent/empty. */
function clampString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  return trimmed.length > MAX_STRING_LEN ? trimmed.slice(0, MAX_STRING_LEN) : trimmed
}

/** Coerce a numeric `value` dimension to a finite number, or null. */
function clampValue(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return value
}

/**
 * Keys that are PROTOTYPE-POLLUTION vectors OR obvious PII. A caller-supplied `meta`
 * is meant for non-PII aggregate dimensions, so anything that looks like a user
 * identifier, contact, network address, or credential is dropped fail-closed. The
 * match is case-insensitive and substring-based (so `userId`, `user_id`, `userEmail`,
 * `x-forwarded-for`, `sessionToken`, `apiKey` all match), which biases toward DROPPING
 * a borderline key rather than risking PII at rest.
 */
const FORBIDDEN_META_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const PII_KEY_SUBSTRINGS = [
  'user',
  'email',
  'ip',
  'token',
  'session',
  'cookie',
  'password',
  'secret',
  'apikey',
  'api_key',
  'auth',
  'phone',
  'ssn',
  'address',
  'name', // username/fullname/firstname/lastname — over-broad on purpose
  'visitor',
  'fingerprint',
  'device',
  'forwarded',
  'remoteaddr',
  'identity',
  'account',
]

/** True when a meta key must be dropped (proto-pollution OR PII-ish). */
function isForbiddenMetaKey(key: string): boolean {
  if (FORBIDDEN_META_KEYS.has(key)) return true
  const lower = key.toLowerCase()
  return PII_KEY_SUBSTRINGS.some((bad) => lower.includes(bad))
}

/**
 * Sanitize a caller-supplied `meta` into a SAFE, null-prototype object of non-PII
 * aggregate dimensions. Drops prototype-pollution + PII-ish keys, keeps only primitive
 * values (string/number/boolean — objects/arrays/functions are dropped so a nested
 * `{ user: {...} }` can't smuggle PII), bounds string length and key count, and returns
 * `null` when nothing safe remains. Pure + total: never throws.
 */
export function sanitizeMeta(meta: unknown): Record<string, string | number | boolean> | null {
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return null
  const out: Record<string, string | number | boolean> = Object.create(null)
  let kept = 0
  for (const key of Object.keys(meta as Record<string, unknown>)) {
    if (kept >= MAX_META_KEYS) break
    if (isForbiddenMetaKey(key)) continue
    const value = (meta as Record<string, unknown>)[key]
    if (typeof value === 'string') {
      out[key] = value.length > MAX_STRING_LEN ? value.slice(0, MAX_STRING_LEN) : value
      kept++
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value
      kept++
    } else if (typeof value === 'boolean') {
      out[key] = value
      kept++
    }
    // Non-primitive values (objects/arrays/null/undefined/functions) are dropped:
    // a non-PII dimension is always a scalar, and dropping objects blocks nested PII.
  }
  return kept > 0 ? { ...out } : null
}

/**
 * The fully-sanitized, ready-to-store shape of one analytics event. Built by
 * {@link buildAnalyticsRow} from untrusted {@link TrackOptions}. NO principal/PII
 * fields exist on this shape at all — they cannot be stored because there is nowhere
 * to put them.
 */
export interface SanitizedAnalyticsEvent {
  type: AnalyticsEventType
  collection: string | null
  documentId: string | null
  query: string | null
  experiment: string | null
  variant: string | null
  value: number | null
  meta: Record<string, string | number | boolean> | null
}

/**
 * Validate + sanitize untrusted track input into a storable event, or `null` when the
 * `type` is invalid (the caller logs + drops — a bad track never throws into a content
 * op). NOTHING principal-derived is read here: even if a caller passes a `req`, no user
 * id / token is ever copied onto the row. `query` is the search TERMS, not identity.
 */
export function buildAnalyticsRow(opts: TrackOptions): SanitizedAnalyticsEvent | null {
  if (!isAnalyticsEventType(opts.type)) return null
  return {
    type: opts.type,
    collection: clampString(opts.collection),
    documentId: clampString(opts.documentId),
    query: clampString(opts.query),
    experiment: clampString(opts.experiment),
    variant: clampString(opts.variant),
    value: clampValue(opts.value),
    meta: sanitizeMeta(opts.meta),
  }
}

/**
 * The context an emitter needs to append + trim analytics events. Built once per kernel.
 * Resilient: every failure is caught + logged and never propagates into the content op.
 */
export interface AnalyticsCtx {
  db: DatabaseAdapter
  retain: number
  /** Monotonic per-kernel sequence (ordering + stable trim), seeded from the table at boot. */
  seq: { next: () => number }
  logger?: Logger
}

/**
 * Append ONE analytics event. Always writes to {@link ANALYTICS_TABLE} and nowhere
 * else — a `type`/`collection` value can never redirect the write (the target table is
 * hard-coded). Trims the table to `retain` (oldest `seq` first). NEVER throws — a
 * tracking failure is best-effort observability and must not break the content op
 * (mirrors the audit / change-feed pattern).
 */
export async function appendAnalytics(ctx: AnalyticsCtx, event: SanitizedAnalyticsEvent): Promise<void> {
  try {
    const seq = ctx.seq.next()
    await ctx.db.create({
      // SECURITY: the collection is a hard-coded constant, NOT derived from input —
      // `track` can therefore only ever write `_analytics`, never another collection.
      collection: ANALYTICS_TABLE,
      data: {
        id: randomUUID(),
        seq,
        at: new Date().toISOString(),
        type: event.type,
        collection: event.collection,
        documentId: event.documentId,
        query: event.query,
        experiment: event.experiment,
        variant: event.variant,
        value: event.value,
        meta: event.meta,
      },
    })
    await trimAnalytics(ctx)
  } catch (err) {
    ctx.logger?.warn('Failed to record analytics event', err)
  }
}

/** Trim `_analytics` to at most `retain` rows, dropping the oldest `seq` first (a ring
 *  buffer, like the change feed). Best-effort: a trim failure is logged, not fatal. */
async function trimAnalytics(ctx: AnalyticsCtx): Promise<void> {
  try {
    const total = await ctx.db.count({ collection: ANALYTICS_TABLE })
    if (total <= ctx.retain) return
    const excess = total - ctx.retain
    const oldest = await ctx.db.find({
      collection: ANALYTICS_TABLE,
      sort: [{ field: 'seq', direction: 'asc' }],
      limit: excess,
      page: 1,
    })
    for (const row of oldest.docs) {
      await ctx.db.delete({ collection: ANALYTICS_TABLE, id: String(row.id) })
    }
  } catch (err) {
    ctx.logger?.warn('Failed to trim analytics table', err)
  }
}

/** Seed the monotonic analytics seq from the highest `seq` already stored (so ordering
 *  survives a restart). A missing table degrades gracefully to 0. */
export async function createAnalyticsSeq(db: DatabaseAdapter): Promise<{ next: () => number }> {
  let current = 0
  try {
    const res = await db.find({
      collection: ANALYTICS_TABLE,
      sort: [{ field: 'seq', direction: 'desc' }],
      limit: 1,
      page: 1,
    })
    const n = Math.floor(Number(res.docs[0]?.seq))
    if (Number.isFinite(n) && n > current) current = n
  } catch {
    // No `_analytics` table yet (not migrated) — start at 0.
  }
  return {
    next() {
      current += 1
      return current
    },
  }
}

// ---------------------------------------------------------------------------
// Insights — bounded aggregate queries over the captured events
// ---------------------------------------------------------------------------

/** Parse an optional ISO `from`/`to` bound into a comparable timestamp, or null. */
function isoBound(value: string | undefined): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null
  const t = Date.parse(value)
  if (!Number.isFinite(t)) return null
  return new Date(t).toISOString()
}

/** One scanned analytics row, narrowed to the fields insights aggregate over. */
interface ScannedEvent {
  at: string
  type: string
  collection: string | null
  documentId: string | null
  query: string | null
  experiment: string | null
  variant: string | null
  value: number | null
}

/** Map a raw stored row to the narrowed {@link ScannedEvent}. */
function toScanned(row: Record<string, unknown>): ScannedEvent {
  return {
    at: String(row.at ?? ''),
    type: String(row.type ?? ''),
    collection: row.collection == null ? null : String(row.collection),
    documentId: row.documentId == null ? null : String(row.documentId),
    query: row.query == null ? null : String(row.query),
    experiment: row.experiment == null ? null : String(row.experiment),
    variant: row.variant == null ? null : String(row.variant),
    value: typeof row.value === 'number' && Number.isFinite(row.value) ? row.value : null,
  }
}

/**
 * Scan up to {@link MAX_INSIGHTS_SCAN} matching `_analytics` rows for an insights query,
 * filtered (in the DB) by an optional collection / type / `from`–`to` time range. The
 * row cap bounds the aggregate cost regardless of table size (DoS guard). Returns the
 * narrowed events; the caller does the in-memory aggregation.
 */
async function scanEvents(
  db: DatabaseAdapter,
  opts: { collection?: string; type?: string; from: string | null; to: string | null },
): Promise<ScannedEvent[]> {
  const and: Where[] = []
  if (opts.collection) and.push({ collection: { equals: opts.collection } })
  if (opts.type) and.push({ type: { equals: opts.type } })
  if (opts.from) and.push({ at: { greater_than_equal: opts.from } })
  if (opts.to) and.push({ at: { less_than_equal: opts.to } })
  const where: Where | undefined = and.length > 0 ? { and } : undefined

  const sort: SortSpec[] = [{ field: 'seq', direction: 'desc' }]
  const events: ScannedEvent[] = []
  let page = 1
  const pageSize = 1000
  while (events.length < MAX_INSIGHTS_SCAN) {
    const res = await db.find({
      collection: ANALYTICS_TABLE,
      ...(where ? { where } : {}),
      sort,
      limit: pageSize,
      page,
    })
    if (res.docs.length === 0) break
    for (const row of res.docs) {
      events.push(toScanned(row))
      if (events.length >= MAX_INSIGHTS_SCAN) break
    }
    if (!res.hasNextPage) break
    page++
  }
  return events
}

/** Rank `[key, count]` pairs by count desc (stable on key for determinism), take `limit`. */
function topCounts<T>(
  counts: Map<string, { count: number; sample: T }>,
  limit: number,
): Array<{ key: string; count: number; sample: T }> {
  return [...counts.entries()]
    .map(([key, v]) => ({ key, count: v.count, sample: v.sample }))
    .sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, limit)
}

/**
 * Run a bounded aggregate insights query. Privacy note: every result is an AGGREGATE
 * count/sum over content events — there is no per-user data to leak (none is stored).
 * Access note: insight rows are filtered to the collections the caller may read via
 * `readableCollection` (the HTTP layer is admin/editor-gated AND passes this predicate),
 * so an editor never sees counts for a collection they can't read. Events with no
 * collection dimension (e.g. a bare `search`) are collection-agnostic and always allowed.
 */
export async function computeInsights(
  config: SanitizedAnalytics,
  db: DatabaseAdapter,
  readableCollection: (collection: string) => boolean,
  opts: InsightsOptions,
): Promise<InsightsResult> {
  if (!config.enabled) return emptyInsights(opts.metric)
  const limit = clampInsightsLimit(opts.limit)
  const from = isoBound(opts.from)
  const to = isoBound(opts.to)
  const collectionFilter = clampString(opts.collection) ?? undefined
  const typeFilter = isAnalyticsEventType(opts.type) ? opts.type : undefined

  const all = await scanEvents(db, {
    ...(collectionFilter ? { collection: collectionFilter } : {}),
    ...(typeFilter ? { type: typeFilter } : {}),
    from,
    to,
  })
  // Drop events for collections the caller cannot read (an editor never learns a
  // hidden collection's counts). Collection-less events are always kept.
  const events = all.filter((e) => e.collection == null || readableCollection(e.collection))

  switch (opts.metric) {
    case 'top_content':
      return { metric: 'top_content', rows: topContent(events, limit) }
    case 'top_queries':
      return { metric: 'top_queries', rows: topQueries(events, limit) }
    case 'ai_retrieval_leaderboard':
      // The "how AI uses your content" headline — top content among ai_retrieval events.
      return {
        metric: 'ai_retrieval_leaderboard',
        rows: topContent(
          events.filter((e) => e.type === 'ai_retrieval'),
          limit,
        ),
      }
    case 'variant_performance':
      return { metric: 'variant_performance', rows: variantPerformance(events, limit) }
    case 'activity':
      return { metric: 'activity', rows: activity(events, limit) }
    default:
      return emptyInsights(opts.metric)
  }
}

/** Documents ranked by event count (filterable upstream by type). */
function topContent(events: ScannedEvent[], limit: number): InsightsResult['rows'] {
  const counts = new Map<string, { count: number; sample: { collection: string; documentId: string } }>()
  for (const e of events) {
    if (e.collection == null || e.documentId == null) continue
    const key = `${e.collection} ${e.documentId}`
    const existing = counts.get(key)
    if (existing) existing.count++
    else counts.set(key, { count: 1, sample: { collection: e.collection, documentId: e.documentId } })
  }
  return topCounts(counts, limit).map((r) => ({
    collection: r.sample.collection,
    documentId: r.sample.documentId,
    count: r.count,
  }))
}

/** Most frequent search/retrieval `query` terms with counts. */
function topQueries(events: ScannedEvent[], limit: number): InsightsResult['rows'] {
  const counts = new Map<string, { count: number; sample: string }>()
  for (const e of events) {
    if (e.query == null) continue
    const existing = counts.get(e.query)
    if (existing) existing.count++
    else counts.set(e.query, { count: 1, sample: e.query })
  }
  return topCounts(counts, limit).map((r) => ({ query: r.sample, count: r.count }))
}

/** Per experiment+variant: impressions + conversions (+ rate when both are present). */
function variantPerformance(events: ScannedEvent[], limit: number): InsightsResult['rows'] {
  const agg = new Map<string, { experiment: string; variant: string; impressions: number; conversions: number }>()
  for (const e of events) {
    if (e.experiment == null || e.variant == null) continue
    const key = `${e.experiment} ${e.variant}`
    let row = agg.get(key)
    if (!row) {
      row = { experiment: e.experiment, variant: e.variant, impressions: 0, conversions: 0 }
      agg.set(key, row)
    }
    if (e.type === 'variant_impression') row.impressions++
    else if (e.type === 'conversion') row.conversions++
  }
  return [...agg.values()]
    .sort(
      (a, b) =>
        b.impressions - a.impressions ||
        (a.experiment < b.experiment ? -1 : a.experiment > b.experiment ? 1 : 0) ||
        (a.variant < b.variant ? -1 : 1),
    )
    .slice(0, limit)
    .map((r) => ({
      experiment: r.experiment,
      variant: r.variant,
      impressions: r.impressions,
      conversions: r.conversions,
      ...(r.impressions > 0 ? { rate: r.conversions / r.impressions } : {}),
    }))
}

/** Event counts bucketed by day (UTC) and by type within the scanned range. */
function activity(events: ScannedEvent[], limit: number): InsightsResult['rows'] {
  const byBucket = new Map<string, { bucket: string; count: number; byType: Record<string, number> }>()
  for (const e of events) {
    const bucket = e.at.length >= 10 ? e.at.slice(0, 10) : 'unknown' // YYYY-MM-DD (UTC)
    let row = byBucket.get(bucket)
    if (!row) {
      row = { bucket, count: 0, byType: Object.create(null) }
      byBucket.set(bucket, row)
    }
    row.count++
    if (e.type) row.byType[e.type] = (row.byType[e.type] ?? 0) + 1
  }
  return [...byBucket.values()]
    .sort((a, b) => (a.bucket < b.bucket ? 1 : a.bucket > b.bucket ? -1 : 0)) // newest bucket first
    .slice(0, limit)
    .map((r) => ({ bucket: r.bucket, count: r.count, byType: { ...r.byType } }))
}

/** An empty result for the given metric (feature off / unknown metric). */
function emptyInsights(metric: InsightsOptions['metric']): InsightsResult {
  return { metric, rows: [] }
}
