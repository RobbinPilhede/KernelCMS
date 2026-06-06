import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { KernelError, clearErrorMessages, defineEndpoint, initKernel, registerErrorMessages } from '@kernel/core'
import type { Kernel } from '@kernel/core'
import { createRequestHandler } from './index'

let kernel: Kernel
let handler: (req: Request) => Promise<Response>

beforeEach(async () => {
  clearErrorMessages()
  registerErrorMessages({
    en: { 'comments.locked': 'This thread is locked.', 'comments.rate': 'Try again in {minutes} minutes.' },
    sv: { 'comments.locked': 'Tråden är låst.' },
  })
  kernel = await initKernel(
    {
      secret: 'i18n-test',
      db: sqliteAdapter({ url: ':memory:' }),
      collections: [{ slug: 'posts', access: { read: () => true }, fields: [{ name: 'title', type: 'text' }] }],
      endpoints: [
        defineEndpoint({
          method: 'GET',
          path: '/locked',
          access: () => true,
          handler: () => {
            throw new KernelError('This thread is locked.', 'FORBIDDEN', 423, undefined, {
              messageKey: 'comments.locked',
            })
          },
        }),
        defineEndpoint({
          method: 'GET',
          path: '/rate',
          access: () => true,
          handler: () => {
            throw new KernelError('Too many requests.', 'TOO_MANY_REQUESTS', 429, undefined, {
              messageKey: 'comments.rate',
              context: { minutes: 15 },
            })
          },
        }),
        defineEndpoint({
          method: 'GET',
          path: '/unkeyed',
          access: () => true,
          handler: () => {
            throw new KernelError('Baked message.', 'BAD_REQUEST', 400, undefined, { messageKey: 'missing.key' })
          },
        }),
      ],
    },
    { logLevel: 'error' },
  )
  await kernel.migrate()
  handler = createRequestHandler(kernel, {})
})

afterEach(async () => {
  await kernel.destroy()
  clearErrorMessages()
})

async function message(res: Response): Promise<string> {
  return ((await res.json()) as { error: { message: string } }).error.message
}

describe('error i18n at the boundary', () => {
  it('renders the default-locale message and keeps the declared status', async () => {
    const res = await handler(new Request('http://localhost/api/locked'))
    expect(res.status).toBe(423)
    expect(await message(res)).toBe('This thread is locked.')
  })

  it('localizes by Accept-Language', async () => {
    const res = await handler(new Request('http://localhost/api/locked', { headers: { 'accept-language': 'sv' } }))
    expect(await message(res)).toBe('Tråden är låst.')
  })

  it('falls back from a regional locale to its base (sv-SE -> sv)', async () => {
    const res = await handler(new Request('http://localhost/api/locked', { headers: { 'accept-language': 'sv-SE' } }))
    expect(await message(res)).toBe('Tråden är låst.')
  })

  it('interpolates context into the template', async () => {
    const res = await handler(new Request('http://localhost/api/rate'))
    expect(await message(res)).toBe('Try again in 15 minutes.')
  })

  it('falls back to the baked message when the key is unregistered', async () => {
    const res = await handler(new Request('http://localhost/api/unkeyed'))
    expect(await message(res)).toBe('Baked message.')
  })
})
