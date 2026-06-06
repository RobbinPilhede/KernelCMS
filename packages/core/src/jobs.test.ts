import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { defineConfig, initKernel } from './index'
import type { Kernel } from './index'

const trusted = { overrideAccess: true } as const
let echoed: unknown[] = []

function buildConfig() {
  return defineConfig({
    secret: 'test-secret',
    db: sqliteAdapter({ url: ':memory:' }),
    collections: [{ slug: 'posts', access: { read: () => true }, fields: [{ name: 'title', type: 'text' }] }],
    jobs: [
      {
        slug: 'echo',
        handler: ({ input }) => {
          echoed.push(input)
          return { ok: true, got: input }
        },
      },
      {
        slug: 'boom',
        maxAttempts: 2,
        handler: () => {
          throw new Error('kaboom')
        },
      },
      {
        slug: 'make-post',
        handler: async ({ input, local }) => {
          const doc = await local.create({
            collection: 'posts',
            data: { title: String((input as { title: string }).title) },
            overrideAccess: true,
          })
          return { id: doc.id }
        },
      },
    ],
  })
}

let kernel: Kernel
beforeEach(async () => {
  echoed = []
  kernel = await initKernel(buildConfig(), { logLevel: 'error' })
  await kernel.migrate()
})
afterEach(async () => {
  await kernel.destroy()
})

describe('background jobs', () => {
  it('runs a due job and records its result', async () => {
    const job = await kernel.enqueue({ task: 'echo', input: { hello: 'world' } })
    expect(job.status).toBe('pending')

    const result = await kernel.runDueJobs()
    expect(result.ran).toContain(job.id)
    expect(echoed).toEqual([{ hello: 'world' }])

    const done = await kernel.findByID({ collection: 'kernel_jobs', id: job.id, ...trusted })
    expect(done?.status).toBe('completed')
    expect(done?.result).toEqual({ ok: true, got: { hello: 'world' } })
    expect(done?.attempts).toBe(1)
  })

  it('does not run a job scheduled for the future until its time arrives', async () => {
    const future = new Date(Date.now() + 60_000).toISOString()
    const job = await kernel.enqueue({ task: 'echo', input: 1, runAt: future })

    const first = await kernel.runDueJobs()
    expect(first.ran).not.toContain(job.id)

    const later = await kernel.runDueJobs({ now: new Date(Date.now() + 120_000) })
    expect(later.ran).toContain(job.id)
  })

  it('retries a failing job until attempts are exhausted, then marks it failed', async () => {
    const job = await kernel.enqueue({ task: 'boom' })

    const r1 = await kernel.runDueJobs()
    expect(r1.failed).toContain(job.id)
    let row = await kernel.findByID({ collection: 'kernel_jobs', id: job.id, ...trusted })
    expect(row?.status).toBe('pending') // attempt 1 of 2 → still retryable
    expect(row?.attempts).toBe(1)
    expect(row?.last_error).toContain('kaboom')

    await kernel.runDueJobs()
    row = await kernel.findByID({ collection: 'kernel_jobs', id: job.id, ...trusted })
    expect(row?.status).toBe('failed') // attempt 2 of 2 → exhausted
    expect(row?.attempts).toBe(2)
  })

  it('gives handlers a working Local API', async () => {
    const job = await kernel.enqueue({ task: 'make-post', input: { title: 'From a job' } })
    await kernel.runDueJobs()

    const posts = await kernel.find({ collection: 'posts', ...trusted })
    expect(posts.docs.map((d) => d.title)).toContain('From a job')

    const done = await kernel.findByID({ collection: 'kernel_jobs', id: job.id, ...trusted })
    expect(done?.status).toBe('completed')
  })

  it('rejects enqueueing an unregistered task', async () => {
    await expect(kernel.enqueue({ task: 'nope' })).rejects.toThrow()
  })
})
