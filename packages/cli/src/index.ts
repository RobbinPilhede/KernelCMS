import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  EMPTY_SCHEMA,
  diffSchema,
  formatDoctorReport,
  formatSystemInfo,
  generateTypes,
  importData,
  initKernel,
  runDoctor,
  summarizePlan,
  systemInfo,
  type ImportPayload,
} from '@kernel/core'
import type { Kernel, KernelConfig, KernelSchema } from '@kernel/core'
import { serve } from '@kernel/server'
import { configTemplate, moduleTemplate, toSlug } from './templates'

interface Flags {
  [key: string]: string | boolean
}

interface ParsedArgs {
  command: string | undefined
  positionals: string[]
  flags: Flags
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = []
  const flags: Flags = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next
        i++
      } else {
        flags[key] = true
      }
    } else {
      positionals.push(arg)
    }
  }
  return { command: positionals[0], positionals: positionals.slice(1), flags }
}

interface LoadedConfig {
  config: KernelConfig
  seed?: (kernel: Kernel) => Promise<void> | void
  path: string
}

async function loadConfig(flags: Flags): Promise<LoadedConfig> {
  const configPath = typeof flags.config === 'string' ? flags.config : 'kernel.config.ts'
  const abs = resolve(process.cwd(), configPath)
  const mod = (await import(pathToFileURL(abs).href)) as {
    default?: KernelConfig
    config?: KernelConfig
    seed?: (kernel: Kernel) => Promise<void> | void
  }
  const config = mod.default ?? mod.config
  if (!config) throw new Error(`No config found. Export a default config from ${configPath}.`)
  return { config, seed: mod.seed, path: abs }
}

const HELP = `KernelCMS CLI

Usage: kernel <command> [options]

Commands:
  init               Scaffold a starter kernel.config.ts in the current directory
  migrate            Create/update database tables from the config schema
  migrate:status     Diff the config schema against the saved snapshot (risk-classified)
  migrate:snapshot   Save the compiled schema to kernel/schema-snapshot.json
  info               Print a product overview of this KernelCMS instance
  doctor             Check the config + environment for misconfigurations
  import             Import a portable JSON export (--file) — migrate from another CMS
  seed               Run the exported seed() function
  jobs:run           Run all due background jobs once (drive from a cron)
  generate:types     Write generated TypeScript types for the content model
  generate:module    Scaffold a new module (collection + endpoint) — <name> [--out path]
  dev                Migrate, then start the REST API server (development)
  start              Serve for production (no auto-migrate; doctor-gated)

Options:
  --config <path>    Path to kernel.config.ts (default: ./kernel.config.ts)
  --port <number>    Port for "dev" (default: $PORT or 3000)
  --out <path>       Output file for "generate:types"
`

export async function run(argv: string[]): Promise<void> {
  // Load a project .env (e.g. DATABASE_URL written during first-run setup) into
  // process.env before the config is imported, so an env-driven config picks it
  // up. No-op when there is no .env.
  try {
    process.loadEnvFile()
  } catch {
    /* no .env file — fine */
  }

  const { command, flags, positionals } = parseArgs(argv)

  switch (command) {
    case 'init': {
      const out =
        typeof flags.out === 'string' ? resolve(process.cwd(), flags.out) : resolve(process.cwd(), 'kernel.config.ts')
      if (existsSync(out)) {
        console.error(`Refusing to overwrite existing file: ${out}`)
        process.exitCode = 1
        break
      }
      writeFileSync(out, configTemplate())
      console.log(`✓ Wrote ${out}\n\nNext steps:\n  npm install kernelcms\n  npx kernel dev`)
      break
    }

    case 'generate:module': {
      const name = positionals[0]
      if (!name) {
        console.error('Usage: kernel generate:module <name>')
        process.exitCode = 1
        break
      }
      const slug = toSlug(name)
      const out =
        typeof flags.out === 'string' ? resolve(process.cwd(), flags.out) : resolve(process.cwd(), `${slug}.module.ts`)
      if (existsSync(out)) {
        console.error(`Refusing to overwrite existing file: ${out}`)
        process.exitCode = 1
        break
      }
      writeFileSync(out, moduleTemplate(name))
      console.log(`✓ Wrote ${out}`)
      break
    }

    case 'migrate': {
      const { config } = await loadConfig(flags)
      const kernel = await initKernel(config)
      const report = await kernel.db.migrate(kernel.schema)
      console.log(
        `✓ Migration complete — ${report.createdTables.length} table(s) created, ${report.addedColumns.length} column(s) added.`,
      )
      if (report.createdTables.length) console.log(`  Created: ${report.createdTables.join(', ')}`)
      await kernel.destroy()
      break
    }

    case 'migrate:status':
    case 'migrate:snapshot': {
      const { config, path } = await loadConfig(flags)
      const kernel = await initKernel(config)
      const snapshotPath =
        typeof flags.out === 'string'
          ? resolve(process.cwd(), flags.out)
          : resolve(dirname(path), 'kernel', 'schema-snapshot.json')

      if (command === 'migrate:snapshot') {
        mkdirSync(dirname(snapshotPath), { recursive: true })
        writeFileSync(snapshotPath, JSON.stringify(kernel.schema, null, 2) + '\n', 'utf8')
        console.log(`✓ Schema snapshot written to ${snapshotPath}`)
      } else {
        const current: KernelSchema = existsSync(snapshotPath)
          ? (JSON.parse(readFileSync(snapshotPath, 'utf8')) as KernelSchema)
          : EMPTY_SCHEMA
        const plan = diffSchema(current, kernel.schema)
        console.log(summarizePlan(plan))
        if (plan.hasDestructive) console.log('\n⚠  Plan contains destructive changes — review before applying.')
      }
      await kernel.destroy()
      break
    }

    case 'info': {
      const { config } = await loadConfig(flags)
      const kernel = await initKernel(config)
      console.log(formatSystemInfo(systemInfo(kernel)))
      await kernel.destroy()
      break
    }

    case 'doctor': {
      const { config } = await loadConfig(flags)
      const kernel = await initKernel(config)
      const report = runDoctor(kernel.config)
      console.log(formatDoctorReport(report))
      await kernel.destroy()
      if (!report.ok) process.exitCode = 1
      break
    }

    case 'import': {
      const file = typeof flags.file === 'string' ? flags.file : undefined
      if (!file) throw new Error('Pass --file <path> to a portable JSON export ({ "<slug>": [rows] }).')
      const { config } = await loadConfig(flags)
      const payload = JSON.parse(readFileSync(resolve(process.cwd(), file), 'utf8')) as ImportPayload
      const kernel = await initKernel(config, { autoMigrate: true })
      const report = await importData(kernel, payload)
      const summary = Object.entries(report.created)
        .map(([slug, n]) => `${slug}: ${n}`)
        .join(', ')
      console.log(`✓ Imported ${report.total - report.errors.length}/${report.total} document(s) — ${summary}`)
      for (const e of report.errors) console.error(`  ✖ ${e.collection}[${e.index}] ${e.message}`)
      await kernel.destroy()
      if (!report.ok) process.exitCode = 1
      break
    }

    case 'seed': {
      const { config, seed } = await loadConfig(flags)
      if (!seed) throw new Error('No `seed` export found in the config module.')
      const kernel = await initKernel(config, { autoMigrate: true })
      await seed(kernel)
      console.log('✓ Seed complete.')
      await kernel.destroy()
      break
    }

    case 'jobs:run': {
      const { config } = await loadConfig(flags)
      const kernel = await initKernel(config)
      const { ran, failed } = await kernel.runDueJobs()
      console.log(`✓ Jobs: ${ran.length} ran, ${failed.length} failed.`)
      await kernel.destroy()
      break
    }

    case 'generate:types':
    case 'types': {
      const { config, path } = await loadConfig(flags)
      const output = generateTypes({ collections: config.collections, globals: config.globals ?? [] })
      const out =
        typeof flags.out === 'string' ? resolve(process.cwd(), flags.out) : resolve(dirname(path), 'kernel-types.ts')
      writeFileSync(out, output, 'utf8')
      console.log(`✓ Types written to ${out}`)
      break
    }

    case 'dev': {
      const { config } = await loadConfig(flags)
      const kernel = await initKernel(config, { autoMigrate: true })
      const port = typeof flags.port === 'string' ? Number(flags.port) : Number(process.env.PORT) || 3000
      const server = await serve(kernel, {
        port,
        apiKey: process.env.KERNEL_API_KEY,
        cors: true,
        admin: true,
        graphql: true,
        // Local development: don't throttle yourself. Production (`kernel start`)
        // keeps the default rate limiter on.
        rateLimit: { enabled: false },
      })
      console.log(`\n  KernelCMS dev server`)
      console.log(`  ➜  Admin:  ${server.url}/admin`)
      console.log(`  ➜  API:    ${server.url}${kernel.config.routes.api}`)
      console.log(`  ➜  Health: ${server.url}${kernel.config.routes.api}/health`)
      console.log(`  ➜  Collections: ${kernel.config.collections.map((c) => c.slug).join(', ') || '(none)'}`)
      if (!process.env.KERNEL_API_KEY) {
        console.log(`  !  Set KERNEL_API_KEY to enable trusted writes over HTTP.`)
      }
      const shutdown = async () => {
        await server.close()
        await kernel.destroy()
        process.exit(0)
      }
      process.on('SIGINT', shutdown)
      process.on('SIGTERM', shutdown)
      break
    }

    case 'start': {
      // Production serve: never auto-migrate (run `kernel migrate` as a discrete
      // deploy step first) and require an explicit secret + API key.
      const { config } = await loadConfig(flags)
      const kernel = await initKernel(config)
      const report = runDoctor(kernel.config, { env: 'production' })
      if (!report.ok) {
        console.error(formatDoctorReport(report))
        await kernel.destroy()
        process.exitCode = 1
        break
      }
      const port = typeof flags.port === 'string' ? Number(flags.port) : Number(process.env.PORT) || 3000
      const server = await serve(kernel, {
        port,
        apiKey: process.env.KERNEL_API_KEY,
        cors: process.env.KERNEL_CORS ? process.env.KERNEL_CORS.split(',') : false,
        admin: true,
        graphql: true,
      })
      console.log(`KernelCMS listening on ${server.url} (production)`)
      const shutdown = async () => {
        await server.close()
        await kernel.destroy()
        process.exit(0)
      }
      process.on('SIGINT', shutdown)
      process.on('SIGTERM', shutdown)
      break
    }

    case undefined:
    case 'help':
    case '--help':
      console.log(HELP)
      break

    default:
      console.error(`Unknown command "${command}".\n`)
      console.log(HELP)
      process.exitCode = 1
  }
}
