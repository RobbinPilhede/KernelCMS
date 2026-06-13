import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { defineConfig, initKernel } from './index'
import type { EvalRule, Kernel, WorkflowContext, WorkflowDefinition } from './index'

// Agentic workflows: a SCOPED agent drives content from trigger → draft → quality gate →
// human review, with hard guardrails. Every step runs AS the workflow's agent principal
// (field-scoped + draft-only + access-checked, never overrideAccess); content advances
// ONLY through the eval gate or the human review inbox — never auto-publish. These tests
// pin the run-state machine, the gates, the scoped-principal brake, the trigger enqueue,
// and the untrusted-input guard.

const isEditor = ({ req }: { req: { user: { roles?: string[] } | null } }): boolean =>
  Boolean(req.user?.roles?.includes('editor'))
const editor = { user: { id: 'ed', roles: ['editor'] } }

// A blocking eval that rejects any post whose body contains a banned term.
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

function workflowConfig(workflows: WorkflowDefinition[]) {
  return defineConfig({
    secret: 'workflow-test-secret',
    db: sqliteAdapter({ url: ':memory:' }),
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
          // Unscoped privilege field: only the agent fieldScope stops it being written.
          { name: 'secret', type: 'text' },
        ],
      },
      // A trigger source collection (no drafts needed — the workflow writes into posts).
      {
        slug: 'briefs',
        access: { read: () => true, create: () => true, update: () => true },
        fields: [{ name: 'topic', type: 'text' }],
      },
    ],
    workflows,
  })
}

describe('runWorkflow — run-state machine', () => {
  let kernel: Kernel
  let createdId = ''

  beforeEach(async () => {
    createdId = ''
    const wf: WorkflowDefinition = {
      slug: 'draft_clean',
      agent: 'writer-bot',
      trigger: { on: 'manual' },
      steps: [
        {
          name: 'write',
          async run(ctx) {
            ctx.log('writing a clean draft')
            const post = await ctx.kernel.create({
              collection: 'posts',
              // Submits an out-of-scope field too — the fieldScope must strip it.
              data: { title: 'Hello', body: 'clean body', secret: 'leak' },
            })
            createdId = post.id
          },
        },
      ],
    }
    kernel = await initKernel(workflowConfig([wf]), { logLevel: 'error', autoMigrate: true })
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('runs steps in order and completes, recording per-step status', async () => {
    const run = await kernel.runWorkflow({ slug: 'draft_clean' })
    expect(run.status).toBe('completed')
    expect(run.steps).toHaveLength(1)
    expect(run.steps[0]?.name).toBe('write')
    expect(run.steps[0]?.status).toBe('completed')
    expect(run.steps[0]?.startedAt).toBeTruthy()
    expect(run.steps[0]?.finishedAt).toBeTruthy()
  })

  it('the step writes content AS the scoped agent: a draft, with the out-of-scope field stripped', async () => {
    await kernel.runWorkflow({ slug: 'draft_clean' })
    const doc = await kernel.findByID({ collection: 'posts', id: createdId, draft: true, overrideAccess: true })
    // Draft-only brake: even though it asked for _status:'published', it stays a draft.
    expect(doc?._status).toBe('draft')
    // fieldScope allows title/body only — `secret` is stripped.
    expect(doc?.title).toBe('Hello')
    expect(doc?.body).toBe('clean body')
    expect(doc?.secret ?? null).toBeNull()
  })

  it('records the run in the durable log, queryable by slug/status', async () => {
    const run = await kernel.runWorkflow({ slug: 'draft_clean' })
    const log = await kernel.workflowRuns({ slug: 'draft_clean' })
    expect(log.count).toBe(1)
    expect(log.docs[0]?.id).toBe(run.id)
    expect(log.docs[0]?.status).toBe('completed')
    const completed = await kernel.workflowRuns({ status: 'completed' })
    expect(completed.docs.some((r) => r.id === run.id)).toBe(true)
    const failed = await kernel.workflowRuns({ status: 'failed' })
    expect(failed.docs.some((r) => r.id === run.id)).toBe(false)
  })
})

describe('guardrail — a step can never publish, even if it tries', () => {
  let kernel: Kernel

  beforeEach(async () => {
    const wf: WorkflowDefinition = {
      slug: 'tries_to_publish',
      agent: 'writer-bot',
      steps: [
        {
          name: 'born-published',
          async run(ctx) {
            // The agent brake rejects a born-published create — this THROWS, failing the run.
            await ctx.kernel.create({ collection: 'posts', data: { title: 'Hot', body: 'now', _status: 'published' } })
          },
        },
      ],
    }
    kernel = await initKernel(workflowConfig([wf]), { logLevel: 'error', autoMigrate: true })
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('a step that requests _status:published fails the run (agent brake), publishing nothing', async () => {
    const run = await kernel.runWorkflow({ slug: 'tries_to_publish' })
    expect(run.status).toBe('failed')
    expect(run.steps[0]?.status).toBe('failed')
    // No published post exists.
    const posts = await kernel.find({ collection: 'posts', overrideAccess: true, draft: true })
    expect(posts.docs.some((p) => p._status === 'published')).toBe(false)
  })

  it('the bound step API ignores an overrideAccess attempt (cannot trust itself past the brake)', async () => {
    // Even if a step passes overrideAccess:true, the engine pins it to false — so a
    // publish-shaped write still hits the agent brake and fails the run.
    const wf: WorkflowDefinition = {
      slug: 'tries_override',
      agent: 'writer-bot',
      steps: [
        {
          name: 'override-publish',
          async run(ctx) {
            await ctx.kernel.create({
              collection: 'posts',
              data: { title: 'X', body: 'y', _status: 'published' },
              // The step tries to escalate — must be dropped by the engine.
              overrideAccess: true,
            } as never)
          },
        },
      ],
    }
    const k = await initKernel(workflowConfig([wf]), { logLevel: 'error', autoMigrate: true })
    try {
      const run = await k.runWorkflow({ slug: 'tries_override' })
      expect(run.status).toBe('failed')
      const posts = await k.find({ collection: 'posts', overrideAccess: true, draft: true })
      expect(posts.docs.some((p) => p._status === 'published')).toBe(false)
    } finally {
      await k.destroy()
    }
  })
})

describe('evalGate — halts on a blocking failure', () => {
  let kernel: Kernel
  let bannedId = ''

  beforeEach(async () => {
    bannedId = ''
    const wf: WorkflowDefinition = {
      slug: 'gated_publish',
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
          name: 'never-runs',
          async run(ctx) {
            ctx.log('should not reach here')
          },
        },
      ],
    }
    kernel = await initKernel(workflowConfig([wf]), { logLevel: 'error', autoMigrate: true })
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('fails the run, halts before later steps, and leaves the content a draft (never published)', async () => {
    const run = await kernel.runWorkflow({ slug: 'gated_publish' })
    expect(run.status).toBe('failed')
    expect(run.lastError).toMatch(/banned term/i)
    // The gate step is recorded failed; the step after it never started.
    expect(run.steps[0]?.status).toBe('completed')
    expect(run.steps[1]?.status).toBe('failed')
    expect(run.steps[2]?.status).toBe('pending')
    // The offending content stays a draft — the gate is the only path to publish.
    const doc = await kernel.findByID({ collection: 'posts', id: bannedId, draft: true, overrideAccess: true })
    expect(doc?._status).toBe('draft')
  })

  it('records the failure in the audit log', async () => {
    await kernel.runWorkflow({ slug: 'gated_publish' })
    const audit = await kernel.findAuditLog({ where: { action: { equals: 'workflow.failed' } } })
    expect(audit.docs.length).toBeGreaterThan(0)
  })
})

describe('requestReview — pauses for the human gate, which is the only way to publish', () => {
  let kernel: Kernel
  let reviewedId = ''

  beforeEach(async () => {
    reviewedId = ''
    const wf: WorkflowDefinition = {
      slug: 'draft_then_review',
      agent: 'writer-bot',
      steps: [
        {
          name: 'write',
          async run(ctx) {
            const post = await ctx.kernel.create({
              collection: 'posts',
              data: { title: 'Review me', body: 'clean body' },
            })
            reviewedId = post.id
          },
        },
        {
          name: 'request-review',
          async run(ctx) {
            await ctx.requestReview({ collection: 'posts', id: reviewedId }, 'please review')
          },
        },
        {
          name: 'after-review',
          async run(ctx) {
            ctx.log('should not run — paused before this')
          },
        },
      ],
    }
    kernel = await initKernel(workflowConfig([wf]), { logLevel: 'error', autoMigrate: true })
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('pauses the run as awaiting_review and surfaces the draft in the review queue', async () => {
    const run = await kernel.runWorkflow({ slug: 'draft_then_review' })
    expect(run.status).toBe('awaiting_review')
    expect(run.steps[2]?.status).toBe('pending')
    const queue = await kernel.findReviewQueue({ collection: 'posts', req: editor })
    expect(queue.docs.some((d) => d.id === reviewedId)).toBe(true)
    // Still a draft — the workflow did not publish it.
    const doc = await kernel.findByID({ collection: 'posts', id: reviewedId, draft: true, overrideAccess: true })
    expect(doc?._status).toBe('draft')
  })

  it('an editor approving via the inbox is the only thing that publishes it', async () => {
    await kernel.runWorkflow({ slug: 'draft_then_review' })
    // Before approval: not published.
    let doc = await kernel.findByID({ collection: 'posts', id: reviewedId, draft: true, overrideAccess: true })
    expect(doc?._status).toBe('draft')
    // Human approves through the existing inbox path → publishes.
    await kernel.submitReview({ collection: 'posts', id: reviewedId, decision: 'approve', req: editor })
    doc = await kernel.findByID({ collection: 'posts', id: reviewedId, overrideAccess: true })
    expect(doc?._status).toBe('published')
  })
})

describe('trigger — a create enqueues a durable run drained by runDueJobs', () => {
  let kernel: Kernel

  beforeEach(async () => {
    const wf: WorkflowDefinition = {
      slug: 'on_brief',
      agent: 'writer-bot',
      trigger: { on: 'create', collection: 'briefs' },
      steps: [
        {
          name: 'draft-from-brief',
          async run(ctx) {
            const input = ctx.input as { topic?: string } | undefined
            await ctx.kernel.create({
              collection: 'posts',
              data: { title: input?.topic ?? 'untitled', body: 'drafted' },
            })
          },
        },
      ],
    }
    kernel = await initKernel(workflowConfig([wf]), { logLevel: 'error', autoMigrate: true })
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('creating a trigger doc enqueues a run that completes after the queue drains', async () => {
    await kernel.create({ collection: 'briefs', data: { topic: 'A topic' }, req: editor })
    // The run is durable: not executed inline, only enqueued.
    let runs = await kernel.workflowRuns({ slug: 'on_brief' })
    expect(runs.count).toBe(0)
    // Drain the queue → the run executes.
    await kernel.runDueJobs()
    runs = await kernel.workflowRuns({ slug: 'on_brief' })
    expect(runs.count).toBe(1)
    expect(runs.docs[0]?.status).toBe('completed')
    expect(runs.docs[0]?.trigger.on).toBe('create')
    expect(runs.docs[0]?.trigger.collection).toBe('briefs')
    // The draft post was created from the brief's topic.
    const posts = await kernel.find({ collection: 'posts', overrideAccess: true, draft: true })
    expect(posts.docs.some((p) => p.title === 'A topic')).toBe(true)
  })
})

describe('untrusted input + thrown steps fail cleanly', () => {
  let kernel: Kernel

  beforeEach(async () => {
    const wf: WorkflowDefinition = {
      slug: 'guarded',
      agent: 'writer-bot',
      steps: [
        {
          name: 'gate-bad-ref',
          async run(ctx) {
            // A hostile gate ref must be rejected, not pollute or crash.
            await ctx.evalGate({ collection: '__proto__', id: 'x' })
          },
        },
      ],
    }
    kernel = await initKernel(workflowConfig([wf]), { logLevel: 'error', autoMigrate: true })
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('a prototype-pollution gate ref fails the run cleanly (recorded), never crashes', async () => {
    const run = await kernel.runWorkflow({ slug: 'guarded' })
    expect(run.status).toBe('failed')
    expect(run.steps[0]?.status).toBe('failed')
    expect(run.lastError).toMatch(/illegal|unknown/i)
    // Prototype is intact.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('an unknown workflow slug throws cleanly', async () => {
    await expect(kernel.runWorkflow({ slug: 'nope' })).rejects.toThrow()
  })
})

describe('config sanitize — workflow guardrails fail-fast', () => {
  it('rejects a workflow whose agent has the admin role', async () => {
    await expect(
      initKernel(
        defineConfig({
          secret: 'workflow-test-secret',
          db: sqliteAdapter({ url: ':memory:' }),
          agents: [{ id: 'super', token: 'super-token', roles: ['admin'] }],
          collections: [{ slug: 'posts', fields: [{ name: 'title', type: 'text' }] }],
          workflows: [{ slug: 'bad', agent: 'super', steps: [{ name: 's', run: async () => {} }] }],
        }),
        { logLevel: 'error' },
      ),
    ).rejects.toThrow(/admin/i)
  })

  it('rejects a trigger pointing at a non-existent collection', async () => {
    await expect(
      initKernel(
        defineConfig({
          secret: 'workflow-test-secret',
          db: sqliteAdapter({ url: ':memory:' }),
          collections: [{ slug: 'posts', fields: [{ name: 'title', type: 'text' }] }],
          workflows: [
            {
              slug: 'bad',
              trigger: { on: 'create', collection: 'ghost' },
              steps: [{ name: 's', run: async () => {} }],
            },
          ],
        }),
        { logLevel: 'error' },
      ),
    ).rejects.toThrow(/does not exist/i)
  })

  it('rejects an unknown agent reference', async () => {
    await expect(
      initKernel(
        defineConfig({
          secret: 'workflow-test-secret',
          db: sqliteAdapter({ url: ':memory:' }),
          collections: [{ slug: 'posts', fields: [{ name: 'title', type: 'text' }] }],
          workflows: [{ slug: 'bad', agent: 'missing', steps: [{ name: 's', run: async () => {} }] }],
        }),
        { logLevel: 'error' },
      ),
    ).rejects.toThrow(/unknown agent/i)
  })
})
