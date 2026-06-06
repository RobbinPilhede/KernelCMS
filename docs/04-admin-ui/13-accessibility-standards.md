# Admin Accessibility Standards

The KernelCMS admin is a tool people use for hours every day, often with assistive technology. We treat WCAG 2.2 AA as a build-time contract, not a post-launch audit. Accessibility is wired into `@kernel/ui` primitives, enforced in CI, and surfaced to plugin authors through the same component API everyone else uses. Payload and Strapi ship admin UIs that are *mostly* keyboard-usable but carry known gaps in focus management and dynamic-region announcements; Sanity Studio is the strongest of the three but still leaves custom input authors to solve ARIA themselves. KernelCMS pushes the conformance guarantees down into the primitive layer so that a correctly-built field is accessible by construction.

## WCAG 2.2 AA targets

We commit to the full WCAG 2.2 Level A and AA success criteria for the admin shell, every built-in field type, the rich-text editor, the media library, and live preview. The bar is the same for first-party UI and for plugin-contributed UI — `@kernel/plugin-sdk` field components inherit the same primitives, so they pass or fail by the same rules.

The criteria we treat as highest-leverage and most frequently regressed:

| Criterion | Level | What it means in the admin |
| --- | --- | --- |
| 1.4.3 Contrast (Minimum) | AA | Every design token pairing meets 4.5:1 body / 3:1 large text |
| 1.4.11 Non-text Contrast | AA | Input borders, focus rings, icon buttons meet 3:1 against adjacent color |
| 2.1.1 Keyboard | A | Every operation reachable and operable without a pointer |
| 2.4.7 Focus Visible | AA | `:focus-visible` ring on every interactive element |
| 2.4.11 Focus Not Obscured | AA | Sticky headers / toolbars never cover the focused control |
| 2.5.7 Dragging Movements | AA | Array/blocks reordering has a keyboard alternative |
| 2.5.8 Target Size (Minimum) | AA | Interactive targets ≥ 24×24 CSS px (we ship 44px) |
| 3.3.7 Redundant Entry | A | Multi-step flows don't re-ask for known data |
| 4.1.2 Name, Role, Value | A | Custom widgets expose correct ARIA semantics |
| 4.1.3 Status Messages | AA | Saves, validation, and autosave announce via live regions |

2.5.7, 2.5.8, 2.4.11, and 3.3.7 are new in 2.2 and are exactly where reorderable arrays, blocks, and sticky document toolbars tend to break — so they get explicit test coverage rather than relying on a generic audit pass.

Contrast is enforced at the token level, not per-component. `@kernel/ui` validates the theme on boot in development and white-label themes are checked the same way (see [White-label theming](./12-theming-and-white-label.md)):

```ts
// kernel.config.ts
import { defineConfig } from '@kernel/core'
import { theme, contrastGuard } from '@kernel/ui'

export default defineConfig({
  admin: {
    theme: theme({
      tokens: {
        color: {
          fg: { default: '#11181c', muted: '#5c6770' },
          bg: { default: '#ffffff', subtle: '#f4f5f6' },
          accent: { default: '#2f6fed', fg: '#ffffff' },
          focusRing: '#2f6fed',
        },
        // 44px hit targets, not the 24px WCAG floor
        control: { minTargetPx: 44 },
      },
      // Fails the dev server boot if any declared pairing < required ratio
      plugins: [contrastGuard({ enforce: 'AA', failOn: 'build' })],
    }),
  },
})
```

`contrastGuard` resolves every `fg`/`bg` and `fg`/`accent` pairing the design system can produce, computes the ratio, and refuses to start the dev server when a pairing fails. That turns 1.4.3 and 1.4.11 from a manual review item into a hard build error — neither Payload nor Strapi enforces contrast against their theming layer this way.

## Keyboard and focus management

Everything is operable from the keyboard, and nothing depends on a pointer. The command palette (`Cmd/Ctrl+K`) is the keyboard spine of the admin: navigation, document actions, locale switching, and publishing all route through it, so power users never need the mouse.

Focus management is the part that breaks silently, so we centralize it. `@kernel/ui` ships `FocusScope`, `useRovingFocus`, and `useFocusReturn` and the admin shell uses them for every overlay. TanStack Router drives navigation, and we hook route transitions to move focus deterministically rather than leaving it on a stale element.

```
Document edit route: focus lifecycle
───────────────────────────────────────────────
 route enter ──▶ move focus to <h1> doc title (tabindex=-1)
                 announce "Editing {title}" via polite region
 open dialog ──▶ FocusScope traps; first focusable or labelled
                 element receives focus
 close dialog ─▶ useFocusReturn restores the trigger element
 save (Cmd+S) ─▶ focus stays put; status region announces result
 validation ───▶ focus jumps to first invalid field, error linked
                 via aria-describedby
```

Rules the admin shell guarantees:

- **Modal dialogs** use the native `<dialog>` element with `FocusScope`. Tab cycles within the dialog, `Escape` closes and returns focus to the trigger. No focus ever lands behind the backdrop.
- **Route changes** move focus to the new view's top-level heading (`tabindex="-1"`), never silently to `<body>`. TanStack Router's `onLoad` integration fires the announcement.
- **Roving tabindex** is used for the collection list (TanStack Table rows), the blocks toolbar, tabs fields, and the command palette results — one tab stop in, arrow keys to traverse.
- **Validation failures** move focus to the first invalid field and wire the message with `aria-describedby` + `aria-invalid`. TanStack Form's per-field state feeds this directly.
- **Keyboard reorder** satisfies 2.5.7: every drag-reorderable surface (array rows, blocks, relationship ordering) exposes a "grab" control that responds to arrow keys with live-region position announcements.

```tsx
// Keyboard reordering inside an array field — drag is an enhancement, not the only path
import { useReorder, LiveRegion } from '@kernel/ui'

function ArrayRowHandle({ index, total, onMove }: ArrayRowHandleProps) {
  const { handleProps, announce } = useReorder({
    index,
    total,
    onMove,
    label: (i, n) => `Row ${i + 1} of ${n}. Use arrow keys to reorder.`,
  })

  return (
    <button
      type="button"
      aria-roledescription="sortable item"
      {...handleProps} // role, aria-label, keydown for ArrowUp/ArrowDown/Home/End
    >
      <span aria-hidden="true">⠿</span>
      <LiveRegion politeness="assertive" message={announce} />
    </button>
  )
}
```

The blocks editor and rich-text editor get extra scrutiny: text-selection, inline formatting (`Cmd+B`/`Cmd+I`), and block insertion are all keyboard-driven, and the slash-menu is a roving-focus listbox, not a `div` soup.

## ARIA patterns

We follow the WAI-ARIA Authoring Practices for every composite widget and we prefer native HTML first — `<button>`, `<dialog>`, `<details>`, real `<label>`/`<input>` associations — before reaching for ARIA. ARIA is added only where the platform has no native equivalent. This is where most CMS admin bugs live: a custom select built from `<div onclick>` that a screen reader can't operate.

The fixed mapping from KernelCMS UI surface to ARIA pattern:

| Admin surface | Native / ARIA pattern | Key attributes |
| --- | --- | --- |
| Command palette | `combobox` + `listbox` | `aria-expanded`, `aria-activedescendant`, `aria-controls` |
| `select` / `radio` field | native `<select>` / `radiogroup` | grouped, labelled, keyboard-native |
| `tabs` field | `tablist` / `tab` / `tabpanel` | `aria-selected`, `aria-controls`, roving tabindex |
| Collection list (TanStack Table) | `grid` | `aria-sort` on sortable columns, `aria-rowcount` |
| Blocks slash-menu | `listbox` | `aria-activedescendant`, typeahead |
| Media library grid | `grid` + multiselect | `aria-multiselectable`, `aria-selected` |
| Autosave / publish status | `status` live region | `aria-live="polite"`, `role="status"` |
| Validation summary | `alert` live region | `aria-live="assertive"`, `role="alert"` |
| Live preview iframe | labelled region | `title`, `aria-label` describing the frame |

Status messages (4.1.3) are the criterion teams forget. KernelCMS routes every async outcome — autosave ticks, save success, publish, draft restore, validation errors — through a single live-region manager so announcements are consistent and never dropped:

```ts
// @kernel/ui live-region manager — one polite + one assertive region for the whole shell
import { announce } from '@kernel/ui'

// Autosave + publish (non-disruptive, polite)
announce('Draft saved', { politeness: 'polite' })
announce('Published to production', { politeness: 'polite' })

// Validation + failures (interrupts, assertive)
announce('3 fields need attention', { politeness: 'assertive' })
```

Because the field config is the source of truth, ARIA naming is derived from it. A field's `label`, `required`, `admin.description`, and validation state are mapped onto `aria-label`/`aria-describedby`/`aria-required`/`aria-invalid` automatically — plugin authors using `@kernel/plugin-sdk` get correct semantics without writing ARIA at all. i18n and RTL flow through the same path: `dir` is set from the active locale and announcements are localized (see Internationalization).

## The testing approach

Accessibility is verified at three layers, and all three run in CI. We do not rely on manual audits to catch regressions; manual testing exists to find what automation can't.

```
┌──────────────────────────────────────────────────────────┐
│ 3. Manual / AT pass (per release)                        │
│    NVDA+Firefox, VoiceOver+Safari, keyboard-only,        │
│    200% zoom, forced-colors, prefers-reduced-motion      │
├──────────────────────────────────────────────────────────┤
│ 2. Component + E2E (every PR)                            │
│    axe-core via @axe-core/playwright on every story      │
│    + critical flows; keyboard-only Playwright scripts    │
├──────────────────────────────────────────────────────────┤
│ 1. Static (every commit)                                 │
│    eslint-plugin-jsx-a11y, token contrastGuard,          │
│    TypeScript ARIA prop types                            │
└──────────────────────────────────────────────────────────┘
```

1. **Static** — `eslint-plugin-jsx-a11y` runs on every commit; `contrastGuard` fails the build on token violations; `@kernel/ui` component props are typed so an invalid `role`/`aria-*` combination is a compile error.
2. **Automated component + E2E** — every `@kernel/ui` and admin component story runs through `axe-core` (via `@axe-core/playwright`). Zero serious/critical violations is a merge gate. On top of that, Playwright scripts drive critical flows — create a document, edit a blocks field, reorder an array, publish — using keyboard input only, asserting focus order and live-region text.

```ts
// e2e/a11y/document-edit.spec.ts
import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

test('document edit view has zero AA violations and keyboard reorder works', async ({ page }) => {
  await page.goto('/admin/collections/posts/new')

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag22aa'])
    .analyze()
  expect(results.violations).toEqual([])

  // Reorder array rows with the keyboard only — no pointer
  await page.getByRole('button', { name: /sortable item/i }).first().focus()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('status')).toContainText('Row 2 of')
})
```

3. **Manual and assistive-technology** — before each release, a human runs the admin with NVDA on Firefox and VoiceOver on Safari, keyboard-only, at 200% zoom, in Windows High Contrast (`forced-colors`), and with `prefers-reduced-motion`. This is the only way to catch announcement *quality* (does "Row 2 of 5" actually make sense in context) and reduced-motion compliance, which automation can flag but not judge.

Findings feed back into fixtures: any AT bug becomes a Playwright regression test before it's fixed, so the same defect can't return. This is the practical difference from Payload and Strapi — accessibility there is a quality goal pursued by maintainers; in KernelCMS the AA gate is a CI requirement that blocks merges, and the guarantees live in primitives every plugin reuses.

## Open questions

- **Conformance scope for embedded preview targets.** Live preview renders the *user's* frontend inside an iframe; we can guarantee the admin chrome around it but not the previewed site. Do we surface a non-blocking axe report for the preview frame, or stay silent to avoid implying we audit user content?
- **AA vs. AAA opt-in.** Some teams (public sector) need AAA contrast (7:1). Should `contrastGuard` accept `enforce: 'AAA'` as a supported tier, or document it as best-effort only?
- **Third-party rich-text plugins.** Custom block components from `@kernel/plugin-sdk` inherit primitives, but an author can still inject raw DOM. Do we run axe against registered plugin components at build time, or only warn?
