# Self-Hosting: Docker & Kubernetes

KernelCMS ships as a single Node/Bun-compatible server image plus a set of swappable adapters, so self-hosting is mostly a question of wiring infrastructure to `kernel.config.ts` and supplying secrets. This guide covers the official Docker image, a production Compose stack, the Kubernetes deployment with the `kernel` Helm chart, how config and secrets flow through the adapter layer, and a zero-surprise upgrade procedure. For the managed alternative, see KernelCMS Cloud; content and config are portable between the two, so nothing here locks you in.

## The Docker Image

The image is built from your project, not pulled pre-baked. KernelCMS is config-as-code: your `kernel.config.ts`, collections, globals, and any custom field types are part of the build. `create-kernel` scaffolds a multi-stage `Dockerfile` that compiles the admin app (TanStack Start SSR bundle) and the server, then ships a slim runtime layer.

```dockerfile
# Stage 1 — build admin + server bundles
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-lock.yaml package.json ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile
RUN pnpm kernel build          # emits .kernel/ (server) + dist/ (admin SSR)

# Stage 2 — runtime
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system kernel && adduser --system --ingroup kernel kernel
COPY --from=build --chown=kernel:kernel /app/.kernel ./.kernel
COPY --from=build --chown=kernel:kernel /app/node_modules ./node_modules
COPY --from=build --chown=kernel:kernel /app/package.json ./
USER kernel
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s \
  CMD node .kernel/healthcheck.js
CMD ["pnpm", "kernel", "start"]
```

Design choices that matter:

- **Runs as non-root.** The runtime stage drops to an unprivileged `kernel` user. Strapi's default Dockerfile historically ran as root; we don't.
- **Health endpoint is first-class.** `kernel start` mounts `/_kernel/health` (liveness) and `/_kernel/ready` (readiness — verifies the active DB adapter answers `SELECT 1` and the storage adapter responds). The bundled `healthcheck.js` hits readiness so orchestrators never route traffic to a pod whose Postgres connection is still cold.
- **Bun is a supported runtime.** Swap the base image to `oven/bun:1` and the `CMD` to `bun kernel start`. The server core is runtime-agnostic; only the adapters that touch native drivers (e.g. `@kernel/db-postgres`) need a compatible build, which we publish for both.
- **The image is stateless.** No uploads, no SQLite file, no cache live inside it. That is enforced by the adapter contract, not convention — see config below.

Published tags follow `ghcr.io/kernelcms/kernel:<version>` with `:<major>.<minor>` floating tags. Pin the full version in production; never deploy `:latest`.

## A Compose Stack

Compose is the right tool for a single-host deployment, a staging box, or local parity with production. The canonical stack is the server, Postgres (via `@kernel/db-postgres`, the default), and Redis for the cache and queue adapters.

```yaml
# compose.yaml
services:
  kernel:
    build: .
    restart: unless-stopped
    ports: ["3000:3000"]
    environment:
      KERNEL_DATABASE_URL: postgres://kernel:${DB_PASSWORD}@db:5432/kernel
      KERNEL_REDIS_URL: redis://cache:6379
      KERNEL_SECRET: ${KERNEL_SECRET}
      KERNEL_S3_BUCKET: ${S3_BUCKET}
      KERNEL_S3_REGION: ${S3_REGION}
      KERNEL_S3_ACCESS_KEY_ID: ${S3_ACCESS_KEY_ID}
      KERNEL_S3_SECRET_ACCESS_KEY: ${S3_SECRET_ACCESS_KEY}
    depends_on:
      db: { condition: service_healthy }
      cache: { condition: service_started }

  db:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: kernel
      POSTGRES_PASSWORD: ${DB_PASSWORD}
      POSTGRES_DB: kernel
    volumes: ["pgdata:/var/lib/postgresql/data"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U kernel"]
      interval: 10s
      timeout: 3s
      retries: 5

  cache:
    image: redis:7-alpine
    restart: unless-stopped
    command: ["redis-server", "--maxmemory", "256mb", "--maxmemory-policy", "allkeys-lru"]

volumes:
  pgdata:
```

```
            ┌──────────────┐        ┌────────────┐
   :3000 ── │   kernel     │ ──SQL─ │  postgres  │ ─ pgdata vol
            │ (Start SSR + │        └────────────┘
            │  API host)   │ ──────► S3 (uploads, external)
            └──────┬───────┘        ┌────────────┐
                   └────cache/queue─│   redis    │
                                    └────────────┘
```

Note that uploads go to S3, not a host volume. You *can* mount a volume and use the local filesystem storage adapter for a hobby deploy, but for anything you care about, keep the container stateless and let object storage hold media. This is the same posture Payload pushes you toward with its S3 plugin; the difference is that in KernelCMS storage is a core adapter, not a bolt-on. Run migrations as a one-shot before starting traffic:

```bash
docker compose run --rm kernel pnpm kernel migrate
docker compose up -d
```

## Kubernetes & Helm

For multi-replica, autoscaled deployments, use the `kernel` Helm chart (`oci://ghcr.io/kernelcms/charts/kernel`). The admin app and API host are the same process, so you scale one Deployment. Because the server is stateless, horizontal scaling is trivial — all shared state lives in the DB, the cache adapter, and object storage.

```yaml
# values.yaml
image:
  repository: ghcr.io/kernelcms/kernel
  tag: "1.8.2"          # pin exactly

replicaCount: 3

env:
  KERNEL_DATABASE_URL:
    valueFrom: { secretKeyRef: { name: kernel-secrets, key: database-url } }
  KERNEL_REDIS_URL:
    value: redis://kernel-redis-master:6379
  KERNEL_SECRET:
    valueFrom: { secretKeyRef: { name: kernel-secrets, key: app-secret } }

migrations:
  enabled: true          # runs `kernel migrate` as a pre-upgrade Job + Helm hook

probes:
  liveness:  { path: /_kernel/health, initialDelaySeconds: 20 }
  readiness: { path: /_kernel/ready,  initialDelaySeconds: 10 }

autoscaling:
  enabled: true
  minReplicas: 3
  maxReplicas: 12
  targetCPUUtilizationPercentage: 70

podDisruptionBudget:
  minAvailable: 2
```

```
            ┌─────────────────── Ingress (TLS) ───────────────────┐
            ▼                                                      ▼
     ┌────────────┐   ┌────────────┐   ┌────────────┐       /admin + /api
     │ kernel pod │   │ kernel pod │   │ kernel pod │   (Service, ClusterIP)
     └─────┬──────┘   └─────┬──────┘   └─────┬──────┘
           └────────────────┼────────────────┘
                ┌───────────┴───────────┐
                ▼                       ▼
        Postgres (managed/             Redis (cache + queue
        StatefulSet)                   adapters)
                                       S3 (external) — uploads
```

The chart ships a pre-upgrade `Job` that runs `kernel migrate` as a Helm `pre-upgrade` hook with `hook-weight` ordering, so schema changes apply before the new pods roll. The `PodDisruptionBudget` and a `RollingUpdate` strategy with `maxUnavailable: 0` give you zero-downtime rollouts. Don't co-locate Postgres in-cluster for production unless you have a CloudNativePG or similar operator; a managed Postgres (RDS, Cloud SQL, Neon) is the safer default, and KernelCMS doesn't care which — the connection string is all the `@kernel/db-postgres` adapter needs.

| Concern        | Compose (single host)        | Kubernetes (Helm)                       |
|----------------|------------------------------|-----------------------------------------|
| Scaling        | vertical only                | HPA, 3–N replicas                       |
| Migrations     | manual `run --rm`            | pre-upgrade Job (Helm hook)             |
| TLS            | reverse proxy (Caddy/Traefik)| Ingress + cert-manager                  |
| Rollout        | restart in place             | rolling, `maxUnavailable: 0`            |
| Best for       | staging, small prod          | high-traffic, multi-region prod         |

## Config & Secrets

Everything operational threads through `kernel.config.ts`. Infrastructure is read from the environment so the same image runs in every stage without rebuilds. The pattern: typed env reads in config, secrets injected by the platform.

```ts
// kernel.config.ts
import { defineConfig } from '@kernel/core'
import { postgresAdapter } from '@kernel/db-postgres'
import { s3Storage } from '@kernel/storage'
import { redisCache, redisQueue } from '@kernel/server'
import { Pages } from './collections/Pages'
import { Media } from './collections/Media'
import { SiteSettings } from './globals/SiteSettings'

export default defineConfig({
  secret: process.env.KERNEL_SECRET!,     // signs sessions, tokens, preview JWTs
  collections: [Pages, Media],
  globals: [SiteSettings],

  db: postgresAdapter({
    url: process.env.KERNEL_DATABASE_URL!,
    pool: { max: 20 },
  }),

  storage: s3Storage({
    bucket: process.env.KERNEL_S3_BUCKET!,
    region: process.env.KERNEL_S3_REGION!,
    credentials: 'env',                   // reads KERNEL_S3_ACCESS_KEY_ID / _SECRET_ACCESS_KEY
  }),

  cache: redisCache({ url: process.env.KERNEL_REDIS_URL! }),
  queue: redisQueue({ url: process.env.KERNEL_REDIS_URL! }),

  cors: { origins: (process.env.KERNEL_CORS_ORIGINS ?? '').split(',').filter(Boolean) },
})
```

Rules of the road:

- **`KERNEL_SECRET` is load-bearing.** It signs sessions, API tokens, and live-preview JWTs. Rotating it invalidates all sessions — schedule it. Minimum 32 bytes; generate with `kernel gen secret`.
- **Never bake secrets into the image.** The Dockerfile copies no `.env`. In Compose, use an `.env` file or Docker secrets; in Kubernetes, use a `Secret` referenced via `secretKeyRef` (shown above) or an external manager (External Secrets Operator → Vault/AWS Secrets Manager). The chart never templates plaintext secrets into values.
- **CORS and trusted origins are explicit.** No wildcard-with-credentials. Sanity makes you manage CORS origins in a hosted dashboard; here it's in version-controlled config, reviewed in PRs.
- **Validate at boot.** `defineConfig` validates the adapter wiring and fails fast — a missing `KERNEL_DATABASE_URL` crashes the readiness probe rather than serving 500s. See Configuration Reference for the full surface and [Access Control](../06-auth-security/01-authorization-and-access-control.md) for how the same `secret` underpins authz.

| Variable                     | Required | Purpose                                  |
|------------------------------|----------|------------------------------------------|
| `KERNEL_SECRET`              | yes      | signs sessions, tokens, preview JWTs     |
| `KERNEL_DATABASE_URL`        | yes      | `@kernel/db-postgres` connection         |
| `KERNEL_S3_*`                | prod     | object storage for uploads               |
| `KERNEL_REDIS_URL`           | prod     | cache + queue adapters                   |
| `KERNEL_CORS_ORIGINS`        | prod     | comma-separated allowlist                |

## Upgrades

KernelCMS follows semver. Patch and minor releases are drop-in; majors carry a migration guide. The image version and the npm package versions move together, so an upgrade is: bump `@kernel/*`, rebuild, migrate, roll.

```bash
pnpm up "@kernel/*@1.9.0"          # bump all packages in lockstep
pnpm kernel migrate status         # preview pending schema diffs
pnpm kernel build                  # rebuild image inputs
```

Migrations are generated from schema diffs (the same Drizzle-backed flow as Payload's migration generator, but adapter-agnostic — Postgres, SQLite/libSQL, MySQL, and the MongoDB adapter each emit their own format). The sequence:

1. **Generate** on a dev machine: `kernel migrate create` writes a reviewable, committed migration file. Never auto-apply unreviewed diffs in production.
2. **Apply before rollout.** In Compose, `docker compose run --rm kernel pnpm kernel migrate`. In Kubernetes, the chart's pre-upgrade Job does this automatically, gated on success before new pods start.
3. **Roll forward.** With `maxUnavailable: 0` and the readiness probe, the old pods serve until new ones are ready.

For zero-downtime majors, design migrations to be **backward-compatible across one version** (expand/contract): add columns and new fields first, deploy code that writes both, backfill, then remove the old shape in a later release. This lets old and new pods coexist during the rollout window. The deeper playbook lives in Database Migrations.

Rollback: because the migrate Job runs before the new pods, a failed migration aborts the Helm upgrade with the old version still live. If a *deployed* version misbehaves after a successful migration, roll the image back only if the migration was additive (expand/contract guarantees this); otherwise apply a forward fix. Keep automated backups (the [Backups](./06-backups-and-disaster-recovery.md) doc covers cadence and restore drills) so a destructive migration is recoverable.

## Open questions

- **Operator vs. Helm-only.** A `kernel-operator` (CRDs for `Kernel`, `Tenant`) would manage migrations and tenant provisioning more cleanly than Helm hooks, but adds maintenance surface. Helm-first for v1; operator under evaluation.
- **Edge runtime parity.** The server runs on Node and Bun today. Full Cloudflare Workers / edge deployment depends on which adapters can run there (`@kernel/db-postgres` over HTTP drivers works; native drivers don't). Scope of an officially supported edge image is still open.
- **In-cluster Postgres recommendation.** Whether to bundle a CloudNativePG dependency in the chart for self-contained installs, or keep insisting on external managed Postgres, is undecided.
