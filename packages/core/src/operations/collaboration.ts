import type { Row } from '@kernel/db'
import { evalAccess, isAllowed, asWhere } from '../access'
import { matchesWhere } from '../query'
import { LOCKS_TABLE, PRESENCE_TABLE } from '../schema'
import { ForbiddenError } from '../errors'
import type {
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
} from '../types'
import type { OpsContext } from './context'

/**
 * Real-time collaboration: advisory document locks + editor presence.
 *
 * Locks are ADVISORY — they signal intent and never gate writes; a writer who ignores a
 * lock still goes through the SAME access control. So these ops deliberately do NOT consult
 * collection access for the write itself — they're a presence/coordination layer, not an
 * authorization layer. They DO access-check READ on the target (via `assertTarget`) so a
 * caller can't lock, heartbeat on, or learn who is editing a document outside their read
 * scope. `now` is injectable for deterministic expiry.
 */
export function createCollaborationOps(ctx: OpsContext) {
  const { config, db, MAX_LIMIT, buildReq, principalOf, assertTarget } = ctx

  const DEFAULT_LOCK_TTL_MS = 120_000
  // Upper bound on a lock's lifetime. Clamps hostile/garbage `ttlMs` (NaN, Infinity, or
  // values so large that `now + ttl` overflows a JS Date) to a finite range so the date
  // math below can never throw a RangeError into a 500.
  const MAX_LOCK_TTL_MS = 24 * 60 * 60 * 1000
  const DEFAULT_PRESENCE_TTL_MS = 30_000

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
    const where = opts.collection ? { collection: { equals: ctx.collectionOrThrow(opts.collection).slug } } : undefined
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

  return { acquireLock, releaseLock, getLock, listLocks, heartbeat, getPresence }
}
