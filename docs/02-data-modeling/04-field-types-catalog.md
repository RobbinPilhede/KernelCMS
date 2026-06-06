# Field Types Catalog

This is the complete reference for every built-in field type in KernelCMS: what it does, the config surface it exposes, how it maps to storage across the SQL and MongoDB adapters, and where it differs from the equivalents in Payload, Sanity, and Strapi. Field types are the atoms of collections and globals. They compose into structural fields — `array`, `blocks`, `group`, `tabs`, `row` — covered separately in Structural Fields. Everything below is fully typed: the `@kernel/core` field builders infer a document type from your `kernel.config.ts`, and that inferred type flows unchanged into the REST, GraphQL, and RPC surfaces.

## The shared field shape

Every field, scalar or structural, extends one base contract. Knowing it once means you know it for all of them.

```ts
interface BaseField<TValue> {
  name: string // column / property key; must be unique within its level
  label?: string | LabelFn // admin label; defaults to a humanized name
  required?: boolean // server-enforced on create/update
  unique?: boolean // adapter-level unique index
  index?: boolean // adapter-level secondary index
  localized?: boolean // per-locale storage; see Localization
  defaultValue?: TValue | (() => TValue | Promise<TValue>)
  validate?: Validator<TValue> // sync or async, runs after type coercion
  access?: FieldAccess // read/create/update, evaluated server-side
  admin?: FieldAdminConfig // condition, width, description, components
  hooks?: FieldHooks<TValue> // beforeValidate / beforeChange / afterRead
}
```

Two design choices to call out. First, `validate` is a real function, not a JSON schema fragment — Payload and KernelCMS agree here, but Sanity's `validation: (Rule) => Rule.required()` builder and Strapi's attribute-level JSON constraints are strictly less expressive because they can't reach sibling field values without an escape hatch. KernelCMS validators receive `{ data, siblingData, operation, req }`, so cross-field rules are first-class. Second, `access` is per-field and evaluated server-side on read and write; a field the caller can't read is stripped from the payload before it leaves the process, not hidden in the client.

## Scalar fields

Scalars are the single-value primitives. They are the ones you reach for ninety percent of the time.

### `text`

A single-line string. Maps to `varchar`/`text` on SQL and `string` on MongoDB.

```ts
import { text } from '@kernel/core/fields'

text({
  name: 'title',
  required: true,
  unique: true,
  maxLength: 200,
  admin: { placeholder: 'Untitled' },
})
```

`minLength` / `maxLength` are enforced server-side and also surfaced as `maxLength` on the rendered TanStack Form input. On Postgres a `maxLength` becomes `varchar(n)`; without it you get unbounded `text`.

### `textarea`

Identical storage to `text`, but the admin renders a multi-line control. Use it for plain multi-paragraph content where you do not want the `richText` editor's structure.

### `number`

Stored as `numeric`/`double precision` on SQL and `number` on MongoDB. Supports `min`, `max`, and `hasMany` (an ordered numeric array).

```ts
number({ name: 'priceUSD', min: 0, admin: { step: 0.01 } })
```

KernelCMS keeps `number` as a true numeric column rather than Strapi's split `integer` / `biginteger` / `decimal` / `float` attribute zoo. Precision is a column option, not a separate field type:

```ts
number({ name: 'ledgerCents', precision: { mode: 'integer' } }) // bigint column
```

### `boolean`

A nullable tri-state by default (`true` / `false` / `null`). Set `required: true` and a `defaultValue` to make it a hard two-state. Renders as a switch.

```ts
boolean({ name: 'featured', defaultValue: false, required: true })
```

## Specialized scalars: `date`, `email`, `json`, `code`, `point`

These carry extra semantics, validation, or storage handling beyond a raw primitive.

### `date`

Stored as `timestamptz` on Postgres (always UTC), `text` ISO-8601 on SQLite, and a native `Date` on MongoDB. The admin picker mode is config-driven and does not change storage.

```ts
date({
  name: 'publishedAt',
  admin: { date: { pickerAppearance: 'dayAndTime', timeFormat: 'HH:mm' } },
  defaultValue: () => new Date(),
})
```

Pick one rule and hold it: KernelCMS stores instants in UTC and renders in the editor's locale/timezone. We do not store naive wall-clock times. If you need a date-only field (a birthday, with no timezone), set `admin.date.pickerAppearance: 'dayOnly'` and the value is normalized to midnight UTC.

### `email`

A `text` column with a built-in RFC-validating `validate` you can extend. The point is the semantic tag — REST/GraphQL expose it as an `EmailAddress` scalar, and the admin renders a `type="email"` input with the correct keyboard on mobile.

```ts
email({ name: 'contact', unique: true })
```

### `json`

Arbitrary JSON. Maps to `jsonb` on Postgres, `json` on MySQL, `text` (serialized) on SQLite, and a native subdocument on MongoDB. You can attach a JSON Schema for editor validation and typing.

```ts
import type { FromSchema } from '@kernel/core'

const schema = {
  type: 'object',
  properties: { theme: { enum: ['light', 'dark'] } },
  required: ['theme'],
} as const

json<FromSchema<typeof schema>>({ name: 'preferences', jsonSchema: schema })
```

With a schema the field is typed; without one it is `unknown` (never `any` — you narrow it yourself). This is stricter than Strapi's untyped `json` attribute and closer in spirit to Sanity's typed objects, but without forcing you to declare a named object type.

### `code`

A `text` column rendered with a syntax-highlighted Monaco editor in the admin. `language` drives highlighting only; it never changes storage.

```ts
code({ name: 'snippet', admin: { language: 'ts', editorHeight: 320 } })
```

### `point`

Geospatial. Stored as PostGIS `geography(Point)` when the Postgres adapter detects the extension (falling back to two `double precision` columns otherwise), and as GeoJSON `{ type: 'Point', coordinates: [lng, lat] }` on MongoDB, which can back a `2dsphere` index. Payload and Strapi both lack a first-class geo type; this is a genuine KernelCMS advantage for store-locator and proximity use cases.

```ts
point({ name: 'location', index: true }) // value: [lng, lat]
```

## Choice fields: `select`, `radio`, `checkbox`

All three model a constrained set of options. The difference is cardinality and presentation, not storage philosophy.

| Field      | Cardinality              | Admin control             | Storage                               |
| ---------- | ------------------------ | ------------------------- | ------------------------------------- |
| `select`   | single or `hasMany`      | dropdown / multi-combobox | `text`, or `text[]` / join when many  |
| `radio`    | always single            | radio group               | `text`                                |
| `checkbox` | single boolean _or_ many | checkbox(es)              | `boolean`, or `text[]` when `options` |

```ts
select({
  name: 'status',
  options: [
    { label: 'Draft', value: 'draft' },
    { label: 'In review', value: 'review' },
    { label: 'Published', value: 'published' },
  ],
  defaultValue: 'draft',
  hasMany: false,
})
```

Options are typed: the example above narrows the document field to `'draft' | 'review' | 'published'`, not `string`. For `hasMany`, multi-value storage is adapter-specific — `text[]` on Postgres, a serialized array on SQLite, and a native array on MongoDB. When you need the values queryable and joinable, prefer a `relationship` to a lookup collection over a fat multi-select; selects are for closed, code-owned enumerations that rarely change.

`radio` and a single `select` are storage-identical; choose by ergonomics — `radio` when all options should be visible at once (three to five), `select` beyond that.

A bare `checkbox` (no `options`) is just a styled boolean. With `options` it becomes a multi-checkbox group backed by an array, which is the idiomatic way to render a small fixed taxonomy inline.

## `ui` and virtual fields

These two never write a column. They exist for the admin and for derived data respectively, and keeping them out of storage is deliberate.

### `ui` — presentational only

A `ui` field renders a custom React component in the edit form and is omitted from every API response and the database schema entirely. Use it for callouts, computed previews, action buttons, or section dividers.

```ts
ui({
  name: 'slugPreview',
  admin: { components: { Field: '@/admin/SlugPreview' } },
})
```

Payload's `ui` field is the direct analog. The KernelCMS difference is that the component reference is a module specifier resolved through the admin bundler, so it survives white-label theming and lazy-loads via the same TanStack Router boundary as the rest of the form.

### Virtual fields — computed, not stored

A virtual field is read-only and derived at read time. It declares its TypeScript type and a resolver; it produces no column and cannot be written through any API.

```ts
text({
  name: 'fullName',
  virtual: true,
  hooks: {
    afterRead: [({ data }) => `${data.firstName} ${data.lastName}`],
  },
})
```

```
                 stored columns                derived
   ┌──────────────┬──────────────┐       ┌──────────────┐
   │ firstName    │ lastName     │  ──▶  │ fullName      │
   └──────────────┴──────────────┘       └──────────────┘
        persisted                          afterRead only
```

Virtual fields participate in `select` projection and GraphQL field resolution but are excluded from `where` and `sort` unless you back them with a generated/stored column (an Open question below). This is cleaner than Strapi, which has no native virtual concept, and more explicit than Sanity's GROQ projections, which compute on every query with no schema declaration.

## The complete catalog

| Field          | Category       | SQL storage             | MongoDB storage     | `hasMany` | Localizable | Notes                                                                     |
| -------------- | -------------- | ----------------------- | ------------------- | :-------: | :---------: | ------------------------------------------------------------------------- |
| `text`         | scalar         | `varchar`/`text`        | `string`            |    yes    |     yes     | `minLength`/`maxLength`                                                   |
| `textarea`     | scalar         | `text`                  | `string`            |    no     |     yes     | multi-line input only                                                     |
| `number`       | scalar         | `numeric`/`double`      | `number`            |    yes    |     yes     | `min`/`max`/`precision`                                                   |
| `boolean`      | scalar         | `boolean`               | `bool`              |    no     |     yes     | nullable tri-state                                                        |
| `date`         | specialized    | `timestamptz`           | `Date`              |    no     |     yes     | stored UTC                                                                |
| `email`        | specialized    | `text`                  | `string`            |    yes    |     yes     | RFC-validated, `EmailAddress` scalar                                      |
| `json`         | specialized    | `jsonb`                 | object              |    no     |     yes     | optional JSON Schema typing                                               |
| `code`         | specialized    | `text`                  | `string`            |    no     |     yes     | Monaco editor                                                             |
| `point`        | specialized    | `geography(Point)`      | GeoJSON Point       |    no     |     no      | PostGIS / `2dsphere`                                                      |
| `select`       | choice         | `text` / `text[]`       | `string` / array    |    yes    |     yes     | typed enum                                                                |
| `radio`        | choice         | `text`                  | `string`            |    no     |     yes     | single only                                                               |
| `checkbox`     | choice         | `boolean` / `text[]`    | `bool` / array      |    yes    |     yes     | bool or multi-option                                                      |
| `relationship` | relational     | FK / join table         | ObjectId(s)         |    yes    |     yes     | see Relationships                                                         |
| `upload`       | relational     | FK to media collection  | ObjectId            |    yes    |     yes     | see [Media & Uploads](../07-media-files/00-media-and-uploads-overview.md) |
| `richText`     | rich           | `jsonb`                 | object              |    no     |     yes     | block AST, see RichText                                                   |
| `array`        | structural     | rows in child table     | array of objects    |    n/a    |     yes     | see Structural Fields                                                     |
| `blocks`       | structural     | rows + `blockType`      | discriminated array |    n/a    |     yes     | tagged union                                                              |
| `group`        | structural     | inlined / nested object | nested object       |    n/a    |   partial   | namespacing                                                               |
| `tabs`         | structural     | inlined per tab         | nested              |    n/a    |     n/a     | layout + namespacing                                                      |
| `row`          | layout         | none (layout only)      | none                |    n/a    |     n/a     | admin layout                                                              |
| `ui`           | presentational | none                    | none                |    n/a    |     n/a     | render-only                                                               |
| custom         | extension      | adapter-defined         | adapter-defined     |  varies   |   varies    | via Plugin SDK                                                            |

Custom field types register through `@kernel/plugin-sdk`: you provide a Drizzle/Mongo column mapping, a Zod-or-function validator, an admin component, and the REST/GraphQL serialization. They are not second-class — every built-in scalar above is itself implemented against the same public contract.

## Open questions

- **Virtual field querying.** Should `virtual: true` optionally compile to a Postgres `GENERATED ALWAYS AS ... STORED` column so it can be indexed, sorted, and filtered? That ties the resolver to SQL-expressible logic and has no MongoDB equivalent. Leaning toward an opt-in `stored: true` flag that the SQL adapters honor and the MongoDB adapter rejects at config-load time.
- **`point` without PostGIS.** The two-column fallback can't answer radius queries. Do we hard-require the extension when any `point` field is present, or silently degrade and document the limitation? Current bias is to fail fast at migration time with a clear remediation message.
- **`select` option migrations.** Renaming an option `value` is a data migration, not a schema diff. We need a declarative `renameOption` step in the migration generator rather than leaving it to hand-written SQL.
