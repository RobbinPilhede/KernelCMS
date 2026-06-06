import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { initKernel } from '@kernel/core'
import type { Kernel } from '@kernel/core'
import { createRequestHandler } from './index'

let kernel: Kernel
let handler: (req: Request) => Promise<Response>

beforeEach(async () => {
  kernel = await initKernel(
    {
      secret: 'setup-env-test',
      db: sqliteAdapter({ url: ':memory:' }),
      collections: [{ slug: 'users', auth: true, access: { read: () => true, create: () => true }, fields: [] }],
    },
    { logLevel: 'error' },
  )
  await kernel.migrate()
  handler = createRequestHandler(kernel, {})
})

afterEach(async () => {
  await kernel.destroy()
})

function post(values: Record<string, unknown>): Promise<Response> {
  return handler(
    new Request('http://localhost/api/_admin/env', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values }),
    }),
  )
}

describe('POST /_admin/env (first-run connector settings)', () => {
  it('writes whitelisted keys to .env during first-run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kernel-env-'))
    const cwd = process.cwd()
    process.chdir(dir)
    try {
      const res = await post({ DATABASE_URL: 'postgres://u:p@localhost:5432/db' })
      expect(res.status).toBe(200)
      const env = await readFile(join(dir, '.env'), 'utf8')
      expect(env).toContain('DATABASE_URL=postgres://u:p@localhost:5432/db')
    } finally {
      process.chdir(cwd)
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects a non-whitelisted key without writing', async () => {
    const res = await post({ EVIL_KEY: 'x' })
    expect(res.status).toBe(400)
  })

  it('rejects multi-line values (env injection)', async () => {
    const res = await post({ DATABASE_URL: 'a\nGITHUB_CLIENT_SECRET=leak' })
    expect(res.status).toBe(400)
  })

  it('refuses once an admin exists (past first-run)', async () => {
    await kernel.create({
      collection: 'users',
      data: { email: 'a@x.test', password: 'password123' },
      overrideAccess: true,
    })
    const res = await post({ DATABASE_URL: 'postgres://x' })
    expect(res.status).toBe(403)
  })

  it('refuses in production', async () => {
    const prev = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      const res = await post({ DATABASE_URL: 'postgres://x' })
      expect(res.status).toBe(403)
    } finally {
      process.env.NODE_ENV = prev
    }
  })
})
