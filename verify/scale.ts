/* No-ceiling scale proof. Boots a REAL sqlite kernel from a programmatically
 * generated config with 200 collections (col_000..col_199) — well past
 * Contentful's 48 content-type cap and the ~100-collection wall Payload has been
 * reported to hit. Several collections carry relationship fields (so FK
 * auto-indexing + populate are exercised at scale), a couple enable drafts, and
 * one uses the blocks page-builder. We then migrate, assert all 200 tables
 * physically exist, run CRUD across many of them, populate a relationship across
 * two deep collections, and spot-check that a 201st collection works too — the
 * only limit is hardware.
 * Run: pnpm tsx verify/scale.ts */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { defineConfig, initKernel, type CollectionConfig, type KernelConfig } from '@kernel/core'
import { sqliteAdapter } from '@kernel/db-sqlite'

const require_ = createRequire(import.meta.url)
const { DatabaseSync } = require_('node:sqlite') as {
  DatabaseSync: new (p: string) => {
    prepare(sql: string): { all(): unknown[] }
    close(): void
  }
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

const COUNT = 200
const slug = (i: number) => `col_${String(i).padStart(3, '0')}`
const openAccess = { read: () => true, create: () => true, update: () => true, delete: () => true }

/** Build a config of `count` collections. Each gets a text + number field; every
 *  collection points a `parent` relationship at the PREVIOUS collection (so the
 *  graph is a deep chain and FK auto-indexing fires on every one). A handful also
 *  enable drafts and one uses blocks — exercising the heavier code paths at scale. */
function makeScaleConfig(dbUrl: string, count: number): KernelConfig {
  const collections: CollectionConfig[] = []
  for (let i = 0; i < count; i++) {
    const fields: CollectionConfig['fields'] = [
      { name: 'title', type: 'text', required: true },
      { name: 'seq', type: 'number' },
    ]
    // Relationship chain: col_i.parent -> col_(i-1). col_000 has no parent.
    if (i > 0) {
      fields.push({ name: 'parent', type: 'relationship', relationTo: slug(i - 1), onDelete: 'setNull' })
    }
    // Every 50th collection enables drafts (adds _status/_scheduled_at + a versions table).
    const drafty = i % 50 === 0 && i > 0
    // One collection carries a blocks page-builder field.
    if (i === 100) {
      fields.push({
        name: 'layout',
        type: 'blocks',
        blocks: [{ slug: 'hero', fields: [{ name: 'heading', type: 'text' }] }],
      })
    }
    collections.push({
      slug: slug(i),
      ...(drafty ? { versions: { drafts: true } } : {}),
      access: openAccess,
      fields,
    })
  }
  return defineConfig({
    secret: 'verify-scale-secret-32-characters!!',
    db: sqliteAdapter({ url: dbUrl }),
    collections,
  })
}

function physicalTables(dbFile: string): Set<string> {
  const raw = new DatabaseSync(dbFile)
  const rows = raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
  raw.close()
  return new Set(rows.map((r) => r.name))
}

function indexedColumns(dbFile: string, table: string): string[] {
  const raw = new DatabaseSync(dbFile)
  const idxNames = (
    raw.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='${table}'`).all() as Array<{
      name: string
    }>
  ).map((r) => r.name)
  const cols: string[] = []
  for (const name of idxNames) {
    const info = raw.prepare(`PRAGMA index_info('${name.replace(/'/g, "''")}')`).all() as Array<{ name: string }>
    for (const r of info) cols.push(r.name)
  }
  raw.close()
  return cols
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'kverify-scale-'))
  const dbFile = join(dir, 'scale.db')
  const config = makeScaleConfig(`file:${dbFile}`, COUNT)

  // ---- 0. No artificial cap survives sanitize/compile ----------------------
  section('0. Config carries 200 collections through compile (no cap)')
  check('config has exactly 200 collections', config.collections.length === COUNT, `len=${config.collections.length}`)

  // ---- 1. Boot + migrate 200 collections -----------------------------------
  section('1. Boot + migrate 200 collections (well past Contentful 48 / Payload ~100)')
  const t0 = performance.now()
  const kernel = await initKernel(config, { autoMigrate: true, logLevel: 'error' })
  const bootMs = Math.round(performance.now() - t0)

  const tables = physicalTables(dbFile)
  const missing: string[] = []
  for (let i = 0; i < COUNT; i++) if (!tables.has(slug(i))) missing.push(slug(i))
  check(
    'all 200 collection tables physically created',
    missing.length === 0,
    missing.length ? `missing=${missing.slice(0, 5).join(',')}…` : `${COUNT} tables`,
  )

  // ---- 2. FK auto-indexing fired at scale ----------------------------------
  section('2. Relationship columns auto-indexed at scale')
  const deepIdx = indexedColumns(dbFile, slug(150))
  check(
    'col_150.parent indexed (deep collection)',
    deepIdx.includes('parent'),
    `index cols: ${deepIdx.join(',') || '(none)'}`,
  )

  // ---- 3. CRUD across many collections -------------------------------------
  section('3. CRUD across many of the 200 collections')
  // Create one doc in every 10th collection; build a parent chain for two deep ones.
  let created = 0
  for (let i = 0; i < COUNT; i += 10) {
    await kernel.create({ collection: slug(i), data: { title: `doc ${i}`, seq: i }, overrideAccess: true } as never)
    created++
  }
  check('created a doc in every 10th collection', created === 20, `created=${created}`)

  // Populate a relationship across two DEEP collections: col_177 -> col_176.
  // (Neither is a multiple of 10, so the CRUD loop above didn't touch them — the
  // count assertions below stay exact.)
  const parentDoc = await kernel.create({
    collection: slug(176),
    data: { title: 'deep parent', seq: 176 },
    overrideAccess: true,
  } as never)
  const childDoc = await kernel.create({
    collection: slug(177),
    data: { title: 'deep child', seq: 177, parent: parentDoc.id },
    overrideAccess: true,
  } as never)
  const populated = await kernel.findByID({
    collection: slug(177),
    id: childDoc.id,
    depth: 1,
    overrideAccess: true,
  } as never)
  check(
    'relationship populated across two deep collections (depth:1)',
    typeof populated?.parent === 'object' && populated?.parent?.title === 'deep parent',
    `parent=${JSON.stringify(populated?.parent)?.slice(0, 50)}`,
  )

  // ---- 4. Query / count correctness at scale -------------------------------
  section('4. Query + count are correct at scale')
  const listed = await kernel.find({ collection: slug(177), limit: 10, page: 1, overrideAccess: true } as never)
  const listDocs = listed.docs ?? listed
  check(
    'find returns the deep-collection doc',
    listDocs.length === 1 && listDocs[0]?.title === 'deep child',
    `count=${listDocs.length}`,
  )
  const counted = await kernel.count({ collection: slug(0), overrideAccess: true } as never)
  check('count on col_000 is correct', counted === 1, `count=${counted}`)

  // ---- 5. Spot-check: a 201st collection also works (no ceiling) ------------
  section('5. A 201st collection migrates + works (still no ceiling)')
  await kernel.destroy()
  const dbFile2 = join(dir, 'scale-201.db')
  const config201 = makeScaleConfig(`file:${dbFile2}`, COUNT + 1)
  check(
    '201-collection config survives compile',
    config201.collections.length === COUNT + 1,
    `len=${config201.collections.length}`,
  )
  const kernel201 = await initKernel(config201, { autoMigrate: true, logLevel: 'error' })
  const tables201 = physicalTables(dbFile2)
  check('the 201st collection table exists', tables201.has(slug(COUNT)), `has ${slug(COUNT)}`)
  const doc201 = await kernel201.create({
    collection: slug(COUNT),
    data: { title: 'past the wall', seq: COUNT },
    overrideAccess: true,
  } as never)
  check('CRUD works on the 201st collection', Boolean(doc201.id), `id=${doc201.id}`)
  await kernel201.destroy()

  console.log(`\n\x1b[1mno ceiling: ${COUNT} collections booted in ${bootMs}ms\x1b[0m`)
  console.log(`\x1b[1mScale Result: ${pass} passed, ${fails.length} failed\x1b[0m`)
  if (fails.length) {
    console.log('Failures:\n  ' + fails.join('\n  '))
    process.exit(1)
  }
  process.exit(0)
}
main().catch((e) => {
  console.error('SCALE HARNESS ERROR:', e)
  process.exit(2)
})
