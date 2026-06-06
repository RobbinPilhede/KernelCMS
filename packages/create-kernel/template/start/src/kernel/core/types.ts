import type {
  DatabaseAdapter,
  KernelSchema,
  PaginatedResult,
  Row,
  Where,
} from '@kernel/db'

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
  width?: number
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
  relationTo: string
  hasMany?: boolean
}

export interface ArrayField extends FieldBase {
  type: 'array'
  fields: AnyField[]
  minRows?: number
  maxRows?: number
}

export interface GroupField extends FieldBase {
  type: 'group'
  fields: AnyField[]
}

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

export type FieldType = AnyField['type']

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
}

export interface CollectionConfig {
  slug: string
  labels?: { singular?: string; plural?: string }
  fields: AnyField[]
  timestamps?: boolean
  admin?: {
    useAsTitle?: string
    defaultColumns?: string[]
    group?: string
    description?: string
    hidden?: boolean
  }
  access?: CollectionAccess
  hooks?: CollectionHooks
  /** Mark this collection as an auth collection (adds email + password handling). */
  auth?: boolean | AuthOptions
}

export interface GlobalConfig {
  slug: string
  label?: string
  fields: AnyField[]
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
}

// ---------------------------------------------------------------------------
// Public document + operation surface
// ---------------------------------------------------------------------------

export type Doc = Row & { id: string }

export interface OperationBase {
  req?: Partial<RequestContext>
  overrideAccess?: boolean
  depth?: number
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

export interface UpdateOptions extends OperationBase {
  collection: string
  id: string
  data: Row
}

export interface DeleteOptions extends OperationBase {
  collection: string
  id: string
}

export interface CountOptions extends OperationBase {
  collection: string
  where?: Where
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
  update<T extends Doc = Doc>(opts: UpdateOptions): Promise<T | null>
  delete<T extends Doc = Doc>(opts: DeleteOptions): Promise<T | null>
  count(opts: CountOptions): Promise<number>
  login(opts: LoginOptions): Promise<AuthResult>
  authenticate(token: string): Promise<AuthUser | null>
  findGlobal<T extends Row = Row>(opts: FindGlobalOptions): Promise<T>
  updateGlobal<T extends Row = Row>(opts: UpdateGlobalOptions): Promise<T>
  migrate(): Promise<void>
  destroy(): Promise<void>
}
