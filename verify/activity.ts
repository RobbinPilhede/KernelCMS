/* Live per-document activity-timeline verification: `documentActivity` merges a document's
 * version snapshots + editorial comments (any reader) with review decisions + audit-log
 * entries (reviewers only) into one access-checked, newest-first feed. Proves: the whole feed
 * is gated on the document's READ access (a caller who can't read the doc is denied — no leak);
 * a reviewer sees version + comment + audit; a non-reviewer who CAN read sees only version +
 * comment, `includesReviewerEvents` is false, and NO audit leaks; events are newest-first; and
 * the `types` filter restricts the feed (and still reviewer-gates audit). No HTTP server needed
 * — exercises the core op directly. Run: pnpm tsx verify/activity.ts */
import { mkdtempSync, rmSync } from 'node:fs'
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
async function denied(n: string, fn: () => Promise<unknown>) {
  try {
    await fn()
    check(n, false, 'expected an error, succeeded')
  } catch (e: any) {
    check(
      n,
      /forbidden|not.?found|unauthorized|validation|bad.?request|invalid/i.test(`${e?.code}${e?.name}${e?.message}`),
      `threw ${e?.code ?? e?.name}`,
    )
  }
}

// A reviewer (editor/admin), a non-reviewer viewer, and anonymous (no user).
const editor = { user: { id: 'ed', roles: ['editor'] } } as any
const admin = { user: { id: 'adm', roles: ['admin'] } } as any
const viewer = { user: { id: 'vw', roles: ['viewer'] } } as any
const viewerB = { user: { id: 'vw2', roles: ['viewer'] } } as any

// Owner-scoped read: a row is only readable by its owner (or an admin).
const ownerRead = ({ req }: any) => {
  if (req.user?.roles?.includes('admin')) return true
  return { owner: { equals: req.user?.id ?? '__none__' } }
}

async function main() {
  const dbFile = join(mkdtempSync(join(tmpdir(), 'kverify-activity-')), 'a.db')
  const config = defineConfig({
    secret: 'verify-secret-32-characters-long!!',
    db: sqliteAdapter({ url: `file:${dbFile}` }),
    audit: true,
    comments: true,
    collections: [
      {
        slug: 'posts',
        versions: { drafts: true },
        access: { read: () => true, create: () => true, update: () => true },
        fields: [
          { name: 'title', type: 'text', required: true },
          { name: 'body', type: 'text' },
        ],
      },
      {
        slug: 'secrets',
        versions: { drafts: true },
        access: { read: ownerRead, create: () => true, update: () => true },
        fields: [
          { name: 'owner', type: 'text' },
          { name: 'note', type: 'text' },
        ],
      },
    ],
  })
  const kernel = await initKernel(config, { autoMigrate: true } as any)

  // Seed a public post: create + update (>=2 versions) + a comment by the viewer.
  const post = await kernel.create({ collection: 'posts', data: { title: 'Hello' }, req: editor })
  await kernel.update({ collection: 'posts', id: post.id, data: { title: 'Hello v2' }, req: editor })
  const comment = await kernel.addComment({ collection: 'posts', id: post.id, body: 'first comment', req: viewer })

  console.log('\n\x1b[1mActivity — reviewer sees a merged version + comment + audit feed\x1b[0m')
  const rev = await kernel.documentActivity({ collection: 'posts', id: post.id, req: editor })
  check('includesReviewerEvents is true for a reviewer', rev.includesReviewerEvents === true, '')
  check(
    'feed has >= 2 version events',
    rev.events.filter((e: any) => e.type === 'version').length >= 2,
    `versions=${rev.events.filter((e: any) => e.type === 'version').length}`,
  )
  check(
    'feed has a comment event',
    rev.events.some((e: any) => e.type === 'comment'),
    '',
  )
  check(
    'feed has audit events (reviewer-only)',
    rev.events.some((e: any) => e.type === 'audit'),
    '',
  )
  const auditActions = rev.events.filter((e: any) => e.type === 'audit').map((e: any) => e.action)
  check(
    'audit actions are real audit actions',
    auditActions.length > 0 && auditActions.every((a: string) => ['create', 'update', 'comment.create'].includes(a)),
    `actions=${[...new Set(auditActions)].join(',')}`,
  )
  const mapped = rev.events.find((e: any) => e.type === 'comment') as any
  check(
    'comment event maps body + actor from the principal',
    mapped?.data?.commentId === comment.id && mapped?.data?.body === 'first comment' && mapped?.actor?.id === 'vw',
    `actor=${mapped?.actor?.id}`,
  )

  console.log('\n\x1b[1mActivity — events are newest-first\x1b[0m')
  let ordered = true
  for (let i = 0; i < rev.events.length - 1; i++) {
    if (!(rev.events[i]!.at >= rev.events[i + 1]!.at)) ordered = false
  }
  check('events sorted newest-first (at desc)', ordered, `n=${rev.events.length}`)

  console.log('\n\x1b[1mActivity — a non-reviewer reader sees version + comment ONLY (no audit leak)\x1b[0m')
  const non = await kernel.documentActivity({ collection: 'posts', id: post.id, req: viewer })
  check('includesReviewerEvents is false for a non-reviewer', non.includesReviewerEvents === false, '')
  check(
    'non-reviewer sees version events',
    non.events.some((e: any) => e.type === 'version'),
    '',
  )
  check(
    'non-reviewer sees comment events',
    non.events.some((e: any) => e.type === 'comment'),
    '',
  )
  check('non-reviewer sees NO audit events', !non.events.some((e: any) => e.type === 'audit'), '')
  check('non-reviewer sees NO review events', !non.events.some((e: any) => e.type === 'review'), '')

  console.log("\n\x1b[1mActivity — user A's comment is visible in user B's feed (B can read the doc)\x1b[0m")
  const bFeed = await kernel.documentActivity({ collection: 'posts', id: post.id, req: viewerB })
  check(
    "user B sees user A's comment",
    bFeed.events.some((e: any) => e.type === 'comment' && e.data.commentId === comment.id),
    '',
  )
  check('user B (non-reviewer) still sees no audit', !bFeed.events.some((e: any) => e.type === 'audit'), '')

  console.log('\n\x1b[1mActivity — the `types` filter restricts the feed (and reviewer-gates audit)\x1b[0m')
  const onlyComments = await kernel.documentActivity({
    collection: 'posts',
    id: post.id,
    types: ['comment'],
    req: editor,
  })
  check(
    'types:[comment] returns only comment events',
    onlyComments.events.length > 0 && onlyComments.events.every((e: any) => e.type === 'comment'),
    `n=${onlyComments.events.length}`,
  )
  const viewerAudit = await kernel.documentActivity({ collection: 'posts', id: post.id, types: ['audit'], req: viewer })
  check(
    'types:[audit] for a non-reviewer returns []',
    viewerAudit.events.length === 0,
    `n=${viewerAudit.events.length}`,
  )
  const reviewerAudit = await kernel.documentActivity({
    collection: 'posts',
    id: post.id,
    types: ['audit'],
    req: editor,
  })
  check(
    'types:[audit] for a reviewer returns audit events',
    reviewerAudit.events.length > 0 && reviewerAudit.events.every((e: any) => e.type === 'audit'),
    `n=${reviewerAudit.events.length}`,
  )

  console.log('\n\x1b[1mActivity — the whole feed is gated on DOCUMENT read access (no leak)\x1b[0m')
  const secret = await kernel.create({ collection: 'secrets', data: { owner: 'vw', note: 'top secret' }, req: viewer })
  await kernel.addComment({ collection: 'secrets', id: secret.id, body: 'mine', req: viewer })
  await denied('a caller who cannot read the doc is denied (no events leak)', () =>
    kernel.documentActivity({ collection: 'secrets', id: secret.id, req: viewerB }),
  )
  await denied('an anonymous caller (no req.user) is denied on an unreadable doc', () =>
    kernel.documentActivity({ collection: 'secrets', id: secret.id }),
  )
  const ownerFeed = await kernel.documentActivity({ collection: 'secrets', id: secret.id, req: viewer })
  check(
    'the owner CAN read its own doc feed',
    ownerFeed.events.some((e: any) => e.type === 'comment'),
    '',
  )
  const adminFeed = await kernel.documentActivity({ collection: 'secrets', id: secret.id, req: admin })
  check('an admin reads any doc with the reviewer feed', adminFeed.includesReviewerEvents === true, '')

  await kernel.destroy()
  rmSync(dbFile, { force: true })
  console.log(`\n\x1b[1mActivity Result: ${pass} passed, ${fails.length} failed\x1b[0m`)
  if (fails.length) {
    console.log('Failures:\n  ' + fails.join('\n  '))
    process.exit(1)
  }
  process.exit(0)
}
main().catch((e) => {
  console.error('ACTIVITY HARNESS ERROR:', e)
  process.exit(2)
})
