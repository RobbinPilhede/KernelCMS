import type { DatabaseAdapter, Logger } from '@kernel/db'
import type { Doc, Kernel, KernelConfig } from './types'
import { sanitizeConfig } from './config'
import { compileSchema } from './schema'
import { createOperations } from './operations'
import { createCachedDb } from './cache'
import { CACHE_SLUG, JOBS_SLUG } from './config'
import { isKernelError } from './errors'
import { attachWebhooks } from './webhooks'
import { attachSearch } from './search'
import { applyPlugins } from './plugins'

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const

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
    async migrate() {
      await sanitized.db.migrate(schema)
    },
    async destroy() {
      if (sanitized.cache) await sanitized.cache.destroy()
      if (sanitized.search) await sanitized.search.destroy()
      await sanitized.db.destroy()
    },
  }
}
