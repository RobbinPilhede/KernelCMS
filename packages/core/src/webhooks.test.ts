import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import type { Kernel } from './index'
import { initKernel } from './index'

interface Captured {
  url: string
  headers: Record<string, string>
  body: string
}

function stubFetch(): { calls: Captured[]; restore: () => void } {
  const calls: Captured[] = []
  const fn = vi.fn(async (url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ url, headers: init.headers, body: init.body })
    return new Response('ok', { status: 200 })
  })
  vi.stubGlobal('fetch', fn)
  return { calls, restore: () => vi.unstubAllGlobals() }
}

describe('webhooks', () => {
  let kernel: Kernel
  let fetchStub: ReturnType<typeof stubFetch>

  beforeEach(async () => {
    fetchStub = stubFetch()
    kernel = await initKernel(
      {
        secret: 'wh-test',
        db: sqliteAdapter({ url: ':memory:' }),
        webhooks: [
          { url: 'https://hook.example/all', secret: 'shh' },
          { url: 'https://hook.example/deletes-only', events: ['delete'] },
          { url: 'https://hook.example/posts-only', collections: ['posts'] },
        ],
        collections: [
          {
            slug: 'posts',
            access: { read: () => true, create: () => true, update: () => true, delete: () => true },
            fields: [{ name: 'title', type: 'text' }],
          },
          {
            slug: 'notes',
            access: { read: () => true, create: () => true },
            fields: [{ name: 'body', type: 'text' }],
          },
        ],
      },
      { logLevel: 'error' },
    )
    await kernel.migrate()
  })

  afterEach(async () => {
    fetchStub.restore()
    await kernel.destroy()
  })

  it('fires a signed POST on create', async () => {
    const doc = await kernel.create({ collection: 'posts', data: { title: 'hi' }, overrideAccess: true })
    const all = fetchStub.calls.filter((c) => c.url === 'https://hook.example/all')
    expect(all).toHaveLength(1)
    const payload = JSON.parse(all[0]!.body)
    expect(payload.event).toBe('create')
    expect(payload.collection).toBe('posts')
    expect(payload.id).toBe(doc.id)
    expect(payload.doc.title).toBe('hi')
    // HMAC signature matches the body.
    const expected = `sha256=${createHmac('sha256', 'shh').update(all[0]!.body).digest('hex')}`
    expect(all[0]!.headers['x-kernel-signature']).toBe(expected)
    expect(all[0]!.headers['x-kernel-event']).toBe('create')
  })

  it('respects the events filter (delete-only hook silent on create)', async () => {
    await kernel.create({ collection: 'posts', data: { title: 'x' }, overrideAccess: true })
    expect(fetchStub.calls.some((c) => c.url === 'https://hook.example/deletes-only')).toBe(false)
  })

  it('fires on delete for matching hooks', async () => {
    const doc = await kernel.create({ collection: 'posts', data: { title: 'x' }, overrideAccess: true })
    fetchStub.calls.length = 0
    await kernel.delete({ collection: 'posts', id: doc.id, overrideAccess: true })
    const urls = fetchStub.calls.map((c) => c.url)
    expect(urls).toContain('https://hook.example/all')
    expect(urls).toContain('https://hook.example/deletes-only')
  })

  it('respects the collections filter', async () => {
    await kernel.create({ collection: 'notes', data: { body: 'x' }, overrideAccess: true })
    expect(fetchStub.calls.some((c) => c.url === 'https://hook.example/posts-only')).toBe(false)
    // The unrestricted hook still fired for notes.
    expect(fetchStub.calls.some((c) => c.url === 'https://hook.example/all')).toBe(true)
  })

  it('never throws when the receiver fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      }),
    )
    // The write still succeeds despite the webhook failing.
    const doc = await kernel.create({ collection: 'posts', data: { title: 'resilient' }, overrideAccess: true })
    expect(doc.id).toBeTruthy()
  })
})
