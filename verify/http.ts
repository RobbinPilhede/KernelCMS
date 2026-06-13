/* Real HTTP verification: boot the web-standard request handler and exercise
 * REST + the server-side agent BEARER auth path (resolveAuth's agent branch).
 * Run: pnpm tsx verify/http.ts */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initKernel } from '@kernel/core'
import { createRequestHandler } from '@kernel/server'
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

async function main() {
  const dbFile = join(mkdtempSync(join(tmpdir(), 'kverify-http-')), 'h.db')
  const kernel = await initKernel(makeConfig(`file:${dbFile}`), { autoMigrate: true } as any)
  await kernel.create({
    collection: 'posts',
    data: { title: 'Published one', _status: 'published' },
    overrideAccess: true,
  } as any)
  const handler = createRequestHandler(kernel, {})
  const call = (path: string, init?: RequestInit) => handler(new Request('http://localhost' + path, init))

  console.log('\n\x1b[1mHTTP — REST basics\x1b[0m')
  const health = await call('/api/health')
  check('GET /api/health ok', health.status === 200, `status=${health.status}`)
  const listRes = await call('/api/posts')
  const listJson: any = await listRes.json()
  const docs = listJson.docs ?? listJson
  check(
    'GET /api/posts returns published only',
    listRes.status === 200 && docs.length === 1,
    `status=${listRes.status} count=${docs.length}`,
  )

  console.log('\n\x1b[1mHTTP — agent bearer auth (server resolveAuth agent branch)\x1b[0m')
  // A scoped draft create (no _status): featured is outside the agent's allow-list -> stripped.
  const agentCreate = await call('/api/posts', {
    method: 'POST',
    headers: { authorization: 'Bearer tok-content', 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'REST agent',
      body: { v: 1, type: 'doc', children: [{ type: 'paragraph', children: [{ type: 'text', text: 'x' }] }] },
      featured: true,
    }),
  })
  const acJson: any = await agentCreate.json().catch(() => ({}))
  const acDoc = acJson.doc ?? acJson
  check(
    'agent bearer create succeeds',
    agentCreate.status === 201 || agentCreate.status === 200,
    `status=${agentCreate.status}`,
  )
  check('agent REST create is a DRAFT (server-enforced)', acDoc?._status === 'draft', `_status=${acDoc?._status}`)
  check(
    'agent REST create stripped unscoped field (featured)',
    acDoc?.featured === false,
    `featured=${acDoc?.featured}`,
  )

  // Agent attempting a born-published create over HTTP is rejected (draft-only brake).
  const agentPublish = await call('/api/posts', {
    method: 'POST',
    headers: { authorization: 'Bearer tok-content', 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'REST agent publish', _status: 'published' }),
  })
  check(
    'agent CANNOT born-publish over HTTP (draft-only)',
    agentPublish.status === 403,
    `status=${agentPublish.status}`,
  )

  const badToken = await call('/api/posts', {
    method: 'POST',
    headers: { authorization: 'Bearer not-a-real-token', 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'should fail' }),
  })
  check(
    'unknown bearer token is NOT authorized to create',
    badToken.status === 401 || badToken.status === 403,
    `status=${badToken.status}`,
  )

  console.log(`\n\x1b[1mHTTP Result: ${pass} passed, ${fails.length} failed\x1b[0m`)
  if (fails.length) {
    console.log('Failures:\n  ' + fails.join('\n  '))
    process.exit(1)
  }
  process.exit(0)
}
main().catch((e) => {
  console.error('HTTP HARNESS ERROR:', e)
  process.exit(2)
})
