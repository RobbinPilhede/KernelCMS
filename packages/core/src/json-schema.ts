/**
 * Pure field -> JSON Schema mapping over the `describeConfig` descriptor shapes.
 * Framework-agnostic so it can be shared by OpenAPI generation (`@kernel/server`)
 * and MCP tooling (`@kernel/mcp`) without pulling in any server dependency.
 */
import type { AdminField } from './describe'

export type JsonSchema = Record<string, unknown>

/** Map a single descriptor field to a JSON Schema fragment. */
export function fieldSchema(field: AdminField): JsonSchema {
  const wrapMany = (item: JsonSchema): JsonSchema => (field.hasMany ? { type: 'array', items: item } : item)
  switch (field.type) {
    case 'number':
      return { type: 'number' }
    case 'boolean':
    case 'checkbox':
      return { type: 'boolean' }
    case 'date':
      return { type: 'string', format: 'date-time' }
    case 'email':
      return { type: 'string', format: 'email' }
    case 'json':
    case 'point':
    case 'richText':
      return {} // free-form
    case 'select':
    case 'radio': {
      const values = (field.options ?? []).map((o) => o.value)
      return wrapMany(values.length ? { type: 'string', enum: values } : { type: 'string' })
    }
    case 'relationship':
    case 'upload':
      return wrapMany({ type: 'string', description: `Related id (${String(field.relationTo)})` })
    case 'group':
      return { type: 'object', properties: propertiesOf(field.fields ?? []) }
    case 'array':
      return { type: 'array', items: { type: 'object', properties: propertiesOf(field.fields ?? []) } }
    case 'blocks':
      return { type: 'array', items: { type: 'object' } }
    default:
      return { type: 'string' } // text, textarea, slug, code, password
  }
}

export function propertiesOf(fields: AdminField[]): Record<string, JsonSchema> {
  const props: Record<string, JsonSchema> = {}
  for (const f of fields) {
    // Never document hidden fields — these are server-managed columns
    // (hash/api_key/reset_token/totp_secret/…) whose names should not leak.
    if (f.admin?.hidden) continue
    props[f.name] = fieldSchema(f)
  }
  return props
}

export function docSchema(fields: AdminField[]): JsonSchema {
  const props = propertiesOf(fields)
  props.id = { type: 'string' }
  props.createdAt = { type: 'string', format: 'date-time' }
  props.updatedAt = { type: 'string', format: 'date-time' }
  return { type: 'object', properties: props }
}
