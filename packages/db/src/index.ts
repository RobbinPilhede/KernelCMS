/**
 * @kernel/db — the persistence adapter contract and the storage-facing schema.
 *
 * The operation core (@kernel/core) is written entirely against these types and
 * never imports a driver. Concrete backends (@kernel/db-sqlite, ...) implement
 * `DatabaseAdapter`. This is the contract that makes the "choose everything"
 * promise real.
 */

// ---------------------------------------------------------------------------
// Storage-facing schema (produced by @kernel/core, consumed by adapters)
// ---------------------------------------------------------------------------

export type StorageType = 'text' | 'integer' | 'real' | 'boolean' | 'json' | 'timestamp'

export interface ColumnSchema {
  /** Column name (matches the field name). */
  name: string
  /** Physical storage type the adapter must provision. */
  type: StorageType
  required: boolean
  unique: boolean
  indexed: boolean
  /** For relationship columns, the collection slug this points at. */
  relationTo?: string
  /** When true, the stored value is a JSON map of locale -> value. */
  localized: boolean
}

export interface TableSchema {
  /** Physical table name. */
  table: string
  /** Logical slug (collection slug, or the global slug). */
  slug: string
  /** Columns excluding the system id/timestamp columns the adapter owns. */
  columns: ColumnSchema[]
  timestamps: boolean
  /** Single-row table backing a global. */
  singleton: boolean
}

export interface KernelSchema {
  tables: TableSchema[]
}

// ---------------------------------------------------------------------------
// Adapter base
// ---------------------------------------------------------------------------

export type AdapterKind = 'db' | 'storage' | 'auth' | 'email' | 'search' | 'cache' | 'queue'

export interface Logger {
  debug: (msg: string, meta?: unknown) => void
  info: (msg: string, meta?: unknown) => void
  warn: (msg: string, meta?: unknown) => void
  error: (msg: string, meta?: unknown) => void
}

export interface AdapterContext {
  logger: Logger
}

export interface HealthStatus {
  status: 'ok' | 'degraded' | 'down'
  detail?: string
}

export interface Adapter {
  readonly kind: AdapterKind
  readonly name: string
  readonly contractVersion: `${number}.${number}`
  init(ctx: AdapterContext): Promise<void>
  health(): Promise<HealthStatus>
  destroy(): Promise<void>
}

// ---------------------------------------------------------------------------
// Query AST
// ---------------------------------------------------------------------------

export type WhereOperator =
  | 'equals'
  | 'not_equals'
  | 'in'
  | 'not_in'
  | 'greater_than'
  | 'greater_than_equal'
  | 'less_than'
  | 'less_than_equal'
  | 'like'
  | 'contains'
  | 'exists'

export type WhereCondition = Partial<Record<WhereOperator, unknown>>

export interface Where {
  and?: Where[]
  or?: Where[]
  [field: string]: WhereCondition | Where[] | undefined
}

export type SortDirection = 'asc' | 'desc'
export interface SortSpec {
  field: string
  direction: SortDirection
}

export type Row = Record<string, unknown>

export interface FindArgs {
  collection: string
  where?: Where
  sort?: SortSpec[]
  limit: number
  page: number
}

export interface PaginatedResult<T = Row> {
  docs: T[]
  totalDocs: number
  limit: number
  page: number
  totalPages: number
  hasNextPage: boolean
  hasPrevPage: boolean
  prevPage: number | null
  nextPage: number | null
  pagingCounter: number
}

export interface MigrationReport {
  createdTables: string[]
  addedColumns: string[]
  statements: string[]
}

// ---------------------------------------------------------------------------
// Database adapter contract
// ---------------------------------------------------------------------------

export interface DatabaseCapabilities {
  transactions: boolean
  joins: 'native' | 'application'
  jsonQuery: boolean
  fullTextSearch: boolean
  returning: boolean
}

export interface DatabaseAdapter extends Adapter {
  readonly kind: 'db'
  readonly capabilities: DatabaseCapabilities
  /** Diff the schema against the live database and apply the changes. */
  migrate(schema: KernelSchema): Promise<MigrationReport>
  find(args: FindArgs): Promise<PaginatedResult<Row>>
  findByID(args: { collection: string; id: string }): Promise<Row | null>
  create(args: { collection: string; data: Row }): Promise<Row>
  update(args: { collection: string; id: string; data: Row }): Promise<Row | null>
  delete(args: { collection: string; id: string }): Promise<Row | null>
  count(args: { collection: string; where?: Where }): Promise<number>
  transaction<R>(fn: (tx: DatabaseAdapter) => Promise<R>): Promise<R>
}

export type DatabaseAdapterFactory = () => DatabaseAdapter
