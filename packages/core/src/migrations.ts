/**
 * Diff-based migration planning. `kernel.config.ts` is the single source of truth
 * for schema; this module diffs the freshly-compiled IR against a stored snapshot
 * and emits a deterministic, risk-classified plan. It is pure — it never touches a
 * database — so it is fully testable and the same input always yields the same
 * plan. Applying the plan is the adapter's job. See docs/03-persistence/08.
 */
import type { ColumnSchema, KernelSchema, MigrationJournalEntry, TableSchema } from '@kernel/db'

export type { MigrationJournalEntry }

/** Risk class drives review ordering and whether an auto-`down` is safe. */
export type ChangeClass = 'safe' | 'destructive'

export type MigrationOp =
  | { kind: 'createTable'; table: string; slug: string; class: 'safe'; columns: ColumnSchema[] }
  | { kind: 'dropTable'; table: string; class: 'destructive' }
  | { kind: 'addColumn'; table: string; column: ColumnSchema; class: ChangeClass }
  | { kind: 'dropColumn'; table: string; column: string; class: 'destructive' }
  | { kind: 'alterColumnType'; table: string; column: string; from: string; to: string; class: 'destructive' }
  | { kind: 'setColumnRequired'; table: string; column: string; required: boolean; class: ChangeClass }

/**
 * Whether an operation is safe to run against a LIVE table without blocking reads
 * or failing on existing rows — the zero-downtime classification. Additive,
 * non-rewriting changes are online-safe: create-table, create-index, and adding a
 * NULLABLE column (no table rewrite, no constraint that existing rows can violate).
 * Adding a NOT NULL column, dropping anything, retyping, or tightening NULL→NOT NULL
 * are NOT online-safe — they need the expand → backfill → contract dance.
 */
export function isOnlineSafe(op: MigrationOp): boolean {
  switch (op.kind) {
    case 'createTable':
      return true
    case 'addColumn':
      // Nullable add is online-safe; a required (NOT NULL) add can fail on existing rows.
      return !op.column.required
    case 'setColumnRequired':
      // Loosening (NOT NULL → NULL) is safe; tightening is not.
      return op.required === false
    case 'dropTable':
    case 'dropColumn':
    case 'alterColumnType':
      return false
  }
}

export interface MigrationPlan {
  ops: MigrationOp[]
  /** True when any op can lose data or fail on existing rows. */
  hasDestructive: boolean
  /** True when EVERY op is safe to run against a live database (see {@link isOnlineSafe}).
   *  An empty plan is trivially online-safe. */
  onlineSafe: boolean
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
        alters.push({
          kind: 'alterColumnType',
          table: nextTable.table,
          column: col.name,
          from: before.type,
          to: col.type,
          class: 'destructive',
        })
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
  return {
    ops,
    hasDestructive: ops.some((o) => o.class === 'destructive'),
    onlineSafe: ops.every(isOnlineSafe),
    empty: ops.length === 0,
  }
}

/** Human-readable summary for `kernel migrate status` / `generate` output. Each line
 *  carries a destructive badge plus an online-safety marker so an operator can see at a
 *  glance which changes can run against a live database and which need expand-contract. */
export function summarizePlan(plan: MigrationPlan): string {
  if (plan.empty) return 'Schema is up to date — no changes.'
  const lines = plan.ops.map((op) => {
    const badge = op.class === 'destructive' ? '⚠ ' : '  '
    // Online-safety marker: a plain "·" for live-safe, "‼" for changes that need the
    // expand → backfill → contract flow before they're safe under traffic.
    const live = isOnlineSafe(op) ? '·' : '‼'
    const tail = (text: string) => `${badge}${live} ${text}`
    switch (op.kind) {
      case 'createTable':
        return tail(`create table ${op.table} (${op.columns.length} columns)`)
      case 'dropTable':
        return tail(`drop table ${op.table}`)
      case 'addColumn':
        return tail(
          `add column ${op.table}.${op.column.name} ${op.column.type}${op.column.required ? ' NOT NULL' : ''}`,
        )
      case 'dropColumn':
        return tail(`drop column ${op.table}.${op.column}`)
      case 'alterColumnType':
        return tail(`alter ${op.table}.${op.column} type ${op.from} → ${op.to}`)
      case 'setColumnRequired':
        return tail(`set ${op.table}.${op.column} ${op.required ? 'NOT NULL' : 'NULL'}`)
    }
  })
  const destructive = plan.ops.filter((o) => o.class === 'destructive').length
  const notLive = plan.ops.filter((o) => !isOnlineSafe(o)).length
  const header =
    `${plan.ops.length} change(s)` +
    `${destructive ? `, ${destructive} destructive` : ''}` +
    `${notLive ? `, ${notLive} not online-safe` : ', all online-safe'}:`
  const guide = notLive
    ? '\nLegend: · online-safe   ‼ needs expand → backfill → contract (add nullable column, ' +
      'backfill it via `kernel backfill`, then tighten/swap in a later migration).'
    : ''
  return [header, ...lines].join('\n') + guide
}

/** An empty schema, useful as the "current" side for a from-scratch plan. */
export const EMPTY_SCHEMA: KernelSchema = { tables: [] }

// ---------------------------------------------------------------------------
// Migration journal + rollback (down-SQL generation)
// ---------------------------------------------------------------------------

/**
 * The SQL-dialect bits a {@link downStatementsFor} call needs. Core owns the inversion
 * LOGIC (what to drop, in what order, with what guards); the adapter supplies the dialect
 * (identifier quoting + the three DROP templates), so the generator stays pure + testable
 * and both adapters reuse it. Keep these minimal and side-effect free.
 */
export interface SqlDialect {
  /** Quote an identifier (and validate it). Throws on an invalid identifier. */
  quote(ident: string): string
  /** `DROP INDEX` for an index created on `table(column)` by the migrate path. */
  dropIndex(table: string, column: string): string
  /** `ALTER TABLE … DROP COLUMN`. */
  dropColumn(table: string, column: string): string
  /** `DROP TABLE`. */
  dropTable(table: string): string
}

/** The index name the adapters' `migrate` derives for an indexed column. Kept here so
 *  rollback drops the exact index the forward path created. */
export function indexNameFor(table: string, column: string): string {
  return `idx_${table}_${column}`
}

/**
 * Generate the INVERSE statements for one journal entry — the heart of rollback.
 *
 * Safety invariant (do not weaken): this ONLY ever drops what the entry RECORDS as
 * having been added. It never infers drops from a schema diff and never touches a
 * column/table that isn't in `createdTables`/`addedColumns`. As a hard backstop it
 * refuses to drop any `_*` system table (the journal, audit, roles, …) even if one
 * were somehow recorded, so a corrupt/forged journal row can't nuke system state.
 *
 * Order mirrors a safe teardown: drop the per-column indexes the forward path may have
 * created, then the added columns, then the created tables (created tables are dropped
 * whole, so their columns/indexes are NOT separately dropped — that would error).
 */
export function downStatementsFor(entry: MigrationJournalEntry, dialect: SqlDialect): string[] {
  const out: string[] = []
  const droppedTables = new Set(entry.createdTables)

  const isSystemTable = (table: string): boolean => table.startsWith('_')

  // 1) Added columns → DROP INDEX (if any) then DROP COLUMN. Skip columns that belong
  //    to a table we're dropping wholesale (the DROP TABLE removes them).
  for (const ref of entry.addedColumns) {
    const dot = ref.indexOf('.')
    if (dot <= 0) continue // malformed "table.column" reference — never act on it.
    const table = ref.slice(0, dot)
    const column = ref.slice(dot + 1)
    if (!table || !column) continue
    if (droppedTables.has(table)) continue
    // Never drop a column on a system table — rollback only undoes user-schema additions.
    if (isSystemTable(table)) continue
    out.push(dialect.dropIndex(table, column))
    out.push(dialect.dropColumn(table, column))
  }

  // 2) Created tables → DROP TABLE, in REVERSE creation order so dependents go first.
  for (let i = entry.createdTables.length - 1; i >= 0; i--) {
    const table = entry.createdTables[i]!
    // Guard: never drop a system table. The forward path never journals one as
    // "created" (system tables are provisioned, not migration-owned), but fail closed.
    if (isSystemTable(table)) continue
    out.push(dialect.dropTable(table))
  }

  return out
}
