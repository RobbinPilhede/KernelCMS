/* create-kernel scaffold proof. For EACH starter model we:
 *   1. Spawn the real scaffolder (`node packages/create-kernel/index.js <dir>
 *      --model <name> --no-install`) into a temp dir, unattended.
 *   2. Assert the expected files exist and the generated `src/server/config.ts`
 *      names every collection of that model.
 *   3. BOOT the model through a real sqlite kernel — the verify harness consumes the
 *      SAME `models.js` the scaffolder renders from (`buildRuntime`), so this is the
 *      real content model, not a copy — then migrate(), seed(), and run a sample
 *      create + read to prove the scaffolded model actually RUNS, not just copies.
 * Also checks `--from-brief` maps a free-text brief to the right model OFFLINE.
 * Run: pnpm tsx verify/scaffold.ts */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { defineConfig, initKernel, type CollectionConfig, type GlobalConfig } from '@kernel/core'
import { sqliteAdapter } from '@kernel/db-sqlite'
// The scaffolder's own source of truth — imported directly so we boot the real model.
import { MODELS, buildRuntime, chooseModel, modelNames } from '../packages/create-kernel/models.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const scaffolder = join(__dirname, '..', 'packages', 'create-kernel', 'index.js')

let pass = 0
const fails: string[] = []
function check(name: string, cond: boolean, evidence = '') {
  if (cond) {
    pass++
    console.log(`  \x1b[32mPASS\x1b[0m ${name}${evidence ? ` — ${evidence}` : ''}`)
  } else {
    fails.push(name)
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}${evidence ? ` — ${evidence}` : ''}`)
  }
}
const section = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`)

const openAccess = { read: () => true, create: () => true, update: () => true, delete: () => true }

async function bootModel(modelName: string, dbUrl: string) {
  const runtime = buildRuntime(MODELS[modelName])
  // Widen access for the boot test so create/read run without auth (the scaffold
  // ships read-only public access; the harness exercises full CRUD).
  const collections = runtime.collections.map(
    (c: CollectionConfig): CollectionConfig => ({ ...c, access: { ...openAccess } }),
  )
  const globals = runtime.globals.map((g: GlobalConfig): GlobalConfig => ({ ...g, access: { ...openAccess } }))
  const config = defineConfig({
    secret: 'verify-scaffold-secret-32-characters!',
    db: sqliteAdapter({ url: dbUrl }),
    collections,
    globals,
  })
  const kernel = await initKernel(config, { autoMigrate: true, logLevel: 'error' })
  return { kernel, runtime }
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'kverify-scaffold-'))

  for (const modelName of modelNames()) {
    section(`Model "${modelName}" — scaffold + boot`)
    const model = MODELS[modelName]
    const appName = `app-${modelName}`
    const appDir = join(root, appName)

    // ---- 1. Spawn the real scaffolder, unattended -------------------------
    // The scaffolder takes a bare project NAME and creates it under its cwd, so we
    // pass the name and run it inside the temp root.
    const res = spawnSync('node', [scaffolder, appName, '--model', modelName, '--no-install'], {
      cwd: root,
      stdio: 'pipe',
      encoding: 'utf8',
    })
    check(
      `${modelName}: scaffolder exits 0`,
      res.status === 0,
      res.status === 0 ? '' : (res.stderr || '').slice(0, 200),
    )

    // ---- 2. Expected files exist ------------------------------------------
    const configPath = join(appDir, 'src', 'server', 'config.ts')
    check(`${modelName}: package.json created`, existsSync(join(appDir, 'package.json')))
    check(`${modelName}: src/server/config.ts created`, existsSync(configPath))
    check(`${modelName}: src/server/kernel.ts created`, existsSync(join(appDir, 'src', 'server', 'kernel.ts')))
    check(`${modelName}: routes/index.tsx created`, existsSync(join(appDir, 'src', 'routes', 'index.tsx')))

    // ---- 3. Generated config names every collection of the model ----------
    const source = existsSync(configPath) ? readFileSync(configPath, 'utf8') : ''
    const missing = model.collections.filter((c: CollectionConfig) => !source.includes(`slug: "${c.slug}"`))
    check(
      `${modelName}: config.ts references all ${model.collections.length} collections`,
      missing.length === 0,
      missing.length ? `missing=${missing.map((c: CollectionConfig) => c.slug).join(',')}` : '',
    )
    check(`${modelName}: config.ts exports a view descriptor`, source.includes('export const view'))

    // ---- 4. Boot the REAL model: migrate + seed + sample create/read ------
    const dbFile = join(appDir, 'verify.db')
    const { kernel, runtime } = await bootModel(modelName, `file:${dbFile}`)

    // Seed exactly as the scaffold would on first boot.
    await runtime.seed(kernel)

    const primary = runtime.view.primary
    const seeded = await kernel.find({ collection: primary, limit: 100, overrideAccess: true } as never)
    const seededDocs = seeded.docs ?? seeded
    check(
      `${modelName}: seed populated the primary collection "${primary}"`,
      seededDocs.length > 0,
      `count=${seededDocs.length}`,
    )

    // A relationship in the model populates at depth>0 (proves FK wiring runs).
    const relField = model.collections
      .flatMap((c: CollectionConfig) => c.fields.map((f) => ({ slug: c.slug, f })))
      .find((x: { f: { type: string } }) => x.f.type === 'relationship')
    if (relField) {
      const withRel = await kernel.find({
        collection: relField.slug,
        depth: 1,
        limit: 100,
        overrideAccess: true,
      } as never)
      const docs = withRel.docs ?? withRel
      const populated = docs.find((d: Record<string, unknown>) => {
        const v = d[(relField.f as { name: string }).name]
        return v && typeof v === 'object'
      })
      check(
        `${modelName}: relationship "${(relField.f as { name: string }).name}" populates at depth 1`,
        Boolean(populated),
        populated ? 'object value' : 'no populated doc found',
      )
    }

    // A fresh create + read on the primary collection (the model actually runs).
    const sample = sampleRow(model, primary)
    const created = await kernel.create({ collection: primary, data: sample, overrideAccess: true } as never)
    check(`${modelName}: create on "${primary}" works`, Boolean(created.id), `id=${created.id}`)
    const readBack = await kernel.findByID({ collection: primary, id: created.id, overrideAccess: true } as never)
    check(`${modelName}: read-back returns the created doc`, readBack?.id === created.id)

    await kernel.destroy()
  }

  // ---- 5. --from-brief maps briefs to models OFFLINE (deterministic) ------
  section('--from-brief maps free-text briefs to the closest model (offline, no LLM)')
  check('"online store selling products" → shop', chooseModel('an online store selling products') === 'shop')
  check('"documentation guide and manual" → docs', chooseModel('a documentation guide and manual') === 'docs')
  check('"portfolio of my project work" → portfolio', chooseModel('a portfolio of my project work') === 'portfolio')
  check('"a news blog with articles" → blog', chooseModel('a news blog with articles') === 'blog')
  check('empty brief → default blog', chooseModel('') === 'blog')

  console.log(`\n\x1b[1mScaffold Result: ${pass} passed, ${fails.length} failed\x1b[0m`)
  if (fails.length) {
    console.log('Failures:\n  ' + fails.join('\n  '))
    process.exit(1)
  }
  process.exit(0)
}

/** A minimal valid create payload for a model's primary collection (required fields). */
function sampleRow(model: { collections: CollectionConfig[] }, slug: string): Record<string, unknown> {
  const collection = model.collections.find((c) => c.slug === slug)!
  const row: Record<string, unknown> = {}
  let n = 0
  for (const f of collection.fields) {
    const field = f as { name: string; type: string; required?: boolean; options?: unknown[]; integer?: boolean }
    if (!field.required) continue
    if (field.type === 'number') row[field.name] = 1
    else if (field.type === 'email') row[field.name] = 'sample@example.com'
    else if (field.type === 'select' && Array.isArray(field.options)) row[field.name] = String(field.options[0])
    else if (field.type === 'slug') row[field.name] = `verify-sample-${n++}`
    else row[field.name] = `sample-${slug}-${n++}`
  }
  return row
}

main().catch((e) => {
  console.error('SCAFFOLD HARNESS ERROR:', e)
  process.exit(2)
})
