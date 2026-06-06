import { describe, expect, it } from 'vitest'
import type { ColumnSchema, KernelSchema, TableSchema } from '@kernel/db'
import { EMPTY_SCHEMA, diffSchema, summarizePlan } from './migrations'

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
    expect(plan.ops.some((o) => o.kind === 'dropColumn' && o.column === 'legacy' && o.class === 'destructive')).toBe(true)
    expect(plan.ops.some((o) => o.kind === 'dropTable' && o.table === 'drafts')).toBe(true)
    expect(plan.hasDestructive).toBe(true)
  })

  it('detects type changes and required tightening as destructive', () => {
    const current = schema(table('posts', [col('views', 'text'), col('slug', 'text', { required: false })]))
    const next = schema(table('posts', [col('views', 'integer'), col('slug', 'text', { required: true })]))
    const plan = diffSchema(current, next)
    expect(plan.ops.some((o) => o.kind === 'alterColumnType' && o.from === 'text' && o.to === 'integer')).toBe(true)
    expect(plan.ops.some((o) => o.kind === 'setColumnRequired' && o.required === true && o.class === 'destructive')).toBe(true)
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
