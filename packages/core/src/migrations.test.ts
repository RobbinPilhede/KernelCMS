import { describe, expect, it } from 'vitest'
import type { ColumnSchema, KernelSchema, MigrationJournalEntry, TableSchema } from '@kernel/db'
import {
  EMPTY_SCHEMA,
  diffSchema,
  downStatementsFor,
  indexNameFor,
  isOnlineSafe,
  summarizePlan,
  type SqlDialect,
} from './migrations'

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

const schema = (...tables: TableSchema[]): KernelSchema => ({ tables })

describe('diffSchema', () => {
  it('reports no changes for identical schemas', () => {
    const s = schema(table('posts', [col('title')]))
    const plan = diffSchema(s, s)
    expect(plan.empty).toBe(true)
    expect(plan.hasDestructive).toBe(false)
    expect(summarizePlan(plan)).toMatch(/up to date/)
  })

  it('plans a create table for a brand-new collection (safe)', () => {
    const plan = diffSchema(EMPTY_SCHEMA, schema(table('posts', [col('title')])))
    expect(plan.ops).toHaveLength(1)
    expect(plan.ops[0]).toMatchObject({ kind: 'createTable', table: 'posts', class: 'safe' })
    expect(plan.hasDestructive).toBe(false)
  })

  it('classifies a nullable column add as safe and a NOT NULL add as destructive', () => {
    const current = schema(table('posts', [col('title')]))
    const next = schema(table('posts', [col('title'), col('subtitle'), col('slug', 'text', { required: true })]))
    const plan = diffSchema(current, next)
    const add = plan.ops.find((o) => o.kind === 'addColumn' && o.column.name === 'subtitle')
    const addReq = plan.ops.find((o) => o.kind === 'addColumn' && o.column.name === 'slug')
    expect(add?.class).toBe('safe')
    expect(addReq?.class).toBe('destructive')
    expect(plan.hasDestructive).toBe(true)
  })

  it('marks dropped columns and tables as destructive', () => {
    const current = schema(table('posts', [col('title'), col('legacy')]), table('drafts', [col('x')]))
    const next = schema(table('posts', [col('title')]))
    const plan = diffSchema(current, next)
    expect(plan.ops.some((o) => o.kind === 'dropColumn' && o.column === 'legacy' && o.class === 'destructive')).toBe(
      true,
    )
    expect(plan.ops.some((o) => o.kind === 'dropTable' && o.table === 'drafts')).toBe(true)
    expect(plan.hasDestructive).toBe(true)
  })

  it('detects type changes and required tightening as destructive', () => {
    const current = schema(table('posts', [col('views', 'text'), col('slug', 'text', { required: false })]))
    const next = schema(table('posts', [col('views', 'integer'), col('slug', 'text', { required: true })]))
    const plan = diffSchema(current, next)
    expect(plan.ops.some((o) => o.kind === 'alterColumnType' && o.from === 'text' && o.to === 'integer')).toBe(true)
    expect(
      plan.ops.some((o) => o.kind === 'setColumnRequired' && o.required === true && o.class === 'destructive'),
    ).toBe(true)
  })

  it('orders creates before destructive drops', () => {
    const current = schema(table('old', [col('x')]))
    const next = schema(table('new', [col('y')]))
    const plan = diffSchema(current, next)
    const createIdx = plan.ops.findIndex((o) => o.kind === 'createTable')
    const dropIdx = plan.ops.findIndex((o) => o.kind === 'dropTable')
    expect(createIdx).toBeLessThan(dropIdx)
  })

  it('is deterministic — same inputs yield an identical plan', () => {
    const current = schema(table('posts', [col('title')]))
    const next = schema(table('posts', [col('title'), col('body')]), table('tags', [col('name')]))
    expect(diffSchema(current, next)).toEqual(diffSchema(current, next))
  })
})

describe('online-safe classification', () => {
  it('marks create-table, create-index, and nullable-column adds as online-safe', () => {
    const plan = diffSchema(
      schema(table('posts', [col('title')])),
      schema(table('posts', [col('title'), col('subtitle')]), table('tags', [col('name', 'text', { indexed: true })])),
    )
    expect(plan.onlineSafe).toBe(true)
    expect(plan.ops.every(isOnlineSafe)).toBe(true)
  })

  it('marks an add-required-column as NOT online-safe', () => {
    const plan = diffSchema(
      schema(table('posts', [col('title')])),
      schema(table('posts', [col('title'), col('slug', 'text', { required: true })])),
    )
    const add = plan.ops.find((o) => o.kind === 'addColumn')!
    expect(isOnlineSafe(add)).toBe(false)
    expect(plan.onlineSafe).toBe(false)
  })

  it('marks drops and type changes as NOT online-safe', () => {
    const drop = diffSchema(
      schema(table('posts', [col('title'), col('legacy')])),
      schema(table('posts', [col('title')])),
    )
    expect(drop.onlineSafe).toBe(false)

    const retype = diffSchema(
      schema(table('posts', [col('views', 'text')])),
      schema(table('posts', [col('views', 'integer')])),
    )
    expect(retype.onlineSafe).toBe(false)
  })

  it('marks loosening NOT NULL → NULL as online-safe but tightening as not', () => {
    const loosen = diffSchema(
      schema(table('posts', [col('slug', 'text', { required: true })])),
      schema(table('posts', [col('slug', 'text', { required: false })])),
    )
    expect(loosen.onlineSafe).toBe(true)
    const tighten = diffSchema(
      schema(table('posts', [col('slug', 'text', { required: false })])),
      schema(table('posts', [col('slug', 'text', { required: true })])),
    )
    expect(tighten.onlineSafe).toBe(false)
  })

  it('summarizePlan surfaces the online-safety legend only when something is unsafe', () => {
    const safe = diffSchema(EMPTY_SCHEMA, schema(table('posts', [col('title')])))
    expect(summarizePlan(safe)).toMatch(/all online-safe/)
    const unsafe = diffSchema(
      schema(table('posts', [col('title')])),
      schema(table('posts', [col('title'), col('slug', 'text', { required: true })])),
    )
    expect(summarizePlan(unsafe)).toMatch(/not online-safe/)
    expect(summarizePlan(unsafe)).toMatch(/expand → backfill → contract/)
  })
})

describe('downStatementsFor — inverse SQL generation', () => {
  // A simple, predictable dialect so assertions read clearly.
  const dialect: SqlDialect = {
    quote: (id) => `"${id}"`,
    dropIndex: (t, c) => `DROP INDEX IF EXISTS "${indexNameFor(t, c)}";`,
    dropColumn: (t, c) => `ALTER TABLE "${t}" DROP COLUMN "${c}";`,
    dropTable: (t) => `DROP TABLE IF EXISTS "${t}";`,
  }
  const entry = (over: Partial<MigrationJournalEntry>): MigrationJournalEntry => ({
    id: 'm1',
    at: '2026-01-01T00:00:00.000Z',
    createdTables: [],
    addedColumns: [],
    statements: [],
    ...over,
  })

  it('drops added columns (index then column) and created tables in reverse order', () => {
    const stmts = downStatementsFor(
      entry({ createdTables: ['tags', 'authors'], addedColumns: ['posts.subtitle'] }),
      dialect,
    )
    expect(stmts).toEqual([
      'DROP INDEX IF EXISTS "idx_posts_subtitle";',
      'ALTER TABLE "posts" DROP COLUMN "subtitle";',
      'DROP TABLE IF EXISTS "authors";',
      'DROP TABLE IF EXISTS "tags";',
    ])
  })

  it('does not separately drop columns that belong to a table being dropped wholesale', () => {
    const stmts = downStatementsFor(entry({ createdTables: ['tags'], addedColumns: ['tags.name'] }), dialect)
    expect(stmts).toEqual(['DROP TABLE IF EXISTS "tags";'])
  })

  it('never drops a `_*` system table or a system-table column (safety invariant)', () => {
    const stmts = downStatementsFor(
      entry({ createdTables: ['_migrations', '_audit'], addedColumns: ['_audit.extra', 'posts.ok'] }),
      dialect,
    )
    // Only the user column is dropped; nothing touches a system table.
    expect(stmts).toEqual(['DROP INDEX IF EXISTS "idx_posts_ok";', 'ALTER TABLE "posts" DROP COLUMN "ok";'])
    expect(stmts.join('\n')).not.toMatch(/_migrations|_audit/)
  })

  it('ignores malformed column references', () => {
    const stmts = downStatementsFor(entry({ addedColumns: ['nodot', '.leadingdot', 'table.'] }), dialect)
    expect(stmts).toEqual([])
  })
})
