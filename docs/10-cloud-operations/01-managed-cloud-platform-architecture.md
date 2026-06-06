# Managed Cloud Platform Architecture

KernelCMS Cloud is the managed runtime that hosts KernelCMS for teams that don't want to operate Postgres, object storage, queues, and an SSR admin app themselves. It runs the exact same open-source core (`@kernel/core`, `@kernel/server`, `@kernel/admin`) you'd self-host — there is no proprietary fork — wrapped in a control plane that provisions, isolates, scales, and observes per-project runtimes. Sanity ships a hosted-only content lake with no portable self-host story; Payload and Strapi ship self-host-first with bolt-on cloud offerings. KernelCMS Cloud is deliberately a _deployment target_, not a different product: the same `kernel.config.ts` that boots `localhost:3000` boots a Cloud project, and content plus config are portable in both directions.

## Control plane versus data plane

The hard architectural line in the platform is between the **control plane** (multi-tenant, KernelCMS-operated, manages _projects_) and the **data plane** (per-tenant runtimes that actually serve content). They share no request path. A control-plane outage must never take down a customer's live API; a data-plane incident in one project must never leak into another.

```
                        ┌──────────────────────── CONTROL PLANE (KernelCMS-operated) ────────────────────────┐
   dashboard.kernel.sh  │  ┌──────────┐   ┌────────────┐   ┌─────────────┐   ┌──────────┐   ┌─────────────┐  │
   ───────────────────► │  │ Identity │   │ Provisioner│   │  Billing    │   │ Metrics  │   │ Config/IaC  │  │
   kernel CLI / RPC     │  │  & RBAC  │   │ (Temporal) │   │  (Stripe)   │   │ pipeline │   │  registry   │  │
                        │  └──────────┘   └─────┬──────┘   └─────────────┘   └────▲─────┘   └─────────────┘  │
                        └───────────────────────┼──────────────────────────────────┼──────────────────────┘
                                  provision/scale│ (async, eventually consistent)   │ telemetry
                        ┌───────────────────────▼──────────────────────────────────┼──────────────────────┐
   {project}.kernel.sh  │   DATA PLANE (per-project runtimes)                       │                      │
   ───────────────────► │   ┌─────────────┐  ┌─────────────┐   ┌──────────────┐   ┌┴─────────────┐         │
   REST / GraphQL / RPC │   │ Admin (SSR) │  │ API host    │   │ Job workers  │   │ Postgres +   │         │
                        │   │ @kernel/    │  │ @kernel/    │   │ (@kernel/    │   │ object store │         │
                        │   │   admin     │  │   server    │   │  queue)      │   │ + search     │         │
                        │   └─────────────┘  └─────────────┘   └──────────────┘   └──────────────┘         │
                        └───────────────────────────────────────────────────────────────────────────────┘
```

The **control plane** is the only multi-tenant code we run. It owns the global project registry, identity, RBAC, billing, the provisioning workflow engine, and the metrics/log ingestion pipeline. It is the system of record for _which projects exist_, _who can touch them_, and _what plan they're on_. It never reads or writes customer content.

The **data plane** is N independent KernelCMS runtimes. Each is a normal `@kernel/server` process (or fleet) serving REST/GraphQL/RPC plus an `@kernel/admin` SSR app on TanStack Start, backed by that project's own database, storage bucket, and search index. The data plane treats the control plane as an external authority for identity and config; it degrades gracefully if the control plane is unavailable (cached JWKS, last-known config), so content keeps serving.

| Property                  | Control plane                    | Data plane                               |
| ------------------------- | -------------------------------- | ---------------------------------------- |
| Tenancy                   | Multi-tenant                     | Single-project                           |
| System of record for      | Projects, users, billing, config | Content, media, versions                 |
| Availability target       | 99.95%                           | 99.9% per project (99.99% on enterprise) |
| Failure blast radius      | Provisioning/dashboard paused    | One project                              |
| Talks to customer content | Never                            | Always                                   |
| Deploy cadence            | Continuous                       | Pinned per project, gated rollouts       |

This split is what lets us pin a project to a specific KernelCMS version. Strapi Cloud and Sanity push platform changes on their schedule; a Cloud project declares its core version in config and the control plane orchestrates the upgrade as an explicit, reversible migration (see Versioning & upgrades).

## Project provisioning

A _project_ is the unit of provisioning: one `kernel.config.ts`, one database, one bucket, one set of domains, one runtime fleet. Provisioning is driven by the control-plane **Provisioner**, a Temporal-based durable workflow. We use durable workflows rather than imperative scripts because provisioning spans minutes, touches half a dozen external systems, and must be resumable and idempotent — a half-created project with a dangling bucket and no DB is the worst outcome.

The platform inspects the project's committed config to decide what to allocate. The adapter contract from the open-source core (`database`, `storage`, `search`, `email`, `queue`, `cache`) maps directly onto Cloud-managed services:

```ts
// kernel.config.ts — a project targeting KernelCMS Cloud
import { defineConfig } from '@kernel/core'
import { cloud } from '@kernel/cloud'

export default defineConfig({
  // On Cloud, adapters resolve to managed services via the `cloud()` preset.
  // The identical config self-hosts by swapping these for postgres()/s3()/etc.
  ...cloud({
    region: 'eu-central',
    plan: 'team',
    database: { engine: 'postgres', tier: 'standard' }, // Drizzle/Postgres, default
    storage: { cdn: true },
    search: { engine: 'managed' },
  }),
  collections: [Posts, Media, Authors],
  globals: [SiteSettings],
})
```

The provisioning workflow, as durable steps:

```ts
// control-plane/workflows/provisionProject.ts (illustrative)
export async function provisionProject(input: ProvisionInput): Promise<ProjectHandle> {
  const project = await steps.registerProject(input) // 1. reserve slug, write registry row
  const db = await steps.allocateDatabase(project) // 2. create isolated Postgres database/role
  const bucket = await steps.allocateStorage(project) // 3. create bucket + scoped credentials
  const search = await steps.allocateSearchIndex(project) // 4. namespaced search index
  await steps.runMigrations(project, db) // 5. drizzle migrations from schema diff
  await steps.deployRuntime(project, { db, bucket, search }) // 6. schedule data-plane fleet
  await steps.bindDomains(project) // 7. {slug}.kernel.sh + custom domains, ACME certs
  await steps.seedOwner(project, input.owner) // 8. first admin user + access policy
  return steps.markReady(project) // 9. flip status → ready, emit webhook
}
```

Every step is idempotent and compensatable: if `deployRuntime` fails, the workflow's compensation handlers tear down the bucket, search index, and database so we never leak orphaned infrastructure. The same workflow powers preview environments — a branch deploy clones config and runs migrations against a fresh database, mirroring how Payload Cloud does ephemeral environments, but with the full adapter set (search, queue, cache) reproduced, not just the DB.

`create-kernel` and the `kernel` CLI both drive provisioning over the typed RPC surface:

```bash
kernel cloud init            # links local kernel.config.ts to a Cloud project
kernel cloud deploy          # pushes config, runs migrations, rolls the fleet
kernel cloud env create pr-42 --from main   # ephemeral preview env
```

## Tenant isolation

KernelCMS Cloud uses **database-per-project** isolation as the default, not a shared schema with a `tenant_id` column. This is a deliberate divergence from the cheaper pooled model and the right call for a CMS: customer content is the asset, schemas differ per project (config-as-code means every project's tables are shaped by its collections), and noisy-neighbor risk on a content API is real. Sanity solves this with a proprietary document store; we solve it with boring, portable Postgres databases that a customer can `pg_dump` and walk away with.

Isolation is enforced at four layers:

| Layer    | Mechanism                                                                                       | Guarantee                                                                   |
| -------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Storage  | One Postgres database + dedicated role per project; bucket prefix + scoped IAM creds            | No cross-project query is _expressible_ — credentials only see one database |
| Compute  | Per-project runtime fleet; pooled only on the free/hobby tier with strict cgroup quotas         | CPU/memory noisy-neighbor bounded; paid tiers fully dedicated               |
| Network  | Per-project egress identity; data-plane pods cannot reach the control-plane DB                  | Lateral movement blocked                                                    |
| Identity | Project-scoped JWTs; control plane signs, data plane verifies issuer + audience + project claim | A token minted for project A is rejected by project B                       |

```ts
// Every data-plane request carries a project-scoped claim.
// @kernel/server rejects tokens whose `prj` claim ≠ the runtime's bound project.
type ProjectClaim = {
  sub: string // user id
  prj: string // project id — bound at provision time, verified per request
  aud: 'kernel-cloud'
  scopes: string[] // maps to @kernel/core access control evaluation
}
```

Access control inside a project is unchanged from self-host: the operation-, document-, and field-level policies in `@kernel/core` run identically. Cloud adds the _outer_ boundary — making sure request traffic, credentials, and data for project A can never address project B — and leaves the _inner_ boundary (who can edit which document) to the open-source access engine. Free-tier projects share a runtime to keep costs sane, but never share a database; the moment a project upgrades, the Provisioner migrates it to dedicated compute without changing its data.

## Platform services

Around each project runtime, the control plane operates shared platform services that customers don't have to assemble themselves. These are the operational concerns the brief calls out — billing, observability, backups, and a global content CDN — implemented as control-plane systems that _attach_ to data-plane projects.

- **Global content CDN.** Read traffic to REST/GraphQL and media is fronted by an edge CDN keyed per project. Cache invalidation is event-driven: on publish, `@kernel/core` emits a document event, the data plane purges affected tags (`collection:posts`, `doc:{id}`), and the edge serves fresh content within seconds. This is the managed equivalent of wiring your own CDN in self-host, with surrogate-key purging built in.
- **Observability.** Every runtime ships structured logs, RED metrics (rate/errors/duration per operation), and OpenTelemetry traces to the control-plane metrics pipeline. Customers see per-project dashboards (p95 latency, error rate, slow queries, queue depth) without standing up Grafana. Alerts route to the project's notification channels.
- **Backups & PITR.** Each project database runs continuous WAL archiving with point-in-time recovery; nightly logical `pg_dump` snapshots are retained per the plan's policy and are restorable into a fresh preview environment. Media buckets are versioned. Because everything is portable Postgres + object storage, "export my project" is a first-class operation, not a support ticket — the anti-Sanity guarantee.
- **Billing & metering.** Usage (bandwidth, storage, compute-hours, API requests) is metered from the metrics pipeline and reconciled into Stripe by the Billing service. Plan limits are enforced in the control plane (provisioning gates) and surfaced as soft warnings before hard caps, so a traffic spike throttles rather than silently fails.
- **Queue & jobs.** The `@kernel/queue` adapter resolves to a managed queue; scheduled tasks (autosave compaction, version pruning, webhook delivery, search reindex) run on per-project job workers, isolated from request-serving compute.

See Tenant isolation deep dive, [Billing & metering](./04-billing-metering-and-plans.md), and [Backups & recovery](./06-backups-and-disaster-recovery.md) for the implementation specifics of each service.

## Open questions

- **Free-tier compute model.** Pooled runtime with cgroup quotas vs. scale-to-zero per-project containers — the trade-off is cold-start latency vs. per-tenant cost. Leaning scale-to-zero if cold starts stay under 800ms.
- **Region pinning vs. data residency tiers.** Whether `region` is a hard data-residency guarantee (enterprise contractual) or a best-effort placement on standard plans.
- **Control-plane DB for config.** Whether project config lives only in Git (pulled at deploy) or is also mirrored in the control-plane registry for dashboard editing without a redeploy.
- **Bring-your-own-cloud.** Running the data plane in a customer's own VPC while the control plane stays KernelCMS-operated — demanded by enterprise, but complicates the provisioning and observability pipelines.
