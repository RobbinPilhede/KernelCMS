/* Live agentic-workflow verification: a real sqlite kernel with a scoped `writer-bot`
 * agent, a drafts-enabled `posts` collection (publish: isEditor), a blocking banned-term
 * eval, the review inbox + audit, and a few workflows. Proves the guardrails that ARE the
 * feature: steps run scoped + draft-only, the eval/review gates are the only advancement,
 * triggers drain durably, and a step can never publish or override access.
 * Run: pnpm tsx verify/workflows.ts */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig, initKernel } from '@kernel/core'
import type { EvalRule, WorkflowDefinition } from '@kernel/core'
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

const isEditor = ({ req }: any) => Boolean(req.user?.roles?.includes('editor'))
const editor = { user: { id: 'ed', roles: ['editor'] } }

const bannedTermEval: EvalRule = {
  name: 'no-banned-terms',
  run({ doc }) {
    const body = typeof doc.body === 'string' ? doc.body : ''
    if (body.toLowerCase().includes('forbidden')) {
      return [{ ok: false, severity: 'error', message: 'body contains a banned term', field: 'body' }]
    }
    return [{ ok: true, severity: 'info', message: 'clean' }]
  },
}

// Ids captured by the steps, so the harness can assert on the documents they wrote.
let cleanId = ''
let bannedId = ''
let reviewId = ''

const workflows: WorkflowDefinition[] = [
  {
    slug: 'draft_clean',
    agent: 'writer-bot',
    steps: [
      {
        name: 'write',
        async run(ctx) {
          ctx.log('drafting')
          // Submits an out-of-scope `secret` field AND a publish attempt is NOT made here —
          // we prove the fieldScope strip + draft default on a normal write.
          const post = await ctx.kernel.create({
            collection: 'posts',
            data: { title: 'Hello', body: 'clean body', secret: 'leak' },
          })
          cleanId = post.id
        },
      },
    ],
  },
  {
    slug: 'gated',
    agent: 'writer-bot',
    steps: [
      {
        name: 'write-banned',
        async run(ctx) {
          const post = await ctx.kernel.create({
            collection: 'posts',
            data: { title: 'Bad', body: 'this is forbidden' },
          })
          bannedId = post.id
        },
      },
      {
        name: 'gate',
        async run(ctx) {
          await ctx.evalGate({ collection: 'posts', id: bannedId })
        },
      },
      {
        name: 'never',
        async run(ctx) {
          ctx.log('unreachable')
        },
      },
    ],
  },
  {
    slug: 'review_flow',
    agent: 'writer-bot',
    steps: [
      {
        name: 'write',
        async run(ctx) {
          const post = await ctx.kernel.create({ collection: 'posts', data: { title: 'Review me', body: 'ok body' } })
          reviewId = post.id
        },
      },
      {
        name: 'request-review',
        async run(ctx) {
          await ctx.requestReview({ collection: 'posts', id: reviewId }, 'please review')
        },
      },
      {
        name: 'after',
        async run(ctx) {
          ctx.log('unreachable until human acts')
        },
      },
    ],
  },
  {
    slug: 'tries_publish',
    agent: 'writer-bot',
    steps: [
      {
        name: 'born-published',
        async run(ctx) {
          await ctx.kernel.create({ collection: 'posts', data: { title: 'Hot', body: 'now', _status: 'published' } })
        },
      },
    ],
  },
  {
    slug: 'on_brief',
    agent: 'writer-bot',
    trigger: { on: 'create', collection: 'briefs' },
    steps: [
      {
        name: 'draft-from-brief',
        async run(ctx) {
          const input = ctx.input as { topic?: string } | undefined
          await ctx.kernel.create({ collection: 'posts', data: { title: input?.topic ?? 'untitled', body: 'drafted' } })
        },
      },
    ],
  },
  {
    // Self-loop guard test: triggers on `briefs` create AND its own step creates a brief
    // as its own agent. The loop guard must stop the agent's write from re-triggering it.
    slug: 'self_loop',
    agent: 'writer-bot',
    trigger: { on: 'create', collection: 'briefs' },
    steps: [
      {
        name: 'spawn-brief',
        async run(ctx) {
          await ctx.kernel.create({ collection: 'briefs', data: { topic: 'spawned' } })
        },
      },
    ],
  },
]

async function main() {
  const dbFile = join(mkdtempSync(join(tmpdir(), 'kverify-wf-')), 'w.db')
  const config = defineConfig({
    secret: 'verify-secret-32-characters-long!!',
    db: sqliteAdapter({ url: `file:${dbFile}` }),
    audit: true,
    review: true,
    evals: [bannedTermEval],
    agents: [
      { id: 'writer-bot', token: 'writer-bot-token', roles: ['editor'], fieldScope: { allow: ['title', 'body'] } },
    ],
    collections: [
      {
        slug: 'posts',
        versions: { drafts: true },
        access: { read: () => true, create: () => true, update: () => true, publish: isEditor },
        fields: [
          { name: 'title', type: 'text' },
          { name: 'body', type: 'text' },
          { name: 'secret', type: 'text' },
        ],
      },
      {
        slug: 'briefs',
        access: { read: () => true, create: () => true, update: () => true },
        fields: [{ name: 'topic', type: 'text' }],
      },
    ],
    workflows,
  })
  const kernel = await initKernel(config, { autoMigrate: true } as any)

  console.log('\n\x1b[1mWorkflows — steps run AS the scoped agent (draft-only + field-scoped)\x1b[0m')
  const run1 = await kernel.runWorkflow({ slug: 'draft_clean' })
  check('runWorkflow completes a clean run', run1.status === 'completed', `status=${run1.status}`)
  check('per-step status recorded', run1.steps[0]?.status === 'completed', `step=${run1.steps[0]?.status}`)
  const cleanDoc: any = await kernel.findByID({ collection: 'posts', id: cleanId, draft: true, overrideAccess: true })
  check('the step wrote a DRAFT (agent cannot publish)', cleanDoc?._status === 'draft', `_status=${cleanDoc?._status}`)
  check('allowed fields written', cleanDoc?.title === 'Hello' && cleanDoc?.body === 'clean body', '')
  check(
    'out-of-scope `secret` STRIPPED by fieldScope',
    (cleanDoc?.secret ?? null) === null,
    `secret=${cleanDoc?.secret}`,
  )
  // Attribution: the draft is agent-authored (so the review inbox can see it).
  const versions = await kernel.findVersions({
    collection: 'posts',
    id: cleanId,
    createdByType: 'agent',
    overrideAccess: true,
  } as any)
  check(
    'draft attributed to the agent (createdByType=agent)',
    versions.docs.length >= 1,
    `agentVersions=${versions.docs.length}`,
  )

  console.log('\n\x1b[1mWorkflows — evalGate is a hard gate (blocking eval halts the run)\x1b[0m')
  const run2 = await kernel.runWorkflow({ slug: 'gated' })
  check('a blocking eval fails the run', run2.status === 'failed', `status=${run2.status}`)
  check('the gate step is recorded failed', run2.steps[1]?.status === 'failed', `gate=${run2.steps[1]?.status}`)
  check('the step AFTER the gate never ran', run2.steps[2]?.status === 'pending', `after=${run2.steps[2]?.status}`)
  const bannedDoc: any = await kernel.findByID({ collection: 'posts', id: bannedId, draft: true, overrideAccess: true })
  check(
    'the offending content stays a DRAFT (never published)',
    bannedDoc?._status === 'draft',
    `_status=${bannedDoc?._status}`,
  )
  const failAudit = await kernel.findAuditLog({ where: { action: { equals: 'workflow.failed' } } })
  check(
    'the failure is recorded in the audit log',
    (failAudit.docs ?? []).length > 0,
    `entries=${failAudit.docs?.length}`,
  )

  console.log('\n\x1b[1mWorkflows — requestReview pauses; only a HUMAN approving publishes\x1b[0m')
  const run3 = await kernel.runWorkflow({ slug: 'review_flow' })
  check('the run pauses as awaiting_review', run3.status === 'awaiting_review', `status=${run3.status}`)
  check(
    'the step after requestReview did not run',
    run3.steps[2]?.status === 'pending',
    `after=${run3.steps[2]?.status}`,
  )
  const queue = await kernel.findReviewQueue({ collection: 'posts', req: editor })
  check(
    'the draft appears in the review inbox',
    queue.docs.some((d) => d.id === reviewId),
    `queue=${queue.docs.length}`,
  )
  let reviewDoc: any = await kernel.findByID({ collection: 'posts', id: reviewId, draft: true, overrideAccess: true })
  check('still a DRAFT before approval', reviewDoc?._status === 'draft', `_status=${reviewDoc?._status}`)
  await kernel.submitReview({ collection: 'posts', id: reviewId, decision: 'approve', req: editor })
  reviewDoc = await kernel.findByID({ collection: 'posts', id: reviewId, overrideAccess: true })
  check(
    'an editor approving via the inbox is what publishes it',
    reviewDoc?._status === 'published',
    `_status=${reviewDoc?._status}`,
  )

  console.log('\n\x1b[1mWorkflows — a step can NEVER publish (agent brake holds)\x1b[0m')
  const run4 = await kernel.runWorkflow({ slug: 'tries_publish' })
  check('a born-published step fails the run', run4.status === 'failed', `status=${run4.status}`)
  const anyPublishedHot = await kernel.find({
    collection: 'posts',
    where: { title: { equals: 'Hot' } } as any,
    overrideAccess: true,
    draft: true,
  })
  check(
    'nothing was published by the publish attempt',
    !anyPublishedHot.docs.some((p: any) => p._status === 'published'),
    '',
  )

  console.log('\n\x1b[1mWorkflows — create trigger enqueues a DURABLE run drained by runDueJobs\x1b[0m')
  await kernel.create({ collection: 'briefs', data: { topic: 'A topic' }, req: editor })
  let triggered = await kernel.workflowRuns({ slug: 'on_brief' })
  check('the run is durable (not executed inline at trigger time)', triggered.count === 0, `runs=${triggered.count}`)
  await kernel.runDueJobs()
  triggered = await kernel.workflowRuns({ slug: 'on_brief' })
  check('runDueJobs drains the enqueued run', triggered.count === 1, `runs=${triggered.count}`)
  check('the drained run completed', triggered.docs[0]?.status === 'completed', `status=${triggered.docs[0]?.status}`)
  check(
    'the run records the trigger source',
    triggered.docs[0]?.trigger.collection === 'briefs',
    `trigger=${triggered.docs[0]?.trigger.collection}`,
  )
  const draftedPosts = await kernel.find({ collection: 'posts', overrideAccess: true, draft: true })
  check(
    'the workflow drafted a post from the brief',
    draftedPosts.docs.some((p: any) => p.title === 'A topic'),
    '',
  )

  console.log('\n\x1b[1mWorkflows — self-trigger loop guard (agent write does not re-fire its own workflow)\x1b[0m')
  // The editor's brief already triggered self_loop; drain everything, then drain twice
  // more. The agent's own brief-create inside the step must NOT enqueue more self_loop
  // runs — so the count is bounded, not runaway.
  await kernel.runDueJobs()
  await kernel.runDueJobs()
  const loopRuns1 = (await kernel.workflowRuns({ slug: 'self_loop' })).count
  await kernel.runDueJobs()
  await kernel.runDueJobs()
  const loopRuns2 = (await kernel.workflowRuns({ slug: 'self_loop' })).count
  check(
    'self-triggering workflow run count is bounded (no runaway)',
    loopRuns2 === loopRuns1,
    `${loopRuns1} → ${loopRuns2}`,
  )

  console.log('\n\x1b[1mWorkflows — run log is queryable + completed runs are audited\x1b[0m')
  const completedRuns = await kernel.workflowRuns({ status: 'completed' })
  check('completed runs queryable by status', completedRuns.count >= 2, `completed=${completedRuns.count}`)
  const okAudit = await kernel.findAuditLog({ where: { action: { equals: 'workflow.completed' } } })
  check('completed runs recorded in the audit log', (okAudit.docs ?? []).length >= 2, `entries=${okAudit.docs?.length}`)

  console.log(`\n\x1b[1mWorkflows Result: ${pass} passed, ${fails.length} failed\x1b[0m`)
  await kernel.destroy()
  if (fails.length) {
    console.log('Failures:\n  ' + fails.join('\n  '))
    process.exit(1)
  }
  process.exit(0)
}
main().catch((e) => {
  console.error('WORKFLOWS HARNESS ERROR:', e)
  process.exit(2)
})
