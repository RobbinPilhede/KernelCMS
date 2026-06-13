/**
 * @kernel/db-postgres — a PostgreSQL adapter built on node-postgres (`pg`),
 * implementing the @kernel/db `DatabaseAdapter` contract.
 *
 * Unlike the single-connection SQLite adapter, this uses a real connection pool:
 * each transaction runs on its own checked-out client, so transactions are
 * genuinely concurrent and isolated by Postgres itself. Writes use `RETURNING *`
 * to read the row back in a single round trip.
 */
import pg from 'pg'
import type { Pool as PgPool, PoolClient, PoolConfig } from 'pg'
import type {
  AdapterContext,
  ColumnSchema,
  DatabaseAdapter,
  DatabaseCapabilities,
  FindArgs,
  HealthStatus,
  KernelSchema,
  Logger,
  MigrateOptions,
  MigrationJournalEntry,
  MigrationReport,
  PaginatedResult,
  Row,
  TableSchema,
  Where,
  WhereCondition,
} from '@kernel/db'
import { type SqlDialect, downStatementsFor } from '@kernel/core'

const { Pool } = pg

export interface PostgresAdapterOptions {
  /** Connection string. Defaults to `process.env.DATABASE_URL`. */
  url?: string
  /**
   * TLS. `true` is a convenience for hosted Postgres that presents a cert the
   * system store doesn't verify (`{ rejectUnauthorized: false }`); pass a full
   * object for stricter setups.
   */
  ssl?: boolean | PoolConfig['ssl']
  /** Maximum pooled clients. Default 10. */
  max?: number
  /** Escape hatch: a full pg PoolConfig, merged last. */
  pool?: PoolConfig
}

/** The subset of pg's Pool/PoolClient surface this adapter relies on. */
interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
}

const SQL_TYPE: Record<ColumnSchema['type'], string> = {
  text: 'text',
  integer: 'integer',
  real: 'double precision',
  boolean: 'boolean',
  timestamp: 'timestamptz',
  json: 'jsonb',
}

function quote(ident: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ident)) {
    throw new Error(`Invalid SQL identifier: ${ident}`)
  }
  return `"${ident}"`
}

/** Accumulates positional ($1, $2, …) parameters in order. */
class Params {
  readonly values: unknown[] = []
  next(value: unknown): string {
    this.values.push(value)
    return `$${this.values.length}`
  }
}

class PostgresAdapter implements DatabaseAdapter {
  readonly kind = 'db' as const
  readonly name = 'postgres'
  readonly contractVersion = '1.0' as const
  readonly capabilities: DatabaseCapabilities = {
    transactions: true,
    joins: 'application',
    jsonQuery: false,
    fullTextSearch: false,
    returning: true,
  }

  private pool: PgPool | null = null
  private logger: Logger | null = null
  private readonly options: PostgresAdapterOptions
  private readonly tables = new Map<string, TableSchema>()
  private readonly allowedCols = new Map<string, Set<string>>()
  private savepointSeq = 0

  constructor(options: PostgresAdapterOptions) {
    this.options = options
  }

  async init(ctx: AdapterContext): Promise<void> {
    this.logger = ctx.logger
    const url = this.options.url ?? process.env.DATABASE_URL
    if (!url && !this.options.pool) {
      throw new Error(
        'PostgreSQL adapter requires a connection string. Set DATABASE_URL or pass `url` to postgresAdapter().',
      )
    }
    const ssl = this.options.ssl === true ? { rejectUnauthorized: false } : this.options.ssl
    const config: PoolConfig = {
      connectionString: url,
      max: this.options.max ?? 10,
      ...(ssl === undefined ? {} : { ssl }),
      ...this.options.pool,
    }
    this.pool = new Pool(config)
    // Fail fast on a bad connection rather than on the first query.
    const probe = await this.pool.connect()
    probe.release()
    this.logger.info('postgres connected')
  }

  private requirePool(): PgPool {
    if (!this.pool) throw new Error('Postgres adapter not initialized. Did you call initKernel()?')
    return this.pool
  }

  private table(name: string): TableSchema {
    const t = this.tables.get(name)
    if (!t) {
      throw new Error(
        `Unknown table "${name}". Register the schema first — initKernel() does this on boot; ` +
          `if you construct the adapter directly, call register(schema) (or migrate(schema)).`,
      )
    }
    return t
  }

  register(schema: KernelSchema): void {
    for (const table of schema.tables) {
      this.tables.set(table.table, table)
      const allowed = new Set<string>(['id', 'createdAt', 'updatedAt'])
      for (const c of table.columns) allowed.add(c.name)
      this.allowedCols.set(table.table, allowed)
    }
  }

  private allowed(table: string): Set<string> {
    return this.allowedCols.get(table) ?? new Set(['id'])
  }

  async migrate(schema: KernelSchema, opts?: MigrateOptions): Promise<MigrationReport> {
    const pool = this.requirePool()
    const dryRun = opts?.dryRun === true
    const report: MigrationReport = { createdTables: [], addedColumns: [], statements: [] }
    // Registering up front means reads/writes resolve tables even mid-migration (and a
    // dry run still leaves the table registry usable for subsequent reads).
    this.register(schema)

    // Atomicity: run the whole migration on a single checked-out client inside one
    // transaction, so a mid-run failure rolls back to the pre-migration schema (Postgres
    // DDL is transactional). A dry run opens no transaction and executes nothing.
    const client = dryRun ? null : await pool.connect()
    // Reads (information_schema lookups) run on the pool in a dry run, on the client
    // otherwise, so they observe changes made earlier in the same transaction.
    const reader: Queryable = (client as unknown as Queryable) ?? (pool as unknown as Queryable)
    try {
      if (client) await client.query('BEGIN')
      for (const table of schema.tables) {
        const existing = await reader.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = current_schema() AND table_name = $1`,
          [table.table],
        )

        if (existing.rows.length === 0) {
          const sql = this.createTableSql(table)
          if (client) await client.query(sql)
          report.createdTables.push(table.table)
          report.statements.push(sql)
        } else {
          const have = new Set(existing.rows.map((r) => String(r.column_name)))
          for (const col of table.columns) {
            if (!have.has(col.name)) {
              const sql = `ALTER TABLE ${quote(table.table)} ADD COLUMN ${this.columnSql(col)};`
              if (client) await client.query(sql)
              report.addedColumns.push(`${table.table}.${col.name}`)
              report.statements.push(sql)
            }
          }
        }

        for (const col of table.columns) {
          if (col.indexed && !col.unique) {
            const idx = `idx_${table.table}_${col.name}`
            const sql = `CREATE INDEX IF NOT EXISTS ${quote(idx)} ON ${quote(table.table)} (${quote(col.name)});`
            if (client) await client.query(sql)
            report.statements.push(sql)
          }
        }
      }
      if (client) await client.query('COMMIT')
    } catch (err) {
      if (client) {
        try {
          await client.query('ROLLBACK')
        } catch {
          // The connection may be broken; the original error is what matters.
        }
      }
      throw err
    } finally {
      client?.release()
    }

    this.logger?.info(
      `${dryRun ? 'migrate (dry run): ' : 'migrated: '}${report.createdTables.length} table(s) ${
        dryRun ? 'would be created' : 'created'
      }, ${report.addedColumns.length} column(s) ${dryRun ? 'would be added' : 'added'}`,
    )
    return report
  }

  /** Postgres DROP-statement dialect for rollback. Postgres supports
   *  `ALTER TABLE … DROP COLUMN` and `DROP INDEX IF EXISTS`. Identifiers are validated
   *  by `quote`. */
  private readonly dialect: SqlDialect = {
    quote,
    dropIndex: (table, column) => `DROP INDEX IF EXISTS ${quote(`idx_${table}_${column}`)};`,
    dropColumn: (table, column) => `ALTER TABLE ${quote(table)} DROP COLUMN IF EXISTS ${quote(column)};`,
    dropTable: (table) => `DROP TABLE IF EXISTS ${quote(table)};`,
  }

  async rollback(entries: MigrationJournalEntry[], opts?: MigrateOptions): Promise<{ statements: string[] }> {
    const dryRun = opts?.dryRun === true
    // Inverse SQL is generated by core (safety-checked) with this adapter's dialect.
    const statements = entries.flatMap((entry) => downStatementsFor(entry, this.dialect))
    if (!dryRun && statements.length > 0) {
      const client = await this.requirePool().connect()
      try {
        await client.query('BEGIN')
        for (const sql of statements) await client.query(sql)
        await client.query('COMMIT')
      } catch (err) {
        try {
          await client.query('ROLLBACK')
        } catch {
          // ignore — surface the original error
        }
        throw err
      } finally {
        client.release()
      }
    }
    return { statements }
  }

  private columnSql(col: ColumnSchema): string {
    const parts = [quote(col.name), SQL_TYPE[col.type]]
    if (col.unique) parts.push('UNIQUE')
    return parts.join(' ')
  }

  private createTableSql(table: TableSchema): string {
    const cols = [`${quote('id')} text PRIMARY KEY`]
    for (const col of table.columns) cols.push(this.columnSql(col))
    if (table.timestamps) {
      cols.push(`${quote('createdAt')} timestamptz`)
      cols.push(`${quote('updatedAt')} timestamptz`)
    }
    return `CREATE TABLE IF NOT EXISTS ${quote(table.table)} (\n  ${cols.join(',\n  ')}\n);`
  }

  // -- value codecs ---------------------------------------------------------

  private encode(col: ColumnSchema, value: unknown): unknown {
    if (value === undefined || value === null) return null
    switch (col.type) {
      case 'boolean':
        return Boolean(value)
      case 'json':
        // pg renders JS arrays/objects as Postgres array/record literals, which
        // are invalid for jsonb. Stringify ourselves; Postgres parses it back.
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
        // jsonb arrives parsed; tolerate a string just in case.
        if (typeof value === 'string') {
          try {
            return JSON.parse(value)
          } catch {
            return null
          }
        }
        return value
      case 'timestamp':
        return value instanceof Date ? value.toISOString() : value
      default:
        return value
    }
  }

  private decodeRow(table: TableSchema, raw: Record<string, unknown>): Row {
    const out: Row = { id: raw.id }
    if ('createdAt' in raw) out.createdAt = raw.createdAt instanceof Date ? raw.createdAt.toISOString() : raw.createdAt
    if ('updatedAt' in raw) out.updatedAt = raw.updatedAt instanceof Date ? raw.updatedAt.toISOString() : raw.updatedAt
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
    params: Params,
  ): string {
    const clauses: string[] = []
    if (where.and?.length) {
      const sub = where.and.map((w) => this.buildWhere(w, table, cols, allowed, params)).filter(Boolean)
      if (sub.length) clauses.push(`(${sub.join(' AND ')})`)
    }
    if (where.or) {
      // An explicit empty `or: []` means "match nothing" (deny), so fail closed.
      if (where.or.length === 0) clauses.push('false')
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
    if (typeof operand === 'boolean') return operand
    return operand
  }

  private fieldClause(field: string, cond: WhereCondition, col: ColumnSchema | undefined, params: Params): string {
    const id = quote(field)
    const parts: string[] = []
    for (const [op, operand] of Object.entries(cond)) {
      switch (op) {
        case 'equals':
          if (operand === null) parts.push(`${id} IS NULL`)
          else parts.push(`${id} = ${params.next(this.encodeOperand(col, operand))}`)
          break
        case 'not_equals':
          if (operand === null) parts.push(`${id} IS NOT NULL`)
          else parts.push(`(${id} <> ${params.next(this.encodeOperand(col, operand))} OR ${id} IS NULL)`)
          break
        case 'in':
        case 'not_in': {
          const arr = Array.isArray(operand) ? operand : [operand]
          if (arr.length === 0) {
            parts.push(op === 'in' ? 'false' : 'true')
            break
          }
          const ph = arr.map((v) => params.next(this.encodeOperand(col, v))).join(', ')
          parts.push(`${id} ${op === 'in' ? 'IN' : 'NOT IN'} (${ph})`)
          break
        }
        case 'greater_than':
          parts.push(`${id} > ${params.next(this.encodeOperand(col, operand))}`)
          break
        case 'greater_than_equal':
          parts.push(`${id} >= ${params.next(this.encodeOperand(col, operand))}`)
          break
        case 'less_than':
          parts.push(`${id} < ${params.next(this.encodeOperand(col, operand))}`)
          break
        case 'less_than_equal':
          parts.push(`${id} <= ${params.next(this.encodeOperand(col, operand))}`)
          break
        case 'like':
        case 'contains': {
          // Case-insensitive (ILIKE) to match the in-memory query engine, with
          // LIKE metacharacters escaped so user input matches literally.
          const literal = String(operand).replace(/[\\%_]/g, (ch) => `\\${ch}`)
          parts.push(`${id}::text ILIKE ${params.next(`%${literal}%`)} ESCAPE '\\'`)
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

  private whereSql(table: TableSchema, where: Where | undefined, params: Params): string {
    if (!where) return ''
    const clause = this.buildWhere(where, table, this.colByName(table), this.allowed(table.table), params)
    return clause ? ` WHERE ${clause}` : ''
  }

  // -- CRUD (each takes the queryable so transactions reuse a bound client) --

  private async rawGet(q: Queryable, table: TableSchema, id: string): Promise<Row | null> {
    const res = await q.query(`SELECT * FROM ${quote(table.table)} WHERE ${quote('id')} = $1`, [id])
    const row = res.rows[0]
    return row ? this.decodeRow(table, row) : null
  }

  private async _findByID(q: Queryable, args: { collection: string; id: string }): Promise<Row | null> {
    return this.rawGet(q, this.table(args.collection), args.id)
  }

  private async _find(q: Queryable, args: FindArgs): Promise<PaginatedResult<Row>> {
    const table = this.table(args.collection)
    const allowed = this.allowed(table.table)

    const countParams = new Params()
    const whereForCount = this.whereSql(table, args.where, countParams)
    const totalRes = await q.query(
      `SELECT COUNT(*)::int AS c FROM ${quote(table.table)}${whereForCount}`,
      countParams.values,
    )
    const totalDocs = Number(totalRes.rows[0]?.c ?? 0)

    const params = new Params()
    const whereSql = this.whereSql(table, args.where, params)
    const sortParts = (args.sort ?? [])
      .filter((s) => allowed.has(s.field))
      .map((s) => `${quote(s.field)} ${s.direction === 'desc' ? 'DESC' : 'ASC'}`)
    const orderBy = sortParts.length ? ` ORDER BY ${sortParts.join(', ')}` : ` ORDER BY ${quote('id')} ASC`

    const limit = args.limit
    const offset = (args.page - 1) * limit
    const limitPh = params.next(limit)
    const offsetPh = params.next(offset)
    const res = await q.query(
      `SELECT * FROM ${quote(table.table)}${whereSql}${orderBy} LIMIT ${limitPh} OFFSET ${offsetPh}`,
      params.values,
    )

    const docs = res.rows.map((r) => this.decodeRow(table, r))
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

  private async _create(q: Queryable, args: { collection: string; data: Row }): Promise<Row> {
    const table = this.table(args.collection)
    const id = String(args.data.id)
    const fields = [quote('id')]
    const params = new Params()
    const placeholders = [params.next(id)]

    for (const col of table.columns) {
      if (Object.prototype.hasOwnProperty.call(args.data, col.name)) {
        fields.push(quote(col.name))
        placeholders.push(params.next(this.encode(col, args.data[col.name])))
      }
    }
    if (table.timestamps) {
      fields.push(quote('createdAt'), quote('updatedAt'))
      placeholders.push('now()', 'now()')
    }

    const res = await q.query(
      `INSERT INTO ${quote(table.table)} (${fields.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
      params.values,
    )
    const created = res.rows[0]
    if (!created) throw new Error('Insert succeeded but returned no row.')
    return this.decodeRow(table, created)
  }

  private async _update(q: Queryable, args: { collection: string; id: string; data: Row }): Promise<Row | null> {
    const table = this.table(args.collection)
    const sets: string[] = []
    const params = new Params()
    for (const col of table.columns) {
      if (Object.prototype.hasOwnProperty.call(args.data, col.name)) {
        sets.push(`${quote(col.name)} = ${params.next(this.encode(col, args.data[col.name]))}`)
      }
    }
    if (table.timestamps) sets.push(`${quote('updatedAt')} = now()`)

    if (sets.length === 0) return this.rawGet(q, table, args.id)

    const idPh = params.next(args.id)
    const res = await q.query(
      `UPDATE ${quote(table.table)} SET ${sets.join(', ')} WHERE ${quote('id')} = ${idPh} RETURNING *`,
      params.values,
    )
    const row = res.rows[0]
    return row ? this.decodeRow(table, row) : null
  }

  private async _delete(q: Queryable, args: { collection: string; id: string }): Promise<Row | null> {
    const table = this.table(args.collection)
    const res = await q.query(`DELETE FROM ${quote(table.table)} WHERE ${quote('id')} = $1 RETURNING *`, [args.id])
    const row = res.rows[0]
    return row ? this.decodeRow(table, row) : null
  }

  private async _count(q: Queryable, args: { collection: string; where?: Where }): Promise<number> {
    const table = this.table(args.collection)
    const params = new Params()
    const whereSql = this.whereSql(table, args.where, params)
    const res = await q.query(`SELECT COUNT(*)::int AS c FROM ${quote(table.table)}${whereSql}`, params.values)
    return Number(res.rows[0]?.c ?? 0)
  }

  // -- public contract surface (pool-backed) --------------------------------

  async findByID(args: { collection: string; id: string }): Promise<Row | null> {
    return this._findByID(this.requirePool(), args)
  }
  async find(args: FindArgs): Promise<PaginatedResult<Row>> {
    return this._find(this.requirePool(), args)
  }
  async create(args: { collection: string; data: Row }): Promise<Row> {
    return this._create(this.requirePool(), args)
  }
  async update(args: { collection: string; id: string; data: Row }): Promise<Row | null> {
    return this._update(this.requirePool(), args)
  }
  async delete(args: { collection: string; id: string }): Promise<Row | null> {
    return this._delete(this.requirePool(), args)
  }
  async count(args: { collection: string; where?: Where }): Promise<number> {
    return this._count(this.requirePool(), args)
  }

  /** A transaction-scoped adapter bound to a single client (or savepoint). */
  private bound(client: PoolClient): DatabaseAdapter {
    const q: Queryable = client as unknown as Queryable
    return {
      kind: this.kind,
      name: this.name,
      contractVersion: this.contractVersion,
      capabilities: this.capabilities,
      init: async () => {},
      migrate: () => {
        throw new Error('migrate() is not available inside a transaction.')
      },
      find: (a) => this._find(q, a),
      findByID: (a) => this._findByID(q, a),
      create: (a) => this._create(q, a),
      update: (a) => this._update(q, a),
      delete: (a) => this._delete(q, a),
      count: (a) => this._count(q, a),
      transaction: (fn) => this.savepoint(client, fn),
      health: async () => ({ status: 'ok' }) as HealthStatus,
      destroy: async () => {},
    }
  }

  private async savepoint<R>(client: PoolClient, fn: (tx: DatabaseAdapter) => Promise<R>): Promise<R> {
    const name = `sp_${++this.savepointSeq}`
    await client.query(`SAVEPOINT ${name}`)
    try {
      const result = await fn(this.bound(client))
      await client.query(`RELEASE SAVEPOINT ${name}`)
      return result
    } catch (err) {
      await client.query(`ROLLBACK TO SAVEPOINT ${name}`)
      throw err
    }
  }

  async transaction<R>(fn: (tx: DatabaseAdapter) => Promise<R>): Promise<R> {
    const client = await this.requirePool().connect()
    await client.query('BEGIN')
    try {
      const result = await fn(this.bound(client))
      await client.query('COMMIT')
      return result
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // The connection may be broken; the original error is what matters.
      }
      throw err
    } finally {
      client.release()
    }
  }

  async health(): Promise<HealthStatus> {
    try {
      await this.requirePool().query('SELECT 1')
      return { status: 'ok' }
    } catch (err) {
      return { status: 'down', detail: err instanceof Error ? err.message : String(err) }
    }
  }

  async destroy(): Promise<void> {
    await this.pool?.end()
    this.pool = null
  }
}

/** Create a PostgreSQL database adapter. */
export function postgresAdapter(options: PostgresAdapterOptions = {}): DatabaseAdapter {
  return new PostgresAdapter(options)
}
