// Public surface of @kernel/core.

export { defineConfig, sanitizeConfig, defaultLocaleOf, assertProductionSecret } from './config'
export { defineEndpoint, matchEndpoint, parseEndpointInput, invokeEndpoint } from './endpoints'
export type { InvokeEndpointArgs } from './endpoints'
export { initKernel, createLogger } from './kernel'
export type { InitOptions } from './kernel'
export {
  compileSchema,
  tableForCollection,
  tableForGlobal,
  GLOBAL_ROW_ID,
  AUDIT_TABLE,
  REVIEWS_TABLE,
  MIGRATIONS_TABLE,
  LOCKS_TABLE,
  PRESENCE_TABLE,
  CREDENTIALS_TABLE,
  WORKFLOW_RUNS_TABLE,
  CHANGES_TABLE,
  ANALYTICS_TABLE,
} from './schema'
export { createWorkflowEngine, attachWorkflowTriggers } from './workflows'
export type { WorkflowEngine, WorkflowEngineCtx } from './workflows'
export { WORKFLOW_JOB_TASK } from './config'
export { a11yEval, seoEval, policyEval, brandEval, runEvals } from './evals'
export type { EvalResult, SeoEvalOptions, PolicyEvalOptions, BrandEvalOptions } from './evals'
export {
  canonicalJSON,
  hashContent,
  contentForHash,
  createSigner,
  signManifest,
  verifyManifest,
  CanonicalDepthError,
} from './signing'
export type { Signer, SigningAlgorithm, SanitizedSigning } from './signing'
export { generateTypes } from './codegen'
export type { CodegenInput } from './codegen'
export { parseSort, mergeWhere, matchesWhere } from './query'
export { evalAccess, isAllowed, asWhere } from './access'
export { rbacAllows, createRbacStore, injectRbac, assertValidRoleDef, ROLES_TABLE } from './rbac'
export { sanitizeTenancy, injectTenancy, resolveTenant } from './tenancy'
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
  validateLocaleRequired,
  serializeDoc,
  deserializeDoc,
  relationshipFields,
  joinFields,
  effectiveFields,
} from './fields'
export { createOperations } from './operations'
export type { Operations, OperationCtx, RecordAuditArgs } from './operations'
export {
  resolvePersonalized,
  segmentMapCopy,
  isSafeSegmentKey,
  bucketVariant,
  fnv1a32,
  FORBIDDEN_SEGMENT_KEYS,
} from './personalization'
export type { ResolvePersonalizedOptions, BucketExperiment } from './personalization'
export { memoryCache, createCachedDb } from './cache'
export type { MemoryCacheOptions, CachedDbOptions } from './cache'
export { dbCache, redisCache } from './cache-backends'
export type { DbCacheOptions, RedisCacheOptions } from './cache-backends'
export { deliverWebhook, attachWebhooks } from './webhooks'
export type { WebhookPayload } from './webhooks'
export {
  attachChangeFeed,
  createChangeBus,
  createSeqCounter,
  emitChange,
  makeChangeFilter,
  readChanges,
  clampRetain,
  clampChangesLimit,
  MAX_CHANGE_LISTENERS,
  DEFAULT_CHANGE_RETAIN,
  MAX_CHANGE_RETAIN,
  DEFAULT_CHANGES_LIMIT,
  MAX_CHANGES_LIMIT,
} from './realtime'
export type { ChangeBus, SeqCounter, ChangeFeedCtx } from './realtime'
export {
  appendAnalytics,
  buildAnalyticsRow,
  computeInsights,
  createAnalyticsSeq,
  sanitizeMeta,
  isAnalyticsEventType,
  clampAnalyticsRetain,
  clampInsightsLimit,
  ANALYTICS_EVENT_TYPES,
  DEFAULT_ANALYTICS_RETAIN,
  MAX_ANALYTICS_RETAIN,
  MIN_ANALYTICS_RETAIN,
  DEFAULT_INSIGHTS_SCAN,
  MAX_INSIGHTS_SCAN,
  DEFAULT_INSIGHTS_LIMIT,
  MAX_INSIGHTS_LIMIT,
} from './analytics'
export type { AnalyticsCtx, SanitizedAnalyticsEvent } from './analytics'
export {
  cacheTags,
  cacheTagsHeader,
  computePurge,
  purgeTagsForEvent,
  sanitizeTag,
  clampPurgeLimit,
  DEFAULT_PURGE_LIMIT,
  MAX_PURGE_LIMIT,
  MAX_PURGE_REVERSE_LOOKUPS,
} from './edge'
export { memorySearch, attachSearch, extractSearchText } from './search'
export {
  memoryVector,
  attachSemantic,
  reciprocalRankFusion,
  enrichedEmbeddingText,
  cosineSimilarity,
  dot,
  MAX_VECTOR_DIMENSIONS,
} from './vector'
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
export {
  oidcProvider,
  oktaSSO,
  auth0SSO,
  entraSSO,
  googleWorkspaceSSO,
  oneLoginSSO,
  pkceVerifier,
  pkceChallenge,
  OidcError,
} from './oidc'
export type { OidcProviderOptions } from './oidc'
export { describeConfig } from './describe'
export type { AdminSchema, AdminCollection, AdminGlobal, AdminField, AdminBlock, AdminFieldOption } from './describe'
export { fieldSchema, propertiesOf, docSchema } from './json-schema'
export type { JsonSchema } from './json-schema'

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

export { diffSchema, summarizePlan, EMPTY_SCHEMA, isOnlineSafe, downStatementsFor, indexNameFor } from './migrations'
export type { MigrationPlan, MigrationOp, ChangeClass, MigrationJournalEntry, SqlDialect } from './migrations'

export { runDoctor, formatDoctorReport } from './doctor'
export type { Diagnostic, DiagnosticLevel, DoctorReport, DoctorOptions } from './doctor'

export { importData } from './import'
export type { ImportPayload, ImportReport, ImportError, ImportOptions } from './import'

export { systemInfo, formatSystemInfo, setupRuntime, connectorStatus, KERNEL_VERSION } from './info'
export type { SystemInfo, CollectionInfo, SetupRuntime, ConnectorStatus } from './info'

export * from './errors'
export { ALL_LOCALES } from './types'
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
  MigrateOptions,
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
  VectorAdapter,
  VectorAdapterFactory,
  VectorEntry,
  VectorHit,
  VectorResult,
} from '@kernel/db'
