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
import { describeConfig, docSchema } from '@kernel/core'
// fieldSchema/propertiesOf/docSchema moved to @kernel/core's json-schema so
// @kernel/mcp can reuse the same field -> JSON Schema mapping without depending
// on @kernel/server. Only docSchema is referenced here.
import type { AdminCollection, AdminGlobal, EndpointConfig, JsonSchema, Kernel } from '@kernel/core'

interface OpenApiOptions {
  apiBase: string
  title?: string
  version?: string
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
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1" crossorigin="anonymous"></script>
  </body>
</html>`
}
