/**
 * Agentic workflow engine — the orchestration layer that lets a SCOPED agent take a
 * job from trigger → draft → quality gate → human review, with hard guardrails so
 * nothing autonomous can go live unchecked.
 *
 * GUARDRAILS (this IS the feature's value):
 *  - Every step runs through a Local-API subset BOUND to the workflow's agent principal
 *    (`principalType:'agent'`, the agent's `roles`/`fieldScope`). So every create/update
 *    a step makes is field-scoped, draft-only (the agent brake in operations), and runs
 *    through normal access control — NEVER `overrideAccess`. A step physically cannot
 *    publish, cannot write fields outside `fieldScope`, and cannot read past its access.
 *  - The ONLY ways content advances are the gates: `evalGate` runs the configured
 *    content-CI evals and THROWS on a blocking failure (halting the run); `requestReview`
 *    hands the draft to the human inbox (#3) and pauses the run. There is no auto-publish.
 *  - The durable `_workflow_runs` log + audit trail record every step + status transition.
 *    Run-log writes use the trusted path (a system table), but they only ever carry status
 *    and step metadata — never content writes, which always go through the scoped principal.
 *
 * Trigger-driven runs are enqueued onto the durable job queue (a reserved task), so a
 * slow agent step can never block the content write that triggered it; `runDueJobs`
 * (cron / `kernel jobs:run`) drains them.
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseAdapter, Logger, Row } from '@kernel/db'
import type { Operations } from './operations'
import type {
  AgentConfig,
  AuthUser,
  CollectionAfterChangeHook,
  CollectionConfig,
  Doc,
  JobDefinition,
  RequestContext,
  RunWorkflowOptions,
  SanitizedConfig,
  WorkflowContext,
  WorkflowDefinition,
  WorkflowLocalApi,
  WorkflowRef,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowRunsOptions,
  WorkflowStepRecord,
  WorkflowTriggerRecord,
} from './types'
import { WORKFLOW_RUNS_TABLE } from './schema'
import { WORKFLOW_JOB_TASK } from './config'
import { runEvals } from './evals'
import { BadRequestError } from './errors'

/** Prototype-pollution vectors a manual/trigger payload must never reach a write with.
 *  The engine never spreads `input` into a write itself; this guards the run-log echo. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** Keep run-log lines bounded so a chatty/hostile step can't grow a row without limit. */
const MAX_LOG_LINES = 200
const MAX_LOG_LINE_LENGTH = 2000

/** A control-flow signal a step's `requestReview` raises to PAUSE the run. Caught by the
 *  engine and turned into the `awaiting_review` terminal state — never surfaced as a failure. */
class AwaitingReviewSignal extends Error {
  constructor() {
    super('awaiting_review')
    this.name = 'AwaitingReviewSignal'
  }
}

export interface WorkflowEngine {
  runWorkflow(opts: RunWorkflowOptions): Promise<WorkflowRun>
  workflowRuns(opts?: WorkflowRunsOptions): Promise<{ docs: WorkflowRun[]; count: number }>
  /** The bound handler for the reserved drain job — `initKernel` installs it onto the
   *  placeholder job definition so `runDueJobs` executes enqueued runs. */
  drainJobHandler: JobDefinition['handler']
}

export interface WorkflowEngineCtx {
  config: SanitizedConfig
  /** Raw db for `_workflow_runs` rows (a system table; the engine owns it directly). */
  db: DatabaseAdapter
  ops: Operations
  logger?: Logger
}

/** Coerce a stored `_workflow_runs` row into the public `WorkflowRun` shape. */
function rowToRun(row: Row): WorkflowRun {
  const trigger = (row.trigger ?? { on: 'manual' }) as WorkflowTriggerRecord
  const steps = Array.isArray(row.steps) ? (row.steps as WorkflowStepRecord[]) : []
  return {
    id: String(row.id),
    slug: String(row.slug),
    status: row.status as WorkflowRunStatus,
    trigger,
    steps,
    attempts: Number(row.attempts) || 0,
    lastError: row.lastError != null ? String(row.lastError) : null,
    ...(row.createdAt != null ? { createdAt: String(row.createdAt) } : {}),
    ...(row.updatedAt != null ? { updatedAt: String(row.updatedAt) } : {}),
  }
}

export function createWorkflowEngine(ctx: WorkflowEngineCtx): WorkflowEngine {
  const { config, db, ops, logger } = ctx
  const workflowsBySlug = new Map(config.workflows.map((w) => [w.slug, w]))
  const agentsById = new Map(config.agents.map((a) => [a.id, a]))

  /** Build the scoped agent principal a workflow's steps execute as. An explicit `agent`
   *  resolves to its configured roles/fieldScope; an agent-less workflow gets a draft-only
   *  system-agent (no fieldScope, but the `principalType:'agent'` brake still forbids any
   *  publish). NEVER an admin — sanitize already rejected an admin agent. */
  function principalFor(wf: WorkflowDefinition): AuthUser {
    const agent: AgentConfig | undefined = wf.agent ? agentsById.get(wf.agent) : undefined
    if (agent) {
      return {
        id: agent.id,
        principalType: 'agent',
        roles: agent.roles ?? [],
        ...(agent.fieldScope ? { fieldScope: agent.fieldScope } : {}),
      }
    }
    return { id: `workflow:${wf.slug}`, principalType: 'agent', roles: [] }
  }

  /** The Local-API subset a step gets, every method pinned to the scoped agent `req`.
   *  The caller can never override the principal — `req`/`overrideAccess` from the step's
   *  opts are dropped so it cannot escalate out of its scope or trust itself. */
  function boundLocalApi(req: Partial<RequestContext>): WorkflowLocalApi {
    const pin = <T extends { req?: Partial<RequestContext>; overrideAccess?: boolean }>(opts: T): T => ({
      ...opts,
      req,
      overrideAccess: false,
    })
    return {
      find: (opts) => ops.find(pin(opts)),
      findByID: (opts) => ops.findByID(pin(opts)),
      create: (opts) => ops.create(pin(opts)),
      update: (opts) => ops.update(pin(opts)),
      delete: (opts) => ops.delete(pin(opts)),
      count: (opts) => ops.count(pin(opts)),
      composePage: (opts) => ops.composePage(pin(opts)),
      findVersions: (opts) => ops.findVersions(pin(opts)),
    }
  }

  /** Validate a gate ref against the config (real collection, string id) so a hostile
   *  step can't point a gate at a system table or a prototype-pollution key. */
  function assertRef(ref: WorkflowRef): { collection: CollectionConfig; id: string } {
    const slug = typeof ref?.collection === 'string' ? ref.collection : ''
    if (FORBIDDEN_KEYS.has(slug)) throw new BadRequestError(`Illegal collection "${slug}".`)
    const collection = config.collectionsBySlug[slug]
    if (!collection) throw new BadRequestError(`Unknown collection "${slug}".`)
    const id = typeof ref?.id === 'string' && ref.id.length > 0 ? ref.id : ''
    if (!id) throw new BadRequestError('A gate ref needs a string `id`.')
    return { collection, id }
  }

  /** Persist the run row (create on first write, update thereafter). Trusted path: this
   *  is a system table, never content. */
  async function saveRun(run: WorkflowRun, isNew: boolean): Promise<void> {
    const data: Row = {
      id: run.id,
      slug: run.slug,
      status: run.status,
      trigger: run.trigger,
      steps: run.steps,
      attempts: run.attempts,
      lastError: run.lastError,
    }
    if (isNew) {
      await db.create({ collection: WORKFLOW_RUNS_TABLE, data })
    } else {
      await db.update({ collection: WORKFLOW_RUNS_TABLE, id: run.id, data })
    }
  }

  /** Execute a workflow's steps in order against a fresh run row. Returns the final run. */
  async function execute(wf: WorkflowDefinition, trigger: WorkflowTriggerRecord, input: unknown): Promise<WorkflowRun> {
    const principal = principalFor(wf)
    const req: Partial<RequestContext> = { user: principal }
    const localApi = boundLocalApi(req)

    const run: WorkflowRun = {
      id: randomUUID(),
      slug: wf.slug,
      status: 'running',
      trigger,
      steps: wf.steps.map((s) => ({ name: s.name, status: 'pending' })),
      attempts: 1,
      lastError: null,
    }
    await saveRun(run, true)

    for (let i = 0; i < wf.steps.length; i++) {
      const step = wf.steps[i]!
      const record = run.steps[i]!
      record.status = 'running'
      record.startedAt = new Date().toISOString()
      await saveRun(run, false)

      // The gate helpers + log are rebuilt per step so `ctx.step` and the log target the
      // current step's record. `requestReview` raises a signal the loop catches to pause.
      let paused = false
      const log = (msg: string): void => {
        const lines = (record.log ??= [])
        if (lines.length >= MAX_LOG_LINES) return
        lines.push(String(msg).slice(0, MAX_LOG_LINE_LENGTH))
      }
      const evalGate = async (ref: WorkflowRef): Promise<void> => {
        const { collection, id } = assertRef(ref)
        // Read the to-be-checked doc through the SCOPED principal (drafts included) — a
        // step can only gate a doc it can actually read. Never overrideAccess.
        const doc = await ops.findByID({ collection: collection.slug, id, draft: true, req })
        if (!doc) throw new BadRequestError(`evalGate: document "${collection.slug}/${id}" not found or not readable.`)
        const { blocking } = await runEvals(config.evals, {
          doc: doc as Row,
          collection: collection.slug,
          req: req as RequestContext,
          fields: collection.fields,
        })
        if (blocking.length > 0) {
          const summary = blocking.map((b) => `[${b.rule}] ${b.message}`).join('; ')
          throw new BadRequestError(`evalGate blocked: ${summary}`)
        }
      }
      const requestReview = async (ref: WorkflowRef, note?: string): Promise<void> => {
        const { collection, id } = assertRef(ref)
        // Reuse the existing review inbox: an agent-authored draft becomes a pending queue
        // item. We do NOT submit a decision — only a HUMAN approving via the inbox publishes.
        // record a `request_changes`-shaped pending marker by simply leaving it in the queue;
        // the queue derives "pending" from agent-authorship, which the scoped write provided.
        if (!config.review.enabled) {
          throw new BadRequestError('requestReview requires the review inbox (set `config.review`).')
        }
        const queue = await ops.findReviewQueue({ collection: collection.slug, req })
        const present = queue.docs.some((d) => d.id === id)
        if (!present) {
          // The doc must be an agent-authored draft to be reviewable. If the step never wrote
          // it through the scoped principal, surface a clear error rather than a silent pause.
          throw new BadRequestError(
            `requestReview: "${collection.slug}/${id}" is not an agent-authored draft awaiting review.`,
          )
        }
        if (note) log(`review requested: ${note}`)
        paused = true
        throw new AwaitingReviewSignal()
      }

      const stepCtx: WorkflowContext = {
        kernel: localApi,
        input,
        log,
        step: { name: step.name, index: i },
        evalGate,
        requestReview,
      }

      try {
        await step.run(stepCtx)
        record.status = 'completed'
        record.finishedAt = new Date().toISOString()
        await saveRun(run, false)
      } catch (err) {
        record.finishedAt = new Date().toISOString()
        if (paused && err instanceof AwaitingReviewSignal) {
          // Pause: this step and the run wait for a human decision in the inbox.
          record.status = 'completed'
          run.status = 'awaiting_review'
          await saveRun(run, false)
          await ops.recordAudit({
            action: 'workflow.awaiting_review',
            req: req as RequestContext,
            meta: { workflow: wf.slug, runId: run.id, step: step.name },
          })
          return run
        }
        // A thrown step (including a blocking evalGate) fails the run cleanly. Only the
        // error MESSAGE is recorded — never a stack or payload, so no secret leaks.
        const message = err instanceof Error ? err.message : String(err)
        record.status = 'failed'
        record.error = message
        run.status = 'failed'
        run.lastError = message
        await saveRun(run, false)
        await ops.recordAudit({
          action: 'workflow.failed',
          req: req as RequestContext,
          meta: { workflow: wf.slug, runId: run.id, step: step.name, error: message },
        })
        return run
      }
    }

    run.status = 'completed'
    await saveRun(run, false)
    await ops.recordAudit({
      action: 'workflow.completed',
      req: req as RequestContext,
      meta: { workflow: wf.slug, runId: run.id },
    })
    return run
  }

  async function runWorkflow(opts: RunWorkflowOptions): Promise<WorkflowRun> {
    if (config.workflows.length === 0) throw new BadRequestError('No workflows are configured.')
    const wf = workflowsBySlug.get(opts.slug)
    if (!wf) throw new BadRequestError(`No workflow is registered with slug "${opts.slug}".`)
    const trigger: WorkflowTriggerRecord = { on: 'manual' }
    return execute(wf, trigger, opts.input)
  }

  async function workflowRuns(opts: WorkflowRunsOptions = {}): Promise<{ docs: WorkflowRun[]; count: number }> {
    if (config.workflows.length === 0) return { docs: [], count: 0 }
    const and: Row[] = []
    if (opts.slug) and.push({ slug: { equals: opts.slug } })
    if (opts.status) and.push({ status: { equals: opts.status } })
    const where = and.length > 0 ? { and } : undefined
    const limit = Math.min(Math.max(Math.floor(opts.limit ?? 25), 1), 1000)
    const page = Math.max(Math.floor(opts.page ?? 1), 1)
    const res = await db.find({
      collection: WORKFLOW_RUNS_TABLE,
      ...(where ? { where: where as never } : {}),
      sort: [{ field: 'createdAt', direction: 'desc' }],
      limit,
      page,
    })
    return { docs: res.docs.map(rowToRun), count: res.totalDocs ?? res.docs.length }
  }

  /** The drain handler `runDueJobs` invokes for an enqueued trigger run. The job `input`
   *  carries the workflow slug + trigger record + the trigger document. */
  const drainJobHandler: JobDefinition['handler'] = async ({ input }) => {
    const payload = (input ?? {}) as { slug?: unknown; trigger?: WorkflowTriggerRecord; doc?: unknown }
    const slug = typeof payload.slug === 'string' ? payload.slug : ''
    const wf = workflowsBySlug.get(slug)
    if (!wf) throw new Error(`workflow drain: unknown workflow "${slug}".`)
    const trigger: WorkflowTriggerRecord = payload.trigger ?? { on: 'manual' }
    const run = await execute(wf, trigger, payload.doc)
    return { runId: run.id, status: run.status }
  }

  return { runWorkflow, workflowRuns, drainJobHandler }
}

/**
 * Attach create/update trigger hooks to the collections workflows watch. Each fires an
 * `afterChange` hook that ENQUEUES a durable workflow run via the jobs queue — so the
 * actual (potentially slow) agent steps never block the content write, and a failed run
 * is retryable. System collections are excluded so internal writes can't trigger loops.
 * Mutates the provided collections in place. The jobs queue is the only execution path
 * for triggers; `runDueJobs` (cron) drains them.
 */
export function attachWorkflowTriggers(
  collections: CollectionConfig[],
  workflows: WorkflowDefinition[],
  enqueue: Operations['enqueue'],
  systemSlugs: ReadonlySet<string>,
  logger: Logger,
): void {
  if (workflows.length === 0) return
  const byCollection = new Map<string, { slug: string; on: 'create' | 'update'; agent?: string }[]>()
  for (const wf of workflows) {
    const t = wf.trigger
    if (!t || (t.on !== 'create' && t.on !== 'update') || !t.collection) continue
    if (systemSlugs.has(t.collection)) continue
    const list = byCollection.get(t.collection) ?? []
    list.push({ slug: wf.slug, on: t.on, agent: wf.agent })
    byCollection.set(t.collection, list)
  }

  for (const collection of collections) {
    const triggers = byCollection.get(collection.slug)
    if (!triggers || triggers.length === 0) continue
    const slug = collection.slug
    const hooks = (collection.hooks ??= {})

    const onChange: CollectionAfterChangeHook = async (args) => {
      const event = args.operation as 'create' | 'update'
      const doc = args.doc as Doc
      const writerId = (args.req as { user?: { id?: string } } | undefined)?.user?.id
      for (const wf of triggers) {
        if (wf.on !== event) continue
        // Loop guard: a workflow's own agent writing into its trigger collection must NOT
        // re-fire the same workflow (otherwise an agent draft-create self-sustains an
        // unbounded trigger→job→trigger chain). Other principals still trigger normally.
        if (wf.agent && writerId === wf.agent) continue
        try {
          await enqueue({
            task: WORKFLOW_JOB_TASK,
            input: { slug: wf.slug, trigger: { on: event, collection: slug, documentId: doc.id }, doc },
          })
        } catch (err) {
          // A failed enqueue must never break or roll back the content write that fired it.
          logger.warn(`workflow trigger ${wf.slug} (${event} ${slug}) could not enqueue`, err)
        }
      }
      return args.doc
    }
    hooks.afterChange = [...(hooks.afterChange ?? []), onChange]
  }
}
