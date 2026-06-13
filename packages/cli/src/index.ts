import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  EMPTY_SCHEMA,
  assertProductionSecret,
  diffSchema,
  formatDoctorReport,
  formatSystemInfo,
  generateTypes,
  importData,
  initKernel,
  runDoctor,
  sanitizeConfig,
  summarizePlan,
  systemInfo,
  type ImportPayload,
} from '@kernel/core'
import type { Kernel, KernelConfig, KernelSchema } from '@kernel/core'
import { serve } from '@kernel/server'
import { configTemplate, moduleTemplate, toSlug } from './templates'
import { IMPORT_SOURCES, formatImportReport, isImportSource, loadAdapter, runImport, type ImportInput } from './import'

/** Pick the stdio agent principal: explicit --agent, else the sole configured
 *  agent. Ambiguous / empty / unknown is a hard, explained error. Pure so it's
 *  testable without loading a config file. */
export function selectStdioAgent<A extends { id: string }>(
  agents: A[],
  agentId: string | undefined,
): { agent: A } | { error: string } {
  if (agentId) {
    const found = agents.find((a) => a.id === agentId)
    return found ? { agent: found } : { error: `No agent with id "${agentId}" found in kernel.config.agents.` }
  }
  if (agents.length === 0) {
    return {
      error:
        'No agents configured. Add an `agents: [...]` entry to your kernel.config (id + token) ' +
        'so the MCP server has a principal to act as.',
    }
  }
  if (agents.length === 1) return { agent: agents[0]! }
  return {
    error: `Multiple agents configured (${agents.map((a) => a.id).join(', ')}). Pick one with --agent <id>.`,
  }
}

export { installWarningFilter, isSuppressedWarning } from './warnings'

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

// Upper bound on an import export file — adapters buffer the whole file, so refuse
// inputs large enough to OOM the process before any per-field clamp applies.
const MAX_IMPORT_FILE_BYTES = 256 * 1_048_576

const HELP = `KernelCMS CLI

Usage: kernel <command> [options]

Commands:
  init               Scaffold a starter kernel.config.ts in the current directory
  migrate            Create/update database tables from the config schema (--dry-run to preview SQL)
  migrate:plan       Preview the exact SQL a migrate would run, without touching the DB (alias: migrate --dry-run)
  migrate:rollback   Undo the last migration(s) — drops added columns/tables ([--steps N] [--dry-run] [--force])
  migrate:status     Diff the config schema against the saved snapshot (risk + online-safety classified)
  migrate:snapshot   Save the compiled schema to kernel/schema-snapshot.json
  backfill           Set a field across existing rows — --collection <slug> --field <name> --value <v> [--dry-run]
  info               Print a product overview of this KernelCMS instance
  doctor             Check the config + environment for misconfigurations
  import             Import content OUT of another CMS — --from <source> (dry-run by default)
  import:json        Import a portable KernelCMS JSON export (--file)
  seed               Run the exported seed() function
  jobs:run           Run all due background jobs once (drive from a cron)
  generate:types     Write generated TypeScript types for the content model
  generate:module    Scaffold a new module (collection + endpoint) — <name> [--out path]
  dev                Migrate, then start the REST API server (development)
  start              Serve for production (no auto-migrate; doctor-gated)
  mcp                Serve this kernel as an MCP server (stdio by default; --http for multi-agent)

Options:
  --config <path>    Path to kernel.config.ts (default: ./kernel.config.ts)
  --from <source>    "import" source: wordpress | contentful | sanity | strapi | payload
  --file <path>      Export file to import from
  --url <url>        Source REST base URL (strapi/payload fallback)
  --token <token>    Source API token (never logged)
  --apply            "import": actually write (default is a dry-run preview)
  --status <s>       "import": draft | published for imported docs (default: draft)
  --port <number>    Port for "dev"/"mcp --http" (default: $PORT or 3000)
  --out <path>       Output file for "generate:types"
  --agent <id>       Agent principal for "mcp" stdio (required if config has >1 agent)
  --http             Serve "mcp" over HTTP (multi-agent; principals come from the request token)
  --host <host>      Host to bind for "mcp --http" (default: 127.0.0.1)
  --dry-run          "migrate"/"migrate:rollback"/"backfill": compute without writing
  --force            "migrate:rollback": actually execute the (destructive) rollback
  --steps <n>        "migrate:rollback": how many migrations to undo (default 1)
  --collection <s>   "backfill": target collection slug
  --field <name>     "backfill": field to populate
  --value <v>        "backfill": value (parsed as JSON if it parses, else a string)
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
      console.log(
        `✓ Wrote ${out}\n\n` +
          `Next steps:\n  npm install kernelcms\n  npx kernel dev\n\n` +
          `Embedding in a TS/Next app? Node runs this .ts config natively and needs\n` +
          `.ts import extensions, so set in your tsconfig (don't exclude the config —\n` +
          `you'd lose type-checking):\n` +
          `  "compilerOptions": { "moduleResolution": "bundler", "allowImportingTsExtensions": true, "noEmit": true }`,
      )
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

    case 'migrate:plan':
    case 'migrate': {
      const { config, path } = await loadConfig(flags)
      const kernel = await initKernel(config)
      // `--dry-run` (or the `migrate:plan` alias) previews the EXACT SQL without
      // touching the database. The bundled adapters apply additive changes only —
      // they create tables and add columns, but never drop or retype (no data loss by
      // surprise). If a snapshot exists, surface destructive drift either way so it
      // isn't silently skipped.
      const dryRun = command === 'migrate:plan' || flags['dry-run'] === true || flags.plan === true
      const snapshotPath = resolve(dirname(path), 'kernel', 'schema-snapshot.json')
      const current: KernelSchema = existsSync(snapshotPath)
        ? (JSON.parse(readFileSync(snapshotPath, 'utf8')) as KernelSchema)
        : EMPTY_SCHEMA
      const plan = diffSchema(current, kernel.schema)
      if (dryRun) {
        console.log('— Migration plan (risk + online-safety classified) —')
        console.log(summarizePlan(plan))
        const report = await kernel.migrate({ dryRun: true })
        console.log('\n— SQL that WOULD run (nothing was executed) —')
        console.log(report.statements.length ? report.statements.join('\n') : '  (no statements — schema up to date)')
        console.log(
          `\nDry run: ${report.createdTables.length} table(s) would be created, ` +
            `${report.addedColumns.length} column(s) would be added. The database was NOT modified.`,
        )
        if (plan.hasDestructive) {
          console.log(
            '\n⚠  Destructive changes are shown above but the additive migrate never applies them — ' +
              'run them by hand (expand → backfill → contract for online safety).',
          )
        }
        await kernel.destroy()
        break
      }
      if (existsSync(snapshotPath)) {
        const destructive = plan.ops.filter((o) => o.class === 'destructive')
        if (destructive.length) {
          console.log('⚠  Destructive changes detected — NOT applied automatically:')
          console.log(summarizePlan({ ops: destructive, hasDestructive: true, onlineSafe: false, empty: false }))
          console.log('   Apply these by hand before relying on the new schema, then re-run migrate:snapshot.\n')
        }
      }
      // Through kernel.migrate so a `_migrations` journal row is recorded (enables rollback).
      const report = await kernel.migrate()
      console.log(
        `✓ Migration complete — ${report.createdTables.length} table(s) created, ${report.addedColumns.length} column(s) added.`,
      )
      if (report.createdTables.length) console.log(`  Created: ${report.createdTables.join(', ')}`)
      console.log(`  Tip: run "kernel migrate:snapshot" to record this schema for future drift checks.`)
      await kernel.destroy()
      break
    }

    case 'migrate:rollback': {
      // Rollback DROPS schema (the columns/tables the last migration added), so it is
      // destructive by definition and requires an explicit --force to actually run.
      // Without --force it prints the inverse SQL and refuses.
      const { config } = await loadConfig(flags)
      const kernel = await initKernel(config)
      const steps = typeof flags.steps === 'string' ? Math.max(1, Number(flags.steps) || 1) : 1
      const force = flags.force === true
      const dryRun = flags['dry-run'] === true || !force
      const result = await kernel.rollbackMigration({ steps, dryRun })
      if (result.reverted.length === 0) {
        console.log('Nothing to roll back — the migration journal is empty.')
        await kernel.destroy()
        break
      }
      console.log(
        `${dryRun ? '— Rollback plan (NOT executed) —' : '✓ Rolled back'} ` +
          `${result.reverted.length} migration(s) (newest-first).`,
      )
      console.log('Inverse SQL:')
      console.log(result.statements.length ? '  ' + result.statements.join('\n  ') : '  (no statements)')
      if (dryRun && !force) {
        console.log(
          '\n⚠  This will DROP the columns/tables listed above and CANNOT be undone. ' +
            'Re-run with --force to execute:\n   kernel migrate:rollback' +
            (steps > 1 ? ` --steps ${steps}` : '') +
            ' --force',
        )
      }
      await kernel.destroy()
      break
    }

    case 'backfill': {
      // Populate a (typically newly-added, nullable) field across existing rows — the
      // middle step of the safe online sequence: add nullable column → backfill →
      // tighten to required in a later migration.
      const { config } = await loadConfig(flags)
      const collection = typeof flags.collection === 'string' ? flags.collection : undefined
      const fieldName = typeof flags.field === 'string' ? flags.field : undefined
      if (!collection || !fieldName) {
        console.error('Usage: kernel backfill --collection <slug> --field <name> --value <v> [--dry-run]')
        process.exitCode = 1
        break
      }
      if (!('value' in flags)) {
        console.error('Pass --value <v> (parsed as JSON if it parses, else treated as a string).')
        process.exitCode = 1
        break
      }
      // --value is parsed as JSON when it parses (so 42, true, null, ["a"] keep their
      // type), otherwise treated as a literal string.
      const raw = flags.value
      let value: unknown = raw
      if (typeof raw === 'string') {
        try {
          value = JSON.parse(raw)
        } catch {
          value = raw
        }
      }
      const dryRun = flags['dry-run'] === true
      const kernel = await initKernel(config)
      const result = await kernel.backfill({ collection, field: fieldName, value, dryRun })
      console.log(
        dryRun
          ? `Dry run: ${result.matched} document(s) match and WOULD be backfilled (nothing written).`
          : `✓ Backfilled ${result.updated}/${result.matched} document(s) — set ${collection}.${fieldName}.`,
      )
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
      // Static config checks first — these never touch the database, so they still
      // run (and report) even when the database is unreachable.
      const report = runDoctor(sanitizeConfig(config))
      console.log(formatDoctorReport(report))
      // Then a runtime probe: can we actually open and query the database?
      let dbOk = false
      try {
        const kernel = await initKernel(config)
        const health = await kernel.db.health()
        dbOk = health.status === 'ok'
        console.log(
          dbOk
            ? '\n✓ Database reachable.'
            : `\n✖ Database ${health.status}${health.detail ? `: ${health.detail}` : ''}`,
        )
        await kernel.destroy()
      } catch (err) {
        console.error(`\n✖ Database unreachable: ${err instanceof Error ? err.message : String(err)}`)
      }
      if (!report.ok || !dbOk) process.exitCode = 1
      break
    }

    case 'import': {
      // Migrate content OUT of a competitor CMS and INTO KernelCMS. Dry-run by default —
      // destructive writes are opt-in (--apply/--write), so a curious `kernel import` can
      // never mutate the database. The adapter parses the export; the engine maps ids,
      // resolves relationships in a second pass, and prints an honest report.
      const from = typeof flags.from === 'string' ? flags.from : undefined
      if (!from) {
        throw new Error(`Pass --from <source> (one of: ${IMPORT_SOURCES.join(', ')}).`)
      }
      if (!isImportSource(from)) {
        throw new Error(`Unknown import source "${from}". Use one of: ${IMPORT_SOURCES.join(', ')}.`)
      }
      const file = typeof flags.file === 'string' ? flags.file : undefined
      const url = typeof flags.url === 'string' ? flags.url : undefined
      if (!file && !url) {
        throw new Error(`Pass --file <path> (an exported file) to import from ${from}.`)
      }
      const apply = flags.apply === true || flags.write === true
      const dryRun = !apply
      const statusFlag = typeof flags.status === 'string' ? flags.status : undefined
      if (statusFlag && statusFlag !== 'draft' && statusFlag !== 'published') {
        throw new Error(`--status must be "draft" or "published" (got "${statusFlag}").`)
      }
      const defaultStatus = statusFlag === 'published' ? 'published' : 'draft'

      // Adapters read the whole file into memory; refuse pathologically large inputs
      // up front so a multi-GB export can't OOM the import before any per-field clamp.
      const resolvedFile = file ? resolve(process.cwd(), file) : undefined
      if (resolvedFile) {
        const bytes = statSync(resolvedFile).size
        if (bytes > MAX_IMPORT_FILE_BYTES) {
          throw new Error(
            `Import file is ${(bytes / 1_048_576).toFixed(0)} MiB; the limit is ${MAX_IMPORT_FILE_BYTES / 1_048_576} MiB. ` +
              `Split the export into smaller files.`,
          )
        }
      }

      const { config } = await loadConfig(flags)
      const adapter = await loadAdapter(from)
      const input: ImportInput = {
        ...(resolvedFile ? { file: resolvedFile } : {}),
        ...(url ? { url } : {}),
        ...(typeof flags.token === 'string' ? { token: flags.token } : {}),
        ...(typeof flags.space === 'string' ? { space: flags.space } : {}),
        ...(typeof flags.dataset === 'string' ? { dataset: flags.dataset } : {}),
      }
      const dataset = await adapter.read(input)
      for (const note of dataset.notes ?? []) console.log(`  note: ${note}`)

      const kernel = await initKernel(config, { autoMigrate: true })
      const report = await runImport(kernel, dataset, { dryRun, defaultStatus, source: adapter.name })
      console.log(formatImportReport(report))
      await kernel.destroy()
      if (report.errors.length) process.exitCode = 1
      break
    }

    case 'import:json': {
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
      // Fail closed on a missing/dev/weak secret before anything else (initKernel
      // enforces this too; the explicit call keeps the guarantee visible here).
      assertProductionSecret(config)
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
        // GraphQL is extra, unbounded attack surface that most deployments never
        // use, so it is off by default in production. Opt back in with
        // KERNEL_GRAPHQL=true (depth + field-count limits still apply).
        graphql: process.env.KERNEL_GRAPHQL === 'true',
        // The OpenAPI spec + Scalar docs map every collection and field, so they
        // are off by default in production (they would hand an attacker a full API
        // blueprint, unauthenticated). Opt back in with KERNEL_OPENAPI=true.
        openapi: process.env.KERNEL_OPENAPI === 'true',
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

    case 'mcp': {
      // Lazy-load @kernel/mcp (and through it the MCP SDK) only when this command
      // runs, so the SDK never weighs on the lean core / other commands. A failed
      // import almost always means the peer SDK isn't installed — say so plainly.
      let mcp: typeof import('@kernel/mcp')
      try {
        mcp = await import('@kernel/mcp')
      } catch {
        console.error('MCP support needs @modelcontextprotocol/sdk — install it: npm install @modelcontextprotocol/sdk')
        process.exitCode = 1
        break
      }

      const http = flags.http === true
      const { config } = await loadConfig(flags)

      if (http) {
        // Multi-agent: principals are resolved per-request from the bearer token by
        // serveHttp, so no --agent here. Plain logging is fine (stdout isn't a transport).
        const kernel = await initKernel(config)
        const port = typeof flags.port === 'string' ? Number(flags.port) : Number(process.env.PORT) || 4000
        const host = typeof flags.host === 'string' ? flags.host : undefined
        const server = mcp.serveHttp(kernel, { port, host })
        const addr = server.address()
        const shown = addr && typeof addr === 'object' ? `${addr.address}:${addr.port}` : String(port)
        console.log(`KernelCMS MCP (HTTP) listening on ${shown}/mcp`)
        console.log(`  Agents authenticate per-request with a bearer token (Authorization: Bearer <token>).`)
        const shutdown = async () => {
          await new Promise<void>((res) => server.close(() => res()))
          await kernel.destroy()
          process.exit(0)
        }
        process.on('SIGINT', shutdown)
        process.on('SIGTERM', shutdown)
        break
      }

      // stdio (default): Claude Desktop / Cursor spawn this process and speak
      // JSON-RPC over stdout. stdout is the TRANSPORT — nothing human-readable may
      // touch it, so load the kernel at 'error' level (info/debug go to stdout) and
      // route every diagnostic here to stderr.
      const kernel = await initKernel(config, { logLevel: 'error' })

      // Pick the single agent principal for this stdio session: explicit --agent,
      // else the sole configured agent. Ambiguous/empty is a hard, explained error.
      const agentId = typeof flags.agent === 'string' ? flags.agent : undefined
      const picked = selectStdioAgent(kernel.config.agents, agentId)
      if ('error' in picked) {
        await kernel.destroy()
        console.error(picked.error)
        process.exitCode = 1
        break
      }
      const agent = picked.agent

      const principal = mcp.resolveAgentPrincipal(kernel, agent.token)
      // resolveAgentPrincipal can't realistically miss here (we read the token from
      // the same config), but never connect a transport without a principal.
      if (!principal) {
        await kernel.destroy()
        console.error(`Could not resolve a principal for agent "${agent.id}".`)
        process.exitCode = 1
        break
      }

      // Diagnostics to stderr only — stdout stays pure protocol.
      console.error(`KernelCMS MCP (stdio) serving as agent "${agent.id}".`)
      const server = await mcp.serveStdio(kernel, {
        principal: {
          id: principal.id,
          ...(principal.roles ? { roles: principal.roles } : {}),
          ...(principal.fieldScope ? { fieldScope: principal.fieldScope } : {}),
        },
      })
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
