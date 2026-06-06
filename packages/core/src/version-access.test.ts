import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { defineConfig, initKernel } from './index'
import type { Kernel } from './index'

// A row-scoped collection: each user may only read documents they own. This is
// the canonical multi-tenant pattern and the case the version endpoints must not
// leak around.
function buildConfig() {
  return defineConfig({
    secret: 'test-secret',
    db: sqliteAdapter({ url: ':memory:' }),
    collections: [
      {
        slug: 'notes',
        versions: true,
        access: {
          read: ({ req }) => (req.user ? { owner: { equals: req.user.id } } : false),
          create: () => true,
          update: () => true,
        },
        fields: [
          { name: 'title', type: 'text' },
          { name: 'owner', type: 'text' },
          // A field only the owner-admin may read.
          { name: 'secret_note', type: 'text', access: { read: () => false } },
        ],
      },
    ],
  })
}

describe('version endpoints honour row + field access', () => {
  let kernel: Kernel
  let noteId: string
  const owner = { user: { id: 'user-a', collection: 'notes' } } as const
  const intruder = { user: { id: 'user-b', collection: 'notes' } } as const

  beforeEach(async () => {
    kernel = await initKernel(buildConfig(), { logLevel: 'error' })
    await kernel.migrate()
    const note = await kernel.create({
      collection: 'notes',
      data: { title: 'Mine', owner: 'user-a', secret_note: 'top secret' },
      overrideAccess: true,
    })
    noteId = note.id
    await kernel.update({
      collection: 'notes',
      id: noteId,
      data: { title: 'Mine v2' },
      overrideAccess: true,
    })
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('lets the owner list versions', async () => {
    const res = await kernel.findVersions({ collection: 'notes', id: noteId, req: owner })
    expect(res.totalDocs).toBeGreaterThan(0)
  })

  it('forbids another user from listing a document version history (IDOR)', async () => {
    await expect(kernel.findVersions({ collection: 'notes', id: noteId, req: intruder })).rejects.toThrow()
  })

  it('strips field-read-restricted data from version snapshots', async () => {
    const res = await kernel.findVersions({ collection: 'notes', id: noteId, req: owner })
    for (const v of res.docs) {
      expect((v.version as Record<string, unknown>).secret_note).toBeUndefined()
    }
  })

  it('forbids another user from restoring a version (IDOR)', async () => {
    const versions = await kernel.findVersions({ collection: 'notes', id: noteId, overrideAccess: true })
    const vid = versions.docs[0]!.id
    await expect(
      kernel.restoreVersion({ collection: 'notes', id: noteId, versionId: vid, req: intruder }),
    ).rejects.toThrow()
  })
})
