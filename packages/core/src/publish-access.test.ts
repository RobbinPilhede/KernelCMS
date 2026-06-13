import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { defineConfig, initKernel } from './index'
import type { Kernel } from './index'

// `_status` is a system column that bypasses field-level access. Without the
// publish gate, anyone with `update` could publish a draft via a raw
// `{ _status: 'published' }`. These collections pin down each path.

// A collection where ONLY editors may publish, but anyone may update. This is the
// "agents can only write drafts" shape: the `update` rule is permissive, the
// `publish` rule is strict.
const isEditor = (req: { user: { roles?: string[] } | null }): boolean => Boolean(req.user?.roles?.includes('editor'))

function gatedConfig() {
  return defineConfig({
    secret: 'test-secret',
    db: sqliteAdapter({ url: ':memory:' }),
    collections: [
      {
        slug: 'posts',
        versions: { drafts: true },
        access: {
          read: () => true,
          create: () => true,
          update: () => true,
          publish: ({ req }) => isEditor(req as { user: { roles?: string[] } | null }),
        },
        fields: [{ name: 'title', type: 'text' }],
      },
    ],
  })
}

// No `publish` rule: publishing falls back to `update`, so the historical
// "anyone who can update can publish" behaviour must be preserved.
function ungatedConfig() {
  return defineConfig({
    secret: 'test-secret',
    db: sqliteAdapter({ url: ':memory:' }),
    collections: [
      {
        slug: 'posts',
        versions: { drafts: true },
        access: { read: () => true, create: () => true, update: () => true },
        fields: [{ name: 'title', type: 'text' }],
      },
    ],
  })
}

const editor = { user: { id: 'u-editor', collection: 'posts', roles: ['editor'] } }
const writer = { user: { id: 'u-writer', collection: 'posts', roles: ['writer'] } }

describe('publish gate (access.publish) restricts the draft → published transition', () => {
  let kernel: Kernel
  let draftId: string

  beforeEach(async () => {
    kernel = await initKernel(gatedConfig(), { logLevel: 'error' })
    await kernel.migrate()
    const draft = await kernel.create({
      collection: 'posts',
      data: { title: 'Draft', _status: 'draft' },
      req: writer,
    })
    draftId = draft.id
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('forbids a non-editor from publishing via a raw PATCH { _status: published }', async () => {
    await expect(
      kernel.update({ collection: 'posts', id: draftId, data: { _status: 'published' }, req: writer }),
    ).rejects.toThrow()
  })

  it('forbids a non-editor from publishing via publish() → update()', async () => {
    await expect(kernel.publish({ collection: 'posts', id: draftId, req: writer })).rejects.toThrow()
  })

  it('forbids a non-editor from creating a born-published document', async () => {
    await expect(
      kernel.create({ collection: 'posts', data: { title: 'Hot take', _status: 'published' }, req: writer }),
    ).rejects.toThrow()
  })

  it('still allows the non-editor to update the draft (publish gate is publish-only)', async () => {
    const updated = await kernel.update({
      collection: 'posts',
      id: draftId,
      data: { title: 'Draft edited' },
      req: writer,
    })
    expect(updated?.title).toBe('Draft edited')
    expect(updated?._status).toBe('draft')
  })

  it('allows an editor to publish via raw PATCH { _status: published }', async () => {
    const published = await kernel.update({
      collection: 'posts',
      id: draftId,
      data: { _status: 'published' },
      req: editor,
    })
    expect(published?._status).toBe('published')
  })

  it('allows an editor to publish via publish()', async () => {
    const published = await kernel.publish({ collection: 'posts', id: draftId, req: editor })
    expect(published?._status).toBe('published')
  })

  it('allows an editor to create a born-published document', async () => {
    const created = await kernel.create({
      collection: 'posts',
      data: { title: 'Editor post', _status: 'published' },
      req: editor,
    })
    expect(created._status).toBe('published')
  })

  it('does not re-check publish when editing an already-published doc', async () => {
    await kernel.update({ collection: 'posts', id: draftId, data: { _status: 'published' }, req: editor })
    // A non-editor may still edit content of a published doc — that's not a new publish.
    const edited = await kernel.update({
      collection: 'posts',
      id: draftId,
      data: { title: 'Post-publish copy edit' },
      req: writer,
    })
    expect(edited?.title).toBe('Post-publish copy edit')
    expect(edited?._status).toBe('published')
  })

  it('lets a scheduled publish (overrideAccess) go through despite the publish gate', async () => {
    await kernel.publish({
      collection: 'posts',
      id: draftId,
      publishAt: new Date(Date.now() + 60_000).toISOString(),
      req: editor,
    })
    const { published } = await kernel.processScheduledPublishes({ now: Date.now() + 120_000 })
    expect(published).toContain(draftId)
    const doc = await kernel.findByID({ collection: 'posts', id: draftId, draft: true, overrideAccess: true })
    expect(doc?._status).toBe('published')
  })
})

describe('publish gate falls back to update when access.publish is undefined', () => {
  let kernel: Kernel
  let draftId: string

  beforeEach(async () => {
    kernel = await initKernel(ungatedConfig(), { logLevel: 'error' })
    await kernel.migrate()
    const draft = await kernel.create({
      collection: 'posts',
      data: { title: 'Draft', _status: 'draft' },
      req: writer,
    })
    draftId = draft.id
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('still lets anyone who can update publish via raw PATCH (unchanged behaviour)', async () => {
    const published = await kernel.update({
      collection: 'posts',
      id: draftId,
      data: { _status: 'published' },
      req: writer,
    })
    expect(published?._status).toBe('published')
  })

  it('still lets anyone who can update publish via publish()', async () => {
    const published = await kernel.publish({ collection: 'posts', id: draftId, req: writer })
    expect(published?._status).toBe('published')
  })
})
