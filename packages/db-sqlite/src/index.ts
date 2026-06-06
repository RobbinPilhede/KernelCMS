/**
 * @kernel/db-sqlite — a zero-dependency SQLite adapter built on Node's
 * built-in `node:sqlite` (DatabaseSync). Great for local-first dev, CI, and
 * edge/libSQL deployments. Implements the @kernel/db `DatabaseAdapter` contract.
 */
import { createRequire } from 'node:module'
import type {
  AdapterContext,
  ColumnSchema,
  DatabaseAdapter,
  DatabaseCapabilities,
  FindArgs,
  HealthStatus,
  KernelSchema,
  Logger,
  MigrationReport,
  PaginatedResult,
  Row,
  TableSchema,
  Where,
  WhereCondition,
} from '@kernel/db'

// node:sqlite is a recent built-in; load it via createRequire so bundlers
// (Vite/esbuild) never try to statically resolve the specifier.
const nodeRequire = createRequire(import.meta.url)
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite')

export interface SQLiteAdapterOptions {
  /** File path or ':memory:'. Accepts "file:./x.db" URLs too. Default ':memory:'. */
  url?: string
  /** Set busy timeout in ms. Default 5000. */
  busyTimeout?: number
  /** Use WAL journal mode for file databases. Default true. */
  wal?: boolean
}

const SQL_TYPE: Record<ColumnSchema['type'], string> = {
  text: 'TEXT',
  integer: 'INTEGER',
  real: 'REAL',
  boolean: 'INTEGER',
  timestamp: 'TEXT',
  json: 'TEXT',
}

function quote(ident: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ident)) {
    throw new Error(`Invalid SQL identifier: ${ident}`)
  }
  return `"${ident}"`
}

function resolveLocation(url: string | undefined): string {
  if (!url) return ':memory:'
  if (url === ':memory:') return url
  if (url.startsWith('file:')) return url.slice('file:'.length)
  return url
}

interface StatementLike {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

interface DB {
  exec(sql: string): void
  prepare(sql: string): StatementLike
  close(): void
}

class SQLiteAdapter implements DatabaseAdapter {
  readonly kind = 'db' as const
  readonly name = 'sqlite'
  readonly contractVersion = '1.0' as const
  readonly capabilities: DatabaseCapabilities = {
    transactions: true,
    joins: 'application',
    jsonQuery: false,
    fullTextSearch: false,
    returning: false,
  }

  private db: DB | null = null
  private logger: Logger | null = null
  private readonly options: SQLiteAdapterOptions
  private readonly tables = new Map<string, TableSchema>()
  private readonly allowedCols = new Map<string, Set<string>>()
  // Serializes transactions. There is one shared synchronous connection, so two
  // overlapping `BEGIN…COMMIT` blocks would interleave their statements at the
  // `await` points inside the callback and corrupt each other. Chaining every
  // transaction onto this tail guarantees at most one is open at a time.
  private txTail: Promise<unknown> = Promise.resolve()

  constructor(options: SQLiteAdapterOptions) {
    this.options = options
  }

  async init(ctx: AdapterContext): Promise<void> {
    this.logger = ctx.logger
    const location = resolveLocation(this.options.url)
    this.db = new DatabaseSync(location) as unknown as DB
    this.db.exec(`PRAGMA busy_timeout = ${Number(this.options.busyTimeout ?? 5000)};`)
    if (location !== ':memory:' && (this.options.wal ?? true)) {
      this.db.exec('PRAGMA journal_mode = WAL;')
    }
    this.logger.info(`sqlite connected (${location})`)
  }

  private conn(): DB {
    if (!this.db) throw new Error('SQLite adapter not initialized. Did you call initKernel()?')
    return this.db
  }

  private table(name: string): TableSchema {
    const t = this.tables.get(name)
    if (!t) throw new Error(`Unknown table "${name}". Run migrations first.`)
    return t
  }

  async migrate(schema: KernelSchema): Promise<MigrationReport> {
    const db = this.conn()
    const report: MigrationReport = { createdTables: [], addedColumns: [], statements: [] }

    for (const table of schema.tables) {
      this.tables.set(table.table, table)
      const allowed = new Set<string>(['id', 'createdAt', 'updatedAt'])
      for (const c of table.columns) allowed.add(c.name)
      this.allowedCols.set(table.table, allowed)

      const existing = db.prepare(`PRAGMA table_info(${quote(table.table)})`).all() as Array<{ name: string }>
      if (existing.length === 0) {
        const sql = this.createTableSql(table)
        db.exec(sql)
        report.createdTables.push(table.table)
        report.statements.push(sql)
      } else {
        const have = new Set(existing.map((c) => c.name))
        for (const col of table.columns) {
          if (!have.has(col.name)) {
            const sql = `ALTER TABLE ${quote(table.table)} ADD COLUMN ${this.columnSql(col)};`
            db.exec(sql)
            report.addedColumns.push(`${table.table}.${col.name}`)
            report.statements.push(sql)
          }
        }
      }

      for (const col of table.columns) {
        if (col.indexed && !col.unique) {
          const idx = `idx_${table.table}_${col.name}`
          const sql = `CREATE INDEX IF NOT EXISTS ${quote(idx)} ON ${quote(table.table)} (${quote(col.name)});`
          db.exec(sql)
        }
      }
    }
    this.logger?.info(
      `migrated: ${report.createdTables.length} table(s) created, ${report.addedColumns.length} column(s) added`,
    )
    return report
  }

  private columnSql(col: ColumnSchema): string {
    const parts = [quote(col.name), SQL_TYPE[col.type]]
    if (col.unique) parts.push('UNIQUE')
    return parts.join(' ')
  }

  private createTableSql(table: TableSchema): string {
    const cols = [`${quote('id')} TEXT PRIMARY KEY`]
    for (const col of table.columns) cols.push(this.columnSql(col))
    if (table.timestamps) {
      cols.push(`${quote('createdAt')} TEXT`)
      cols.push(`${quote('updatedAt')} TEXT`)
    }
    return `CREATE TABLE IF NOT EXISTS ${quote(table.table)} (\n  ${cols.join(',\n  ')}\n);`
  }

  // -- value codecs ---------------------------------------------------------

  private encode(col: ColumnSchema, value: unknown): unknown {
    if (value === undefined || value === null) return null
    switch (col.type) {
      case 'boolean':
        return value ? 1 : 0
      case 'json':
        return JSON.stringify(value)
      case 'integer':
        return Math.trunc(Number(value))
      case 'real':
        return Number(value)
      case 'timestamp':
        return value instanceof Date ? value.toISOString() : String(value)
      default:
        return String(value)
    }
  }

  private decode(col: ColumnSchema, value: unknown): unknown {
    if (value === undefined || value === null) return null
    switch (col.type) {
      case 'boolean':
        return Boolean(value)
      case 'json':
        try {
          return typeof value === 'string' ? JSON.parse(value) : value
        } catch {
          return null
        }
      default:
        return value
    }
  }

  private decodeRow(table: TableSchema, raw: Record<string, unknown>): Row {
    const out: Row = { id: raw.id }
    if ('createdAt' in raw) out.createdAt = raw.createdAt
    if ('updatedAt' in raw) out.updatedAt = raw.updatedAt
    for (const col of table.columns) out[col.name] = this.decode(col, raw[col.name])
    return out
  }

  private colByName(table: TableSchema): Map<string, ColumnSchema> {
    const m = new Map<string, ColumnSchema>()
    for (const c of table.columns) m.set(c.name, c)
    return m
  }

  // -- where compilation ----------------------------------------------------

  private buildWhere(
    where: Where,
    table: TableSchema,
    cols: Map<string, ColumnSchema>,
    allowed: Set<string>,
    params: unknown[],
  ): string {
    const clauses: string[] = []
    if (where.and?.length) {
      const sub = where.and.map((w) => this.buildWhere(w, table, cols, allowed, params)).filter(Boolean)
      if (sub.length) clauses.push(`(${sub.join(' AND ')})`)
    }
    if (where.or) {
      // An explicit empty `or: []` means "match nothing" (deny), so fail closed.
      if (where.or.length === 0) clauses.push('0')
      else {
        const sub = where.or.map((w) => this.buildWhere(w, table, cols, allowed, params)).filter(Boolean)
        if (sub.length) clauses.push(`(${sub.join(' OR ')})`)
      }
    }
    for (const [field, cond] of Object.entries(where)) {
      if (field === 'and' || field === 'or' || cond === undefined) continue
      if (!allowed.has(field)) throw new Error(`Cannot filter on unknown field "${field}" of "${table.table}".`)
      clauses.push(this.fieldClause(field, cond as WhereCondition, cols.get(field), params))
    }
    return clauses.length ? clauses.join(' AND ') : ''
  }

  private encodeOperand(col: ColumnSchema | undefined, operand: unknown): unknown {
    if (col) return this.encode(col, operand)
    if (typeof operand === 'boolean') return operand ? 1 : 0
    return operand as unknown
  }

  private fieldClause(field: string, cond: WhereCondition, col: ColumnSchema | undefined, params: unknown[]): string {
    const id = quote(field)
    const parts: string[] = []
    for (const [op, operand] of Object.entries(cond)) {
      switch (op) {
        case 'equals':
          if (operand === null) parts.push(`${id} IS NULL`)
          else {
            params.push(this.encodeOperand(col, operand))
            parts.push(`${id} = ?`)
          }
          break
        case 'not_equals':
          if (operand === null) parts.push(`${id} IS NOT NULL`)
          else {
            params.push(this.encodeOperand(col, operand))
            parts.push(`(${id} <> ? OR ${id} IS NULL)`)
          }
          break
        case 'in':
        case 'not_in': {
          const arr = Array.isArray(operand) ? operand : [operand]
          if (arr.length === 0) {
            parts.push(op === 'in' ? '0' : '1')
            break
          }
          for (const v of arr) params.push(this.encodeOperand(col, v))
          const ph = arr.map(() => '?').join(', ')
          parts.push(`${id} ${op === 'in' ? 'IN' : 'NOT IN'} (${ph})`)
          break
        }
        case 'greater_than':
          params.push(this.encodeOperand(col, operand))
          parts.push(`${id} > ?`)
          break
        case 'greater_than_equal':
          params.push(this.encodeOperand(col, operand))
          parts.push(`${id} >= ?`)
          break
        case 'less_than':
          params.push(this.encodeOperand(col, operand))
          parts.push(`${id} < ?`)
          break
        case 'less_than_equal':
          params.push(this.encodeOperand(col, operand))
          parts.push(`${id} <= ?`)
          break
        case 'like':
        case 'contains': {
          // Escape LIKE metacharacters so user input is matched literally — an
          // operand of "100%" must not become a wildcard. The backslash escape
          // char is declared via ESCAPE and is itself escaped first.
          const literal = String(operand).replace(/[\\%_]/g, (ch) => `\\${ch}`)
          params.push(`%${literal}%`)
          parts.push(`${id} LIKE ? ESCAPE '\\'`)
          break
        }
        case 'exists':
          parts.push(operand ? `${id} IS NOT NULL` : `${id} IS NULL`)
          break
        default:
          throw new Error(`Unsupported operator "${op}".`)
      }
    }
    return parts.length ? `(${parts.join(' AND ')})` : ''
  }

  private whereSql(table: TableSchema, where: Where | undefined): { sql: string; params: unknown[] } {
    if (!where) return { sql: '', params: [] }
    const params: unknown[] = []
    const allowed = this.allowedCols.get(table.table) ?? new Set(['id'])
    const clause = this.buildWhere(where, table, this.colByName(table), allowed, params)
    return { sql: clause ? ` WHERE ${clause}` : '', params }
  }

  // -- CRUD -----------------------------------------------------------------

  private rawGet(table: TableSchema, id: string): Row | null {
    const row = this.conn()
      .prepare(`SELECT * FROM ${quote(table.table)} WHERE ${quote('id')} = ?`)
      .get(id) as Record<string, unknown> | undefined
    return row ? this.decodeRow(table, row) : null
  }

  async findByID(args: { collection: string; id: string }): Promise<Row | null> {
    return this.rawGet(this.table(args.collection), args.id)
  }

  async find(args: FindArgs): Promise<PaginatedResult<Row>> {
    const table = this.table(args.collection)
    const db = this.conn()
    const { sql: whereSql, params } = this.whereSql(table, args.where)
    const allowed = this.allowedCols.get(table.table) ?? new Set(['id'])

    const totalRow = db.prepare(`SELECT COUNT(*) AS c FROM ${quote(table.table)}${whereSql}`).get(...params) as {
      c: number | bigint
    }
    const totalDocs = Number(totalRow.c)

    const sortParts = (args.sort ?? [])
      .filter((s) => allowed.has(s.field))
      .map((s) => `${quote(s.field)} ${s.direction === 'desc' ? 'DESC' : 'ASC'}`)
    const orderBy = sortParts.length ? ` ORDER BY ${sortParts.join(', ')}` : ` ORDER BY ${quote('id')} ASC`

    const limit = args.limit
    const offset = (args.page - 1) * limit
    const rows = db
      .prepare(`SELECT * FROM ${quote(table.table)}${whereSql}${orderBy} LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Array<Record<string, unknown>>

    const docs = rows.map((r) => this.decodeRow(table, r))
    const totalPages = limit > 0 ? Math.max(Math.ceil(totalDocs / limit), 1) : 1
    const page = args.page
    return {
      docs,
      totalDocs,
      limit,
      page,
      totalPages,
      hasPrevPage: page > 1,
      hasNextPage: page < totalPages,
      prevPage: page > 1 ? page - 1 : null,
      nextPage: page < totalPages ? page + 1 : null,
      pagingCounter: offset + 1,
    }
  }

  async create(args: { collection: string; data: Row }): Promise<Row> {
    const table = this.table(args.collection)
    const id = String(args.data.id)
    const now = new Date().toISOString()
    const fields = [quote('id')]
    const values: unknown[] = [id]

    for (const col of table.columns) {
      if (Object.prototype.hasOwnProperty.call(args.data, col.name)) {
        fields.push(quote(col.name))
        values.push(this.encode(col, args.data[col.name]))
      }
    }
    if (table.timestamps) {
      fields.push(quote('createdAt'), quote('updatedAt'))
      values.push(now, now)
    }

    const placeholders = fields.map(() => '?').join(', ')
    this.conn()
      .prepare(`INSERT INTO ${quote(table.table)} (${fields.join(', ')}) VALUES (${placeholders})`)
      .run(...values)
    const created = this.rawGet(table, id)
    if (!created) throw new Error('Insert succeeded but row could not be read back.')
    return created
  }

  async update(args: { collection: string; id: string; data: Row }): Promise<Row | null> {
    const table = this.table(args.collection)
    const sets: string[] = []
    const values: unknown[] = []
    for (const col of table.columns) {
      if (Object.prototype.hasOwnProperty.call(args.data, col.name)) {
        sets.push(`${quote(col.name)} = ?`)
        values.push(this.encode(col, args.data[col.name]))
      }
    }
    if (table.timestamps) {
      sets.push(`${quote('updatedAt')} = ?`)
      values.push(new Date().toISOString())
    }
    if (sets.length > 0) {
      values.push(args.id)
      const res = this.conn()
        .prepare(`UPDATE ${quote(table.table)} SET ${sets.join(', ')} WHERE ${quote('id')} = ?`)
        .run(...values)
      if (Number(res.changes) === 0 && !this.rawGet(table, args.id)) return null
    }
    return this.rawGet(table, args.id)
  }

  async delete(args: { collection: string; id: string }): Promise<Row | null> {
    const table = this.table(args.collection)
    const existing = this.rawGet(table, args.id)
    if (!existing) return null
    this.conn()
      .prepare(`DELETE FROM ${quote(table.table)} WHERE ${quote('id')} = ?`)
      .run(args.id)
    return existing
  }

  async count(args: { collection: string; where?: Where }): Promise<number> {
    const table = this.table(args.collection)
    const { sql, params } = this.whereSql(table, args.where)
    const row = this.conn()
      .prepare(`SELECT COUNT(*) AS c FROM ${quote(table.table)}${sql}`)
      .get(...params) as { c: number | bigint }
    return Number(row.c)
  }

  async transaction<R>(fn: (tx: DatabaseAdapter) => Promise<R>): Promise<R> {
    const run = async (): Promise<R> => {
      const db = this.conn()
      // BEGIN IMMEDIATE takes the write lock up front so a transaction that will
      // write never starts read-only and then deadlocks on upgrade under WAL.
      db.exec('BEGIN IMMEDIATE')
      try {
        const result = await fn(this)
        db.exec('COMMIT')
        return result
      } catch (err) {
        try {
          db.exec('ROLLBACK')
        } catch {
          // Ignore rollback failures (e.g. the transaction never opened); the
          // original error is what matters.
        }
        throw err
      }
    }
    // Queue behind any in-flight transaction, regardless of how it settled.
    const result = this.txTail.then(run, run)
    this.txTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  async health(): Promise<HealthStatus> {
    try {
      this.conn().prepare('SELECT 1').get()
      return { status: 'ok' }
    } catch (err) {
      return { status: 'down', detail: err instanceof Error ? err.message : String(err) }
    }
  }

  async destroy(): Promise<void> {
    this.db?.close()
    this.db = null
  }
}

/** Create a SQLite database adapter. */
export function sqliteAdapter(options: SQLiteAdapterOptions = {}): DatabaseAdapter {
  return new SQLiteAdapter(options)
}
