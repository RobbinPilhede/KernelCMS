import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { run } from './index'

// A kernel.config.ts written to disk with the given `agents` literal, so the CLI's
// real config loader (dynamic import of a .ts file) exercises the mcp command path.
function writeConfig(dir: string, agentsLiteral: string): string {
  const path = join(dir, 'kernel.config.ts')
  writeFileSync(
    path,
    `import { defineConfig } from '@kernel/core'\n` +
      `import { sqliteAdapter } from '@kernel/db-sqlite'\n` +
      `export default defineConfig({\n` +
      `  secret: 'test-secret-value-32-chars-long!!',\n` +
      `  db: sqliteAdapter({ url: ':memory:' }),\n` +
      `  collections: [{ slug: 'posts', fields: [{ name: 'title', type: 'text' }] }],\n` +
      `  agents: ${agentsLiteral},\n` +
      `})\n`,
    'utf8',
  )
  return path
}

describe('kernel mcp (stdio principal selection)', () => {
  let dir: string
  let errSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kernel-mcp-'))
    process.exitCode = undefined
    // The command routes diagnostics to stderr; capture instead of printing.
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    errSpy.mockRestore()
    process.exitCode = undefined
    rmSync(dir, { recursive: true, force: true })
  })

  it('errors clearly when the config has no agents', async () => {
    const config = writeConfig(dir, '[]')
    await run(['mcp', '--config', config])
    expect(process.exitCode).toBe(1)
    const msg = errSpy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(msg).toContain('No agents configured')
    expect(msg).toContain('agents: [...]')
  })

  it('errors with the agent ids when the config has more than one agent and none is chosen', async () => {
    const config = writeConfig(dir, `[{ id: 'a', token: 'tok-a' }, { id: 'b', token: 'tok-b' }]`)
    await run(['mcp', '--config', config])
    expect(process.exitCode).toBe(1)
    const msg = errSpy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(msg).toContain('Multiple agents configured')
    expect(msg).toContain('--agent')
  })

  it('errors when --agent names an id that is not configured', async () => {
    const config = writeConfig(dir, `[{ id: 'a', token: 'tok-a' }]`)
    await run(['mcp', '--config', config, '--agent', 'nope'])
    expect(process.exitCode).toBe(1)
    const msg = errSpy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(msg).toContain('No agent with id "nope"')
  })
})
