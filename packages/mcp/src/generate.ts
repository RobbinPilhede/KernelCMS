/**
 * Pure descriptor -> MCP tool manifest. Mirrors the OpenAPI generation in
 * `@kernel/server`: both consume `describeConfig(...)` and the shared JSON-Schema
 * mapper from `@kernel/core`, so the agent surface and the HTTP surface never drift.
 *
 * No kernel, no transport, no access logic here — this only describes the tools.
 * Dispatch + access enforcement live in `server.ts`.
 */
import type { AdminBlock, AdminCollection, AdminGlobal, AdminSchema, EndpointConfig, JsonSchema } from '@kernel/core'
import { propertiesOf } from '@kernel/core'

/** The Local API operation a tool maps to. The server switches on this, never on
 *  the tool name's string shape, so renaming a slug can't misroute a call. */
export type ToolOp =
  | 'find'
  | 'findByID'
  | 'create'
  | 'update'
  | 'delete'
  | 'findGlobal'
  | 'updateGlobal'
  | 'count'
  | 'findVersions'
  | 'composePage'
  | 'invokeEndpoint'

/** MCP tool behaviour hints (SDK `ToolAnnotations`). Advisory only — the core
 *  access pipeline is what actually enforces anything; these just let a client
 *  label/group tools (read-only, destructive, …) for the human in the loop. */
export interface ToolAnnotations {
  title?: string
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
}

export interface ToolDef {
  name: string
  description: string
  /** A JSON Schema `object` the MCP client validates arguments against. */
  inputSchema: JsonSchema
  /** Behaviour hints surfaced to the client (and the human approving calls). */
  annotations: ToolAnnotations
  /** Wiring metadata the dispatcher uses; not sent to the client. */
  op: ToolOp
  /** Collection slug or global slug this tool targets. */
  target: string
  /** For `invokeEndpoint` tools: the author's endpoint + its `:param` names, so the
   *  dispatcher can rebuild raw endpoint input from the flat tool args. */
  endpoint?: EndpointConfig
  paramNames?: string[]
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
  const tools: ToolDef[] = [
    {
      name: `${coll.slug}_list`,
      description: `List ${noun} (paginated, access-filtered).`,
      op: 'find',
      target: coll.slug,
      annotations: { title: `List ${noun}`, readOnlyHint: true },
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
      annotations: { title: `Get ${coll.labels.singular}`, readOnlyHint: true },
      inputSchema: objectSchema({ id: ID, depth: DEPTH, locale: LOCALE }, ['id']),
    },
    {
      name: `${coll.slug}_count`,
      description: `Count ${noun} matching an optional filter (access-filtered).`,
      op: 'count',
      target: coll.slug,
      annotations: { title: `Count ${noun}`, readOnlyHint: true },
      inputSchema: objectSchema({ where: WHERE }, []),
    },
  ]
  // Versions: only for collections that keep a history. Lets an agent (or a human)
  // review change history — including filtering to agent-authored snapshots.
  if (coll.versions?.enabled) {
    tools.push({
      name: `${coll.slug}_versions`,
      description: `List the version history of a ${coll.labels.singular} (access-checked).`,
      op: 'findVersions',
      target: coll.slug,
      annotations: { title: `${coll.labels.singular} versions`, readOnlyHint: true },
      inputSchema: objectSchema(
        {
          id: ID,
          limit: { type: 'number', description: 'Page size.' },
          page: { type: 'number', description: 'Page number (1-based).' },
          createdByType: {
            type: 'string',
            enum: ['user', 'agent'],
            description: 'Only versions authored by this kind of principal.',
          },
        },
        ['id'],
      ),
    })
  }
  return tools
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
      // Create is NOT idempotent: each call yields a new document.
      annotations: { title: `Create ${coll.labels.singular}` },
      inputSchema: objectSchema(dataProps, required),
    },
    {
      // Update: id required, every data field optional (partial patch).
      name: `${coll.slug}_update`,
      description: `Update an existing ${coll.labels.singular} by id.`,
      op: 'update',
      target: coll.slug,
      annotations: { title: `Update ${coll.labels.singular}`, idempotentHint: true },
      inputSchema: objectSchema({ id: ID, ...dataProps }, ['id']),
    },
    {
      name: `${coll.slug}_delete`,
      description: `Delete a ${coll.labels.singular} by id.`,
      op: 'delete',
      target: coll.slug,
      annotations: { title: `Delete ${coll.labels.singular}`, destructiveHint: true, idempotentHint: true },
      inputSchema: objectSchema({ id: ID }, ['id']),
    },
  ]
}

/** Storage-bearing blocks fields on a collection (recurses presentational containers,
 *  which `describeConfig` already flattens — so a top-level scan suffices here). */
function blocksFieldsOf(coll: AdminCollection): { name: string; blocks: AdminBlock[] }[] {
  const out: { name: string; blocks: AdminBlock[] }[] = []
  for (const f of coll.fields) {
    if (f.type === 'blocks' && Array.isArray(f.blocks)) out.push({ name: f.name, blocks: f.blocks })
  }
  return out
}

/**
 * The `compose_page` tool: assemble a `blocks` layout from a structured spec in one
 * validated call, created as an agent-authored DRAFT (so it lands in the review inbox).
 * Emitted only for collections that actually have a blocks field. `field` is required
 * when the collection has more than one blocks field (ambiguous otherwise). The core op
 * validates every block type/field, so the schema here is intentionally permissive on
 * `data` shape and lets core return a precise BadRequest for anything invalid.
 */
function composeTools(coll: AdminCollection): ToolDef[] {
  const blockFields = blocksFieldsOf(coll)
  if (blockFields.length === 0) return []
  const allBlockSlugs = [...new Set(blockFields.flatMap((bf) => bf.blocks.map((b) => b.slug)))]
  const fieldProp: Record<string, JsonSchema> =
    blockFields.length > 1
      ? {
          field: {
            type: 'string',
            enum: blockFields.map((bf) => bf.name),
            description: 'Which blocks field to assemble into.',
          },
        }
      : { field: { type: 'string', description: 'Blocks field to assemble into (defaults to the only one).' } }
  const required = blockFields.length > 1 ? ['blocks', 'field'] : ['blocks']
  return [
    {
      name: `${coll.slug}_compose_page`,
      description:
        `Assemble a ${coll.labels.singular} blocks layout from a list of blocks and create it ` +
        `as a draft (lands in the review inbox). Block types: ${allBlockSlugs.join(', ') || '(none)'}.`,
      op: 'composePage',
      target: coll.slug,
      // Create-shaped: not idempotent, not destructive, not read-only. The draft-only
      // brake + field scope + access all apply (it goes through create()).
      annotations: { title: `Compose ${coll.labels.singular}` },
      inputSchema: objectSchema(
        {
          ...fieldProp,
          blocks: {
            type: 'array',
            description: 'Ordered blocks to assemble.',
            items: objectSchema(
              {
                type: { type: 'string', description: 'Block slug (must match the field schema).' },
                data: { type: 'object', description: 'Block field values (keys must be fields of that block).' },
              },
              ['type'],
            ),
          },
          data: { type: 'object', description: 'Other top-level fields to set on the document.' },
        },
        required,
      ),
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
      annotations: { title: `Get ${global.label}`, readOnlyHint: true },
      inputSchema: objectSchema({ depth: DEPTH, locale: LOCALE }, []),
    },
    {
      name: `${global.slug}_update_global`,
      description: `Update the ${global.label} global.`,
      op: 'updateGlobal',
      target: global.slug,
      annotations: { title: `Update ${global.label}`, idempotentHint: true },
      inputSchema: objectSchema(dataProps, []),
    },
  ]
}

/** Extract `:param` names from an endpoint path, in order. */
function pathParams(path: string): string[] {
  const names: string[] = []
  for (const seg of path.split('/')) {
    if (seg.startsWith(':')) names.push(seg.slice(1))
  }
  return names
}

/** Sanitize an arbitrary string into a stable `[a-z0-9_]+` tool name fragment. */
function sanitizeName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/**
 * Tools for OPT-IN custom endpoints (`endpoint.mcp === true`). Each runs the
 * author's own handler — the most powerful surface here — so exposure is opt-in
 * and the endpoint's `access` rule is the gate (enforced via `invokeEndpoint` with
 * the agent req). Endpoints without the flag are never exposed (least surprise).
 *
 * SECURITY: an endpoint handler that calls `local.*` with `overrideAccess` runs
 * OUTSIDE the agent field-scope/draft brakes — do not set `mcp: true` on such an
 * endpoint, or a scoped agent gains full, unbrakable read/write through it.
 *
 * Input schema: required string props for each `:param`, plus a free-form `body`
 * object. The endpoint's input parsers are opaque (`Parser<T>`), so — exactly as
 * OpenAPI marks them — the body is described as an unconstrained object.
 */
function endpointTools(endpoints: readonly EndpointConfig[]): ToolDef[] {
  const tools: ToolDef[] = []
  for (const ep of endpoints) {
    if (ep.mcp !== true) continue
    const params = pathParams(ep.path)
    const base = ep.summary ? sanitizeName(ep.summary) : sanitizeName(`${ep.method}_${ep.path}`)
    const name = base.length ? base : sanitizeName(`${ep.method}_${ep.path}`)
    const props: Record<string, JsonSchema> = {}
    for (const p of params) {
      props[p] = { type: 'string', description: `Path parameter :${p}.` }
    }
    if (ep.input?.body) {
      props.body = { type: 'object', description: 'Request body (validated by the endpoint).' }
    }
    tools.push({
      name,
      description: ep.summary ?? `${ep.method} ${ep.path}`,
      op: 'invokeEndpoint',
      target: name,
      // Custom handlers can do anything; surface as non-readonly without a finer
      // hint (we can't infer the handler's effect). The access rule is the guard.
      annotations: { title: ep.summary ?? `${ep.method} ${ep.path}` },
      inputSchema: objectSchema(props, params),
      endpoint: ep,
      paramNames: params,
    })
  }
  return tools
}

/**
 * Build the full tool manifest from a content-model descriptor (and, optionally,
 * the raw custom endpoints — those carry the author's handler, which `describeConfig`
 * intentionally omits). Hidden collections are skipped entirely, as are auth
 * collections — handing an agent user/credential CRUD is a footgun we close here
 * even though the core access pipeline would also gate it.
 */
export function generateTools(schema: AdminSchema, endpoints: readonly EndpointConfig[] = []): ToolDef[] {
  const tools: ToolDef[] = []
  for (const coll of schema.collections) {
    if (coll.hidden || coll.auth) continue
    tools.push(...listTools(coll), ...writeTools(coll), ...composeTools(coll))
  }
  for (const global of schema.globals) {
    tools.push(...globalTools(global))
  }
  tools.push(...endpointTools(endpoints))
  return tools
}
