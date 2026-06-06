import type { DatabaseAdapter, Logger } from '@kernel/db'
import type { Kernel, KernelConfig } from './types'
import { sanitizeConfig } from './config'
import { compileSchema } from './schema'
import { createOperations } from './operations'
import { createCachedDb } from './cache'
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
  const schema = compileSchema(sanitized)

  await sanitized.db.init({ logger })
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

  const ops = createOperations({ config: sanitized, db: opDb })

  return {
    config: sanitized,
    db: sanitized.db,
    ...(sanitized.cache ? { cache: sanitized.cache } : {}),
    schema,
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
    enqueue: ops.enqueue,
    runDueJobs: ops.runDueJobs,
    async migrate() {
      await sanitized.db.migrate(schema)
    },
    async destroy() {
      if (sanitized.cache) await sanitized.cache.destroy()
      await sanitized.db.destroy()
    },
  }
}
