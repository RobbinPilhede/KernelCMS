import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { defineConfig, initKernel } from '@kernel/core'
import type { Kernel } from '@kernel/core'
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

  it('lists exactly the generated post tools', async () => {
    const { client, server } = await connect(kernel, titleAgent)
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name)
    expect(names).toEqual(['posts_list', 'posts_get', 'posts_create', 'posts_update', 'posts_delete'])
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
