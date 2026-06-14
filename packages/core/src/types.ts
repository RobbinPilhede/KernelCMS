import type {
  CacheAdapter,
  DatabaseAdapter,
  KernelSchema,
  Logger,
  MigrationReport,
  PaginatedResult,
  Row,
  SearchAdapter,
  VectorAdapter,
  Where,
} from '@kernel/db'
import type { RichTextFeature, RichTextPreset } from '@kernel/richtext'
import type { ImageProcessor, StorageAdapter } from '@kernel/storage'
import type { KernelPlugin } from './plugins'
import type { EmailAdapter } from './email'
import type { OAuthProvider } from './oauth'

// ---------------------------------------------------------------------------
// Request context
// ---------------------------------------------------------------------------

/** A coarse field allow/deny list. `allow` (when set) is deny-by-default: only the
 *  listed top-level field names may be written; everything else is stripped. `deny`
 *  is the inverse. Matched by top-level field name (a permitted group/array passes
 *  its subfields through). */
export interface FieldScope {
  allow?: string[]
  deny?: string[]
}

export interface AuthUser {
  id: string
  email?: string
  roles?: string[]
  collection?: string
  /** What kind of principal this is. `'agent'` is a non-human, access-controlled
   *  caller (e.g. an MCP client): it flows through the SAME access pipeline as a
   *  human but is scoped by `fieldScope` and can NEVER publish (drafts only). */
  principalType?: 'user' | 'agent'
  /** Restrict which top-level fields this principal may write (see {@link FieldScope}).
   *  Enforced in `applyFieldAccess` BEFORE per-field rules. Humans omit this. */
  fieldScope?: FieldScope
  /** The principal's tenant (a TRUSTED claim, set only by the auth layer). When
   *  `config.tenancy` is enabled, this scopes every read/write to the tenant's own rows.
   *  Never derive this from a client query/body/header. See {@link TenancyConfig}. */
  tenant?: string
  [key: string]: unknown
}

/** A non-human, access-controlled principal (e.g. an MCP client). Its true guard
 *  is `fieldScope.allow` plus the hard draft-only brake — NEVER grant an agent an
 *  `admin` role. `token` is the bearer credential (source it from env, never hardcode). */
export interface AgentConfig {
  id: string
  token: string
  label?: string
  roles?: string[]
  fieldScope?: FieldScope
  /** Optional allow-list of collection slugs the agent may act on (informational at
   *  this layer; enforcement is via access rules + fieldScope). */
  collections?: string[]
}

export interface RequestContext<TUser extends AuthUser = AuthUser> {
  /** The authenticated user, or null for anonymous requests. */
  user: TUser | null
  /** Active locale for reads/writes. */
  locale: string
  /** Locale to fall back to when a value is missing, or false to disable. */
  fallbackLocale: string | false
  /** Active audience segment for personalized fields (reads + writes). An unknown or
   *  absent segment resolves to the configured default segment. Untrusted: only a known
   *  segment id is ever honoured (see {@link AudiencesConfig}). */
  audience?: string
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
// RBAC (role -> permission grants)
// ---------------------------------------------------------------------------

/** The operations a role grant can cover. `publish` only applies to drafts-enabled
 *  collections (and is ignored for globals). */
export type RbacOp = 'read' | 'create' | 'update' | 'delete' | 'publish'

/** A per-resource grant: `true` allows every op, or an explicit list of ops. */
export type OpGrant = true | RbacOp[]

/** A role: an optional description, an `admin` super-grant (bypasses per-op checks,
 *  like the literal 'admin' role), and per-collection / per-global op grants. */
export interface RoleDef {
  description?: string
  /** Full access to everything (mirrors the literal 'admin' role convention). */
  admin?: boolean
  /** Op grants keyed by collection slug. */
  collections?: Record<string, OpGrant>
  /** Op grants keyed by global slug (read/update only). */
  globals?: Record<string, OpGrant>
}

/** Opt-in granular RBAC. When omitted, NOTHING changes (full backward compatibility):
 *  no `_roles` table, no access injection. When present, roles seed a runtime-editable
 *  store and injected access rules enforce them. */
export interface RbacConfig {
  roles: Record<string, RoleDef>
}

/** The mutable runtime role store. Created at config compile, seeded from `config.rbac`,
 *  then merged with the `_roles` DB table at boot. The injected access closures capture
 *  this object by reference, so `updateRole`/`createRole`/`deleteRole` take effect on the
 *  next access check with no recompile. */
export interface RbacStore {
  roles: Record<string, RoleDef>
}

// ---------------------------------------------------------------------------
// Multi-tenancy (automatic per-tenant content scoping)
// ---------------------------------------------------------------------------

/** Opt-in multi-tenancy. When set, every scoped collection is automatically constrained
 *  so a principal only ever sees/touches rows of ITS OWN tenant — with zero per-collection
 *  boilerplate. The acting tenant is read from the AUTHENTICATED PRINCIPAL (a trusted
 *  claim), never from a client-supplied param. Omit to disable (nothing changes). */
export interface TenancyConfig {
  /** The server-managed tenant column added to each scoped collection. Default `'tenant'`.
   *  Must be a safe snake_case identifier. */
  field?: string
  /** Which collections are tenant-scoped. Omit to scope ALL non-system, non-auth
   *  collections; or give an explicit allow-list of slugs. */
  collections?: string[]
  /** Fail-closed default (true): a principal with NO resolved tenant is denied all scoped
   *  content (sees nothing) and cannot create scoped docs. Set false to let a tenant-less
   *  principal fall through to the collection's own (un-tenant-scoped) access. */
  requireTenant?: boolean
  /** Extract the acting tenant from the request. DEFAULT: the trusted `req.user.tenant`
   *  claim. MUST derive only from the authenticated principal — never a client query/body/
   *  header — or cross-tenant isolation is broken. Return null/undefined for "no tenant". */
  resolve?: (req: RequestContext) => string | null | undefined
}

/** Resolved multi-tenancy settings (after sanitize). `enabled:false` when unconfigured
 *  (no tenant field, no access wrapping — fully backward-compatible). */
export interface SanitizedTenancy {
  enabled: boolean
  /** The server-managed tenant column name. */
  field: string
  /** Resolved slugs of the tenant-scoped collections. */
  collections: string[]
  /** Fail-closed: deny scoped content to a tenant-less principal. */
  requireTenant: boolean
  /** Principal-derived tenant resolver (defaults to `req.user.tenant`). */
  resolve: (req: RequestContext) => string | null | undefined
}

/** A role as returned by the Local/HTTP API: its name plus its definition. */
export interface RoleDoc {
  name: string
  def: RoleDef
}

/** Options for runtime role mutations. `req` attributes the change to the acting
 *  admin in the audit log; it never relaxes access (the HTTP layer enforces the
 *  admin gate before these run). */
export interface RoleMutationOptions {
  req?: Partial<RequestContext>
}

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
  /** Store this field as a per-audience-segment value map (`{ [segment]: value }`), the
   *  personalization parallel of `localized`. On write the value is merged into the
   *  existing map for the request's write segment (other segments untouched); on read it
   *  resolves to the active `audience` segment, then the default segment, then null.
   *  Requires `config.audiences`. A field can't be BOTH `localized` and `personalized`
   *  (rejected at sanitize). Still subject to field read-access. */
  personalized?: boolean
  index?: boolean
  /** Encrypt this field's value at rest with AES-256-GCM (transparent: encrypted on write,
   *  decrypted on read). The storage column holds an authenticated `enc:1:…` ciphertext
   *  envelope, never the plaintext. Requires `config.encryption`. Because ciphertext is
   *  opaque and non-deterministic, an encrypted field can't be `unique`, `index`ed,
   *  filtered/sorted on, full-text searched, `localized`, or `personalized` (all rejected at
   *  config load). Field read-access still applies on top. */
  encrypted?: boolean
  defaultValue?: unknown
  admin?: FieldAdmin
  access?: FieldAccess
  validate?: ValidateFn
  /** Mark a `compute` field as virtual: derived on every read, not stored as a
   *  column, and not validated as input. Because it is not persisted, a virtual
   *  field cannot be sorted or filtered on. Omit (or set false) to get a STORED
   *  computed field instead — see `compute`. Rendered read-only in the admin. */
  virtual?: boolean
  /** Derive this field's value instead of taking it from input. Two modes:
   *
   *  - With `virtual: true` — derived on every READ from the resolved document.
   *    Lives only in memory, so it is never stored and cannot be sorted/filtered.
   *  - Without `virtual` (the default) — a STORED computed field: derived at WRITE
   *    time (create/update), persisted to a real column, and therefore sortable
   *    and filterable. The computed value always overrides any client input.
   *
   *  Either way the logic lives in one place so it can't drift ("views as
   *  contract" at the field level). May be async. */
  compute?: (args: { doc: Doc; req: RequestContext }) => unknown | Promise<unknown>
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

/** Referential-integrity action applied to THIS referring field when a document it
 *  points at is deleted. Unset = no action (legacy behaviour): the reference is left
 *  dangling and `populate` tolerates it. `setNull` clears the ref (or pulls the id
 *  from a hasMany list); `cascade` deletes the referring document; `restrict` blocks
 *  the delete while any referrer exists. */
export type OnDeleteAction = 'setNull' | 'cascade' | 'restrict'

export interface RelationshipField extends FieldBase {
  type: 'relationship' | 'upload'
  /** A single collection, or several for a polymorphic relationship. Polymorphic
   *  values are stored/returned as `{ relationTo, value }` so the target is explicit. */
  relationTo: string | string[]
  hasMany?: boolean
  /** What happens to documents holding this reference when the target is deleted.
   *  Defaults to no action (dangling reference) when omitted — non-breaking. */
  onDelete?: OnDeleteAction
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
  /** Gate the draft → published transition as a distinct, access-controlled step
   *  (drafts-enabled collections). Evaluated whenever a write would set `_status`
   *  to 'published' that wasn't already — via `publish()`, a raw `_status` write,
   *  or a born-published `create()`. When omitted, falls back to `update` so any
   *  principal who can update can still publish; set it to restrict publishing to
   *  a subset (e.g. forbid agents from publishing). Bypassed by `overrideAccess`. */
  publish?: AccessFn
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
    /** Default ordering for the list view and for `find()` calls that pass no
     *  `sort` (Payload-style: "title" asc, "-createdAt" desc, comma-separated for
     *  tie-breakers). Falls back to newest-first by `createdAt` (or `id`). */
    defaultSort?: string
    group?: string
    description?: string
    hidden?: boolean
    /** Point live preview at your frontend; the admin iframes this URL and posts
     *  the live document data to it. Omit to use the built-in preview renderer.
     *  Set `false` to disable the preview pane entirely for this collection. */
    livePreview?: { url: string } | false
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
  /** Read-through caching for this collection (requires `config.cache`). `true`
   *  uses the default TTL; pass `{ ttl }` (ms) to override. Reads are memoized at
   *  the database layer and invalidated on any write to this collection. */
  cache?: boolean | { ttl?: number }
  /** Full-text search for this collection (requires `config.search`). Index the
   *  listed text fields; query with `kernel.search({ collection, query })`.
   *  Set `semantic: true` to ALSO embed each document (requires `config.embeddings`)
   *  for vector / hybrid search via `kernel.semanticSearch` / `kernel.hybridSearch`. */
  search?: { fields: string[]; semantic?: boolean }
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
  /** Admin presentation: group globals under a sidebar heading and describe them. */
  admin?: { group?: string; description?: string }
  access?: { read?: AccessFn; update?: AccessFn }
  hooks?: Pick<CollectionHooks, 'beforeChange' | 'afterChange' | 'afterRead'>
}

export interface LocalizationConfig {
  locales: string[]
  defaultLocale: string
  fallback?: boolean
  /** Strict localization. OFF by default (fully backward-compatible). When on:
   *  reads NEVER silently fall back to another locale (an untranslated field reads
   *  `null`, so missing translations can't masquerade as present); `required`
   *  localized fields are validated for the locale being written; and `publish`
   *  rejects a doc whose DEFAULT locale is missing a required localized field.
   *  A caller may still opt into fallback per-request via an explicit `fallbackLocale`. */
  strict?: boolean
}

// ---------------------------------------------------------------------------
// Personalization + A/B experiments
//
// The personalization parallel of localization: a `personalized` field stores a
// `{ [segment]: value }` map keyed by AUDIENCE SEGMENT instead of locale, resolved
// per request from `req.audience` (→ default segment → null). A/B experiments bucket
// a caller-supplied visitor key deterministically to a variant — and a variant IS a
// segment id, so composing the assigned variant as `req.audience` makes reads return
// that variant's personalized content.
// ---------------------------------------------------------------------------

/** Audience segments for personalized content. `default` is the resolve-fallback
 *  segment and must be one of `segments`. */
export interface AudiencesConfig {
  segments: string[]
  default: string
}

/** Resolved audiences config (after sanitize). `enabled:false` when unconfigured. */
export interface SanitizedAudiences {
  enabled: boolean
  segments: string[]
  default: string
}

/** A declarative A/B experiment. Each `variant` must be a configured audience segment.
 *  `weights` (default equal) bias the deterministic bucketing; `seed` namespaces the
 *  hash so re-running an experiment under a new seed reshuffles assignments. */
export interface ExperimentConfig {
  slug: string
  variants: string[]
  weights?: number[]
  seed?: string
}

/** Resolved experiment (after sanitize): normalized, non-negative weights that sum > 0. */
export interface SanitizedExperiment {
  slug: string
  variants: string[]
  weights: number[]
  seed: string
}

export interface AssignVariantOptions {
  /** The experiment slug (must be configured). */
  experiment: string
  /** A caller-supplied visitor/session id. Only its HASH is ever used or recorded —
   *  the raw key is never stored (no PII at rest). */
  key: string
}

export interface AssignVariantResult {
  experiment: string
  /** The assigned variant — also a valid audience segment id. */
  variant: string
  /** Alias of `variant`: set `req.audience = segment` to read that variant's content. */
  segment: string
}

export type WebhookEvent = 'create' | 'update' | 'delete'

export interface WebhookConfig {
  /** Stable identifier for this endpoint — keys the durable delivery log and the admin
   *  retry route. Optional; when omitted a stable slug is derived from the URL. Must be
   *  unique across the configured webhooks. */
  slug?: string
  /** Destination URL for the POST. Must be `http(s)`; a URL whose host is a loopback /
   *  private / link-local / cloud-metadata address is REJECTED at config load unless
   *  `allowPrivateNetwork` is set (SSRF egress guard). */
  url: string
  /** HMAC-SHA256 signing secret. When set, an `x-kernel-signature: sha256=<hex>`
   *  header lets the receiver verify the body. Read from env; never hardcode. */
  secret?: string
  /** Restrict to these collection slugs. Default: all non-system collections. */
  collections?: string[]
  /** Restrict to these events. Default: create, update, delete. */
  events?: WebhookEvent[]
  /** Extra headers to send (e.g. an auth token for the receiver). */
  headers?: Record<string, string>
  /** Abort the delivery after this many ms. Default 5000. */
  timeoutMs?: number
  /** Durable delivery: instead of a best-effort inline POST on the write, enqueue the
   *  event to the `_webhook_deliveries` outbox and deliver it from the cron drain
   *  (`kernel.processWebhooks`, wired into `jobs:run`) with retry + backoff. A slow or
   *  down receiver no longer drops events or slows the write. Default false (inline). */
  durable?: boolean
  /** Max delivery attempts before a durable delivery is marked `exhausted`. Default 5,
   *  clamped 1–20. Only meaningful with `durable`. */
  maxAttempts?: number
  /** Allow a destination on a loopback/private/link-local network (disables the SSRF
   *  guard for THIS endpoint). For trusted internal receivers / local dev only. */
  allowPrivateNetwork?: boolean
}

/** A configured webhook after normalization: a guaranteed unique `slug`, defaulted
 *  `maxAttempts`, and the SSRF guard already enforced at config load. */
export interface SanitizedWebhook extends WebhookConfig {
  slug: string
  maxAttempts: number
}

/** Status of one durable webhook delivery in the `_webhook_deliveries` outbox. */
export type WebhookDeliveryStatus = 'pending' | 'delivered' | 'failed' | 'exhausted'

/** A row of the durable webhook delivery log. */
export interface WebhookDeliveryDoc extends Row {
  id: string
  /** The target webhook's slug. */
  webhook: string
  event: WebhookEvent
  collection: string
  documentId: string
  status: WebhookDeliveryStatus
  /** How many delivery attempts have been made. */
  attempts: number
  /** The last HTTP status code or a short error string (never the secret). */
  lastStatus: string | null
  /** When the next attempt is due (ISO). Null once delivered/exhausted. */
  nextAttemptAt: string | null
  /** When the delivery succeeded (ISO), else null. */
  deliveredAt: string | null
  createdAt: string
  updatedAt: string
}

export interface ProcessWebhooksOptions {
  /** Treat "now" as this instant (defaults to the current time). */
  now?: Date
  /** Max deliveries to attempt this drain. Default 50, clamped 1–1000. */
  limit?: number
}

export interface ProcessWebhooksResult {
  /** Deliveries that succeeded this drain (their ids). */
  delivered: string[]
  /** Deliveries that failed this drain and will be retried (their ids). */
  retried: string[]
  /** Deliveries that hit `maxAttempts` and were marked exhausted (their ids). */
  exhausted: string[]
}

export interface WebhookDeliveriesOptions {
  /** Filter to one webhook slug. */
  webhook?: string
  /** Filter to one status. */
  status?: WebhookDeliveryStatus
  /** Return rows created after this ISO time. */
  since?: string
  limit?: number
  page?: number
  req?: Partial<RequestContext>
  overrideAccess?: boolean
}

export interface RetryWebhookDeliveryOptions {
  deliveryId: string
  req?: Partial<RequestContext>
  overrideAccess?: boolean
}

/** A redacted view of a configured webhook for the admin surface — never includes the
 *  signing secret or custom headers (which may carry credentials). */
export interface WebhookSummary {
  slug: string
  url: string
  events: WebhookEvent[]
  collections: string[] | null
  durable: boolean
  signed: boolean
}

// ---------------------------------------------------------------------------
// Real-time content: change feed (CDC, pull) + in-process bus + SSE (push)
//
// Every content change on a non-system collection emits a METADATA-ONLY event —
// `{ seq, at, collection, documentId, event, principalType }`, never the document
// body — so a change event can NEVER leak a field a subscriber can't read. The
// subscriber re-fetches the doc through the normal access-checked API. The durable
// pull feed, the in-process `subscribe` bus, and the SSE stream all share ONE
// access-filter so a subscriber never even learns that a forbidden document changed.
// ---------------------------------------------------------------------------

/** The kind of content change a {@link ChangeEvent} records. `publish`/`unpublish`
 *  are reserved for forward-compatibility (drafts transitions); the hook-based feed
 *  emits create/update/delete (a publish reads as 'update'). */
export type ChangeEventType = 'create' | 'update' | 'delete' | 'publish' | 'unpublish'

/** One change-feed event. METADATA ONLY — it carries no document body or field values,
 *  so it can never leak content a subscriber is not allowed to read. `seq` is a
 *  monotonic integer cursor (ordered across the whole feed); poll the pull feed with
 *  `since=seq`. `principalType` names the kind of actor only (never a token). */
export interface ChangeEvent {
  /** Monotonic integer cursor. Strictly increasing across the whole feed. */
  seq: number
  /** ISO timestamp the change was recorded. */
  at: string
  collection: string
  documentId: string
  event: ChangeEventType
  /** The acting principal's kind. Never an auth token — just the actor classification. */
  principalType: 'user' | 'agent' | 'system'
}

/** Real-time content config. OPT-IN: when omitted, nothing changes (no `_changes`
 *  table, no change-feed hooks, no bus). When enabled, content changes are recorded
 *  to the durable `_changes` outbox, fan out to in-process `subscribe` listeners, and
 *  are served by the access-filtered pull feed + SSE stream. */
export interface RealtimeConfig {
  enabled?: boolean
  /** Max rows kept in the `_changes` outbox (oldest trimmed first, like version
   *  maxPerDoc). Default 10000; clamped to a sane bound. */
  retain?: number
}

/** Resolved realtime settings (after sanitize). `enabled:false` when unconfigured. */
export interface SanitizedRealtime {
  enabled: boolean
  /** Bounded `_changes` retention (max rows). */
  retain: number
}

export interface ChangesOptions {
  /** Return only changes with `seq` strictly greater than this cursor. Default 0 (all). */
  since?: number
  /** Narrow to one collection. */
  collection?: string
  /** Max events to return (after access filtering). Clamped. Default 100. */
  limit?: number
  /** The caller request context — its read access scopes which events are returned. */
  req?: Partial<RequestContext>
  /** Trusted server call: bypass the per-event access filter (sees every change). Never
   *  set from an untrusted boundary — the REST route always passes the request principal. */
  overrideAccess?: boolean
}

export interface ChangesResult {
  /** The access-filtered, ordered change events (oldest → newest). */
  changes: ChangeEvent[]
  /** The highest `seq` returned — poll again with `since=cursor`. Equals the input
   *  `since` when nothing new is visible. */
  cursor: number
}

// ---------------------------------------------------------------------------
// Edge content delivery — surrogate cache tags + a purge feed
//
// Content reads carry surrogate cache TAGS (`<collection>`, `<collection>:<id>`, and —
// opt-in — the tags of directly-referenced docs) so a CDN/edge cache can cache
// aggressively, and a PURGE FEED derived from the real-time change feed tells the CDN
// exactly which tags to invalidate when content changes. Provider-agnostic: KernelCMS
// emits the tags + purge list; the user wires their CDN (Cloudflare/Fastly/Vercel).
//
// SECURITY — aggressive (`s-maxage`/public) caching is applied ONLY to a response
// produced for an ANONYMOUS principal over a publicly-readable collection; an
// authenticated/scoped response is marked `private, no-store`. Tags derive only from
// the RETURNED, access-checked docs and are sanitized to CDN-safe tokens. The purge
// feed reveals which ids changed → it is admin/operator-gated (like the change feed).
// ---------------------------------------------------------------------------

/** Edge content-delivery config. OPT-IN: when omitted, nothing changes (no cache
 *  headers, no purge feed). The purge feed additionally requires `realtime` (it is
 *  derived from the change feed). See {@link KernelConfig.edge}. */
export interface EdgeConfig {
  enabled?: boolean
  /** The `Cache-Control` header value set on a CACHEABLE (anonymous, public-read)
   *  content GET response. Default `'public, max-age=0, s-maxage=31536000,
   *  stale-while-revalidate=60'` (browser revalidates, CDN caches long, serves stale
   *  while revalidating — combined with tag-purge this is "cache forever, purge on
   *  change"). An authenticated/scoped response is ALWAYS `private, no-store`
   *  regardless of this value. */
  cacheControl?: string
  /** The surrogate-key header name. Default `'Surrogate-Key'` (the Fastly convention;
   *  Cloudflare uses `Cache-Tag` — set it here to match your CDN). */
  tagHeader?: string
  /** Also tag a document with its DIRECT relationship targets, so changing a referenced
   *  doc purges this one (the purge feed then maps a change to the docs that reference
   *  it). Default true. */
  includeRelationships?: boolean
}

/** Resolved edge settings (after sanitize). `enabled:false` when unconfigured. */
export interface SanitizedEdge {
  enabled: boolean
  cacheControl: string
  tagHeader: string
  includeRelationships: boolean
}

/** Args for {@link Kernel.cacheTags}: a single document (by `id` and/or `doc`) OR a
 *  list response (`docs`). For a single doc, supplying `doc` lets relationship-target
 *  tags be included (when `edge.includeRelationships`); `id` alone yields the
 *  collection + doc tag. */
export interface CacheTagsOptions {
  collection: string
  id?: string
  doc?: Doc
  /** A list response's returned docs — yields the collection tag + each doc's tag. */
  docs?: Doc[]
}

export interface PurgeFeedOptions {
  /** Map only changes with `seq` strictly greater than this cursor. Default 0 (all). */
  since?: number
  /** Max recent changes to scan/map (clamped). Default 1000. */
  limit?: number
}

export interface PurgeFeedResult {
  /** The de-duped surrogate cache tags to purge at the CDN. */
  tags: string[]
  /** The highest `seq` scanned — poll again with `since=cursor`. Equals `since` when
   *  nothing new was found. */
  cursor: number
}

// ---------------------------------------------------------------------------
// Content analytics & insights — privacy-first capture + aggregate
//
// Content EVENTS (view / search / ai_retrieval / citation / variant_impression /
// conversion / custom) are appended to a single `_analytics` system table as
// METADATA-ONLY rows, then answered with AGGREGATE insights. NO PII is ever stored:
// no user id, IP, raw visitor key, email, or token — only content/event metadata.
// `query` is the search TERMS, not a user identity. `autoCapture` (opt-in) auto-emits
// an `ai_retrieval` per doc a semantic/hybrid/graph search returns and a
// `variant_impression` when `assignVariant` runs.
// ---------------------------------------------------------------------------

/** The kind of content-usage event recorded in `_analytics`. */
export type AnalyticsEventType =
  | 'view'
  | 'search'
  | 'ai_retrieval'
  | 'citation'
  | 'variant_impression'
  | 'conversion'
  | 'custom'

/** Content analytics config. OPT-IN: when omitted, nothing changes (no `_analytics`
 *  table, no capture, no auto-capture). When enabled, content events are appended to
 *  the bounded `_analytics` table and answered with aggregate `insights`. */
export interface AnalyticsConfig {
  enabled?: boolean
  /** Max rows kept in `_analytics` (oldest `seq` trimmed first, like the change feed).
   *  Default 100000; clamped to a sane bound. */
  retain?: number
  /** Auto-emit `ai_retrieval` events (one per returned doc) from semantic / hybrid /
   *  graph search, and a `variant_impression` from `assignVariant`. OFF by default, so
   *  capture adds zero overhead unless explicitly turned on. */
  autoCapture?: boolean
}

/** Resolved analytics settings (after sanitize). `enabled:false` when unconfigured. */
export interface SanitizedAnalytics {
  enabled: boolean
  /** Bounded `_analytics` retention (max rows). */
  retain: number
  /** Whether search / assignVariant auto-emit analytics events. */
  autoCapture: boolean
}

/** Capture one content-usage event. NO PII: never pass (and the engine never stores) a
 *  user id, IP, raw visitor key, email, or token. `query` is the search TERMS only;
 *  `meta` is for NON-PII aggregate dimensions only (PII-ish + proto keys are stripped). */
export interface TrackOptions {
  type: AnalyticsEventType
  /** The content collection the event is about (nullable — e.g. a bare `search`). */
  collection?: string
  /** The document the event is about (nullable). */
  documentId?: string
  /** Search / retrieval TERMS (NOT user identity); nullable. */
  query?: string
  /** Experiment slug, for variant impressions/conversions; nullable. */
  experiment?: string
  /** Variant / segment id, for variant impressions/conversions; nullable. */
  variant?: string
  /** A numeric measure (e.g. a conversion amount or count); nullable. */
  value?: number
  /** Non-PII aggregate dimensions only. Sanitized on write: prototype-pollution AND
   *  PII-ish keys are stripped, values coerced to primitives + size-bounded. */
  meta?: Record<string, unknown>
  /** Request context. Used ONLY for HTTP-layer gating — NO field of it (no user id /
   *  token) is ever copied onto the stored row. */
  req?: Partial<RequestContext>
  /** Trusted server call marker (carried for symmetry; never relaxes the no-PII rule). */
  overrideAccess?: boolean
}

/** The aggregate insight to compute. All are AGGREGATES over content events (no per-user
 *  data exists to leak). `ai_retrieval_leaderboard` is the headline "how AI uses your
 *  content" view (top content among `ai_retrieval` events). */
export type InsightsMetric =
  | 'top_content'
  | 'top_queries'
  | 'variant_performance'
  | 'activity'
  | 'ai_retrieval_leaderboard'

export interface InsightsOptions {
  metric: InsightsMetric
  /** Narrow to one collection. */
  collection?: string
  /** Narrow to one event type (e.g. `view` vs `ai_retrieval` for `top_content`). */
  type?: AnalyticsEventType
  /** ISO inclusive lower bound on the event time. */
  from?: string
  /** ISO inclusive upper bound on the event time. */
  to?: string
  /** Max result rows. Clamped. Default 20. */
  limit?: number
  /** Reviewer request context — its read access scopes which collections' counts are
   *  returned (the HTTP layer is also admin/editor-gated). */
  req?: Partial<RequestContext>
  /** Trusted server call: bypass the per-collection read filter. Never set from an
   *  untrusted boundary — the REST route always passes the request principal. */
  overrideAccess?: boolean
}

/** One row in a `top_content` / `ai_retrieval_leaderboard` insight. */
export interface ContentInsightRow {
  collection: string
  documentId: string
  count: number
}

/** One row in a `top_queries` insight. */
export interface QueryInsightRow {
  query: string
  count: number
}

/** One row in a `variant_performance` insight. `rate` is present only when impressions > 0. */
export interface VariantInsightRow {
  experiment: string
  variant: string
  impressions: number
  conversions: number
  rate?: number
}

/** One row in an `activity` insight: a UTC day bucket with total + per-type counts. */
export interface ActivityInsightRow {
  bucket: string
  count: number
  byType: Record<string, number>
}

export type InsightRow = ContentInsightRow | QueryInsightRow | VariantInsightRow | ActivityInsightRow

export interface InsightsResult {
  metric: InsightsMetric
  rows: InsightRow[]
}

/** A pluggable embeddings provider: maps N input strings to N equal-dimension
 *  vectors. Provider-agnostic (OpenAI/Cohere/local/etc.) — the user supplies it. */
export type EmbedFn = (texts: string[]) => Promise<number[][]>

/** Embeddings provider config for semantic search. See {@link KernelConfig.embeddings}. */
export interface EmbeddingsConfig {
  embed: EmbedFn
  /** Expected vector dimensionality (informational; used as a sanity bound). */
  dimensions?: number
}

/** A pluggable, provider-agnostic machine-translation provider: maps N source strings
 *  (all in locale `from`) to N translations in locale `to`, IN ORDER. The user supplies
 *  it — DeepL, OpenAI, Google, a local model — KernelCMS has no hard dependency on any.
 *  The closure may hold an API key; KernelCMS NEVER logs its inputs/outputs and wraps any
 *  thrown error in a generic message at the request boundary. */
export type TranslateFn = (opts: { texts: string[]; from: string; to: string }) => Promise<string[]>

/** AI-assisted translation config. See {@link KernelConfig.translation}. Requires
 *  `localization` to be configured (a translation targets a configured locale). */
export interface TranslationConfig {
  translate: TranslateFn
}

export interface KernelConfig {
  serverURL?: string
  db: DatabaseAdapter
  collections: CollectionConfig[]
  globals?: GlobalConfig[]
  localization?: LocalizationConfig
  /** Audience segments for personalized content fields (the personalization parallel of
   *  `localization`). When set, `personalized` fields store a per-segment value map and
   *  resolve from `req.audience`. Omit to disable personalization. */
  audiences?: AudiencesConfig
  /** Declarative A/B experiments. `kernel.assignVariant` buckets a visitor key to a
   *  variant deterministically; the variant is an audience segment, so feeding it back as
   *  `req.audience` reads that variant's personalized content. Requires `audiences`. */
  experiments?: ExperimentConfig[]
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
  /** Autonomous content workflows: declarative pipelines a SCOPED agent runs from
   *  trigger → draft → quality gate → human review. Steps operate through a Local-API
   *  bound to the workflow's agent principal (field-scoped, draft-only, access-checked,
   *  never `overrideAccess`); content advances only via `ctx.evalGate` / `ctx.requestReview`,
   *  so a workflow can NEVER auto-publish. Provisions a `_workflow_runs` log + a reserved
   *  drain job; create/update triggers enqueue runs durably via the jobs system. */
  workflows?: WorkflowDefinition[]
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
  /** Cache adapter (e.g. `memoryCache()`, `dbCache()`, `redisCache(...)`). When set,
   *  collections with `cache` enabled are served read-through and invalidated on write. */
  cache?: CacheAdapter
  /** Outbound webhooks: fire a signed HTTP POST when documents change. */
  webhooks?: WebhookConfig[]
  /** Real-time content: a durable change feed (CDC) + an in-process `subscribe` bus +
   *  a live SSE stream, so UIs update live and agents react to changes. OPT-IN; events
   *  are metadata-only and access-filtered per subscriber. See {@link RealtimeConfig}. */
  realtime?: RealtimeConfig
  /** Edge content delivery: surrogate cache tags on content reads + a purge feed
   *  derived from the change feed, so a CDN/edge cache can cache aggressively and
   *  invalidate precisely. OPT-IN and disabled by default. The purge feed additionally
   *  requires `realtime`. Provider-agnostic — you emit the tags + purge list; you wire
   *  your CDN. See {@link EdgeConfig}. */
  edge?: EdgeConfig
  /** Content analytics & insights: capture content-usage events (views, searches,
   *  AI/RAG retrievals, variant impressions, conversions) into a bounded `_analytics`
   *  system table and answer them with privacy-first AGGREGATE insights. OPT-IN and
   *  disabled by default. NO PII is ever stored. `autoCapture` (opt-in) auto-emits
   *  `ai_retrieval` events from search and `variant_impression` from `assignVariant`.
   *  See {@link AnalyticsConfig}. */
  analytics?: AnalyticsConfig
  /** Search adapter (e.g. `memorySearch()`). Collections with `search` enabled
   *  are indexed on write and queried via `kernel.search`. */
  search?: SearchAdapter
  /** Pluggable, provider-agnostic embeddings. `embed` maps N strings to N
   *  equal-dimension vectors (OpenAI/Cohere/local — you supply it). When set,
   *  collections with `search: { semantic: true }` are embedded on write into a
   *  vector store and queried via `kernel.semanticSearch` / `kernel.hybridSearch`.
   *  The closure may hold an API key — KernelCMS NEVER logs its inputs/outputs. */
  embeddings?: EmbeddingsConfig
  /** Vector store adapter for semantic search. Defaults to `memoryVector()` when
   *  `embeddings` is set (mirrors how `search` works). Swap for a pgvector-backed
   *  adapter in production — it implements the same `VectorAdapter` contract. */
  vector?: VectorAdapter
  /** Pluggable, provider-agnostic AI-assisted translation. `translate` maps N source
   *  strings (locale `from`) to N translations (locale `to`) — you supply the provider
   *  (DeepL/OpenAI/Google/local; no hard dependency). When set, `kernel.translateDocument`
   *  / `kernel.translateMissing` auto-fill untranslated locales of localized fields.
   *  Requires `localization`. Translation WRITES go through the normal access-checked
   *  update (strict per-locale validation + the agent draft-only brake all apply). The
   *  closure may hold an API key — KernelCMS NEVER logs its inputs/outputs. */
  translation?: TranslationConfig
  /** Default cache TTL in ms applied to cached collections that don't set their own.
   *  0 (default) means entries live until invalidated by a write. */
  cacheDefaults?: { ttl?: number }
  /** Non-human, access-controlled principals (e.g. MCP clients). Each authenticates
   *  with its bearer `token` and runs through the full access pipeline scoped by its
   *  `fieldScope`; agents can never publish. Source tokens from env, never hardcode. */
  agents?: AgentConfig[]
  /** Append-only governance audit log. When enabled, every mutating operation
   *  (create/update/delete/publish/unpublish) and auth event (login/login_failed)
   *  is recorded with who/what/when into a single `_audit` system table, queryable
   *  via `kernel.findAuditLog` and exportable over `GET /api/_admin/audit`.
   *  Opt-in and DISABLED by default — `true` or `{ enabled: true }` turns it on. */
  audit?: boolean | { enabled?: boolean }
  /** Granular, runtime-editable RBAC (role -> permission grants). OPT-IN: when omitted,
   *  nothing changes (full backward compatibility). When set, roles seed a `_roles`
   *  system table and injected access rules enforce per-collection / per-global op grants.
   *  Edit roles at runtime via `kernel.createRole/updateRole/deleteRole`; changes take
   *  effect immediately. An `admin: true` role (or the literal 'admin' role) gets full
   *  access. Explicit `collection.access[op]` rules always win over RBAC. */
  rbac?: RbacConfig
  /** Automatic multi-tenancy. OPT-IN: when omitted, nothing changes. When set, scoped
   *  collections gain a server-managed tenant column and an injected access scope so a
   *  principal only ever reads/writes its OWN tenant's rows — no per-collection boilerplate.
   *  The acting tenant is read from the trusted authenticated principal (`req.user.tenant`
   *  by default), never a client param. `overrideAccess` (migrations/admin tooling) bypasses
   *  tenancy. See {@link TenancyConfig}. */
  tenancy?: TenancyConfig
  /** Human approval inbox for agent-authored content. Provisions a `_reviews` system
   *  table and enables `findReviewQueue`/`submitReview`. Enabled by default when
   *  `agents` are configured (the inbox is for agent drafts); set `true` to force it
   *  on, `false` to force it off. When disabled, the review ops return empty / throw
   *  cleanly (like `findRoles` with RBAC off) — fully backward-compatible. */
  review?: boolean
  /** Editorial comments / annotations: threaded review feedback on documents (with an
   *  optional field-name anchor). Provisions a `_comments` system table and enables the
   *  comment ops (`addComment`/`listComments`/`resolveComment`/`deleteComment`) + the
   *  `/api/:collection/:id/comments` routes. OPT-IN, disabled by default — `true` turns it
   *  on. A caller can only comment on / see comments for a document they can READ; the
   *  author is recorded from the authenticated principal (never client input). */
  comments?: boolean
  /** Saved views / smart collections: named, reusable query presets (a stored
   *  `where` + `sort` + display `columns`) that editors save per collection and re-apply
   *  in one click — "Published this month", "My drafts", "Out of stock". Provisions a
   *  `_views` system table and enables the view ops (`saveView`/`listViews`/`applyView`/…)
   *  + the `/api/_admin/views` routes. OPT-IN, disabled by default — `true` turns it on.
   *  A view is owned by its creator (owner recorded from the principal, never client input)
   *  and visible only to its owner unless `shared`; a shared view is visible only to those
   *  who can READ its collection. Applying a view runs the NORMAL access-checked `find`, and
   *  the stored `where`/`sort` are re-validated on every save AND apply — so a saved view can
   *  only ever NARROW results within the caller's access, never bypass it. */
  views?: boolean
  /** Content releases: stage a coordinated set of draft documents and publish them as
   *  one unit, optionally on a schedule. Provisions `_releases` + `_release_items` system
   *  tables and enables the release ops (`createRelease`/`publishRelease`/…) + the
   *  `/api/_admin/releases` routes. OPT-IN, disabled by default — `true` turns it on.
   *  Publishing a release routes every member through the NORMAL per-doc publish gate
   *  (`assertCanPublish`: publish access + the agent draft-only brake + the eval gate),
   *  so a release can never bypass publish authorization. */
  releases?: boolean
  /** Content lifecycle: automatic expiry — the inverse of scheduled publish. Each listed
   *  collection declares a DATE field that holds when a document expires; a cron-driven
   *  drain (`kernel.processContentLifecycle`, wired into `kernel jobs:run` / `lifecycle:run`)
   *  retires every PUBLISHED doc whose expiry has passed by `unpublish` (default),
   *  `archive` (draft + a server-managed `_archived_at` stamp), or `delete`. OPT-IN and
   *  disabled by default — nothing changes when omitted. The drain runs under override (a
   *  TRUSTED system/cron op, like scheduled publish), is resilient per-doc + bounded, and
   *  only ever touches the configured collections. See {@link LifecycleConfig}. */
  lifecycle?: LifecycleConfig
  /** Content credentials (C2PA-style). When set, every publish signs a tamper-evident
   *  manifest of the document into the `_credentials` table; verify re-checks the
   *  signature + content hash. A shared HMAC `secret`, or an asymmetric key pair.
   *  Default OFF. Key material is server-only — never logged or returned. */
  signing?: SigningConfig
  /** Field-level encryption at rest. Provides the key that transparently encrypts every
   *  field marked `encrypted: true` (AES-256-GCM). Required when any field is encrypted.
   *  The key is server-only — never logged or returned. Rotating it makes existing
   *  ciphertext unreadable (a decrypt error), so treat it like a database credential. */
  encryption?: EncryptionConfig
  /** Pre-publish evals ("content CI"). Each rule runs on the to-be-published document;
   *  a `blocking` rule that returns an `error` finding rejects the publish. Built-in
   *  factories (`a11yEval`, `seoEval`, `policyEval`, `brandEval`) can be dropped in. */
  evals?: EvalRule[]
  /** AI-discoverability / GEO (Generative Engine Optimization) layer. When set,
   *  `kernel.llmsTxt`/`llmsFullTxt`/`contentChunks`/`geoDocument` and the public
   *  `GET /api/llms.txt`, `/api/llms-full.txt`, `/api/:collection/:id/geo`, and
   *  `/api/content-chunks` routes emit your PUBLISHED, publicly-readable content as
   *  llms.txt / clean markdown for AI answer engines. Generation runs through the real
   *  access pipeline as an ANONYMOUS principal, so drafts and access-restricted
   *  documents (and read-denied fields) can never appear. Omit to expose, by default,
   *  every collection that has a public read rule and a title field (never auth/upload
   *  /system collections). */
  discoverability?: DiscoverabilityConfig
  /** schema.org structured data (JSON-LD) generated from the typed content model. When
   *  set, `kernel.jsonLd`/`jsonLdScript` and the public `GET /api/:collection/:id/jsonld`
   *  route emit a document as a schema.org JSON-LD object so search engines and AI answer
   *  engines parse it with explicit semantics. Reads run through the real access pipeline
   *  (typically as an ANONYMOUS principal for public embedding), so drafts and access-
   *  restricted documents (and read-denied fields) can never appear. Each configured
   *  collection names a schema.org `type`; field → property mapping is either explicit or
   *  derived from sensible smart defaults. Omit to disable. */
  structuredData?: StructuredDataConfig
  /** Content templates: named, reusable document skeletons (default field values + a
   *  starting blocks layout). `kernel.createFromTemplate` instantiates one into a fully
   *  pre-filled document through the NORMAL access-checked `create` (access, field scope,
   *  validation, and the agent draft-only brake all apply — a template can never be a
   *  publish bypass). OPT-IN; omit to disable (no templates, the ops return empty / throw
   *  cleanly). See {@link ContentTemplateConfig}. */
  templates?: ContentTemplateConfig[]
}

/** Per-collection discoverability options. */
export interface DiscoverabilityCollectionConfig {
  slug: string
  /** Field used as the document title in output. Defaults to `admin.useAsTitle`,
   *  then a `title`/`name` field if present. */
  titleField?: string
  /** Field used for the one-line summary in llms.txt (falls back to a truncated body). */
  descriptionField?: string
  /** URL template for a document, e.g. `/blog/:slug`. `:field` tokens are replaced with
   *  the document's (safely-encoded) field values; `:id` resolves to the document id.
   *  Defaults to `/<slug>/:id`. Joined onto `baseUrl`. */
  urlPattern?: string
  /** Field whose rendered markdown is the document body (richText/text/textarea).
   *  Defaults to the first richText field, then the first textarea/text field. */
  bodyField?: string
  /** Explicitly include (`true`) or exclude (`false`) this collection. */
  include?: boolean
}

/** AI-discoverability / GEO config. See {@link KernelConfig.discoverability}. */
export interface DiscoverabilityConfig {
  /** Site/project title for the llms.txt `# heading`. Defaults to the admin title or 'KernelCMS'. */
  title?: string
  /** One-line description for the llms.txt `> blockquote`. */
  description?: string
  /** Absolute origin prepended to every document URL (e.g. `https://example.com`).
   *  Defaults to `config.serverURL`. Trusted config — never derived from documents. */
  baseUrl?: string
  /** Per-collection overrides. Collections not listed use sensible defaults; an entry
   *  with `include:false` is excluded even if it would otherwise qualify. */
  collections?: DiscoverabilityCollectionConfig[]
  /** Max documents emitted per collection (bounds output size → DoS guard). Default 1000. */
  maxDocsPerCollection?: number
  /** Max documents emitted across the whole corpus (llms-full.txt / chunks). Default 5000. */
  maxDocsTotal?: number
}

/** Resolved discoverability settings (after sanitize). `enabled` is false when the
 *  feature was not configured; the ops then throw a clean "not enabled" error. */
export interface SanitizedDiscoverability {
  enabled: boolean
  title?: string
  description?: string
  baseUrl?: string
  collections: DiscoverabilityCollectionConfig[]
  maxDocsPerCollection: number
  maxDocsTotal: number
}

export interface LlmsTxtOptions {
  /** Override the configured per-collection document cap for this call (clamped). */
  limit?: number
}

export interface ContentChunksOptions {
  /** Narrow to a single collection; omit to chunk every discoverable collection. */
  collection?: string
  /** Max chunks to return (clamped to the configured corpus cap). */
  limit?: number
}

/** A retrieval-ready content chunk for RAG / GEO ingestion. One per published doc. */
export interface ContentChunk {
  id: string
  collection: string
  title: string
  /** Absolute canonical URL (baseUrl + resolved urlPattern). */
  url: string
  /** The chunk text (clean markdown body, title-prefixed). */
  text: string
  /** Rough token estimate (~4 chars/token) for budgeting an ingestion pipeline. */
  tokensEstimate: number
  /** ISO last-updated timestamp, when the collection keeps timestamps. */
  updatedAt: string | null
  /** Provenance rollup (created/last-edited principals), when version history exists. */
  provenance?: {
    createdBy: PrincipalRef | null
    lastEditedBy: PrincipalRef | null
  }
}

export interface GeoDocumentOptions {
  collection: string
  id: string
}

// ---------------------------------------------------------------------------
// Structured data — schema.org JSON-LD generated from the typed content model
//
// A sibling of the discoverability layer: it emits a document as a schema.org
// JSON-LD object (and an embeddable `<script type="application/ld+json">`) so search
// engines AND AI answer engines parse the content with explicit semantics. Reads go
// through the SAME access-checked path as a normal read — a draft/private doc, or a
// read-denied field, is NEVER emitted. When embedded, doc-derived VALUES are HTML-
// escaped so content can never break out of the `<script>` tag (XSS guard).
// ---------------------------------------------------------------------------

/** Per-collection structured-data options. */
export interface StructuredDataCollectionConfig {
  slug: string
  /** A schema.org type, e.g. `'Article'`, `'Product'`, `'Person'`, `'BlogPosting'`,
   *  `'Organization'`. Required, non-empty. Trusted config (never doc-derived). */
  type: string
  /** Explicit schema.org property → field-name mapping. When set, it OVERRIDES the smart
   *  defaults: each entry maps a schema.org property (e.g. `headline`) to the document
   *  field whose value supplies it. Prototype-pollution keys are rejected at sanitize. */
  mapping?: Record<string, string>
  /** URL template for a document, e.g. `/blog/:slug`. `:field` tokens are replaced with
   *  the document's (safely-encoded) field values; `:id` resolves to the document id.
   *  Defaults to `/<slug>/:id`. Joined onto `baseUrl` to form the canonical `@id`. */
  urlPattern?: string
}

/** schema.org JSON-LD config. See {@link KernelConfig.structuredData}. */
export interface StructuredDataConfig {
  /** Absolute origin prepended to every document `@id` URL (e.g. `https://example.com`).
   *  Defaults to `config.serverURL`. Trusted config — never derived from documents. */
  baseUrl?: string
  /** Collections to emit JSON-LD for, each with its schema.org `type`. A collection not
   *  listed here yields no JSON-LD (opt-in: a schema.org type is required per collection). */
  collections?: StructuredDataCollectionConfig[]
}

/** Resolved structured-data settings (after sanitize). `enabled` is false when the
 *  feature was not configured; the ops then return null / `''` cleanly. */
export interface SanitizedStructuredData {
  enabled: boolean
  baseUrl: string
  collections: StructuredDataCollectionConfig[]
}

export interface JsonLdOptions {
  collection: string
  id: string
  req?: Partial<RequestContext>
  /** Trusted server call: read with access checks bypassed. Never set from an untrusted
   *  boundary — the REST route always passes the request principal (typically anonymous
   *  for public SEO embedding). */
  overrideAccess?: boolean
}

export interface JsonLdScriptOptions {
  collection: string
  id: string
  req?: Partial<RequestContext>
  overrideAccess?: boolean
}

export interface SanitizedLocalization {
  locales: string[]
  defaultLocale: string
  fallback: boolean
  /** Strict mode resolved from config (default false). See {@link LocalizationConfig.strict}. */
  strict: boolean
}

/** Sentinel `locale` value: read EVERY locale at once. Localized fields come back as
 *  their full `{ [locale]: value }` map instead of a single resolved value. */
export const ALL_LOCALES = 'all' as const

export interface SanitizedConfig {
  serverURL: string
  db: DatabaseAdapter
  collections: CollectionConfig[]
  globals: GlobalConfig[]
  localization: SanitizedLocalization | false
  /** Resolved audience segments. `enabled:false` when unconfigured. */
  audiences: SanitizedAudiences
  /** Resolved A/B experiments, keyed lookup via `experimentsBySlug`. Empty when unset. */
  experiments: SanitizedExperiment[]
  experimentsBySlug: Record<string, SanitizedExperiment>
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
  /** Validated autonomous workflows (see `workflows`). Empty when none configured. */
  workflows: WorkflowDefinition[]
  /** Registered custom HTTP endpoints. */
  endpoints?: EndpointConfig[]
  /** Registered OAuth providers. */
  oauth?: OAuthProvider[]
  /** Whether the admin shows the "Powered by KernelCMS" credit. */
  attribution: boolean
  /** Resolved cache adapter, when configured. */
  cache?: CacheAdapter
  /** Collection slugs with caching enabled. */
  cacheableSlugs: string[]
  /** Per-slug cache TTL (ms); falls back to the default for slugs not present. */
  cacheTtlBySlug: Record<string, number>
  /** Default cache TTL (ms). */
  cacheDefaultTtl: number
  /** Configured outbound webhooks (normalized: each has a unique slug + defaulted
   *  maxAttempts; the SSRF guard ran at load). Empty array when none configured. */
  webhooks: SanitizedWebhook[]
  /** Resolved real-time setting. `enabled` provisions the `_changes` outbox + change-feed
   *  hooks + the in-process bus; disabled by default (opt-in). */
  realtime: SanitizedRealtime
  /** Resolved edge content-delivery setting. `enabled` makes content GET responses carry
   *  cache tags + a cacheable `Cache-Control` (for anonymous public reads) and enables
   *  the purge feed; disabled by default (opt-in). */
  edge: SanitizedEdge
  /** Resolved content-analytics setting. `enabled` provisions the `_analytics` table and
   *  enables `track`/`insights`; `autoCapture` toggles search/assignVariant auto-emit.
   *  Disabled by default (opt-in). */
  analytics: SanitizedAnalytics
  /** Configured search adapter. */
  search?: SearchAdapter
  /** Per-collection searchable field names. */
  searchableFields: Record<string, string[]>
  /** Resolved embeddings provider, when configured (`config.embeddings`). */
  embeddings?: EmbeddingsConfig
  /** Resolved vector store adapter, when semantic search is active. */
  vector?: VectorAdapter
  /** Resolved AI-translation provider, when configured (`config.translation`). Requires
   *  `localization`; validated to a `translate` function at sanitize. */
  translation?: TranslationConfig
  /** Per-collection field names embedded for semantic search (subset of
   *  `searchableFields` whose collection set `search.semantic: true`). */
  semanticFields: Record<string, string[]>
  /** Validated non-human principals (see `agents`). The server resolves a bearer
   *  token against these to build an `overrideAccess:false`, field-scoped principal. */
  agents: AgentConfig[]
  /** Resolved audit-log setting. `enabled` provisions the `_audit` table and turns
   *  on recording; disabled by default (opt-in governance feature). */
  audit: { enabled: boolean }
  /** Whether granular RBAC is enabled (provisions the `_roles` table + injects access). */
  rbac: { enabled: boolean }
  /** Resolved agent-review setting. `enabled` provisions the `_reviews` table and the
   *  review queue/decision ops; defaults to on when `agents` are configured. */
  review: { enabled: boolean }
  /** Resolved editorial-comments setting. `enabled` provisions the `_comments` table and
   *  the comment ops; disabled by default (opt-in). */
  comments: { enabled: boolean }
  /** Resolved saved-views setting. `enabled` provisions the `_views` table and the view
   *  ops; disabled by default (opt-in). */
  views: { enabled: boolean }
  /** Resolved content-releases setting. `enabled` provisions the `_releases` +
   *  `_release_items` tables and the release ops; disabled by default (opt-in). */
  releases: { enabled: boolean }
  /** Resolved content-lifecycle setting. `enabled` activates the expiry drain and injects
   *  the server-managed `_archived_at` column on archive-action collections; disabled by
   *  default (opt-in), in which case the drain is a no-op. */
  lifecycle: SanitizedLifecycle
  /** The mutable runtime role store. Seeded from `config.rbac.roles`, merged from the
   *  `_roles` table at boot, and captured by reference by the injected access rules.
   *  Empty (`{ roles: {} }`) and unused when RBAC is disabled. */
  rbacStore: RbacStore
  /** Resolved multi-tenancy settings. `enabled` provisions a server-managed tenant column
   *  on each scoped collection and injects a per-tenant access scope; disabled by default
   *  (opt-in), in which case nothing is scoped. */
  tenancy: SanitizedTenancy
  /** Resolved content-credential signing material. `enabled:false` disables signing
   *  (no `_credentials` writes; verify reports no credential). Key material is
   *  server-only and never serialized into output. */
  signing: SanitizedSigningConfig
  /** Field-level encryption key (server-only), or undefined when no field is encrypted. */
  encryption?: EncryptionConfig
  /** Pre-publish eval rules, run at the publish chokepoint. Empty when unset. */
  evals: EvalRule[]
  /** Resolved AI-discoverability / GEO settings. `enabled:false` when unconfigured. */
  discoverability: SanitizedDiscoverability
  /** Resolved schema.org structured-data (JSON-LD) settings. `enabled:false` when
   *  unconfigured (the ops then return null / `''`). */
  structuredData: SanitizedStructuredData
  /** Resolved content templates (named document skeletons), each with deep-cloned + frozen
   *  `data`. Empty when none configured. */
  templates: SanitizedTemplate[]
  /** Slug index into {@link SanitizedConfig.templates} for O(1) lookup. */
  templatesBySlug: Record<string, SanitizedTemplate>
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
  /** Optimistic-concurrency token threaded through to the underlying update — reject the
   *  publish/unpublish if the document moved since the client last read it. See
   *  {@link UpdateOptions.expectedUpdatedAt}. */
  expectedUpdatedAt?: string
}

export interface SearchDocsOptions extends OperationBase {
  collection: string
  query: string
  /** Max documents to return (after access filtering). Default 25. */
  limit?: number
}

export interface SemanticSearchOptions extends OperationBase {
  collection: string
  query: string
  /** Max documents to return (after access filtering). Default 25. */
  limit?: number
  /** Exact-match scalar metadata pre-filter passed to the vector store. Keys are
   *  validated against the collection's fields (unknown / prototype-pollution keys
   *  are rejected) before the query. */
  filter?: Record<string, string | number | boolean | null>
}

export interface HybridSearchOptions extends OperationBase {
  collection: string
  query: string
  /** Max documents to return (after access filtering). Default 25. */
  limit?: number
}

export interface RelatedContentOptions extends OperationBase {
  collection: string
  /** The seed document. Its current content is re-embedded and the store is queried for
   *  the nearest neighbours; the seed itself is always excluded from the results. */
  id: string
  /** Max related documents to return (after access filtering + self-exclusion). Default 25. */
  limit?: number
  /** Exact-match scalar metadata pre-filter passed to the vector store. Keys are validated
   *  against the collection's fields (unknown / prototype-pollution keys are rejected). */
  filter?: Record<string, string | number | boolean | null>
}

export interface FindDuplicatesOptions extends OperationBase {
  collection: string
  /** Cosine-similarity threshold a pair must meet to count as a near-duplicate. Clamped to
   *  [0, 1]; default 0.9. Raising it toward 1 returns only ever-closer matches. */
  threshold?: number
  /** Max pairs to return, highest similarity first. Clamped to [1, 100]; default 100. */
  limit?: number
}

/** One near-duplicate pair: two readable document ids and their cosine similarity. */
export interface DuplicatePairResult {
  a: string
  b: string
  score: number
}

export interface ProcessScheduledOptions {
  /** "Now" reference for which scheduled publishes are due. Defaults to current time. */
  now?: string | Date | number
  limit?: number
}

// ---------------------------------------------------------------------------
// Content lifecycle — automatic expiry (the inverse of scheduled publish)
//
// A drafts/versioned collection declares a DATE field that holds when a document
// expires; a cron-driven drain (`processContentLifecycle`) retires every PUBLISHED
// doc whose expiry has passed by applying the configured `onExpire` action:
//   - 'unpublish' → set `_status:'draft'` (the inverse of publish)
//   - 'archive'   → set `_status:'draft'` AND stamp the server-managed `_archived_at`
//                   timestamp (hidden from public reads, AND distinguishable from a
//                   plain draft — an archived doc has a non-null `_archived_at`)
//   - 'delete'    → remove the document
// The drain runs under `overrideAccess:true` (a TRUSTED system/cron maintenance op,
// exactly like `processScheduledPublishes`); it is resilient per-doc, bounded by
// `limit`, and only ever touches the configured collections. The expiry date is set
// by an editor through NORMAL field access (you can only set the expiry on content
// you can already write); `_archived_at` is server-managed and field-locked (a client
// can never set or clear it via a normal write).
// ---------------------------------------------------------------------------

/** What happens to a PUBLISHED document when its expiry passes. */
export type OnExpireAction = 'unpublish' | 'archive' | 'delete'

/** One lifecycle-managed collection: the date field that holds the expiry, and the
 *  action to apply once it passes. */
export interface LifecycleCollectionConfig {
  /** The collection slug. Must be a real, drafts-enabled collection (the retire actions
   *  operate on the draft|published state machine). */
  slug: string
  /** The `date` field on the collection that holds when a document expires. Default
   *  `'expire_at'`. Must already be declared on the collection as a `date` field. */
  expireField?: string
  /** Action applied to a published doc once `expireField <= now`. Default `'unpublish'`. */
  onExpire?: OnExpireAction
}

/** Opt-in content lifecycle. When omitted, NOTHING changes (no `_archived_at` column,
 *  no drain behaviour). When set, each listed collection is validated (real, drafts-
 *  enabled, with the declared date field) and `processContentLifecycle` retires its
 *  expired published documents. See {@link KernelConfig.lifecycle}. */
export interface LifecycleConfig {
  collections: LifecycleCollectionConfig[]
}

/** One resolved lifecycle-managed collection (after sanitize) — fully defaulted. */
export interface SanitizedLifecycleCollection {
  slug: string
  expireField: string
  onExpire: OnExpireAction
}

/** Resolved content-lifecycle settings (after sanitize). `enabled:false` when
 *  unconfigured (no `_archived_at` columns, the drain is a no-op). */
export interface SanitizedLifecycle {
  enabled: boolean
  collections: SanitizedLifecycleCollection[]
  /** Slugs that take the `archive` action — these get a server-managed `_archived_at`
   *  column injected by the schema. */
  archiveSlugs: string[]
}

export interface ProcessContentLifecycleOptions {
  /** "Now" reference for which documents have expired. Defaults to the current time. */
  now?: string | Date | number
  /** Max documents to retire per collection in one drain. Default 1000; clamped. */
  limit?: number
}

/** One retired document in a {@link ProcessContentLifecycleResult}. */
export interface ContentLifecycleAction {
  collection: string
  id: string
  action: OnExpireAction
}

export interface ProcessContentLifecycleResult {
  /** Every document that was retired this drain, with the action applied. */
  processed: ContentLifecycleAction[]
}

export interface ProcessScheduledResult {
  /** IDs of documents that successfully transitioned to published. */
  published: string[]
  /** Documents that were due but NOT published because a blocking pre-publish eval
   *  rejected them. They remain drafts; the loop continued past them. Present only
   *  when at least one due doc was skipped. */
  skipped?: Array<{ id: string; collection: string; reason: string }>
}

export interface FindOptions extends OperationBase {
  collection: string
  where?: Where
  sort?: string | string[]
  limit?: number
  page?: number
  /** Time-machine read: an ISO timestamp. When set, each matched document is returned
   *  as it existed at that instant — its latest version snapshot with `createdAt <= asOf`.
   *  Documents not yet created at `asOf` are excluded. Requires `versions` enabled on the
   *  collection (else a BadRequestError). Access-checked + field-stripped per doc, exactly
   *  like a live read — the time-machine never widens visibility. */
  asOf?: string
}

export interface FindByIDOptions extends OperationBase {
  collection: string
  id: string
  /** Time-machine read: an ISO timestamp. When set, the document is reconstructed from
   *  its latest version snapshot with `createdAt <= asOf` (null if it did not yet exist).
   *  Requires `versions` enabled (else a BadRequestError). Access read-check + field
   *  stripping apply to the reconstructed doc, exactly like a live read. */
  asOf?: string
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

export interface SignedAssetUrlOptions extends OperationBase {
  collection: string
  /** The upload document whose file to link. The caller must be able to READ it. */
  id: string
  /** Link lifetime in seconds (clamped 1 .. 7 days; default 1 hour). */
  ttl?: number
}

export interface UpdateOptions extends OperationBase {
  collection: string
  id: string
  data: Row
  /** Mark this save as an autosave: the version snapshot is flagged `autosave`
   *  (drafts collections), so the UI can distinguish auto-saved drafts from manual ones. */
  autosave?: boolean
  /** Optimistic-concurrency token: the `updatedAt` the client last read for this
   *  document. When provided, the update is REJECTED with a {@link ConflictError} if the
   *  server's current `updatedAt` no longer matches (another writer got there first) —
   *  no write happens. Omit for last-write-wins (the default, backward-compatible).
   *  Checked AFTER access control, so it can't be used to probe documents you can't read. */
  expectedUpdatedAt?: string
}

/** Write several locales of one document in a single call. Each entry in `locales`
 *  is a partial document for that locale; localized fields are merged into the stored
 *  per-locale maps (untouched locales are preserved, never clobbered). Every locale
 *  goes through the normal access + validation pipeline — no override widening. */
export interface UpdateLocalesOptions extends OperationBase {
  collection: string
  id: string
  /** Per-locale partials, keyed by locale code. Keys must be configured locales;
   *  unknown codes and prototype-pollution keys are rejected. */
  locales: Record<string, Row>
  /** Optimistic-concurrency token: the `updatedAt` the client last read. Checked on the
   *  FIRST locale write (before any locale is applied); a conflict aborts the whole call
   *  before anything is persisted. See {@link UpdateOptions.expectedUpdatedAt}. */
  expectedUpdatedAt?: string
}

/** Per-locale completeness for one document. */
export interface LocaleStatus {
  /** All required localized fields have a value in this locale. */
  complete: boolean
  /** Required localized field names with no value in this locale. */
  missingRequired: string[]
  /** How many localized fields have a value in this locale. */
  filled: number
  /** Total number of localized fields on the collection. */
  totalLocalized: number
}

/** `translationStatus` result: completeness keyed by locale code. */
export type TranslationStatus = Record<string, LocaleStatus>

export interface TranslationStatusOptions extends OperationBase {
  collection: string
  id: string
}

/** One row in the translation dashboard: a document with its per-locale status. */
export interface TranslationStatusItem {
  id: string
  status: TranslationStatus
  completeLocales: string[]
  incompleteLocales: string[]
}

export interface TranslationStatusListOptions extends OperationBase {
  collection: string
  where?: Where
  limit?: number
  page?: number
}

/** Auto-translate one document's localized fields from a source locale into a target
 *  locale via the configured provider, writing the results through the normal
 *  access-checked update (merge — other locales preserved). See {@link Kernel.translateDocument}. */
export interface TranslateDocumentOptions extends OperationBase {
  collection: string
  id: string
  /** Source locale to read field values FROM (a configured locale). */
  from: string
  /** Target locale to write translations INTO (a configured locale, ≠ `from`). */
  to: string
  /** Restrict to these localized field names; omit to consider every localized field. */
  fields?: string[]
  /** Replace an existing `to` value too. Default false: only MISSING translations are filled. */
  overwrite?: boolean
}

/** Batch-fill a collection's missing `to`-locale translations from a source locale. See
 *  {@link Kernel.translateMissing}. */
export interface TranslateMissingOptions extends OperationBase {
  collection: string
  /** Target locale to fill (a configured locale). */
  to: string
  /** Source locale to translate from. Defaults to the configured default locale. */
  from?: string
  /** Restrict to these localized field names; omit to consider every localized field. */
  fields?: string[]
  /** Max documents to translate in this call (bounded). Default 50. */
  limit?: number
}

/** Result of {@link Kernel.translateMissing}: which document ids were translated vs skipped. */
export interface TranslateMissingResult {
  /** Ids of documents that had their `to` locale filled. */
  translated: string[]
  /** Ids of documents that were skipped (already complete, no source text, or not writable). */
  skipped: string[]
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
  /** Filter the history by the principal kind that authored each snapshot, e.g.
   *  `'agent'` to review only agent-made changes. Omit for all. */
  createdByType?: 'user' | 'agent'
}

export interface RestoreVersionOptions extends OperationBase {
  collection: string
  id: string
  versionId: string
}

// ---------------------------------------------------------------------------
// Content time-machine — navigate the version history of one document
//
// A read-only timeline over the version snapshots (plus a write-through restore).
// Every surface goes through the SAME access read-check + field stripping as a live
// read: a caller who cannot read the current document cannot read its history, diff,
// or as-of state either, and a read-denied field never surfaces in any output. Requires
// `versions` enabled on the collection (else a BadRequestError).
// ---------------------------------------------------------------------------

/** One entry in a document's change timeline (oldest → newest). */
export interface HistoryEntry {
  /** The version snapshot id this entry corresponds to. */
  versionId: string
  /** ISO timestamp the snapshot was recorded. */
  at: string
  /** Principal id that authored the snapshot (null when unknown). */
  by: string | null
  /** Principal kind that authored the snapshot. */
  byType: 'user' | 'agent' | 'system'
  /** The snapshot's content status. */
  status: string
  /** Whether the snapshot came from an autosave. */
  autosave: boolean
  /** Field names that differ from the PREVIOUS snapshot (all fields for the create
   *  entry). Read-denied fields are excluded — their change is never revealed. */
  changedFields: string[]
}

export interface HistoryOptions extends OperationBase {
  collection: string
  id: string
}

export interface DiffVersionsOptions extends OperationBase {
  collection: string
  id: string
  /** A versionId OR an ISO timestamp (resolved to the snapshot with `createdAt <= it`). */
  from: string
  /** A versionId OR an ISO timestamp (resolved to the snapshot with `createdAt <= it`). */
  to: string
}

/** Field-level diff: each changed field maps to its before/after values. Only fields the
 *  caller may read appear. */
export type VersionDiff = Record<string, { from: unknown; to: unknown }>

export interface RestoreAsOfOptions extends OperationBase {
  collection: string
  id: string
  /** ISO timestamp: restore the document to its state at this instant. */
  asOf: string
}

/** A recorded mutating/auth event in the append-only audit log. */
export type AuditAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'publish'
  | 'unpublish'
  | 'login'
  | 'login_failed'
  | 'role.create'
  | 'role.update'
  | 'role.delete'
  | 'review.approve'
  | 'review.request_changes'
  | 'release.publish'
  | 'release.schedule'
  | 'release.cancel'
  | 'workflow.completed'
  | 'workflow.failed'
  | 'workflow.awaiting_review'
  | 'experiment.assign'
  | 'content.expire'
  | 'comment.create'
  | 'comment.resolve'
  | 'comment.delete'
  | 'view.create'
  | 'view.update'
  | 'view.delete'
  | 'webhook.deliver'
  | 'webhook.fail'

/** A single audit-log row as returned by `findAuditLog`. */
export interface AuditDoc extends Row {
  id: string
  /** ISO timestamp the event was recorded. */
  at: string
  action: AuditAction
  collection: string | null
  documentId: string | null
  principalId: string | null
  principalType: 'user' | 'agent' | 'system'
  /** Field names written/changed (create/update); null otherwise. */
  fields: string[] | null
  /** Optional extra context (e.g. login email). */
  meta: Record<string, unknown> | null
}

export interface FindAuditLogOptions {
  where?: Where
  limit?: number
  page?: number
  /** Sort spec(s); defaults to newest-first (`at` descending). */
  sort?: string | string[]
}

// ---------------------------------------------------------------------------
// Agent review inbox
//
// The human approval layer over agent-authored content. Agents are already
// draft-only + attributed (`createdByType:'agent'`); the review queue is DERIVED
// ("agent-authored drafts not yet approved") and decisions are persisted in a
// `_reviews` system table — mirroring the audit/roles pattern, NOT a new value on
// the draft|published `_status` state machine.
// ---------------------------------------------------------------------------

/** A reviewer's decision, as persisted in `_reviews`. */
export type ReviewDecision = 'approved' | 'changes_requested'

/** A single persisted review decision row from the `_reviews` table. */
export interface ReviewDoc extends Row {
  id: string
  /** ISO timestamp the decision was recorded. */
  at: string
  collection: string
  documentId: string
  decision: ReviewDecision
  reviewerId: string | null
  reviewerType: 'user' | 'agent' | 'system'
  /** Optional reviewer note (used on `changes_requested`). */
  note: string | null
}

/** One pending item in the agent review queue: an agent-authored draft awaiting
 *  a human decision, with its latest review (if any) for context. */
export interface ReviewQueueItem {
  collection: string
  id: string
  /** The current draft document. */
  doc: Doc
  /** The principal id that authored the document (`createdBy`). */
  createdBy: string | null
  /** Last write time of the draft (drives the "revised after changes_requested" re-queue). */
  updatedAt: string | null
  /** True when the agent revised the draft after the most recent `changes_requested`
   *  — i.e. it is freshly actionable for the reviewer (vs. awaiting the agent). */
  revisedSince?: boolean
  /** The most recent review decision on this document, when one exists. */
  lastReview?: {
    decision: ReviewDecision
    note: string | null
    at: string
    reviewerId: string | null
  }
}

export interface FindReviewQueueOptions {
  /** Narrow to a single collection. Omit to scan every draft-enabled collection. */
  collection?: string
  limit?: number
  page?: number
  /** The reviewer request context — its read access scopes which drafts are listed. */
  req?: Partial<RequestContext>
}

export interface SubmitReviewOptions {
  collection: string
  id: string
  /** `approve` publishes (reusing the publish access gate); `request_changes` keeps
   *  the doc a draft and records the note. */
  decision: 'approve' | 'request_changes'
  /** Reviewer note, surfaced back to the agent (recorded on `request_changes`). */
  note?: string
  /** The reviewer request context — drives the publish access gate on approve and
   *  attributes the decision. Identity comes from the server `user`, never the client. */
  req?: Partial<RequestContext>
}

export interface SubmitReviewResult {
  decision: ReviewDecision
  documentId: string
}

// ---------------------------------------------------------------------------
// Editorial comments / annotations
//
// Threaded review feedback on content documents, with an optional field-name anchor.
// Persisted in a `_comments` system table — never on the document itself, and never
// reachable via generic CRUD (like `_audit`). Access is gated by the target DOCUMENT's
// read access: you can only comment on / see comments for a document you can READ, so a
// comment can't leak content (body/author/existence) a caller could not otherwise see.
// The author is recorded from the authenticated principal, never from client input.
// ---------------------------------------------------------------------------

/** A single persisted comment row from the `_comments` table. */
export interface CommentDoc extends Row {
  id: string
  collection: string
  documentId: string
  /** Optional field-name anchor (a real field of the collection), or null for a
   *  document-level comment. */
  field: string | null
  /** Parent comment id for a threaded reply (same document only), or null for a root. */
  parentId: string | null
  body: string
  /** The author's principal id, recorded from the authenticated principal (never client
   *  input). Null only for a (trusted) system-authored comment. */
  authorId: string | null
  authorType: 'user' | 'agent' | 'system'
  resolved: boolean
  createdAt: string
  updatedAt: string
}

export interface AddCommentOptions {
  collection: string
  /** The target document id — the caller must be able to READ it. */
  id: string
  /** The comment text (required, trimmed, length-bounded). */
  body: string
  /** Optional field-name anchor; validated to be a real field of the collection. */
  field?: string
  /** Optional parent comment id for a threaded reply; validated to belong to the SAME
   *  document (no cross-document/cross-collection threading). */
  parentId?: string
  /** Request context — its principal authors the comment and gates document read access.
   *  The author identity comes from the server `user`, NEVER the client body. */
  req?: Partial<RequestContext>
  /** Trusted server call: skip the document-read gate and record a system-authored comment.
   *  Never set from an untrusted boundary — the REST route always passes the principal. */
  overrideAccess?: boolean
}

export interface ListCommentsOptions {
  collection: string
  /** The target document id — the caller must be able to READ it (else Forbidden/empty). */
  id: string
  /** Narrow to comments anchored to a specific field. */
  field?: string
  /** Include resolved comments (default false — resolved are hidden). */
  includeResolved?: boolean
  req?: Partial<RequestContext>
  overrideAccess?: boolean
}

export interface ResolveCommentOptions {
  commentId: string
  /** Mark resolved (default true) or unresolved (false). */
  resolved?: boolean
  req?: Partial<RequestContext>
  overrideAccess?: boolean
}

export interface DeleteCommentOptions {
  commentId: string
  req?: Partial<RequestContext>
  overrideAccess?: boolean
}

export interface CommentCountOptions {
  collection: string
  id: string
  /** Include resolved comments in the count (default false). */
  includeResolved?: boolean
  req?: Partial<RequestContext>
  overrideAccess?: boolean
}

// ---------------------------------------------------------------------------
// Saved views / smart collections
//
// A saved view is a named query preset — a stored `where` + `sort` + display `columns`
// for one collection — that an editor saves and re-applies in one click. It is owned by
// its creator and private unless `shared`. Applying a view runs the NORMAL access-checked
// `find`, and the stored `where`/`sort` are re-validated on save AND apply, so a view can
// only narrow results within the caller's access — never widen or bypass it.
// ---------------------------------------------------------------------------

export interface ViewDoc extends Row {
  id: string
  collection: string
  name: string
  /** The saved filter, or null for "all". Re-validated against the collection on apply. */
  where: Where | null
  /** The saved sort (a field name or `-field` list), or null for the default order. */
  sort: string | string[] | null
  /** Display column hints for the admin table, or null. Not security-bearing. */
  columns: string[] | null
  /** The principal id that owns the view — recorded from the authenticated principal,
   *  never client input. Only the owner (or an admin) can update/delete it. */
  ownerId: string | null
  /** When true, the view is visible to anyone who can READ its collection; otherwise it
   *  is private to its owner. */
  shared: boolean
  createdAt: string
  updatedAt: string
}

export interface SaveViewOptions {
  collection: string
  /** The view's display name (required, trimmed, length-bounded). */
  name: string
  /** The filter to store — validated against the collection's filterable fields. */
  where?: Where
  /** The sort to store — a field name or `-field`, or a list. Fields are validated. */
  sort?: string | string[]
  /** Display column hints for the admin table. */
  columns?: string[]
  /** Share the view with everyone who can read the collection (default false: private). */
  shared?: boolean
  /** Request context — its principal owns the view and gates collection read access. */
  req?: Partial<RequestContext>
  overrideAccess?: boolean
}

export interface ListViewsOptions {
  /** Narrow to views for a single collection (else every readable view). */
  collection?: string
  req?: Partial<RequestContext>
  overrideAccess?: boolean
}

export interface GetViewOptions {
  viewId: string
  req?: Partial<RequestContext>
  overrideAccess?: boolean
}

export interface UpdateViewOptions {
  viewId: string
  /** Any subset of the view's editable fields. Owner (or admin) only. */
  name?: string
  where?: Where | null
  sort?: string | string[] | null
  columns?: string[] | null
  shared?: boolean
  req?: Partial<RequestContext>
  overrideAccess?: boolean
}

export interface DeleteViewOptions {
  viewId: string
  req?: Partial<RequestContext>
  overrideAccess?: boolean
}

export interface ApplyViewOptions {
  viewId: string
  /** An extra filter AND-combined with the view's stored `where` (further narrows). */
  where?: Where
  /** Override the stored sort for this application only. */
  sort?: string | string[]
  /** Include drafts (passed through to the underlying access-checked `find`). */
  draft?: boolean
  limit?: number
  page?: number
  req?: Partial<RequestContext>
  overrideAccess?: boolean
}

// ---------------------------------------------------------------------------
// Content releases
//
// A release is a NAMED bundle of draft documents that go live together, atomically,
// optionally on a schedule. It layers over the existing drafts + publish + scheduled-
// publish system: publishing a release publishes each member through the normal per-doc
// publish op (so `assertCanPublish` — publish access + the agent draft-only brake + the
// eval gate — applies to every member; a release can never bypass publish authorization).
// ---------------------------------------------------------------------------

/** Lifecycle of a release. `open` → editable + publishable; `scheduled` → awaiting its
 *  drain; `published` → all members went live; `failed` → a mid-publish error left it
 *  partially applied (reported, never silently retried). */
export type ReleaseStatus = 'open' | 'scheduled' | 'published' | 'failed'

/** A persisted release row from the `_releases` table. */
export interface Release {
  id: string
  name: string
  status: ReleaseStatus
  /** ISO timestamp the release is scheduled to publish (null unless `status:'scheduled'`). */
  scheduledAt: string | null
  /** Principal id that created the release. */
  createdBy: string | null
  createdByType: 'user' | 'agent' | 'system'
  createdAt: string
  /** ISO timestamp the release went live (null until published). */
  publishedAt: string | null
}

/** A single member of a release: a (collection, documentId) reference. */
export interface ReleaseItem {
  id: string
  release: string
  collection: string
  documentId: string
}

/** A release together with its member references (the `getRelease` shape). */
export interface ReleaseWithItems extends Release {
  items: ReleaseItem[]
}

export interface CreateReleaseOptions {
  /** Human-readable release name (untrusted; length-bounded, no prototype keys). */
  name: string
  req?: Partial<RequestContext>
  overrideAccess?: boolean
}

export interface ReleaseMemberOptions {
  /** The release id. */
  release: string
  /** The member's collection slug (must be a real, non-system, drafts-enabled collection). */
  collection: string
  /** The member document's id. */
  id: string
  req?: Partial<RequestContext>
  overrideAccess?: boolean
}

export interface GetReleaseOptions {
  release: string
  req?: Partial<RequestContext>
  overrideAccess?: boolean
}

export interface ListReleasesOptions {
  /** Narrow to a single lifecycle status. */
  status?: ReleaseStatus
  limit?: number
  page?: number
  req?: Partial<RequestContext>
  overrideAccess?: boolean
}

/** One member as it CURRENTLY looks (draft state), for the pre-publish preview. */
export interface ReleasePreviewItem {
  collection: string
  id: string
  doc: Doc
}

export interface PreviewReleaseResult {
  items: ReleasePreviewItem[]
}

export interface PublishReleaseOptions {
  release: string
  req?: Partial<RequestContext>
  overrideAccess?: boolean
}

export interface PublishReleaseResult {
  status: ReleaseStatus
  /** `${collection}/${id}` of every member that went live. */
  published: string[]
  /** Members that could not be published, with a reason. On a failed pre-flight NONE
   *  are published (all-or-nothing); on a mid-publish DB error this lists the ones that
   *  failed after some succeeded (best-effort atomic). */
  failed: Array<{ collection: string; id: string; reason: string }>
}

export interface ScheduleReleaseOptions {
  release: string
  /** When the release should publish (ISO string, Date, or epoch ms). Must be in the future. */
  at: string | Date | number
  req?: Partial<RequestContext>
  overrideAccess?: boolean
}

export interface CancelReleaseOptions {
  release: string
  req?: Partial<RequestContext>
  overrideAccess?: boolean
}

export interface ProcessScheduledReleasesOptions {
  /** "Now" reference for which scheduled releases are due. Defaults to the current time. */
  now?: string | Date | number
  limit?: number
}

export interface ProcessScheduledReleasesResult {
  /** Release ids that published successfully when their schedule came due. */
  published: string[]
  /** Releases that were due but could not fully publish, with a reason. */
  failed?: Array<{ release: string; reason: string }>
}

/** A block to assemble into a `blocks` layout via {@link Kernel.composePage}. */
export interface ComposeBlock {
  /** Must match a `BlockDef.slug` available on the target blocks field. */
  type: string
  /** Field values for the block; every key must be a field of that block. */
  data: Record<string, unknown>
}

export interface ComposePageOptions {
  collection: string
  /** The `blocks`-type field to assemble into. Defaults to the collection's single
   *  blocks field (errors when ambiguous or absent). */
  field?: string
  blocks: ComposeBlock[]
  /** Other top-level fields to set on the created document. */
  data?: Record<string, unknown>
  req?: Partial<RequestContext>
}

// ---------------------------------------------------------------------------
// Content templates — named, reusable document skeletons
//
// A template is TRUSTED config: a named set of default field values (which may include a
// blocks `layout`, default text, a default `_status`, …) plus the target collection. A
// `createFromTemplate` merges the template's defaults with the caller's (untrusted)
// overrides and creates the document through the NORMAL access-checked `create` — so
// access, field scope, validation, and the agent draft-only brake all still apply. A
// template is editorial productivity ("New from template"), never a privilege bypass.
// ---------------------------------------------------------------------------

/** One content template (config). `slug` is unique snake_case; `collection` must be a real,
 *  non-system collection; `data` are the default field values for a new document (deep-cloned
 *  + frozen at sanitize, with no prototype-pollution keys). */
export interface ContentTemplateConfig {
  slug: string
  collection: string
  name?: string
  description?: string
  /** Default field values for a new document. May include a blocks `layout`, default
   *  text, `_status`, etc. Plain object only; copied keys must be pollution-free. */
  data: Record<string, unknown>
}

/** Resolved content template (after sanitize): `data` is deep-cloned + frozen. */
export interface SanitizedTemplate {
  slug: string
  collection: string
  name?: string
  description?: string
  data: Record<string, unknown>
}

/** Template metadata as returned by {@link Kernel.listTemplates} (no raw `data`). */
export interface TemplateSummary {
  slug: string
  collection: string
  name?: string
  description?: string
}

export interface ListTemplatesOptions {
  /** Filter to templates that create into this collection. */
  collection?: string
  req?: Partial<RequestContext>
}

export interface CreateFromTemplateOptions extends OperationBase {
  /** The template slug to instantiate (looked up by slug; unknown → clean error). */
  template: string
  /** Caller overrides merged OVER the template defaults (caller wins; deep-merge for
   *  nested objects). Untrusted: prototype-pollution-guarded, and still subject to the
   *  normal create field access + validation. */
  data?: Record<string, unknown>
}

export interface VersionDoc extends Row {
  id: string
  parent: string
  version: Row
  status: string
  autosave: boolean
}

// ---------------------------------------------------------------------------
// AI-era trust: provenance, content credentials, pre-publish evals
//
// Three capabilities layered on the existing version snapshots (which already
// attribute every version to a principal id + kind). Provenance is DERIVED from
// those snapshots; content credentials sign a manifest of the published doc on
// publish and detect tampering on verify; evals are a pre-publish quality gate
// ("content CI"). All are opt-in (signing/evals via config; provenance is read-only).
// ---------------------------------------------------------------------------

/** A principal reference on a provenance chain / manifest — who, and what kind. */
export interface PrincipalRef {
  id: string | null
  type: 'user' | 'agent' | 'system'
}

/** One link in a document's provenance chain — a version snapshot's who/what/how. */
export interface ProvenanceEntry {
  /** 1-based ordinal (oldest version is 1). */
  version: number
  status: string
  /** ISO timestamp the version was recorded. */
  at: string
  /** The principal that authored this version. */
  author: PrincipalRef
  /** The approver, when this version is a review-approved publish. */
  approver?: PrincipalRef
  /** Whether the version came from an autosave (not an explicit save). */
  autosave: boolean
}

/** The full provenance of a document: its version chain plus convenience rollups. */
export interface Provenance {
  documentId: string
  collection: string
  /** Oldest-first chain of version snapshots. */
  chain: ProvenanceEntry[]
  /** The principal that created the document (first version's author). */
  createdBy: PrincipalRef | null
  /** The principal that authored the most recent version. */
  lastEditedBy: PrincipalRef | null
  /** Every distinct principal that authored at least one version (human + agent). */
  contributors: PrincipalRef[]
}

export interface ProvenanceOptions {
  collection: string
  id: string
  req?: Partial<RequestContext>
  overrideAccess?: boolean
}

/** The signing configuration: a shared HMAC secret, OR an asymmetric key pair. Default
 *  OFF (omit to disable content credentials). Key material is server-only and never
 *  appears in any manifest, credential, error, or log. */
export type SigningConfig = { secret: string } | { privateKey: string; publicKey: string; algorithm?: 'ed25519' }

/** Field-level encryption configuration. `key` is any sufficiently-random secret (a 256-bit
 *  AES key is derived from it via SHA-256); read it from env, never hardcode. */
export interface EncryptionConfig {
  key: string
}

/** Resolved signing material — the enabled flag plus the key material + algorithm. */
export interface SanitizedSigningConfig {
  enabled: boolean
  algorithm: 'hmac-sha256' | 'ed25519'
  secret?: string
  privateKey?: string
  publicKey?: string
}

/** The signed claim set embedded in a content credential. Never holds key material. */
export interface ContentManifest {
  collection: string
  documentId: string
  /** `sha256(canonicalJSON(published doc, system/volatile keys excluded))`, hex. */
  contentHash: string
  author: PrincipalRef
  approver: PrincipalRef | null
  publishedAt: string
  versionId: string | null
}

/** A persisted content-credential row (the `_credentials` table). */
export interface CredentialDoc extends Row {
  id: string
  collection: string
  documentId: string
  versionId: string | null
  manifest: ContentManifest
  signature: string
  algorithm: 'hmac-sha256' | 'ed25519'
  /** ISO timestamp the credential was signed. */
  signedAt: string
}

export interface GetCredentialOptions {
  collection: string
  id: string
  req?: Partial<RequestContext>
  overrideAccess?: boolean
}

export interface VerifyCredentialOptions {
  collection: string
  id: string
  req?: Partial<RequestContext>
  overrideAccess?: boolean
}

/** The result of re-verifying a content credential against the live document. */
export interface VerifyCredentialResult {
  valid: boolean
  /** Present when `valid` is false: why (bad signature / tampered content / no credential). */
  reason?: string
  /** The signed manifest (when a credential exists). */
  manifest: ContentManifest | null
}

/** A single finding from a pre-publish eval. */
export interface EvalFinding {
  ok: boolean
  severity: 'error' | 'warn' | 'info'
  message: string
  /** Optional field the finding pertains to. */
  field?: string
}

/** Arguments an eval rule's `run` receives. `fields` is the collection's schema field
 *  list (wired automatically) so a rule can locate richText/upload fields. */
export interface EvalArgs<TUser extends AuthUser = AuthUser> {
  doc: Record<string, unknown>
  collection: string
  req: RequestContext<TUser>
  /** The collection's configured fields (for schema-aware rules). */
  fields?: ConfigField[]
}

/** A pre-publish eval rule. Runs on the to-be-published document at the publish
 *  chokepoint. A `blocking` rule (the default) that returns an `ok:false` `error`
 *  finding REJECTS the publish; warn/info findings are recorded but never block. */
export interface EvalRule {
  name: string
  /** Whether an `error` finding blocks the publish. Defaults to `true`. */
  blocking?: boolean
  /** Collection slugs this rule applies to. Omit to apply to every collection. */
  appliesTo?: string[]
  run(args: EvalArgs): EvalFinding[] | Promise<EvalFinding[]>
}

// ---------------------------------------------------------------------------
// Collaboration: advisory soft locks + lightweight presence
//
// Two LIGHTWEIGHT, DB-backed primitives that answer "two editors (or an agent and a
// human) are on the same document" — NOT a real-time CRDT. Locks are ADVISORY: they
// signal intent and never gate writes (access control is untouched). Presence is an
// active-set heartbeat filtered by a TTL. Both accept an injected `now` (ms epoch) so
// expiry is deterministic under test; production omits it and uses `Date.now()`.
// ---------------------------------------------------------------------------

/** An advisory soft lock held on a document, as stored in `_locks` and returned by the
 *  lock ops. The id is `${collection}:${documentId}`, so a document has at most one. */
export interface LockDoc extends Row {
  id: string
  collection: string
  documentId: string
  /** The principal that holds the lock (its `req.user.id`, or 'anonymous'). */
  principalId: string
  principalType: 'user' | 'agent' | 'system'
  /** ISO timestamp the lock was (most recently) acquired/refreshed. */
  acquiredAt: string
  /** ISO timestamp the lock expires; a lock with `expiresAt <= now` is free to take. */
  expiresAt: string
  /** Optional human label (e.g. the holder's name) for the "locked by …" UI. */
  label?: string | null
}

export interface AcquireLockOptions {
  collection: string
  id: string
  req?: Partial<RequestContext>
  /** Lock lifetime in ms from acquisition. Default 120_000 (2 min). */
  ttlMs?: number
  /** Optional human label shown to others (e.g. the holder's display name). */
  label?: string
  /** "Now" as a ms epoch, for deterministic expiry in tests. Default `Date.now()`. */
  now?: number
}

export interface AcquireLockResult {
  /** The current lock row (yours on acquire/refresh, or the OTHER principal's on a miss). */
  lock: LockDoc
  /** Whether YOU hold the lock now (`'you'`) or a different principal does (`'other'`). */
  heldBy: 'you' | 'other'
}

export interface ReleaseLockOptions {
  collection: string
  id: string
  req?: Partial<RequestContext>
  now?: number
}

export interface ReleaseLockResult {
  /** True when a lock row was removed; false when there was nothing to release. */
  released: boolean
}

export interface GetLockOptions {
  collection: string
  id: string
  /** Caller context — used to access-check READ on the target so a principal who can't
   *  read the document can't probe who is editing it. */
  req?: Partial<RequestContext>
  now?: number
}

export interface ListLocksOptions {
  /** Narrow to one collection; omit to list every unexpired lock. */
  collection?: string
  /** Caller context — locks on documents the caller can't READ are filtered out. Omit (or
   *  call with `overrideAccess`/no user) for a trusted server call that sees every lock. */
  req?: Partial<RequestContext>
  now?: number
}

/** What a principal is doing on a document, for presence. */
export type PresenceKind = 'viewing' | 'editing'

export interface HeartbeatOptions {
  collection: string
  id: string
  kind: PresenceKind
  req?: Partial<RequestContext>
  now?: number
}

/** One active participant on a document. */
export interface PresenceEntry {
  principalId: string
  principalType: 'user' | 'agent' | 'system'
  kind: PresenceKind
  /** ISO timestamp of the participant's most recent heartbeat. */
  lastSeen: string
}

export interface GetPresenceOptions {
  collection: string
  id: string
  /** Caller context — used to access-check READ on the target so a principal who can't
   *  read the document can't see who is present on it. */
  req?: Partial<RequestContext>
  /** Liveness window in ms: a participant whose `lastSeen` is older than this is stale
   *  and excluded from the active set. Default 30_000 (30s). */
  ttlMs?: number
  now?: number
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

// ---------------------------------------------------------------------------
// Migration: dry-run, rollback, backfill
// ---------------------------------------------------------------------------

export interface MigrateRunOptions {
  /** Compute the migration (the exact statements + report) without executing anything.
   *  The database is left completely untouched — preview the SQL before applying it. */
  dryRun?: boolean
}

export interface RollbackOptions {
  /** How many recorded migrations to undo, newest-first. Default 1. */
  steps?: number
  /** Show the inverse SQL (DROP statements) WITHOUT executing it or consuming the
   *  journal rows. Use it to preview a rollback before committing to it. */
  dryRun?: boolean
}

export interface RollbackResult {
  /** Journal entry ids that were (or would be) reverted, newest-first. */
  reverted: string[]
  /** The exact inverse statements run (or that would run on a dry run). */
  statements: string[]
}

export interface BackfillOptions<T extends Doc = Doc> extends OperationBase {
  /** Collection slug whose rows are backfilled. */
  collection: string
  /** The field to populate. Must be a real, storage-bearing field of the collection;
   *  system/internal columns are rejected. */
  field: string
  /** A constant value to set on every matched row. Mutually exclusive with `set`. */
  value?: unknown
  /** Compute the value per document (overrides `value`). Receives the current doc. */
  set?: (doc: T) => unknown
  /** Restrict which rows are backfilled. Omit to backfill the whole collection. */
  where?: Where
  /** Rows updated per batch. Default 500. */
  batchSize?: number
  /** Report `matched` without writing anything. */
  dryRun?: boolean
}

export interface BackfillResult {
  /** How many documents matched the filter (and would be / were updated). */
  matched: number
  /** How many documents were actually written (0 on a dry run). */
  updated: number
}

// ---------------------------------------------------------------------------
// Content knowledge graph + GraphRAG retrieval
//
// Treat content plus its TYPED relationships as a graph: a node is a document,
// an edge is a typed relationship (outbound relationship/upload field) or its
// virtual reverse (`join` field). `graph` does a bounded BFS from a seed doc,
// loading every node through the ACCESS-CHECKED read path — a node the caller
// can't read is DROPPED, and so is the edge to it, so the graph never reveals a
// document (or even a relationship to one) a caller is not allowed to see.
// `graphSearch` seeds the BFS from semantic-search hits and returns the
// connected subgraph plus a plain-text `context` array for grounding an LLM
// (the retrieval half of GraphRAG; the generation is the caller's). Read-only,
// access-checked, and bounded (depth + node cap + per-node fan-out + seed cap)
// so a hub node or a deep cycle can never DoS the traversal.
// ---------------------------------------------------------------------------

/** One node in a content graph: a document, identified by a `${collection}:${id}`
 *  ref. `label` is the document's title (via `admin.useAsTitle`, then a `title`/`name`
 *  field, else `${collection} ${id}`) — only readable fields ever contribute. */
export interface GraphNode {
  /** Stable `${collection}:${id}` identifier (the de-dupe key). */
  ref: string
  collection: string
  id: string
  /** The document's display title. Never carries a read-denied field's value. */
  label: string
}

/** A typed edge between two graph nodes. `kind` is `'relationship'` for an outbound
 *  relationship/upload field, `'reverse'` for a virtual `join` (reverse-relationship)
 *  edge. `field` is the field name on the SOURCE side that defines the edge. */
export interface GraphEdge {
  from: string
  to: string
  field: string
  relationTo: string
  kind: 'relationship' | 'reverse'
}

export interface GraphResult {
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** True when the BFS hit `maxNodes` (or a per-node fan-out cap) and stopped early,
   *  so the subgraph may be incomplete. */
  truncated: boolean
}

export interface GraphOptions {
  collection: string
  id: string
  /** BFS hop budget from the seed. Default 1; clamped to `[0, MAX_POPULATE_DEPTH]`. */
  depth?: number
  /** Hard cap on total nodes returned (the seed counts). Default 100; clamped to a
   *  hard maximum so a hub node can't explode the traversal (DoS guard). */
  maxNodes?: number
  req?: Partial<RequestContext>
  /** Trusted server call: bypass access checks. Never set from an untrusted boundary —
   *  the REST route always passes the request principal. */
  overrideAccess?: boolean
}

/** One grounding snippet for an LLM: a reachable node's ref, label, and a plain-text
 *  excerpt (title + a body/summary snippet). Only readable nodes/fields contribute. */
export interface GraphContextItem {
  ref: string
  label: string
  text: string
}

export interface GraphSearchOptions {
  /** Narrow the semantic seed search to one collection (required when more than one
   *  collection has semantic search — there is no cross-collection seed query). */
  collection?: string
  query: string
  /** BFS hop budget to expand each seed. Default 1; clamped to `[0, MAX_POPULATE_DEPTH]`. */
  depth?: number
  /** Max seed documents from the semantic search. Default 5; clamped. */
  limit?: number
  /** Hard cap on total nodes across the whole expanded subgraph. Default 100; clamped. */
  maxNodes?: number
  req?: Partial<RequestContext>
  overrideAccess?: boolean
}

export interface GraphSearchResult<T extends Doc = Doc> {
  /** The seed documents the query matched (access-checked). */
  seeds: T[]
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** Plain-text grounding context for each reachable node, suitable for an LLM prompt. */
  context: GraphContextItem[]
  truncated: boolean
}

export interface Kernel {
  readonly config: SanitizedConfig
  readonly db: DatabaseAdapter
  readonly schema: KernelSchema
  /** Configured cache adapter, when set (see `config.cache`). */
  readonly cache?: CacheAdapter
  /** Configured search adapter, when set (see `config.search`). */
  readonly search?: SearchAdapter
  /** Full-text search a collection, returning access-checked documents in
   *  relevance order. Requires `config.search` and `collection.search`. */
  searchDocs<T extends Doc = Doc>(opts: SearchDocsOptions): Promise<{ docs: T[] }>
  /** Semantic (vector) search: embed the query, find nearest neighbours in the vector
   *  store, then load each hit through the access-checked read path (docs the caller
   *  can't read are dropped — never leaked). Requires `config.embeddings` and a
   *  collection with `search: { semantic: true }`. */
  semanticSearch<T extends Doc = Doc>(opts: SemanticSearchOptions): Promise<{ docs: T[] }>
  /** Hybrid search: run BOTH full-text and semantic search and fuse the two ranked
   *  id-lists with Reciprocal Rank Fusion (k=60), then access-checked-load the fused
   *  top ids. Falls back gracefully to whichever signal is available (full-text only
   *  when no embeddings; semantic only when no full-text fields). */
  hybridSearch<T extends Doc = Doc>(opts: HybridSearchOptions): Promise<{ docs: T[] }>
  /** Related content (more-like-this): re-embed a seed document's current content, find
   *  its nearest neighbours in the vector store, drop the seed itself, then load each hit
   *  through the access-checked read path (most-similar first). A related doc the caller
   *  can't read is dropped — never leaked; an unreadable/missing seed yields `{ docs: [] }`.
   *  Requires `config.embeddings` and a collection with `search: { semantic: true }`. */
  relatedContent<T extends Doc = Doc>(opts: RelatedContentOptions): Promise<{ docs: T[] }>
  /** Near-duplicate detection: compare every pair of documents in a collection (a bounded
   *  O(n²) scan over the stored embeddings) and return the pairs whose cosine similarity is
   *  ≥ `threshold`, highest first. A pair is returned ONLY when the caller can read BOTH
   *  documents — a pair touching an unreadable doc is dropped, so it cannot reveal hidden
   *  content or ids. The scan is capped (see `MAX_DEDUP_DOCS`) against O(n²) DoS. Requires
   *  `config.embeddings` and a collection with `search: { semantic: true }`. */
  findDuplicates(opts: FindDuplicatesOptions): Promise<{ pairs: DuplicatePairResult[] }>
  /** The durable, access-filtered change feed (CDC pull). Returns metadata-only
   *  {@link ChangeEvent}s with `seq > since` (optionally for one collection), dropping any
   *  event the caller cannot read — for a non-delete event, the document is re-fetched
   *  through the access-checked read path (null/throws → dropped); for a delete (doc gone)
   *  the collection's read access is evaluated. `cursor` is the highest seq returned, so
   *  the client polls again with `since=cursor`. No-op (`{ changes: [], cursor: since }`)
   *  when realtime is disabled. */
  changes(opts?: ChangesOptions): Promise<ChangesResult>
  /** Subscribe to live, in-process change events (the push bus that also powers SSE).
   *  The listener receives every recorded {@link ChangeEvent} (metadata only); the caller
   *  is responsible for access-filtering (the SSE handler and pull feed share one filter).
   *  Returns an unsubscribe function. Bounded: excess listeners are rejected. */
  subscribe(listener: (event: ChangeEvent) => void): () => void
  /** Whether a caller may LEARN that a change happened — the SAME access filter the pull
   *  feed applies, exposed per-event so the SSE stream can gate each pushed event. For a
   *  non-delete event the document is re-loaded through the access-checked read path; for
   *  a delete the collection's read access is evaluated. Returns false (dropped) when
   *  realtime is disabled or the caller can't read the target. */
  changeVisibleTo(
    event: ChangeEvent,
    opts?: { req?: Partial<RequestContext>; overrideAccess?: boolean },
  ): Promise<boolean>
  /** The surrogate cache tags for a document or list response (edge delivery): the
   *  collection tag (`<collection>`), the doc tag (`<collection>:<id>`), and — for a
   *  single doc when `edge.includeRelationships` and a `doc` is supplied — the tags of
   *  the docs it directly references. Pure (no DB/access); pass only docs the caller may
   *  see, since a tag names a (collection,id). Tags are CDN-safe, de-duped tokens.
   *  Returns `[]` when edge delivery is disabled or the collection is unknown. */
  cacheTags(opts: CacheTagsOptions): string[]
  /** The purge feed: cache tags to invalidate at the CDN for changes since `since`,
   *  derived from the real-time change feed (the changed doc's + collection tags; when
   *  `edge.includeRelationships`, also the tags of docs that REFERENCE the changed doc).
   *  Returns the de-duped tags + the new `cursor` (poll again with `since=cursor`).
   *  Requires `edge` + `realtime`; returns an empty set otherwise. The HTTP route is
   *  admin/operator-gated (it reveals which ids changed). */
  purgeFeed(opts?: PurgeFeedOptions): Promise<PurgeFeedResult>
  /** Subscribe to purge tags pushed over the realtime bus: the listener receives the
   *  cache tags (doc + collection) for each live change. A thin convenience over
   *  `subscribe` for a push-based CDN purger; returns an unsubscribe function. No-op
   *  (returns a no-op unsubscribe) when edge delivery is disabled. Reverse-ref tags are
   *  NOT computed on the push path — poll {@link Kernel.purgeFeed} for those. */
  onPurge(listener: (tags: string[]) => void): () => void
  find<T extends Doc = Doc>(opts: FindOptions): Promise<PaginatedResult<T>>
  findByID<T extends Doc = Doc>(opts: FindByIDOptions): Promise<T | null>
  create<T extends Doc = Doc>(opts: CreateOptions): Promise<T>
  upload<T extends Doc = Doc>(opts: UploadDocOptions): Promise<T>
  /** Mint a signed, expiring capability URL for an upload document's file. The caller must be
   *  able to READ the document. The returned URL carries an `exp` + HMAC `sig` (keyed by
   *  `config.secret`) and fetches the file without a session until it expires — for emailing a
   *  private download, embedding a time-limited image, or handing a file to a service. When the
   *  storage adapter mints its own signed URLs (e.g. S3 presign), that is returned instead. */
  signedAssetUrl(opts: SignedAssetUrlOptions): Promise<string>
  update<T extends Doc = Doc>(opts: UpdateOptions): Promise<T | null>
  /** Write several locales of one document in a single call, merging each locale's
   *  partial into the stored per-locale maps (untouched locales preserved). Runs the
   *  normal access + validation pipeline per locale; under strict localization each
   *  provided locale must satisfy its required localized fields. */
  updateLocales<T extends Doc = Doc>(opts: UpdateLocalesOptions): Promise<T | null>
  /** Per-locale translation completeness for one document (required-field coverage
   *  and fill counts per configured locale). Access-checked via the read path. */
  translationStatus(opts: TranslationStatusOptions): Promise<TranslationStatus>
  /** Translation dashboard: per-locale completeness across a collection's documents,
   *  scoped by the caller's read access. Empty when the collection has no localized
   *  fields or localization is off. */
  translationStatusList(opts: TranslationStatusListOptions): Promise<{ docs: TranslationStatusItem[]; count: number }>
  /** AI-assisted translation: read a document's localized field values in the `from` locale,
   *  translate them to `to` via the configured provider, and write the results into the `to`
   *  locale through the NORMAL access-checked update (merge — other locales preserved). Only
   *  MISSING `to` values are filled unless `overwrite` is set. Access + strict per-locale
   *  validation + the agent draft-only brake all apply (a translation never auto-publishes).
   *  Requires `config.translation` and `config.localization`. */
  translateDocument<T extends Doc = Doc>(opts: TranslateDocumentOptions): Promise<T | null>
  /** Batch-fill a collection's missing `to`-locale translations from a source locale, bounded
   *  by `limit`. Scoped by the caller's read/write access (no override widening); reports which
   *  document ids were translated vs skipped. Requires `config.translation`. */
  translateMissing(opts: TranslateMissingOptions): Promise<TranslateMissingResult>
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
  loginWithOAuth(opts: {
    collection: string
    provider: string
    code: string
    redirectUri: string
    nonce?: string
    codeVerifier?: string
  }): Promise<AuthResult>
  findGlobal<T extends Row = Row>(opts: FindGlobalOptions): Promise<T>
  updateGlobal<T extends Row = Row>(opts: UpdateGlobalOptions): Promise<T>
  findVersions(opts: FindVersionsOptions): Promise<PaginatedResult<VersionDoc>>
  restoreVersion<T extends Doc = Doc>(opts: RestoreVersionOptions): Promise<T | null>
  /** Content time-machine — a document's ordered change timeline (oldest → newest). Each
   *  entry's `changedFields` are the fields that differ from the previous snapshot. The
   *  caller must be able to read the document (else Forbidden / empty); read-denied fields
   *  never appear in `changedFields`. Requires `versions` enabled (else BadRequestError). */
  history(opts: HistoryOptions): Promise<HistoryEntry[]>
  /** Field-level diff of one document between two points in time. `from`/`to` may each be
   *  a versionId or an ISO timestamp. Only fields the caller can read appear. Access-checked
   *  exactly like a read. Requires `versions` enabled (else BadRequestError). */
  diffVersions(opts: DiffVersionsOptions): Promise<VersionDiff>
  /** Restore a document to its state at `asOf` by writing the reconstructed state through
   *  the NORMAL update path — access control, the agent draft-only brake, and validation
   *  all apply (no override bypass). Records a new version (the restore is auditable).
   *  Returns null when the document did not exist at `asOf`. */
  restoreAsOf<T extends Doc = Doc>(opts: RestoreAsOfOptions): Promise<T | null>
  publish<T extends Doc = Doc>(opts: PublishOptions): Promise<T | null>
  unpublish<T extends Doc = Doc>(opts: PublishOptions): Promise<T | null>
  processScheduledPublishes(opts?: ProcessScheduledOptions): Promise<ProcessScheduledResult>
  /** Query the append-only audit log (newest-first by default). Returns
   *  `{ docs: [], count: 0 }` when auditing is disabled. */
  findAuditLog(opts?: FindAuditLogOptions): Promise<{ docs: AuditDoc[]; count: number }>
  enqueue(opts: EnqueueOptions): Promise<Doc>
  runDueJobs(opts?: RunJobsOptions): Promise<RunJobsResult>
  /** Execute a workflow's steps in order, each AS the workflow's scoped agent principal
   *  (field-scoped + draft-only + access-checked). Records per-step status into the
   *  `_workflow_runs` log. A blocking `evalGate` failure or a thrown step fails the run
   *  (recorded + audited); `requestReview` pauses the run as `awaiting_review`; all steps
   *  finishing completes it. Throws when workflows are not configured or the slug is unknown. */
  runWorkflow(opts: RunWorkflowOptions): Promise<WorkflowRun>
  /** Query the durable workflow run log (newest-first). Filter by `slug`/`status`.
   *  Returns `{ docs: [], count: 0 }` when workflows are not configured. */
  workflowRuns(opts?: WorkflowRunsOptions): Promise<{ docs: WorkflowRun[]; count: number }>
  /** List all RBAC roles (from the live store). Empty when RBAC is disabled. */
  findRoles(): Promise<RoleDoc[]>
  /** Create a role: persist it to `_roles` and add it to the live store. Throws if RBAC
   *  is disabled, the name already exists, or the definition is invalid. */
  createRole(name: string, def: RoleDef, opts?: RoleMutationOptions): Promise<RoleDoc>
  /** Replace a role's definition: persist to `_roles` and update the live store. The
   *  change is enforced on the next access check. Throws if RBAC is disabled / invalid. */
  updateRole(name: string, def: RoleDef, opts?: RoleMutationOptions): Promise<RoleDoc>
  /** Remove a role from `_roles` and the live store. Throws if RBAC is disabled. */
  deleteRole(name: string, opts?: RoleMutationOptions): Promise<{ name: string }>
  /** List agent-authored drafts awaiting human review (derived; respects the
   *  reviewer's read access). Returns `{ docs: [], count: 0 }` when review is disabled. */
  findReviewQueue(opts?: FindReviewQueueOptions): Promise<{ docs: ReviewQueueItem[]; count: number }>
  /** Decide on an agent-authored draft. `approve` publishes it through the existing
   *  publish gate (a reviewer lacking publish access is rejected); `request_changes`
   *  keeps it a draft and records the note. Both decisions persist to `_reviews` and
   *  are audited. */
  submitReview(opts: SubmitReviewOptions): Promise<SubmitReviewResult>
  /** Add an editorial comment / annotation to a document. The caller MUST be able to READ
   *  the target document (else Forbidden/NotFound — no existence leak). `body` is required,
   *  trimmed, and length-bounded; an optional `field` anchor is validated to be a real field
   *  of the collection; an optional `parentId` must be an existing comment on the SAME
   *  document. The author is recorded from the authenticated principal (never client input);
   *  anonymous principals cannot comment. Requires `config.comments`. */
  addComment(opts: AddCommentOptions): Promise<CommentDoc>
  /** List a document's comments oldest→newest. The caller MUST be able to READ the document
   *  (else Forbidden — never leaks comment bodies/authors/existence). Optionally filtered by
   *  `field` and excluding resolved comments (the default). Returns `[]` when comments are
   *  disabled. */
  listComments(opts: ListCommentsOptions): Promise<CommentDoc[]>
  /** Mark a comment resolved/unresolved. Only the comment's AUTHOR or an admin/editor
   *  (reviewer) may resolve it; document read access is re-checked. */
  resolveComment(opts: ResolveCommentOptions): Promise<CommentDoc>
  /** Delete a comment. Only the comment's AUTHOR or an admin may delete it. */
  deleteComment(opts: DeleteCommentOptions): Promise<{ id: string }>
  /** Count a document's comments (resolved excluded by default). The caller must be able to
   *  READ the document. Returns 0 when comments are disabled. */
  commentCount(opts: CommentCountOptions): Promise<number>
  /** Save a named query preset (a `where` + `sort` + display `columns`) for a collection the
   *  caller can READ. The owner is recorded from the authenticated principal (never client
   *  input); the stored `where`/`sort` are validated against the collection. Private unless
   *  `shared`. Requires `config.views`. */
  saveView(opts: SaveViewOptions): Promise<ViewDoc>
  /** List the caller's own saved views plus any `shared` views on collections they can READ,
   *  newest-first. Optionally scoped to one `collection`. Returns `[]` when views are disabled. */
  listViews(opts?: ListViewsOptions): Promise<ViewDoc[]>
  /** Fetch a single saved view by id — its owner, or (when `shared`) anyone who can READ its
   *  collection. Returns null when not found / not visible. */
  getView(opts: GetViewOptions): Promise<ViewDoc | null>
  /** Update a saved view's editable fields. Only the view's OWNER (or an admin) may update it;
   *  any changed `where`/`sort` is re-validated against the collection. */
  updateView(opts: UpdateViewOptions): Promise<ViewDoc>
  /** Delete a saved view. Only the view's OWNER (or an admin) may delete it. */
  deleteView(opts: DeleteViewOptions): Promise<{ id: string }>
  /** Apply a saved view: run the NORMAL access-checked `find` with the view's stored
   *  `where`+`sort` (re-validated), optionally narrowed by an extra `where`. The result can
   *  only ever be within the caller's read access — a view never widens visibility. */
  applyView<T extends Doc = Doc>(opts: ApplyViewOptions): Promise<PaginatedResult<T>>
  /** Drain the durable webhook outbox: deliver due `_webhook_deliveries` (POST + sign),
   *  marking each delivered, retried (with backoff), or exhausted. A trusted cron op (like
   *  `processContentLifecycle`); wired into `kernel jobs:run` / `webhooks:run`. Returns the
   *  per-status id lists. A no-op when no durable webhooks are configured. */
  processWebhooks(opts?: ProcessWebhooksOptions): Promise<ProcessWebhooksResult>
  /** List the configured webhooks as REDACTED summaries (never the secret or custom
   *  headers). Admin-only surface. */
  listWebhooks(): WebhookSummary[]
  /** Query the durable webhook delivery log (newest-first), optionally by webhook/status. */
  webhookDeliveries(opts?: WebhookDeliveriesOptions): Promise<{ docs: WebhookDeliveryDoc[]; count: number }>
  /** Requeue a failed/exhausted delivery for an immediate retry (resets it to pending,
   *  due now). Admin-only. */
  retryWebhookDelivery(opts: RetryWebhookDeliveryOptions): Promise<WebhookDeliveryDoc>
  /** Create an empty, `open` content release — a named bundle of drafts to publish as a
   *  unit. Requires `config.releases`. The name is untrusted (length-bounded). */
  createRelease(opts: CreateReleaseOptions): Promise<Release>
  /** Add a draft document to an OPEN release. Validates the collection + document exist
   *  and the caller can read the document; de-dupes (release, collection, documentId).
   *  Only `open` releases are editable. */
  addToRelease(opts: ReleaseMemberOptions): Promise<ReleaseWithItems>
  /** Remove a member from an OPEN release. */
  removeFromRelease(opts: ReleaseMemberOptions): Promise<ReleaseWithItems>
  /** List releases (optionally by status), newest-first. Empty when releases are disabled. */
  listReleases(opts?: ListReleasesOptions): Promise<{ docs: Release[]; count: number }>
  /** A release plus its member references, or null when it doesn't exist. */
  getRelease(opts: GetReleaseOptions): Promise<ReleaseWithItems | null>
  /** Preview a release: each member in its CURRENT (draft) state, loaded through the
   *  access-checked read (`draft:true`). Members the caller can't read are dropped. */
  previewRelease(opts: PublishReleaseOptions): Promise<PreviewReleaseResult>
  /** Publish every member of an `open` release as a unit, each through the existing
   *  publish op with the caller's `req` (so `assertCanPublish` — publish access, the
   *  agent brake, and the eval gate — applies per member). ALL-OR-NOTHING pre-flight:
   *  if any member would fail the gate, NONE are published and the release stays `open`.
   *  On success the release becomes `published`. A mid-publish DB error marks it `failed`
   *  and reports which members succeeded (best-effort atomic). */
  publishRelease(opts: PublishReleaseOptions): Promise<PublishReleaseResult>
  /** Schedule an `open` release to publish at `at`. Publishability is gate-checked NOW
   *  (pre-flight at schedule time, exactly like a scheduled per-doc publish); the drain
   *  then publishes the recorded members under override when due. */
  scheduleRelease(opts: ScheduleReleaseOptions): Promise<Release>
  /** Cancel (delete) an `open` or `scheduled` release. A published release is immutable. */
  cancelRelease(opts: CancelReleaseOptions): Promise<{ id: string }>
  /** Publish every scheduled release whose time has arrived (the drain). Members are
   *  published under override — they were gate-checked at schedule time. Drive from a
   *  cron/job alongside `processScheduledPublishes`. */
  processScheduledReleases(opts?: ProcessScheduledReleasesOptions): Promise<ProcessScheduledReleasesResult>
  /** Retire expired content (the inverse of `processScheduledPublishes`). For each
   *  `config.lifecycle` collection, every PUBLISHED document whose `expireField <= now`
   *  is retired by its `onExpire` action — `unpublish` (→ draft), `archive` (→ draft +
   *  `_archived_at` stamp), or `delete`. Runs under override (a TRUSTED system/cron op),
   *  resilient per-doc, bounded by `limit`, and confined to the configured collections.
   *  A no-op (`{ processed: [] }`) when lifecycle is disabled. Drive from a cron/job
   *  alongside `processScheduledPublishes` (`kernel jobs:run` / `kernel lifecycle:run`). */
  processContentLifecycle(opts?: ProcessContentLifecycleOptions): Promise<ProcessContentLifecycleResult>
  /** Assemble a `blocks` page layout from a validated spec and create it through the
   *  normal `create()` path (agent draft-only brake + field scope + access all apply),
   *  so it lands in the review queue. Rejects unknown block types / fields. */
  composePage<T extends Doc = Doc>(opts: ComposePageOptions): Promise<T>
  /** List the available content templates (metadata only — slug/collection/name/description,
   *  never the raw `data`), optionally filtered to one `collection`. Templates are config
   *  skeletons (not content), so the list is non-sensitive and not access-scoped per row.
   *  Empty when no templates are configured. */
  listTemplates(opts?: ListTemplatesOptions): Promise<TemplateSummary[]>
  /** Instantiate a content template into a fully pre-filled document. Looks up the template
   *  by slug, deep-merges the template's default `data` with the caller's (untrusted)
   *  overrides — caller wins, prototype-pollution-guarded — then creates through the NORMAL
   *  `create()` path, so create access, field scope, validation, and the agent draft-only
   *  brake all apply (a template that sets `_status:'published'` still can't let an agent
   *  publish). An unknown slug throws a clean error. */
  createFromTemplate<T extends Doc = Doc>(opts: CreateFromTemplateOptions): Promise<T>
  /** Acquire (or refresh) an ADVISORY soft lock on a document. Returns `heldBy:'you'`
   *  when you now hold it (no lock, expired, or you already held it — refreshed); returns
   *  `heldBy:'other'` WITHOUT stealing when a different principal holds an unexpired lock.
   *  Advisory only: a lock never changes write authorization. */
  acquireLock(opts: AcquireLockOptions): Promise<AcquireLockResult>
  /** Release a soft lock. Only the holder (or an admin/system override) may release an
   *  unexpired lock; an already-expired lock is releasable by anyone. */
  releaseLock(opts: ReleaseLockOptions): Promise<ReleaseLockResult>
  /** The current UNEXPIRED lock on a document, or null. */
  getLock(opts: GetLockOptions): Promise<LockDoc | null>
  /** Every UNEXPIRED lock (optionally for one collection). */
  listLocks(opts?: ListLocksOptions): Promise<LockDoc[]>
  /** Record a presence heartbeat (upsert `lastSeen` + `kind`). Cheap and idempotent. */
  heartbeat(opts: HeartbeatOptions): Promise<void>
  /** The active participants on a document — those whose last heartbeat is within `ttlMs`
   *  of now. Stale rows are filtered out (and lazily pruned). */
  getPresence(opts: GetPresenceOptions): Promise<PresenceEntry[]>
  /** The provenance chain of a document — who created/edited/approved each version,
   *  with human-vs-agent authorship surfaced. Derived from the version snapshots; the
   *  caller must be able to READ the document (never leaks provenance for a hidden doc). */
  provenance(opts: ProvenanceOptions): Promise<Provenance>
  /** The latest content credential for a document (access-checked). Null when signing
   *  is off or the document has never been published under signing. */
  getContentCredential(opts: GetCredentialOptions): Promise<CredentialDoc | null>
  /** Re-verify a document's content credential: confirm the signature is authentic AND
   *  the live content still matches the signed hash. Returns `valid:false` with a reason
   *  when the document was modified after signing (tamper) or the signature doesn't verify. */
  verifyContentCredential(opts: VerifyCredentialOptions): Promise<VerifyCredentialResult>
  /** The llms.txt index for AI answer engines: the project `# title`, `> description`,
   *  then a `## <Plural label>` section per discoverable collection listing each PUBLISHED,
   *  publicly-readable document as `- [title](url): summary`. Generated as an anonymous
   *  principal through the access pipeline, so drafts/private docs never appear. */
  llmsTxt(opts?: LlmsTxtOptions): Promise<string>
  /** The full llms-full.txt corpus: the same header, then a `## <title>` section per
   *  published doc with its body rendered to clean markdown and a provenance/citation
   *  footer (canonical URL, last-updated, signature-verified note when signed). Public
   *  content only; output size is bounded by the configured caps. */
  llmsFullTxt(opts?: LlmsTxtOptions): Promise<string>
  /** Retrieval-ready content chunks (one per published doc) for RAG / GEO ingestion —
   *  title, canonical URL, clean-markdown text, token estimate, and provenance. Public
   *  content only; bounded by the configured caps. */
  contentChunks(opts?: ContentChunksOptions): Promise<ContentChunk[]>
  /** One published document as GEO-optimized markdown: a `# title`, the clean prose body,
   *  and a citation block (author, last-updated, canonical URL, signature-verified status).
   *  Returns null when the document is not found, not published, or not publicly readable. */
  geoDocument(opts: GeoDocumentOptions): Promise<string | null>
  /** One document as a schema.org JSON-LD object (`{ '@context':'https://schema.org',
   *  '@type':<type>, '@id':<canonical url>, …mapped properties }`). Read through the
   *  access-checked path: a draft/private doc or a read-denied field is NEVER emitted —
   *  returns null when the document is not found / not readable. richText renders to
   *  plain text; dates to ISO strings; URLs are built injection-safely. Requires
   *  `config.structuredData` with the collection configured (else null). */
  jsonLd(opts: JsonLdOptions): Promise<Record<string, unknown> | null>
  /** The embeddable `<script type="application/ld+json">…</script>` string for a document,
   *  with the JSON HTML-escaped (`<`/`>`/`&`) so document content can never break out of
   *  the script tag (XSS guard). Returns `''` when there is no readable document. */
  jsonLdScript(opts: JsonLdScriptOptions): Promise<string>
  /** Deterministically bucket a visitor `key` into one of an experiment's variants. The
   *  SAME key always maps to the SAME variant (sticky); the distribution across many keys
   *  matches the configured weights. Only the hash of `key` is used — the raw key is never
   *  stored. The returned `variant`/`segment` is an audience segment: set `req.audience` to
   *  it to read that variant's personalized content. Throws when experiments are not
   *  configured or the slug is unknown. */
  assignVariant(opts: AssignVariantOptions): AssignVariantResult
  /** Capture one content-usage event into the bounded `_analytics` table. Privacy-first:
   *  NO PII is stored (no user id/IP/visitor key/email/token) — a `meta` is sanitized to
   *  non-PII scalar dimensions. Resilient: a tracking failure logs + NEVER throws into the
   *  caller. `track` can only ever write `_analytics`, never another collection. No-op when
   *  analytics is disabled or the `type` is invalid. */
  track(opts: TrackOptions): Promise<void>
  /** Aggregate content insights (top content, top queries, variant performance, activity
   *  over time, the AI-retrieval leaderboard). Every result is an AGGREGATE over content
   *  events — no per-user data exists to leak. The scan + result size are bounded (DoS
   *  guard); rows are filtered to collections the caller can read. Returns an empty result
   *  when analytics is disabled. Admin/editor-gated at the HTTP layer. */
  insights(opts: InsightsOptions): Promise<InsightsResult>
  /** Apply the schema to the database (create tables / add columns / build indexes),
   *  recording a `_migrations` journal row when anything is applied. Pass
   *  `{ dryRun: true }` to compute the exact SQL it WOULD run and return the report
   *  WITHOUT touching the database or writing a journal row. */
  migrate(opts?: MigrateRunOptions): Promise<MigrationReport>
  /** Undo the last `steps` recorded migrations (newest-first): drop the columns and
   *  tables they added, atomically, then consume those journal rows. Destructive by
   *  definition — it drops schema. `{ dryRun: true }` returns the inverse SQL without
   *  executing or consuming anything. Only ever drops what the journal records as added;
   *  never a `_*` system table. */
  rollbackMigration(opts?: RollbackOptions): Promise<RollbackResult>
  /** Populate a field across existing documents — the safe online sequence's middle
   *  step (add a nullable field → backfill it → make it required). Batches over matched
   *  rows via trusted (`overrideAccess`) updates. `{ dryRun: true }` reports `matched`
   *  without writing. */
  backfill<T extends Doc = Doc>(opts: BackfillOptions<T>): Promise<BackfillResult>
  /** Traverse the content knowledge graph from a seed document: a bounded BFS that
   *  follows BOTH outbound relationship/upload fields AND inbound `join` reverse-
   *  relations up to `depth` hops. Every node is loaded through the ACCESS-CHECKED
   *  read path — a node the caller can't read is dropped, and so is the edge to it,
   *  so the graph never reveals a document (or a relationship to one) the caller may
   *  not see. Bounded by `depth` + `maxNodes` + per-node fan-out + cycle de-dupe. */
  graph(opts: GraphOptions): Promise<GraphResult>
  /** GraphRAG retrieval: seed from semantic-search hits for `query`, expand each seed
   *  through `graph(...)` to `depth`, and return the seed docs, the connected subgraph
   *  (nodes + edges), and a plain-text `context` array (label + snippet per reachable
   *  node) for grounding an LLM. Requires `config.embeddings` (semantic seeds); falls
   *  back to `find` when no collection has semantic search. Everything access-checked —
   *  only readable nodes contribute context. The generation step is the caller's. */
  graphSearch<T extends Doc = Doc>(opts: GraphSearchOptions): Promise<GraphSearchResult<T>>
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
// Agentic workflows
//
// A declarative orchestration layer that lets a SCOPED agent take a job from
// trigger → draft → quality gate → human review, with hard guardrails so nothing
// autonomous can go live unchecked. A workflow's `steps` are user functions that
// operate through a Local-API subset BOUND to the configured agent principal —
// every write they make flows through the agent's `fieldScope` + the draft-only
// brake + normal access control (NO overrideAccess). Content advances ONLY via the
// eval gate or the human review gate; a workflow can NEVER auto-publish.
// ---------------------------------------------------------------------------

/** A reference to a single document a gate operates on. */
export interface WorkflowRef {
  collection: string
  id: string
}

/** The Local-API surface a workflow step gets — content reads/writes only, all run
 *  AS the workflow's scoped agent principal (field-scoped, draft-only, access-checked). */
export type WorkflowLocalApi = Pick<
  Kernel,
  'find' | 'findByID' | 'create' | 'update' | 'delete' | 'count' | 'composePage' | 'findVersions'
>

/** The lifecycle state of a workflow run, persisted in `_workflow_runs`. */
export type WorkflowRunStatus = 'pending' | 'running' | 'awaiting_review' | 'completed' | 'failed'

/** Per-step execution record kept in the run log. */
export interface WorkflowStepRecord {
  name: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
  startedAt?: string
  finishedAt?: string
  /** Free-form lines the step appended via `ctx.log(...)`. */
  log?: string[]
  /** The error message when the step failed (never carries secrets — message only). */
  error?: string
}

/** What fired a run: a create/update trigger (with the document) or a manual call. */
export interface WorkflowTriggerRecord {
  on: 'create' | 'update' | 'manual'
  collection?: string
  documentId?: string
}

/** A durable workflow run, as persisted in `_workflow_runs` and returned by the API. */
export interface WorkflowRun {
  id: string
  slug: string
  status: WorkflowRunStatus
  trigger: WorkflowTriggerRecord
  steps: WorkflowStepRecord[]
  attempts: number
  lastError: string | null
  createdAt?: string
  updatedAt?: string
}

/** Context handed to each workflow step. Every content op on `kernel` runs as the
 *  workflow's scoped agent principal. The gate helpers are the ONLY way a step can
 *  advance content past a draft. */
export interface WorkflowContext {
  /** Local-API subset bound to the scoped agent principal (field-scoped, draft-only). */
  kernel: WorkflowLocalApi
  /** The trigger document (create/update) or the manual `input` payload. Treat as
   *  untrusted — never spread it into a write without naming the fields you want. */
  input: unknown
  /** Append a line to this step's run log (persisted; keep it free of secrets). */
  log: (msg: string) => void
  /** Metadata for the step currently executing. */
  step: { name: string; index: number }
  /** Run the configured content-CI evals against a document. THROWS (halting the
   *  workflow and recording a failed run) if a blocking eval rejects. */
  evalGate: (ref: WorkflowRef) => Promise<void>
  /** Submit a document to the human review inbox (#3) and mark the run
   *  `awaiting_review`. The run then PAUSES — a human approves via the inbox to
   *  publish; the workflow never block-waits on a human. */
  requestReview: (ref: WorkflowRef, note?: string) => Promise<void>
}

/** A single ordered step in a workflow. */
export interface WorkflowStep {
  name: string
  run: (ctx: WorkflowContext) => Promise<void>
}

/** What causes a workflow to enqueue a run automatically. `create`/`update` attach an
 *  `afterChange` hook to `collection`; `manual` runs only via `kernel.runWorkflow`. */
export interface WorkflowTrigger {
  on: 'create' | 'update' | 'manual'
  /** The collection whose writes fire the trigger (required for create/update). */
  collection?: string
}

export interface WorkflowDefinition {
  slug: string
  /** Id of a configured `agents` entry. Every step runs AS this scoped principal —
   *  its `fieldScope` and the hard draft-only brake apply to all its writes. When
   *  omitted, steps run as a draft-only system-agent with no fieldScope (still NEVER
   *  publishes). An agent with the `admin` role is rejected at config time. */
  agent?: string
  /** What enqueues a run. Defaults to `manual` when omitted. */
  trigger?: WorkflowTrigger
  steps: WorkflowStep[]
  /** Max attempts before a failed run is given up on (mirrors job retries). Default 3. */
  maxAttempts?: number
}

export interface RunWorkflowOptions {
  slug: string
  /** Manual input payload (ignored for trigger-driven runs, which carry the doc). */
  input?: unknown
  /** Caller request context — used only to AUDIT who started a manual run; it NEVER
   *  becomes the principal that executes steps (that is always the scoped agent). */
  req?: Partial<RequestContext>
}

export interface WorkflowRunsOptions {
  slug?: string
  status?: WorkflowRunStatus
  limit?: number
  page?: number
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
  /** Opt this endpoint into the `@kernel/mcp` agent surface. When `true`, an MCP
   *  tool is generated that runs this handler via the in-process Local API with the
   *  agent principal — your `access` rule is the gate (no `overrideAccess`). Default
   *  (omitted/false) keeps the endpoint OFF the agent surface (least surprise). */
  mcp?: boolean
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
