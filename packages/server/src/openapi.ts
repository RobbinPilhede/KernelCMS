/**
 * OpenAPI 3.0 generation — turns the running config into a machine-readable
 * contract so the auto-generated CRUD surface AND user-defined custom endpoints
 * are discoverable, testable, and codegen-friendly. Pure: `kernel -> spec`.
 *
 * Collection/global field schemas are derived from the same `describeConfig`
 * descriptor the admin uses, so the documented shape can't drift from the real
 * one. Custom endpoints are documented at the path/method/params level (their
 * input validators are opaque `Parser`s); a request/response body is marked as a
 * free-form object, which Scalar still renders as a usable "try it" form.
 */
import { describeConfig } from '@kernel/core'
import type { AdminCollection, AdminField, AdminGlobal, EndpointConfig, Kernel } from '@kernel/core'

type JsonSchema = Record<string, unknown>

interface OpenApiOptions {
  apiBase: string
  title?: string
  version?: string
}

/** Map a single descriptor field to a JSON Schema fragment. */
function fieldSchema(field: AdminField): JsonSchema {
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

function propertiesOf(fields: AdminField[]): Record<string, JsonSchema> {
  const props: Record<string, JsonSchema> = {}
  for (const f of fields) props[f.name] = fieldSchema(f)
  return props
}

function docSchema(fields: AdminField[]): JsonSchema {
  const props = propertiesOf(fields)
  props.id = { type: 'string' }
  props.createdAt = { type: 'string', format: 'date-time' }
  props.updatedAt = { type: 'string', format: 'date-time' }
  return { type: 'object', properties: props }
}

const listEnvelope = (ref: string): JsonSchema => ({
  type: 'object',
  properties: {
    docs: { type: 'array', items: { $ref: ref } },
    totalDocs: { type: 'integer' },
    limit: { type: 'integer' },
    page: { type: 'integer' },
    totalPages: { type: 'integer' },
    hasPrevPage: { type: 'boolean' },
    hasNextPage: { type: 'boolean' },
    prevPage: { type: 'integer', nullable: true },
    nextPage: { type: 'integer', nullable: true },
    pagingCounter: { type: 'integer' },
  },
})

const json = (schema: JsonSchema) => ({ content: { 'application/json': { schema } } })
const errorRef = { $ref: '#/components/schemas/Error' }
const errorResponses = {
  '400': { description: 'Bad request', ...json(errorRef) },
  '401': { description: 'Unauthorized', ...json(errorRef) },
  '403': { description: 'Forbidden', ...json(errorRef) },
  '404': { description: 'Not found', ...json(errorRef) },
}

const LIST_QUERY_PARAMS = [
  { name: 'where', in: 'query', schema: { type: 'string' }, description: 'JSON or bracket-style filter' },
  { name: 'sort', in: 'query', schema: { type: 'string' } },
  { name: 'limit', in: 'query', schema: { type: 'integer' } },
  { name: 'page', in: 'query', schema: { type: 'integer' } },
  { name: 'depth', in: 'query', schema: { type: 'integer' } },
  { name: 'locale', in: 'query', schema: { type: 'string' } },
] as const

function collectionPaths(coll: AdminCollection, paths: Record<string, JsonSchema>): void {
  const ref = `#/components/schemas/${coll.slug}`
  const tag = coll.labels.plural
  const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string' } }
  paths[`/${coll.slug}`] = {
    get: {
      tags: [tag],
      summary: `List ${coll.labels.plural}`,
      parameters: LIST_QUERY_PARAMS,
      responses: { '200': { description: 'OK', ...json(listEnvelope(ref)) }, ...errorResponses },
    },
    post: {
      tags: [tag],
      summary: `Create a ${coll.labels.singular}`,
      requestBody: json({ $ref: ref }),
      responses: { '201': { description: 'Created', ...json({ $ref: ref }) }, ...errorResponses },
    },
  }
  paths[`/${coll.slug}/{id}`] = {
    get: {
      tags: [tag],
      summary: `Get a ${coll.labels.singular} by id`,
      parameters: [idParam],
      responses: { '200': { description: 'OK', ...json({ $ref: ref }) }, ...errorResponses },
    },
    patch: {
      tags: [tag],
      summary: `Update a ${coll.labels.singular}`,
      parameters: [idParam],
      requestBody: json({ $ref: ref }),
      responses: { '200': { description: 'OK', ...json({ $ref: ref }) }, ...errorResponses },
    },
    delete: {
      tags: [tag],
      summary: `Delete a ${coll.labels.singular}`,
      parameters: [idParam],
      responses: { '200': { description: 'OK', ...json({ $ref: ref }) }, ...errorResponses },
    },
  }
}

function globalPaths(global: AdminGlobal, paths: Record<string, JsonSchema>): void {
  const ref = `#/components/schemas/global_${global.slug}`
  paths[`/globals/${global.slug}`] = {
    get: {
      tags: ['Globals'],
      summary: `Get the ${global.label} global`,
      responses: { '200': { description: 'OK', ...json({ $ref: ref }) }, ...errorResponses },
    },
    post: {
      tags: ['Globals'],
      summary: `Update the ${global.label} global`,
      requestBody: json({ $ref: ref }),
      responses: { '200': { description: 'OK', ...json({ $ref: ref }) }, ...errorResponses },
    },
  }
}

function endpointPaths(endpoints: readonly EndpointConfig[], paths: Record<string, JsonSchema>): void {
  for (const ep of endpoints) {
    // Convert `/comments/:postId` to OpenAPI `/comments/{postId}` and collect params.
    const params: JsonSchema[] = []
    const oapiPath = ep.path.replace(/:([A-Za-z0-9_]+)/g, (_m, name: string) => {
      params.push({ name, in: 'path', required: true, schema: { type: 'string' } })
      return `{${name}}`
    })
    const op: JsonSchema = {
      tags: ep.tags ?? ['Custom'],
      summary: ep.summary ?? `${ep.method} ${ep.path}`,
      ...(params.length ? { parameters: params } : {}),
      responses: { '200': { description: 'OK', ...json({}) }, ...errorResponses },
    }
    if (ep.method !== 'GET' && ep.method !== 'DELETE' && ep.input?.body) {
      op.requestBody = json({ type: 'object' })
    }
    const existing = (paths[oapiPath] as Record<string, JsonSchema>) ?? {}
    existing[ep.method.toLowerCase()] = op
    paths[oapiPath] = existing
  }
}

/** Build an OpenAPI 3.0 document from the running kernel. */
export function buildOpenApiSpec(kernel: Kernel, options: OpenApiOptions): JsonSchema {
  const schema = describeConfig(kernel.config)
  const components: Record<string, JsonSchema> = {
    Error: {
      type: 'object',
      properties: {
        error: {
          type: 'object',
          properties: {
            code: { type: 'string' },
            message: { type: 'string' },
            details: {},
          },
          required: ['code', 'message'],
        },
      },
    },
  }
  const paths: Record<string, JsonSchema> = {}

  for (const coll of schema.collections) {
    if (coll.hidden) continue
    components[coll.slug] = docSchema(coll.fields)
    collectionPaths(coll, paths)
  }
  for (const global of schema.globals) {
    components[`global_${global.slug}`] = docSchema(global.fields)
    globalPaths(global, paths)
  }
  endpointPaths(kernel.config.endpoints ?? [], paths)

  return {
    openapi: '3.0.3',
    info: { title: options.title ?? 'KernelCMS API', version: options.version ?? '1.0.0' },
    servers: [{ url: options.apiBase }],
    paths,
    components: { schemas: components },
  }
}

/** A self-contained Scalar API-reference page that loads the spec from `specUrl`. */
export function scalarHtml(specUrl: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>KernelCMS API Reference</title>
  </head>
  <body>
    <script id="api-reference" data-url="${specUrl.replace(/"/g, '&quot;')}"></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>`
}
