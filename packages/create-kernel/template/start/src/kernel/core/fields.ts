import type { ColumnSchema, Row, StorageType } from '@kernel/db'
import type { AnyField, RequestContext, SelectOption } from './types'
import type { FieldError } from './errors'

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
      return 'json'
    case 'select':
    case 'radio':
      return field.hasMany ? 'json' : 'text'
    case 'relationship':
    case 'upload':
      return field.hasMany ? 'json' : 'text'
    default:
      return 'text'
  }
}

export function columnForField(field: AnyField): ColumnSchema {
  const column: ColumnSchema = {
    name: field.name,
    type: storageTypeForField(field),
    required: Boolean(field.required),
    unique: Boolean(field.unique),
    indexed: Boolean(field.index ?? field.unique),
    localized: Boolean(field.localized),
  }
  if ((field.type === 'relationship' || field.type === 'upload') && !field.hasMany) {
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

export function applyDefaults(fields: AnyField[], data: Row): Row {
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
  return (
    value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  )
}

export interface ValidateContext {
  req: RequestContext
  operation: 'create' | 'update'
}

export async function validateFields(
  fields: AnyField[],
  data: Row,
  ctx: ValidateContext,
  prefix = '',
): Promise<FieldError[]> {
  const errors: FieldError[] = []
  for (const field of fields) {
    const path = prefix ? `${prefix}.${field.name}` : field.name
    const value = data?.[field.name]
    const label = fieldLabel(field)

    if (isEmpty(value)) {
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
      if (field.hasMany) return Array.isArray(value) ? null : `${label} must be a list of references.`
      return typeof value === 'string' || typeof value === 'number' ? null : `${label} must be a reference id.`
    }
    case 'array':
      return Array.isArray(value) ? null : `${label} must be a list.`
    case 'group':
      return value && typeof value === 'object' && !Array.isArray(value) ? null : `${label} must be an object.`
    case 'point':
      return Array.isArray(value) && value.length === 2 ? null : `${label} must be a [lng, lat] pair.`
    case 'json':
    case 'richText':
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
  return value
}

export interface SerializeOptions {
  locale: string
  existingRow?: Row | null
}

/** Build a storage row from public field data, merging localized values. */
export function serializeDoc(fields: AnyField[], data: Row, opts: SerializeOptions): Row {
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
export function deserializeDoc(fields: AnyField[], row: Row, opts: DeserializeOptions): Row {
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

/** Top-level relationship fields that can be populated. */
export function relationshipFields(
  fields: AnyField[],
): Array<{ name: string; relationTo: string; hasMany: boolean }> {
  const out: Array<{ name: string; relationTo: string; hasMany: boolean }> = []
  for (const field of fields) {
    if (field.type === 'relationship' || field.type === 'upload') {
      out.push({ name: field.name, relationTo: field.relationTo, hasMany: Boolean(field.hasMany) })
    }
  }
  return out
}
