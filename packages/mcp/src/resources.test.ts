import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { defineConfig, initKernel } from '@kernel/core'
import type { Kernel } from '@kernel/core'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { createMcpServer, type AgentPrincipal } from './server'

// Resources expose the content model for introspection. They must surface the
// public descriptor only — never secret-bearing or auth/hidden collections.

function config() {
  return defineConfig({
    secret: 'test-secret',
    db: sqliteAdapter({ url: ':memory:' }),
    collections: [
      {
        slug: 'posts',
        fields: [{ name: 'title', type: 'text' }],
      },
      // Auth collection: introspecting user/credential schema is a footgun — excluded.
      // Sensitive field NAMES here must never reach the agent-facing descriptor.
      {
        slug: 'users',
        auth: true,
        fields: [
          { name: 'name', type: 'text' },
          { name: 'api_key', type: 'text' },
          { name: 'reset_token', type: 'text' },
          { name: 'totp_secret', type: 'text' },
        ],
      },
      // Hidden collection: excluded from the resource surface too.
      { slug: 'secrets', admin: { hidden: true }, fields: [{ name: 'hash', type: 'text' }] },
    ],
  })
}

const agent: AgentPrincipal = { id: 'bot', roles: [], fieldScope: { allow: ['title'] } }

/** Read the `text` of a resource content block (resources here are always text). */
function contentText(block: unknown): string {
  return (block as { text?: string } | undefined)?.text ?? ''
}

async function connect(kernel: Kernel) {
  const server = createMcpServer(kernel, { principal: agent })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return { client, server }
}

describe('MCP resources expose the content model', () => {
  let kernel: Kernel

  beforeEach(async () => {
    kernel = await initKernel(config(), { logLevel: 'error' })
    await kernel.migrate()
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('lists kernel://schema plus one resource per visible collection', async () => {
    const { client, server } = await connect(kernel)
    const { resources } = await client.listResources()
    const uris = resources.map((r) => r.uri)

    expect(uris).toContain('kernel://schema')
    expect(uris).toContain('kernel://collections/posts')
    // Auth + hidden collections are never advertised.
    expect(uris).not.toContain('kernel://collections/users')
    expect(uris).not.toContain('kernel://collections/secrets')
    await server.close()
  })

  it('reads the full descriptor JSON; auth/hidden collections are excluded', async () => {
    const { client, server } = await connect(kernel)
    const result = await client.readResource({ uri: 'kernel://schema' })

    const block = result.contents[0]
    expect(block?.mimeType).toBe('application/json')
    const raw = contentText(block)
    const schema = JSON.parse(raw) as { collections: Array<{ slug: string }> }
    const slugs = schema.collections.map((c) => c.slug)
    expect(slugs).toContain('posts')
    // Auth + hidden collection slugs must NOT appear in the full-schema payload.
    expect(slugs).not.toContain('users')
    expect(slugs).not.toContain('secrets')
    // Nor may any sensitive field NAME from those collections leak into the JSON.
    for (const secret of ['api_key', 'hash', 'reset_token', 'totp_secret', 'password']) {
      expect(raw).not.toContain(secret)
    }
    await server.close()
  })

  it('reads a single collection descriptor', async () => {
    const { client, server } = await connect(kernel)
    const result = await client.readResource({ uri: 'kernel://collections/posts' })
    const coll = JSON.parse(contentText(result.contents[0])) as { slug: string }
    expect(coll.slug).toBe('posts')
    await server.close()
  })

  it('refuses to read an auth/hidden or unknown collection resource', async () => {
    const { client, server } = await connect(kernel)
    await expect(client.readResource({ uri: 'kernel://collections/users' })).rejects.toThrow()
    await expect(client.readResource({ uri: 'kernel://collections/nope' })).rejects.toThrow()
    await server.close()
  })
})
