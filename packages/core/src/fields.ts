import type { ColumnSchema, Row, StorageType } from '@kernel/db'
import {
  emptyRichText,
  isEmptyRichText,
  resolveRichTextSchema,
  sanitizeRichText,
  type KernelRichText,
  type ResolvedRichTextSchema,
} from '@kernel/richtext'
import type { AnyField, ConfigField, RequestContext, RichTextField, SelectOption } from './types'
import type { FieldError } from './errors'

/** Resolve the allow-list schema for a richText field (cached per field object). */
const richTextSchemaCache = new WeakMap<RichTextField, ResolvedRichTextSchema>()
export function richTextSchemaFor(field: RichTextField): ResolvedRichTextSchema {
  let schema = richTextSchemaCache.get(field)
  if (!schema) {
    schema = resolveRichTextSchema({ features: field.features, preset: field.preset })
    richTextSchemaCache.set(field, schema)
  }
  return schema
}

/** True when a value is a legacy string or a well-formed rich-text document. */
function isRichTextLike(value: unknown): boolean {
  if (typeof value === 'string') return true
  const doc = value as Partial<KernelRichText> | null
  return Boolean(doc && doc.type === 'doc' && doc.v === 1 && Array.isArray(doc.children))
}

/** Coerce a stored/legacy value into a KernelRichText document (string shim §13). */
function asRichTextDoc(value: unknown): KernelRichText {
  if (typeof value === 'string') {
    const text = value.trim()
    return text
      ? { v: 1, type: 'doc', children: [{ type: 'paragraph', children: [{ type: 'text', text }] }] }
      : emptyRichText()
  }
  return value as KernelRichText
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function humanize(name: string): string {
  return name
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^\w/, (c) => c.toUpperCase())
    .trim()
}

export function fieldLabel(field: AnyField): string {
  return field.label ?? humanize(field.name)
}

/**
 * Expand presentational containers (`row`, `tabs`) into their child fields and
 * drop `ui` fields. Storage, validation, serialization, and access all operate
 * on the *effective* fields, since presentational fields hold no data of their
 * own — their children are stored at the parent level.
 */
export function effectiveFields(fields: ConfigField[]): AnyField[] {
  const out: AnyField[] = []
  for (const field of fields) {
    // `ui` and `join` are virtual — they store nothing and get no column.
    if (field.type === 'ui' || field.type === 'join') continue
    if (field.type === 'row') out.push(...effectiveFields(field.fields))
    else if (field.type === 'tabs') for (const tab of field.tabs) out.push(...effectiveFields(tab.fields))
    else out.push(field)
  }
  return out
}

/** Effective fields minus computed (`virtual`) ones — the fields that map to a
 *  storage column and accept input. Storage/validation paths use this; output and
 *  access paths use `effectiveFields` so virtual fields still appear and can be
 *  access-controlled. */
export function storageFields(fields: ConfigField[]): AnyField[] {
  return effectiveFields(fields).filter((f) => !f.virtual)
}

/** Virtual reverse-relationship fields, flattened out of rows/tabs. */
export function joinFields(
  fields: ConfigField[],
): Array<{ name: string; collection: string; on: string; limit: number }> {
  const out: Array<{ name: string; collection: string; on: string; limit: number }> = []
  for (const field of fields) {
    if (field.type === 'join')
      out.push({ name: field.name, collection: field.collection, on: field.on, limit: field.limit ?? 100 })
    else if (field.type === 'row') out.push(...joinFields(field.fields))
    else if (field.type === 'tabs') for (const tab of field.tabs) out.push(...joinFields(tab.fields))
  }
  return out
}

export function optionValue(opt: SelectOption): string {
  return typeof opt === 'string' ? opt : opt.value
}

export function optionLabel(opt: SelectOption): string {
  return typeof opt === 'string' ? humanize(opt) : opt.label
}

/** The physical storage type for a field, accounting for localization and arity. */
export function storageTypeForField(field: AnyField): StorageType {
  if (field.localized) return 'json'
  switch (field.type) {
    case 'number':
      return field.integer ? 'integer' : 'real'
    case 'boolean':
    case 'checkbox':
      return 'boolean'
    case 'date':
      return 'timestamp'
    case 'json':
    case 'richText':
    case 'point':
    case 'array':
    case 'group':
    case 'blocks':
      return 'json'
    case 'select':
    case 'radio':
      return field.hasMany ? 'json' : 'text'
    case 'relationship':
    case 'upload':
      // Polymorphic refs ({ relationTo, value }) and hasMany lists need JSON.
      return field.hasMany || Array.isArray(field.relationTo) ? 'json' : 'text'
    default:
      return 'text'
  }
}

export function columnForField(field: AnyField): ColumnSchema {
  // FK/relationship columns are auto-indexed: relationship lookups are the hot
  // path, and an unindexed FK forces a full scan. Explicit `index: false` opts
  // out; explicit `index`/`unique` still win.
  const isRelation = field.type === 'relationship' || field.type === 'upload'
  const column: ColumnSchema = {
    name: field.name,
    type: storageTypeForField(field),
    required: Boolean(field.required),
    unique: Boolean(field.unique),
    indexed: field.index ?? (Boolean(field.unique) || isRelation),
    localized: Boolean(field.localized),
  }
  // Single-target relationships carry an FK hint; polymorphic (`string[]`) don't.
  if (
    (field.type === 'relationship' || field.type === 'upload') &&
    !field.hasMany &&
    typeof field.relationTo === 'string'
  ) {
    column.relationTo = field.relationTo
  }
  return column
}

/** Resolve a field's default value (supports literal or factory). */
export function defaultForField(field: AnyField): unknown {
  const dv = field.defaultValue
  if (dv === undefined) return undefined
  if (typeof dv === 'function') return (dv as () => unknown)()
  return dv
}

export function applyDefaults(fieldsIn: ConfigField[], data: Row): Row {
  const fields = storageFields(fieldsIn)
  const out: Row = { ...data }
  for (const field of fields) {
    if (out[field.name] === undefined) {
      const dv = defaultForField(field)
      if (dv !== undefined) out[field.name] = dv
    }
  }
  return out
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)
}

export interface ValidateContext {
  req: RequestContext
  operation: 'create' | 'update'
}

export async function validateFields(
  fieldsIn: ConfigField[],
  data: Row,
  ctx: ValidateContext,
  prefix = '',
): Promise<FieldError[]> {
  const fields = storageFields(fieldsIn)
  const errors: FieldError[] = []
  for (const field of fields) {
    const path = prefix ? `${prefix}.${field.name}` : field.name
    const value = data?.[field.name]
    const label = fieldLabel(field)

    // A rich-text doc that renders nothing (empty/whitespace) counts as empty.
    // Malformed values fall through to validateFieldType, which rejects them.
    const empty =
      field.type === 'richText' && value != null && value !== ''
        ? isRichTextLike(value) && isEmptyRichText(asRichTextDoc(value))
        : isEmpty(value)
    if (empty) {
      if (field.required) errors.push({ path, message: `${label} is required.` })
      continue
    }

    const typeError = validateFieldType(field, value, label)
    if (typeError) {
      errors.push({ path, message: typeError })
      continue
    }

    // Recurse into nested structures.
    if (field.type === 'array' && Array.isArray(value)) {
      if (field.minRows !== undefined && value.length < field.minRows) {
        errors.push({ path, message: `${label} requires at least ${field.minRows} row(s).` })
      }
      if (field.maxRows !== undefined && value.length > field.maxRows) {
        errors.push({ path, message: `${label} allows at most ${field.maxRows} row(s).` })
      }
      for (let i = 0; i < value.length; i++) {
        const row = value[i]
        if (row && typeof row === 'object') {
          errors.push(...(await validateFields(field.fields, row as Row, ctx, `${path}.${i}`)))
        } else {
          errors.push({ path: `${path}.${i}`, message: 'Each row must be an object.' })
        }
      }
    } else if (field.type === 'blocks' && Array.isArray(value)) {
      if (field.minRows !== undefined && value.length < field.minRows) {
        errors.push({ path, message: `${label} requires at least ${field.minRows} block(s).` })
      }
      if (field.maxRows !== undefined && value.length > field.maxRows) {
        errors.push({ path, message: `${label} allows at most ${field.maxRows} block(s).` })
      }
      for (let i = 0; i < value.length; i++) {
        const row = value[i]
        if (!row || typeof row !== 'object') {
          errors.push({ path: `${path}.${i}`, message: 'Each block must be an object.' })
          continue
        }
        const blockType = (row as Row).blockType
        const def = field.blocks.find((b) => b.slug === blockType)
        if (!def) {
          errors.push({ path: `${path}.${i}.blockType`, message: `Unknown block type "${String(blockType)}".` })
          continue
        }
        errors.push(...(await validateFields(def.fields, row as Row, ctx, `${path}.${i}`)))
      }
    } else if (field.type === 'group' && value && typeof value === 'object') {
      errors.push(...(await validateFields(field.fields, value as Row, ctx, path)))
    }

    if (field.validate) {
      const result = await field.validate({
        value,
        data,
        siblingData: data,
        req: ctx.req,
        operation: ctx.operation,
      })
      if (result !== true) errors.push({ path, message: result })
    }
  }
  return errors
}

function validateFieldType(field: AnyField, value: unknown, label: string): string | null {
  switch (field.type) {
    case 'text':
    case 'textarea':
    case 'code':
    case 'email':
    case 'slug': {
      if (typeof value !== 'string') return `${label} must be text.`
      if (field.minLength !== undefined && value.length < field.minLength)
        return `${label} must be at least ${field.minLength} characters.`
      if (field.maxLength !== undefined && value.length > field.maxLength)
        return `${label} must be at most ${field.maxLength} characters.`
      if (field.type === 'email' && !EMAIL_RE.test(value)) return `${label} must be a valid email address.`
      if (field.type === 'slug' && !SLUG_RE.test(value)) return `${label} must be a lowercase, hyphenated slug.`
      if (field.pattern && !new RegExp(field.pattern).test(value)) return `${label} has an invalid format.`
      return null
    }
    case 'number': {
      if (typeof value !== 'number' || Number.isNaN(value)) return `${label} must be a number.`
      if (field.integer && !Number.isInteger(value)) return `${label} must be an integer.`
      if (field.min !== undefined && value < field.min) return `${label} must be at least ${field.min}.`
      if (field.max !== undefined && value > field.max) return `${label} must be at most ${field.max}.`
      return null
    }
    case 'boolean':
    case 'checkbox':
      return typeof value === 'boolean' ? null : `${label} must be true or false.`
    case 'date':
      return Number.isNaN(Date.parse(String(value))) ? `${label} must be a valid date.` : null
    case 'select':
    case 'radio': {
      const allowed = field.options.map(optionValue)
      if (field.hasMany) {
        if (!Array.isArray(value)) return `${label} must be a list.`
        for (const v of value) if (!allowed.includes(String(v))) return `${label} contains an invalid option.`
        return null
      }
      return allowed.includes(String(value)) ? null : `${label} must be one of: ${allowed.join(', ')}.`
    }
    case 'relationship':
    case 'upload': {
      const polymorphic = Array.isArray(field.relationTo)
      const isRef = (v: unknown): boolean => {
        if (!polymorphic) return typeof v === 'string' || typeof v === 'number'
        // Polymorphic: a { relationTo, value } pair. `value` is an id on write, or a
        // populated doc on a re-save.
        if (!v || typeof v !== 'object') return false
        const ref = v as { relationTo?: unknown; value?: unknown }
        return (
          typeof ref.relationTo === 'string' &&
          (typeof ref.value === 'string' ||
            typeof ref.value === 'number' ||
            (typeof ref.value === 'object' && ref.value !== null))
        )
      }
      if (field.hasMany) {
        if (!Array.isArray(value)) return `${label} must be a list of references.`
        return value.every(isRef) ? null : `${label} contains an invalid reference.`
      }
      if (isRef(value)) return null
      return polymorphic ? `${label} must be a { relationTo, value } reference.` : `${label} must be a reference id.`
    }
    case 'array':
      return Array.isArray(value) ? null : `${label} must be a list.`
    case 'blocks':
      return Array.isArray(value) ? null : `${label} must be a list of blocks.`
    case 'group':
      return value && typeof value === 'object' && !Array.isArray(value) ? null : `${label} must be an object.`
    case 'point':
      return Array.isArray(value) && value.length === 2 ? null : `${label} must be a [lng, lat] pair.`
    case 'richText': {
      if (typeof value === 'string') return null // legacy string shim (upgraded on write)
      const doc = value as Partial<KernelRichText> | null
      if (!doc || doc.type !== 'doc' || doc.v !== 1 || !Array.isArray(doc.children)) {
        return `${label} must be a rich-text document.`
      }
      return null
    }
    case 'json':
      return null
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Serialization between public documents and storage rows
// ---------------------------------------------------------------------------

function normalizeWrite(field: AnyField, value: unknown): unknown {
  if (value === undefined) return null
  if (field.type === 'date') {
    if (value instanceof Date) return value.toISOString()
    if (typeof value === 'number') return new Date(value).toISOString()
  }
  // Rich text is sanitized + normalized server-side before persisting (security §7);
  // this also upgrades legacy string values to the document model.
  if (field.type === 'richText' && value !== null) {
    return sanitizeRichText(asRichTextDoc(value), richTextSchemaFor(field)).doc
  }
  return value
}

export interface SerializeOptions {
  locale: string
  existingRow?: Row | null
}

/** Build a storage row from public field data, merging localized values. */
export function serializeDoc(fieldsIn: ConfigField[], data: Row, opts: SerializeOptions): Row {
  const fields = storageFields(fieldsIn)
  const row: Row = {}
  for (const field of fields) {
    const has = Object.prototype.hasOwnProperty.call(data, field.name)
    if (field.localized) {
      const existing = opts.existingRow?.[field.name]
      const map: Record<string, unknown> =
        existing && typeof existing === 'object' && !Array.isArray(existing)
          ? { ...(existing as Record<string, unknown>) }
          : {}
      if (has) map[opts.locale] = normalizeWrite(field, data[field.name])
      row[field.name] = map
    } else if (has) {
      row[field.name] = normalizeWrite(field, data[field.name])
    } else if (opts.existingRow && Object.prototype.hasOwnProperty.call(opts.existingRow, field.name)) {
      row[field.name] = opts.existingRow[field.name]
    }
  }
  return row
}

export interface DeserializeOptions {
  locale: string
  fallbackLocale: string | false
}

function resolveLocale(raw: unknown, locale: string, fallback: string | false): unknown {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const map = raw as Record<string, unknown>
    if (locale in map) return map[locale]
    if (fallback && fallback in map) return map[fallback]
    return null
  }
  return raw ?? null
}

/** Resolve a storage row into a public document body (localized values resolved). */
export function deserializeDoc(fieldsIn: ConfigField[], row: Row, opts: DeserializeOptions): Row {
  const fields = storageFields(fieldsIn)
  const doc: Row = {}
  for (const field of fields) {
    const raw = row[field.name]
    doc[field.name] = field.localized
      ? resolveLocale(raw, opts.locale, opts.fallbackLocale)
      : raw === undefined
        ? null
        : raw
  }
  return doc
}

/** Top-level relationship fields that can be populated. `polymorphic` is true when
 *  `relationTo` is a list — those values are stored as `{ relationTo, value }`. */
export function relationshipFields(
  fieldsIn: ConfigField[],
): Array<{ name: string; relationTo: string | string[]; hasMany: boolean; polymorphic: boolean }> {
  const fields = effectiveFields(fieldsIn)
  const out: Array<{ name: string; relationTo: string | string[]; hasMany: boolean; polymorphic: boolean }> = []
  for (const field of fields) {
    if (field.type === 'relationship' || field.type === 'upload') {
      out.push({
        name: field.name,
        relationTo: field.relationTo,
        hasMany: Boolean(field.hasMany),
        polymorphic: Array.isArray(field.relationTo),
      })
    }
  }
  return out
}
