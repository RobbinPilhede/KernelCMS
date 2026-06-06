# API Versioning & Deprecation

KernelCMS generates REST, GraphQL, and typed RPC surfaces from a single content config, so "the API" is not one artifact you version by hand — it is a projection of your collections, globals, fields, and access rules. This document specifies how those projections evolve: the versioning strategy, the deprecation policy, the schema-evolution rules that keep generated surfaces compatible, and the compatibility windows that bound how long old behavior survives. The throughline: most CMS API breakage comes from _your_ schema changes, not ours, so KernelCMS makes both kinds explicit and measurable.

## Two axes of versioning

There are two independent things people mean by "API version," and conflating them is why Strapi v3→v4 and Payload major bumps hurt. KernelCMS separates them.

| Axis                      | What changes                                                               | Who owns it                 | Versioned by                         |
| ------------------------- | -------------------------------------------------------------------------- | --------------------------- | ------------------------------------ |
| **Platform API contract** | REST/GraphQL/RPC shape rules, query language, envelope, error format, auth | KernelCMS core              | A dated `apiVersion`                 |
| **Content schema**        | Your collections, fields, relationships, validation                        | You (in `kernel.config.ts`) | Drizzle migrations + `schemaVersion` |

Sanity does this well — its API is pinned by a date (`useCdn`, `apiVersion: '2024-03-01'`) and your dataset schema is yours to evolve. KernelCMS follows the dated model for the platform contract and adds a generated, typed schema version on top.

```ts
// kernel.config.ts
import { defineConfig } from '@kernel/core'

export default defineConfig({
  api: {
    // Date-pinned platform contract. New behavior ships under new dates;
    // requests without a pin resolve to `default`.
    version: '2026-05-01',
    default: '2026-05-01',
    // Reject requests pinned to a version past its sunset date.
    rejectExpired: true,
  },
})
```

### Why dates, not semver, for the platform contract

Semver (`v1`, `v2`) collapses every breaking change into one cliff and forces a big-bang migration. Strapi's v4 rewrite is the cautionary tale: a single major number bundled dozens of unrelated breaks. Dated versions let each break ship independently and let a consumer pin exactly the contract they tested against. A client pinned to `2026-05-01` keeps that response envelope, error shape, and query-language dialect until the date is sunset — even as newer dates introduce changes.

The pin travels with the request and is echoed back:

```http
GET /api/posts?where[status][equals]=published HTTP/1.1
X-Kernel-Api-Version: 2026-05-01
```

```http
HTTP/1.1 200 OK
X-Kernel-Api-Version: 2026-05-01
X-Kernel-Api-Default: 2026-05-01
```

GraphQL pins via the same header or a `?apiVersion=` param; the typed `@kernel/client` and RPC layer pin at construction so in-process Local API calls never silently drift.

```ts
import { createClient } from '@kernel/client'

const kernel = createClient({
  url: process.env.KERNEL_URL,
  apiVersion: '2026-05-01', // compile-time-checked against generated types
})
```

## Schema evolution

The content schema is the surface your consumers feel most. KernelCMS classifies every config change as **additive**, **transitional**, or **breaking**, and the `kernel` CLI computes the class from a schema diff before it generates a Drizzle migration. This is the discipline Payload and Strapi leave to the developer's judgment; KernelCMS makes the classifier a build gate.

```
  config change
       │
       ▼
  kernel diff ──► additive ────► auto-migrate, no consumer action
       │
       ├────────► transitional ─► dual-read window, codemod offered
       │
       └────────► breaking ─────► blocked unless `--allow-breaking`
                                  + deprecation entry required
```

### Change classification

| Change                                 | Class        | Consumer impact                   |
| -------------------------------------- | ------------ | --------------------------------- |
| Add optional field                     | additive     | none                              |
| Add collection / global                | additive     | none                              |
| Add enum value to `select`             | additive     | none                              |
| Rename field (with `previousName`)     | transitional | aliased; old name read-only       |
| Widen type (`number` → `text` w/ cast) | transitional | dual-read                         |
| Make optional field required           | breaking     | writes may reject                 |
| Remove field / collection              | breaking     | reads/writes fail                 |
| Narrow type or enum                    | breaking     | existing data may fail validation |

Renames are first-class so you never lose data or silently break clients:

```ts
// collections/posts.ts
import { defineCollection } from '@kernel/core'

export const Posts = defineCollection({
  slug: 'posts',
  fields: [
    {
      name: 'summary',
      type: 'textarea',
      // Old field name kept as a read alias across the deprecation window.
      previousName: 'excerpt',
      deprecated: {
        alias: 'excerpt',
        since: '2026-05-01',
        removeAfter: '2026-11-01',
        reason: 'Renamed for consistency with `summary` across collections.',
      },
    },
  ],
})
```

During the window the generated REST/GraphQL/RPC surfaces expose **both** `excerpt` (deprecated) and `summary`. GraphQL marks the old field with the native `@deprecated` directive so any GraphQL tooling — Apollo, GraphiQL, codegen — surfaces the warning automatically. See [GraphQL API](./02-graphql-api.md) and the Query Language for how `where`/`sort`/`depth` interact with aliased fields.

### Migrations are generated, deprecations are declared

The Drizzle migration handles the _database_; the `deprecated` block handles the _contract_. They are separate on purpose: you can deprecate a field's API exposure long before you drop its column, and you can drop a column only after the contract window closes. The CLI enforces the ordering.

```bash
kernel diff                 # classify changes, show consumer impact
kernel migrate generate     # emit Drizzle migration from schema diff
kernel deprecations list    # show active deprecations + sunset dates
```

## Deprecation policy

A deprecation is a contract, not a comment. Every deprecated element — a platform `apiVersion`, a collection, a field, a query operator, an RPC procedure — carries the same metadata and flows through the same machinery.

```ts
type Deprecation = {
  since: string // ISO date the deprecation was announced
  removeAfter: string // earliest date removal may ship
  reason: string // why; shown in warnings and changelog
  replacement?: string // what to use instead
  alias?: string // for renames: the still-readable old name
}
```

### How consumers learn about it

Deprecations are loud by design, across four channels, so nobody discovers a removal in prod:

1. **Response headers** — every response touching a deprecated path emits `Deprecation: true`, a `Sunset:` date (RFC 8594), and a `Link: <docs>; rel="deprecation"`.
2. **GraphQL `@deprecated`** — introspectable, picked up by all standard tooling.
3. **Typed deprecations** — `@kernel/client` and the RPC types mark deprecated fields/procedures with `/** @deprecated */`, so TypeScript flags them in the editor and in CI.
4. **Admin + logs** — the admin panel shows a banner on affected collections, and the server logs a sampled, structured warning per deprecated access (rate-limited so it never floods).

```http
HTTP/1.1 200 OK
Deprecation: true
Sunset: Sat, 01 Nov 2026 00:00:00 GMT
Link: <https://docs.kernelcms.dev/deprecations#posts.excerpt>; rel="deprecation"
```

Payload and Strapi rely largely on changelog notes and console logs; Sanity leans on its dated API. KernelCMS combines dated platform versions _and_ per-element machine-readable deprecation signals, so both humans and CI catch the same thing.

### Telemetry-gated removal

You should never remove something that is still being called. KernelCMS records deprecated-path usage (opt-in, aggregate counts only — no payloads, no PII) so removal is data-driven, not calendar-driven alone:

```bash
kernel deprecations usage --since 30d
```

```
ELEMENT                    LAST SEEN   CALLS/24h   PINNED CLIENTS   SUNSET
posts.excerpt (alias)      2h ago      1,204       3                2026-11-01
api@2026-01-15             8d ago      0           0                2026-07-15
rpc:legacyBulkUpdate       19m ago     47          1                2026-09-01
```

Sunset is enforced only after both the date passes and usage is acceptable. If the date arrives while a pinned client still calls the element, the CLI warns and removal is blocked unless overridden — preventing the classic "we sunset it on schedule and paged ops at 2 a.m." failure.

## Compatibility windows

A compatibility window is the guaranteed minimum lifetime of deprecated behavior. KernelCMS sets defaults by surface and lets you lengthen (never silently shorten) them in config.

| Surface                         | Default window                     | Notes                                   |
| ------------------------------- | ---------------------------------- | --------------------------------------- |
| Platform `apiVersion`           | 12 months from sunset announcement | Dated contracts                         |
| Collection / field (renamed)    | 6 months                           | Old name read-only via alias            |
| Query operator / `where` syntax | 6 months                           | Old + new accepted in parallel          |
| RPC procedure                   | 6 months                           | `/** @deprecated */` in generated types |
| Field removal                   | 3 months min after deprecation     | Telemetry-gated                         |

```ts
// kernel.config.ts
export default defineConfig({
  api: {
    version: '2026-05-01',
    deprecations: {
      // Minimum window before any removal may ship, regardless of date set per-element.
      minWindow: '90d',
      // Block builds that would remove an element still inside its window.
      enforce: 'error', // 'error' | 'warn' | 'off'
      // Reject requests pinned to a sunset version instead of silently upgrading.
      rejectExpired: true,
    },
  },
})
```

### Window lifecycle

```
 announce          window open (dual behavior)            sunset
 (since)   ─────────────────────────────────────────►  (removeAfter)
   │                                                         │
   ▼                                                         ▼
 deprecated: true             headers + @deprecated     reads fail / 410 Gone
 in config                    + typed warnings          (or pinned clients held)
```

Within the window both behaviors are valid: old field name and new, old operator and new, old `apiVersion` and new. At sunset, requests pinned to an expired `apiVersion` get `410 Gone` with `Sunset` and `Link` headers pointing at the migration guide when `rejectExpired` is on; otherwise they resolve to `default` with a one-time `Deprecation` warning. This is stricter than Strapi (which drops old behavior at major boundaries) and more explicit than Payload (where removal timing is per-release-note), while matching Sanity's date-pinned stability.

### What KernelCMS guarantees vs. what it cannot

KernelCMS guarantees windows for changes it generates from your config and for its own platform contract. It cannot guarantee compatibility for behavior you reach through escape hatches — raw Drizzle queries against the underlying tables, custom field types that bypass the validation pipeline, or direct adapter calls. Those are documented as out-of-contract in [Custom Field Types](../02-data-modeling/04-field-types-catalog.md) and [Adapters](../03-persistence/00-persistence-overview-and-adapter-contract.md). Use the generated surfaces and the windows hold; go around them and you own the compatibility yourself.

## Open questions

- **Per-tenant pinning on Cloud.** On KernelCMS Cloud (multi-tenant), should each tenant pin its own `apiVersion`, or should the platform enforce a narrower global window to bound the support matrix? Leaning toward per-tenant pin with a hard floor.
- **Automatic codemods for transitional changes.** We offer codemods for renames in `@kernel/client`; whether to auto-generate codemods for GraphQL operations and persisted queries is undecided.
- **Telemetry default.** Usage-gated removal is opt-in for self-host. Whether to default it _on_ (aggregate, anonymized) for Cloud and keep it off for self-host, or make it uniformly opt-in, is still under discussion.
