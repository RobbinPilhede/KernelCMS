/**
 * kernelcms/mcp — serve a KernelCMS kernel to AI agents over the Model Context
 * Protocol. Tools are auto-generated from your config and every call is routed
 * through the in-process Local API as an access-controlled agent principal:
 *
 *   import { serveStdio } from 'kernelcms/mcp'
 *
 *   await serveStdio(kernel)
 *
 * Requires the optional peer `@modelcontextprotocol/sdk` — install it alongside
 * kernelcms when you use this entry.
 */
export * from '@kernel/mcp'
