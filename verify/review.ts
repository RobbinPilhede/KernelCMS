/* Live agent-review verification: an agent composes a blocks page (draft), a human
 * reviewer requests changes then approves, and the queue derivation + publish gate are
 * proven end-to-end. Run: pnpm tsx verify/review.ts */
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
async function denied(n: string, fn: () => Promise<unknown>) {
  try {
    await fn()
    check(n, false, 'expected an error, succeeded')
  } catch (e: any) {
    check(n, true, `threw ${e?.code ?? e?.name}`)
  }
}

// An editor may publish; a viewer may read but not publish.
const isEditor = ({ req }: any) => Boolean(req.user?.roles?.includes('editor'))
const agentToken = 'content-bot-token-verify-0001'
const agent = {
  req: {
    user: {
      id: 'content-bot',
      principalType: 'agent',
      roles: ['editor'],
      fieldScope: { allow: ['title', 'body', 'layout'] },
    },
  },
}
const editor = { req: { user: { id: 'ed-1', roles: ['editor'] } } }
const viewer = { req: { user: { id: 'vw-1', roles: ['viewer'] } } }

async function main() {
  const dbFile = join(mkdtempSync(join(tmpdir(), 'kverify-review-')), 'r.db')
  const config = defineConfig({
    secret: 'verify-secret-32-characters-long!!',
    db: sqliteAdapter({ url: `file:${dbFile}` }),
    audit: true,
    agents: [
      { id: 'content-bot', token: agentToken, roles: ['editor'], fieldScope: { allow: ['title', 'body', 'layout'] } },
    ],
    collections: [
      {
        slug: 'posts',
        versions: { drafts: true },
        access: {
          read: () => true,
          create: () => true,
          update: () => true,
          publish: isEditor,
        },
        fields: [
          { name: 'title', type: 'text' },
          { name: 'body', type: 'text' },
          {
            name: 'layout',
            type: 'blocks',
            blocks: [
              {
                slug: 'hero',
                fields: [
                  { name: 'heading', type: 'text' },
                  { name: 'subheading', type: 'text' },
                ],
              },
              {
                slug: 'cta',
                fields: [
                  { name: 'label', type: 'text' },
                  { name: 'href', type: 'text' },
                ],
              },
            ],
          },
        ],
      },
    ],
  })
  const kernel = await initKernel(config, { autoMigrate: true } as any)

  console.log('\n\x1b[1mAI page composition — one validated call, agent draft\x1b[0m')
  const composed = await kernel.composePage({
    collection: 'posts',
    blocks: [
      { type: 'hero', data: { heading: 'Welcome', subheading: 'From the bot' } },
      { type: 'cta', data: { label: 'Get started', href: '/start' } },
    ],
    data: { title: 'Bot page' },
    ...(agent.req ? { req: agent.req } : {}),
  } as any)
  check('composePage creates a document', Boolean(composed.id), `id=${composed.id}`)
  check('born a DRAFT (agent draft-only brake holds)', composed._status === 'draft', `status=${composed._status}`)
  check('layout assembled with 2 blocks', Array.isArray(composed.layout) && composed.layout.length === 2, '')
  check(
    'block types preserved in order',
    (composed.layout as any)?.[0]?.blockType === 'hero' && (composed.layout as any)?.[1]?.blockType === 'cta',
    '',
  )
  const versions = await kernel.findVersions({ collection: 'posts', id: composed.id, overrideAccess: true })
  check(
    'attributed createdByType==="agent"',
    versions.docs.some((v: any) => v.createdByType === 'agent'),
    '',
  )

  console.log('\n\x1b[1mcomposePage validation — invalid layouts rejected\x1b[0m')
  await denied('unknown block type is rejected', () =>
    kernel.composePage({
      collection: 'posts',
      blocks: [{ type: 'nope', data: {} }],
      ...((agent as any).req ? { req: (agent as any).req } : {}),
    } as any),
  )
  await denied('unknown block field is rejected', () =>
    kernel.composePage({
      collection: 'posts',
      blocks: [{ type: 'hero', data: { bogus: 'x' } }],
      req: (agent as any).req,
    } as any),
  )
  await denied('prototype-pollution block key is rejected', () =>
    // A real own `__proto__` key (as a JSON payload would carry over MCP/HTTP), not the
    // JS literal (which sets the prototype and is harmless). Must be rejected.
    kernel.composePage({
      collection: 'posts',
      blocks: [{ type: 'hero', data: JSON.parse('{"__proto__":"x"}') }],
      req: (agent as any).req,
    } as any),
  )

  console.log('\n\x1b[1mReview inbox — derived queue + decisions\x1b[0m')
  let queue = await kernel.findReviewQueue({ req: editor.req })
  check(
    'queue lists the agent draft as pending',
    queue.docs.some((d) => d.id === composed.id),
    `count=${queue.count}`,
  )

  console.log('\n\x1b[1mRequest changes — stays a draft, note recorded\x1b[0m')
  const rc = await kernel.submitReview({
    collection: 'posts',
    id: composed.id,
    decision: 'request_changes',
    note: 'Tighten the hero copy.',
    req: editor.req,
  })
  check('decision recorded as changes_requested', rc.decision === 'changes_requested', '')
  const afterRc = await kernel.findByID({ collection: 'posts', id: composed.id, draft: true, overrideAccess: true })
  check('document is still a draft after request_changes', afterRc?._status === 'draft', `status=${afterRc?._status}`)
  queue = await kernel.findReviewQueue({ req: editor.req })
  const item = queue.docs.find((d) => d.id === composed.id)
  check(
    'queue still shows it with the lastReview note',
    item?.lastReview?.note === 'Tighten the hero copy.',
    `note=${item?.lastReview?.note}`,
  )

  console.log('\n\x1b[1mAgent revises — re-enters the queue\x1b[0m')
  await new Promise((r) => setTimeout(r, 10)) // ensure updatedAt advances past the review timestamp
  await kernel.update({ collection: 'posts', id: composed.id, data: { body: 'revised body' }, req: agent.req })
  queue = await kernel.findReviewQueue({ req: editor.req })
  check(
    'revised draft is back in the queue',
    queue.docs.some((d) => d.id === composed.id),
    '',
  )

  console.log('\n\x1b[1mApprove — publish gate reused\x1b[0m')
  await denied('a non-publisher (viewer) CANNOT approve (publish gate)', () =>
    kernel.submitReview({ collection: 'posts', id: composed.id, decision: 'approve', req: viewer.req }),
  )
  const stillDraft = await kernel.findByID({ collection: 'posts', id: composed.id, draft: true, overrideAccess: true })
  check(
    'document still draft after a rejected approve',
    stillDraft?._status === 'draft',
    `status=${stillDraft?._status}`,
  )

  const ap = await kernel.submitReview({ collection: 'posts', id: composed.id, decision: 'approve', req: editor.req })
  check('editor approve records "approved"', ap.decision === 'approved', '')
  const published = await kernel.findByID({ collection: 'posts', id: composed.id })
  check('document is now PUBLISHED', published?._status === 'published', `status=${published?._status}`)
  queue = await kernel.findReviewQueue({ req: editor.req })
  check('approved document leaves the queue', !queue.docs.some((d) => d.id === composed.id), `count=${queue.count}`)

  console.log('\n\x1b[1mGovernance trail — decisions audited\x1b[0m')
  const audit = await kernel.findAuditLog({ limit: 100 })
  const actions = (audit.docs ?? []).map((d: any) => d.action)
  check('review.request_changes recorded', actions.includes('review.request_changes'), '')
  check('review.approve recorded', actions.includes('review.approve'), '')

  console.log('\n\x1b[1mHardening — bounds on agent-reachable surfaces\x1b[0m')
  const tooMany = Array.from({ length: 201 }, () => ({ type: 'hero', data: { heading: 'x' } }))
  await denied('composePage rejects an over-large blocks array (>200)', () =>
    kernel.composePage({ collection: 'posts', blocks: tooMany, req: agent.req }),
  )
  await denied('submitReview rejects an over-long note (>10k)', () =>
    kernel.submitReview({
      collection: 'posts',
      id: composed.id,
      decision: 'request_changes',
      note: 'n'.repeat(10_001),
      req: editor.req,
    }),
  )

  console.log(`\n\x1b[1mReview Result: ${pass} passed, ${fails.length} failed\x1b[0m`)
  if (fails.length) {
    console.log('Failures:\n  ' + fails.join('\n  '))
    process.exit(1)
  }
  process.exit(0)
}
main().catch((e) => {
  console.error('REVIEW HARNESS ERROR:', e)
  process.exit(2)
})
