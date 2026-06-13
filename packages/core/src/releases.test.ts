import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { defineConfig, initKernel } from './index'
import type { EvalRule, Kernel } from './index'

// Content releases: a named bundle of draft documents published as a UNIT, optionally on
// a schedule. Publishing routes every member through the normal per-doc publish gate, so
// a release can never bypass publish authorization. These tests pin the state machine, the
// all-or-nothing pre-flight, de-dupe, the input guards, and the disabled-returns-empty
// contract.

const isEditor = ({ req }: any) => Boolean(req.user?.roles?.includes('editor'))
const editor = { user: { id: 'ed', roles: ['editor'] } }
const viewer = { user: { id: 'vw', roles: ['viewer'] } }
const agent = { user: { id: 'bot', principalType: 'agent' as const, roles: [] } }

// A blocking eval that rejects any post whose title contains "banned".
const noBanned: EvalRule = {
  name: 'no-banned',
  run: ({ doc }) =>
    typeof doc.title === 'string' && doc.title.toLowerCase().includes('banned')
      ? [{ ok: false, severity: 'error', message: 'title contains banned content' }]
      : [{ ok: true, severity: 'info', message: 'clean' }],
}

function releasesConfig(overrides: Record<string, unknown> = {}) {
  return defineConfig({
    secret: 'releases-test-secret',
    db: sqliteAdapter({ url: ':memory:' }),
    audit: true,
    releases: true,
    evals: [noBanned],
    collections: [
      {
        slug: 'posts',
        versions: { drafts: true },
        access: { read: () => true, create: () => true, update: () => true, publish: isEditor },
        fields: [{ name: 'title', type: 'text' }],
      },
    ],
    ...overrides,
  })
}

async function draft(kernel: Kernel, title: string): Promise<string> {
  const doc = await kernel.create({ collection: 'posts', data: { title }, req: editor })
  return doc.id
}

describe('content releases — state machine', () => {
  let kernel: Kernel
  beforeEach(async () => {
    kernel = await initKernel(releasesConfig(), { logLevel: 'error', autoMigrate: true })
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('creates an open release, adds members, and previews them in draft state', async () => {
    const release = await kernel.createRelease({ name: 'Launch', req: editor })
    expect(release.status).toBe('open')

    const a = await draft(kernel, 'Alpha')
    const b = await draft(kernel, 'Beta')
    await kernel.addToRelease({ release: release.id, collection: 'posts', id: a, req: editor })
    const withItems = await kernel.addToRelease({ release: release.id, collection: 'posts', id: b, req: editor })
    expect(withItems.items).toHaveLength(2)

    const preview = await kernel.previewRelease({ release: release.id, req: editor })
    expect(preview.items.map((i) => i.id).sort()).toEqual([a, b].sort())
    // Preview shows the CURRENT draft state.
    expect(preview.items.every((i) => i.doc._status === 'draft')).toBe(true)
  })

  it('de-dupes a member added twice', async () => {
    const release = await kernel.createRelease({ name: 'Dedupe', req: editor })
    const a = await draft(kernel, 'Alpha')
    await kernel.addToRelease({ release: release.id, collection: 'posts', id: a, req: editor })
    const second = await kernel.addToRelease({ release: release.id, collection: 'posts', id: a, req: editor })
    expect(second.items).toHaveLength(1)
  })

  it('removes a member from an open release', async () => {
    const release = await kernel.createRelease({ name: 'Remove', req: editor })
    const a = await draft(kernel, 'Alpha')
    await kernel.addToRelease({ release: release.id, collection: 'posts', id: a, req: editor })
    const after = await kernel.removeFromRelease({ release: release.id, collection: 'posts', id: a, req: editor })
    expect(after.items).toHaveLength(0)
  })

  it('publishes every member together as an editor', async () => {
    const release = await kernel.createRelease({ name: 'Go', req: editor })
    const ids = [await draft(kernel, 'A'), await draft(kernel, 'B'), await draft(kernel, 'C')]
    for (const id of ids) await kernel.addToRelease({ release: release.id, collection: 'posts', id, req: editor })

    const result = await kernel.publishRelease({ release: release.id, req: editor })
    expect(result.status).toBe('published')
    expect(result.published).toHaveLength(3)
    expect(result.failed).toHaveLength(0)

    for (const id of ids) {
      const doc = await kernel.findByID({ collection: 'posts', id })
      expect(doc?._status).toBe('published')
    }
    const got = await kernel.getRelease({ release: release.id, req: editor })
    expect(got?.status).toBe('published')
    expect(got?.publishedAt).toBeTruthy()
  })
})

describe('content releases — all-or-nothing pre-flight', () => {
  let kernel: Kernel
  beforeEach(async () => {
    kernel = await initKernel(releasesConfig(), { logLevel: 'error', autoMigrate: true })
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('publishes NONE when one member fails the eval gate', async () => {
    const release = await kernel.createRelease({ name: 'Mixed', req: editor })
    const good = await draft(kernel, 'Good')
    const bad = await draft(kernel, 'banned thing')
    await kernel.addToRelease({ release: release.id, collection: 'posts', id: good, req: editor })
    await kernel.addToRelease({ release: release.id, collection: 'posts', id: bad, req: editor })

    const result = await kernel.publishRelease({ release: release.id, req: editor })
    expect(result.status).toBe('open')
    expect(result.published).toHaveLength(0)
    expect(result.failed.some((f) => f.id === bad)).toBe(true)

    // The GOOD member must still be a draft (nothing went live).
    expect((await kernel.findByID({ collection: 'posts', id: good }))?._status).toBeUndefined()
    expect((await kernel.findByID({ collection: 'posts', id: good, draft: true }))?._status).toBe('draft')
    // The release stays open and editable.
    expect((await kernel.getRelease({ release: release.id, req: editor }))?.status).toBe('open')
  })

  it('publishes NONE when the caller lacks publish access on a member', async () => {
    const release = await kernel.createRelease({ name: 'NoAccess', req: editor })
    const a = await draft(kernel, 'A')
    await kernel.addToRelease({ release: release.id, collection: 'posts', id: a, req: editor })

    const result = await kernel.publishRelease({ release: release.id, req: viewer })
    expect(result.status).toBe('open')
    expect(result.published).toHaveLength(0)
    expect(result.failed).toHaveLength(1)
    expect((await kernel.findByID({ collection: 'posts', id: a, draft: true }))?._status).toBe('draft')
  })

  it('an agent can never publish a release (the per-doc brake)', async () => {
    const release = await kernel.createRelease({ name: 'AgentTry', req: editor })
    const a = await draft(kernel, 'A')
    await kernel.addToRelease({ release: release.id, collection: 'posts', id: a, req: editor })

    const result = await kernel.publishRelease({ release: release.id, req: agent })
    expect(result.status).toBe('open')
    expect(result.published).toHaveLength(0)
    expect((await kernel.findByID({ collection: 'posts', id: a, draft: true }))?._status).toBe('draft')
  })
})

describe('content releases — scheduling + drain', () => {
  let kernel: Kernel
  beforeEach(async () => {
    kernel = await initKernel(releasesConfig(), { logLevel: 'error', autoMigrate: true })
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('schedules a release and the drain publishes it when due', async () => {
    const release = await kernel.createRelease({ name: 'Scheduled', req: editor })
    const ids = [await draft(kernel, 'A'), await draft(kernel, 'B')]
    for (const id of ids) await kernel.addToRelease({ release: release.id, collection: 'posts', id, req: editor })

    const at = new Date(Date.now() + 60_000).toISOString()
    const scheduled = await kernel.scheduleRelease({ release: release.id, at, req: editor })
    expect(scheduled.status).toBe('scheduled')

    // Before due: still drafts.
    await kernel.processScheduledReleases({ now: Date.now() })
    expect((await kernel.findByID({ collection: 'posts', id: ids[0]! }))?._status).toBeUndefined()

    // When due: members go live.
    const drain = await kernel.processScheduledReleases({ now: Date.now() + 120_000 })
    expect(drain.published).toContain(release.id)
    for (const id of ids) expect((await kernel.findByID({ collection: 'posts', id }))?._status).toBe('published')
    expect((await kernel.getRelease({ release: release.id, req: editor }))?.status).toBe('published')
  })

  it('refuses to schedule when a member would fail the gate', async () => {
    const release = await kernel.createRelease({ name: 'BadSchedule', req: editor })
    const bad = await draft(kernel, 'banned')
    await kernel.addToRelease({ release: release.id, collection: 'posts', id: bad, req: editor })
    const at = new Date(Date.now() + 60_000).toISOString()
    await expect(kernel.scheduleRelease({ release: release.id, at, req: editor })).rejects.toThrow(/would not publish/i)
  })
})

describe('content releases — editability + guards', () => {
  let kernel: Kernel
  beforeEach(async () => {
    kernel = await initKernel(releasesConfig(), { logLevel: 'error', autoMigrate: true })
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('only open releases are editable (cannot add to a published release)', async () => {
    const release = await kernel.createRelease({ name: 'Closed', req: editor })
    const a = await draft(kernel, 'A')
    await kernel.addToRelease({ release: release.id, collection: 'posts', id: a, req: editor })
    await kernel.publishRelease({ release: release.id, req: editor })

    const b = await draft(kernel, 'B')
    await expect(kernel.addToRelease({ release: release.id, collection: 'posts', id: b, req: editor })).rejects.toThrow(
      /only an open release/i,
    )
  })

  it('rejects an over-long name and a prototype-pollution name', async () => {
    await expect(kernel.createRelease({ name: 'x'.repeat(201), req: editor })).rejects.toThrow(/too long/i)
    await expect(kernel.createRelease({ name: '', req: editor })).rejects.toThrow(/required/i)
  })

  it('rejects a member from a non-existent or non-draft collection', async () => {
    const release = await kernel.createRelease({ name: 'Bad', req: editor })
    await expect(
      kernel.addToRelease({ release: release.id, collection: 'nope', id: 'x', req: editor }),
    ).rejects.toThrow(/unknown collection/i)
  })

  it('cancels an open release', async () => {
    const release = await kernel.createRelease({ name: 'Cancel', req: editor })
    await kernel.cancelRelease({ release: release.id, req: editor })
    expect(await kernel.getRelease({ release: release.id, req: editor })).toBeNull()
  })

  it('a published release is immutable (cannot be cancelled)', async () => {
    const release = await kernel.createRelease({ name: 'Immutable', req: editor })
    const a = await draft(kernel, 'A')
    await kernel.addToRelease({ release: release.id, collection: 'posts', id: a, req: editor })
    await kernel.publishRelease({ release: release.id, req: editor })
    await expect(kernel.cancelRelease({ release: release.id, req: editor })).rejects.toThrow(/immutable/i)
  })
})

describe('content releases — disabled by default', () => {
  it('returns empty / throws cleanly when releases are not enabled', async () => {
    const kernel = await initKernel(
      defineConfig({
        secret: 'releases-off-secret',
        db: sqliteAdapter({ url: ':memory:' }),
        collections: [{ slug: 'posts', versions: { drafts: true }, fields: [{ name: 'title', type: 'text' }] }],
      }),
      { logLevel: 'error', autoMigrate: true },
    )
    expect(await kernel.listReleases()).toEqual({ docs: [], count: 0 })
    expect(await kernel.processScheduledReleases()).toEqual({ published: [] })
    await expect(kernel.createRelease({ name: 'x' })).rejects.toThrow(/not enabled/i)
    await kernel.destroy()
  })
})
