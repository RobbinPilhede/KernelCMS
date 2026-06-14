/**
 * Edge content delivery — surrogate cache tags on content reads + a purge feed
 * derived from the real-time change feed, so a CDN/edge cache can cache aggressively
 * and invalidate precisely. Provider-agnostic: KernelCMS emits the tags (on the
 * response) + the list of tags to purge; the user wires their CDN (Cloudflare /
 * Fastly / Vercel / …).
 *
 * The two halves:
 *  - {@link cacheTags} computes the surrogate keys for a document or list response:
 *    the collection tag (`<collection>`), the doc tag (`<collection>:<id>`), and —
 *    when `includeRelationships` — the tags of the docs the response directly
 *    references (`<relCollection>:<relId>`). A CDN stores these on the cached object;
 *    purging any one of them evicts every response carrying it.
 *  - {@link computePurge} maps recent `_changes` rows to the cache tags to invalidate.
 *    Each change yields the changed doc's tag + its collection tag; when
 *    `includeRelationships`, the tags of docs that REFERENCE the changed doc are added
 *    too (a referencing page purges when an embedded doc changes). The change feed is
 *    the source of truth, so the purge feed requires `realtime` to be enabled.
 *
 * SECURITY — the make-or-break is cache-control correctness, enforced at the HTTP
 * layer (see the server): aggressive (`s-maxage`/public) caching is set ONLY on a
 * response produced for an ANONYMOUS principal over a publicly-readable collection;
 * an authenticated / access-scoped response gets `private, no-store`. A wrong header
 * would cache private content at the edge — a serious leak. Tags are derived only
 * from the RETURNED, access-checked docs, so a tag can never name an id the requester
 * couldn't see. Tags are sanitized to CDN-safe tokens (no spaces/newlines/control
 * chars) so neither a collection slug nor a document id can inject a header. The
 * purge feed reveals which document ids changed → it is admin/operator-gated at the
 * HTTP layer (like the change feed), and its scan is bounded.
 */
import type { DatabaseAdapter, Where } from '@kernel/db'
import type { CacheTagsOptions, ChangeEvent, Doc, PurgeFeedOptions, PurgeFeedResult, SanitizedConfig } from './types'
import { relationshipFields } from './fields'
import { CHANGES_TABLE } from './schema'

/** Separator between a collection and a document id in a doc tag (`posts:abc`). The
 *  colon is CDN-safe and matches the surrogate-key convention used by Fastly et al. */
const TAG_SEP = ':'

/** Default + max recent changes one purge-feed call may scan/map (DoS guard — bounds
 *  the cost regardless of how far behind the `since` cursor is). */
export const DEFAULT_PURGE_LIMIT = 1000
export const MAX_PURGE_LIMIT = 5000

/** Max reverse-reference lookups performed per purge call when `includeRelationships`
 *  is on. Computing "who references the changed doc" is one indexed `db.find` per
 *  changed doc per referencing field; this caps the fan-out so a large change batch
 *  can never explode into unbounded queries. Beyond it, reverse-ref tags are skipped
 *  for the remaining changes (their own doc + collection tags are still emitted). */
export const MAX_PURGE_REVERSE_LOOKUPS = 200

/**
 * Sanitize one tag token into a CDN-safe surrogate key: strip every character that is
 * not a safe token char (so a hostile collection slug or document id can never inject
 * a space, newline, or control char into the space-joined `Surrogate-Key` header).
 * Collection slugs are already snake_case-validated at sanitize, but document ids flow
 * from storage and could in theory be anything, so we defend here. Returns '' for a
 * value that sanitizes to nothing (the caller drops empties).
 *
 * Allowed: ASCII letters/digits and `-._:~/` (the unreserved + a few CDN-safe puncts).
 * Everything else — whitespace, control chars, and unsafe punctuation — is removed.
 */
export function sanitizeTag(value: unknown): string {
  if (value == null) return ''
  return String(value).replace(/[^A-Za-z0-9\-._:~/]/g, '')
}

/** Build a sanitized doc tag (`<collection>:<id>`), or '' when either part is empty
 *  after sanitization (a doc with an unusable id contributes no doc tag). */
function docTag(collection: string, id: unknown): string {
  const coll = sanitizeTag(collection)
  const docId = sanitizeTag(id)
  if (!coll || !docId) return ''
  return `${coll}${TAG_SEP}${docId}`
}

/** De-dupe + drop empties, preserving first-seen order (stable output for tests/CDNs). */
function dedupeTags(tags: Iterable<string>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const tag of tags) {
    if (!tag || seen.has(tag)) continue
    seen.add(tag)
    out.push(tag)
  }
  return out
}

/**
 * Collect the ids a document directly references, grouped by target collection — the
 * forward relationship/upload fields. Polymorphic refs (`{ relationTo, value }`) and
 * hasMany lists are both flattened. Only ids whose target collection actually exists
 * contribute (a dangling/unknown relationTo is skipped). Pure: reads only the doc.
 */
function relatedTagsOf(config: SanitizedConfig, collection: string, doc: Doc): string[] {
  const coll = config.collectionsBySlug[collection]
  if (!coll) return []
  const out: string[] = []
  for (const rel of relationshipFields(coll.fields)) {
    const value = doc[rel.name]
    if (rel.polymorphic) {
      const refs = rel.hasMany ? (Array.isArray(value) ? value : []) : value != null ? [value] : []
      for (const ref of refs) {
        if (ref && typeof ref === 'object') {
          const { relationTo, value: id } = ref as { relationTo?: string; value?: unknown }
          // A populated ref nests the resolved doc under `value`; reduce it to its id.
          const relId = id && typeof id === 'object' ? (id as Doc).id : id
          if (relationTo && config.collectionsBySlug[relationTo]) {
            const tag = docTag(relationTo, relId)
            if (tag) out.push(tag)
          }
        }
      }
    } else {
      const relTo = rel.relationTo as string
      if (!config.collectionsBySlug[relTo]) continue
      const ids = rel.hasMany ? (Array.isArray(value) ? value : []) : value != null ? [value] : []
      for (const id of ids) {
        // A populated relation is the resolved doc object; reduce it to its id.
        const relId = id && typeof id === 'object' ? (id as Doc).id : id
        const tag = docTag(relTo, relId)
        if (tag) out.push(tag)
      }
    }
  }
  return out
}

/**
 * The surrogate cache tags for a document or list response. Pure + total (never
 * throws, never touches the DB) — it only reads the supplied doc(s) + config.
 *
 *  - For a single document (`id` and/or `doc` given): the collection tag, the doc tag
 *    (`<collection>:<id>`), and — when `edge.includeRelationships` and a `doc` is
 *    supplied — the tags of the docs it directly references.
 *  - For a list response (`docs` given): the collection tag plus each returned doc's
 *    tag (relationship tags are NOT expanded for lists — a list purges on its own
 *    collection tag or any member doc tag, which already covers a referenced-doc
 *    change via that doc's own tag on the detail response).
 *
 * Tags are sanitized to CDN-safe tokens and de-duped. An empty/unknown collection
 * yields an empty list (defensive — never emits a malformed tag).
 */
export function cacheTags(config: SanitizedConfig, opts: CacheTagsOptions): string[] {
  const collTag = sanitizeTag(opts.collection)
  // Defensive: only tag a KNOWN collection — an unknown slug never yields a tag (it
  // could only come from a misuse, and a malformed tag is worthless to a CDN). Use an
  // own-property check so `__proto__`/`constructor` can't resolve to a truthy inherited
  // member and emit a bogus tag.
  if (!collTag || !Object.prototype.hasOwnProperty.call(config.collectionsBySlug, opts.collection)) return []
  const tags: string[] = [collTag]

  // List response: collection tag + each returned doc's tag.
  if (Array.isArray(opts.docs)) {
    for (const d of opts.docs) {
      const tag = docTag(opts.collection, d?.id)
      if (tag) tags.push(tag)
    }
    return dedupeTags(tags)
  }

  // Single-document response: collection + this doc + (optionally) its relationship targets.
  const id = opts.id ?? opts.doc?.id
  const selfTag = docTag(opts.collection, id)
  if (selfTag) tags.push(selfTag)
  if (config.edge.includeRelationships && opts.doc) {
    for (const tag of relatedTagsOf(config, opts.collection, opts.doc)) tags.push(tag)
  }
  return dedupeTags(tags)
}

/** Build the sanitized, space-joined surrogate-key header value from a tag list (the
 *  CDN convention). De-duped; empties dropped. Returns '' when nothing remains. */
export function cacheTagsHeader(tags: string[]): string {
  return dedupeTags(tags.map(sanitizeTag)).join(' ')
}

/** Map a raw `_changes` row to the metadata-only fields the purge feed reads. */
interface PurgeChange {
  seq: number
  collection: string
  documentId: string
}

/**
 * Find the tags of documents that REFERENCE a changed doc, so a referencing page is
 * purged when an embedded doc changes. For each collection that has a forward
 * relationship/upload field pointing at `changedCollection`, one indexed `db.find`
 * locates rows whose ref column equals the changed id; each match contributes its own
 * doc tag. Bounded by `budget` (decremented per lookup) so a large change batch can't
 * explode into unbounded queries. Best-effort: a query failure yields no extra tags
 * (the changed doc's own tag is still emitted by the caller).
 */
async function reverseRefTags(
  config: SanitizedConfig,
  db: DatabaseAdapter,
  changedCollection: string,
  changedId: string,
  budget: { remaining: number },
): Promise<string[]> {
  const out: string[] = []
  for (const coll of config.collections) {
    for (const rel of relationshipFields(coll.fields)) {
      const targets = Array.isArray(rel.relationTo) ? rel.relationTo : [rel.relationTo]
      if (!targets.includes(changedCollection)) continue
      if (budget.remaining <= 0) return out
      budget.remaining--
      try {
        // The relationship column stores the referenced id (hasMany stores a JSON array,
        // but `contains` matches a member); a polymorphic field stores `{relationTo,value}`
        // — its column is filtered by the id, which is the discriminating part.
        const where: Where = { [rel.name]: { contains: changedId } }
        const res = await db.find({ collection: coll.slug, where, limit: MAX_PURGE_LIMIT, page: 1 })
        for (const row of res.docs) {
          const tag = docTag(coll.slug, row.id)
          if (tag) out.push(tag)
        }
      } catch {
        // A column that doesn't support `contains` (or any adapter quirk) is skipped —
        // reverse-ref purge is a best-effort enhancement over the doc's own tag.
      }
    }
  }
  return out
}

/**
 * Compute the purge feed: read `_changes` rows with `seq > since`, map each to its
 * cache tags (the changed doc's tag + its collection tag; when
 * `edge.includeRelationships`, also the tags of docs that REFERENCE it), de-dupe, and
 * return the set of tags to purge plus the new cursor (the highest seq scanned, so the
 * poller advances even past changes that yielded no tags). Requires `realtime` —
 * returns an empty set otherwise. The scan is bounded by {@link MAX_PURGE_LIMIT}; the
 * reverse-ref fan-out is bounded by {@link MAX_PURGE_REVERSE_LOOKUPS}.
 *
 * NOTE on access: the purge feed deals only with cache TAGS (collection + id), never
 * document bodies, and it is admin/operator-gated at the HTTP layer because it reveals
 * which ids changed — exactly the change feed's access model.
 */
export async function computePurge(
  config: SanitizedConfig,
  db: DatabaseAdapter,
  opts: PurgeFeedOptions = {},
): Promise<PurgeFeedResult> {
  const since = clampSince(opts.since)
  if (!config.realtime.enabled) return { tags: [], cursor: since }
  const limit = clampPurgeLimit(opts.limit)

  // Oldest → newest by seq, only rows past the cursor, capped at `limit` (DoS guard).
  const res = await db.find({
    collection: CHANGES_TABLE,
    where: { seq: { greater_than: since } },
    sort: [{ field: 'seq', direction: 'asc' }],
    limit,
    page: 1,
  })

  const changes: PurgeChange[] = res.docs.map((row) => ({
    seq: Math.floor(Number(row.seq)),
    collection: String(row.collection ?? ''),
    documentId: String(row.documentId ?? ''),
  }))

  let cursor = since
  const tags: string[] = []
  const budget = { remaining: MAX_PURGE_REVERSE_LOOKUPS }
  for (const change of changes) {
    if (Number.isFinite(change.seq) && change.seq > cursor) cursor = change.seq
    const collTag = sanitizeTag(change.collection)
    if (collTag) tags.push(collTag)
    const self = docTag(change.collection, change.documentId)
    if (self) tags.push(self)
    if (config.edge.includeRelationships && collTag && change.documentId) {
      const refs = await reverseRefTags(config, db, change.collection, change.documentId, budget)
      for (const tag of refs) tags.push(tag)
    }
  }
  return { tags: dedupeTags(tags), cursor }
}

/** Clamp the `since` cursor to a finite non-negative integer (default 0). */
function clampSince(value: number | undefined): number {
  const n = Math.floor(Number(value ?? 0))
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** Clamp the purge scan `limit` into `[1, MAX_PURGE_LIMIT]` with the default fallback. */
export function clampPurgeLimit(value: number | undefined): number {
  const n = Math.floor(Number(value ?? DEFAULT_PURGE_LIMIT))
  if (!Number.isFinite(n)) return DEFAULT_PURGE_LIMIT
  return Math.min(Math.max(n, 1), MAX_PURGE_LIMIT)
}

/** Map a change event to its purge tags (doc + collection), for the push helper. Pure;
 *  does NOT compute reverse-refs (the push path is per-event and best-effort — a poller
 *  of {@link computePurge} covers reverse-ref purging). */
export function purgeTagsForEvent(event: ChangeEvent): string[] {
  const out: string[] = []
  const collTag = sanitizeTag(event.collection)
  if (collTag) out.push(collTag)
  const self = docTag(event.collection, event.documentId)
  if (self) out.push(self)
  return dedupeTags(out)
}
