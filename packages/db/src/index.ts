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
  /** The kernel's database adapter, provided to non-db adapters that store state
   *  in the database (e.g. a database-backed cache or queue). */
  db?: DatabaseAdapter
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
  /**
   * Load the schema's table registry WITHOUT touching the database. This is what
   * lets reads and writes resolve their tables when migrations are managed
   * out-of-band (i.e. `initKernel` was called without `autoMigrate`). `migrate`
   * implies `register`. Optional for backward compatibility with third-party
   * adapters; the bundled adapters implement it and `initKernel` calls it on boot.
   */
  register?(schema: KernelSchema): void
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

// ---------------------------------------------------------------------------
// Cache adapter contract
// ---------------------------------------------------------------------------

export interface CacheSetOptions {
  /** Time to live in milliseconds. Omitted/0 means no expiry. */
  ttlMs?: number
  /** Tags for grouped invalidation (e.g. a collection slug). */
  tags?: string[]
}

export interface CacheStats {
  hits: number
  misses: number
  evictions: number
  /** Approximate number of live entries, when the backend can report it. */
  size?: number
}

/**
 * A key/value cache with TTL and tag-based invalidation. KernelCMS uses it as a
 * read-through layer in front of the database (see `createCachedDb`): reads are
 * memoized, and any write to a collection invalidates that collection's tag.
 *
 * Correctness over hit rate: when in doubt an adapter should evict. Cache keys
 * carry the access-merged query, so entries are never shared across viewers with
 * different access scopes.
 */
export interface CacheAdapter extends Adapter {
  readonly kind: 'cache'
  /** Resolve a value, or `undefined` on miss/expiry. */
  get<T = unknown>(key: string): Promise<T | undefined>
  /** Store a value with optional TTL and tags. */
  set(key: string, value: unknown, options?: CacheSetOptions): Promise<void>
  /** Remove a single key. */
  delete(key: string): Promise<void>
  /** Remove every key associated with a tag. */
  deleteByTag(tag: string): Promise<void>
  /** Remove everything. */
  clear(): Promise<void>
  /** Best-effort counters for observability; backends may return zeros. */
  stats(): CacheStats
}

export type CacheAdapterFactory = () => CacheAdapter

// ---------------------------------------------------------------------------
// Search adapter contract
// ---------------------------------------------------------------------------

export interface SearchHit {
  id: string
  /** Relevance score; higher is more relevant. Backend-defined scale. */
  score: number
}

export interface SearchResult {
  hits: SearchHit[]
}

/**
 * A full-text index over opt-in collections. KernelCMS keeps it in sync by
 * indexing a document's configured text fields on write and removing it on
 * delete. `kernel.search(...)` queries it, then loads each hit through the normal
 * access-checked read path, so the index never bypasses access control.
 */
export interface SearchAdapter extends Adapter {
  readonly kind: 'search'
  /** Add or replace a document's indexed text. */
  index(args: { collection: string; id: string; text: string }): Promise<void>
  /** Remove a document from the index. */
  remove(args: { collection: string; id: string }): Promise<void>
  /** Return scored hits for a query within a collection. */
  search(args: { collection: string; query: string; limit: number }): Promise<SearchResult>
  /** Drop the index for one collection, or everything when no slug is given. */
  clear(collection?: string): Promise<void>
}

export type SearchAdapterFactory = () => SearchAdapter
