import { beforeEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { initKernel } from '@kernel/core'
import type { AuthUser, Kernel } from '@kernel/core'
import { createRequestHandler } from './index'

let kernel: Kernel

beforeEach(async () => {
  kernel = await initKernel(
    {
      secret: 'audit-route-test',
      db: sqliteAdapter({ url: ':memory:' }),
      audit: true,
      collections: [
        {
          slug: 'posts',
          access: { read: () => true, create: () => true },
          fields: [{ name: 'title', type: 'text' }],
        },
      ],
    },
    { logLevel: 'error' },
  )
  await kernel.migrate()
  // Seed an audited event.
  await kernel.create({ collection: 'posts', data: { title: 'seeded' }, overrideAccess: true })
})

const admin: AuthUser = { id: 'admin-1', roles: ['admin'], collection: 'users' } as AuthUser
const member: AuthUser = { id: 'member-1', roles: ['editor'], collection: 'users' } as AuthUser

const withUser = (user: AuthUser | null) => ({
  getUser: (): AuthUser | null => user,
  rateLimit: { enabled: false } as const,
})

describe('GET /api/_admin/audit', () => {
  it('returns 401 when unauthenticated', async () => {
    const handler = createRequestHandler(kernel, { rateLimit: { enabled: false } })
    const res = await handler(new Request('http://localhost/api/_admin/audit'))
    expect(res.status).toBe(401)
  })

  it('returns 403 for a non-admin user', async () => {
    const handler = createRequestHandler(kernel, withUser(member))
    const res = await handler(new Request('http://localhost/api/_admin/audit'))
    expect(res.status).toBe(403)
  })

  it('returns audit entries for an admin', async () => {
    const handler = createRequestHandler(kernel, withUser(admin))
    const res = await handler(new Request('http://localhost/api/_admin/audit'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { docs: Array<{ action: string; collection: string }>; count: number }
    expect(body.count).toBeGreaterThanOrEqual(1)
    expect(body.docs[0]!.action).toBe('create')
    expect(body.docs[0]!.collection).toBe('posts')
  })

  it('filters by action', async () => {
    const handler = createRequestHandler(kernel, withUser(admin))
    const res = await handler(new Request('http://localhost/api/_admin/audit?action=delete'))
    const body = (await res.json()) as { count: number }
    expect(body.count).toBe(0)
  })

  it('exports CSV with a header row and proper content type', async () => {
    const handler = createRequestHandler(kernel, withUser(admin))
    const res = await handler(new Request('http://localhost/api/_admin/audit?format=csv'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/csv')
    const text = await res.text()
    const [header, ...rows] = text.split('\r\n')
    expect(header).toBe('id,at,action,collection,documentId,principalId,principalType,fields,meta')
    expect(rows.length).toBeGreaterThanOrEqual(1)
    expect(rows[0]).toContain('create')
  })
})
