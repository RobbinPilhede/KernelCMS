# Custom Fields

KernelCMS ships the standard field library — `text`, `number`, `relationship`, `richText`, `blocks`, and the rest — but real projects always outgrow it. A color picker, a geospatial bounding box, a Stripe price selector, a slug that derives from a sibling field: these are field types, not workarounds. A custom field in KernelCMS is a single object that bundles four concerns — how the value is stored, how it is validated and transformed on the server, how it renders in the admin, and how it registers into the config. This document specifies all four and shows the full authoring loop end to end.

## The field type definition

A field type is the unit of extension. It is **not** just a React component (Sanity), and **not** a server plugin plus a separate admin plugin you wire by name (Strapi). In KernelCMS the data shape and the UI travel together in one `defineFieldType` call, so the type system can infer the stored value from the definition and propagate it through REST, GraphQL, the RPC client, and the generated TypeScript types.

```ts
// fields/color/index.ts
import { defineFieldType } from '@kernel/core'
import { z } from 'zod'
import { ColorInput } from './ColorInput'

export const color = defineFieldType({
  name: 'color',
  // The persisted shape. This is the single source of truth for the value type.
  schema: z.object({
    hex: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    alpha: z.number().min(0).max(1).default(1),
  }),
  // How the value maps onto a column / document path per adapter.
  storage: {
    sql: { kind: 'jsonb' }, // Postgres/MySQL: one jsonb column
    sqlite: { kind: 'json-text' }, // SQLite/libSQL: TEXT holding JSON
    mongo: { kind: 'embedded' }, // MongoDB: embedded sub-document
  },
  // Admin component contract (see "The admin component").
  admin: { component: ColorInput },
})
```

`defineFieldType` returns a typed factory. Authors call it inside a collection with field-instance options, and TanStack Form, TanStack Table, and the query layer all see the same inferred type.

```ts
// kernel.config.ts
import { defineConfig, defineCollection } from '@kernel/core'
import { color } from './fields/color'

export default defineConfig({
  collections: [
    defineCollection({
      slug: 'themes',
      fields: [
        { name: 'name', type: 'text', required: true },
        color({ name: 'accent', required: true, defaultValue: { hex: '#2563eb', alpha: 1 } }),
      ],
    }),
  ],
})
```

### Anatomy

| Key               | Purpose                                                         | Required |
| ----------------- | --------------------------------------------------------------- | -------- |
| `name`            | Unique type identifier used in config and the registry          | yes      |
| `schema`          | Zod schema for the persisted value; drives the inferred TS type | yes      |
| `storage`         | Per-adapter persistence strategy                                | yes      |
| `admin.component` | React component rendered in the document editor                 | yes      |
| `validate`        | Server-side validation hook (sync or async)                     | no       |
| `transform`       | `beforeChange` / `afterRead` value coercion                     | no       |
| `index`           | Index hints emitted into generated migrations                   | no       |
| `graphql`         | Custom GraphQL type/scalar mapping override                     | no       |
| `cell`            | TanStack Table cell renderer for list views                     | no       |

The `schema` is the keystone. Because it is a real Zod schema, KernelCMS derives `z.infer` for the stored value and threads it through `@kernel/client`, the Local API, and the generated `kernel-types.d.ts`. There is no second place to declare the type — contrast Strapi, where the schema JSON, the controller types, and the admin component props are three disconnected declarations you keep in sync by hand.

## Server validation and storage

Everything that affects data integrity runs on the server, inside the same operation core the Local API and RPC use. The admin component never decides whether a value is valid for persistence — it only proposes.

### Validation

`validate` runs after the `schema` parse succeeds, on every create and update, regardless of surface (REST, GraphQL, RPC, Local API). It receives the parsed value plus an operation context, so it can do cross-field and async checks.

```ts
validate: async (value, ctx) => {
  // value is already z.infer<typeof schema> — schema-invalid values never reach here.
  if (ctx.operation === 'create' && value.alpha < 0.1) {
    return 'Accent colors must be at least 10% opaque.'
  }
  // Cross-field: read a sibling value from the in-flight document.
  const bg = ctx.siblingData.background as { hex: string } | undefined
  if (bg && bg.hex === value.hex) {
    return 'Accent must differ from background.'
  }
  return true // true == valid; a string == the error message
}
```

The context surface:

| Field               | Meaning                                                     |
| ------------------- | ----------------------------------------------------------- |
| `ctx.operation`     | `'create'` or `'update'`                                    |
| `ctx.siblingData`   | Sibling field values in the same group/document             |
| `ctx.data`          | The full incoming document                                  |
| `ctx.req`           | Request context: authenticated user, locale, adapter handle |
| `ctx.previousValue` | Stored value before this operation (update only)            |

This mirrors Payload's field `validate` signature deliberately — teams migrating from Payload will recognize it — but KernelCMS guarantees the value is already schema-parsed, so you never re-validate primitive shape. See [Access Control](../06-auth-security/01-authorization-and-access-control.md) for how field-level access composes with validation; access denial short-circuits before `validate` runs.

### Transforms

Storage and presentation rarely use the same shape. `transform.beforeChange` normalizes the incoming value before it hits the adapter; `transform.afterRead` reshapes the stored value on its way out.

```ts
transform: {
  beforeChange: (value) => ({ ...value, hex: value.hex.toLowerCase() }),
  afterRead: (value) => ({ ...value, css: `${value.hex}${alphaToHex(value.alpha)}` }),
}
```

```
write path:  admin/API → schema.parse → validate → beforeChange → adapter.write
read  path:  adapter.read → afterRead → serialize → REST/GraphQL/RPC → client
```

`afterRead` is the right place to add computed, non-persisted projections (here, a ready-to-use `css` string). Keep `beforeChange` deterministic — it runs inside the write transaction.

### Storage mapping

The `storage` block tells each adapter how to materialize the value. KernelCMS resolves the active adapter at build time and the migration generator emits the correct DDL from the diff.

| Adapter               | `kind` options                  | Notes                                                                                                       |
| --------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `@kernel/db-postgres` | `jsonb`, `text`, `column-group` | `jsonb` is default for structured values; `column-group` explodes the object into real columns for indexing |
| `@kernel/db-mysql`    | `json`, `text`, `column-group`  | same model on MySQL JSON                                                                                    |
| `@kernel/db-sqlite`   | `json-text`, `text`             | JSON stored as TEXT; expression indexes via `json_extract`                                                  |
| `@kernel/db-mongodb`  | `embedded`, `reference`         | embedded sub-document or a referenced doc id                                                                |

For fields that must be queried or sorted, prefer `column-group` so `where` and `sort` hit native columns instead of JSON extraction. Declare index intent in the definition and let the generator handle the rest:

```ts
index: { on: ['hex'], type: 'btree' },
```

The generated migration for Postgres `column-group` storage looks like:

```sql
-- generated by `kernel migrate generate`
ALTER TABLE "themes" ADD COLUMN "accent_hex" varchar(7) NOT NULL;
ALTER TABLE "themes" ADD COLUMN "accent_alpha" real NOT NULL DEFAULT 1;
CREATE INDEX "themes_accent_hex_idx" ON "themes" USING btree ("accent_hex");
```

This is the Drizzle-backed difference from Sanity, whose custom types are document-shaped and queried only through GROQ — KernelCMS gives a custom field a real, indexable home in a relational schema when you want one, or stays schemaless on MongoDB when you don't. See Database Adapters for the full `Adapter` contract a `storage.kind` resolves against.

## The admin component

The admin component is a controlled React component bound to TanStack Form. It receives a typed `field` handle and is responsible only for editing UX — it proposes values; the server decides.

```tsx
// fields/color/ColorInput.tsx
import { useFieldComponent } from '@kernel/admin'
import type { FieldComponentProps } from '@kernel/admin'
import { z } from 'zod'
import { color } from './index'

type ColorValue = z.infer<typeof color.schema>

export function ColorInput(props: FieldComponentProps<ColorValue>) {
  // Binds to the surrounding TanStack Form instance; no manual wiring.
  const field = useFieldComponent<ColorValue>(props)

  return (
    <div className="kc-field" role="group" aria-labelledby={field.labelId}>
      <label id={field.labelId} htmlFor={field.inputId}>
        {field.label}
      </label>
      <input
        id={field.inputId}
        type="color"
        value={field.value?.hex ?? '#000000'}
        onChange={(e) => field.setValue({ ...field.value, hex: e.target.value, alpha: field.value?.alpha ?? 1 })}
        onBlur={field.handleBlur}
        aria-invalid={field.errors.length > 0}
        aria-describedby={field.errors.length ? field.errorId : undefined}
      />
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={field.value?.alpha ?? 1}
        onChange={(e) => field.setValue({ ...field.value!, alpha: Number(e.target.value) })}
        aria-label="Opacity"
      />
      {field.errors.length > 0 && (
        <p id={field.errorId} className="kc-field-error" role="alert">
          {field.errors[0]}
        </p>
      )}
    </div>
  )
}
```

`useFieldComponent` is the bridge to TanStack Form. It exposes:

| Member                                      | Type                   | Purpose                                      |
| ------------------------------------------- | ---------------------- | -------------------------------------------- |
| `value` / `setValue`                        | `T` / `(v: T) => void` | controlled value binding                     |
| `errors`                                    | `string[]`             | merged client + server validation messages   |
| `handleBlur`                                | `() => void`           | triggers validate-on-blur, not per-keystroke |
| `disabled`                                  | `boolean`              | resolved from access control + draft state   |
| `locale`                                    | `string`               | active locale for localized fields           |
| `label` / `inputId` / `labelId` / `errorId` | `string`               | accessibility wiring (WCAG 2.2 AA)           |

Two rules the standard library enforces and custom fields should too: validate on blur (not every keystroke), and never render inline styles — use the design tokens from [@kernel/ui](../04-admin-ui/12-theming-and-white-label.md) so the field inherits dark mode and white-label themes. For long repeatable values, wrap rows in TanStack Virtual; the editor already virtualizes long documents, and a custom field that renders an unbounded list without it will blow the performance budget.

Sanity's strength is bespoke input components, and KernelCMS matches that ergonomics — but here the same definition that produces this component also produced the Zod schema, the migration, and the RPC type. You author the editing experience without re-describing the data three times.

### List cell rendering

A field can also render itself in the TanStack Table list view via the optional `cell` renderer. Keep it cheap — it runs per visible row.

```tsx
cell: ({ value }: { value: ColorValue }) => (
  <span className="kc-color-swatch" style={{ background: value.hex }} aria-label={value.hex} />
)
```

## Registration

Custom fields register through the config, never through global side effects. There is no implicit autoloading of an `admin/` folder the way Strapi scans plugins; registration is explicit and typed, which keeps tree-shaking honest and makes the field set reproducible across self-host and KernelCMS Cloud.

```ts
// kernel.config.ts
import { defineConfig } from '@kernel/core'
import { color } from './fields/color'
import { slug } from './fields/slug'

export default defineConfig({
  fields: [color, slug], // registers types into the schema + admin registry
  collections: [
    /* ... */
  ],
})
```

Registering a field does three things at build time:

```
defineConfig({ fields })
   ├─ server registry  → validation + storage + migration generation
   ├─ admin registry   → component mounted by the editor for type === name
   └─ type generation  → kernel-types.d.ts updated for client + RPC
```

The server bundle and admin bundle resolve the same definition but tree-shake the halves they don't need: the React component is stripped from the server build, and the validation/storage internals are stripped from the admin build. Because the definition is one object, there is no risk of the two registries drifting — a class of bug endemic to CMSes that split server schema and admin component into separate registration calls.

Distributable field packages follow the same shape; ship a `@kernel/plugin-*` that exports field definitions and register them identically. See [Plugin SDK](./01-plugin-sdk-and-authoring.md) for packaging and the [Admin Components](./04-custom-admin-components-and-slots.md) guide for overriding built-in field UI without defining a new type.

## Open questions

- **Async validation debounce contract.** Server `validate` is authoritative, but should the admin run async validators live (debounced) against an RPC endpoint, or only on blur/submit? Live validation improves UX but adds load and needs per-field rate limiting.
- **`column-group` migration safety.** Promoting a `jsonb` field to `column-group` on an existing table is a backfill, not a pure DDL diff. The generator should detect this and emit a guarded data migration rather than a plain `ALTER`.
- **Field-level versioning granularity.** Custom transforms run on read; whether `afterRead` output should be diffed into version history, or only the persisted pre-transform value, is unresolved. See [Versioning](../02-data-modeling/10-versioning-drafts-and-autosave.md).
