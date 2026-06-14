/* Live content-lifecycle verification: a config with config.lifecycle over drafts-
 * enabled collections. Proves the cron-driven expiry drain unpublishes/archives/deletes
 * past-expiry PUBLISHED content, that `_archived_at` is server-managed, and that `now`
 * controls the cutoff deterministically. Run: pnpm tsx verify/lifecycle.ts */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig, initKernel } from '@kernel/core'
import { sqliteAdapter } from '@kernel/db-sqlite'

let pass = 0
const fails: string[] = []
const check = (n: string, c: boolean, e = '') => {
  if (c) {
    pass++
    console.log(`  \x1b[32mPASS\x1b[0m ${n}${e ? ` — ${e}` : ''}`)
  } else {
    fails.push(n)
    console.log(`  \x1b[31mFAIL\x1b[0m ${n}${e ? ` — ${e}` : ''}`)
  }
}

const admin = { req: { user: { id: 'u-admin', roles: ['admin'] } } } as any
const PAST = '2020-01-01T00:00:00.000Z'
const FUTURE = '2999-01-01T00:00:00.000Z'
const NOW = new Date('2026-01-01T00:00:00.000Z')

async function main() {
  const dbFile = join(mkdtempSync(join(tmpdir(), 'kverify-lifecycle-')), 'l.db')
  const config = defineConfig({
    secret: 'verify-secret-32-characters-long!!',
    db: sqliteAdapter({ url: `file:${dbFile}` }),
    audit: true,
    lifecycle: {
      collections: [
        { slug: 'posts', expireField: 'expire_at', onExpire: 'unpublish' },
        { slug: 'news', expireField: 'expire_at', onExpire: 'archive' },
        { slug: 'temp', expireField: 'expire_at', onExpire: 'delete' },
      ],
    },
    collections: [
      {
        slug: 'posts',
        versions: { drafts: true },
        access: { read: () => true, create: () => true, update: () => true, delete: () => true },
        fields: [
          { name: 'title', type: 'text' },
          { name: 'expire_at', type: 'date' },
        ],
      },
      {
        slug: 'news',
        versions: { drafts: true },
        access: { read: () => true, create: () => true, update: () => true, delete: () => true },
        fields: [
          { name: 'title', type: 'text' },
          { name: 'expire_at', type: 'date' },
        ],
      },
      {
        slug: 'temp',
        versions: { drafts: true },
        access: { read: () => true, create: () => true, update: () => true, delete: () => true },
        fields: [
          { name: 'title', type: 'text' },
          { name: 'expire_at', type: 'date' },
        ],
      },
    ],
  })
  const kernel = await initKernel(config, { autoMigrate: true } as any)

  const publishWith = async (collection: string, expireAt: string | null) => {
    const doc = await kernel.create({
      collection,
      data: { title: 'doc', ...(expireAt ? { expire_at: expireAt } : {}) },
      ...admin,
    })
    await kernel.publish({ collection, id: doc.id, ...admin })
    return doc
  }

  console.log('\n\x1b[1mLifecycle — unpublish on expiry (the inverse of scheduled publish)\x1b[0m')
  const pastPost = await publishWith('posts', PAST)
  const futurePost = await publishWith('posts', FUTURE)
  const noExpiryPost = await publishWith('posts', null)
  const drain1 = await kernel.processContentLifecycle({ now: NOW })
  check(
    'past-expiry published post is unpublished',
    drain1.processed.some((p: any) => p.id === pastPost.id && p.action === 'unpublish'),
    `processed=${drain1.processed.length}`,
  )
  const pastReread = await kernel.findByID({ collection: 'posts', id: pastPost.id, draft: true, ...admin })
  check(
    'unpublished doc is now a draft',
    (pastReread as any)?._status === 'draft',
    `status=${(pastReread as any)?._status}`,
  )
  const futureReread = await kernel.findByID({ collection: 'posts', id: futurePost.id, ...admin })
  check('future-expiry post is UNCHANGED (still published)', (futureReread as any)?._status === 'published')
  const noneReread = await kernel.findByID({ collection: 'posts', id: noExpiryPost.id, ...admin })
  check('no-expiry post is UNCHANGED (still published)', (noneReread as any)?._status === 'published')

  console.log('\n\x1b[1mLifecycle — archive (draft + server-managed `_archived_at`)\x1b[0m')
  const expiredNews = await publishWith('news', PAST)
  const plainDraft = await kernel.create({ collection: 'news', data: { title: 'plain' }, ...admin })
  const drain2 = await kernel.processContentLifecycle({ now: NOW })
  check(
    'past-expiry published news is archived',
    drain2.processed.some((p: any) => p.id === expiredNews.id && p.action === 'archive'),
  )
  const archived = await kernel.findByID({ collection: 'news', id: expiredNews.id, draft: true, ...admin })
  check('archived doc is a draft', (archived as any)?._status === 'draft')
  check(
    'archived doc carries `_archived_at` = now',
    (archived as any)?._archived_at === NOW.toISOString(),
    `_archived_at=${(archived as any)?._archived_at}`,
  )
  const draftReread = await kernel.findByID({ collection: 'news', id: plainDraft.id, draft: true, ...admin })
  check(
    'a plain draft is distinguishable (no `_archived_at`)',
    ((draftReread as any)?._archived_at ?? null) === null && (draftReread as any)?._status === 'draft',
  )

  console.log('\n\x1b[1mLifecycle — `_archived_at` is server-managed (field-locked)\x1b[0m')
  const lockedNews = await publishWith('news', null)
  await kernel.update({
    collection: 'news',
    id: lockedNews.id,
    data: { title: 'edited', _archived_at: NOW.toISOString() } as any,
    ...admin,
  })
  const lockedReread = await kernel.findByID({ collection: 'news', id: lockedNews.id, ...admin })
  check(
    'a client CANNOT set `_archived_at` via a normal update',
    ((lockedReread as any)?._archived_at ?? null) === null,
    `_archived_at=${(lockedReread as any)?._archived_at}`,
  )
  await kernel.update({
    collection: 'news',
    id: expiredNews.id,
    data: { title: 'tamper', _archived_at: null } as any,
    draft: true,
    ...admin,
  })
  const stillArchived = await kernel.findByID({ collection: 'news', id: expiredNews.id, draft: true, ...admin })
  check(
    'a client CANNOT clear `_archived_at` via a normal update (un-archive)',
    (stillArchived as any)?._archived_at === NOW.toISOString(),
  )

  console.log('\n\x1b[1mLifecycle — delete on expiry\x1b[0m')
  const expiredTemp = await publishWith('temp', PAST)
  const drain3 = await kernel.processContentLifecycle({ now: NOW })
  check(
    'past-expiry published temp is deleted',
    drain3.processed.some((p: any) => p.id === expiredTemp.id && p.action === 'delete'),
  )
  const goneReread = await kernel.findByID({ collection: 'temp', id: expiredTemp.id, draft: true, ...admin })
  check('deleted doc is removed', goneReread === null)

  console.log('\n\x1b[1mLifecycle — `now` controls the cutoff deterministically\x1b[0m')
  const dated = await publishWith('posts', '2026-06-01T00:00:00.000Z')
  const before = await kernel.processContentLifecycle({ now: new Date('2026-05-01T00:00:00.000Z') })
  check('before cutoff: not due', !before.processed.some((p: any) => p.id === dated.id))
  const after = await kernel.processContentLifecycle({ now: new Date('2026-07-01T00:00:00.000Z') })
  check(
    'after cutoff: due',
    after.processed.some((p: any) => p.id === dated.id && p.action === 'unpublish'),
  )

  console.log('\n\x1b[1mLifecycle — actions are audited (governance trail)\x1b[0m')
  const log = await kernel.findAuditLog({ where: { action: { equals: 'content.expire' } } })
  const entry = (log?.docs ?? []).find((d: any) => d.documentId === pastPost.id)
  check('content.expire recorded in audit log', Boolean(entry), `entries=${log?.docs?.length ?? 0}`)
  check('audit attributes the system principal', entry?.principalType === 'system', `type=${entry?.principalType}`)
  check(
    'audit meta carries the action',
    (entry?.meta as any)?.action === 'unpublish',
    `meta=${JSON.stringify(entry?.meta)}`,
  )

  console.log('\n\x1b[1mLifecycle — drain is bounded by `limit`\x1b[0m')
  for (let i = 0; i < 3; i++) await publishWith('temp', PAST)
  const bounded = await kernel.processContentLifecycle({ now: NOW, limit: 2 })
  check('limit caps the per-collection drain', bounded.processed.length === 2, `processed=${bounded.processed.length}`)

  console.log(`\n\x1b[1mLifecycle Result: ${pass} passed, ${fails.length} failed\x1b[0m`)
  if (fails.length) {
    console.log('Failures:\n  ' + fails.join('\n  '))
    process.exit(1)
  }
  process.exit(0)
}
main().catch((e) => {
  console.error('LIFECYCLE HARNESS ERROR:', e)
  process.exit(2)
})
