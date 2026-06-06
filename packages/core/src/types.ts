import type { DatabaseAdapter, KernelSchema, Logger, PaginatedResult, Row, Where } from '@kernel/db'
import type { RichTextFeature, RichTextPreset } from '@kernel/richtext'
import type { ImageProcessor, StorageAdapter } from '@kernel/storage'
import type { KernelPlugin } from './plugins'
import type { EmailAdapter } from './email'
import type { OAuthProvider } from './oauth'

// ---------------------------------------------------------------------------
// Request context
// ---------------------------------------------------------------------------

export interface AuthUser {
  id: string
  email?: string
  roles?: string[]
  collection?: string
  [key: string]: unknown
}

export interface RequestContext<TUser extends AuthUser = AuthUser> {
  /** The authenticated user, or null for anonymous requests. */
  user: TUser | null
  /** Active locale for reads/writes. */
  locale: string
  /** Locale to fall back to when a value is missing, or false to disable. */
  fallbackLocale: string | false
  /** Arbitrary per-request data plugins can attach. */
  context: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

export interface AccessArgs<TUser extends AuthUser = AuthUser> {
  req: RequestContext<TUser>
  /** Present for update/delete/read-by-id. */
  id?: string
  /** Present for create/update. */
  data?: Row
}

/** `true`/`false` to allow/deny, or a `Where` to constrain which rows are visible. */
export type AccessResult = boolean | Where
export type AccessFn<TUser extends AuthUser = AuthUser> = (
  args: AccessArgs<TUser>,
) => AccessResult | Promise<AccessResult>

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export type Operation = 'create' | 'read' | 'update' | 'delete'

export interface HookArgs {
  req: RequestContext
  operation: Operation
  /** Incoming/outgoing document data. */
  data?: Row
  /** The existing document for update/delete. */
  originalDoc?: Row
  doc?: Row
}

export type CollectionBeforeChangeHook = (args: HookArgs & { data: Row }) => Row | Promise<Row>
export type CollectionAfterChangeHook = (args: HookArgs & { doc: Row }) => Row | Promise<Row>
export type CollectionAfterReadHook = (args: HookArgs & { doc: Row }) => Row | Promise<Row>
export type CollectionBeforeDeleteHook = (args: { req: RequestContext; id: string }) => void | Promise<void>
export type CollectionAfterDeleteHook = (args: { req: RequestContext; id: string; doc: Row }) => void | Promise<void>

export interface CollectionHooks {
  beforeChange?: CollectionBeforeChangeHook[]
  afterChange?: CollectionAfterChangeHook[]
  afterRead?: CollectionAfterReadHook[]
  beforeDelete?: CollectionBeforeDeleteHook[]
  afterDelete?: CollectionAfterDeleteHook[]
}

// ---------------------------------------------------------------------------
// Field validation
// ---------------------------------------------------------------------------

export interface FieldValidateArgs {
  value: unknown
  data: Row
  req: RequestContext
  operation: 'create' | 'update'
  siblingData: Row
}

export type ValidateFn = (args: FieldValidateArgs) => true | string | Promise<true | string>

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

export interface FieldAdmin {
  description?: string
  placeholder?: string
  readOnly?: boolean
  hidden?: boolean
  position?: 'main' | 'sidebar'
  /** Group the field under a named tab in the editor (presentational only). */
  tab?: string
  /** Group the field under a named sub-section within a tab (presentational only). */
  section?: string
  width?: number
  /** Render a custom admin component for this field, by key. The component must be
   *  registered on `window.KernelCMS.fields[key]` (loaded via `admin.scripts`). */
  component?: string
  /** Show this field only when the predicate over the current form data is true. */
  condition?: (data: Row, siblingData: Row) => boolean
}

export interface FieldAccess {
  read?: AccessFn
  create?: AccessFn
  update?: AccessFn
}

export interface FieldBase {
  name: string
  label?: string
  required?: boolean
  unique?: boolean
  localized?: boolean
  index?: boolean
  defaultValue?: unknown
  admin?: FieldAdmin
  access?: FieldAccess
  validate?: ValidateFn
}

export interface TextField extends FieldBase {
  type: 'text' | 'textarea' | 'email' | 'code' | 'slug'
  minLength?: number
  maxLength?: number
  pattern?: string
}

export interface NumberField extends FieldBase {
  type: 'number'
  min?: number
  max?: number
  integer?: boolean
}

export interface BooleanField extends FieldBase {
  type: 'boolean' | 'checkbox'
}

export interface DateField extends FieldBase {
  type: 'date'
}

export interface JSONField extends FieldBase {
  type: 'json'
}

export interface RichTextField extends FieldBase {
  type: 'richText'
  /** Ordered allow-list of capabilities. Omit to use `preset` (default 'standard'). */
  features?: RichTextFeature[]
  /** Convenience preset compiled to an explicit feature list. */
  preset?: RichTextPreset
}

export interface PointField extends FieldBase {
  type: 'point'
}

export type SelectOption = string | { label: string; value: string }

export interface SelectField extends FieldBase {
  type: 'select' | 'radio'
  options: SelectOption[]
  hasMany?: boolean
}

export interface RelationshipField extends FieldBase {
  type: 'relationship' | 'upload'
  /** A single collection, or several for a polymorphic relationship. Polymorphic
   *  values are stored/returned as `{ relationTo, value }` so the target is explicit. */
  relationTo: string | string[]
  hasMany?: boolean
}

/** A resolved polymorphic relationship reference. */
export interface PolymorphicRef {
  relationTo: string
  value: unknown
}

export interface ArrayField extends FieldBase {
  type: 'array'
  fields: ConfigField[]
  minRows?: number
  maxRows?: number
}

export interface GroupField extends FieldBase {
  type: 'group'
  fields: ConfigField[]
}

/** A single block variant available to a `blocks` field. */
export interface BlockDef {
  slug: string
  labels?: { singular?: string; plural?: string }
  fields: ConfigField[]
  admin?: {
    /** Group blocks under a heading in the section library. */
    group?: string
    /** One-line description shown on the block's library card. */
    description?: string
    /** Preview image URL for the block's library card. */
    thumbnail?: string
  }
}

/** A repeatable list of typed blocks — the page builder. Stored as a JSON array
 *  of `{ blockType, ...blockFields }`. */
export interface BlocksField extends FieldBase {
  type: 'blocks'
  blocks: BlockDef[]
  minRows?: number
  maxRows?: number
}

/** Storage-bearing fields — every one has a `name` and maps to a column/value. */
export type AnyField =
  | TextField
  | NumberField
  | BooleanField
  | DateField
  | JSONField
  | RichTextField
  | PointField
  | SelectField
  | RelationshipField
  | ArrayField
  | GroupField
  | BlocksField

/** Presentational row: lays its child fields out side-by-side. Not persisted —
 *  children are stored at the parent level. */
export interface RowField {
  type: 'row'
  fields: ConfigField[]
  admin?: FieldAdmin
}

/** Presentational tabs: organizes child fields into tabs. Not persisted —
 *  children are stored at the parent level. */
export interface TabsField {
  type: 'tabs'
  tabs: { label: string; description?: string; fields: ConfigField[] }[]
  admin?: FieldAdmin
}

/** A pure UI slot — renders a custom component in the admin, stores nothing. */
export interface UIField {
  type: 'ui'
  name: string
  admin?: FieldAdmin
}

/** A virtual reverse relationship — not stored. Resolved at read time by querying
 *  the related collection for documents whose `on` field points back at this doc.
 *  e.g. on `authors`: `{ type:'join', name:'posts', collection:'posts', on:'author' }`. */
export interface JoinField {
  type: 'join'
  name: string
  /** The collection that holds the back-reference. */
  collection: string
  /** The relationship/upload field on that collection pointing at this document. */
  on: string
  /** Max related documents to return. Default 100. */
  limit?: number
  admin?: FieldAdmin
}

/** What a user may place in `fields`: storage-bearing fields + presentational containers. */
export type ConfigField = AnyField | RowField | TabsField | UIField | JoinField

export type FieldType = ConfigField['type']

// ---------------------------------------------------------------------------
// Collections, globals, config
// ---------------------------------------------------------------------------

export interface CollectionAccess {
  read?: AccessFn
  create?: AccessFn
  update?: AccessFn
  delete?: AccessFn
}

export interface AuthOptions {
  /** Token lifetime in seconds. */
  tokenExpiration?: number
  /** Field used as the login identifier. Defaults to "email". */
  loginField?: string
  /** Allow authenticating as a user via a per-document API key (machine clients). */
  useAPIKey?: boolean
  /**
   * Require email verification before a user can log in. Adds `email_verified` +
   * verification-token system fields and sends a verification email on signup.
   */
  verify?: boolean | VerifyOptions
  /** Enable the forgot-password / reset-password flow (token emailed to the user). */
  forgotPassword?: boolean | ForgotPasswordOptions
  /** Enable TOTP two-factor auth. Adds `totp_secret`/`totp_enabled` system fields;
   *  once enabled per user, login requires a current 6-digit code. */
  twoFactor?: boolean
}

export interface VerifyOptions {
  /** Verification-token lifetime in seconds. Default 86400 (24h). */
  tokenExpiration?: number
  /** Build the verification email. Defaults to a plain branded message. */
  generateEmail?: (args: { token: string; user: Doc }) => { subject: string; html: string; text?: string }
}

export interface ForgotPasswordOptions {
  /** Reset-token lifetime in seconds. Default 3600 (1h). */
  tokenExpiration?: number
  /** Build the reset email. Defaults to a plain branded message. */
  generateEmail?: (args: { token: string; user: Doc }) => { subject: string; html: string; text?: string }
}

export interface CollectionConfig {
  slug: string
  labels?: { singular?: string; plural?: string }
  fields: ConfigField[]
  timestamps?: boolean
  admin?: {
    useAsTitle?: string
    defaultColumns?: string[]
    group?: string
    description?: string
    hidden?: boolean
    /** Point live preview at your frontend; the admin iframes this URL and posts
     *  the live document data to it. Omit to use the built-in preview renderer. */
    livePreview?: { url: string }
  }
  access?: CollectionAccess
  hooks?: CollectionHooks
  /** Mark this collection as an auth collection (adds email + password handling). */
  auth?: boolean | AuthOptions
  /** Keep a version history of documents. `true` = history-only; pass options to
   *  enable drafts. A separate `_versions_<slug>` table stores snapshots. */
  versions?: boolean | VersionsOptions
  /** Make this an upload collection. System fields (filename, mime_type, filesize,
   *  checksum, url, …) are injected and bytes are stored via the configured adapter. */
  upload?: boolean | UploadConfig
}

export interface ImageSize {
  /** Key under the document's `sizes` map (e.g. "thumbnail", "card", "og"). */
  name: string
  width: number
  /** Omit to preserve aspect ratio. */
  height?: number
  /** How the image fills the box. Default 'cover'. */
  fit?: 'cover' | 'contain' | 'inside'
  /** Re-encode the derivative (e.g. 'webp'). Omit to keep the source format. */
  format?: 'jpeg' | 'png' | 'webp' | 'avif'
  /** Encoder quality 1–100. */
  quality?: number
}

export interface UploadConfig {
  /** Named store from `config.storage` (when a map is configured). Default store otherwise. */
  store?: string
  /** Allowed MIME types; supports wildcards like 'image/*'. Default: allow all. */
  mimeTypes?: string[]
  /** Maximum file size in bytes, enforced server-side. */
  maxFileSize?: number
  /** Generate resized derivatives on upload. Requires `config.image` (an
   *  ImageProcessor adapter); ignored for non-images and when no processor is set. */
  imageSizes?: ImageSize[]
  /** Store an editable focal point (`focal_x`/`focal_y`, 0–100) used as the crop
   *  anchor when generating `cover`-fit sizes. */
  focalPoint?: boolean
}

export interface VersionsOptions {
  /** Enable draft vs published lifecycle. Default false (history-only). */
  drafts?: boolean
  /** Ring-buffer cap of versions kept per document. Default 100 (0 = unlimited). */
  maxPerDoc?: number
}

/** Resolved versions config (after sanitize). */
export interface ResolvedVersions {
  enabled: boolean
  drafts: boolean
  maxPerDoc: number
}

export interface GlobalConfig {
  slug: string
  label?: string
  fields: ConfigField[]
  access?: { read?: AccessFn; update?: AccessFn }
  hooks?: Pick<CollectionHooks, 'beforeChange' | 'afterChange' | 'afterRead'>
}

export interface LocalizationConfig {
  locales: string[]
  defaultLocale: string
  fallback?: boolean
}

export interface KernelConfig {
  serverURL?: string
  db: DatabaseAdapter
  collections: CollectionConfig[]
  globals?: GlobalConfig[]
  localization?: LocalizationConfig
  routes?: { api?: string }
  admin?: { user?: string; meta?: { titleSuffix?: string } }
  /** Secret used to sign auth tokens. Never hardcode; read from env. */
  secret?: string
  /** Byte storage for upload collections — a single adapter or a named map. */
  storage?: StorageAdapter | Record<string, StorageAdapter>
  /** Optional image processor (e.g. `sharpImageProcessor()`), enabling `imageSizes`
   *  generation + dimension probing. Omit to store originals only (lean default). */
  image?: ImageProcessor
  /** Outbound email adapter, powering password reset / email verification. When an
   *  auth collection enables `verify`/`forgotPassword` and none is set, a console
   *  adapter is used (with a warning) so local dev still works. */
  email?: EmailAdapter
  /** Background job handlers. Defining any injects a reserved `kernel_jobs`
   *  collection; enqueue work with `kernel.enqueue` and drain it with
   *  `kernel.runDueJobs` (call from a cron — `kernel jobs:run`). */
  jobs?: JobDefinition[]
  /** Custom HTTP endpoints that extend the auto-generated REST surface. Each runs
   *  through the same access + validation + error pipeline. Define with
   *  `defineEndpoint(...)`; bundle several (plus collections/jobs) with
   *  `defineModule(...)`. */
  endpoints?: EndpointConfig[]
  /** OAuth sign-in providers (e.g. `googleOAuth(...)`). Complete sign-in with
   *  `kernel.loginWithOAuth`; the built-in server exposes start + callback routes. */
  oauth?: OAuthProvider[]
  /** Show a small "Powered by KernelCMS" credit in the admin footer. Default true;
   *  set false to opt out. */
  attribution?: boolean
  /** Config-transformer plugins, applied in dependency order before sanitize. */
  plugins?: KernelPlugin[]
}

export interface SanitizedLocalization {
  locales: string[]
  defaultLocale: string
  fallback: boolean
}

export interface SanitizedConfig {
  serverURL: string
  db: DatabaseAdapter
  collections: CollectionConfig[]
  globals: GlobalConfig[]
  localization: SanitizedLocalization | false
  routes: { api: string }
  admin: { user: string }
  secret: string
  collectionsBySlug: Record<string, CollectionConfig>
  globalsBySlug: Record<string, GlobalConfig>
  storage?: StorageAdapter | Record<string, StorageAdapter>
  /** Optional image processor for derivative generation + dimension probing. */
  image?: ImageProcessor
  /** Resolved outbound email adapter (defaults to a console adapter when auth flows
   *  need it but none was configured). */
  email?: EmailAdapter
  /** Registered background-job handlers. */
  jobs?: JobDefinition[]
  /** Registered custom HTTP endpoints. */
  endpoints?: EndpointConfig[]
  /** Registered OAuth providers. */
  oauth?: OAuthProvider[]
  /** Whether the admin shows the "Powered by KernelCMS" credit. */
  attribution: boolean
}

// ---------------------------------------------------------------------------
// Public document + operation surface
// ---------------------------------------------------------------------------

export type Doc = Row & { id: string }

export interface OperationBase {
  req?: Partial<RequestContext>
  overrideAccess?: boolean
  depth?: number
  /** For drafts-enabled collections: when true, read the latest content
   *  (drafts included). Default false → published documents only. */
  draft?: boolean
}

export interface PublishOptions extends OperationBase {
  collection: string
  id: string
  /** Schedule the publish for a future time; the doc stays a draft until then. */
  publishAt?: string | Date
}

export interface ProcessScheduledOptions {
  /** "Now" reference for which scheduled publishes are due. Defaults to current time. */
  now?: string | Date | number
  limit?: number
}

export interface FindOptions extends OperationBase {
  collection: string
  where?: Where
  sort?: string | string[]
  limit?: number
  page?: number
}

export interface FindByIDOptions extends OperationBase {
  collection: string
  id: string
}

export interface CreateOptions extends OperationBase {
  collection: string
  data: Row
}

export interface UploadFileInput {
  /** Raw file bytes. */
  data: Buffer
  /** Original filename (used for the storage key + `filename` system field). */
  name: string
  /** Client-declared MIME type — verified against magic bytes before storing. */
  mimeType: string
}

export interface UploadDocOptions extends OperationBase {
  collection: string
  file: UploadFileInput
  /** User-authored fields (alt, caption, …) merged with injected system fields. */
  data?: Row
}

export interface UpdateOptions extends OperationBase {
  collection: string
  id: string
  data: Row
  /** Mark this save as an autosave: the version snapshot is flagged `autosave`
   *  (drafts collections), so the UI can distinguish auto-saved drafts from manual ones. */
  autosave?: boolean
}

export interface UpdateManyOptions extends OperationBase {
  collection: string
  where?: Where
  data: Row
  /** Safety cap on how many documents one call may touch. Default 1000. */
  limit?: number
}

export interface DeleteManyOptions extends OperationBase {
  collection: string
  where?: Where
  limit?: number
}

export interface BulkResult<T extends Doc = Doc> {
  docs: T[]
  count: number
}

export interface CreateAPIKeyOptions {
  collection: string
  id: string
}

export interface DeleteOptions extends OperationBase {
  collection: string
  id: string
}

export interface CountOptions extends OperationBase {
  collection: string
  where?: Where
}

export interface FindVersionsOptions extends OperationBase {
  collection: string
  id: string
  limit?: number
  page?: number
}

export interface RestoreVersionOptions extends OperationBase {
  collection: string
  id: string
  versionId: string
}

export interface VersionDoc extends Row {
  id: string
  parent: string
  version: Row
  status: string
  autosave: boolean
}

export interface FindGlobalOptions extends OperationBase {
  slug: string
}

export interface UpdateGlobalOptions extends OperationBase {
  slug: string
  data: Row
}

export interface LoginOptions {
  collection: string
  email: string
  password: string
  /** Current TOTP code, required when the account has 2FA enabled. */
  code?: string
}

export interface AuthResult {
  user: AuthUser
  token: string
  exp: number
}

export interface Kernel {
  readonly config: SanitizedConfig
  readonly db: DatabaseAdapter
  readonly schema: KernelSchema
  find<T extends Doc = Doc>(opts: FindOptions): Promise<PaginatedResult<T>>
  findByID<T extends Doc = Doc>(opts: FindByIDOptions): Promise<T | null>
  create<T extends Doc = Doc>(opts: CreateOptions): Promise<T>
  upload<T extends Doc = Doc>(opts: UploadDocOptions): Promise<T>
  update<T extends Doc = Doc>(opts: UpdateOptions): Promise<T | null>
  updateMany<T extends Doc = Doc>(opts: UpdateManyOptions): Promise<BulkResult<T>>
  delete<T extends Doc = Doc>(opts: DeleteOptions): Promise<T | null>
  deleteMany<T extends Doc = Doc>(opts: DeleteManyOptions): Promise<BulkResult<T>>
  count(opts: CountOptions): Promise<number>
  login(opts: LoginOptions): Promise<AuthResult>
  authenticate(token: string): Promise<AuthUser | null>
  createAPIKey(opts: CreateAPIKeyOptions): Promise<{ key: string }>
  authenticateAPIKey(collection: string, key: string): Promise<AuthUser | null>
  forgotPassword(opts: { collection: string; email: string }): Promise<void>
  resetPassword(opts: { collection: string; token: string; password: string }): Promise<AuthResult>
  verifyEmail(opts: { collection: string; token: string }): Promise<{ verified: true }>
  requestEmailVerification(opts: { collection: string; email: string }): Promise<void>
  setupTwoFactor(opts: { collection: string; id: string }): Promise<{ secret: string; otpauthURL: string }>
  enableTwoFactor(opts: { collection: string; id: string; code: string }): Promise<{ enabled: true }>
  disableTwoFactor(opts: { collection: string; id: string }): Promise<{ enabled: false }>
  loginWithOAuth(opts: { collection: string; provider: string; code: string; redirectUri: string }): Promise<AuthResult>
  findGlobal<T extends Row = Row>(opts: FindGlobalOptions): Promise<T>
  updateGlobal<T extends Row = Row>(opts: UpdateGlobalOptions): Promise<T>
  findVersions(opts: FindVersionsOptions): Promise<PaginatedResult<VersionDoc>>
  restoreVersion<T extends Doc = Doc>(opts: RestoreVersionOptions): Promise<T | null>
  publish<T extends Doc = Doc>(opts: PublishOptions): Promise<T | null>
  unpublish<T extends Doc = Doc>(opts: PublishOptions): Promise<T | null>
  processScheduledPublishes(opts?: ProcessScheduledOptions): Promise<{ published: string[] }>
  enqueue(opts: EnqueueOptions): Promise<Doc>
  runDueJobs(opts?: RunJobsOptions): Promise<RunJobsResult>
  migrate(): Promise<void>
  destroy(): Promise<void>
}

// ---------------------------------------------------------------------------
// Background jobs
// ---------------------------------------------------------------------------

/** The Local-API surface handlers get, to read/write content from a job. */
export type JobLocalApi = Pick<
  Kernel,
  | 'find'
  | 'findByID'
  | 'create'
  | 'update'
  | 'updateMany'
  | 'delete'
  | 'deleteMany'
  | 'count'
  | 'findGlobal'
  | 'updateGlobal'
>

export interface JobRunContext {
  /** The payload passed to `enqueue`. */
  input: unknown
  /** The job record (id, attempts, …). */
  job: Doc
  /** In-process API for reading/writing content. */
  local: JobLocalApi
  /** Configured email adapter, if any. */
  email?: EmailAdapter
}

export interface JobDefinition {
  /** Unique task name; `enqueue({ task })` routes to the matching handler. */
  slug: string
  handler: (ctx: JobRunContext) => Promise<unknown> | unknown
  /** Max attempts before the job is marked failed. Default 3. */
  maxAttempts?: number
}

// ---------------------------------------------------------------------------
// Custom endpoints
//
// Typed, validated, access-controlled HTTP handlers that extend the auto-
// generated REST surface. The building block of "build what you want": a
// module/plugin ships its own endpoints alongside its collections, and they
// flow through the same access, validation, and error pipeline as core routes.
// ---------------------------------------------------------------------------

/** A structural validator (Zod-compatible). Anything with `parse(value) => T`
 *  works, so core needs no Zod dependency yet Zod schemas drop straight in. */
export interface Parser<T> {
  parse: (value: unknown) => T
}

export type EndpointMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

/** Per-part input validators. Each is optional; the handler receives the parsed,
 *  typed value for those provided (and `undefined` for those omitted). A parse
 *  failure becomes a ValidationError carried by the standard error envelope. */
export interface EndpointInput<P = unknown, Q = unknown, B = unknown> {
  params?: Parser<P>
  query?: Parser<Q>
  body?: Parser<B>
}

export interface EndpointContext<TUser extends AuthUser = AuthUser> {
  /** Request context (user, locale, per-request data). */
  req: RequestContext<TUser>
  /** The authenticated user, or null. Shorthand for `req.user`. */
  user: TUser | null
  /** The in-process Local API — run typed operations from the handler. */
  local: Kernel
  /** Request-scoped logger. */
  logger: Logger
  /** The raw web-standard Request, for headers / streaming / advanced cases. */
  request: Request
}

export interface EndpointHandlerArgs<P = unknown, Q = unknown, B = unknown, TUser extends AuthUser = AuthUser> {
  /** Parsed, typed input. Parts without a validator are `undefined`. */
  input: { params: P; query: Q; body: B }
  ctx: EndpointContext<TUser>
}

export interface EndpointConfig<P = unknown, Q = unknown, B = unknown, R = unknown, TUser extends AuthUser = AuthUser> {
  method: EndpointMethod
  /** Path relative to the API base, with `:param` segments, e.g. `/comments/:postId`. */
  path: string
  /** Input validators; omitted parts pass through as `undefined`. */
  input?: EndpointInput<P, Q, B>
  /** Authorization. Defaults to authenticated-only (secure by default). Return
   *  `false` (or throw a KernelError) to deny. */
  access?: (args: { req: RequestContext<TUser>; request: Request }) => boolean | Promise<boolean>
  /** The handler. Return JSON-serializable data (sent as 200) or a `Response`. */
  handler: (args: EndpointHandlerArgs<P, Q, B, TUser>) => R | Promise<R>
  /** Optional summary + tags surfaced in generated OpenAPI docs. */
  summary?: string
  tags?: string[]
}

export interface EnqueueOptions {
  task: string
  input?: unknown
  /** When the job becomes eligible to run. Default now. */
  runAt?: string | number | Date
  maxAttempts?: number
}

export interface RunJobsOptions {
  /** Treat this as the current time (testing/determinism). */
  now?: string | number | Date
  /** Max jobs to claim in this pass. Default 100. */
  limit?: number
}

export interface RunJobsResult {
  ran: string[]
  failed: string[]
}
