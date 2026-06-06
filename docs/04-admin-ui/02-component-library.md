# Component Library

The admin panel is assembled from `@kernel/ui`, a single component library that every screen, field, and plugin draws from. It is shipped as a headless core paired with a default styled layer, so KernelCMS owns the same primitives whether you use the stock admin, override one field, or white-label the whole thing. This document specifies the primitive inventory, the composition patterns that turn primitives into screens, the headless/styled split that makes overrides safe, and the accessibility contract baked into every component.

## Where `@kernel/ui` sits

`@kernel/ui` is the visual substrate. `@kernel/admin` consumes it to build the document edit view, collection list view, media library, and command palette. Plugins built against `@kernel/plugin-sdk` import the same components, so a third-party field renders with identical focus rings, spacing, and dark-mode behavior as a core field — no visual drift.

```
@kernel/ui  (headless primitives + styled layer + tokens)
    │
    ├── @kernel/admin   list view, edit view, media library, command palette
    ├── @kernel/richtext block editor toolbar, popovers, marks
    └── plugins (@kernel/plugin-sdk)  custom fields, custom views
```

Payload ships a React component set but couples it tightly to its own admin runtime; Sanity exposes `@sanity/ui` as a genuinely reusable primitive library; Strapi's design system (`@strapi/design-system`) is the closest analog. KernelCMS follows the Sanity/Strapi model — a real, documented, versioned library — but goes further by making every primitive headless-first and wired to TanStack from the ground up rather than bolted on.

## The primitives inventory

Primitives are the leaf components. They have no knowledge of collections, documents, or the API — they render and emit events. They split into five groups.

| Group           | Primitives                                                                                                                 | Notes                                                         |
| --------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Layout          | `Box`, `Stack`, `Inline`, `Grid`, `Card`, `Divider`, `Container`                                                           | Token-driven spacing only; no raw pixels in props             |
| Typography      | `Text`, `Heading`, `Label`, `Code`, `KeyboardKey`                                                                          | `text-wrap: balance` on headings, `pretty` on body            |
| Forms           | `Input`, `Textarea`, `Select`, `Combobox`, `Checkbox`, `Radio`, `Switch`, `Slider`, `DatePicker`, `ColorField`, `FileDrop` | Each pairs with a `Field` wrapper for label/error/description |
| Overlays        | `Dialog`, `Drawer`, `Popover`, `Tooltip`, `Menu`, `Toast`, `CommandPalette`                                                | All built on a shared focus-trap + dismiss layer              |
| Feedback & data | `Button`, `IconButton`, `Badge`, `Avatar`, `Spinner`, `Skeleton`, `ProgressBar`, `Table`, `VirtualList`, `Tabs`, `Tree`    | `Table`/`VirtualList` wrap TanStack Table + Virtual           |

Two primitives carry most of the admin's weight and deserve specifics.

`Table` is a thin, styled binding over TanStack Table. It does not own state — it accepts a `table` instance so the collection list view controls sorting, column sizing, and row selection while syncing them to URL search params via TanStack Router.

```tsx
import { Table } from '@kernel/ui'
import { useReactTable, getCoreRowModel } from '@tanstack/react-table'

const table = useReactTable({
  data: rows,
  columns,
  getCoreRowModel: getCoreRowModel(),
  state: { sorting, columnSizing, rowSelection },
  onSortingChange: setSorting, // setSorting writes to router search params
  manualSorting: true, // server does the sort via the shared query language
})

return <Table table={table} virtualized estimateRowHeight={44} />
```

`Field` is the contract every form input honors. It owns the label, description, error, and required affordances, and wires `aria-describedby`/`aria-invalid` so individual inputs never reinvent labeling.

```tsx
import { Field, Input } from '@kernel/ui'
;<Field label="Slug" description="URL-safe identifier" error={errors.slug} required>
  {(props) => <Input {...props} value={value} onChange={onChange} />}
</Field>
```

The render-prop hands down the generated `id`, `aria-describedby`, and `aria-invalid`, so the input cannot drift out of sync with its label. This is the seam the field-component system in [field components](./07-field-components-and-rendering.md) builds on.

## Composition patterns

Primitives compose into three tiers. The discipline is that each tier knows only the tier below it — admin features never reach past `@kernel/ui` into raw DOM, and plugins never reach past the composition tier into private internals.

```
Screens        EditView · ListView · MediaLibrary · CommandPalette
   ▲
Compositions   FieldRenderer · Toolbar · DataGrid · FilterBar · Form
   ▲
Primitives     Input · Button · Dialog · Table · Popover · …
```

### Slot-based composition over prop explosion

Components accept slots, not a growing pile of boolean props. A `Card` takes `header`, `media`, and `footer` slots; a `Dialog` takes `title`, `body`, and `actions`. This is how we avoid the `showHeaderWithIconAndBadge` prop sprawl that creeps into long-lived design systems.

```tsx
<Dialog>
  <Dialog.Title>Delete “{doc.title}”?</Dialog.Title>
  <Dialog.Body>This removes the published version and all drafts.</Dialog.Body>
  <Dialog.Actions>
    <Button variant="ghost" onClick={close}>
      Cancel
    </Button>
    <Button variant="danger" onClick={confirm}>
      Delete
    </Button>
  </Dialog.Actions>
</Dialog>
```

### Compound components share state implicitly

`Tabs`, `Menu`, `Combobox`, and `Tree` use React context internally so consumers compose markup without threading state by hand. The parent owns roving-tabindex and open/close; children subscribe.

```tsx
<Tabs defaultValue="content">
  <Tabs.List aria-label="Document sections">
    <Tabs.Trigger value="content">Content</Tabs.Trigger>
    <Tabs.Trigger value="seo">SEO</Tabs.Trigger>
    <Tabs.Trigger value="versions">Versions</Tabs.Trigger>
  </Tabs.List>
  <Tabs.Panel value="content">
    <FieldRenderer fields={contentFields} />
  </Tabs.Panel>
  <Tabs.Panel value="seo">
    <FieldRenderer fields={seoFields} />
  </Tabs.Panel>
</Tabs>
```

The `tabs` field type from the brief maps directly onto this compound component, so config-defined tabs and admin-internal tabs use the same accessible implementation.

### Forms compose through TanStack Form

The `Form` composition binds primitives to TanStack Form. Per-field binding and validation flow through `form.Field`; the `@kernel/ui` input is the dumb leaf that renders the bound state. Validation timing follows the project rule — validate on blur, not on every keystroke — and async/cross-field validation surfaces through the same `Field` error slot.

```tsx
const form = useForm({ defaultValues: doc, onSubmit: save })

<form.Field name="title" validators={{ onBlur: required }}>
  {(field) => (
    <Field label="Title" error={field.state.meta.errors[0]} required>
      {(props) => (
        <Input
          {...props}
          value={field.state.value}
          onBlur={field.handleBlur}
          onChange={(e) => field.handleChange(e.target.value)}
        />
      )}
    </Field>
  )}
</form.Field>
```

### Data-fetching stays out of components

No primitive or composition calls the API. Screens use TanStack Query and hand data down as props. This keeps `@kernel/ui` pure, testable, and reusable on marketing sites or the `@kernel/client` consumer side, not just the admin. Loading, error, and empty states are first-class — `Skeleton`, an error `Card`, and an empty-state slot — because every async screen must render all three.

## Headless plus styled split

Each interactive primitive ships in two layers: a **headless** behavior hook/part with zero opinion on appearance, and a **styled** component that applies KernelCMS design tokens on top. You can consume the styled component, restyle it via tokens, or drop to the headless layer when you need a fully custom look while keeping the accessibility behavior.

```
┌─────────────────────────────────────────────┐
│ styled  <Combobox/>      tokens + default CSS │  ← most consumers stop here
├─────────────────────────────────────────────┤
│ headless useCombobox()   a11y + keyboard +    │  ← drop here for full custom UI
│                          state, no styling    │
└─────────────────────────────────────────────┘
```

```tsx
// Styled: the default, fully themed
import { Combobox } from '@kernel/ui'
;<Combobox options={authors} value={authorId} onChange={setAuthorId} />

// Headless: same keyboard nav, focus management, and ARIA — your markup
import { useCombobox } from '@kernel/ui/headless'
function CustomAuthorPicker() {
  const cb = useCombobox({ options: authors, value: authorId, onChange: setAuthorId })
  return (
    <div {...cb.getRootProps()}>
      <input {...cb.getInputProps()} />
      {cb.isOpen && (
        <ul {...cb.getListProps()}>
          {cb.options.map((o) => (
            <li key={o.id} {...cb.getOptionProps(o)}>
              {o.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
```

This split is the core differentiator. Payload lets you swap field components but you inherit its admin's look; overriding deeply means fighting its CSS. Strapi's design system is styled-first and harder to fully restyle. Sanity's `@sanity/ui` is well-factored but opinionated about its own aesthetic. KernelCMS guarantees that the behavior — keyboard handling, focus order, ARIA wiring — lives in the headless layer and is never lost when you restyle, so white-label theming never sacrifices accessibility.

### Theming through tokens, not overrides

The styled layer reads exclusively from CSS custom properties. White-labeling is a token override, not a CSS-specificity war.

```ts
// kernel.config.ts
export default defineConfig({
  admin: {
    theme: {
      tokens: {
        'color.accent': '#5b2be3',
        'color.bg.canvas': '#0d0d10',
        'radius.control': '8px',
        'font.sans': 'Inter, system-ui, sans-serif',
      },
      darkMode: 'class', // class | media | force-dark | force-light
    },
  },
})
```

Concentric border-radius, fluid `clamp()` spacing, and the full color ramp derive from these tokens, so changing `radius.control` keeps nested radii visually correct. See [theming and tokens](./12-theming-and-white-label.md) for the full token reference.

## Accessibility baked in

Accessibility is a property of the headless layer, which means it cannot be styled away. The targets are WCAG 2.2 AA, including i18n with RTL, matching the brief. Every primitive is tested against the same checklist.

| Concern  | Guarantee                                                                                                                    |
| -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Focus    | `:focus-visible` rings only (keyboard, not mouse click); logical focus order; focus trap + return on every overlay           |
| Keyboard | All interactive primitives operable without a pointer; `Menu`/`Tabs`/`Tree`/`Combobox` use roving tabindex and arrow-key nav |
| ARIA     | Roles, `aria-*`, and live regions wired in headless hooks; `Field` owns `aria-describedby`/`aria-invalid`                    |
| Contrast | Token ramps validated to ≥ 4.5:1 text, ≥ 3:1 UI; enforced in CI against the token file                                       |
| Motion   | All transitions specify exact properties; `prefers-reduced-motion: reduce` honored globally                                  |
| RTL      | Logical properties (`margin-inline`, `padding-block`) everywhere; `dir` flips layout without per-component work              |
| Targets  | 44px minimum interactive target on touch                                                                                     |

Overlays share one dismiss-and-trap layer, so `Dialog`, `Drawer`, `Popover`, and `CommandPalette` all handle `Escape`, outside-click, scroll-lock, and focus return identically. The command palette — central to the keyboard-first UX in [navigation and shell](./03-navigation-and-app-shell.md) — is just `CommandPalette` built on that layer, announced to screen readers as a live combobox.

Accessibility regressions are caught mechanically: every primitive carries `axe` assertions in its test suite, and contrast is recomputed from the token file on each CI run so a theme change cannot silently drop below AA. Tests assert behavior — keyboard reachability, correct ARIA, focus return — not internal markup, so restyling never breaks the suite.

## Open questions

- **Styling engine.** Token-driven CSS Modules vs. a zero-runtime compiler (e.g. vanilla-extract / Panda). Both satisfy the no-runtime-CSS-in-JS rule; the decision hinges on plugin-author ergonomics and bundle cost.
- **Headless surface area.** Whether to expose headless hooks for _every_ primitive or only the complex interactive ones (`Combobox`, `Menu`, `Tree`, overlays). Exposing all increases the public API we must keep stable across majors.
- **Icon strategy.** Ship a curated icon set in `@kernel/ui` vs. depend on an external set vs. let consumers inject icons via a provider. Affects bundle size and white-label flexibility.
- **`@kernel/ui` outside the admin.** How much of the library to guarantee as stable for use on public frontends via `@kernel/client`, versus treating it as an admin-internal contract.
