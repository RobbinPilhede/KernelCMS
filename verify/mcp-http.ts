/* Real MCP HTTP transport verification: start serveHttp, connect REAL MCP clients
 * over StreamableHTTP with per-request agent bearer tokens (multi-agent), and
 * verify 401 on missing/bad token. Run: pnpm tsx verify/mcp-http.ts */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initKernel } from '@kernel/core'
import { serveHttp } from '@kernel/mcp'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
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

async function connect(url: string, token?: string) {
  const transport = new StreamableHTTPClientTransport(
    new URL(url),
    token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : undefined,
  )
  const client = new Client({ name: 'verify-http', version: '0.0.0' })
  await client.connect(transport)
  return client
}

async function main() {
  const dbFile = join(mkdtempSync(join(tmpdir(), 'kverify-mcph-')), 'mh.db')
  const kernel = await initKernel(makeConfig(`file:${dbFile}`), { autoMigrate: true } as any)
  const PORT = 4191
  const server = serveHttp(kernel, { port: PORT, host: '127.0.0.1' })
  await new Promise((r) => setTimeout(r, 400))
  const url = `http://127.0.0.1:${PORT}/mcp`

  console.log('\n\x1b[1mMCP HTTP — multi-agent, per-request token\x1b[0m')
  // content-bot: scoped to title/body/layout
  const content = await connect(url, 'tok-content')
  const cTools = (await content.listTools()).tools.map((t: any) => t.name)
  check('content-bot connects + lists tools', cTools.includes('posts_create'), `${cTools.length} tools`)
  const cCreate: any = await content.callTool({
    name: 'posts_create',
    arguments: { title: 'http agent', featured: true },
  })
  const cDoc = JSON.parse(cCreate?.content?.[0]?.text ?? '{}')
  check(
    'content-bot create is a scoped draft',
    cDoc?._status === 'draft' && cDoc?.featured === false,
    `_status=${cDoc?._status} featured=${cDoc?.featured}`,
  )
  await content.close()

  // tags-bot: a DIFFERENT scope (categories only) — proves per-request principal isolation
  const tags = await connect(url, 'tok-tags')
  const seedCat = await kernel.create({
    collection: 'categories',
    data: { name: 'C', slug: 'c' },
    overrideAccess: true,
  } as any)
  const seedPost = await kernel.create({
    collection: 'posts',
    data: { title: 'seed', _status: 'published' },
    overrideAccess: true,
  } as any)
  // tags-bot may set categories but NOT title (title not in its allow-list)
  const tUpd: any = await tags.callTool({
    name: 'posts_update',
    arguments: { id: seedPost.id, title: 'HACKED', categories: [seedCat.id] },
  })
  const tDoc = JSON.parse(tUpd?.content?.[0]?.text ?? '{}')
  check(
    'tags-bot scope differs (title NOT writable, categories writable)',
    tDoc?.title === 'seed' && Array.isArray(tDoc?.categories) && tDoc.categories.length === 1,
    `title=${tDoc?.title} cats=${JSON.stringify(tDoc?.categories)?.slice(0, 30)}`,
  )
  await tags.close()

  console.log('\n\x1b[1mMCP HTTP — auth required\x1b[0m')
  let noTokenFailed = false
  try {
    const c = await connect(url)
    await c.listTools()
    await c.close()
  } catch {
    noTokenFailed = true
  }
  check('no token is rejected (401, cannot use tools)', noTokenFailed, '')
  let badTokenFailed = false
  try {
    const c = await connect(url, 'not-real')
    await c.listTools()
    await c.close()
  } catch {
    badTokenFailed = true
  }
  check('invalid token is rejected', badTokenFailed, '')

  server.close()
  console.log(`\n\x1b[1mMCP HTTP Result: ${pass} passed, ${fails.length} failed\x1b[0m`)
  if (fails.length) {
    console.log('Failures:\n  ' + fails.join('\n  '))
    process.exit(1)
  }
  process.exit(0)
}
main().catch((e) => {
  console.error('MCP HTTP HARNESS ERROR:', e)
  process.exit(2)
})
