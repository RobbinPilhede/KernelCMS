# Accessibility & Compliance Testing

KernelCMS ships WCAG 2.2 AA as a product guarantee, not a best-effort aspiration. The admin panel built on TanStack Start, `@kernel/ui`, and `@kernel/admin` is the surface most CMSes treat as "internal tooling" and quietly let regress — Payload, Sanity, and Strapi all have open accessibility gaps in their studios. We treat the admin like a public product: every component carries automated axe coverage, every release passes a manual audit on a fixed cadence, and we publish a real VPAT. This document specifies the gates — what runs automatically, what a human must sign off on, how the VPAT stays honest, and exactly where CI blocks a merge.

## The accessibility pyramid

We layer cheap-fast checks under expensive-slow ones so that 90% of regressions die in CI and humans only see the genuinely subjective failures.

```
                 ┌───────────────────────┐
   slow, manual  │  Manual audit (AT, KB) │  per release
                 ├───────────────────────┤
                 │  E2E axe (Playwright)  │  per PR
                 ├───────────────────────┤
   fast, auto    │  Component axe (jsdom) │  per commit
                 ├───────────────────────┤
                 │  Lint (jsx-a11y, ESLint)│  pre-commit
                 └───────────────────────┘
```

Automated tooling catches roughly 30–40% of WCAG failures (the axe-core team's own published figure). We never pretend the remaining 60% is covered by a green check — that's the entire reason the manual audit and VPAT exist as first-class gates, not afterthoughts.

## axe and automated checks

Automated checks run at three altitudes. All three use `axe-core` as the engine so rule versions stay consistent; the difference is the rendering environment.

### Static analysis (pre-commit)

`eslint-plugin-jsx-a11y` runs in the lint stage with a strict config. This is the only check that runs without rendering anything, so it's our fastest signal. We enable the full `recommended` ruleset plus the strict additions, and we do not allow disable-comments in `@kernel/ui` or `@kernel/admin` without a linked tracking issue.

```ts
// .eslintrc.a11y.ts — applied to packages/ui and packages/admin
import jsxA11y from 'eslint-plugin-jsx-a11y'

export default {
  plugins: { 'jsx-a11y': jsxA11y },
  rules: {
    ...jsxA11y.configs.strict.rules,
    'jsx-a11y/no-autofocus': ['error', { ignoreNonDOM: true }],
    'jsx-a11y/control-has-associated-label': 'error',
    'jsx-a11y/no-noninteractive-element-interactions': 'error',
  },
}
```

### Component-level axe (per commit)

Every component in `@kernel/ui` and every admin view ships a Vitest test that renders into jsdom and runs `axe`. We expose a thin helper from `@kernel/admin/testing` so the assertion is one line and the rule config is centralized — individual tests cannot silently weaken the ruleset.

```ts
// packages/ui/src/Field/TextField.a11y.test.tsx
import { render } from '@testing-library/react'
import { expectNoA11yViolations } from '@kernel/admin/testing'
import { TextField } from './TextField'

test('TextField is accessible with a label and error', async () => {
  const { container } = render(
    <TextField
      name="title"
      label="Title"
      required
      error="Title is required"
    />,
  )
  await expectNoA11yViolations(container)
})
```

```ts
// packages/admin/src/testing/axe.ts
import { axe, type RunOptions } from 'vitest-axe'

const RULESET: RunOptions = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] },
  rules: {
    // color-contrast is unreliable in jsdom — owned by E2E and manual instead
    'color-contrast': { enabled: false },
  },
}

export async function expectNoA11yViolations(node: Element): Promise<void> {
  const results = await axe(node, RULESET)
  expect(results).toHaveNoViolations()
}
```

A deliberate decision: `color-contrast` is disabled in jsdom because jsdom doesn't compute real layout or resolve CSS custom properties, so it produces false negatives. Contrast is verified instead in the E2E layer (real browser, real tokens) and in the manual audit. This is the kind of thing Strapi's test suite gets wrong — it asserts contrast in a non-rendering environment and the result is meaningless.

### E2E axe (per PR)

Playwright drives the real admin against a seeded `kernel.config.ts` fixture and runs `@axe-core/playwright` on each critical route. This is where contrast, focus order, and computed ARIA are actually trustworthy because Chromium has resolved the full cascade including our design tokens and dark mode.

```ts
// e2e/a11y/admin-routes.spec.ts
import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

const ROUTES = [
  '/admin/login',
  '/admin/collections/posts',          // TanStack Table list view
  '/admin/collections/posts/create',   // TanStack Form edit view
  '/admin/globals/site-settings',
  '/admin/media',                       // media library
] as const

for (const route of ROUTES) {
  test(`${route} has no a11y violations (light + dark)`, async ({ page }) => {
    for (const theme of ['light', 'dark'] as const) {
      await page.goto(route)
      await page.emulateMedia({ colorScheme: theme })
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze()
      expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([])
    }
  })
}
```

Running every route in both light and dark is non-negotiable. Dark mode regressions on contrast are the single most common admin a11y bug, and Sanity Studio has shipped several of these because its dark theme isn't in the automated path.

### What axe cannot see

We keep an honest internal table of the WCAG 2.2 criteria automation does **not** cover, so nobody mistakes a green pipeline for conformance:

| Criterion | Why automation misses it | Where it's covered |
|---|---|---|
| 2.4.3 Focus Order | Logical order is semantic, not structural | Manual + KB walkthrough |
| 1.3.2 Meaningful Sequence | Reading order vs. DOM order | Manual + screen reader |
| 2.5.3 Label in Name | Visible label ⊆ accessible name | Partial (lint) + manual |
| 3.3.2 Labels or Instructions | Presence detectable, sufficiency not | Manual |
| 1.4.13 Content on Hover/Focus | Dismissible/persistent behavior | Manual |
| 2.4.11 Focus Not Obscured | Sticky toolbars vs. focus ring | Manual + E2E heuristic |

## Manual audits

Automation gates merges; manual audits gate releases. Before any `kernel`/`@kernel/admin` minor release, an audit runs against the candidate build and must be signed off. We script the *coverage* so it's repeatable even though the *judgment* is human.

### Cadence and scope

- **Per release (minor and major):** full audit of the critical flows below.
- **Per quarter:** full audit including low-traffic surfaces (version history diff view, the block-based rich-text editor's slash menu, the command palette, live preview visual editing).
- **On any new field type or block:** targeted audit of that component before it leaves `experimental`.

### The walkthrough matrix

Each flow is exercised with keyboard-only, then with a screen reader, then at 200% and 400% zoom, then with `prefers-reduced-motion`. We test on the combinations real users actually run:

| Assistive tech | Browser | OS |
|---|---|---|
| NVDA | Firefox | Windows |
| JAWS | Chrome | Windows |
| VoiceOver | Safari | macOS |
| TalkBack | Chrome | Android (live preview only) |

### Critical flows

1. **Log in** — `@kernel/auth` form, error announcement, focus on first invalid field.
2. **Create a document** — TanStack Form bindings, per-field validation announced via `aria-live`, required/error state, async validation spinner reachable.
3. **The rich-text editor** — `@kernel/richtext` block editor: keyboard insertion of blocks, screen-reader announcement of block type, escape semantics for nested toolbars. This is where every competitor struggles; a block editor is essentially a custom widget and demands a manual pass every release.
4. **Collection list** — TanStack Table sorting/filtering reachable by keyboard, sort state announced, virtualized rows don't trap or lose focus.
5. **Media library** — upload via keyboard, focus management in the `<dialog>` picker.
6. **Command palette** — `aria-activedescendant` pattern, results announced as the count changes.

### Recording findings

Findings land as GitHub issues with a fixed label taxonomy (`a11y/blocker`, `a11y/serious`, `a11y/moderate`, mapped to axe impact levels) and a WCAG SC reference. A blocker or serious finding holds the release. This is the discipline gap with Strapi and Payload: they fix a11y bugs reactively from user reports rather than gating a release on a pre-publication audit.

## The VPAT

We publish a **Voluntary Product Accessibility Template** (VPAT 2.5 Rev, WCAG 2.2 + EN 301 549 editions) for KernelCMS at each major release. Procurement teams — especially government, education, and enterprise — require a VPAT to even evaluate a CMS. Payload, Sanity, and Strapi do not publish one. For KernelCMS this is both a conformance forcing-function and a sales wedge: a credible VPAT is the difference between being shortlisted and being filtered out.

### What it documents

Each WCAG 2.2 success criterion gets a conformance level and explanatory notes:

| Conformance level | Meaning |
|---|---|
| Supports | Meets the criterion without exception |
| Partially Supports | Some functionality does not fully meet it |
| Does Not Support | Majority of functionality does not meet it |
| Not Applicable | Criterion does not apply to the product |

### Honesty rules

The fastest way to destroy trust is a VPAT that claims "Supports" everywhere. Ours follows two hard rules:

- **Every "Supports" maps to evidence** — an E2E test ID, a manual audit run ID, or both. No claim without a trace.
- **Every "Partially Supports" names the gap** and links the tracking issue. A known limitation documented honestly is worth more to a procurement reviewer than a perfect-looking sheet.

We generate the evidence index automatically so the prose VPAT can be cross-checked against reality:

```ts
// scripts/vpat-evidence.ts — emits a map of WCAG SC -> evidence
import { collectAxeResults } from '@kernel/admin/testing'

type Evidence = {
  criterion: `${number}.${number}.${number}`
  level: 'Supports' | 'Partially Supports' | 'Does Not Support' | 'Not Applicable'
  automated: string[]   // E2E/component test ids
  manual: string[]      // audit run ids
  notes: string
}

export async function buildEvidenceIndex(): Promise<Evidence[]> {
  const axe = await collectAxeResults()
  // ...merge automated coverage with the manual audit log (audits/*.json)
  return mergeAutomatedAndManual(axe)
}
```

The VPAT lives next to the docs and is regenerated as part of the release runbook — see Release Process and [Compliance Overview](../06-auth-security/07-data-privacy-and-compliance.md).

## CI gates

The pipeline enforces the pyramid as discrete, individually-blocking jobs. Nothing merges with a red a11y stage.

```
 commit ─► lint (jsx-a11y) ─► component axe ─► build ─► E2E axe (light+dark)
                 │                  │                          │
              blocks PR         blocks PR                  blocks PR
```

The thresholds are exposed in `kernel.config.ts` so a project consuming `@kernel/admin` inherits the same gates and can tighten (never loosen below AA) them:

```ts
// kernel.config.ts
import { defineConfig } from '@kernel/core'

export default defineConfig({
  admin: {
    accessibility: {
      standard: 'wcag22aa',          // floor — cannot be set below 'wcag2aa'
      failOn: ['critical', 'serious'], // axe impact levels that fail CI
      themes: ['light', 'dark'],       // both must pass E2E
      // criteria automation can't verify, owned by the manual audit:
      manualReviewRequired: [
        '2.4.3', '1.3.2', '2.5.3', '3.3.2', '1.4.13', '2.4.11',
      ],
    },
  },
})
```

```yaml
# .github/workflows/a11y.yml (excerpt)
jobs:
  a11y:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm lint:a11y           # eslint-plugin-jsx-a11y, blocks on error
      - run: pnpm test:a11y           # vitest-axe component suite
      - run: pnpm build
      - run: pnpm e2e:a11y            # @axe-core/playwright, light + dark
      - run: pnpm vpat:check          # fails if a 'Supports' claim lost its evidence
```

The `vpat:check` step is the keystone: it fails the build if any criterion marked "Supports" in the published VPAT no longer has a passing automated or logged-manual evidence trail. That closes the loop where a refactor silently regresses a claim we've made to customers — the exact failure mode that makes most published VPATs stale within a release or two.

`failOn` defaulting to `critical` + `serious` (not `moderate`) is intentional: moderate findings file issues but don't block, because blocking on every moderate produces alert fatigue and `// eslint-disable` whack-a-mole. Moderates are swept up in the per-quarter manual audit instead.

## Open questions

- **Per-tenant theming on Cloud.** White-label theming lets tenants override design tokens, which can break contrast we can't pre-test. Likely answer: a runtime contrast linter in `@kernel/ui` that warns at theme-save time and refuses to publish a token set that fails AA — but the enforcement boundary (warn vs. block) for KernelCMS Cloud is undecided.
- **Plugin a11y certification.** Should `@kernel/plugin-sdk` field plugins be required to ship axe coverage before listing in a future marketplace, and do we surface an a11y badge? Leaning yes, mechanism TBD.
- **AT matrix cost.** JAWS licensing and the manual VoiceOver pass are the most expensive part of the cadence. Open question whether we move some screen-reader smoke tests to an automated harness (e.g., Guidepup) to shrink the manual surface without losing fidelity.
