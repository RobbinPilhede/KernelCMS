import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { defineConfig, initKernel } from './index'
import type { Kernel } from './index'

// Red-team suite for the agent principal. An agent is a non-human caller that flows
// through the SAME access pipeline as a human (overrideAccess:false) but is scoped:
// it may only write the fields in its allow-list and can NEVER publish (drafts only).
// Privilege escalation is the #1 risk, so each test pins down one escape route.

// A permissive collection: anyone may create/update/publish. The agent's brakes must
// hold even though config alone would let a human do everything here.
function postsConfig() {
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
          // Even an explicit, permissive publish rule must not let an agent publish.
          publish: () => true,
        },
        fields: [
          { name: 'title', type: 'text' },
          { name: 'body', type: 'text' },
          // A privilege field on a NON-auth collection: it carries no field rule, so
          // only the agent's fieldScope stops it being written. A stripped text field
          // reads back absent (`undefined`), giving an unambiguous "not written" proof.
          { name: 'roles', type: 'text' },
        ],
      },
    ],
  })
}

// An agent scoped to write only `body`. roles:[] — never grant an agent admin.
const bodyAgent = {
  user: { id: 'agent-writer', principalType: 'agent' as const, roles: [], fieldScope: { allow: ['body'] } },
}
// A human writer with no fieldScope — the baseline whose behaviour must not change.
const human = { user: { id: 'u-human', collection: 'posts', roles: ['writer'] } }

describe('agent field allow-list (deny-by-default)', () => {
  let kernel: Kernel
  let draftId: string

  beforeEach(async () => {
    kernel = await initKernel(postsConfig(), { logLevel: 'error' })
    await kernel.migrate()
    const draft = await kernel.create({
      collection: 'posts',
      data: { title: 'Seed', body: 'seed body', _status: 'draft' },
      req: human,
    })
    draftId = draft.id
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('writes an allowed field but strips every unscoped field on update', async () => {
    const updated = await kernel.update({
      collection: 'posts',
      id: draftId,
      // The agent submits its allowed field AND several it must not touch.
      data: { body: 'agent edit', title: 'HIJACK', roles: 'admin' },
      req: bodyAgent,
    })
    expect(updated?.body).toBe('agent edit')
    // Unscoped fields are deleted from the write, so the seed values survive.
    expect(updated?.title).toBe('Seed')
    expect(updated?.roles ?? null).toBeNull()
  })

  it('strips unscoped fields on create too (allow-list applies to both write paths)', async () => {
    const created = await kernel.create({
      collection: 'posts',
      data: { body: 'fresh', title: 'should vanish', roles: 'admin' },
      req: bodyAgent,
    })
    expect(created.body).toBe('fresh')
    expect(created.title ?? null).toBeNull()
    expect(created.roles ?? null).toBeNull()
  })

  it('cannot escalate: roles is stripped even though the collection declares no rule for it', async () => {
    const updated = await kernel.update({
      collection: 'posts',
      id: draftId,
      data: { roles: 'admin' },
      req: bodyAgent,
    })
    expect(updated?.roles ?? null).toBeNull()
  })

  it('with a deny-list (no allow), the denied field is stripped and the rest pass', async () => {
    const denyAgent = {
      user: { id: 'agent-deny', principalType: 'agent' as const, roles: [], fieldScope: { deny: ['roles'] } },
    }
    const updated = await kernel.update({
      collection: 'posts',
      id: draftId,
      data: { title: 'allowed by deny-list', roles: 'admin' },
      req: denyAgent,
    })
    expect(updated?.title).toBe('allowed by deny-list')
    expect(updated?.roles ?? null).toBeNull()
  })
})

describe('agent draft-only brake (can never publish)', () => {
  let kernel: Kernel
  let draftId: string

  beforeEach(async () => {
    kernel = await initKernel(postsConfig(), { logLevel: 'error' })
    await kernel.migrate()
    const draft = await kernel.create({
      collection: 'posts',
      data: { body: 'draft body', _status: 'draft' },
      req: bodyAgent,
    })
    draftId = draft.id
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('forbids a born-published create even when access.publish would allow it', async () => {
    await expect(
      kernel.create({ collection: 'posts', data: { body: 'hot', _status: 'published' }, req: bodyAgent }),
    ).rejects.toThrow()
  })

  it('forbids publishing via a raw PATCH { _status: published }', async () => {
    await expect(
      kernel.update({ collection: 'posts', id: draftId, data: { _status: 'published' }, req: bodyAgent }),
    ).rejects.toThrow()
  })

  it('forbids publishing via publish()', async () => {
    await expect(kernel.publish({ collection: 'posts', id: draftId, req: bodyAgent })).rejects.toThrow()
  })

  it('can create and edit a draft, and read it back', async () => {
    const edited = await kernel.update({
      collection: 'posts',
      id: draftId,
      data: { body: 'still a draft' },
      req: bodyAgent,
    })
    expect(edited?.body).toBe('still a draft')
    expect(edited?._status).toBe('draft')
    const read = await kernel.findByID({ collection: 'posts', id: draftId, draft: true, req: bodyAgent })
    expect(read?.body).toBe('still a draft')
  })

  it('may unpublish (published → draft is never a publish transition)', async () => {
    // Publish as a human first, then let the agent pull it back to draft.
    await kernel.update({ collection: 'posts', id: draftId, data: { _status: 'published' }, req: human })
    const unpublished = await kernel.unpublish({ collection: 'posts', id: draftId, req: bodyAgent })
    expect(unpublished?._status).toBe('draft')
  })

  // Scheduled-publish bypass: setting `_scheduled_at` schedules a publish that the cron
  // (processScheduledPublishes, override) would later execute — a publish by proxy. The
  // agent brake must treat it exactly like a direct publish.
  it('forbids scheduling a publish via update { _scheduled_at } (past time)', async () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    await expect(
      kernel.update({ collection: 'posts', id: draftId, data: { _scheduled_at: past }, req: bodyAgent }),
    ).rejects.toThrow()
  })

  it('forbids scheduling a publish via update { _scheduled_at } (future time)', async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString()
    await expect(
      kernel.update({ collection: 'posts', id: draftId, data: { _scheduled_at: future }, req: bodyAgent }),
    ).rejects.toThrow()
  })

  it('forbids scheduling a publish on create { _scheduled_at }', async () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    await expect(
      kernel.create({ collection: 'posts', data: { body: 'sneaky', _scheduled_at: past }, req: bodyAgent }),
    ).rejects.toThrow()
  })

  it('does not persist a schedule after a forbidden agent attempt', async () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    await expect(
      kernel.update({ collection: 'posts', id: draftId, data: { _scheduled_at: past }, req: bodyAgent }),
    ).rejects.toThrow()
    // Storage proof: with no pending schedule, the cron (run now, with the past time
    // long elapsed) publishes nothing for this draft — the bypass is closed.
    const result = await kernel.processScheduledPublishes({ now: new Date() })
    expect(result.published).not.toContain(draftId)
    const after = await kernel.findByID({ collection: 'posts', id: draftId, draft: true, overrideAccess: true })
    expect(after?._status).toBe('draft')
  })

  it('an agent may clear _scheduled_at to null (harmless, never schedules a publish)', async () => {
    const cleared = await kernel.update({
      collection: 'posts',
      id: draftId,
      data: { _scheduled_at: null },
      req: bodyAgent,
    })
    expect(cleared?._status).toBe('draft')
  })
})

describe('scheduled publishing: human + cron paths unaffected by the agent brake', () => {
  let kernel: Kernel
  let draftId: string

  beforeEach(async () => {
    kernel = await initKernel(postsConfig(), { logLevel: 'error' })
    await kernel.migrate()
    const draft = await kernel.create({
      collection: 'posts',
      data: { title: 'Seed', body: 'seed', _status: 'draft' },
      req: human,
    })
    draftId = draft.id
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('a human can schedule a publish (stays a draft; cron has not fired yet)', async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString()
    const scheduled = await kernel.update({
      collection: 'posts',
      id: draftId,
      data: { _scheduled_at: future },
      req: human,
    })
    // Stays a draft until the cron fires; a cron run NOW finds nothing due.
    expect(scheduled?._status).toBe('draft')
    const result = await kernel.processScheduledPublishes({ now: new Date() })
    expect(result.published).not.toContain(draftId)
    const still = await kernel.findByID({ collection: 'posts', id: draftId, draft: true, overrideAccess: true })
    expect(still?._status).toBe('draft')
  })

  it('processScheduledPublishes publishes a human-scheduled draft once due', async () => {
    // Human schedules in the past so it is immediately due.
    const past = new Date(Date.now() - 60_000).toISOString()
    await kernel.update({ collection: 'posts', id: draftId, data: { _scheduled_at: past }, req: human })

    const result = await kernel.processScheduledPublishes({ now: new Date() })
    expect(result.published).toContain(draftId)

    const published = await kernel.findByID({ collection: 'posts', id: draftId })
    expect(published?._status).toBe('published')
  })
})

describe('human principal is unchanged by the agent machinery', () => {
  let kernel: Kernel
  let draftId: string

  beforeEach(async () => {
    kernel = await initKernel(postsConfig(), { logLevel: 'error' })
    await kernel.migrate()
    const draft = await kernel.create({
      collection: 'posts',
      data: { title: 'Seed', body: 'seed', _status: 'draft' },
      req: human,
    })
    draftId = draft.id
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('a human (no fieldScope) writes every unruled field, including roles', async () => {
    const updated = await kernel.update({
      collection: 'posts',
      id: draftId,
      data: { title: 'human title', roles: 'anything' },
      req: human,
    })
    expect(updated?.title).toBe('human title')
    // No fieldScope and no field rule → unchanged behaviour: the field is written.
    expect(updated?.roles).toBe('anything')
  })

  it('a human can still publish (publish gate falls back to update)', async () => {
    const published = await kernel.update({
      collection: 'posts',
      id: draftId,
      data: { _status: 'published' },
      req: human,
    })
    expect(published?._status).toBe('published')
  })
})

describe('version attribution by principal kind', () => {
  let kernel: Kernel

  beforeEach(async () => {
    kernel = await initKernel(postsConfig(), { logLevel: 'error' })
    await kernel.migrate()
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('records createdByType and can filter the history to agent changes', async () => {
    const draft = await kernel.create({
      collection: 'posts',
      data: { body: 'by agent', _status: 'draft' },
      req: bodyAgent,
    })
    await kernel.update({ collection: 'posts', id: draft.id, data: { body: 'human edit' }, req: human })

    const agentOnly = await kernel.findVersions({
      collection: 'posts',
      id: draft.id,
      createdByType: 'agent',
      overrideAccess: true,
    })
    expect(agentOnly.docs.length).toBe(1)
    expect(agentOnly.docs.every((v) => v.createdByType === 'agent')).toBe(true)

    const all = await kernel.findVersions({ collection: 'posts', id: draft.id, overrideAccess: true })
    expect(all.docs.length).toBeGreaterThan(agentOnly.docs.length)
  })
})
