import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server as HttpServer } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { defineConfig, initKernel } from '@kernel/core'
import type { Kernel } from '@kernel/core'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { resolveAgentPrincipal } from './server'
import { serveHttp } from './http'

// Two agents with distinct scopes prove multi-agent isolation: each token yields
// a different principal, and the scope is enforced through the core pipeline.
const CONTENT_TOKEN = 'content-token-aaaaaaaaaaaaaaaaaaaaaaaa'
const TAGS_TOKEN = 'tags-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbb'

function config() {
  return defineConfig({
    secret: 'test-secret',
    db: sqliteAdapter({ url: ':memory:' }),
    // Permissive access on purpose — the agent fieldScope brake is what must hold.
    collections: [
      {
        slug: 'posts',
        versions: { drafts: true },
        access: { read: () => true, create: () => true, update: () => true },
        fields: [
          { name: 'title', type: 'text' },
          { name: 'body', type: 'text' },
        ],
      },
    ],
    agents: [
      { id: 'content-bot', token: CONTENT_TOKEN, roles: [], fieldScope: { allow: ['title'] } },
      { id: 'tags-bot', token: TAGS_TOKEN, roles: [], fieldScope: { allow: ['body'] } },
    ],
  })
}

function baseUrl(server: HttpServer, path = '/mcp'): URL {
  const addr = server.address() as AddressInfo
  return new URL(`http://127.0.0.1:${addr.port}${path}`)
}

/** Connect a real MCP client over Streamable HTTP, sending the agent bearer token. */
async function connectClient(server: HttpServer, token: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' })
  const transport = new StreamableHTTPClientTransport(baseUrl(server), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  })
  await client.connect(transport)
  return client
}

describe('resolveAgentPrincipal', () => {
  let kernel: Kernel
  beforeEach(async () => {
    kernel = await initKernel(config(), { logLevel: 'error' })
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('resolves a valid token to an agent principal', () => {
    const p = resolveAgentPrincipal(kernel, CONTENT_TOKEN)
    expect(p).not.toBeNull()
    expect(p?.id).toBe('content-bot')
    expect(p?.principalType).toBe('agent')
    expect(p?.fieldScope).toEqual({ allow: ['title'] })
  })

  it('distinguishes between agents (multi-agent scopes)', () => {
    expect(resolveAgentPrincipal(kernel, TAGS_TOKEN)?.id).toBe('tags-bot')
    expect(resolveAgentPrincipal(kernel, CONTENT_TOKEN)?.id).toBe('content-bot')
  })

  it('returns null for unknown and empty tokens', () => {
    expect(resolveAgentPrincipal(kernel, 'not-a-real-token')).toBeNull()
    expect(resolveAgentPrincipal(kernel, '')).toBeNull()
    // Length-mismatched prefix of a real token must not match.
    expect(resolveAgentPrincipal(kernel, CONTENT_TOKEN.slice(0, 5))).toBeNull()
  })
})

describe('serveHttp — per-request agent auth', () => {
  let kernel: Kernel
  let server: HttpServer

  beforeEach(async () => {
    kernel = await initKernel(config(), { logLevel: 'error' })
    await kernel.migrate()
    server = serveHttp(kernel)
    await new Promise<void>((resolve) => server.on('listening', resolve))
  })
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await kernel.destroy()
  })

  it('rejects a request with NO token with 401 and serves nothing', async () => {
    const res = await fetch(baseUrl(server), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error?: { message?: string } }
    expect(body.error?.message).toMatch(/token/i)
    // The 401 body must never echo any tool name.
    expect(JSON.stringify(body)).not.toContain('posts_create')
  })

  it('rejects an INVALID token with 401', async () => {
    const res = await fetch(baseUrl(server), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer wrong-token',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    expect(res.status).toBe(401)
  })

  it('lets a valid agent list and call tools, scoped to its fieldScope', async () => {
    const client = await connectClient(server, CONTENT_TOKEN)
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).toContain('posts_create')

    const result = await client.callTool({
      name: 'posts_create',
      arguments: { title: 'Hello', body: 'should be stripped' },
    })
    const block = (result.content as Array<{ type: string; text?: string }>).find((c) => c.type === 'text')
    const doc = JSON.parse(block?.text ?? '{}') as Record<string, unknown>
    expect(doc.title).toBe('Hello')
    // content-bot may write only `title`; `body` is stripped by fieldScope.
    expect(doc.body ?? null).toBeNull()
    // Agent writes are drafts.
    expect(doc._status).toBe('draft')
    await client.close()
  })

  it('isolates two agents: different tokens enforce different scopes', async () => {
    // content-bot allows only `title`.
    const contentClient = await connectClient(server, CONTENT_TOKEN)
    const a = await contentClient.callTool({
      name: 'posts_create',
      arguments: { title: 'T1', body: 'B1' },
    })
    const aDoc = JSON.parse((a.content as Array<{ text?: string }>).find((c) => c.text)?.text ?? '{}') as Record<
      string,
      unknown
    >
    expect(aDoc.title).toBe('T1')
    expect(aDoc.body ?? null).toBeNull()
    await contentClient.close()

    // tags-bot allows only `body`.
    const tagsClient = await connectClient(server, TAGS_TOKEN)
    const b = await tagsClient.callTool({
      name: 'posts_create',
      arguments: { title: 'T2', body: 'B2' },
    })
    const bDoc = JSON.parse((b.content as Array<{ text?: string }>).find((c) => c.text)?.text ?? '{}') as Record<
      string,
      unknown
    >
    expect(bDoc.body).toBe('B2')
    expect(bDoc.title ?? null).toBeNull()
    await tagsClient.close()
  })

  it('exposes the schema resource to an authenticated agent', async () => {
    const client = await connectClient(server, CONTENT_TOKEN)
    const uris = (await client.listResources()).resources.map((r) => r.uri)
    expect(uris).toContain('kernel://schema')
    await client.close()
  })
})
