// Public surface of @kernel/mcp: expose a KernelCMS instance as an access-controlled
// MCP server. Tools are auto-generated from the same descriptor that drives OpenAPI;
// every call is routed through the in-process Local API as an agent principal.

export { generateTools } from './generate'
export type { ToolDef, ToolOp, ToolAnnotations } from './generate'
export { createMcpServer } from './server'
export type { AgentPrincipal, McpServerOptions } from './server'
export { serveStdio } from './stdio'
