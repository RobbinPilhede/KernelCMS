// Public surface of @kernel/core.

export { defineConfig, sanitizeConfig, defaultLocaleOf, assertProductionSecret } from './config'
export { defineEndpoint, matchEndpoint, parseEndpointInput } from './endpoints'
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
  joinFields,
  effectiveFields,
} from './fields'
export { createOperations } from './operations'
export type { Operations, OperationCtx } from './operations'
export { memoryCache, createCachedDb } from './cache'
export type { MemoryCacheOptions, CachedDbOptions } from './cache'
export { dbCache, redisCache } from './cache-backends'
export type { DbCacheOptions, RedisCacheOptions } from './cache-backends'
export { deliverWebhook, attachWebhooks } from './webhooks'
export type { WebhookPayload } from './webhooks'
export { memorySearch, attachSearch, extractSearchText } from './search'
export { testPayment, stripePayment, signTestWebhook, verifyStripeSignature, PaymentError } from './payments'
export { commerce } from './commerce'
export type { CommerceOptions } from './commerce'
export type {
  PaymentAdapter,
  PaymentLineItem,
  CreateCheckoutArgs,
  CheckoutSession,
  PaymentEvent,
  PaymentStatus,
  RefundResult,
  TestPaymentOptions,
  StripePaymentOptions,
} from './payments'
export {
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  generateOpaqueToken,
  hashOpaqueToken,
  generateTotpSecret,
  totpCode,
  verifyTotp,
  otpauthURL,
} from './auth'
export type { TokenPayload } from './auth'
export { consoleEmail, memoryEmail, httpEmail } from './email'
export type { EmailAdapter, EmailMessage, MemoryEmailAdapter } from './email'
export { oauthProvider, googleOAuth, githubOAuth } from './oauth'
export type { OAuthProvider, OAuthProfile } from './oauth'
export { describeConfig } from './describe'
export type { AdminSchema, AdminCollection, AdminGlobal, AdminField, AdminBlock, AdminFieldOption } from './describe'

export {
  definePlugin,
  defineModule,
  applyPlugins,
  orderPlugins,
  PluginConflictError,
  PluginCycleError,
  PluginSetupError,
} from './plugins'
export type { KernelPlugin, PluginContext, PluginExtensions, ModuleConfig } from './plugins'

export { diffSchema, summarizePlan, EMPTY_SCHEMA } from './migrations'
export type { MigrationPlan, MigrationOp, ChangeClass } from './migrations'

export { runDoctor, formatDoctorReport } from './doctor'
export type { Diagnostic, DiagnosticLevel, DoctorReport, DoctorOptions } from './doctor'

export { importData } from './import'
export type { ImportPayload, ImportReport, ImportError, ImportOptions } from './import'

export { systemInfo, formatSystemInfo, setupRuntime, connectorStatus, KERNEL_VERSION } from './info'
export type { SystemInfo, CollectionInfo, SetupRuntime, ConnectorStatus } from './info'

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
  CacheAdapter,
  CacheAdapterFactory,
  CacheSetOptions,
  CacheStats,
  SearchAdapter,
  SearchAdapterFactory,
  SearchHit,
  SearchResult,
} from '@kernel/db'
