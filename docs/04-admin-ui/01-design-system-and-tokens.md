# Design System & Tokens

The KernelCMS admin is config-driven, white-labelable, and WCAG 2.2 AA by default — which means its visual language cannot be a pile of hand-tuned CSS. It is a token system. Every color, dimension, and type ramp the admin renders is a named token resolved at runtime from a layered cascade: a built-in default theme, a deployment-level theme from `kernel.config.ts`, the operator's chosen color mode (light/dark) and density (comfortable/compact), and any per-user overrides. This document specifies that token architecture, the theming primitives exposed by `@kernel/ui`, the dark-mode contract, and the density system. The goal is the same one Sanity reaches for with its hue-based studio theme and Strapi with its `@strapi/design-system`, but with a token contract that is typed end-to-end and addressable from `kernel.config.ts` without forking the admin.

## Token architecture

Tokens live in three tiers. This is the standard reference/system/component split, and keeping the tiers honest is what makes theming tractable.

```
┌─────────────────────────────────────────────────────────┐
│  Tier 1 — Reference (primitives)                         │
│  raw, mode-agnostic values. never used directly in UI.   │
│  color.blue.500  space.4  font.size.300  radius.md       │
└───────────────┬─────────────────────────────────────────┘
                │ aliased by
┌───────────────▼─────────────────────────────────────────┐
│  Tier 2 — System (semantic)                              │
│  intent-named, mode-aware. the layer components consume. │
│  color.bg.surface  color.fg.muted  color.accent.solid    │
│  space.gutter  text.body.md  border.default              │
└───────────────┬─────────────────────────────────────────┘
                │ specialized by
┌───────────────▼─────────────────────────────────────────┐
│  Tier 3 — Component                                      │
│  per-component knobs, default to system tokens.          │
│  button.solid.bg  field.border.focus  table.row.hover    │
└──────────────────────────────────────────────────────────┘
```

Reference tokens are the raw palette and scales. They never appear in a component's styles — a component that reaches for `color.blue.500` directly is a bug, because that value has no meaning in dark mode. System tokens carry intent (`color.bg.surface`, `color.fg.muted`, `color.accent.solid`) and are the only tier most components touch. Component tokens exist so a plugin author can restyle `button.solid.bg` without redefining the button, and they fall back to system tokens when unset.

Every token is emitted as a CSS custom property under a `--k-` prefix and is also exported as a typed accessor from `@kernel/ui`. The CSS variables are what the browser cascades; the typed map is what gives you autocomplete and compile-time errors when a token is renamed.

```ts
// @kernel/ui
import { token, useToken } from '@kernel/ui'

// static reference — resolves to `var(--k-color-bg-surface)`
const surface = token('color.bg.surface')

// reactive read inside a component (subscribes to mode/density changes)
function Panel() {
  const pad = useToken('space.gutter')
  return <div style={{ background: token('color.bg.surface'), padding: pad }} />
}
```

### Color

Colors are authored as primitives in perceptual space (OKLCH) so that ramps stay even and contrast is predictable across hues. Each hue ships a 12-step ramp (`50`–`950` plus `0`/`1000` endpoints), mirroring the Radix-style scale Sanity also leans on, where steps map to _roles_ — backgrounds, borders, solids, text — not arbitrary lightness.

| Step    | Role                           | Example system token                          |
| ------- | ------------------------------ | --------------------------------------------- |
| 50–100  | app & subtle backgrounds       | `color.bg.canvas`, `color.bg.subtle`          |
| 200–300 | UI element backgrounds, hover  | `color.bg.element`, `color.bg.hover`          |
| 400–500 | borders, separators            | `color.border.default`, `color.border.strong` |
| 600–700 | solid fills (buttons, accents) | `color.accent.solid`                          |
| 800–950 | high-contrast text             | `color.fg.default`, `color.fg.muted`          |

Semantic color tokens are grouped by surface and foreground, plus intent ramps (`accent`, `success`, `warning`, `danger`, `info`). Because they are role-mapped, swapping the accent hue is one line — unlike Strapi, where deeper brand theming historically meant overriding component CSS, KernelCMS rebinds the role:

```ts
// kernel.config.ts
import { defineConfig } from '@kernel/core'

export default defineConfig({
  admin: {
    theme: {
      brand: { name: 'Acme', logo: '/acme.svg' },
      tokens: {
        // re-point the accent role to a custom hue ramp
        color: {
          accent: { hue: 268, chroma: 0.16 }, // generates the full 12-step ramp
          danger: { hue: 24 },
        },
        radius: { md: '10px' },
      },
    },
  },
})
```

### Space

Spacing is a single geometric-ish scale on a 4px base, indexed by integer so math stays obvious in code review.

| Token      | Value (comfortable) | Typical use                  |
| ---------- | ------------------- | ---------------------------- |
| `space.0`  | 0                   | reset                        |
| `space.1`  | 4px                 | icon gaps                    |
| `space.2`  | 8px                 | inline padding               |
| `space.3`  | 12px                | field padding                |
| `space.4`  | 16px                | card padding, default gutter |
| `space.6`  | 24px                | section spacing              |
| `space.8`  | 32px                | page padding                 |
| `space.12` | 48px                | large layout gaps            |

Layout primitives never take raw pixels — `<Stack>`, `<Inline>`, and `<Grid>` from `@kernel/ui` accept token indices and emit `gap`, never margins, per the project's CSS rules. Semantic aliases (`space.gutter`, `space.field-y`) point at scale steps and are what density modes retune.

### Type

Typography is a fluid ramp built with `clamp()` so it scales with viewport without breakpoint-based font sizes. Sizes, line-heights, weights, and letter-spacing are bundled into composite `text.*` tokens — you consume a role, not a pile of loose values, which keeps long documents and dense tables internally consistent.

```ts
text.display // clamp(1.75rem, 1.4rem + 1.5vw, 2.25rem) / 1.1  / 600
text.heading // clamp(1.25rem, 1.1rem + 0.6vw, 1.5rem)   / 1.2  / 600
text.body.md // 0.875rem / 1.5 / 400        ← admin default
text.body.sm // 0.8125rem / 1.45 / 400
text.code // 0.8125rem / 1.5 / 450  (mono, tabular-nums)
text.label // 0.75rem / 1.3 / 500  (uppercase tracking)
```

The default UI font stack is a system stack (`ui-sans-serif, system-ui, …`) with an opt-in variable font; code and the `code` field type use `ui-monospace` with `font-variant-numeric: tabular-nums` so numeric columns in TanStack Table align.

## Theming primitives

A theme is a typed, partial override of the token tree. `@kernel/ui` exposes `defineTheme`, a `ThemeProvider`, and the resolution engine that flattens the cascade into CSS variables on a scoped root.

```ts
// @kernel/ui
import { defineTheme } from '@kernel/ui'

export const acme = defineTheme({
  name: 'acme',
  color: {
    accent: { hue: 268, chroma: 0.16 },
    bg: { canvas: { light: 'oklch(99% 0 0)', dark: 'oklch(16% 0.01 268)' } },
  },
  radius: { md: '10px' },
  font: { sans: '"Inter Variable", ui-sans-serif, system-ui' },
})
```

Resolution order, lowest to highest precedence:

```
default theme  →  config theme (kernel.config.ts)  →  plugin themes
               →  color mode (light|dark)  →  density (comfortable|compact)
               →  per-user prefs  →  inline component overrides
```

The engine resolves once on the server during SSR (TanStack Start) so the first paint already carries the correct variables — no flash of default theme. Mode and density toggles only swap a `data-` attribute on the root and rely on CSS variable cascades, so they never re-resolve the tree or re-render the React component graph. White-labeling is therefore a config concern, not a fork: brand, logo, favicon, accent, and radius are all token overrides, and the admin shell reads them the same way regardless of self-host or KernelCMS Cloud tenant.

Token values are validated at build time. An override that points a system token at a removed primitive, or supplies a malformed OKLCH string, fails the build rather than shipping a broken admin — the same end-to-end-type-safety tenet the rest of KernelCMS follows.

## Dark mode

Dark mode is a first-class color mode, not a filter. Every semantic color token carries both a `light` and a `dark` value; the resolver picks based on the active mode and writes the chosen value into the variable. Components never branch on mode — they read `color.bg.surface` and get the right thing.

```
:root[data-theme-mode="light"] { --k-color-bg-surface: oklch(100% 0 0); }
:root[data-theme-mode="dark"]  { --k-color-bg-surface: oklch(20% 0.01 268); }
```

Dark ramps are not inverted light ramps. They are authored as their own 12-step OKLCH scale so that the background→border→text progression keeps perceptually even steps and clears WCAG 2.2 AA at every text role. Elevation in dark mode is communicated by _lighter_ surfaces (raised panels move up the ramp) rather than shadows, which read poorly on dark backgrounds.

Mode selection respects `prefers-color-scheme` as the default, persists the user's explicit choice, and exposes a third `system` setting that re-follows the OS. The choice is stored per user and resolved during SSR to avoid a flash.

```ts
import { useColorMode } from '@kernel/ui'

const { mode, resolved, setMode } = useColorMode()
// mode: 'system' | 'light' | 'dark'   resolved: 'light' | 'dark'
setMode('dark')
```

Where Strapi and Payload essentially maintain two palettes, KernelCMS's mode contract is enforced by the type system: a custom theme that defines a light value for a token but omits the dark value is a type error, so you cannot ship a half-themed dark mode.

## Density modes

Density retunes spacing and control sizing without touching color or type roles. Two modes ship — `comfortable` (default) and `compact` — and they are pure remaps of the spacing aliases and control-height tokens. The data-heavy surfaces (TanStack Table list views, version-history panels, the media library grid) gain meaningful rows-per-screen in compact mode, which is exactly where editors managing thousands of documents feel the difference.

| Token                      | Comfortable      | Compact          |
| -------------------------- | ---------------- | ---------------- |
| `control.height.md`        | 36px             | 30px             |
| `space.field-y`            | `space.3` (12px) | `space.2` (8px)  |
| `space.gutter`             | `space.4` (16px) | `space.3` (12px) |
| `table.row.height`         | 44px             | 34px             |
| `text.body.md` line-height | 1.5              | 1.4              |

Density is a root `data-density` attribute, so toggling it is a single attribute write and a CSS cascade — no React re-render, no layout recomputation in JS. The 44px comfortable touch target satisfies the accessibility target-size rule; compact mode is gated behind a pointer/precision check and a user opt-in so it is never the default on touch devices. Neither Payload nor Sanity ships a built-in density switch; for KernelCMS it falls out of the token architecture for free because density only ever rebinds aliases, never primitives.

```ts
import { useDensity } from '@kernel/ui'

const { density, setDensity } = useDensity() // 'comfortable' | 'compact'
```

See [Theming & White-Labeling](./12-theming-and-white-label.md) for full brand-override recipes, Accessibility for the contrast and target-size budgets each token must satisfy, and Admin Architecture for how the resolver hooks into TanStack Start SSR.

## Open questions

- **Theme distribution format.** Should third-party themes ship as `@kernel/ui` `defineTheme` modules (typed, requires a build) or as a serializable JSON token document that KernelCMS Cloud can hot-swap per tenant without a deploy? Leaning toward both, with JSON as the portable interchange.
- **High-contrast and forced-colors.** Whether to ship a dedicated `contrast: 'more'` mode with its own ramp, or rely solely on `forced-colors` media handling. AA is guaranteed; AAA-on-demand is undecided.
- **Per-collection theming.** Allowing a collection or workspace to override accent/brand tokens (useful for multi-brand setups on one instance) is requested but risks visual incoherence; scoping rules are unresolved.
- **Density granularity.** Whether a third `cozy` step between comfortable and compact earns its keep, or whether two modes plus a global type-scale multiplier covers the need more cleanly.
