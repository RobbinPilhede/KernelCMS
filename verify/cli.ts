/* Spawn the real `kernel mcp` CLI command and connect a REAL MCP stdio client to
 * it — proving the CLI boots a kernel and serves a working MCP server.
 * Run: pnpm tsx verify/cli.ts */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

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
  console.log('\n\x1b[1mCLI — `kernel mcp` serves over stdio\x1b[0m')
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      'node_modules/tsx/dist/cli.mjs',
      'packages/cli/src/bin.ts',
      'mcp',
      '--config',
      'verify/kernel.config.ts',
      '--agent',
      'content-bot',
    ],
    cwd: process.cwd(),
    stderr: 'pipe',
  })
  const client = new Client({ name: 'verify-cli', version: '0.0.0' })
  await client.connect(transport)
  check('CLI `kernel mcp` started and completed MCP handshake', true)
  const tools = (await client.listTools()).tools.map((t: any) => t.name)
  check(
    'CLI-served MCP lists the generated tools',
    tools.includes('posts_create') && tools.includes('settings_get_global'),
    `${tools.length} tools`,
  )
  check('CLI-served MCP excludes auth collection', !tools.some((t) => t.startsWith('users_')), '')
  await client.close()
  console.log(`\n\x1b[1mCLI Result: ${pass} passed, ${fails.length} failed\x1b[0m`)
  if (fails.length) {
    console.log('Failures:\n  ' + fails.join('\n  '))
    process.exit(1)
  }
  process.exit(0)
}
main().catch((e) => {
  console.error('CLI HARNESS ERROR:', e?.message ?? e)
  process.exit(2)
})
