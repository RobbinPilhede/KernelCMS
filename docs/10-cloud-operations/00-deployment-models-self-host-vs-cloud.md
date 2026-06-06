# Deployment Models: Self-Host vs Cloud

KernelCMS runs in exactly two shapes — you self-host the open-source core on your own infrastructure, or you run on KernelCMS Cloud, a managed multi-tenant platform. Both execute the same `@kernel/server` build against the same `kernel.config.ts`. There is no "community edition" with a crippled feature set and no proprietary fork you graduate to. The runtime is identical; what differs is who operates the database, storage, and the box. This page explains the two models, the hybrid arrangement that sits between them, and the data-ownership guarantees that make moving between them a non-event.

## The Single Runtime Principle

Most CMS vendors maintain a hard seam between their hosted product and the thing you download. Sanity is hosted-only at the data layer — your content lives in their Content Lake whether you like it or not, and "self-hosting" is not an option for the datastore. Strapi Cloud and self-hosted Strapi are the same binary but the Cloud control plane is closed. Payload is self-host-first and only recently added a hosted offering; the two paths diverge in tooling.

KernelCMS treats the deployment target as a configuration concern, not a product tier. The `kernel.config.ts` you write locally is the same file that ships to Cloud. Adapters — database, storage, email, auth, search, cache, queue — are swappable in both models. Cloud simply pre-selects and operates a default set of adapters for you.

```
                 kernel.config.ts  (one source of truth)
                          │
            ┌─────────────┴─────────────┐
            ▼                           ▼
      Self-Host                   KernelCMS Cloud
   @kernel/server on            managed @kernel/server
   your Node/Bun/edge           + control plane, billing,
   + your adapters              CDN, backups, observability
```

## Self-Host: Own Everything

Self-hosting means you run `@kernel/server` as a long-lived process (or edge bundle) and you own every dependency it touches. You pick the database adapter, you pick where uploads land, you decide how email goes out. KernelCMS ships first-party adapters — `@kernel/db-postgres` (default), `@kernel/db-sqlite`, `@kernel/db-mysql`, `@kernel/db-mongodb`, and `@kernel/storage` — but the `Adapter` contract is public, so a bespoke adapter is a supported path, not a hack.

A representative self-host config:

```ts
// kernel.config.ts
import { defineConfig } from '@kernel/core'
import { postgresAdapter } from '@kernel/db-postgres'
import { s3Storage } from '@kernel/storage'
import { Posts, Media } from './collections'
import { SiteSettings } from './globals'

export default defineConfig({
  serverURL: process.env.KERNEL_SERVER_URL,
  db: postgresAdapter({
    connectionString: process.env.DATABASE_URL,
    // Drizzle is the default SQL ORM; migrations are diffed from schema
    migrations: { dir: './migrations' },
  }),
  storage: s3Storage({
    bucket: process.env.S3_BUCKET,
    region: process.env.S3_REGION,
    // credentials resolved from the host's IAM role, never hardcoded
  }),
  collections: [Posts, Media],
  globals: [SiteSettings],
})
```

Deployment targets are deliberately broad. The server runs on Node, Bun, or edge runtimes, and ships as a Docker image, a Compose stack, or a Kubernetes Deployment. A minimal Compose topology:

```
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│ @kernel/server│──│  Postgres    │   │  S3 / MinIO  │
│ (Node or Bun) │   │  (Drizzle)   │   │  (uploads)   │
└──────┬───────┘   └──────────────┘   └──────────────┘
       │ admin (TanStack Start SSR) + REST + GraphQL + RPC
       ▼
   reverse proxy / TLS
```

What you own — and therefore what you operate — in self-host:

| Concern            | Who runs it (self-host) | First-party help                              |
| ------------------ | ----------------------- | --------------------------------------------- |
| Database           | You                     | `@kernel/db-*` adapters, generated migrations |
| File storage / CDN | You                     | `@kernel/storage` (S3, local, custom)         |
| TLS / ingress      | You                     | Docker/K8s recipes                            |
| Backups            | You                     | `kernel db dump` / restore commands           |
| Scaling            | You                     | stateless server; scale horizontally          |
| Observability      | You                     | structured logs, OpenTelemetry hooks          |
| Upgrades           | You                     | semver-pinned `@kernel/*` packages            |

Self-host is the right call when data residency is contractual, when you already run a platform team, or when the content lives behind a VPC next to services that must read it directly via the Local API. The trade is operational: every box in that table is now your pager.

See [Self-Hosting with Docker](./02-self-hosting-guide-docker-and-k8s.md) and [Kubernetes Deployment](./02-self-hosting-guide-docker-and-k8s.md) for the concrete recipes.

## Managed Cloud: Sanity-Style

KernelCMS Cloud is the managed counterpart — multi-tenant hosting where we operate the runtime, the database, storage, the global content CDN, backups, billing, and observability. The mental model is Sanity's hosted Content Lake, but with two differences that matter: the content is stored in a standard Postgres schema you can export at any time, and the API surface (REST, GraphQL, RPC) is byte-for-byte the same one your self-hosted peers run.

You do not write a different config for Cloud. You attach a Cloud project and let it manage the infrastructure adapters:

```ts
// kernel.config.ts — Cloud-targeted
import { defineConfig } from '@kernel/core'
import { cloud } from '@kernel/cloud'
import { Posts, Media } from './collections'

export default defineConfig({
  // Cloud provisions db + storage + cache + queue; no adapter wiring needed
  ...cloud({
    project: 'acme-marketing',
    region: 'eu-west',
    // escape hatch: override any managed adapter if you must
    overrides: {
      /* db, storage, search ... */
    },
  }),
  collections: [Posts, Media],
})
```

What Cloud operates so you don't:

| Concern       | KernelCMS Cloud                                   |
| ------------- | ------------------------------------------------- |
| Database      | Managed Postgres, point-in-time recovery          |
| Storage + CDN | Global content CDN, signed URLs, image transforms |
| Scaling       | Autoscaled, multi-tenant isolation                |
| Backups       | Automated, retained, restorable per-project       |
| Observability | Built-in metrics, traces, request logs            |
| Billing       | Usage-based, per-project                          |
| Upgrades      | Rolling, version-pinned per project               |

Cloud wins where Sanity and Strapi Cloud win — you ship content models, not infrastructure — but without the lock-in tax. Because the storage layer is plain Postgres + object storage rather than a proprietary lake, the [Local API](../05-api/03-typed-rpc-and-local-api.md) and the typed RPC client (`@kernel/client`) behave identically whether they hit a Cloud endpoint or a container you run. Strapi Cloud, by contrast, exposes a managed control plane you cannot reproduce locally; Cloud's control plane is operational sugar, never a gate on your data.

## The Hybrid Model

Most teams do not live at either pole. The hybrid model splits the responsibility along the seams the adapter system already exposes. You run `@kernel/server` yourself but delegate specific infrastructure concerns to Cloud-managed adapters — or you run on Cloud but pin certain adapters back to your own infrastructure via `overrides`.

Two common shapes:

**Self-host the server, lean on Cloud for the hard parts.** Keep the runtime in your VPC for the Local API and network locality, but point storage and search at Cloud-managed adapters so you skip operating a CDN and a search cluster.

```ts
export default defineConfig({
  db: postgresAdapter({ connectionString: process.env.DATABASE_URL }), // yours
  storage: cloud.storage({ project: 'acme-marketing' }), // managed CDN
  search: cloud.search({ project: 'acme-marketing' }), // managed search
  collections: [Posts, Media],
})
```

**Run on Cloud, keep the database at home.** Data-residency rules sometimes forbid content leaving a jurisdiction. Cloud runs the server and CDN; the `db` adapter points at your own Postgres over a private link.

```ts
export default defineConfig({
  ...cloud({ project: 'acme-marketing', region: 'eu-west' }),
  // override the managed DB with your residency-bound Postgres
  db: postgresAdapter({ connectionString: process.env.PRIVATE_DB_URL }),
})
```

```
   Hybrid (residency-pinned DB)
   ┌────────────── KernelCMS Cloud ──────────────┐
   │  @kernel/server  ·  CDN  ·  search  ·  queue │
   └───────────────────────┬─────────────────────┘
                           │ private link
                           ▼
                 your Postgres (in-jurisdiction)
```

Hybrid is viable precisely because every infrastructure concern is an independent adapter behind one contract. No competitor offers this granularity — Sanity gives you their lake or nothing; Strapi gives you their box or your box, not a per-concern split.

## Data Ownership and Portability

Portability is the load-bearing promise: content and config move between self-host and Cloud, in either direction, without transformation. This is enforced, not aspirational.

- **Config is code.** `kernel.config.ts` is committed to your repository in every model. Cloud reads the same file; it never owns your schema.
- **Content is a standard schema.** SQL backends use Drizzle-generated Postgres/MySQL/SQLite tables; the MongoDB adapter uses plain collections. There is no proprietary on-disk format to reverse-engineer, unlike Sanity's Content Lake.
- **Migrations are portable.** They are diffed from your schema and live in your repo, so the same migration set applies on Cloud or on your own database.

The CLI makes the move concrete and symmetric:

```bash
# Self-host -> Cloud
kernel export --out ./snapshot           # content + media manifest, no proprietary wrapper
kernel cloud import ./snapshot --project acme-marketing

# Cloud -> Self-host
kernel cloud export --project acme-marketing --out ./snapshot
kernel import ./snapshot --db "$DATABASE_URL"
```

An export is a content snapshot plus a media manifest, not an opaque blob. You can read it, diff it, and load it into a database we never touch. There is no API key that, once revoked, strands your content — the canonical copy is always something you can hold.

| Guarantee                | Self-Host | Cloud | Hybrid |
| ------------------------ | --------- | ----- | ------ |
| Config in your repo      | Yes       | Yes   | Yes    |
| Open content schema      | Yes       | Yes   | Yes    |
| One-command export       | Yes       | Yes   | Yes    |
| Switch model, no rewrite | Yes       | Yes   | Yes    |

See [Migrating Between Models](./02-self-hosting-guide-docker-and-k8s.md) and [Backups and Recovery](./06-backups-and-disaster-recovery.md) for operational detail.

## Open Questions

- **Hybrid billing granularity.** When only storage and search are Cloud-managed, billing should meter those adapters in isolation. The per-adapter metering boundary is not yet finalized.
- **Private-link DB latency budget.** A residency-pinned database behind a private link adds round-trips to every operation. We need a published latency budget and a documented degradation mode before recommending it for write-heavy workloads.
- **Cross-region content sync on Cloud.** Whether multi-region Cloud projects get active-active content replication or remain single-write-region with CDN read replicas is undecided.
