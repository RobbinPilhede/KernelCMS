# Agentic workflows

Hand a job to an AI agent and let it run a multi-step content pipeline — ideation,
draft, quality gate, human review — without it ever being able to push something
live. This is the *agentic CMS*: autonomous content pipelines with hard guardrails
baked into the engine.

A workflow is orchestration plus guardrails. KernelCMS schedules the steps, pins
every operation to a scoped agent principal, records a durable run log, and gates
content advancement on quality checks and human approval. The actual generation —
the LLM call that writes the draft — is **your** code inside a step. KernelCMS does
not call a model for you; it makes sure that whatever the model produces cannot go
live unchecked.

Workflows build on four existing pieces: agent principals (the scoped, draft-only
caller — see the README's auth section), the review inbox, content-CI `evals`, and
the background jobs system.

## The concept: autonomous, but governed

A normal automation runs as a trusted system caller — it can write anything,
publish anything. That is exactly what you do **not** want when an LLM is in the
loop. A KernelCMS workflow inverts it:

- Every step runs as the workflow's scoped **agent**, never as a system caller.
  The agent's `fieldScope` and its hard draft-only brake apply to every step.
- The agent physically **cannot publish** and **cannot write outside its
  `fieldScope`**. There is no `overrideAccess` anywhere on the workflow path.
- Content moves forward **only** through two explicit gates: `evalGate` (your
  quality CI) and `requestReview` (a human approving in the inbox).

So the agent is free to draft, revise, and shuffle drafts around all day. Nothing
it touches reaches the public read path until your evals pass *and* a human says
yes.

## Defining a workflow

Workflows live on your config under `workflows`. A `WorkflowDefinition` names a
`slug` (snake_case), the `agent` to run as, an optional `trigger`, and the ordered
`steps`:

```ts
export default defineConfig({
  agents: [
    {
      id: 'writer',
      token: process.env.WRITER_TOKEN,            // bearer credential, from env
      roles: ['editor'],
      fieldScope: { allow: ['title', 'body', 'excerpt'] }, // deny-by-default
    },
  ],
  workflows: [
    {
      slug: 'draft_from_brief',
      agent: 'writer',                            // every step runs as this principal
      trigger: { on: 'create', collection: 'briefs' },
      maxAttempts: 3,                             // retry budget for a failing run
      steps: [
        {
          name: 'draft',
          async run(ctx) {
            // ctx.input is the brief that triggered the run.
            const body = await generateWithYourLLM(ctx.input.brief)

            // A DRAFT — the agent principal cannot create a published doc.
            const post = await ctx.kernel.create({
              collection: 'posts',
              data: { title: ctx.input.title, body },
            })
            ctx.log(`drafted post ${post.id}`)

            // Quality CI. Runs the collection's evals; THROWS → the run fails.
            await ctx.evalGate({ collection: 'posts', id: post.id })

            // Pause the run as `awaiting_review`; a human approves in the inbox.
            await ctx.requestReview({ collection: 'posts', id: post.id }, 'ready for review')
          },
        },
      ],
    },
  ],
})
```

That single workflow is a complete pipeline: a new `brief` fires it, the agent
drafts a `posts` document, the draft must pass your evals, and then it parks in the
review inbox for a human. At no point could the agent publish.

| Field         | Meaning                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------- |
| `slug`        | snake_case identifier; used by `runWorkflow`, the REST route, and the run log.           |
| `agent`       | id of a configured agent. Its `fieldScope` + draft-only brake apply to **every** step.   |
| `trigger`     | `{ on: 'create' \| 'update' \| 'manual', collection? }`. Omit / `manual` → run-only.     |
| `steps`       | ordered `WorkflowStep[]`; each is `{ name, run(ctx) }`, run inline in order.              |
| `maxAttempts` | optional retry budget for a run that fails.                                               |

## The WorkflowContext (`ctx`)

Each step's `run(ctx)` receives a `WorkflowContext`:

- **`ctx.kernel`** — a Local-API subset (`find`, `findByID`, `create`, `update`,
  `delete`, `count`, `composePage`, `findVersions`) where **every call is pinned to
  the scoped agent principal**. A step cannot pass `overrideAccess` and cannot swap
  in a different principal. This is the only data handle a step gets, and it is the
  same access pipeline a human or REST client goes through.
- **`ctx.input`** — the trigger document on a `create` / `update` run, or the manual
  input passed to `runWorkflow` / the route.
- **`ctx.log(msg)`** — append a line to the run log for this step.
- **`ctx.step`** — `{ name, index }` for the currently executing step.

### The two gates

Content advancement is not something a step does by writing data. It happens only
through these two awaited calls:

```ts
// Quality CI: runs the collection's configured `evals` against the doc.
// A blocking eval failure THROWS, which fails the run — the draft does not advance.
await ctx.evalGate({ collection: 'posts', id })

// Submits the doc to the review inbox and PAUSES the run as `awaiting_review`.
await ctx.requestReview({ collection: 'posts', id }, 'optional note for the reviewer')
```

`evalGate` is your automated quality bar — the same content-CI evals you run
elsewhere, invoked inline. `requestReview` is the human handoff. The workflow engine
does **not** block-wait for a person: it pauses the run as `awaiting_review` and
returns. The human then approves the doc in the inbox, and **that** inbox-approval
path is what publishes it. The workflow's job is to get a vetted draft in front of a
human, not to sit and spin until they click.

## Triggers vs. manual, and durable execution

There are two ways a workflow runs, and they execute differently.

**Triggered runs** (`on: 'create'` / `on: 'update'`) enqueue a **durable** run onto
the background jobs queue when a matching document is written. They do **not** run
inline with the content write — a slow agent step (an LLM call can take seconds)
must never block the editor saving a document. The queued run is drained by your
jobs runner:

```bash
kernel jobs:run        # drain due jobs once (drive it from a cron)
```

or `runDueJobs(...)` from server code. Set `trigger.collection` to scope a trigger
to one collection.

**Manual runs** (`on: 'manual'`, or no trigger) never fire on a write. You start
them explicitly:

```ts
const run = await kernel.runWorkflow({ slug: 'draft_from_brief', input, req })
```

`runWorkflow` executes the steps **inline** and returns the resulting `WorkflowRun`.
Use it for on-demand pipelines, scripts, and tests.

> Self-triggering loops are guarded. An agent's own write into its trigger
> collection will **not** re-fire its workflow, so a "draft → trigger → draft …"
> loop cannot run away.

## The run log and REST routes

Every run is durable and inspectable. `_workflow_runs` records the run plus
per-step status and errors. Errors are stored as **messages only** — never stack
traces, never secrets.

```ts
// The durable run log, filtered:
const { docs } = await kernel.workflowRuns({
  slug: 'draft_from_brief',
  status: 'awaiting_review',
  limit: 20,
  page: 1,
})
```

The same surface is exposed over REST, gated to admin/editor callers:

```http
GET  /api/_admin/workflow-runs?slug=draft_from_brief&status=awaiting_review
POST /api/_admin/workflows/draft_from_brief/run
```

The `run` route is the HTTP equivalent of `runWorkflow` — it executes a manual run
(or kicks one for a manual workflow) and returns the run.

Decisions are recorded for audit on every outcome:
`workflow.completed`, `workflow.failed`, and `workflow.awaiting_review`.

## The run-state machine

A run moves through a small, explicit set of states:

```text
pending → running → completed
                 ├→ failed
                 └→ awaiting_review
```

- **`pending`** — enqueued (a triggered run waiting for the jobs runner).
- **`running`** — steps are executing.
- **`completed`** — every step finished without a gate pausing or failing it.
- **`failed`** — a step threw (including a blocking `evalGate`). The per-step error
  message is recorded; `maxAttempts` governs retries.
- **`awaiting_review`** — a step called `requestReview` and parked the run. The doc
  is in the inbox; a human approval (which publishes) closes the loop outside the
  workflow.

## The guardrail guarantees

These hold because they are enforced by `@kernel/core`, not by the workflow code you
write:

- **Scoped principal.** Every step runs as the workflow's agent. `ctx.kernel` is
  pinned to that principal — a step cannot set `overrideAccess` or swap principals.
- **Draft-only.** The agent physically cannot publish: a born-published create, a
  `_status: 'published'` write, a `publish()`, or scheduling are all rejected for an
  agent principal. Publishing stays a human decision.
- **Field-scoped.** Writes are limited to the agent's `fieldScope.allow`
  (deny-by-default). An agent scoped to `['title', 'body']` cannot touch `roles` no
  matter what a step tries to write.
- **Gates are the only advancement.** A draft reaches the public read path only
  after `evalGate` passes **and** a human approves the `requestReview` in the inbox.
  KernelCMS provides the orchestration and the guardrails; the generation is your
  agent/LLM, and the publish is the human's inbox approval.
- **Loop-guarded.** An agent's own write into its trigger collection will not
  re-fire the workflow.

The net effect: you can point a capable, autonomous agent at your content and trust
that nothing it produces goes live unchecked.
