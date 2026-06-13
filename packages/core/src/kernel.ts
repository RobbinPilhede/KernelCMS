import type { DatabaseAdapter, Logger, MigrationJournalEntry, MigrationReport } from '@kernel/db'
import { randomUUID } from 'node:crypto'
import type {
  BackfillOptions,
  BackfillResult,
  Doc,
  Kernel,
  KernelConfig,
  MigrateRunOptions,
  RollbackOptions,
  RollbackResult,
} from './types'
import { sanitizeConfig } from './config'
import { compileSchema, MIGRATIONS_TABLE } from './schema'
import { createOperations } from './operations'
import { createCachedDb } from './cache'
import { CACHE_SLUG, JOBS_SLUG } from './config'
import { BadRequestError, isKernelError } from './errors'
import { attachWebhooks } from './webhooks'
import { attachSearch } from './search'
import { applyPlugins } from './plugins'
import { ROLES_TABLE, cloneRoleDef } from './rbac'
import { storageFields } from './fields'

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const

// Keys a backfill may never target: prototype-pollution vectors plus server-owned
// system columns. The positive check (must be a real storage field) already excludes
// these, but listing them keeps the guard explicit and fails closed.
const FORBIDDEN_BACKFILL_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'id',
  'createdAt',
  'updatedAt',
  '_status',
  '_scheduled_at',
])

/** Coerce a journal column (stored as JSON, decoded to an array) into a string[]. */
function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)) : []
}

export function createLogger(level: keyof typeof LEVELS = 'info'): Logger {
  const min = LEVELS[level]
  const emit = (lvl: keyof typeof LEVELS, stream: 'log' | 'warn' | 'error') => (msg: string, meta?: unknown) => {
    if (LEVELS[lvl] < min) return
    const line = `[kernel] ${lvl.toUpperCase()} ${msg}`
    if (meta === undefined) console[stream](line)
    else console[stream](line, meta)
  }
  return {
    debug: emit('debug', 'log'),
    info: emit('info', 'log'),
    warn: emit('warn', 'warn'),
    error: emit('error', 'error'),
  }
}

export interface InitOptions {
  /** Apply the schema (create/alter tables) during init. Default false. */
  autoMigrate?: boolean
  logLevel?: keyof typeof LEVELS
}

/** Boot a Kernel instance: sanitize config, init the adapter, expose the Local API. */
export async function initKernel(config: KernelConfig, options: InitOptions = {}): Promise<Kernel> {
  const logger = createLogger(options.logLevel ?? (process.env.KERNEL_LOG_LEVEL as keyof typeof LEVELS) ?? 'info')
  // Plugins transform the raw config (add collections/fields/hooks) before sanitize.
  const resolved = await applyPlugins(config, logger)
  const sanitized = sanitizeConfig(resolved)
  // Outbound webhooks: attach firing hooks to targeted collections (excluding
  // system tables) before operations are created.
  if (sanitized.webhooks && sanitized.webhooks.length > 0) {
    attachWebhooks(sanitized.collections, sanitized.webhooks, new Set([JOBS_SLUG, CACHE_SLUG]), logger)
  }
  // Full-text search: attach index-sync hooks to searchable collections.
  if (sanitized.search && Object.keys(sanitized.searchableFields).length > 0) {
    attachSearch(sanitized.collections, sanitized.search, sanitized.searchableFields, logger)
  }
  const schema = compileSchema(sanitized)

  await sanitized.db.init({ logger })
  // Always register the schema's table registry so reads/writes resolve their
  // tables even when migrations are managed out-of-band (no autoMigrate). Without
  // this, find()/create() would throw "Unknown table" until a migration ran.
  sanitized.db.register?.(schema)
  if (options.autoMigrate) await sanitized.db.migrate(schema)

  // Optional read-through cache. The operation core runs against `opDb`; when a
  // cache adapter is configured and collections opt in, that is a cache-wrapping
  // adapter, otherwise the raw db. Access control still runs on every call.
  let opDb: DatabaseAdapter = sanitized.db
  if (sanitized.cache && sanitized.cacheableSlugs.length > 0) {
    await sanitized.cache.init({ logger, db: sanitized.db })
    opDb = createCachedDb(sanitized.db, sanitized.cache, {
      cacheableSlugs: new Set(sanitized.cacheableSlugs),
      ttlMs: sanitized.cacheDefaultTtl,
      ttlBySlug: sanitized.cacheTtlBySlug,
    })
  }
  if (sanitized.search) await sanitized.search.init({ logger, db: sanitized.db })

  const ops = createOperations({ config: sanitized, db: opDb, logger })

  // RBAC boot: reconcile the runtime store with the `_roles` table. On first boot
  // (table empty) the config-seeded roles are written so they're persisted/editable;
  // on later boots the persisted rows are merged into the store so runtime edits made
  // in a previous run survive. The store was already seeded from config at compile, so
  // the injected access rules work even if this step is skipped (e.g. table not yet
  // migrated) — hence failures are logged, never fatal.
  if (sanitized.rbac.enabled) {
    try {
      const existing = await sanitized.db.find({ collection: ROLES_TABLE, limit: 1000, page: 1 })
      if (existing.docs.length === 0) {
        // First boot: persist the config-seeded roles.
        for (const [name, def] of Object.entries(sanitized.rbacStore.roles)) {
          await sanitized.db.create({ collection: ROLES_TABLE, data: { id: name, name, def: cloneRoleDef(def) } })
        }
      } else {
        // Persisted rows are authoritative for roles they define; merge them over the
        // config seed so runtime edits/additions take effect.
        for (const row of existing.docs) {
          const name = typeof row.name === 'string' ? row.name : String(row.id)
          const def = (row.def ?? {}) as import('./types').RoleDef
          sanitized.rbacStore.roles[name] = cloneRoleDef(def)
        }
      }
    } catch (err) {
      logger.warn('RBAC: could not load `_roles` (run a migration to enable persistence)', err)
    }
  }

  return {
    config: sanitized,
    db: sanitized.db,
    ...(sanitized.cache ? { cache: sanitized.cache } : {}),
    ...(sanitized.search ? { search: sanitized.search } : {}),
    schema,
    async searchDocs<T extends Doc = Doc>(opts: import('./types').SearchDocsOptions): Promise<{ docs: T[] }> {
      const search = sanitized.search
      if (!search) throw new Error('No search adapter configured (config.search).')
      if (!sanitized.searchableFields[opts.collection]) {
        throw new Error(`Collection "${opts.collection}" does not have search enabled.`)
      }
      const limit = Math.max(1, opts.limit ?? 25)
      // Over-fetch hits so access filtering on load does not starve the result.
      const { hits } = await search.search({ collection: opts.collection, query: opts.query, limit: limit * 4 })
      const docs: T[] = []
      for (const hit of hits) {
        // Load through the access-checked read path. A hit the caller may not read
        // either returns null or raises an access error — both are skipped, so the
        // index never surfaces a forbidden document.
        let doc: T | null = null
        try {
          doc = await ops.findByID<T>({
            collection: opts.collection,
            id: hit.id,
            req: opts.req,
            overrideAccess: opts.overrideAccess,
            depth: opts.depth,
          })
        } catch (err) {
          if (!isKernelError(err)) throw err
        }
        if (doc) docs.push(doc)
        if (docs.length >= limit) break
      }
      return { docs }
    },
    find: ops.find,
    findByID: ops.findByID,
    create: ops.create,
    upload: ops.upload,
    update: ops.update,
    updateLocales: ops.updateLocales,
    translationStatus: ops.translationStatus,
    translationStatusList: ops.translationStatusList,
    updateMany: ops.updateMany,
    delete: ops.delete,
    deleteMany: ops.deleteMany,
    count: ops.count,
    login: ops.login,
    authenticate: ops.authenticate,
    createAPIKey: ops.createAPIKey,
    authenticateAPIKey: ops.authenticateAPIKey,
    forgotPassword: ops.forgotPassword,
    resetPassword: ops.resetPassword,
    verifyEmail: ops.verifyEmail,
    requestEmailVerification: ops.requestEmailVerification,
    setupTwoFactor: ops.setupTwoFactor,
    enableTwoFactor: ops.enableTwoFactor,
    disableTwoFactor: ops.disableTwoFactor,
    loginWithOAuth: ops.loginWithOAuth,
    findGlobal: ops.findGlobal,
    updateGlobal: ops.updateGlobal,
    findVersions: ops.findVersions,
    restoreVersion: ops.restoreVersion,
    publish: ops.publish,
    unpublish: ops.unpublish,
    processScheduledPublishes: ops.processScheduledPublishes,
    findAuditLog: ops.findAuditLog,
    enqueue: ops.enqueue,
    runDueJobs: ops.runDueJobs,
    findRoles: ops.findRoles,
    createRole: ops.createRole,
    updateRole: ops.updateRole,
    deleteRole: ops.deleteRole,
    findReviewQueue: ops.findReviewQueue,
    submitReview: ops.submitReview,
    composePage: ops.composePage,
    async migrate(opts?: MigrateRunOptions): Promise<MigrationReport> {
      const dryRun = opts?.dryRun === true
      const report = await sanitized.db.migrate(schema, { dryRun })
      // Record ONE journal row per real, non-empty migration — the single chokepoint
      // so every adapter gets journaling for free. A dry run writes nothing; an empty
      // migration (no tables created, no columns added) is skipped so rollback never
      // sees a no-op entry. The journal row is itself a normal insert into the always-
      // provisioned `_migrations` table.
      const applied = report.createdTables.length > 0 || report.addedColumns.length > 0
      if (!dryRun && applied) {
        try {
          await sanitized.db.create({
            collection: MIGRATIONS_TABLE,
            data: {
              id: randomUUID(),
              at: new Date().toISOString(),
              createdTables: report.createdTables,
              addedColumns: report.addedColumns,
              statements: report.statements,
            },
          })
        } catch (err) {
          // The schema change already succeeded; a journal-write failure must not
          // unwind it. Warn loudly — rollback won't be able to undo this migration.
          logger.warn('Migration applied but the journal row could not be written (rollback unavailable for it)', err)
        }
      }
      return report
    },
    async rollbackMigration(opts?: RollbackOptions): Promise<RollbackResult> {
      const dryRun = opts?.dryRun === true
      // Clamp steps to a finite positive integer — a NaN/Infinity would otherwise reach
      // the adapter as `limit` and throw an opaque datatype error before any drop.
      const rawSteps = Math.floor(Number(opts?.steps))
      const steps = Number.isFinite(rawSteps) ? Math.max(1, rawSteps) : 1
      if (typeof sanitized.db.rollback !== 'function') {
        throw new BadRequestError('The configured database adapter does not support rollback.')
      }
      // Read the last `steps` journal rows, newest-first. These are the ONLY source of
      // truth for what may be dropped — rollback never infers drops from a schema diff.
      const found = await sanitized.db.find({
        collection: MIGRATIONS_TABLE,
        sort: [{ field: 'at', direction: 'desc' }],
        limit: steps,
        page: 1,
      })
      const entries: MigrationJournalEntry[] = found.docs.map((row) => ({
        id: String(row.id),
        at: String(row.at ?? ''),
        createdTables: asStringArray(row.createdTables),
        addedColumns: asStringArray(row.addedColumns),
        statements: asStringArray(row.statements),
      }))
      const { statements } = await sanitized.db.rollback(entries, { dryRun })
      // Consume the journal rows only after a real (non-dry-run) rollback succeeds, so a
      // dry run leaves the journal intact and a failed drop leaves the entry to retry.
      if (!dryRun) {
        for (const entry of entries) {
          await sanitized.db.delete({ collection: MIGRATIONS_TABLE, id: entry.id })
        }
      }
      return { reverted: entries.map((e) => e.id), statements }
    },
    async backfill<T extends Doc = Doc>(opts: BackfillOptions<T>): Promise<BackfillResult> {
      const collection = sanitized.collectionsBySlug[opts.collection]
      if (!collection) throw new BadRequestError(`Unknown collection "${opts.collection}".`)
      // Validate the target field: it must be a real, storage-bearing field of the
      // collection. This rejects system/internal columns (id, _status, timestamps, …)
      // and prototype-pollution keys, so a backfill can never clobber server-owned state.
      const field = opts.field
      if (FORBIDDEN_BACKFILL_KEYS.has(field) || !storageFields(collection.fields).some((f) => f.name === field)) {
        throw new BadRequestError(`"${field}" is not a writable field of "${opts.collection}".`)
      }
      if (opts.value === undefined && typeof opts.set !== 'function') {
        throw new BadRequestError('Provide either `value` or a `set(doc)` function to backfill.')
      }
      const dryRun = opts.dryRun === true
      const batchSize = Math.min(Math.max(Math.floor(opts.batchSize ?? 500), 1), 1000)

      // Count up front for the `matched` total; on a dry run that's the whole answer.
      const matched = await ops.count({ collection: opts.collection, where: opts.where, overrideAccess: true })
      if (dryRun) return { matched, updated: 0 }

      // Two phases, so the write phase can't perturb its own pagination: first read every
      // matching doc id by paging the STABLE filter (a backfill update may or may not keep
      // a row in the filter, so paging WHILE writing could skip or revisit). Then update
      // each id via the trusted maintenance path. Memory is bounded by `matched`, itself a
      // count the operator chose to backfill.
      const targets: T[] = []
      let page = 1
      for (;;) {
        const result = await ops.find<T>({
          collection: opts.collection,
          where: opts.where,
          sort: 'id',
          limit: batchSize,
          page,
          // Backfill is maintenance over ALL existing rows — include drafts, which the
          // normal read path hides. Without this, draft rows are silently skipped and
          // the add→backfill→tighten-to-NOT-NULL sequence breaks on the still-null drafts.
          draft: true,
          overrideAccess: true,
          req: opts.req,
        })
        targets.push(...result.docs)
        if (!result.hasNextPage || result.docs.length === 0) break
        page++
      }

      let updated = 0
      for (const doc of targets) {
        const next = typeof opts.set === 'function' ? opts.set(doc) : opts.value
        const res = await ops.update({
          collection: opts.collection,
          id: doc.id,
          data: { [field]: next },
          overrideAccess: true,
          req: opts.req,
        })
        if (res) updated++
      }
      return { matched, updated }
    },
    async destroy() {
      if (sanitized.cache) await sanitized.cache.destroy()
      if (sanitized.search) await sanitized.search.destroy()
      await sanitized.db.destroy()
    },
  }
}
