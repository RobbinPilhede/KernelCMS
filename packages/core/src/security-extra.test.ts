import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { defineConfig, initKernel, memoryEmail } from './index'
import type { Kernel } from './index'

describe('globals enforce field-level read access', () => {
  let kernel: Kernel
  beforeEach(async () => {
    kernel = await initKernel(
      defineConfig({
        secret: 'test-secret',
        db: sqliteAdapter({ url: ':memory:' }),
        globals: [
          {
            slug: 'settings',
            access: { read: () => true, update: () => true },
            fields: [
              { name: 'title', type: 'text' },
              { name: 'api_token', type: 'text', access: { read: () => false } },
            ],
          },
        ],
        collections: [],
      }),
      { logLevel: 'error' },
    )
    await kernel.migrate()
    await kernel.updateGlobal({
      slug: 'settings',
      data: { title: 'Site', api_token: 'super-secret' },
      overrideAccess: true,
    })
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('strips a read-restricted global field for a normal caller', async () => {
    const g = await kernel.findGlobal({ slug: 'settings', req: { user: { id: 'u1', collection: 'x' } } })
    expect(g.title).toBe('Site')
    expect(g.api_token).toBeUndefined()
  })

  it('returns the field with overrideAccess', async () => {
    const g = await kernel.findGlobal({ slug: 'settings', overrideAccess: true })
    expect(g.api_token).toBe('super-secret')
  })
})

describe('an empty or:[] access scope denies (fails closed)', () => {
  let kernel: Kernel
  beforeEach(async () => {
    kernel = await initKernel(
      defineConfig({
        secret: 'test-secret',
        db: sqliteAdapter({ url: ':memory:' }),
        collections: [
          {
            slug: 'docs',
            // Deny-all expressed as an empty disjunction.
            access: { read: () => ({ or: [] }), create: () => true },
            fields: [{ name: 'title', type: 'text' }],
          },
        ],
      }),
      { logLevel: 'error' },
    )
    await kernel.migrate()
    await kernel.create({ collection: 'docs', data: { title: 'one' }, overrideAccess: true })
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('matches no rows for a non-override caller', async () => {
    const res = await kernel.find({ collection: 'docs', req: { user: { id: 'u1', collection: 'x' } } })
    expect(res.totalDocs).toBe(0)
  })
})

describe('changing a password invalidates existing sessions', () => {
  let kernel: Kernel
  beforeEach(async () => {
    kernel = await initKernel(
      defineConfig({
        secret: 'test-secret',
        db: sqliteAdapter({ url: ':memory:' }),
        collections: [
          {
            slug: 'users',
            auth: true,
            access: { read: () => true, create: () => true, update: () => true },
            fields: [],
          },
        ],
      }),
      { logLevel: 'error' },
    )
    await kernel.migrate()
    await kernel.create({
      collection: 'users',
      data: { email: 'a@x.test', password: 'password123' },
      overrideAccess: true,
    })
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('rejects a token issued before a password change', async () => {
    const { token, user } = await kernel.login({ collection: 'users', email: 'a@x.test', password: 'password123' })
    expect(await kernel.authenticate(token)).not.toBeNull()

    await kernel.update({
      collection: 'users',
      id: user.id,
      data: { password: 'a-new-password' },
      overrideAccess: true,
    })

    // The old token must no longer authenticate.
    expect(await kernel.authenticate(token)).toBeNull()
    // A fresh login works again.
    const fresh = await kernel.login({ collection: 'users', email: 'a@x.test', password: 'a-new-password' })
    expect(await kernel.authenticate(fresh.token)).not.toBeNull()
  })
})

describe('server-managed auth fields are not client-writable', () => {
  let kernel: Kernel
  beforeEach(async () => {
    kernel = await initKernel(
      defineConfig({
        secret: 'test-secret',
        db: sqliteAdapter({ url: ':memory:' }),
        collections: [
          {
            slug: 'users',
            auth: { verify: true },
            // Deliberately permissive doc-level access; field-level system guards
            // must still hold.
            access: { read: () => true, create: () => true, update: () => true },
            fields: [],
          },
        ],
      }),
      { logLevel: 'error' },
    )
    await kernel.migrate()
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('ignores a client-supplied email_verified on create', async () => {
    const user = await kernel.create({
      collection: 'users',
      data: { email: 'a@x.test', password: 'password123', email_verified: true } as never,
    })
    const row = await kernel.findByID({ collection: 'users', id: user.id, overrideAccess: true })
    expect(row?.email_verified === true || row?.email_verified === 1).toBe(false)
  })

  it('ignores a client-supplied token_version on update', async () => {
    const user = await kernel.create({
      collection: 'users',
      data: { email: 'b@x.test', password: 'password123' },
      overrideAccess: true,
    })
    await kernel.update({ collection: 'users', id: user.id, data: { token_version: 9999 } as never })
    const row = await kernel.findByID({ collection: 'users', id: user.id, overrideAccess: true })
    expect(Number(row?.token_version ?? 0)).not.toBe(9999)
  })
})

describe('forgot-password is rate limited', () => {
  let kernel: Kernel
  beforeEach(async () => {
    kernel = await initKernel(
      defineConfig({
        secret: 'test-secret',
        db: sqliteAdapter({ url: ':memory:' }),
        email: memoryEmail(),
        collections: [
          {
            slug: 'users',
            auth: { forgotPassword: true },
            access: { read: () => true, create: () => true },
            fields: [],
          },
        ],
      }),
      { logLevel: 'error' },
    )
    await kernel.migrate()
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('throws after the per-email request budget is exceeded', async () => {
    const email = 'spam-target@x.test'
    // The first few requests resolve (no enumeration); the burst then trips the limiter.
    await kernel.forgotPassword({ collection: 'users', email })
    await kernel.forgotPassword({ collection: 'users', email })
    await kernel.forgotPassword({ collection: 'users', email })
    await expect(kernel.forgotPassword({ collection: 'users', email })).rejects.toThrow(/too many/i)
  })
})
