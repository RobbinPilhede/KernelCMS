/**
 * Builds an MCP `Server` over a KernelCMS instance. Tools are auto-generated from
 * the content-model descriptor; every CallTool is dispatched through the in-process
 * Local API with an AGENT PRINCIPAL.
 *
 * SECURITY MODEL: this layer enforces NOTHING on its own. It only stamps the call
 * with `req.user = { ...principal, principalType: 'agent' }` and forwards to the op.
 * `overrideAccess` is never set (stays falsy), so the core access pipeline runs on
 * every call exactly as it does for a human — same rules, plus the agent brakes
 * (fieldScope allow/deny, draft-only). Do not add access checks here.
 */
import { timingSafeEqual } from 'node:crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type { CallToolResult, ReadResourceResult } from '@modelcontextprotocol/sdk/types.js'
import type { AdminCollection, AdminSchema, AuthUser, EndpointConfig, FieldScope, Kernel, RequestContext, Where } from '@kernel/core'
import { describeConfig, invokeEndpoint, isKernelError } from '@kernel/core'
import { generateTools, type ToolDef } from './generate'

/** The agent identity the server acts as. `principalType` is forced to `'agent'`
 *  internally — callers cannot pass `'user'` to escape the agent brakes. */
export interface AgentPrincipal {
  id: string
  roles?: string[]
  fieldScope?: FieldScope
}

export interface McpServerOptions {
  principal: AgentPrincipal
  /** Server identity reported to the client during initialize. */
  name?: string
  version?: string
}

/** Constant-time string compare that never short-circuits on content; length
 *  mismatch is the only early-out (and reveals nothing about the secret bytes). */
function timingEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/**
 * Resolve a presented bearer token to a configured agent principal, or null.
 * Mirrors `@kernel/server`'s `matchAgent`/`resolveAuth` agent branch EXACTLY:
 * every candidate is compared with a constant-time check and the loop never
 * short-circuits on the first match, so a timing side-channel can't reveal which
 * agent (if any) a token belongs to. The returned principal is always an agent
 * (`principalType:'agent'`) and carries no `overrideAccess` — the core access
 * pipeline (plus the agent draft-only brake + fieldScope) is the only gate.
 */
export function resolveAgentPrincipal(kernel: Kernel, token: string): AuthUser | null {
  if (token.length === 0) return null
  let matched: AgentPrincipal | null = null
  for (const agent of kernel.config.agents) {
    // No early-out on the first hit: keep scanning so total work (and thus timing)
    // doesn't depend on WHICH agent matched.
    if (timingEqual(token, agent.token) && !matched) {
      matched = { id: agent.id, roles: agent.roles ?? [], ...(agent.fieldScope ? { fieldScope: agent.fieldScope } : {}) }
    }
  }
  if (!matched) return null
  return {
    id: matched.id,
    principalType: 'agent',
    roles: matched.roles ?? [],
    ...(matched.fieldScope ? { fieldScope: matched.fieldScope } : {}),
  }
}

/** Args arrive as untyped JSON from the client; narrow at the boundary. */
type ToolArgs = Record<string, unknown>

function asArgs(value: unknown): ToolArgs {
  return value && typeof value === 'object' ? (value as ToolArgs) : {}
}

/** Pull a required string id out of untrusted args, or throw a clean client error. */
function requireId(args: ToolArgs): string {
  const id = args.id
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('A string "id" argument is required.')
  }
  return id
}

/** Optional positive integer (depth/limit/page) or undefined; rejects junk. */
function optNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function optString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Strip the control keys so the remainder is the document data for create/update. */
function dataFrom(args: ToolArgs): Record<string, unknown> {
  const { id, depth, locale, ...data } = args
  void id
  void depth
  void locale
  return data
}

function textResult(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] }
}

/** Surface op failures as MCP tool errors. Kernel errors carry a safe, public
 *  message; anything else is reported generically so internals/stack never leak. */
function errorResult(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : 'The tool call failed.'
  return { content: [{ type: 'text', text: message }], isError: true }
}

// Resource URIs. `kernel://schema` is the whole model; `kernel://collections/<slug>`
// is one collection's descriptor.
const SCHEMA_URI = 'kernel://schema'
const COLLECTION_PREFIX = 'kernel://collections/'

function collectionUri(slug: string): string {
  return `${COLLECTION_PREFIX}${encodeURIComponent(slug)}`
}

/** Extract the slug from a `kernel://collections/<slug>` URI, or null if it isn't one. */
function collectionSlugFromUri(uri: string): string | null {
  if (!uri.startsWith(COLLECTION_PREFIX)) return null
  const raw = uri.slice(COLLECTION_PREFIX.length)
  if (!raw) return null
  try {
    return decodeURIComponent(raw)
  } catch {
    return null
  }
}

/** Wrap a JSON-serializable descriptor as a single text resource content block. */
function jsonResource(uri: string, payload: AdminSchema | AdminCollection): ReadResourceResult {
  return {
    contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(payload, null, 2) }],
  }
}

/**
 * Create an MCP server bound to `kernel`, acting as `options.principal`.
 * The returned `Server` is transport-agnostic — wire it to stdio (see `stdio.ts`)
 * or any other transport the SDK provides.
 */
export function createMcpServer(kernel: Kernel, options: McpServerOptions): Server {
  // describeConfig already strips secrets/hidden columns and auth-collection
  // internals, so the descriptor is safe to expose verbatim as a resource.
  const schema = describeConfig(kernel.config)
  const tools = generateTools(schema, kernel.config.endpoints ?? [])
  const byName = new Map<string, ToolDef>(tools.map((t) => [t.name, t]))

  // Resources let an agent DISCOVER the content model before calling tools. The
  // per-collection descriptors exclude hidden + auth collections, matching the
  // tool surface (no user/credential schema is ever introspectable).
  const visibleCollections = schema.collections.filter((c) => !c.hidden && !c.auth)

  // Build the request context once per call. principalType is hard-pinned to
  // 'agent'; overrideAccess is deliberately omitted (falsy) so access is enforced.
  const reqFor = (): Partial<RequestContext> => ({
    user: {
      id: options.principal.id,
      principalType: 'agent',
      ...(options.principal.roles ? { roles: options.principal.roles } : {}),
      ...(options.principal.fieldScope ? { fieldScope: options.principal.fieldScope } : {}),
    },
  })

  const server = new Server(
    { name: options.name ?? 'kernelcms', version: options.version ?? '0.0.0' },
    { capabilities: { tools: {}, resources: {} } },
  )

  // ── Resources (introspection) ─────────────────────────────────────────────
  // Read-only and unauthenticated at this layer: they expose only the already
  // secret-stripped descriptor, nothing that depends on the caller's identity.
  server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: [
      {
        uri: SCHEMA_URI,
        name: 'Content model',
        description: 'The full KernelCMS content-model descriptor (collections, globals, fields).',
        mimeType: 'application/json',
      },
      ...visibleCollections.map((c) => ({
        uri: collectionUri(c.slug),
        name: `${c.labels.singular} schema`,
        description: `Descriptor for the "${c.slug}" collection.`,
        mimeType: 'application/json',
      })),
    ],
  }))

  server.setRequestHandler(ReadResourceRequestSchema, (request): ReadResourceResult => {
    const { uri } = request.params
    if (uri === SCHEMA_URI) return jsonResource(uri, schema)
    const slug = collectionSlugFromUri(uri)
    if (slug !== null) {
      const coll = visibleCollections.find((c) => c.slug === slug)
      if (coll) return jsonResource(uri, coll)
    }
    // Unknown/hidden/auth collection: refuse rather than disclose its existence.
    throw new Error(`Unknown resource: ${uri}`)
  })

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: t.annotations,
    })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const tool = byName.get(request.params.name)
    if (!tool) return errorResult(new Error(`Unknown tool: ${request.params.name}`))

    const args = asArgs(request.params.arguments)
    const req = reqFor()

    try {
      const result = await dispatch(kernel, tool, args, req)
      return textResult(result)
    } catch (err) {
      // KernelError (Forbidden/Unauthorized/Validation/…) and unexpected errors
      // both funnel through here; neither leaks a stack to the agent.
      if (err instanceof Error && !isKernelError(err)) {
        // Unexpected: log server-side (operators need it to diagnose), but the
        // client still gets a generic message — no stack/internals leak to the agent.
        console.error(`[KernelCMS MCP] tool "${request.params.name}" failed:`, err)
        return errorResult(new Error('The tool call failed.'))
      }
      return errorResult(err)
    }
  })

  return server
}

/** Narrow a tool arg to the `'user' | 'agent'` principal kind, or undefined. */
function optPrincipalType(value: unknown): 'user' | 'agent' | undefined {
  return value === 'user' || value === 'agent' ? value : undefined
}

/** Build raw endpoint input from flat tool args: declared `:param`s become string
 *  path params, the rest of the body rides under `body`. `invokeEndpoint` re-runs
 *  the endpoint's own parsers, so anything malformed becomes a ValidationError. */
function endpointInput(
  paramNames: readonly string[],
  args: ToolArgs,
): { params: Record<string, string>; body?: unknown } {
  const params: Record<string, string> = {}
  for (const name of paramNames) {
    const value = args[name]
    if (typeof value === 'string') params[name] = value
  }
  return { params, body: args.body }
}

/** Route a generated tool to its Local API op (or custom endpoint). `req` carries
 *  the agent principal; `overrideAccess` is never passed, so access is enforced. */
async function dispatch(
  kernel: Kernel,
  tool: ToolDef,
  args: ToolArgs,
  req: Partial<RequestContext>,
): Promise<unknown> {
  const { op, target } = tool
  switch (op) {
    case 'find':
      return kernel.find({
        collection: target,
        where: args.where && typeof args.where === 'object' ? (args.where as Where) : undefined,
        sort: optString(args.sort),
        limit: optNumber(args.limit),
        page: optNumber(args.page),
        depth: optNumber(args.depth),
        ...localeReq(req, args),
      })
    case 'findByID':
      return kernel.findByID({
        collection: target,
        id: requireId(args),
        depth: optNumber(args.depth),
        // Agents work on drafts; read the latest content so they see their own writes.
        draft: true,
        ...localeReq(req, args),
      })
    case 'create':
      return kernel.create({ collection: target, data: dataFrom(args), ...localeReq(req, args) })
    case 'update':
      return kernel.update({
        collection: target,
        id: requireId(args),
        data: dataFrom(args),
        ...localeReq(req, args),
      })
    case 'delete':
      return kernel.delete({ collection: target, id: requireId(args), ...localeReq(req, args) })
    case 'findGlobal':
      return kernel.findGlobal({ slug: target, depth: optNumber(args.depth), ...localeReq(req, args) })
    case 'updateGlobal':
      return kernel.updateGlobal({ slug: target, data: dataFrom(args), ...localeReq(req, args) })
    case 'count':
      return kernel.count({
        collection: target,
        where: args.where && typeof args.where === 'object' ? (args.where as Where) : undefined,
        ...localeReq(req, args),
      })
    case 'findVersions':
      return kernel.findVersions({
        collection: target,
        id: requireId(args),
        limit: optNumber(args.limit),
        page: optNumber(args.page),
        createdByType: optPrincipalType(args.createdByType),
        ...localeReq(req, args),
      })
    case 'invokeEndpoint': {
      // OPT-IN custom endpoint. The endpoint's `access` rule is the gate: we pass the
      // agent `req` and never set overrideAccess, so invokeEndpoint authorizes the
      // agent exactly as the HTTP path would, then runs the author's handler.
      const endpoint = tool.endpoint as EndpointConfig
      const { req: scoped } = localeReq(req, args)
      return invokeEndpoint(kernel, endpoint, {
        input: endpointInput(tool.paramNames ?? [], args),
        req: scoped as RequestContext,
      })
    }
    default: {
      // Exhaustiveness: a new ToolOp must be handled above.
      const never: never = op
      throw new Error(`Unhandled op: ${String(never)}`)
    }
  }
}

/** Merge the per-call locale (if the client supplied one) into the agent req. */
function localeReq(req: Partial<RequestContext>, args: ToolArgs): { req: Partial<RequestContext> } {
  const locale = optString(args.locale)
  return { req: locale ? { ...req, locale } : req }
}
