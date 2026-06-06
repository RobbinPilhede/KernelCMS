import { afterEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { defineEndpoint, defineModule, initKernel } from './index'
import type { Kernel } from './index'

const base = { secret: 'modules-test', db: sqliteAdapter({ url: ':memory:' }) }

let kernel: Kernel | null = null
afterEach(async () => {
  await kernel?.destroy()
  kernel = null
})

// A module bundles a whole vertical slice: collection + endpoint + job.
const comments = defineModule({
  name: 'comments',
  version: '1.0.0',
  collections: [{ slug: 'comments', access: { read: () => true }, fields: [{ name: 'body', type: 'text' }] }],
  endpoints: [
    defineEndpoint({ method: 'GET', path: '/comments/ping', access: () => true, handler: () => ({ ok: true }) }),
  ],
  jobs: [{ slug: 'moderate-comments', handler: async () => ({}) }],
})

describe('defineModule', () => {
  it('installs a collection, endpoint, and job as one unit', async () => {
    kernel = await initKernel({ ...base, collections: [], plugins: [comments] }, { logLevel: 'error' })
    expect(kernel.config.collectionsBySlug.comments).toBeTruthy()
    expect(kernel.config.endpoints?.some((e) => e.method === 'GET' && e.path === '/comments/ping')).toBe(true)
    expect(kernel.config.jobs?.some((j) => j.slug === 'moderate-comments')).toBe(true)
  })

  it('composes with existing config (does not drop pre-defined collections/endpoints)', async () => {
    kernel = await initKernel(
      {
        ...base,
        collections: [{ slug: 'posts', access: { read: () => true }, fields: [{ name: 'title', type: 'text' }] }],
        endpoints: [defineEndpoint({ method: 'GET', path: '/health-x', access: () => true, handler: () => ({}) })],
        plugins: [comments],
      },
      { logLevel: 'error' },
    )
    // Both the pre-existing and the module-added items survive the fold.
    expect(kernel.config.collectionsBySlug.posts).toBeTruthy()
    expect(kernel.config.collectionsBySlug.comments).toBeTruthy()
    const paths = (kernel.config.endpoints ?? []).map((e) => e.path)
    expect(paths).toContain('/health-x')
    expect(paths).toContain('/comments/ping')
  })

  it('rejects a duplicate collection slug across modules (fatal conflict)', async () => {
    const dupA = defineModule({
      name: 'a',
      collections: [{ slug: 'dup', access: { read: () => true }, fields: [] }],
    })
    const dupB = defineModule({
      name: 'b',
      collections: [{ slug: 'dup', access: { read: () => true }, fields: [] }],
    })
    await expect(
      initKernel({ ...base, collections: [], plugins: [dupA, dupB] }, { logLevel: 'error' }),
    ).rejects.toThrow(/dup/)
  })

  it('rejects a duplicate endpoint across a module and base config', async () => {
    await expect(
      initKernel(
        {
          ...base,
          collections: [],
          endpoints: [
            defineEndpoint({ method: 'GET', path: '/comments/ping', access: () => true, handler: () => ({}) }),
          ],
          plugins: [comments],
        },
        { logLevel: 'error' },
      ),
    ).rejects.toThrow(/comments\/ping/)
  })
})
