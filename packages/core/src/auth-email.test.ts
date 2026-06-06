import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { BadRequestError, ForbiddenError, defineConfig, initKernel, memoryEmail } from './index'
import type { Kernel, MemoryEmailAdapter } from './index'

const trusted = { overrideAccess: true } as const

function buildConfig(email: MemoryEmailAdapter) {
  return defineConfig({
    secret: 'test-secret',
    serverURL: 'http://localhost:3000',
    db: sqliteAdapter({ url: ':memory:' }),
    email,
    collections: [
      {
        slug: 'users',
        auth: { verify: true, forgotPassword: true },
        access: { read: () => true, create: () => true, update: () => true },
        fields: [{ name: 'name', type: 'text' }],
      },
    ],
  })
}

/** Pull the single-use token out of the link the default email template builds. */
function tokenFromEmail(body: string): string {
  const match = /token=([^&\s"']+)/.exec(body)
  if (!match) throw new Error(`no token in email body: ${body}`)
  return decodeURIComponent(match[1]!)
}

let kernel: Kernel
let email: MemoryEmailAdapter

beforeEach(async () => {
  email = memoryEmail()
  kernel = await initKernel(buildConfig(email), { logLevel: 'error' })
  await kernel.migrate()
})
afterEach(async () => {
  await kernel.destroy()
})

describe('password reset', () => {
  beforeEach(async () => {
    // A verified user so login isn't gated by verification for these tests.
    await kernel.create({
      collection: 'users',
      data: { email: 'ada@example.com', password: 'original-password', email_verified: true },
      ...trusted,
    })
    email.clear()
  })

  it('emails a reset token, accepts it, and signs the user in with the new password', async () => {
    await kernel.forgotPassword({ collection: 'users', email: 'ada@example.com' })
    expect(email.sent).toHaveLength(1)
    expect(email.sent[0]!.to).toBe('ada@example.com')

    const token = tokenFromEmail(email.sent[0]!.text ?? email.sent[0]!.html)
    const result = await kernel.resetPassword({ collection: 'users', token, password: 'brand-new-password' })
    expect(result.token).toBeTypeOf('string')

    // New password works; old one no longer does.
    await expect(
      kernel.login({ collection: 'users', email: 'ada@example.com', password: 'brand-new-password' }),
    ).resolves.toMatchObject({ user: { email: 'ada@example.com' } })
    await expect(
      kernel.login({ collection: 'users', email: 'ada@example.com', password: 'original-password' }),
    ).rejects.toThrow()
  })

  it('rejects an invalid or already-used token', async () => {
    await kernel.forgotPassword({ collection: 'users', email: 'ada@example.com' })
    const token = tokenFromEmail(email.sent[0]!.text ?? email.sent[0]!.html)
    await kernel.resetPassword({ collection: 'users', token, password: 'first-reset-pass' })
    // The token is single-use — cleared after the first reset.
    await expect(
      kernel.resetPassword({ collection: 'users', token, password: 'second-reset-pass' }),
    ).rejects.toBeInstanceOf(BadRequestError)
    await expect(
      kernel.resetPassword({ collection: 'users', token: 'totally-made-up', password: 'whatever-pass' }),
    ).rejects.toBeInstanceOf(BadRequestError)
  })

  it('does not reveal whether an email exists (no enumeration)', async () => {
    await expect(
      kernel.forgotPassword({ collection: 'users', email: 'nobody@example.com' }),
    ).resolves.toBeUndefined()
    expect(email.sent).toHaveLength(0)
  })

  it('enforces a minimum password length on reset', async () => {
    await kernel.forgotPassword({ collection: 'users', email: 'ada@example.com' })
    const token = tokenFromEmail(email.sent[0]!.text ?? email.sent[0]!.html)
    await expect(kernel.resetPassword({ collection: 'users', token, password: 'short' })).rejects.toThrow()
  })
})

describe('email verification', () => {
  it('sends a verification email on signup and blocks login until verified', async () => {
    await kernel.create({
      collection: 'users',
      data: { email: 'grace@example.com', password: 'hopper-password' },
      ...trusted,
    })
    expect(email.sent).toHaveLength(1)
    expect(email.sent[0]!.subject).toMatch(/verify/i)

    // Correct credentials, but unverified → blocked.
    await expect(
      kernel.login({ collection: 'users', email: 'grace@example.com', password: 'hopper-password' }),
    ).rejects.toBeInstanceOf(ForbiddenError)

    const token = tokenFromEmail(email.sent[0]!.text ?? email.sent[0]!.html)
    await expect(kernel.verifyEmail({ collection: 'users', token })).resolves.toEqual({ verified: true })

    // Now login succeeds.
    await expect(
      kernel.login({ collection: 'users', email: 'grace@example.com', password: 'hopper-password' }),
    ).resolves.toMatchObject({ user: { email: 'grace@example.com' } })
  })

  it('re-sends verification on request, and no-ops once verified', async () => {
    await kernel.create({
      collection: 'users',
      data: { email: 'linus@example.com', password: 'torvalds-password' },
      ...trusted,
    })
    email.clear()

    await kernel.requestEmailVerification({ collection: 'users', email: 'linus@example.com' })
    expect(email.sent).toHaveLength(1)

    const token = tokenFromEmail(email.sent[0]!.text ?? email.sent[0]!.html)
    await kernel.verifyEmail({ collection: 'users', token })
    email.clear()

    // Already verified → no email sent (and no enumeration leak).
    await kernel.requestEmailVerification({ collection: 'users', email: 'linus@example.com' })
    expect(email.sent).toHaveLength(0)
  })
})

describe('secret leakage', () => {
  it('never returns reset/verification tokens through the API', async () => {
    await kernel.create({
      collection: 'users',
      data: { email: 'turing@example.com', password: 'enigma-password' },
      ...trusted,
    })
    await kernel.forgotPassword({ collection: 'users', email: 'turing@example.com' })

    const found = await kernel.find({ collection: 'users', overrideAccess: true })
    const doc = found.docs.find((d) => d.email === 'turing@example.com')!
    expect(doc).toBeDefined()
    expect(doc.hash).toBeUndefined()
    expect(doc.reset_token).toBeUndefined()
    expect(doc.reset_token_expiry).toBeUndefined()
    expect(doc.verification_token).toBeUndefined()
    expect(doc.verification_token_expiry).toBeUndefined()
    // The public-safe flag is allowed through.
    expect('email_verified' in doc).toBe(true)
  })
})
