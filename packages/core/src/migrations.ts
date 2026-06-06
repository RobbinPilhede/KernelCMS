/**
 * Diff-based migration planning. `kernel.config.ts` is the single source of truth
 * for schema; this module diffs the freshly-compiled IR against a stored snapshot
 * and emits a deterministic, risk-classified plan. It is pure — it never touches a
 * database — so it is fully testable and the same input always yields the same
 * plan. Applying the plan is the adapter's job. See docs/03-persistence/08.
 */
import type { ColumnSchema, KernelSchema, TableSchema } from '@kernel/db'

/** Risk class drives review ordering and whether an auto-`down` is safe. */
export type ChangeClass = 'safe' | 'destructive'

export type MigrationOp =
  | { kind: 'createTable'; table: string; slug: string; class: 'safe'; columns: ColumnSchema[] }
  | { kind: 'dropTable'; table: string; class: 'destructive' }
  | { kind: 'addColumn'; table: string; column: ColumnSchema; class: ChangeClass }
  | { kind: 'dropColumn'; table: string; column: string; class: 'destructive' }
  | { kind: 'alterColumnType'; table: string; column: string; from: string; to: string; class: 'destructive' }
  | { kind: 'setColumnRequired'; table: string; column: string; required: boolean; class: ChangeClass }

export interface MigrationPlan {
  ops: MigrationOp[]
  /** True when any op can lose data or fail on existing rows. */
  hasDestructive: boolean
  /** True when there is nothing to do. */
  empty: boolean
}

function tableMap(schema: KernelSchema): Map<string, TableSchema> {
  return new Map(schema.tables.map((t) => [t.table, t]))
}
function columnMap(table: TableSchema): Map<string, ColumnSchema> {
  return new Map(table.columns.map((c) => [c.name, c]))
}

/**
 * Diff `current` (what's in the DB / last snapshot) against `next` (compiled from
 * config) and return the ordered, classified operations to reconcile them.
 * Ordering: creates → column adds/alters → drops, so additive work lands before
 * anything destructive.
 */
export function diffSchema(current: KernelSchema, next: KernelSchema): MigrationPlan {
  const creates: MigrationOp[] = []
  const alters: MigrationOp[] = []
  const drops: MigrationOp[] = []

  const currentTables = tableMap(current)
  const nextTables = tableMap(next)

  // New tables.
  for (const table of next.tables) {
    if (!currentTables.has(table.table)) {
      creates.push({ kind: 'createTable', table: table.table, slug: table.slug, class: 'safe', columns: table.columns })
    }
  }

  // Dropped tables.
  for (const table of current.tables) {
    if (!nextTables.has(table.table)) {
      drops.push({ kind: 'dropTable', table: table.table, class: 'destructive' })
    }
  }

  // Column-level diffs for tables present in both.
  for (const nextTable of next.tables) {
    const currentTable = currentTables.get(nextTable.table)
    if (!currentTable) continue
    const currentCols = columnMap(currentTable)
    const nextCols = columnMap(nextTable)

    for (const col of nextTable.columns) {
      const before = currentCols.get(col.name)
      if (!before) {
        // Adding a NOT NULL column to an existing table can fail on existing rows.
        const cls: ChangeClass = col.required ? 'destructive' : 'safe'
        alters.push({ kind: 'addColumn', table: nextTable.table, column: col, class: cls })
        continue
      }
      if (before.type !== col.type) {
        alters.push({ kind: 'alterColumnType', table: nextTable.table, column: col.name, from: before.type, to: col.type, class: 'destructive' })
      }
      if (before.required !== col.required) {
        // Tightening (false→true) can fail on existing nulls; loosening is safe.
        alters.push({
          kind: 'setColumnRequired',
          table: nextTable.table,
          column: col.name,
          required: col.required,
          class: col.required ? 'destructive' : 'safe',
        })
      }
    }

    for (const col of currentTable.columns) {
      if (!nextCols.has(col.name)) {
        drops.push({ kind: 'dropColumn', table: nextTable.table, column: col.name, class: 'destructive' })
      }
    }
  }

  const ops = [...creates, ...alters, ...drops]
  return { ops, hasDestructive: ops.some((o) => o.class === 'destructive'), empty: ops.length === 0 }
}

/** Human-readable summary for `kernel migrate status` / `generate` output. */
export function summarizePlan(plan: MigrationPlan): string {
  if (plan.empty) return 'Schema is up to date — no changes.'
  const lines = plan.ops.map((op) => {
    const badge = op.class === 'destructive' ? '⚠ ' : '  '
    switch (op.kind) {
      case 'createTable':
        return `${badge}create table ${op.table} (${op.columns.length} columns)`
      case 'dropTable':
        return `${badge}drop table ${op.table}`
      case 'addColumn':
        return `${badge}add column ${op.table}.${op.column.name} ${op.column.type}${op.column.required ? ' NOT NULL' : ''}`
      case 'dropColumn':
        return `${badge}drop column ${op.table}.${op.column}`
      case 'alterColumnType':
        return `${badge}alter ${op.table}.${op.column} type ${op.from} → ${op.to}`
      case 'setColumnRequired':
        return `${badge}set ${op.table}.${op.column} ${op.required ? 'NOT NULL' : 'NULL'}`
    }
  })
  const destructive = plan.ops.filter((o) => o.class === 'destructive').length
  const header = `${plan.ops.length} change(s)${destructive ? `, ${destructive} destructive` : ''}:`
  return [header, ...lines].join('\n')
}

/** An empty schema, useful as the "current" side for a from-scratch plan. */
export const EMPTY_SCHEMA: KernelSchema = { tables: [] }
