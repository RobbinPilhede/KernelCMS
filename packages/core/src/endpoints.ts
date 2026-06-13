/**
 * Custom endpoint runtime — the pure, transport-agnostic core of `config.endpoints`.
 *
 * `defineEndpoint` is an identity helper that gives full input/output inference.
 * `matchEndpoint` resolves a request (method + path segments) to an endpoint and
 * its `:param` values. `parseEndpointInput` runs the per-part validators and turns
 * any failure into a `ValidationError`, so custom endpoints share the exact error
 * envelope as core routes. The HTTP glue (access, handler invocation, response)
 * lives in `@kernel/server`; everything here is unit-testable without a server.
 */
import { ForbiddenError, UnauthorizedError, ValidationError } from './errors'
import type { Logger } from '@kernel/db'
import { createLogger } from './kernel'
import type { EndpointConfig, Kernel, RequestContext } from './types'

/** Identity helper. The argument is fully type-checked — `params`/`query`/`body`
 *  are inferred from the validators and the handler must consume them correctly —
 *  but the return is the erased `EndpointConfig` so a heterogeneous set of
 *  endpoints assigns cleanly into `config.endpoints` without variance friction. */
export function defineEndpoint<P = undefined, Q = undefined, B = undefined, R = unknown>(
  config: EndpointConfig<P, Q, B, R>,
): EndpointConfig {
  return config as EndpointConfig
}

/** Resolve a method + already-split path segments to a matching endpoint and its
 *  extracted `:param` values. First match wins (declaration order), so authors
 *  can intentionally order overlapping routes. Returns null when nothing matches. */
export function matchEndpoint(
  endpoints: readonly EndpointConfig[],
  method: string,
  segments: string[],
): { endpoint: EndpointConfig; params: Record<string, string> } | null {
  for (const endpoint of endpoints) {
    if (endpoint.method !== method) continue
    const epSegments = endpoint.path.split('/').filter(Boolean)
    if (epSegments.length !== segments.length) continue
    const params: Record<string, string> = {}
    let matched = true
    for (let i = 0; i < epSegments.length; i++) {
      const seg = epSegments[i]!
      if (seg.startsWith(':')) {
        params[seg.slice(1)] = segments[i]!
      } else if (seg !== segments[i]) {
        matched = false
        break
      }
    }
    if (matched) return { endpoint, params }
  }
  return null
}

interface ParserIssue {
  path?: (string | number)[]
  message: string
}

/** Run one validator, mapping a Zod-style (`.issues`) or generic throw into the
 *  framework's `ValidationError` with stable `{ path, message }` details. */
function runParser<T>(parser: { parse: (value: unknown) => T }, value: unknown, target: string): T {
  try {
    return parser.parse(value)
  } catch (err) {
    const issues = (err as { issues?: ParserIssue[] }).issues
    const details = Array.isArray(issues)
      ? issues.map((issue) => ({
          path: [target, ...(issue.path ?? [])].join('.'),
          message: issue.message,
        }))
      : [{ path: target, message: err instanceof Error ? err.message : 'Invalid input.' }]
    throw new ValidationError(details)
  }
}

/** Validate the raw request parts against the endpoint's declared input. Parts
 *  without a validator pass through as `undefined`. Throws `ValidationError`
 *  (which the server renders as the standard error envelope) on any failure. */
export function parseEndpointInput(
  endpoint: EndpointConfig,
  raw: { params: Record<string, string>; query: Record<string, unknown>; body: unknown },
): { params: unknown; query: unknown; body: unknown } {
  const input = endpoint.input
  return {
    params: input?.params ? runParser(input.params, raw.params, 'params') : undefined,
    query: input?.query ? runParser(input.query, raw.query, 'query') : undefined,
    body: input?.body ? runParser(input.body, raw.body, 'body') : undefined,
  }
}

/** Args for {@link invokeEndpoint}. `input` is the *raw* (pre-validation) parts —
 *  exactly what the HTTP path feeds `parseEndpointInput` — so in-process callers
 *  go through the same validation/error envelope. `req` carries the principal and
 *  locale; the access rule and handler see it unchanged. */
export interface InvokeEndpointArgs {
  input?: { params?: Record<string, string>; query?: Record<string, unknown>; body?: unknown }
  req: RequestContext
  logger?: Logger
  /** The real web Request, when one exists (the HTTP path supplies it so access
   *  rules and handlers can read headers/body). Omitted by non-HTTP callers, who
   *  get a minimal in-process shim instead. */
  request?: Request
}

// A non-HTTP caller has no real `Request`, but the endpoint contract types both the
// `access` arg and `ctx.request` as `Request`. We pass a minimal web-standard shim
// so the contract holds and handlers that only read headers/url degrade gracefully
// rather than crashing on a null. Handlers that consume the *body* of `ctx.request`
// (e.g. signed-webhook endpoints) are HTTP-only by nature and not meant for this path.
const inProcessRequest = (): Request => new Request('kernel://in-process')

/**
 * Invoke a custom endpoint's business logic in-process — transport-agnostic.
 *
 * Runs the same pure pipeline as the HTTP path: authorize (explicit access rule,
 * else secure-by-default authenticated-only), validate the declared input into a
 * `ValidationError` on failure, then call the handler with a full typed context
 * whose Local API is `kernel`. No HTTP Request/Response is touched — body plumbing,
 * serialization, status codes and CORS stay in `@kernel/server`'s `runEndpoint`.
 *
 * Lives in `@kernel/core` (not `@kernel/server`) so non-HTTP callers such as the
 * MCP server can drive endpoints without depending on the HTTP layer.
 */
export async function invokeEndpoint(
  kernel: Kernel,
  endpoint: EndpointConfig,
  args: InvokeEndpointArgs,
): Promise<unknown> {
  const { req } = args
  const user = req.user
  const request = args.request ?? inProcessRequest()

  // Authorize: explicit access rule, else secure-by-default (authenticated only).
  // Identical semantics to runEndpoint — deny maps to 403 when a principal exists,
  // 401 otherwise.
  const allowed = endpoint.access ? await endpoint.access({ req, request }) : Boolean(user)
  if (!allowed) throw user ? new ForbiddenError() : new UnauthorizedError()

  // Validate through the endpoint's declared parsers — same ValidationError shape
  // the HTTP path emits. Missing parts default to empty so omitted validators pass.
  const input = parseEndpointInput(endpoint, {
    params: args.input?.params ?? {},
    query: args.input?.query ?? {},
    body: args.input?.body,
  }) as { params: unknown; query: unknown; body: unknown }

  return endpoint.handler({
    input,
    ctx: { req, user, local: kernel, logger: args.logger ?? createLogger(), request },
  })
}
