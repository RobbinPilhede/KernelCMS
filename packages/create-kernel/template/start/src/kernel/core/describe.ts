/**
 * Produce a serializable description of the content model for the admin UI and
 * external tooling. Access functions, validators, and hooks are intentionally
 * omitted — only data needed to render forms and tables is included.
 */
import type { AnyField, CollectionConfig, FieldAdmin, FieldType, GlobalConfig, SanitizedConfig } from './types'
import { fieldLabel, optionLabel, optionValue } from './fields'

export interface AdminFieldOption {
  label: string
  value: string
}

export interface AdminField {
  name: string
  type: FieldType | 'password'
  label: string
  required: boolean
  unique: boolean
  localized: boolean
  hasMany?: boolean
  relationTo?: string
  options?: AdminFieldOption[]
  fields?: AdminField[]
  min?: number
  max?: number
  minLength?: number
  maxLength?: number
  admin?: Omit<FieldAdmin, 'condition'>
}

export interface AdminCollection {
  slug: string
  labels: { singular: string; plural: string }
  useAsTitle: string
  defaultColumns?: string[]
  group?: string
  description?: string
  auth: boolean
  hidden: boolean
  fields: AdminField[]
}

export interface AdminGlobal {
  slug: string
  label: string
  fields: AdminField[]
}

export interface AdminSchema {
  collections: AdminCollection[]
  globals: AdminGlobal[]
  localization: { locales: string[]; defaultLocale: string } | null
  routes: { api: string }
}

function describeField(field: AnyField): AdminField {
  const out: AdminField = {
    name: field.name,
    type: field.type,
    label: fieldLabel(field),
    required: Boolean(field.required),
    unique: Boolean(field.unique),
    localized: Boolean(field.localized),
  }
  if (field.admin) {
    const { condition, ...rest } = field.admin
    void condition
    out.admin = rest
  }
  if (field.type === 'select' || field.type === 'radio') {
    out.options = field.options.map((o) => ({ label: optionLabel(o), value: optionValue(o) }))
    out.hasMany = Boolean(field.hasMany)
  }
  if (field.type === 'relationship' || field.type === 'upload') {
    out.relationTo = field.relationTo
    out.hasMany = Boolean(field.hasMany)
  }
  if (field.type === 'array' || field.type === 'group') {
    out.fields = field.fields.map(describeField)
  }
  if (field.type === 'number') {
    if (field.min !== undefined) out.min = field.min
    if (field.max !== undefined) out.max = field.max
  }
  if (field.type === 'text' || field.type === 'textarea' || field.type === 'email' || field.type === 'code') {
    if (field.minLength !== undefined) out.minLength = field.minLength
    if (field.maxLength !== undefined) out.maxLength = field.maxLength
  }
  return out
}

function describeCollection(collection: CollectionConfig): AdminCollection {
  const fields = collection.fields.filter((f) => f.name !== 'hash').map(describeField)
  if (collection.auth) {
    fields.push({
      name: 'password',
      type: 'password',
      label: 'Password',
      required: false,
      unique: false,
      localized: false,
      admin: { description: 'Leave blank to keep the current password.' },
    })
  }
  return {
    slug: collection.slug,
    labels: {
      singular: collection.labels?.singular ?? collection.slug,
      plural: collection.labels?.plural ?? collection.slug,
    },
    useAsTitle: collection.admin?.useAsTitle ?? collection.fields[0]?.name ?? 'id',
    defaultColumns: collection.admin?.defaultColumns,
    group: collection.admin?.group,
    description: collection.admin?.description,
    auth: Boolean(collection.auth),
    hidden: Boolean(collection.admin?.hidden),
    fields,
  }
}

function describeGlobal(global: GlobalConfig): AdminGlobal {
  return {
    slug: global.slug,
    label: global.label ?? global.slug,
    fields: global.fields.map(describeField),
  }
}

export function describeConfig(config: SanitizedConfig): AdminSchema {
  return {
    collections: config.collections.map(describeCollection),
    globals: config.globals.map(describeGlobal),
    localization: config.localization
      ? { locales: config.localization.locales, defaultLocale: config.localization.defaultLocale }
      : null,
    routes: { api: config.routes.api },
  }
}
