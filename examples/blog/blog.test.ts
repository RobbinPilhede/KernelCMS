import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { initKernel } from '@kernel/core'
import type { Kernel } from '@kernel/core'
import { serve } from '@kernel/server'
import type { RunningServer } from '@kernel/server'
import { KernelClientError, createClient } from '@kernel/client'
import type { KernelClient } from '@kernel/client'

// Configure the example to run fully in-memory before importing it.
process.env.KERNEL_DB_URL = ':memory:'
process.env.KERNEL_SECRET = 'test-secret'

const API_KEY = 'test-api-key'

let kernel: Kernel
let server: RunningServer
let client: KernelClient

beforeAll(async () => {
  const mod = await import('./kernel.config')
  kernel = await initKernel(mod.default, { autoMigrate: true, logLevel: 'error' })
  await mod.seed(kernel)
  server = await serve(kernel, { port: 0, apiKey: API_KEY, cors: true })
  client = createClient({ baseURL: server.url, apiKey: API_KEY })
})

afterAll(async () => {
  await server.close()
  await kernel.destroy()
})

describe('HTTP API', () => {
  it('reports health', async () => {
    const health = await client.health()
    expect(health.status).toBe('ok')
    expect(health.db.status).toBe('ok')
  })

  it('serves seeded posts on a public read', async () => {
    const posts = await client.find('posts')
    expect(posts.totalDocs).toBeGreaterThanOrEqual(3)
  })

  it('filters via bracket query params', async () => {
    const res = await fetch(`${server.url}/api/posts?where[status][equals]=published&sort=title`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { docs: Array<{ status: string }> }
    expect(body.docs.length).toBeGreaterThanOrEqual(2)
    expect(body.docs.every((d) => d.status === 'published')).toBe(true)
  })

  it('denies anonymous writes (secure by default)', async () => {
    const res = await fetch(`${server.url}/api/authors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Intruder' }),
    })
    expect(res.status).toBe(403)
  })

  it('allows writes with the system API key', async () => {
    const author = await client.create<{ id: string; name: string }>('authors', {
      name: 'Grace Hopper',
      email: 'grace@example.com',
    })
    expect(author.id).toBeTypeOf('string')

    const fetched = await client.findByID<{ name: string }>('authors', author.id)
    expect(fetched.name).toBe('Grace Hopper')
  })

  it('rejects invalid documents with 400 and field errors', async () => {
    try {
      await client.create('posts', { title: 'ab' })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(KernelClientError)
      expect((err as KernelClientError).status).toBe(400)
      expect((err as KernelClientError).code).toBe('VALIDATION')
    }
  })

  it('returns 404 for a missing document', async () => {
    try {
      await client.findByID('posts', 'does-not-exist')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect((err as KernelClientError).status).toBe(404)
    }
  })

  it('populates relationships at depth', async () => {
    const list = await client.find<{ author: unknown }>('posts', {
      where: { slug: { equals: 'hello-kernelcms' } },
      depth: 1,
    })
    const post = list.docs[0]
    expect(post).toBeDefined()
    expect((post?.author as { name: string }).name).toBe('Ada Lovelace')
  })

  it('logs in and authorizes writes with a user token', async () => {
    const res = await fetch(`${server.url}/api/users/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'password123' }),
    })
    expect(res.status).toBe(200)
    const { token, user } = (await res.json()) as { token: string; user: { email: string; hash?: string } }
    expect(user.email).toBe('admin@example.com')
    expect(user.hash).toBeUndefined()

    const authed = createClient({ baseURL: server.url, token })
    const post = await authed.create<{ id: string }>('posts', { title: 'Written by a user', slug: 'by-a-user' })
    expect(post.id).toBeTypeOf('string')

    const me = await fetch(`${server.url}/api/users/me`, { headers: { authorization: `Bearer ${token}` } })
    expect(me.status).toBe(200)
  })

  it('rejects bad credentials with 401', async () => {
    const res = await fetch(`${server.url}/api/users/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'wrong-password' }),
    })
    expect(res.status).toBe(401)
  })

  it('reads and writes globals', async () => {
    const settings = await client.findGlobal('site_settings')
    expect(settings.site_name).toBe('The Kernel Blog')

    const updated = await client.updateGlobal('site_settings', { site_name: 'Renamed Blog' })
    expect(updated.site_name).toBe('Renamed Blog')
  })
})
