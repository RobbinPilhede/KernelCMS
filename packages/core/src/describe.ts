/**
 * Produce a serializable description of the content model for the admin UI and
 * external tooling. Access functions, validators, and hooks are intentionally
 * omitted — only data needed to render forms and tables is included.
 */
import type { AnyField, CollectionConfig, FieldAdmin, FieldType, GlobalConfig, SanitizedConfig } from './types'
import { effectiveFields, fieldLabel, humanize, optionLabel, optionValue, richTextSchemaFor } from './fields'
import { resolveVersions } from './schema'

/** Serializable description of a richText field's allow-list, for the admin editor. */
export interface AdminRichTextSchema {
  marks: string[]
  nodes: string[]
  headingLevels: number[]
  lists: { ordered: boolean; unordered: boolean }
  link: { enabled: boolean; allowNewTab: boolean; internalCollections: string[] }
  relationshipCollections: string[]
  uploadCollections: string[]
  blockSlugs: string[]
}

export interface AdminFieldOption {
  label: string
  value: string
}

export interface AdminBlock {
  slug: string
  labels: { singular: string; plural: string }
  fields: AdminField[]
  group?: string
  description?: string
  thumbnail?: string
}

export interface AdminField {
  name: string
  type: FieldType | 'password'
  label: string
  required: boolean
  unique: boolean
  localized: boolean
  hasMany?: boolean
  relationTo?: string | string[]
  options?: AdminFieldOption[]
  fields?: AdminField[]
  blocks?: AdminBlock[]
  defaultValue?: unknown
  min?: number
  max?: number
  minLength?: number
  maxLength?: number
  richText?: AdminRichTextSchema
  admin?: Omit<FieldAdmin, 'condition'>
  /** Computed field: not stored, derived on read, shown read-only. */
  virtual?: boolean
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
  upload: boolean
  livePreview?: { url: string }
  /** Present when the collection keeps a version history; `drafts` toggles the
   *  draft/published lifecycle (status pill, Save draft vs Publish). */
  versions?: { enabled: boolean; drafts: boolean }
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
  /** Whether to render the "Powered by KernelCMS" credit in the admin. */
  attribution: boolean
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
  // Computed fields are server-derived: surface as read-only so the admin never
  // tries to edit (or persist) them.
  if (field.virtual) {
    out.virtual = true
    out.admin = { ...(out.admin ?? {}), readOnly: true }
  }
  // Expose literal defaults so the admin can initialise new documents. Function
  // defaults are resolved server-side at create time, not here.
  if (field.defaultValue !== undefined && typeof field.defaultValue !== 'function') {
    out.defaultValue = field.defaultValue
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
    out.fields = effectiveFields(field.fields).map(describeField)
  }
  if (field.type === 'blocks') {
    out.blocks = field.blocks.map((b) => {
      const block: AdminBlock = {
        slug: b.slug,
        labels: {
          singular: b.labels?.singular ?? b.slug,
          plural: b.labels?.plural ?? b.slug,
        },
        fields: effectiveFields(b.fields).map(describeField),
      }
      if (b.admin?.group) block.group = b.admin.group
      if (b.admin?.description) block.description = b.admin.description
      if (b.admin?.thumbnail) block.thumbnail = b.admin.thumbnail
      return block
    })
  }
  if (field.type === 'number') {
    if (field.min !== undefined) out.min = field.min
    if (field.max !== undefined) out.max = field.max
  }
  if (field.type === 'text' || field.type === 'textarea' || field.type === 'email' || field.type === 'code') {
    if (field.minLength !== undefined) out.minLength = field.minLength
    if (field.maxLength !== undefined) out.maxLength = field.maxLength
  }
  if (field.type === 'richText') {
    const s = richTextSchemaFor(field)
    out.richText = {
      marks: [...s.marks],
      nodes: [...s.nodes],
      headingLevels: [...s.headingLevels],
      lists: s.lists,
      link: {
        enabled: s.link.enabled,
        allowNewTab: s.link.allowNewTab,
        internalCollections: [...s.link.internalCollections],
      },
      relationshipCollections: [...s.relationshipCollections],
      uploadCollections: [...s.uploadCollections],
      blockSlugs: [...s.blockSlugs],
    }
  }
  return out
}

function describeCollection(collection: CollectionConfig): AdminCollection {
  const fields = effectiveFields(collection.fields)
    .filter((f) => f.name !== 'hash')
    .map(describeField)
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
      singular: collection.labels?.singular ?? humanize(collection.slug),
      plural: collection.labels?.plural ?? humanize(collection.slug),
    },
    useAsTitle: collection.admin?.useAsTitle ?? effectiveFields(collection.fields)[0]?.name ?? 'id',
    defaultColumns: collection.admin?.defaultColumns,
    group: collection.admin?.group,
    description: collection.admin?.description,
    auth: Boolean(collection.auth),
    hidden: Boolean(collection.admin?.hidden),
    upload: Boolean(collection.upload),
    ...(collection.admin?.livePreview ? { livePreview: collection.admin.livePreview } : {}),
    ...(() => {
      const v = resolveVersions(collection.versions)
      return v.enabled ? { versions: { enabled: true, drafts: v.drafts } } : {}
    })(),
    fields,
  }
}

function describeGlobal(global: GlobalConfig): AdminGlobal {
  return {
    slug: global.slug,
    label: global.label ?? humanize(global.slug),
    fields: effectiveFields(global.fields).map(describeField),
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
    attribution: config.attribution,
  }
}
