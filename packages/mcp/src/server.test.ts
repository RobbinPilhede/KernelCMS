import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { defineConfig, defineEndpoint, initKernel } from '@kernel/core'
import type { Kernel, RequestContext } from '@kernel/core'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { createMcpServer, type AgentPrincipal } from './server'

// End-to-end: a real in-memory kernel behind a real MCP server, driven by a real
// MCP client over a linked in-memory transport. This proves the agent principal is
// enforced through the full CallTool path — not just in a unit of the dispatcher.

// Permissive on purpose: config alone would let anyone do anything. The agent brakes
// (fieldScope + draft-only) must still hold because they live in the core pipeline.
function postsConfig() {
  return defineConfig({
    secret: 'test-secret',
    db: sqliteAdapter({ url: ':memory:' }),
    collections: [
      {
        slug: 'posts',
        versions: { drafts: true },
        access: { read: () => true, create: () => true, update: () => true, publish: () => true },
        fields: [
          { name: 'title', type: 'text' },
          { name: 'body', type: 'text' },
          // Unruled privilege field: only the agent's fieldScope stops it being written.
          { name: 'roles', type: 'text' },
        ],
      },
    ],
  })
}

// Agent scoped to write only `title`. roles:[] — never grant an agent admin.
const titleAgent: AgentPrincipal = { id: 'content-bot', roles: [], fieldScope: { allow: ['title'] } }

/** Spin up a kernel + MCP server + connected client, all over in-memory transports. */
async function connect(kernel: Kernel, principal: AgentPrincipal) {
  const server = createMcpServer(kernel, { principal })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return { client, server }
}

/** First text block of a tool result, parsed back to an object. */
function parseText(result: { content: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  const block = result.content.find((c) => c.type === 'text')
  return JSON.parse(block?.text ?? '{}') as Record<string, unknown>
}

describe('MCP CallTool enforces the agent principal end-to-end', () => {
  let kernel: Kernel

  beforeEach(async () => {
    kernel = await initKernel(postsConfig(), { logLevel: 'error' })
    await kernel.migrate()
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('lists exactly the generated post tools, with annotations', async () => {
    const { client, server } = await connect(kernel, titleAgent)
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name)
    expect(names).toEqual([
      'posts_list',
      'posts_get',
      'posts_count',
      'posts_versions',
      'posts_create',
      'posts_update',
      'posts_delete',
    ])
    // Annotations survive the SDK round-trip (list read-only, delete destructive).
    const list = tools.find((t) => t.name === 'posts_list')
    const del = tools.find((t) => t.name === 'posts_delete')
    expect(list?.annotations?.readOnlyHint).toBe(true)
    expect(del?.annotations?.destructiveHint).toBe(true)
    await server.close()
  })

  it('counts and reviews version history via an agent principal', async () => {
    const { client, server } = await connect(kernel, titleAgent)
    await client.callTool({ name: 'posts_create', arguments: { title: 'One' } })
    const second = parseText(
      (await client.callTool({ name: 'posts_create', arguments: { title: 'Two' } })) as {
        content: Array<{ type: string; text?: string }>
      },
    )

    // _count goes through access (read:()=>true here) and sees both drafts.
    const count = await client.callTool({ name: 'posts_count', arguments: {} })
    expect(count.isError ?? false).toBe(false)
    expect(JSON.parse((count as { content: Array<{ text?: string }> }).content[0]?.text ?? '0')).toBe(2)

    // Update the second doc to produce a second version snapshot.
    await client.callTool({ name: 'posts_update', arguments: { id: second.id, title: 'Two-edited' } })
    const versions = parseText(
      (await client.callTool({
        name: 'posts_versions',
        arguments: { id: second.id, createdByType: 'agent' },
      })) as { content: Array<{ type: string; text?: string }> },
    )
    // All snapshots here were authored by the agent; filtering to 'agent' returns them.
    expect(Array.isArray(versions.docs)).toBe(true)
    expect((versions.docs as unknown[]).length).toBeGreaterThan(0)
    await server.close()
  })

  it('creates a DRAFT with only the scoped field; unscoped fields are stripped', async () => {
    const { client, server } = await connect(kernel, titleAgent)
    const result = await client.callTool({
      name: 'posts_create',
      arguments: { title: 'Agent title', body: 'should vanish', roles: 'admin' },
    })
    expect(result.isError ?? false).toBe(false)
    const doc = parseText(result as { content: Array<{ type: string; text?: string }> })
    expect(doc.title).toBe('Agent title')
    // Out-of-scope fields never reach storage.
    expect(doc.body ?? null).toBeNull()
    expect(doc.roles ?? null).toBeNull()
    // The agent's write is a draft — it can never be born published.
    expect(doc._status).toBe('draft')
    await server.close()
  })

  it('returns an MCP error when the agent attempts to publish via _status', async () => {
    const { client, server } = await connect(kernel, titleAgent)
    // Seed a draft as the agent first.
    const created = parseText(
      (await client.callTool({
        name: 'posts_create',
        arguments: { title: 'Draft' },
      })) as { content: Array<{ type: string; text?: string }> },
    )
    const id = created.id as string

    // _status is not in the tool schema, but force it through as a raw argument to
    // prove the CORE pipeline (not the schema) blocks the publish.
    const result = await client.callTool({
      name: 'posts_update',
      arguments: { id, _status: 'published' } as Record<string, unknown>,
    })
    expect(result.isError).toBe(true)
    // The doc stays a draft in storage.
    const after = await kernel.findByID({ collection: 'posts', id, draft: true, overrideAccess: true })
    expect(after?._status).toBe('draft')
    await server.close()
  })

  it('logs an unexpected (non-Kernel) error server-side but keeps the client message generic', async () => {
    // Force a plain (non-Kernel) failure deep in the op, simulating an internal bug.
    const boom = new Error('internal db pool exploded')
    vi.spyOn(kernel, 'find').mockRejectedValueOnce(boom)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const { client, server } = await connect(kernel, titleAgent)
    const result = await client.callTool({ name: 'posts_list', arguments: {} })

    // Client gets ONLY the generic message — no stack/internals leak.
    expect(result.isError).toBe(true)
    const text = (result as { content: Array<{ type: string; text?: string }> }).content[0]?.text
    expect(text).toBe('The tool call failed.')
    expect(text).not.toContain('db pool')

    // Operators get the real error server-side, tagged with the tool name.
    expect(errSpy).toHaveBeenCalledOnce()
    expect(errSpy.mock.calls[0]?.[0]).toContain('posts_list')
    expect(errSpy.mock.calls[0]?.[1]).toBe(boom)

    errSpy.mockRestore()
    await server.close()
  })
})

// Custom-endpoint tools: opt-in (mcp:true) and gated by the endpoint's own access
// rule, enforced through invokeEndpoint with the agent req (no overrideAccess).
function endpointConfig() {
  return defineConfig({
    secret: 'test-secret',
    db: sqliteAdapter({ url: ':memory:' }),
    collections: [{ slug: 'posts', fields: [{ name: 'title', type: 'text' }] }],
    endpoints: [
      defineEndpoint({
        method: 'POST',
        path: '/posts/:id/publish',
        summary: 'Publish post',
        mcp: true,
        input: {
          params: { parse: (v) => v as { id: string } },
          body: { parse: (v) => v as Record<string, unknown> },
        },
        access: () => true,
        handler: ({ input }) => ({
          published: (input.params as { id: string }).id,
          note: (input.body as { note?: string } | undefined)?.note ?? null,
        }),
      }),
      // Opted in, but access denies the agent → CallTool must surface an MCP error.
      defineEndpoint({
        method: 'POST',
        path: '/admin/wipe',
        summary: 'Wipe everything',
        mcp: true,
        access: ({ req }: { req: RequestContext }) => req.user?.roles?.includes('admin') ?? false,
        handler: () => ({ wiped: true }),
      }),
      // Not opted in → never a tool.
      defineEndpoint({
        method: 'GET',
        path: '/internal/metrics',
        access: () => true,
        handler: () => ({ ok: true }),
      }),
    ],
  })
}

describe('MCP custom-endpoint tools', () => {
  let kernel: Kernel

  beforeEach(async () => {
    kernel = await initKernel(endpointConfig(), { logLevel: 'error' })
    await kernel.migrate()
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('exposes only mcp:true endpoints as tools', async () => {
    const { client, server } = await connect(kernel, titleAgent)
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).toContain('publish_post')
    expect(names).toContain('wipe_everything')
    expect(names.some((n) => n.includes('metrics'))).toBe(false)
    await server.close()
  })

  it('runs an allowed endpoint handler with params + body', async () => {
    const { client, server } = await connect(kernel, titleAgent)
    const result = await client.callTool({
      name: 'publish_post',
      arguments: { id: 'abc123', body: { note: 'ship it' } },
    })
    if (result.isError) throw new Error((result as { content: Array<{ text?: string }> }).content[0]?.text)
    expect(result.isError ?? false).toBe(false)
    const out = parseText(result as { content: Array<{ type: string; text?: string }> })
    expect(out.published).toBe('abc123')
    expect(out.note).toBe('ship it')
    await server.close()
  })

  it('returns an MCP error when the endpoint access rule denies the agent', async () => {
    // titleAgent has roles:[] so the admin-gated endpoint denies it.
    const { client, server } = await connect(kernel, titleAgent)
    const result = await client.callTool({ name: 'wipe_everything', arguments: {} })
    expect(result.isError).toBe(true)
    await server.close()
  })
})
