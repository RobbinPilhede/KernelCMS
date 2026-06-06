# Field Components & Rendering

The admin panel never reads your `kernel.config.ts` directly. Instead, the config compiles to a serializable **field schema**, and the rendering layer walks that schema, resolving each node to a React component through the **field component registry**. This document specifies how a `field` config becomes an interactive, validated, conditionally-visible control: the registry that maps types to components, how those components bind to TanStack Form, how `admin.condition` drives reactive visibility, and the override API that lets you replace any built-in component without forking `@kernel/admin`.

## From config to render tree

A document edit view is a tree, not a flat list. `array`, `blocks`, `group`, `tabs`, `row`, and `collapsible` are container fields — they nest other fields. Rendering is a depth-first walk that the admin performs once per document load, memoized against the field schema (which is static for the lifetime of the app).

```
kernel.config.ts ──compile──▶ FieldSchema[] (serializable)
                                     │
                          <DocumentForm> (TanStack Form)
                                     │
                            renderFields(schema, path)
                                     │
                 ┌───────────────────┼───────────────────┐
              FieldCell           FieldCell           ContainerCell
            (registry[type])    (registry[type])     (array/group/tabs)
                 │                                        │
            <TextField/>                          renderFields(children, path+i)
```

Every cell receives a stable **path** — `title`, `meta.seo.description`, `blocks.2.cta.label`. The path is the single identifier used for form state, validation, localization, access control, and live-preview targeting. This mirrors Payload's dotted field paths, but KernelCMS makes the path a typed `FieldPath<T>` derived from the collection's inferred document type, so a typo in a custom component is a compile error rather than a runtime `undefined`.

See [Document Forms](./06-document-edit-view.md) for the form lifecycle and [Collections](../02-data-modeling/01-collections.md) for the field config reference.

## The field component registry

The registry is a `Map<FieldType, FieldComponent>` plus a resolver. For any field node, the resolver picks a component in priority order:

| Priority | Source                                                   | Example                                |
| -------- | -------------------------------------------------------- | -------------------------------------- |
| 1        | `admin.components.Field` on the field config             | A bespoke color picker on one field    |
| 2        | A registered **custom field type**                       | `field('rating')` → your `RatingField` |
| 3        | A `kernel.config.ts` global override for a built-in type | Replace every `text` field app-wide    |
| 4        | The built-in `@kernel/ui` component                      | Default `TextField`, `SelectField`, …  |

This four-tier fallback is the core difference from Strapi, whose custom field plugins must register against a fixed set of extension points and ship a Webpack/Vite plugin, and from Sanity, where the equivalent is `components.input` inside the schema. KernelCMS keeps all four tiers in one registry so a single resolver call answers "what renders this node?" with no special cases.

Built-in registrations cover every type in the data model:

```ts
// @kernel/ui — the default registry (excerpt)
import { defineRegistry } from '@kernel/admin'

export const defaultFieldRegistry = defineRegistry({
  text: TextField,
  textarea: TextareaField,
  number: NumberField,
  boolean: BooleanField,
  date: DateField,
  email: EmailField,
  json: JsonField,
  code: CodeField,
  point: PointField,
  select: SelectField,
  radio: RadioField,
  checkbox: CheckboxField,
  relationship: RelationshipField,
  upload: UploadField,
  array: ArrayField,
  blocks: BlocksField,
  group: GroupField,
  tabs: TabsField,
  row: RowField,
  richText: RichTextField,
  ui: UIField,
})
```

A `FieldComponent` has a fixed, typed contract. It never receives the whole form — only what it needs to render and write one field:

```ts
// @kernel/admin
export interface FieldComponentProps<TValue = unknown, TConfig = FieldConfig> {
  path: FieldPath // 'meta.seo.title'
  config: TConfig // the compiled field config (label, required, admin, …)
  value: TValue
  onChange: (next: TValue) => void
  onBlur: () => void
  errors: FieldError[] // resolved validation errors for this path
  disabled: boolean // from access control or condition
  locale: string | null // active locale for localized fields
}

export type FieldComponent<V = unknown> = (props: FieldComponentProps<V>) => JSX.Element
```

Components are looked up by reference and rendered through a thin `<FieldCell>` wrapper that owns the label, description, required marker, error region, and the localization tab strip — so individual components stay focused on the control itself. Registration is open: `@kernel/plugin-sdk` plugins call `registry.register(type, component)` during admin boot, which is how the editor, media library, and third-party field packs add their own types.

## TanStack Form binding

KernelCMS uses **TanStack Form** as the single source of truth for the edit view. The document is one form instance; every field component is bound through a `useField` subscription keyed by its path. This is deliberate: TanStack Form's per-field subscriptions mean typing in the `title` field re-renders only the `title` cell, not the 60 other fields on a content-heavy document. Payload and Strapi both lean on broader context re-renders here; on large documents the virtualized-plus-granular model is measurably faster.

The binding is hidden inside `<FieldCell>`, so component authors never wire TanStack Form by hand:

```ts
// @kernel/admin — FieldCell (simplified)
function FieldCell({ schema, parentPath }: FieldCellProps) {
  const path = joinPath(parentPath, schema.name)
  const Component = useFieldComponent(schema)     // registry resolution
  const visible = useFieldCondition(schema, path) // see "Conditional fields"

  const field = useField({
    name: path,
    validators: toTanStackValidators(schema.validate), // sync + async + cross-field
  })

  if (!visible) return null

  return (
    <FieldLabelShell config={schema} errors={field.state.meta.errors}>
      <Component
        path={path}
        config={schema}
        value={field.state.value}
        onChange={field.handleChange}
        onBlur={field.handleBlur}
        errors={field.state.meta.errors}
        disabled={useFieldAccess(path).readOnly}
        locale={useActiveLocale(schema)}
      />
    </FieldLabelShell>
  )
}
```

Validation is layered. The field config's `validate` functions — the same ones the server runs — are adapted into TanStack Form validators so the admin gives immediate, optimistic feedback, then the server re-validates on save as the authority. Async validators (uniqueness, remote checks) run debounced on blur via TanStack Form's `onChangeAsync`/`onBlurAsync`; cross-field validators receive the full form values so a `endDate` field can assert it is after `startDate`. Errors flow back keyed by path, which is why `errors` in the props contract is already scoped to the component.

Container fields bind to **array/list APIs** rather than scalar state. `ArrayField` and `BlocksField` use TanStack Form's array helpers (`pushValue`, `removeValue`, `moveValue`) for add/remove/reorder, and wrap their rows in **TanStack Virtual** so a 500-row repeater renders only the visible window. Each row recursively calls `renderFields` with `parentPath` extended by the row index.

## Conditional fields

Field visibility is declarative. `admin.condition` is a pure function of the current document and the active user; the admin subscribes a field's visibility to exactly the paths the condition reads.

```ts
// kernel.config.ts
fields: [
  field('select', {
    name: 'layout',
    options: ['standard', 'landing', 'longform'],
  }),
  field('upload', {
    name: 'hero',
    relationTo: 'media',
    admin: {
      // Only landing pages get a hero image
      condition: (doc) => doc.layout === 'landing',
    },
  }),
  field('group', {
    name: 'seo',
    admin: {
      condition: (doc, { user }) => user.roles.includes('editor'),
    },
    fields: [
      /* … */
    ],
  }),
]
```

The compiler statically analyzes each `condition` body to record which paths it touches (with a runtime fallback that subscribes to the whole document if analysis is inconclusive). `useFieldCondition` then subscribes via TanStack Store and TanStack Form's selective `useStore`, so toggling `layout` re-evaluates only conditions that depend on `layout`. Compare Payload, where conditions re-run against a context value; KernelCMS's path-scoped subscriptions keep conditional logic cheap even on documents with hundreds of fields.

Two semantics matter and are fixed by design:

- **Hidden ≠ deleted.** A hidden field keeps its value in form state and is still submitted. Hiding is a UI concern; pruning data is the job of access control and `beforeChange` hooks. This avoids the Strapi/Sanity footgun where conditional UI accidentally implies conditional persistence.
- **Conditions never gate security.** A `condition` can hide a field, but server-side **field-level access control** is the enforcement boundary. The `disabled` prop in the component contract is sourced from access control, never from `condition`. See [Access Control](../06-auth-security/01-authorization-and-access-control.md).

## The custom field override API

There are two distinct extension points, and conflating them is the most common mistake.

**1. Override one field's component** — keep the built-in type and data shape, swap only the React control. Set `admin.components.Field`:

```ts
field('text', {
  name: 'brandColor',
  admin: {
    components: {
      Field: ColorPickerField, // a FieldComponent you wrote
      Cell: ColorSwatchCell, // optional: list-view (TanStack Table) cell
    },
  },
})
```

`ColorPickerField` receives the standard `FieldComponentProps` — `value`, `onChange`, `onBlur`, `errors` — so it is a controlled input with zero knowledge of TanStack Form internals. The optional `Cell` overrides how the value renders in the collection list, which `@kernel/admin` builds on TanStack Table.

**2. Register a new field type** — a reusable type with its own config, validation, and storage mapping. This is the path for shipping a field via `@kernel/plugin-sdk`:

```ts
// @kernel/plugin-sdk
import { defineFieldType } from '@kernel/plugin-sdk'

export const rating = defineFieldType<number, { max?: number }>({
  type: 'rating',
  Field: RatingField, // FieldComponentProps<number>
  Cell: RatingStarsCell,
  defaultValue: () => 0,
  // How this field maps onto the storage adapter (Drizzle / Mongo)
  column: ({ config }) => integer({ check: `value <= ${config.max ?? 5}` }),
  // Shared across REST, GraphQL, RPC, and admin
  validate: (value, { config }) => (value >= 0 && value <= (config.max ?? 5) ? true : 'Rating out of range'),
  graphQLType: 'Int',
})
```

Registering through `defineFieldType` is what separates KernelCMS from a pure UI override: the new type is known to the **whole stack** — schema diffing and migrations (`@kernel/db`), REST/GraphQL generation (`@kernel/rest`, `@kernel/graphql`), the typed RPC client (`@kernel/client`), and the admin — not just the React layer. Sanity custom inputs and Strapi custom fields stop at the editor; here, one definition propagates type, validation, persistence, and API surface together.

Both extension points respect the engineering tenets: components are typed against the field's inferred value (`FieldComponentProps<number>`, no `any`), and the built-in is always reachable as an escape hatch — import `TextField` from `@kernel/ui` and wrap it rather than reimplement label, error, and localization plumbing.

### Server vs. client components

`Field` and `Cell` are client components (`"use client"`) — they bind to TanStack Form and run in the browser. Anything expensive or secret (fetching options from a privileged source, computing derived data) belongs in a TanStack Start **server function** that the component calls through TanStack Query, never inline in render. The registry only ever holds client-renderable components; server work is a data dependency, not a rendering concern.

## Open questions

- **Condition path analysis fallback.** Static analysis of `condition` bodies covers member-access patterns; dynamic access (`doc[key]`) currently forces a whole-document subscription. Whether to require an explicit `dependencies: ['layout']` array for those cases, or accept the conservative fallback, is undecided.
- **Async field component code-splitting.** Heavy editors (code, richText, map/point) should lazy-load. Open question whether the registry stores `React.lazy` wrappers by default or leaves splitting to the component author.
- **Cell vs. Field config unification.** Today `Field` and `Cell` are separate overrides. We may collapse them into a single `components` object with a shared value formatter to avoid duplicated rendering logic between edit and list views.
