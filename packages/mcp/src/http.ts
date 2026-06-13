/**
 * Multi-agent MCP over HTTP. Each request is authenticated INDEPENDENTLY: the
 * agent token is read from `Authorization: Bearer <token>` (or `x-kernel-agent`),
 * resolved to a configured agent principal, and a fresh MCP server bound to THAT
 * principal handles the request. Different agents therefore connect with different
 * scoped tokens and never share a principal.
 *
 * SECURITY — this is a NEW remote attack surface, so the posture is strict:
 *  - Token check is constant-time (`resolveAgentPrincipal`); no token is ever echoed.
 *  - Missing/unknown token → 401 with a generic JSON error; NO tools/resources served.
 *  - The principal is always `principalType:'agent'`; `overrideAccess` is never set,
 *    so the core access pipeline + agent brakes (draft-only, fieldScope) fully apply.
 *  - Stateless per-request transport: server + transport are created and torn down
 *    per request (no session affinity, no cross-request state to hijack).
 *  - Request bodies are size-capped before being buffered (DoS guard).
 *  - CORS is OFF by default. Browsers are not the intended client; opt in explicitly.
 */
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Kernel } from '@kernel/core'
import { createMcpServer, resolveAgentPrincipal } from './server'

export interface ServeHttpOptions {
  /** Port to listen on. Defaults to an ephemeral port (0); read it back from the
   *  returned server's `address()`. */
  port?: number
  /** Host/interface to bind. Defaults to loopback (`127.0.0.1`) — do NOT expose
   *  this on `0.0.0.0` without a proxy/TLS in front. */
  host?: string
  /** Path the MCP endpoint is mounted at. Defaults to `/mcp`. */
  path?: string
  /** Max bytes accepted for a single request body. Defaults to 4 MB. */
  maxBodyBytes?: number
  /**
   * CORS allow-list of origins. OFF by default (no header emitted). Pass explicit
   * origins to enable a browser client; credentials are never allowed (agents use
   * bearer tokens, not cookies, so there is nothing to attach).
   */
  cors?: string[]
  /** Server identity reported to clients during initialize. */
  name?: string
  version?: string
}

const DEFAULT_PATH = '/mcp'
const DEFAULT_HOST = '127.0.0.1'
// MCP JSON-RPC messages are small; a tight cap blunts memory-exhaustion attempts.
const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024

/** Send a JSON-RPC-shaped error response. Never includes the presented token. */
function sendError(res: ServerResponse, status: number, code: number, message: string): void {
  if (res.headersSent) return
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.setHeader('x-content-type-options', 'nosniff')
  // `WWW-Authenticate` signals the client a credential is required (RFC 6750).
  if (status === 401) res.setHeader('www-authenticate', 'Bearer')
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }))
}

/** Extract the agent token from the request: `Authorization: Bearer <t>` first,
 *  then the `x-kernel-agent` header. Returns null if neither is present. */
function tokenFrom(req: IncomingMessage): string | null {
  const auth = req.headers['authorization']
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice('Bearer '.length)
  const header = req.headers['x-kernel-agent']
  if (typeof header === 'string' && header.length > 0) return header
  return null
}

/** Apply the restrictive CORS policy (allow-list only, no credentials). */
function applyCors(req: IncomingMessage, res: ServerResponse, cors: string[] | undefined): void {
  if (!cors || cors.length === 0) return
  const origin = req.headers['origin']
  if (typeof origin === 'string' && cors.includes(origin)) {
    res.setHeader('access-control-allow-origin', origin)
    res.setHeader('access-control-allow-headers', 'Content-Type, Authorization, x-kernel-agent, mcp-session-id')
    res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS')
    res.setHeader('vary', 'Origin')
  }
}

/** Buffer the request body with a hard size cap (DoS guard). Resolves to the raw
 *  bytes, or rejects once the cap is exceeded (the caller answers 413). */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('PAYLOAD_TOO_LARGE'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * Start a Node HTTP server that serves MCP with PER-REQUEST agent authentication.
 * Returns the underlying `http.Server` so the caller can read its address and
 * `close()` it. Each request gets its own principal — this is the multi-agent
 * surface: agent A's token yields agent A's scope, agent B's token yields B's.
 */
export function serveHttp(kernel: Kernel, options: ServeHttpOptions = {}): HttpServer {
  const path = options.path ?? DEFAULT_PATH
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES

  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      // Last-ditch guard: never leak internals to the client.
      console.error('[KernelCMS MCP HTTP] request failed:', err)
      sendError(res, 500, -32603, 'Internal error.')
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    applyCors(req, res, options.cors)

    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.end()
      return
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    if (url.pathname !== path) {
      sendError(res, 404, -32601, 'Not found.')
      return
    }

    // AUTH GATE — resolve the agent BEFORE creating any server or reading the body.
    // No token / unknown token → 401, and we never serve tools or resources.
    const token = tokenFrom(req)
    const principal = token ? resolveAgentPrincipal(kernel, token) : null
    if (!principal) {
      sendError(res, 401, -32001, 'Unauthorized: a valid agent token is required.')
      return
    }

    let body: Buffer
    try {
      body = await readBody(req, maxBodyBytes)
    } catch {
      sendError(res, 413, -32600, 'Request body too large.')
      return
    }
    // Pre-parse the JSON body so the transport doesn't re-read the (consumed) stream.
    let parsedBody: unknown
    if (body.length > 0) {
      try {
        parsedBody = JSON.parse(body.toString('utf8'))
      } catch {
        sendError(res, 400, -32700, 'Parse error: body must be valid JSON.')
        return
      }
    }

    // Fresh, stateless server + transport bound to THIS agent's principal. Created
    // per request and disposed when the response ends — no shared/session state.
    const mcp = createMcpServer(kernel, {
      principal: { id: principal.id, roles: principal.roles, fieldScope: principal.fieldScope },
      name: options.name,
      version: options.version,
    })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => {
      void transport.close()
      void mcp.close()
    })
    await mcp.connect(transport)
    await transport.handleRequest(req, res, parsedBody)
  }

  server.listen(options.port ?? 0, options.host ?? DEFAULT_HOST)
  return server
}
