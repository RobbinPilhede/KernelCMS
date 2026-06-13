/* Live migration verification: dry-run preview, journal, rollback (+ safety),
 * backfill, and online-safe classification — all against a real sqlite kernel.
 * Run: pnpm tsx verify/migration.ts */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import {
  EMPTY_SCHEMA,
  MIGRATIONS_TABLE,
  defineConfig,
  diffSchema,
  initKernel,
  type ColumnSchema,
  type KernelConfig,
  type KernelSchema,
  type TableSchema,
} from '@kernel/core'
import { sqliteAdapter } from '@kernel/db-sqlite'

const require_ = createRequire(import.meta.url)
const { DatabaseSync } = require_('node:sqlite') as {
  DatabaseSync: new (p: string) => { prepare(sql: string): { all(): unknown[] } }
}

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

// Direct, out-of-band SQL read so "did a table physically get created?" can't be
// answered by the kernel's own registry — only by the actual database.
function physicalTables(dbFile: string): Set<string> {
  const raw = new DatabaseSync(dbFile)
  const rows = raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
  return new Set(rows.map((r) => r.name))
}

const baseConfig = (dbFile: string): KernelConfig =>
  defineConfig({
    secret: 'verify-migration-secret-32-chars!!',
    db: sqliteAdapter({ url: `file:${dbFile}` }),
    collections: [
      {
        slug: 'posts',
        access: { read: () => true, create: () => true, update: () => true, delete: () => true },
        fields: [
          { name: 'title', type: 'text' },
          { name: 'views', type: 'number' },
        ],
      },
    ],
  })

// A second config that ADDS a collection + a column on the existing one — the migration
// we roll back.
const grownConfig = (dbFile: string): KernelConfig =>
  defineConfig({
    secret: 'verify-migration-secret-32-chars!!',
    db: sqliteAdapter({ url: `file:${dbFile}` }),
    collections: [
      {
        slug: 'posts',
        access: { read: () => true, create: () => true, update: () => true, delete: () => true },
        fields: [
          { name: 'title', type: 'text' },
          { name: 'views', type: 'number' },
          { name: 'tier', type: 'text' }, // new nullable column on existing table
        ],
      },
      {
        slug: 'tags',
        access: { read: () => true, create: () => true, update: () => true, delete: () => true },
        fields: [{ name: 'name', type: 'text' }],
      },
    ],
  })

const col = (name: string, type: ColumnSchema['type'] = 'text', extra: Partial<ColumnSchema> = {}): ColumnSchema => ({
  name,
  type,
  required: false,
  unique: false,
  indexed: false,
  localized: false,
  ...extra,
})
const table = (name: string, columns: ColumnSchema[]): TableSchema => ({
  table: name,
  slug: name,
  columns,
  timestamps: true,
  singleton: false,
})

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'kverify-migration-'))
  const dbFile = join(dir, 'm.db')

  // ---- Dry run creates nothing ------------------------------------------------
  section('Dry-run preview — computes SQL, touches nothing')
  const k1 = await initKernel(baseConfig(dbFile), { logLevel: 'error' })
  const dry = await k1.migrate({ dryRun: true })
  check(
    'dry-run report lists CREATE statements',
    dry.statements.some((s) => /CREATE TABLE/.test(s)),
    `${dry.statements.length} stmts`,
  )
  check('dry-run report would create posts', dry.createdTables.includes('posts'), dry.createdTables.join(','))
  const afterDry = physicalTables(dbFile)
  check(
    'dry-run created NO physical tables',
    !afterDry.has('posts') && !afterDry.has(MIGRATIONS_TABLE),
    `tables=${[...afterDry].join(',') || '(none)'}`,
  )

  // ---- Real migrate creates tables + journal ----------------------------------
  section('Real migrate — applies + journals')
  await k1.migrate()
  const afterReal = physicalTables(dbFile)
  check('real migrate created posts', afterReal.has('posts'), 'physical table exists')
  check('real migrate provisioned _migrations', afterReal.has(MIGRATIONS_TABLE), '')
  const journal1 = await k1.db.find({ collection: MIGRATIONS_TABLE, limit: 10, page: 1 })
  check('journal has exactly one row', journal1.totalDocs === 1, `count=${journal1.totalDocs}`)
  check(
    'journal row records createdTables + statements',
    Array.isArray(journal1.docs[0]?.createdTables) &&
      (journal1.docs[0]!.createdTables as string[]).includes('posts') &&
      Array.isArray(journal1.docs[0]?.statements),
    `createdTables=${(journal1.docs[0]?.createdTables as string[] | undefined)?.join(',')}`,
  )
  // Seed three posts so we can prove untouched data survives rollback.
  for (let i = 0; i < 3; i++) await k1.create({ collection: 'posts', data: { title: `p${i}`, views: i } })
  // An empty re-migrate writes no new journal row.
  await k1.migrate()
  const journalEmpty = await k1.db.find({ collection: MIGRATIONS_TABLE, limit: 10, page: 1 })
  check('empty migrate adds no journal row', journalEmpty.totalDocs === 1, `count=${journalEmpty.totalDocs}`)
  await k1.destroy()

  // ---- Grow the schema, then roll it back -------------------------------------
  section('Rollback — undoes the last migration, keeps data')
  const k2 = await initKernel(grownConfig(dbFile), { logLevel: 'error' })
  const grow = await k2.migrate()
  check('grow added tags table', physicalTables(dbFile).has('tags'), '')
  check('grow added posts.tier column', grow.addedColumns.includes('posts.tier'), grow.addedColumns.join(','))
  const journal2 = await k2.db.find({ collection: MIGRATIONS_TABLE, limit: 10, page: 1 })
  check('journal now has two rows', journal2.totalDocs === 2, `count=${journal2.totalDocs}`)

  // Dry-run rollback: shows DROP SQL, executes nothing.
  const rbPlan = await k2.rollbackMigration({ steps: 1, dryRun: true })
  check(
    'rollback dry-run yields DROP SQL',
    rbPlan.statements.some((s) => /DROP TABLE/.test(s)) && rbPlan.statements.some((s) => /DROP COLUMN/.test(s)),
    `${rbPlan.statements.length} stmts`,
  )
  check('rollback dry-run did NOT drop tags', physicalTables(dbFile).has('tags'), 'tags still present')
  const journalAfterDry = await k2.db.find({ collection: MIGRATIONS_TABLE, limit: 10, page: 1 })
  check(
    'rollback dry-run did NOT consume the journal row',
    journalAfterDry.totalDocs === 2,
    `count=${journalAfterDry.totalDocs}`,
  )

  // Real rollback.
  const rb = await k2.rollbackMigration({ steps: 1 })
  check('rollback reverted one entry', rb.reverted.length === 1, `reverted=${rb.reverted.length}`)
  const tablesAfter = physicalTables(dbFile)
  check('rollback dropped the tags table', !tablesAfter.has('tags'), `tables=${[...tablesAfter].join(',')}`)
  check(
    'rollback consumed the journal row',
    (await k2.db.find({ collection: MIGRATIONS_TABLE, limit: 10, page: 1 })).totalDocs === 1,
    '',
  )
  // posts.tier column is gone — querying it must fail (the column no longer exists).
  let tierGone = false
  try {
    await k2.find({ collection: 'posts', where: { tier: { equals: 'x' } } as never, limit: 1, page: 1 })
  } catch {
    tierGone = true
  }
  check('rollback dropped the posts.tier column', tierGone, 'filtering on tier now errors')
  // Untouched data survived.
  const survivors = await k2.find({ collection: 'posts', limit: 10, page: 1 })
  check('untouched posts data intact after rollback', survivors.totalDocs === 3, `count=${survivors.totalDocs}`)
  await k2.destroy()

  // ---- Rollback safety: never a system table / non-journaled drop -------------
  section('Rollback safety invariant')
  const k3 = await initKernel(baseConfig(dbFile), { logLevel: 'error' })
  // The physical DB still has posts + _migrations from earlier runs; a fresh migrate is a
  // no-op, so there's nothing left to roll back — the journal holds the original posts entry.
  const remaining = await k3.db.find({ collection: MIGRATIONS_TABLE, limit: 10, page: 1 })
  check('one journal entry remains (the original create)', remaining.totalDocs === 1, `count=${remaining.totalDocs}`)
  // Roll it back: it created `posts` — that IS journaled, so it drops; but _migrations must survive.
  await k3.rollbackMigration({ steps: 1 })
  const afterSafety = physicalTables(dbFile)
  check('rollback never dropped the _migrations system table', afterSafety.has(MIGRATIONS_TABLE), 'still present')
  await k3.destroy()

  // ---- Backfill ----------------------------------------------------------------
  section('Backfill — populate a new field across existing rows')
  const dbFile2 = join(dir, 'b.db')
  const k4 = await initKernel(grownConfig(dbFile2), { logLevel: 'error' })
  await k4.migrate()
  for (let i = 0; i < 3; i++) await k4.create({ collection: 'posts', data: { title: `b${i}`, views: i } })
  const bfDry = await k4.backfill({ collection: 'posts', field: 'tier', value: 'free', dryRun: true })
  check(
    'backfill dry-run reports matched=3 without writing',
    bfDry.matched === 3 && bfDry.updated === 0,
    `matched=${bfDry.matched} updated=${bfDry.updated}`,
  )
  const stillNull = await k4.find({ collection: 'posts', limit: 10, page: 1 })
  check(
    'backfill dry-run wrote nothing',
    stillNull.docs.every((d) => d.tier == null),
    '',
  )
  const bf = await k4.backfill({ collection: 'posts', field: 'tier', value: 'free' })
  check('backfill set all 3 rows', bf.matched === 3 && bf.updated === 3, `updated=${bf.updated}`)
  const filled = await k4.find({ collection: 'posts', limit: 10, page: 1 })
  check(
    'every row now has tier=free',
    filled.docs.every((d) => d.tier === 'free'),
    '',
  )
  const bfComputed = await k4.backfill({
    collection: 'posts',
    field: 'tier',
    set: (doc) => (Number(doc.views) >= 1 ? 'paid' : 'free'),
  })
  check('computed set(doc) backfill ran', bfComputed.updated === 3, `updated=${bfComputed.updated}`)
  const tiers = await k4.find({ collection: 'posts', limit: 10, page: 1, sort: 'views' })
  check(
    'computed backfill produced free/paid/paid',
    tiers.docs.map((d) => d.tier).join(',') === 'free,paid,paid',
    tiers.docs.map((d) => d.tier).join(','),
  )
  await k4.destroy()

  // ---- Backfill reaches DRAFT rows (regression: must not silently skip drafts) --
  section('Backfill — drafts are not silently skipped')
  const dbFile3 = join(dir, 'd.db')
  const kd = await initKernel(
    defineConfig({
      secret: 'verify-migration-secret-32-chars!!',
      db: sqliteAdapter({ url: `file:${dbFile3}` }),
      collections: [
        {
          slug: 'posts',
          versions: { drafts: true },
          access: { read: () => true, create: () => true, update: () => true, delete: () => true },
          fields: [
            { name: 'title', type: 'text' },
            { name: 'tier', type: 'text' },
          ],
        },
      ],
    }),
    { logLevel: 'error' },
  )
  await kd.migrate()
  // Two drafts + one published — the published-only read path would see just one.
  await kd.create({ collection: 'posts', data: { title: 'd0' } })
  await kd.create({ collection: 'posts', data: { title: 'd1' } })
  await kd.create({ collection: 'posts', data: { title: 'd2', _status: 'published' } as Row, overrideAccess: true })
  const bfDraft = await kd.backfill({ collection: 'posts', field: 'tier', value: 'free' })
  check(
    'backfill reaches all rows incl. drafts (matched===updated===3)',
    bfDraft.matched === 3 && bfDraft.updated === 3,
    `matched=${bfDraft.matched} updated=${bfDraft.updated}`,
  )
  const allRows = await kd.find({ collection: 'posts', draft: true, limit: 10, page: 1 })
  check(
    'every draft + published row now has tier=free',
    allRows.docs.every((d) => d.tier === 'free'),
    '',
  )
  // Regression guard for the steps:NaN clamp (programmatic API).
  const nanRoll = await kd.rollbackMigration({ steps: Number('x') as number, dryRun: true })
  check('rollback with NaN steps clamps to 1 (no crash)', Array.isArray(nanRoll.statements), '')
  await kd.destroy()

  // ---- Online-safe classification ---------------------------------------------
  section('Online-safe classification')
  const nullableAdd = diffSchema(
    { tables: [table('posts', [col('title')])] } as KernelSchema,
    { tables: [table('posts', [col('title'), col('subtitle')])] } as KernelSchema,
  )
  check('add-nullable-column is online-safe', nullableAdd.onlineSafe === true, '')
  const requiredAdd = diffSchema(
    { tables: [table('posts', [col('title')])] } as KernelSchema,
    { tables: [table('posts', [col('title'), col('slug', 'text', { required: true })])] } as KernelSchema,
  )
  check('add-required-column is NOT online-safe', requiredAdd.onlineSafe === false, '')
  const dropPlan = diffSchema(
    { tables: [table('posts', [col('title'), col('old')])] } as KernelSchema,
    { tables: [table('posts', [col('title')])] } as KernelSchema,
  )
  check('a drop is NOT online-safe', dropPlan.onlineSafe === false, '')
  const fromScratch = diffSchema(EMPTY_SCHEMA, { tables: [table('posts', [col('title')])] } as KernelSchema)
  check('create-table is online-safe', fromScratch.onlineSafe === true, '')

  console.log(`\n\x1b[1mMigration Result: ${pass} passed, ${fails.length} failed\x1b[0m`)
  if (fails.length) {
    console.log('Failures:\n  ' + fails.join('\n  '))
    process.exit(1)
  }
  process.exit(0)
}
main().catch((e) => {
  console.error('MIGRATION HARNESS ERROR:', e)
  process.exit(2)
})
