import type { Logger } from '@kernel/db'
import type { Kernel, KernelConfig } from './types'
import { sanitizeConfig } from './config'
import { compileSchema } from './schema'
import { createOperations } from './operations'

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const

export function createLogger(level: keyof typeof LEVELS = 'info'): Logger {
  const min = LEVELS[level]
  const emit =
    (lvl: keyof typeof LEVELS, stream: 'log' | 'warn' | 'error') =>
    (msg: string, meta?: unknown) => {
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
  const sanitized = sanitizeConfig(config)
  const schema = compileSchema(sanitized)
  const logger = createLogger(options.logLevel ?? (process.env.KERNEL_LOG_LEVEL as keyof typeof LEVELS) ?? 'info')

  await sanitized.db.init({ logger })
  if (options.autoMigrate) await sanitized.db.migrate(schema)

  const ops = createOperations({ config: sanitized, db: sanitized.db })

  return {
    config: sanitized,
    db: sanitized.db,
    schema,
    find: ops.find,
    findByID: ops.findByID,
    create: ops.create,
    update: ops.update,
    delete: ops.delete,
    count: ops.count,
    login: ops.login,
    authenticate: ops.authenticate,
    findGlobal: ops.findGlobal,
    updateGlobal: ops.updateGlobal,
    async migrate() {
      await sanitized.db.migrate(schema)
    },
    async destroy() {
      await sanitized.db.destroy()
    },
  }
}
