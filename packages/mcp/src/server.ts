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
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { EndpointConfig, FieldScope, Kernel, RequestContext, Where } from '@kernel/core'
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

/**
 * Create an MCP server bound to `kernel`, acting as `options.principal`.
 * The returned `Server` is transport-agnostic — wire it to stdio (see `stdio.ts`)
 * or any other transport the SDK provides.
 */
export function createMcpServer(kernel: Kernel, options: McpServerOptions): Server {
  const tools = generateTools(describeConfig(kernel.config), kernel.config.endpoints ?? [])
  const byName = new Map<string, ToolDef>(tools.map((t) => [t.name, t]))

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
    { capabilities: { tools: {} } },
  )

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
