/* Real MCP verification: boot a kernel + the MCP server, connect a REAL MCP
 * client over an in-memory transport, and drive the tools as a scoped agent.
 * Run: pnpm tsx verify/mcp.ts */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initKernel } from '@kernel/core'
import { createMcpServer } from '@kernel/mcp'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { makeConfig } from './config'

let pass = 0
const fails: string[] = []
const check = (n: string, c: boolean, e = '') => {
  if (c) {
    pass++
    console.log(`  \x1b[32mPASS\x1b[0m ${n}${e ? ` — ${e}` : ''}`)
  } else {
    fails.push(n)
    console.log(`  \x1b[31mFAIL\x1b[0m ${n}${e ? ` — ${e}` : ''}`)
  }
}
const text = (r: any) => r?.content?.[0]?.text ?? ''
const doc = (r: any) => {
  try {
    return JSON.parse(text(r))
  } catch {
    return null
  }
}

async function main() {
  const dbFile = join(mkdtempSync(join(tmpdir(), 'kverify-mcp-')), 'm.db')
  const kernel = await initKernel(makeConfig(`file:${dbFile}`), { autoMigrate: true } as any)
  await kernel.create({ collection: 'authors', data: { name: 'Seed', email: 's@x.test' }, overrideAccess: true } as any)

  const server = createMcpServer(kernel, {
    principal: { id: 'content-bot', roles: ['editor'], fieldScope: { allow: ['title', 'body', 'layout'] } },
  })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'verify-client', version: '0.0.0' })
  await Promise.all([server.connect(st), client.connect(ct)])

  console.log('\n\x1b[1mMCP — tool surface\x1b[0m')
  const tools = (await client.listTools()).tools.map((t: any) => t.name)
  console.log('  tools:', tools.join(', '))
  check(
    'CRUD tools generated',
    ['posts_list', 'posts_get', 'posts_count', 'posts_create', 'posts_update', 'posts_delete'].every((t) =>
      tools.includes(t),
    ),
  )
  check('versions tool present (drafts collection)', tools.includes('posts_versions'))
  check('global tools present', tools.includes('settings_get_global') && tools.includes('settings_update_global'))
  check('auth collection NOT exposed', !tools.some((t) => t.startsWith('users_')), 'no users_* tools')
  const endpointTool = tools.find((t) => t.includes('touch'))
  check('opt-in (mcp:true) endpoint tool present', Boolean(endpointTool), `tool=${endpointTool}`)

  console.log('\n\x1b[1mMCP — agent enforcement end-to-end\x1b[0m')
  const created = doc(
    await client.callTool({
      name: 'posts_create',
      arguments: {
        title: 'Via MCP',
        body: { v: 1, type: 'doc', children: [{ type: 'paragraph', children: [{ type: 'text', text: 'mcp body' }] }] },
        featured: true,
      },
    }),
  )
  check('agent create returns a doc', Boolean(created?.id), `id=${created?.id}`)
  check('agent MCP create is a DRAFT', created?._status === 'draft', `_status=${created?._status}`)
  check(
    'agent MCP create stripped unscoped field (featured)',
    created?.featured === false,
    `featured=${created?.featured}`,
  )
  const pub = await client.callTool({ name: 'posts_update', arguments: { id: created?.id, _status: 'published' } })
  check(
    'agent CANNOT publish via MCP update',
    Boolean(pub?.isError),
    `isError=${pub?.isError} msg=${text(pub).slice(0, 60)}`,
  )
  const list = doc(await client.callTool({ name: 'posts_list', arguments: {} }))
  check('agent MCP list works', Array.isArray(list?.docs ?? list), `count=${(list?.docs ?? list)?.length}`)

  console.log('\n\x1b[1mMCP — resources (no secret/auth leakage)\x1b[0m')
  const resources = (await client.listResources()).resources.map((r: any) => r.uri)
  check('kernel://schema resource listed', resources.includes('kernel://schema'), resources.join(', '))
  const schemaRes: any = await client.readResource({ uri: 'kernel://schema' })
  const schema = JSON.parse(schemaRes?.contents?.[0]?.text ?? '{}')
  const slugs = (schema.collections ?? []).map((c: any) => c.slug)
  check('schema excludes auth collection (users)', !slugs.includes('users'), `slugs=${slugs.join(',')}`)
  const schemaStr = JSON.stringify(schema)
  check('schema leaks no secret field names', !/api_key|"hash"|reset_token|totp_secret|password/.test(schemaStr), '')

  console.log('\n\x1b[1mMCP — opt-in endpoint tool runs access-checked\x1b[0m')
  if (endpointTool) {
    const seedPost = await kernel.create({
      collection: 'posts',
      data: { title: 'EP', _status: 'published' },
      overrideAccess: true,
    } as any)
    const epRes = await client.callTool({ name: endpointTool, arguments: { id: seedPost.id, body: {} } })
    check('endpoint tool invokes (no error)', !epRes?.isError, `out=${text(epRes).slice(0, 80)}`)
  }

  await client.close()
  console.log(`\n\x1b[1mMCP Result: ${pass} passed, ${fails.length} failed\x1b[0m`)
  if (fails.length) {
    console.log('Failures:\n  ' + fails.join('\n  '))
    process.exit(1)
  }
  process.exit(0)
}
main().catch((e) => {
  console.error('MCP HARNESS ERROR:', e)
  process.exit(2)
})
