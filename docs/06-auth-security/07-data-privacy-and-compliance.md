# Data Privacy & Compliance

KernelCMS treats privacy as a first-class concern of the operation core, not a plugin bolted on after launch. Every read, write, and delete flows through the same operation pipeline that enforces [access control](./01-authorization-and-access-control.md), so the same hooks that gate authorization also drive consent records, audit logging, export, and erasure. This document specifies how KernelCMS aligns with GDPR and CCPA/CPRA, how the `@kernel/core` operation core implements data export and erasure, how audit trails are recorded and queried, and how data residency is enforced across self-host and KernelCMS Cloud. Payload, Sanity, and Strapi all leave most of this to userland; KernelCMS ships the primitives in core and wires them to the adapter layer.

## GDPR and CCPA

The regulatory surface a CMS actually touches is narrow but sharp: it stores personal data in collections (authors, commenters, form submissions, customer records), it processes that data on behalf of a controller, and it must honor data-subject rights — access, portability, rectification, erasure, restriction, and objection. KernelCMS models these obligations declaratively on collections rather than asking you to implement them per-endpoint.

You mark which fields carry personal data and which legal basis applies. The compliance engine reads this metadata to drive export shape, erasure strategy, and retention.

```ts
// kernel.config.ts
import { defineConfig, collection } from '@kernel/core'

export default defineConfig({
  collections: [
    collection('users', {
      privacy: {
        // Marks this collection as containing data subjects.
        // Export/erasure requests resolve subjects through this collection.
        subject: { idField: 'email', kind: 'natural-person' },
        retention: { after: 'inactive', period: '24 months', action: 'erase' },
      },
      fields: [
        { name: 'email', type: 'email', privacy: { pii: 'identifier', basis: 'contract' } },
        { name: 'fullName', type: 'text', privacy: { pii: 'direct', basis: 'contract' } },
        { name: 'ipAddress', type: 'text', privacy: { pii: 'indirect', basis: 'legitimate-interest' } },
        { name: 'marketingConsent', type: 'boolean', privacy: { basis: 'consent', consentKey: 'marketing' } },
        { name: 'internalNotes', type: 'textarea', privacy: { pii: 'none', exportable: false } },
      ],
    }),
  ],
})
```

The `privacy` metadata is the single source of truth. `pii` classifies the field (`identifier`, `direct`, `indirect`, `none`); `basis` records the GDPR Article 6 lawful basis; `exportable` controls whether a value leaves the system in a portability request; `consentKey` ties a field to a consent ledger entry.

### CCPA/CPRA specifics

CCPA frames the same rights differently — the right to know, the right to delete, the right to correct, and the right to opt out of sale or sharing. KernelCMS exposes a per-subject `doNotSell` flag and a sharing ledger so that downstream integrations (analytics, ad pixels, third-party sync plugins) can check status before processing.

| Right | GDPR | CCPA/CPRA | KernelCMS API |
|---|---|---|---|
| Access / Know | Art. 15 | §1798.100 | `kernel.privacy.export(subject)` |
| Portability | Art. 20 | — | `export({ format: 'json' \| 'csv' })` |
| Erasure / Delete | Art. 17 | §1798.105 | `kernel.privacy.erase(subject)` |
| Rectification / Correct | Art. 16 | §1798.106 | standard `update` op + audit |
| Restriction | Art. 18 | — | `kernel.privacy.restrict(subject)` |
| Opt out of sale | — | §1798.120 | `subject.doNotSell = true` |

Payload and Strapi require you to hand-roll these endpoints against their data layer. Sanity exposes a GROQ-driven dataset you can query but offers no subject resolution or erasure orchestration. KernelCMS resolves a subject across every collection that references them and runs the request as one atomic operation.

## Data export and erasure

A data-subject request rarely touches one collection. A single `users` record may be referenced by `comments`, `orders`, `form-submissions`, and `audit-log` entries through `relationship` fields. KernelCMS walks the relationship graph from the subject collection to assemble a complete portable bundle and to scope erasure correctly.

```
                    subject: users(email=jo@x.io)
                              │
        ┌─────────────┬───────┴───────┬──────────────┐
        ▼             ▼               ▼              ▼
    comments      orders        form-submissions  audit-log
   (author rel)  (customer)      (submittedBy)    (actor rel)
        │
   referenced media (upload) ──► storage adapter
```

### Export

`kernel.privacy.export` produces a structured, machine-readable bundle that satisfies the Article 20 portability requirement. It honors field-level `exportable` flags so internal notes and non-PII operational fields stay out of the bundle.

```ts
import { kernel } from '@kernel/server'

const bundle = await kernel.privacy.export({
  subject: { collection: 'users', id: userId },
  format: 'json',          // 'json' | 'csv' | 'ndjson'
  include: 'related',      // 'self' | 'related' | 'all'
  signedUrlTtl: '15m',     // delivered via storage adapter as a signed URL
})
// bundle: { manifest, records, media[], generatedAt, requestId }
```

The export runs through the same access-control evaluation as a normal read, so an export triggered by an admin respects field-level read rules. Media referenced by `upload` fields is streamed from the configured [`@kernel/storage`](../07-media-files/01-storage-adapters.md) adapter and either inlined or referenced by signed URL.

### Erasure

Erasure is the hard part, because foreign keys, version history, drafts, and audit trails all hold copies of personal data. KernelCMS supports three strategies, chosen per collection or per request:

| Strategy | What happens | When to use |
|---|---|---|
| `hard-delete` | Row removed; relationships nulled or cascaded | No legal retention obligation |
| `anonymize` | PII fields overwritten with tombstones; non-PII kept | Analytics/order history must survive |
| `crypto-shred` | Per-subject encryption key destroyed | High-volume, encrypted-at-rest data |

```ts
const result = await kernel.privacy.erase({
  subject: { collection: 'users', id: userId },
  strategy: 'anonymize',
  // Field-level overrides; everything marked pii != 'none' is replaced.
  tombstone: { email: 'erased+{id}@deleted.invalid', fullName: '[erased]' },
  cascade: { comments: 'anonymize', orders: 'anonymize', 'form-submissions': 'hard-delete' },
  reason: 'gdpr-art-17',
})
// result: { erased: 14, anonymized: 9, retained: [{ collection: 'orders', reason: 'tax-law' }] }
```

Crucially, erasure also reaches into version history and drafts. A naive delete that leaves an old autosaved version containing the user's name is a compliance failure. `kernel.privacy.erase` rewrites historical versions in place for erased fields, recording the rewrite itself in the audit trail without re-storing the erased values. Retention exceptions (data the controller must keep for tax or legal reasons) are returned explicitly rather than silently dropped, so the request can be reported accurately to the data subject.

Strapi's delete simply removes the row and orphans related records; version history is a paid feature with no erasure awareness. Payload deletes the document but leaves versions intact unless you write hooks. KernelCMS makes graph-aware, version-aware erasure the default path.

## Audit trails

Every mutating operation produces an immutable audit record. The audit log is append-only: it is written through a dedicated adapter that rejects updates and deletes, and entries are hash-chained so tampering is detectable.

```ts
// kernel.config.ts excerpt
audit: {
  adapter: postgresAudit({ table: 'kernel_audit', append_only: true }),
  hashChain: true,                 // each entry stores prevHash; chain is verifiable
  capture: ['create', 'update', 'delete', 'login', 'export', 'erase', 'access-denied'],
  redact: ['password', 'token'],   // never log these field values
  retention: '7 years',            // diverge from content retention on purpose
}
```

Each entry records the actor, the operation, the target document, a structured field-level diff, the access decision, the request IP and user agent, and the request ID that ties it to export/erasure jobs.

```ts
interface AuditEntry {
  id: string
  at: string                    // ISO-8601, UTC
  actor: { id: string; type: 'user' | 'apiKey' | 'system' }
  op: 'create' | 'update' | 'delete' | 'login' | 'export' | 'erase'
  target: { collection: string; documentId: string } | null
  diff?: FieldDiff[]            // before/after, redacted fields masked
  decision: 'allow' | 'deny'
  context: { ip: string; userAgent: string; requestId: string }
  prevHash: string
  hash: string                  // sha256(prevHash + canonical(entry))
}
```

Audit data is queryable through the same `where`/`sort`/pagination query language used everywhere else, surfaced in the admin under a dedicated, read-only view backed by TanStack Table and TanStack Query:

```ts
const trail = await kernel.audit.query({
  where: { 'target.collection': { eq: 'users' }, op: { in: ['erase', 'export'] } },
  sort: '-at',
  limit: 50,
})
const intact = await kernel.audit.verifyChain({ from: '2026-01-01' }) // boolean + first break
```

Neither Payload, Sanity, nor Strapi ships a tamper-evident, hash-chained audit log in the open-source core. This is a deliberate KernelCMS differentiator for SOC 2 and ISO 27001 evidence collection.

## Data residency

Residency means personal data physically stays in an approved region. KernelCMS enforces this at two layers: the database adapter binds to a region, and the storage adapter binds to a region. Because both are swappable, residency is a configuration property, not a code change.

```ts
// kernel.config.ts — EU residency
import { postgres } from '@kernel/db-postgres'
import { s3 } from '@kernel/storage'

export default defineConfig({
  region: 'eu-central-1',          // policy assertion; mismatches fail at boot
  db: postgres({ url: env.DATABASE_URL, region: 'eu-central-1' }),
  storage: s3({ bucket: 'kernel-eu', region: 'eu-central-1', enforceRegion: true }),
})
```

At boot, `@kernel/core` validates that every adapter's resolved region matches the declared `region` and refuses to start on a mismatch — a fail-closed posture that prevents an accidental US bucket from leaking EU data.

### Per-tenant residency on KernelCMS Cloud

Self-host pins one region per deployment. KernelCMS Cloud is multi-tenant, so residency is resolved per project from the control plane, and each tenant's data lives in a region-local data plane.

```
        Control plane (global): routing, billing, identity
                          │  resolves tenant → region
        ┌─────────────────┼─────────────────────┐
        ▼                 ▼                     ▼
   data plane: eu    data plane: us       data plane: ap
   (db + storage     (db + storage         (db + storage
    + CDN edge EU)     + CDN edge US)        + CDN edge AP)
```

The content CDN is configured to serve from in-region edges only for residency-scoped projects, and backups inherit the project's region. Because content and config are portable by design, a tenant can request a region migration: the platform exports the full project, provisions a data plane in the target region, replays, and verifies before cutover — all logged in the audit trail.

Sanity hosts content in its own regions with limited residency choice; Strapi Cloud and Payload Cloud offer a small fixed set. KernelCMS makes the region an explicit, verifiable property of the adapter contract on both self-host and Cloud, with fail-closed enforcement.

## Open questions

- **Consent ledger storage**: keep the consent ledger inline on the subject document, or in a dedicated append-only `kernel_consent` table that mirrors the audit adapter's tamper-evidence? The latter is cleaner for proof-of-consent but adds a join on every consent check.
- **Crypto-shred key custody**: per-subject keys could live in the database (simple, but co-located with the ciphertext) or in an external KMS adapter (`@kernel/kms`, not yet specified). Co-location weakens the shred guarantee.
- **Cross-region relationships**: should KernelCMS Cloud permit a `relationship` field to point across regional data planes, or forbid it to keep residency provably clean? Forbidding is safer but limits global content models.
- **DSAR self-service surface**: whether to ship a tenant-facing, unauthenticated DSAR intake form in `@kernel/admin`, or leave the public-facing request flow to userland and only expose the fulfillment APIs.
