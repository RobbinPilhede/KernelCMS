import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { initKernel, memoryEmail, totpCode } from '@kernel/core'
import type { EmailMessage, Kernel, MemoryEmailAdapter } from '@kernel/core'
import { localStorage } from '@kernel/storage'
import { createRequestHandler } from './index'

let kernel: Kernel

beforeEach(async () => {
  kernel = await initKernel(
    {
      secret: 'test-secret',
      db: sqliteAdapter({ url: ':memory:' }),
      collections: [{ slug: 'posts', access: { read: () => true }, fields: [{ name: 'title', type: 'text' }] }],
    },
    { logLevel: 'error' },
  )
  await kernel.migrate()
})

afterEach(async () => {
  await kernel.destroy()
})

function request(origin: string): Request {
  return new Request('http://localhost/api/health', { headers: { origin } })
}

describe('CORS', () => {
  it('reflects the origin but withholds credentials when cors:true', async () => {
    const handler = createRequestHandler(kernel, { cors: true })
    const res = await handler(request('http://evil.example'))
    // Reflected origin is allowed for unauthenticated (no-credential) requests…
    expect(res.headers.get('access-control-allow-origin')).toBe('http://evil.example')
    // …but credentials must NOT be permitted on a reflected/wildcard origin.
    expect(res.headers.get('access-control-allow-credentials')).toBeNull()
  })

  it('permits credentials only for an allow-listed origin', async () => {
    const handler = createRequestHandler(kernel, { cors: ['http://app.example'] })
    const res = await handler(request('http://app.example'))
    expect(res.headers.get('access-control-allow-origin')).toBe('http://app.example')
    expect(res.headers.get('access-control-allow-credentials')).toBe('true')
  })

  it('omits CORS headers for an origin not on the allow-list', async () => {
    const handler = createRequestHandler(kernel, { cors: ['http://app.example'] })
    const res = await handler(request('http://evil.example'))
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
    expect(res.headers.get('access-control-allow-credentials')).toBeNull()
  })

  it('answers preflight without leaking credentials under cors:true', async () => {
    const handler = createRequestHandler(kernel, { cors: true })
    const res = await handler(
      new Request('http://localhost/api/posts', { method: 'OPTIONS', headers: { origin: 'http://evil.example' } }),
    )
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-credentials')).toBeNull()
  })
})

describe('built-in admin', () => {
  let adminKernel: Kernel
  let handler: (req: Request) => Promise<Response>

  beforeEach(async () => {
    adminKernel = await initKernel(
      {
        secret: 'admin-secret',
        db: sqliteAdapter({ url: ':memory:' }),
        collections: [
          {
            slug: 'users',
            auth: true,
            access: { read: () => true },
            fields: [{ name: 'roles', type: 'select', options: ['user', 'admin'], hasMany: true, defaultValue: ['user'] }],
          },
        ],
      },
      { logLevel: 'error' },
    )
    await adminKernel.migrate()
    handler = createRequestHandler(adminKernel, { admin: true })
  })
  afterEach(async () => {
    await adminKernel.destroy()
  })

  it('serves the admin HTML shell at /admin and /login', async () => {
    for (const path of ['/admin', '/login']) {
      const res = await handler(new Request('http://localhost' + path))
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/html')
      expect(await res.text()).toContain('KernelCMS Admin')
    }
  })

  it('leaves / alone (no redirect; admin stays at /admin)', async () => {
    const res = await handler(new Request('http://localhost/'))
    expect(res.status).toBe(404)
    expect(res.headers.get('location')).toBeNull()
  })

  it('reports needsSetup before any user exists, false after', async () => {
    const before = (await (await handler(new Request('http://localhost/api/_admin/status'))).json()) as {
      needsSetup: boolean
      authCollection: string | null
    }
    expect(before).toEqual({ needsSetup: true, authCollection: 'users' })

    const setup = await handler(
      new Request('http://localhost/api/_admin/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'admin@example.com', password: 'supersecret123' }),
      }),
    )
    expect(setup.status).toBe(201)
    const created = (await setup.json()) as { token: string; user: { roles: string[] } }
    expect(created.token).toBeTypeOf('string')
    expect(created.user.roles).toEqual(['admin'])

    const after = (await (await handler(new Request('http://localhost/api/_admin/status'))).json()) as {
      needsSetup: boolean
    }
    expect(after.needsSetup).toBe(false)
  })

  it('refuses a second setup once an admin exists (takeover guard)', async () => {
    const body = JSON.stringify({ email: 'first@example.com', password: 'supersecret123' })
    await handler(new Request('http://localhost/api/_admin/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body }))

    const second = await handler(
      new Request('http://localhost/api/_admin/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'intruder@example.com', password: 'supersecret123' }),
      }),
    )
    expect(second.status).toBe(403)
  })

  it('lets the seeded admin log in via the REST endpoint', async () => {
    const body = JSON.stringify({ email: 'admin@example.com', password: 'supersecret123' })
    await handler(new Request('http://localhost/api/_admin/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body }))

    const login = await handler(new Request('http://localhost/api/users/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body }))
    expect(login.status).toBe(200)
    expect(((await login.json()) as { token: string }).token).toBeTypeOf('string')
  })
})

describe('password reset & verification (REST)', () => {
  let k: Kernel
  let h: (req: Request) => Promise<Response>
  let email: MemoryEmailAdapter
  const JSON_HEADERS = { 'content-type': 'application/json' }

  const post = (path: string, body: unknown) =>
    h(new Request('http://localhost/api' + path, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) }))
  const tokenOf = (msg: EmailMessage) => /token=([^&\s"']+)/.exec(msg.text ?? msg.html)![1]!

  beforeEach(async () => {
    email = memoryEmail()
    k = await initKernel(
      {
        secret: 'reset-secret',
        serverURL: 'http://localhost',
        db: sqliteAdapter({ url: ':memory:' }),
        email,
        collections: [
          {
            slug: 'users',
            auth: { verify: true, forgotPassword: true },
            access: { read: () => true, create: () => true },
            fields: [],
          },
        ],
      },
      { logLevel: 'error' },
    )
    await k.migrate()
    h = createRequestHandler(k, { admin: true })
  })
  afterEach(async () => {
    await k.destroy()
  })

  it('runs the full forgot → reset → login flow over HTTP', async () => {
    // Bootstrap the (auto-verified) admin via setup.
    await post('/_admin/setup', { email: 'admin@example.com', password: 'supersecret123' })
    email.clear()

    const forgot = await post('/users/forgot-password', { email: 'admin@example.com' })
    expect(forgot.status).toBe(200)
    expect(email.sent).toHaveLength(1)

    const reset = await post('/users/reset-password', {
      token: tokenOf(email.sent[0]!),
      password: 'a-fresh-password',
    })
    expect(reset.status).toBe(200)

    const login = await post('/users/login', { email: 'admin@example.com', password: 'a-fresh-password' })
    expect(login.status).toBe(200)
  })

  it('returns a generic success for an unknown email (no enumeration)', async () => {
    await post('/_admin/setup', { email: 'admin@example.com', password: 'supersecret123' })
    email.clear()
    const forgot = await post('/users/forgot-password', { email: 'ghost@example.com' })
    expect(forgot.status).toBe(200)
    expect((await forgot.json()) as { success: boolean }).toEqual({ success: true })
    expect(email.sent).toHaveLength(0)
  })

  it('verifies a freshly created user and unblocks login', async () => {
    // First admin (auto-verified) so we can act as a trusted creator.
    const setup = await post('/_admin/setup', { email: 'admin@example.com', password: 'supersecret123' })
    const adminToken = ((await setup.json()) as { token: string }).token
    email.clear()

    // Create a second user → triggers a verification email and is login-blocked.
    await h(
      new Request('http://localhost/api/users', {
        method: 'POST',
        headers: { ...JSON_HEADERS, Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ email: 'member@example.com', password: 'member-password' }),
      }),
    )
    expect(email.sent).toHaveLength(1)

    const blocked = await post('/users/login', { email: 'member@example.com', password: 'member-password' })
    expect(blocked.status).toBe(403)

    const verify = await post('/users/verify-email', { token: tokenOf(email.sent[0]!) })
    expect(verify.status).toBe(200)

    const ok = await post('/users/login', { email: 'member@example.com', password: 'member-password' })
    expect(ok.status).toBe(200)
  })
})

describe('versions & drafts (REST)', () => {
  let vKernel: Kernel
  let h: (req: Request) => Promise<Response>
  const SVC = 'svc-key'
  const auth = { Authorization: `Bearer ${SVC}`, 'content-type': 'application/json' }

  beforeEach(async () => {
    vKernel = await initKernel(
      {
        secret: 'v-secret',
        db: sqliteAdapter({ url: ':memory:' }),
        collections: [
          {
            slug: 'articles',
            access: { read: () => true },
            versions: { drafts: true },
            fields: [{ name: 'title', type: 'text', required: true }],
          },
        ],
      },
      { logLevel: 'error' },
    )
    await vKernel.migrate()
    h = createRequestHandler(vKernel, { apiKey: SVC })
  })
  afterEach(async () => {
    await vKernel.destroy()
  })

  async function createArticle(title: string) {
    const res = await h(
      new Request('http://localhost/api/articles', { method: 'POST', headers: auth, body: JSON.stringify({ title }) }),
    )
    return (await res.json()) as { id: string; _status: string; title: string }
  }

  it('new article is a draft, hidden from the published list but visible with ?draft=true', async () => {
    const a = await createArticle('Draft article')
    expect(a._status).toBe('draft')

    const pub = (await (await h(new Request('http://localhost/api/articles'))).json()) as { totalDocs: number }
    expect(pub.totalDocs).toBe(0)

    const drafts = (await (
      await h(new Request('http://localhost/api/articles?draft=true', { headers: auth }))
    ).json()) as { totalDocs: number }
    expect(drafts.totalDocs).toBe(1)
  })

  it('publish then unpublish toggles public visibility and records versions', async () => {
    const a = await createArticle('Publish me')

    const pubRes = await h(new Request(`http://localhost/api/articles/${a.id}/publish`, { method: 'POST', headers: auth }))
    expect(pubRes.status).toBe(200)
    expect(((await pubRes.json()) as { _status: string })._status).toBe('published')

    expect((await h(new Request(`http://localhost/api/articles/${a.id}`))).status).toBe(200)

    const versions = (await (
      await h(new Request(`http://localhost/api/articles/${a.id}/versions`, { headers: auth }))
    ).json()) as { totalDocs: number }
    expect(versions.totalDocs).toBeGreaterThanOrEqual(2) // create + publish

    await h(new Request(`http://localhost/api/articles/${a.id}/unpublish`, { method: 'POST', headers: auth }))
    expect((await h(new Request(`http://localhost/api/articles/${a.id}`))).status).toBe(404)
  })

  it('restores a prior version via REST', async () => {
    const a = await createArticle('First title')
    await h(
      new Request(`http://localhost/api/articles/${a.id}`, {
        method: 'PATCH',
        headers: auth,
        body: JSON.stringify({ title: 'Second title' }),
      }),
    )
    const list = (await (
      await h(new Request(`http://localhost/api/articles/${a.id}/versions`, { headers: auth }))
    ).json()) as { docs: Array<{ id: string; version: { title: string } }> }
    const first = list.docs.find((v) => v.version.title === 'First title')!

    const restored = await h(
      new Request(`http://localhost/api/articles/${a.id}/versions/${first.id}/restore`, { method: 'POST', headers: auth }),
    )
    expect(restored.status).toBe(200)
    expect(((await restored.json()) as { title: string }).title).toBe('First title')
  })
})

describe('uploads (REST + local delivery)', () => {
  let uKernel: Kernel
  let h: (req: Request) => Promise<Response>
  let dir: string
  const SVC = 'svc-key'
  // A minimal valid PNG signature is enough for the magic-byte sniff.
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kernel-srv-uploads-'))
    uKernel = await initKernel(
      {
        secret: 'u-secret',
        db: sqliteAdapter({ url: ':memory:' }),
        storage: localStorage({ rootDir: dir, servePath: '/files' }),
        collections: [
          {
            slug: 'media',
            access: { read: () => true },
            upload: { mimeTypes: ['image/*'], maxFileSize: 1024 },
            fields: [{ name: 'alt', type: 'text', required: true }],
          },
          {
            slug: 'private_media',
            // Only authenticated callers may read — exercises proxy-mode delivery.
            access: { read: ({ req }) => Boolean(req.user) },
            upload: { mimeTypes: ['image/*'] },
            fields: [{ name: 'alt', type: 'text', required: true }],
          },
        ],
      },
      { logLevel: 'error' },
    )
    await uKernel.migrate()
    h = createRequestHandler(uKernel, { apiKey: SVC })
  })
  afterAll(async () => {
    await uKernel.destroy()
    await rm(dir, { recursive: true, force: true })
  })

  it('accepts a multipart upload and serves the stored bytes from servePath', async () => {
    const form = new FormData()
    form.set('file', new File([PNG], 'shot.png', { type: 'image/png' }))
    form.set('alt', 'A screenshot')

    const res = await h(
      new Request('http://localhost/api/media', { method: 'POST', headers: { Authorization: `Bearer ${SVC}` }, body: form }),
    )
    expect(res.status).toBe(201)
    const doc = (await res.json()) as { url: string; alt: string; mime_type: string; filesize: number }
    expect(doc.alt).toBe('A screenshot')
    expect(doc.mime_type).toBe('image/png')
    expect(doc.filesize).toBe(PNG.length)
    expect(doc.url).toMatch(/^\/files\/media\//)

    // The local delivery route streams the bytes back with the right content type.
    const file = await h(new Request(`http://localhost${doc.url}`))
    expect(file.status).toBe(200)
    expect(file.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await file.arrayBuffer()).equals(PNG)).toBe(true)
  })

  it('rejects a non-image masquerading via its filename', async () => {
    const form = new FormData()
    form.set('file', new File([Buffer.from('<?php ?>', 'utf8')], 'evil.png', { type: 'image/png' }))
    form.set('alt', 'x')
    const res = await h(
      new Request('http://localhost/api/media', { method: 'POST', headers: { Authorization: `Bearer ${SVC}` }, body: form }),
    )
    expect(res.status).toBe(400)
  })

  it('enforces collection read access on the delivery route (proxy mode)', async () => {
    const form = new FormData()
    form.set('file', new File([PNG], 'secret.png', { type: 'image/png' }))
    form.set('alt', 'classified')
    const created = await h(
      new Request('http://localhost/api/private_media', { method: 'POST', headers: { Authorization: `Bearer ${SVC}` }, body: form }),
    )
    expect(created.status).toBe(201)
    const { url } = (await created.json()) as { url: string }

    // Unauthenticated request is denied (read access requires a user) → 404.
    const anon = await h(new Request(`http://localhost${url}`))
    expect(anon.status).toBe(404)

    // The system caller (apiKey) passes access → bytes are served.
    const authed = await h(new Request(`http://localhost${url}`, { headers: { Authorization: `Bearer ${SVC}` } }))
    expect(authed.status).toBe(200)
    expect(Buffer.from(await authed.arrayBuffer()).equals(PNG)).toBe(true)
  })
})

describe('bulk operations (REST)', () => {
  let bKernel: Kernel
  let h: (req: Request) => Promise<Response>
  const SVC = 'svc-key'
  const auth = { Authorization: `Bearer ${SVC}`, 'content-type': 'application/json' }

  beforeEach(async () => {
    bKernel = await initKernel(
      {
        secret: 'bulk-secret',
        db: sqliteAdapter({ url: ':memory:' }),
        collections: [
          {
            slug: 'tasks',
            access: { read: () => true },
            fields: [
              { name: 'title', type: 'text', required: true },
              { name: 'done', type: 'boolean', defaultValue: false },
            ],
          },
        ],
      },
      { logLevel: 'error' },
    )
    await bKernel.migrate()
    h = createRequestHandler(bKernel, { apiKey: SVC })
    for (const t of [
      { title: 'a', done: true },
      { title: 'b', done: true },
      { title: 'c', done: false },
    ]) {
      await h(new Request('http://localhost/api/tasks', { method: 'POST', headers: auth, body: JSON.stringify(t) }))
    }
  })
  afterEach(async () => {
    await bKernel.destroy()
  })

  it('PATCH /:collection?where updates all matching docs', async () => {
    const where = encodeURIComponent(JSON.stringify({ done: { equals: true } }))
    const res = await h(
      new Request(`http://localhost/api/tasks?where=${where}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ done: false }) }),
    )
    expect(res.status).toBe(200)
    expect(((await res.json()) as { count: number }).count).toBe(2)
  })

  it('DELETE /:collection?where removes only matching docs', async () => {
    const where = encodeURIComponent(JSON.stringify({ done: { equals: true } }))
    const res = await h(new Request(`http://localhost/api/tasks?where=${where}`, { method: 'DELETE', headers: auth }))
    expect(res.status).toBe(200)
    expect(((await res.json()) as { count: number }).count).toBe(2)
    const left = (await (await h(new Request('http://localhost/api/tasks'))).json()) as { totalDocs: number }
    expect(left.totalDocs).toBe(1)
  })

  it('refuses an unscoped bulk delete (no where) with 400', async () => {
    const res = await h(new Request('http://localhost/api/tasks', { method: 'DELETE', headers: auth }))
    expect(res.status).toBe(400)
  })
})

describe('graphql endpoint', () => {
  let gKernel: Kernel
  let h: (req: Request) => Promise<Response>
  const SVC = 'svc-key'
  const auth = { Authorization: `Bearer ${SVC}`, 'content-type': 'application/json' }

  beforeEach(async () => {
    gKernel = await initKernel(
      {
        secret: 'g-secret',
        db: sqliteAdapter({ url: ':memory:' }),
        collections: [
          { slug: 'posts', access: { read: () => true }, fields: [{ name: 'title', type: 'text', required: true }] },
        ],
      },
      { logLevel: 'error' },
    )
    await gKernel.migrate()
    h = createRequestHandler(gKernel, { apiKey: SVC, graphql: true })
  })
  afterEach(async () => {
    await gKernel.destroy()
  })

  it('executes a create mutation then a query over the generated schema', async () => {
    const mutate = await h(
      new Request('http://localhost/api/graphql', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ query: 'mutation($d: JSON!){ createPosts(data:$d){ id title } }', variables: { d: { title: 'GQL' } } }),
      }),
    )
    expect(mutate.status).toBe(200)
    expect(((await mutate.json()) as { data: { createPosts: { title: string } } }).data.createPosts.title).toBe('GQL')

    const query = await h(
      new Request('http://localhost/api/graphql', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ query: '{ posts { totalDocs docs { title } } }' }),
      }),
    )
    expect(((await query.json()) as { data: { posts: { totalDocs: number } } }).data.posts.totalDocs).toBe(1)
  })

  it('returns 404 when graphql is not enabled', async () => {
    const off = createRequestHandler(gKernel, { apiKey: SVC })
    const res = await off(new Request('http://localhost/api/graphql', { method: 'POST', headers: auth, body: '{}' }))
    expect(res.status).toBe(404)
  })
})

describe('API key auth (REST)', () => {
  let aKernel: Kernel
  let h: (req: Request) => Promise<Response>

  beforeEach(async () => {
    aKernel = await initKernel(
      {
        secret: 'apikey-rest',
        db: sqliteAdapter({ url: ':memory:' }),
        collections: [
          { slug: 'agents', auth: { useAPIKey: true }, access: { read: () => true, create: () => true }, fields: [{ name: 'name', type: 'text' }] },
          {
            slug: 'notes',
            // Only an authenticated caller may read notes.
            access: { read: ({ req }) => Boolean(req.user), create: () => true },
            fields: [{ name: 'body', type: 'text' }],
          },
        ],
      },
      { logLevel: 'error' },
    )
    await aKernel.migrate()
    h = createRequestHandler(aKernel)
  })
  afterEach(async () => {
    await aKernel.destroy()
  })

  it('authenticates a request via the per-collection API-Key header', async () => {
    const agent = await aKernel.create({ collection: 'agents', data: { email: 'a@x.co', password: 'a-long-password' }, overrideAccess: true })
    const { key } = await aKernel.createAPIKey({ collection: 'agents', id: agent.id })
    await aKernel.create({ collection: 'notes', data: { body: 'secret' }, overrideAccess: true })

    // Anonymous read is denied by the notes read-access rule → 403.
    const anon = await h(new Request('http://localhost/api/notes'))
    expect(anon.status).toBe(403)

    // With the API key, the caller is authenticated → the note is visible.
    const authedRes = await h(new Request('http://localhost/api/notes', { headers: { Authorization: `agents API-Key ${key}` } }))
    expect(authedRes.status).toBe(200)
    expect(((await authedRes.json()) as { totalDocs: number }).totalDocs).toBe(1)
  })
})

describe('two-factor auth (REST)', () => {
  let k: Kernel
  let h: (req: Request) => Promise<Response>
  const JSON_HEADERS = { 'content-type': 'application/json' }

  beforeEach(async () => {
    k = await initKernel(
      {
        secret: '2fa-secret',
        db: sqliteAdapter({ url: ':memory:' }),
        collections: [
          {
            slug: 'users',
            auth: { twoFactor: true },
            access: { read: () => true },
            fields: [{ name: 'roles', type: 'select', options: ['user', 'admin'], hasMany: true, defaultValue: ['user'] }],
          },
        ],
      },
      { logLevel: 'error' },
    )
    await k.migrate()
    h = createRequestHandler(k, { admin: true })
  })
  afterEach(async () => {
    await k.destroy()
  })

  it('enrols 2FA and then requires a code at login', async () => {
    const setup = await h(
      new Request('http://localhost/api/_admin/setup', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ email: 'admin@example.com', password: 'supersecret123' }),
      }),
    )
    const token = ((await setup.json()) as { token: string }).token
    const authed = { ...JSON_HEADERS, Authorization: `Bearer ${token}` }

    // Set up → returns a secret; enable it with a current code.
    const setupRes = await h(new Request('http://localhost/api/users/2fa-setup', { method: 'POST', headers: authed }))
    expect(setupRes.status).toBe(200)
    const { secret } = (await setupRes.json()) as { secret: string }
    const enableRes = await h(
      new Request('http://localhost/api/users/2fa-enable', {
        method: 'POST',
        headers: authed,
        body: JSON.stringify({ code: totpCode(secret) }),
      }),
    )
    expect(enableRes.status).toBe(200)

    // Login without a code is now rejected; with a code it succeeds.
    const noCode = await h(
      new Request('http://localhost/api/users/login', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ email: 'admin@example.com', password: 'supersecret123' }),
      }),
    )
    expect(noCode.status).toBe(401)

    const withCode = await h(
      new Request('http://localhost/api/users/login', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ email: 'admin@example.com', password: 'supersecret123', code: totpCode(secret) }),
      }),
    )
    expect(withCode.status).toBe(200)
  })
})

describe('admin component overrides (script injection)', () => {
  let k: Kernel
  beforeEach(async () => {
    k = await initKernel(
      { secret: 's', db: sqliteAdapter({ url: ':memory:' }), collections: [{ slug: 'posts', access: { read: () => true }, fields: [{ name: 'title', type: 'text' }] }] },
      { logLevel: 'error' },
    )
    await k.migrate()
  })
  afterEach(async () => {
    await k.destroy()
  })

  it('injects configured admin scripts into the shell, and omits them otherwise', async () => {
    const withScripts = createRequestHandler(k, { admin: { scripts: ['/custom/fields.js'] } })
    const res = await withScripts(new Request('http://localhost/admin'))
    const body = await res.text()
    expect(body).toContain('<script src="/custom/fields.js" type="module"></script>')
    expect(body).toContain('</body>')

    const plain = createRequestHandler(k, { admin: true })
    const plainBody = await (await plain(new Request('http://localhost/admin'))).text()
    expect(plainBody).not.toContain('/custom/fields.js')
  })
})
