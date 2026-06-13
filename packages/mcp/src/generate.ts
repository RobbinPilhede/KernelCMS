/**
 * Pure descriptor -> MCP tool manifest. Mirrors the OpenAPI generation in
 * `@kernel/server`: both consume `describeConfig(...)` and the shared JSON-Schema
 * mapper from `@kernel/core`, so the agent surface and the HTTP surface never drift.
 *
 * No kernel, no transport, no access logic here — this only describes the tools.
 * Dispatch + access enforcement live in `server.ts`.
 */
import type { AdminCollection, AdminGlobal, AdminSchema, JsonSchema } from '@kernel/core'
import { propertiesOf } from '@kernel/core'

/** The Local API operation a tool maps to. The server switches on this, never on
 *  the tool name's string shape, so renaming a slug can't misroute a call. */
export type ToolOp = 'find' | 'findByID' | 'create' | 'update' | 'delete' | 'findGlobal' | 'updateGlobal'

export interface ToolDef {
  name: string
  description: string
  /** A JSON Schema `object` the MCP client validates arguments against. */
  inputSchema: JsonSchema
  /** Wiring metadata the dispatcher uses; not sent to the client. */
  op: ToolOp
  /** Collection slug or global slug this tool targets. */
  target: string
}

/** A JSON Schema object envelope. `additionalProperties:false` keeps agents from
 *  smuggling fields the schema doesn't name (e.g. `_status`) past the client. */
function objectSchema(properties: Record<string, JsonSchema>, required: string[]): JsonSchema {
  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  }
}

// Shared read controls. `where` is free-form (the Local API validates operators and
// rejects unknown ones with a 400), `locale`/`depth`/`page`/`limit`/`sort` mirror the ops.
const WHERE: JsonSchema = { type: 'object', description: 'Query filter (Kernel where-clause).' }
const SORT: JsonSchema = { type: 'string', description: 'Sort field, prefix with - for descending.' }
const DEPTH: JsonSchema = { type: 'number', description: 'Relationship population depth.' }
const LOCALE: JsonSchema = { type: 'string', description: 'Locale for localized fields.' }
const ID: JsonSchema = { type: 'string', description: 'Document id.' }

function listTools(coll: AdminCollection): ToolDef[] {
  const noun = coll.labels.plural
  return [
    {
      name: `${coll.slug}_list`,
      description: `List ${noun} (paginated, access-filtered).`,
      op: 'find',
      target: coll.slug,
      inputSchema: objectSchema(
        {
          where: WHERE,
          sort: SORT,
          limit: { type: 'number', description: 'Page size.' },
          page: { type: 'number', description: 'Page number (1-based).' },
          depth: DEPTH,
          locale: LOCALE,
        },
        [],
      ),
    },
    {
      name: `${coll.slug}_get`,
      description: `Get a single ${coll.labels.singular} by id.`,
      op: 'findByID',
      target: coll.slug,
      inputSchema: objectSchema({ id: ID, depth: DEPTH, locale: LOCALE }, ['id']),
    },
  ]
}

function writeTools(coll: AdminCollection): ToolDef[] {
  // The mapper already drops hidden/server-managed columns (hash, api_key, …) and
  // never emits `_status`, so agents can't publish through a generated write tool.
  const dataProps = propertiesOf(coll.fields)
  const required = coll.fields.filter((f) => f.required && !f.admin?.hidden).map((f) => f.name)
  return [
    {
      name: `${coll.slug}_create`,
      description: `Create a new ${coll.labels.singular} (agents create drafts).`,
      op: 'create',
      target: coll.slug,
      inputSchema: objectSchema(dataProps, required),
    },
    {
      // Update: id required, every data field optional (partial patch).
      name: `${coll.slug}_update`,
      description: `Update an existing ${coll.labels.singular} by id.`,
      op: 'update',
      target: coll.slug,
      inputSchema: objectSchema({ id: ID, ...dataProps }, ['id']),
    },
    {
      name: `${coll.slug}_delete`,
      description: `Delete a ${coll.labels.singular} by id.`,
      op: 'delete',
      target: coll.slug,
      inputSchema: objectSchema({ id: ID }, ['id']),
    },
  ]
}

function globalTools(global: AdminGlobal): ToolDef[] {
  const dataProps = propertiesOf(global.fields)
  return [
    {
      name: `${global.slug}_get_global`,
      description: `Get the ${global.label} global.`,
      op: 'findGlobal',
      target: global.slug,
      inputSchema: objectSchema({ depth: DEPTH, locale: LOCALE }, []),
    },
    {
      name: `${global.slug}_update_global`,
      description: `Update the ${global.label} global.`,
      op: 'updateGlobal',
      target: global.slug,
      inputSchema: objectSchema(dataProps, []),
    },
  ]
}

/**
 * Build the full tool manifest from a content-model descriptor. Hidden collections
 * are skipped entirely (they don't belong on the agent surface), as are auth
 * collections — handing an agent user/credential CRUD is a footgun we close here
 * even though the core access pipeline would also gate it.
 */
export function generateTools(schema: AdminSchema): ToolDef[] {
  const tools: ToolDef[] = []
  for (const coll of schema.collections) {
    if (coll.hidden || coll.auth) continue
    tools.push(...listTools(coll), ...writeTools(coll))
  }
  for (const global of schema.globals) {
    tools.push(...globalTools(global))
  }
  return tools
}
