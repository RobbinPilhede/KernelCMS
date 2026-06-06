// Public surface of @kernel/core.

export { defineConfig, sanitizeConfig, defaultLocaleOf } from './config'
export { initKernel, createLogger } from './kernel'
export type { InitOptions } from './kernel'
export { compileSchema, tableForCollection, tableForGlobal, GLOBAL_ROW_ID } from './schema'
export { generateTypes } from './codegen'
export type { CodegenInput } from './codegen'
export { parseSort, mergeWhere, matchesWhere } from './query'
export { evalAccess, isAllowed, asWhere } from './access'
export {
  humanize,
  fieldLabel,
  optionValue,
  optionLabel,
  storageTypeForField,
  columnForField,
  defaultForField,
  applyDefaults,
  validateFields,
  serializeDoc,
  deserializeDoc,
  relationshipFields,
} from './fields'
export { createOperations } from './operations'
export type { Operations, OperationCtx } from './operations'
export { hashPassword, verifyPassword, signToken, verifyToken } from './auth'
export type { TokenPayload } from './auth'
export { describeConfig } from './describe'
export type { AdminSchema, AdminCollection, AdminGlobal, AdminField, AdminFieldOption } from './describe'

export * from './errors'
export type * from './types'

// Convenience re-exports of the storage contract.
export type {
  DatabaseAdapter,
  DatabaseAdapterFactory,
  DatabaseCapabilities,
  KernelSchema,
  TableSchema,
  ColumnSchema,
  StorageType,
  PaginatedResult,
  Row,
  Where,
  WhereOperator,
  WhereCondition,
  SortSpec,
  MigrationReport,
  Logger,
  Adapter,
  AdapterContext,
} from '@kernel/db'
