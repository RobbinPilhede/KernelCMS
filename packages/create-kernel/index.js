#!/usr/bin/env node
/**
 * create-kernel — scaffold a KernelCMS app on TanStack Start.
 *
 * Usage:
 *   npm  create kernel@latest my-app
 *   pnpm create kernel my-app
 *   yarn create kernel my-app
 *
 * Zero runtime dependencies (Node built-ins only). The template vendors the
 * KernelCMS engine, so the generated app runs even before @kernel/* packages
 * are published.
 */
import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const selfPkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8'))

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
}
const paint = (s, ...codes) => (stdout.isTTY ? codes.join('') + s + C.reset : s)

const TEMPLATES = {
  start: 'TanStack Start blog — SSR pages reading the KernelCMS Local API (SQLite)',
}

const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', '.nitro', '.output', '.tanstack', '.vinxi', '.vscode'])
const EXCLUDE_FILES = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lockb',
  '.cta.json',
  'todos.json',
  'AGENTS.md',
])

function parseArgs(argv) {
  const flags = {}
  const positionals = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') flags.help = true
    else if (a === '--version' || a === '-v') flags.version = true
    else if (a === '--no-install') flags.noInstall = true
    else if (a === '--force' || a === '-f') flags.force = true
    else if (a === '--template' || a === '-t') flags.template = argv[++i]
    else if (a.startsWith('--template=')) flags.template = a.slice('--template='.length)
    else if (a === '--pm') flags.pm = argv[++i]
    else if (a.startsWith('--pm=')) flags.pm = a.slice('--pm='.length)
    else if (!a.startsWith('-')) positionals.push(a)
  }
  return { flags, positionals }
}

function detectPM(override) {
  if (override) return override
  const ua = process.env.npm_config_user_agent || ''
  if (ua.startsWith('pnpm')) return 'pnpm'
  if (ua.startsWith('yarn')) return 'yarn'
  if (ua.startsWith('bun')) return 'bun'
  return 'npm'
}

function runInstall(pm, cwd) {
  // The command is built only from a whitelisted package-manager name plus a
  // literal subcommand — there is no user input — so a shell invocation is safe.
  // Passing one command string (not an args array) also sidesteps Node's DEP0190
  // while still resolving .cmd launchers correctly on Windows.
  const command = pm === 'yarn' ? 'yarn' : `${pm} install`
  return spawnSync(command, { cwd, stdio: 'inherit', shell: true })
}

function printHelp() {
  console.log(`
${paint('create-kernel', C.bold)} — scaffold a KernelCMS app on TanStack Start

${paint('Usage:', C.bold)}
  npm  create kernel@latest ${paint('[name]', C.dim)} ${paint('[options]', C.dim)}
  pnpm create kernel ${paint('[name]', C.dim)} ${paint('[options]', C.dim)}

${paint('Options:', C.bold)}
  -t, --template <id>   Template to use (default: start)
      --pm <pm>         Package manager: npm | pnpm | yarn | bun
      --no-install      Skip installing dependencies
  -f, --force           Overwrite a non-empty target directory
  -h, --help            Show this help
  -v, --version         Print version

${paint('Templates:', C.bold)}
  start   ${TEMPLATES.start}
`)
}

async function main() {
  const { flags, positionals } = parseArgs(process.argv.slice(2))
  if (flags.version) {
    console.log(selfPkg.version)
    return
  }
  if (flags.help) {
    printHelp()
    return
  }

  console.log(
    '\n' + paint('  ◆ KernelCMS', C.bold, C.magenta) + '  ' + paint('create-kernel v' + selfPkg.version, C.dim) + '\n',
  )

  const template = flags.template || 'start'
  if (!TEMPLATES[template]) {
    console.error(paint(`Unknown template "${template}". Available: ${Object.keys(TEMPLATES).join(', ')}`, C.red))
    process.exit(1)
  }
  const templateDir = join(__dirname, 'template', template)
  if (!existsSync(templateDir)) {
    console.error(paint(`Template files are missing at ${templateDir}.`, C.red))
    process.exit(1)
  }

  let name = positionals[0]
  if (!name) {
    if (stdin.isTTY) {
      const rl = createInterface({ input: stdin, output: stdout })
      const answer = await rl.question(paint('Project name: ', C.cyan) + paint('(my-kernel-app) ', C.dim))
      rl.close()
      name = answer.trim() || 'my-kernel-app'
    } else {
      name = 'my-kernel-app'
    }
  }
  name = name.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+|-+$/g, '') || 'my-kernel-app'

  const target = resolve(process.cwd(), name)
  if (existsSync(target) && readdirSync(target).length > 0 && !flags.force) {
    console.error(paint(`\nDirectory "${name}" already exists and is not empty. Use --force to overwrite.`, C.red))
    process.exit(1)
  }

  console.log(
    paint('Creating a KernelCMS app in ', C.dim) +
      paint(`./${name}`, C.bold) +
      paint(`  (template: ${template})\n`, C.dim),
  )

  cpSync(templateDir, target, {
    recursive: true,
    filter: (src) => {
      const b = basename(src)
      if (EXCLUDE_DIRS.has(b) || EXCLUDE_FILES.has(b)) return false
      if (/\.(db|db-shm|db-wal|sqlite|sqlite3)$/.test(b)) return false
      return true
    },
  })

  const pkgPath = join(target, 'package.json')
  if (existsSync(pkgPath)) {
    const tpkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    tpkg.name = name
    writeFileSync(pkgPath, JSON.stringify(tpkg, null, 2) + '\n')
  }
  console.log(paint('✓ Project files created.', C.green))

  const pm = detectPM(flags.pm)
  let installed = false
  if (!flags.noInstall) {
    console.log(paint(`\nInstalling dependencies with ${pm}…\n`, C.dim))
    const res = runInstall(pm, target)
    installed = !res.error && res.status === 0
    if (!installed)
      console.log(paint('\nDependency install did not complete — you can run it yourself below.', C.yellow))
    else console.log(paint('\n✓ Dependencies installed.', C.green))
  }

  const runDev = pm === 'npm' ? 'npm run dev' : `${pm} dev`
  console.log('\n' + paint('  ✦ Done! Your KernelCMS app is ready.', C.bold, C.green) + '\n')
  console.log('  Next steps:')
  console.log(paint(`    cd ${name}`, C.cyan))
  if (flags.noInstall || !installed) console.log(paint(`    ${pm === 'yarn' ? 'yarn' : pm + ' install'}`, C.cyan))
  console.log(paint(`    ${runDev}`, C.cyan))
  console.log('\n  Then open the URL the dev server prints ' + paint('(default http://localhost:3000)', C.dim) + '.')
  console.log(paint('\n  Edit src/server/config.ts to shape your content model. Happy building!\n', C.dim))
}

main().catch((err) => {
  console.error(paint('\nError: ' + (err && err.message ? err.message : String(err)), C.red))
  process.exit(1)
})
