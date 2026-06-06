import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { defineConfig, initKernel, totpCode, verifyTotp } from './index'
import type { Kernel } from './index'

const trusted = { overrideAccess: true } as const

function buildConfig() {
  return defineConfig({
    secret: 'test-secret',
    db: sqliteAdapter({ url: ':memory:' }),
    collections: [
      {
        slug: 'users',
        auth: { twoFactor: true },
        access: { read: () => true, create: () => true, update: () => true },
        fields: [],
      },
    ],
  })
}

describe('TOTP primitives', () => {
  it('verifies its own generated code and rejects a wrong one', () => {
    const secret = 'JBSWY3DPEHPK3PXP' // RFC test vector secret
    const now = 1_700_000_000_000
    const code = totpCode(secret, now)
    expect(code).toMatch(/^\d{6}$/)
    expect(verifyTotp(secret, code, now)).toBe(true)
    expect(verifyTotp(secret, '000000', now)).toBe(false)
  })

  it('tolerates one step of clock drift', () => {
    const secret = 'JBSWY3DPEHPK3PXP'
    const now = 1_700_000_000_000
    const prevStep = totpCode(secret, now - 30_000)
    expect(verifyTotp(secret, prevStep, now, 1)).toBe(true)
  })
})

describe('two-factor login flow', () => {
  let kernel: Kernel
  beforeEach(async () => {
    kernel = await initKernel(buildConfig(), { logLevel: 'error' })
    await kernel.migrate()
    await kernel.create({ collection: 'users', data: { email: 'a@x.test', password: 'password123' }, ...trusted })
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('only requires a code after 2FA is enabled', async () => {
    const user = (await kernel.find({ collection: 'users', ...trusted })).docs[0]!

    // Before enabling: a plain login works.
    await expect(
      kernel.login({ collection: 'users', email: 'a@x.test', password: 'password123' }),
    ).resolves.toMatchObject({ user: { email: 'a@x.test' } })

    // Set up + enable with a current code.
    const { secret } = await kernel.setupTwoFactor({ collection: 'users', id: user.id })
    await kernel.enableTwoFactor({ collection: 'users', id: user.id, code: totpCode(secret) })

    // Now login without a code is rejected…
    await expect(kernel.login({ collection: 'users', email: 'a@x.test', password: 'password123' })).rejects.toThrow()
    // …and with a valid code it succeeds.
    await expect(
      kernel.login({ collection: 'users', email: 'a@x.test', password: 'password123', code: totpCode(secret) }),
    ).resolves.toMatchObject({ user: { email: 'a@x.test' } })
  })

  it('rejects enabling 2FA with a bad code, and lets you disable it', async () => {
    const user = (await kernel.find({ collection: 'users', ...trusted })).docs[0]!
    const { secret } = await kernel.setupTwoFactor({ collection: 'users', id: user.id })
    await expect(
      kernel.enableTwoFactor({ collection: 'users', id: user.id, code: '000000' }),
    ).rejects.toThrow()

    await kernel.enableTwoFactor({ collection: 'users', id: user.id, code: totpCode(secret) })
    await kernel.disableTwoFactor({ collection: 'users', id: user.id })
    // After disabling, a plain login works again.
    await expect(
      kernel.login({ collection: 'users', email: 'a@x.test', password: 'password123' }),
    ).resolves.toMatchObject({ user: { email: 'a@x.test' } })
  })

  it('never returns the TOTP secret through the API', async () => {
    const user = (await kernel.find({ collection: 'users', ...trusted })).docs[0]!
    await kernel.setupTwoFactor({ collection: 'users', id: user.id })
    const reread = await kernel.findByID({ collection: 'users', id: user.id, ...trusted })
    expect(reread?.totp_secret).toBeUndefined()
    expect('totp_enabled' in (reread ?? {})).toBe(true)
  })
})
