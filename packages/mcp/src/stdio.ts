/**
 * Wire the MCP server to a stdio transport. This is how desktop MCP clients
 * (e.g. Claude Desktop) attach: they spawn a process that calls `serveStdio` and
 * speak JSON-RPC over stdin/stdout.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { Kernel } from '@kernel/core'
import { createMcpServer, type McpServerOptions } from './server'

/**
 * Boot an MCP server for `kernel` and connect it to stdio. Resolves once the
 * transport is connected; the server then runs until the transport closes.
 * Returns the `Server` so the caller can `await server.close()` for shutdown.
 */
export async function serveStdio(kernel: Kernel, options: McpServerOptions): Promise<Server> {
  const server = createMcpServer(kernel, options)
  const transport = new StdioServerTransport()
  await server.connect(transport)
  return server
}
