# Plugin Marketplace & Registry

KernelCMS plugins are plain npm packages that conform to the `@kernel/plugin-sdk` contract. The registry layer described here is not a replacement for npm — it is a curation, discovery, and trust index built on top of npm. This document specifies how plugins are published, indexed, scored for trust, versioned against the unstable surfaces of a config-as-code CMS, and how authors can charge money without forcing the core registry behind a paywall. The design deliberately keeps the open-source path frictionless (anyone can `pnpm add` a plugin from npm and wire it into `kernel.config.ts`) while making the curated registry and KernelCMS Cloud the place where trust signals, paid licensing, and one-click install live.

## The Registry Model

The first decision: KernelCMS does not invent a package host. Payload took the "it's just npm" route and never shipped a real marketplace — discovery there means searching GitHub topics and the docs site. Strapi built a first-class Marketplace UI inside the admin, but every plugin still installs from npm and the marketplace is a curated catalog with a submission process. Sanity has a plugin ecosystem plus a separate template/starter gallery, again backed by npm. KernelCMS follows the Strapi insight — a real in-admin catalog wins — but pushes it further by making the registry a thin, queryable index that any client (admin UI, `kernel` CLI, Cloud) reads from.

The registry is a layered system:

```
        ┌─────────────────────────────────────────────┐
        │  npm (source of truth for package tarballs)   │
        └───────────────────────┬───────────────────────┘
                                │  ingest (webhook + poll)
        ┌───────────────────────▼───────────────────────┐
        │  KernelCMS Registry Index                      │
        │  - metadata, compat matrix, trust scores       │
        │  - search (tags, adapters, field types)        │
        │  - license + pricing records                   │
        └──────┬───────────────┬──────────────┬──────────┘
               │               │              │
        ┌──────▼─────┐  ┌──────▼──────┐ ┌─────▼──────┐
        │ kernel CLI │  │ admin panel │ │ Cloud UI   │
        │ kernel add │  │ Marketplace │ │ install/buy│
        └────────────┘  └─────────────┘ └────────────┘
```

A plugin enters the index in one of two ways. Either the author opts in by adding a `kernel` block to `package.json` and the registry's npm ingest worker picks it up on publish, or they submit through the Cloud dashboard for the curated tier (required for paid plugins and for the "verified" badge). The index never stores tarballs; install always resolves through the user's own package manager so air-gapped and self-hosted users keep full control. The registry is queryable as data:

```ts
// @kernel/client — registry queries are typed, cached via TanStack Query
import { registry } from '@kernel/client'

const results = await registry.search({
  query: 'algolia',
  // facet by the things that actually matter in a CMS
  provides: ['search-adapter'],
  compatibleWith: { core: '^2.4.0', db: '@kernel/db-postgres' },
  trust: { minScore: 70, verifiedOnly: false },
  sort: 'trust',
})
```

The in-admin Marketplace is a TanStack Table view over exactly this query, with TanStack Router holding the facet state in search params so a filtered catalog is a shareable URL. Installing from the admin does not download code into a running process; it writes the dependency, prints the `kernel.config.ts` wiring snippet, and (on Cloud) triggers a rebuild. Self-hosters get a copy-paste command. We never hot-load untrusted code into the admin runtime — see Plugin Security & Sandboxing.

## Metadata and Trust

Every indexed plugin carries a manifest. The minimum lives in `package.json`; the registry enriches it with computed signals.

```jsonc
// package.json of a community plugin
{
  "name": "@acme/kernel-plugin-algolia",
  "version": "1.3.0",
  "kernel": {
    "displayName": "Algolia Search",
    "provides": ["search-adapter"], // capability tags, controlled vocabulary
    "fieldTypes": [], // custom field types it registers
    "adapters": { "search": "algolia" },
    "peerSurfaces": ["@kernel/server", "@kernel/admin"],
    "compat": { "core": "^2.0.0" }, // semver range against @kernel/core
    "config": "./schema/config.json", // JSON Schema for the plugin's options
    "screenshots": ["./media/list.png"],
    "license": "MIT",
    "pricing": { "model": "free" },
  },
  "peerDependencies": { "@kernel/core": "^2.0.0" },
}
```

`provides` and `adapters` draw from a controlled vocabulary (`db-adapter`, `storage-adapter`, `search-adapter`, `auth-provider`, `email-provider`, `cache-adapter`, `queue-adapter`, `field-type`, `richtext-node`, `admin-view`, `hook-bundle`). This is what makes registry search useful in a way GitHub topics never are: a user filtering for "things that satisfy the search adapter contract and run on the edge runtime" gets a precise answer.

Trust is the registry's real product. We compute a 0–100 score from objective signals and surface every input, never a black box:

| Signal                                          | Weight | Source                  |
| ----------------------------------------------- | ------ | ----------------------- |
| Verified publisher (domain/org proof)           | 20     | Cloud submission        |
| Provenance attestation (npm + Sigstore)         | 15     | npm publish metadata    |
| Compat tests pass on current core               | 20     | registry CI matrix      |
| No critical advisories in deps                  | 15     | `dependency-audit` scan |
| Maintenance (release cadence, open-issue ratio) | 15     | GitHub/GitLab API       |
| Adoption (weekly downloads, deduped)            | 10     | npm stats               |
| Docs + screenshots present                      | 5      | manifest check          |

```ts
interface TrustReport {
  score: number // 0–100
  tier: 'verified' | 'community' | 'unscored'
  signals: TrustSignal[] // every input, with its raw value
  advisories: Advisory[] // open security advisories, by severity
  provenance: ProvenanceAttestation | null
  lastScannedAt: string
}
```

The "verified" badge requires identity proof and a clean security scan; it is the only signal a human gates. Everything else is automated and re-run on each publish and nightly. Strapi's marketplace shows a "verified" label but the criteria are opaque; KernelCMS makes the rubric public and the raw signals inspectable, which matters when you're about to give a plugin access to your content operations.

## Versioning

A CMS plugin couples to far more surface than a typical library. It can depend on the core operation pipeline, the admin component API, the field-type registry, and a specific adapter contract — any of which can break independently. We split compatibility into three declared dimensions rather than one fuzzy `peerDependency`:

```ts
// @kernel/plugin-sdk
export const definePlugin = (p: PluginDefinition) => p

export interface CompatDeclaration {
  core: string // @kernel/core operation pipeline + config schema
  admin?: string // @kernel/admin component + view API (if it ships UI)
  sdkSurface: number // monotonic plugin-SDK contract version, e.g. 3
}
```

The plugin SDK surface is a single integer that bumps only on breaking changes to the plugin contract itself — install hooks, field registration, lifecycle. Core and admin follow semver independently. The registry's compat matrix runs each plugin's smoke test against the latest patch of every supported minor, so the catalog can answer "does this work on the version I'm pinned to" without trusting the author's hand-written range. A red cell in the matrix downgrades trust and hides the plugin from filtered installs for incompatible cores.

| Plugin v | core ^2.0 | core ^2.4 | core ^3.0 | sdkSurface |
| -------- | --------- | --------- | --------- | ---------- |
| 1.3.0    | ✅        | ✅        | ❌        | 3          |
| 2.0.0    | ❌        | ✅        | ✅        | 4          |

The `kernel` CLI enforces this on install. It refuses a plugin whose declared `core` range excludes the installed core, and warns when the registry compat matrix disagrees with the author's declaration:

```bash
$ kernel add @acme/kernel-plugin-algolia
✔ resolved @acme/kernel-plugin-algolia@1.3.0
✖ incompatible: requires @kernel/core ^2.0.0, you have 3.1.2
  → 2.0.0 supports your core. install it instead? (Y/n)
```

Deprecations follow the SDK-surface integer. When `sdkSurface` bumps, the previous surface stays supported for two minor core releases with codemods shipped via `kernel migrate plugins`. This is stricter than Payload, where plugin breakage tends to surface only at runtime, and more legible than Sanity's studio versioning, where v2→v3 was a hard cliff for the whole ecosystem.

## Monetization Options

The open-source core stays MIT and the npm install path is never gated — that is a hard constraint, not a marketing line. Monetization is opt-in and lives in the curated/Cloud layer. We support three models, all expressed in the manifest and enforced at the license-check boundary, never by withholding source.

```ts
type Pricing =
  | { model: 'free' }
  | { model: 'paid'; price: number; interval: 'one-time' | 'monthly' | 'yearly'; currency: 'usd' }
  | { model: 'freemium'; freeTier: string[]; paidFeatures: string[]; price: number; interval: 'monthly' }
  | { model: 'byo'; note: string } // bring-your-own license (e.g. enterprise SaaS the plugin wraps)
```

| Model              | Who collects payment     | Enforcement                         | Best for                           |
| ------------------ | ------------------------ | ----------------------------------- | ---------------------------------- |
| Free / MIT         | nobody                   | none                                | community adapters, field types    |
| Paid (license key) | KernelCMS Cloud (Stripe) | `@kernel/plugin-sdk` license verify | premium adapters, advanced editors |
| Freemium           | Cloud                    | feature-flag check at runtime       | open core + paid pro features      |
| Sponsorship        | GitHub/OpenCollective    | none (badge only)                   | maintainers funding free work      |

Paid plugins are still published as readable npm packages — we do not ship obfuscated tarballs — but the gated features call a license-verification hook that checks a signed, offline-verifiable license token. The token is an asymmetrically signed JWT, so self-hosters validate it without phoning home:

```ts
// inside a paid plugin
import { verifyLicense } from '@kernel/plugin-sdk'

export default definePlugin({
  name: '@acme/kernel-plugin-visual-workflow',
  async setup(ctx) {
    const license = await verifyLicense(ctx, {
      sku: 'visual-workflow-pro',
      // offline check against KernelCMS Cloud's published public key
    })
    if (!license.valid) {
      ctx.logger.warn('Visual Workflow running in free mode — pro nodes disabled')
    }
    return { features: license.valid ? proNodes : freeNodes }
  },
})
```

Cloud is the merchant of record: it runs Stripe, handles tax/VAT, issues license tokens, and pays out authors (we take a platform fee on the curated paid tier; sponsorship and free plugins cost nothing). On Cloud, buying a plugin and provisioning its license key is one click and the key lands in the project's secret store. Self-hosters paste the key into `kernel.config.ts` via an env reference:

```ts
// kernel.config.ts
import { defineConfig } from '@kernel/core'
import visualWorkflow from '@acme/kernel-plugin-visual-workflow'

export default defineConfig({
  plugins: [visualWorkflow({ license: process.env.VISUAL_WORKFLOW_LICENSE })],
})
```

This is the gap Payload, Sanity, and Strapi all leave open. None of them ships a native paid-plugin rail — authors hand-roll Gumroad links and homegrown license servers, and self-hosted enforcement is ad hoc. KernelCMS makes paid distribution a first-class, MIT-compatible primitive: source stays open, payment and licensing are handled by Cloud, and the offline token means a paid plugin keeps working on a self-hosted, air-gapped install without a runtime dependency on our servers.

## Open Questions

- **Trust score gaming.** Download counts and release cadence are spoofable. Do we cap the adoption signal's weight, or move to a Cloud-attested "real install" metric that only counts deduplicated production deployments?
- **Curated-tier governance.** Who arbitrates takedowns for a verified plugin that later ships a vulnerability or a license violation — automated advisory thresholds, a human review board, or both?
- **Platform fee on paid plugins.** The exact percentage and whether the first-party `@kernel/*` adapters are ever allowed to be paid (current stance: no) needs a written policy before the Cloud paid tier ships.
- **Private registries.** Enterprises will want an internal index scoped to their npm proxy. Is that a self-hostable `@kernel/registry` package, or a Cloud feature only?
