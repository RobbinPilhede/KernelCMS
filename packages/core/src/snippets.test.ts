import { afterEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { defineConfig, initKernel } from './index'
import type { Doc, Kernel } from './index'
import { ValidationError } from './index'

// Trusted (access-bypassing) context for setup writes that aren't the thing under test.
const trusted = { overrideAccess: true } as const
// Human principals for the access-checked transclusion cases. The principal lives on
// `req` — operations resolve access from `opts.req.user`, not a top-level `user`.
const alice = { req: { user: { id: 'alice', roles: ['viewer'] } } } as any
const bob = { req: { user: { id: 'bob', roles: ['viewer'] } } } as any
const admin = { req: { user: { id: 'adm', roles: ['admin'] } } } as any

// Owner-scoped read for the secret snippet library: only the owner (or an admin) may read.
const ownerRead = ({ req }: any) =>
  req.user?.roles?.includes('admin') ? true : { owner: { equals: req.user?.id ?? '__none__' } }

function buildConfig() {
  return defineConfig({
    secret: 'test-secret-32-characters-long!!',
    db: sqliteAdapter({ url: ':memory:' }),
    collections: [
      // A snippet library: reusable fragments referenced + transcluded elsewhere.
      {
        slug: 'snippets',
        snippet: true,
        access: { read: () => true, create: () => true, update: () => true },
        fields: [
          { name: 'label', type: 'text' },
          { name: 'body', type: 'text' },
        ],
      },
      // References a single fragment from `snippets`.
      {
        slug: 'pages',
        access: { read: () => true, create: () => true, update: () => true },
        fields: [
          { name: 'title', type: 'text' },
          { name: 'cta', type: 'snippet', snippet: 'snippets' },
        ],
      },
      // An ordered LIST of fragments (hasMany).
      {
        slug: 'page_lists',
        access: { read: () => true, create: () => true, update: () => true },
        fields: [
          { name: 'title', type: 'text' },
          { name: 'ctas', type: 'snippet', snippet: 'snippets', hasMany: true },
        ],
      },
      // An access-gated snippet library + a collection that references it.
      {
        slug: 'secret_snippets',
        snippet: true,
        access: { read: ownerRead, create: () => true, update: () => true },
        fields: [
          { name: 'owner', type: 'text' },
          { name: 'body', type: 'text' },
        ],
      },
      {
        slug: 'pages2',
        access: { read: () => true, create: () => true, update: () => true },
        fields: [
          { name: 'title', type: 'text' },
          { name: 'secret', type: 'snippet', snippet: 'secret_snippets' },
        ],
      },
      // A SELF-referential snippet library: a fragment can chain to the next fragment.
      // Used to prove cycle/depth safety (A -> B -> A is bounded, never infinite).
      {
        slug: 'chain',
        snippet: true,
        access: { read: () => true, create: () => true, update: () => true },
        fields: [
          { name: 'body', type: 'text' },
          { name: 'next', type: 'snippet', snippet: 'chain' },
        ],
      },
    ],
  })
}

let kernel: Kernel
afterEach(async () => {
  if (kernel) await kernel.destroy()
})

async function boot(): Promise<Kernel> {
  kernel = await initKernel(buildConfig(), { logLevel: 'error' })
  await kernel.migrate()
  return kernel
}

describe('content snippets / reusable blocks', () => {
  it('transcludes the live fragment on read at depth 1, leaves the raw id at depth 0', async () => {
    const k = await boot()
    const frag = await k.create({ collection: 'snippets', data: { label: 'CTA', body: 'Buy now' }, ...trusted })
    const page = await k.create({ collection: 'pages', data: { title: 'Home', cta: frag.id }, ...trusted })

    const deep = await k.findByID({ collection: 'pages', id: page.id, depth: 1, ...trusted })
    const cta = deep?.cta as Doc
    expect(typeof cta).toBe('object')
    expect(cta.id).toBe(frag.id)
    expect(cta.body).toBe('Buy now')

    const shallow = await k.findByID({ collection: 'pages', id: page.id, depth: 0, ...trusted })
    expect(shallow?.cta).toBe(frag.id)

    const noDepth = await k.findByID({ collection: 'pages', id: page.id, ...trusted })
    expect(noDepth?.cta).toBe(frag.id)
  })

  it('edit-once-update-everywhere: re-reading reflects the fragment edit, not a copy', async () => {
    const k = await boot()
    const frag = await k.create({ collection: 'snippets', data: { label: 'CTA', body: 'v1' }, ...trusted })
    const pageA = await k.create({ collection: 'pages', data: { title: 'A', cta: frag.id }, ...trusted })
    const pageB = await k.create({ collection: 'pages', data: { title: 'B', cta: frag.id }, ...trusted })

    await k.update({ collection: 'snippets', id: frag.id, data: { body: 'v2' }, ...trusted })

    const a = await k.findByID({ collection: 'pages', id: pageA.id, depth: 1, ...trusted })
    const b = await k.findByID({ collection: 'pages', id: pageB.id, depth: 1, ...trusted })
    expect((a?.cta as Doc).body).toBe('v2')
    expect((b?.cta as Doc).body).toBe('v2')
  })

  it('hasMany resolves to an ordered list of fragment docs', async () => {
    const k = await boot()
    const f1 = await k.create({ collection: 'snippets', data: { label: 'one', body: '1' }, ...trusted })
    const f2 = await k.create({ collection: 'snippets', data: { label: 'two', body: '2' }, ...trusted })
    const f3 = await k.create({ collection: 'snippets', data: { label: 'three', body: '3' }, ...trusted })
    const list = await k.create({
      collection: 'page_lists',
      data: { title: 'L', ctas: [f3.id, f1.id, f2.id] },
      ...trusted,
    })

    const deep = await k.findByID({ collection: 'page_lists', id: list.id, depth: 1, ...trusted })
    const ctas = deep?.ctas as Doc[]
    expect(Array.isArray(ctas)).toBe(true)
    expect(ctas.map((c) => c.id)).toEqual([f3.id, f1.id, f2.id])
    expect(ctas.map((c) => c.body)).toEqual(['3', '1', '2'])
  })

  it('access-checked transclusion: a non-readable fragment falls back to its raw id', async () => {
    const k = await boot()
    const secret = await k.create({
      collection: 'secret_snippets',
      data: { owner: 'alice', body: 'top secret' },
      ...trusted,
    })
    const page = await k.create({ collection: 'pages2', data: { title: 'P', secret: secret.id }, ...trusted })

    // Bob cannot read alice's secret → the reference stays the raw id, content is NOT leaked.
    const asBob = await k.findByID({ collection: 'pages2', id: page.id, depth: 1, ...bob })
    expect(asBob?.secret).toBe(secret.id)
    expect(typeof asBob?.secret).not.toBe('object')

    // The owner (and an admin) get the full transcluded fragment.
    const asAlice = await k.findByID({ collection: 'pages2', id: page.id, depth: 1, ...alice })
    expect((asAlice?.secret as Doc).body).toBe('top secret')
    const asAdmin = await k.findByID({ collection: 'pages2', id: page.id, depth: 1, ...admin })
    expect((asAdmin?.secret as Doc).body).toBe('top secret')
  })

  it('cycle/depth safety: A -> B -> A is bounded by MAX_POPULATE_DEPTH and never hangs', async () => {
    const k = await boot()
    const a = await k.create({ collection: 'chain', data: { body: 'A' }, ...trusted })
    const b = await k.create({ collection: 'chain', data: { body: 'B', next: a.id }, ...trusted })
    await k.update({ collection: 'chain', id: a.id, data: { next: b.id }, ...trusted })

    const start = Date.now()
    const read = await k.findByID({ collection: 'chain', id: a.id, depth: 10, ...trusted })
    const elapsed = Date.now() - start

    expect(read?.id).toBe(a.id)
    // It must return (bounded recursion), and quickly — well under a second.
    expect(elapsed).toBeLessThan(1000)
    // The chain inlines fragment docs down the bounded depth; the first hop is B.
    expect((read?.next as Doc).id).toBe(b.id)
  })

  it('config guard: a snippet field referencing an UNKNOWN collection throws at initKernel', async () => {
    const bad = defineConfig({
      secret: 'test-secret-32-characters-long!!',
      db: sqliteAdapter({ url: ':memory:' }),
      collections: [
        {
          slug: 'pages',
          access: { read: () => true },
          fields: [{ name: 'cta', type: 'snippet', snippet: 'does_not_exist' }],
        },
      ],
    })
    await expect(initKernel(bad, { logLevel: 'error' })).rejects.toThrow(/references unknown collection/i)
  })

  it('config guard: a snippet field referencing a NON-snippet collection throws at initKernel', async () => {
    const bad = defineConfig({
      secret: 'test-secret-32-characters-long!!',
      db: sqliteAdapter({ url: ':memory:' }),
      collections: [
        // `blocks` is a normal collection, NOT flagged `snippet: true`.
        { slug: 'blocks', access: { read: () => true }, fields: [{ name: 'body', type: 'text' }] },
        {
          slug: 'pages',
          access: { read: () => true },
          fields: [{ name: 'cta', type: 'snippet', snippet: 'blocks' }],
        },
      ],
    })
    await expect(initKernel(bad, { logLevel: 'error' })).rejects.toThrow(/must reference a .*snippet/i)
  })

  it('write validation: a string id is accepted, a boolean snippet value is rejected', async () => {
    const k = await boot()
    const frag = await k.create({ collection: 'snippets', data: { label: 'x', body: 'y' }, ...trusted })

    const ok = await k.create({ collection: 'pages', data: { title: 'Valid', cta: frag.id }, ...trusted })
    expect(ok.cta).toBe(frag.id)

    await expect(
      k.create({ collection: 'pages', data: { title: 'Bad', cta: true } as any, ...trusted }),
    ).rejects.toBeInstanceOf(ValidationError)
  })
})
