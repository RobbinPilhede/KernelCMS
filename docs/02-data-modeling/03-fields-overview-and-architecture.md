# Fields: Overview & Architecture

Fields are the atom of the KernelCMS data model. A collection or global is just an ordered list of field definitions, and almost everything the system does — generating the Drizzle schema, building the REST/GraphQL surface, rendering the admin form, running validation and access control — is derived mechanically from those definitions. This document specifies the field definition shape, the lifecycle a field value moves through on every operation, the split between data fields and presentational fields, and the hook-in points for custom field types. It assumes you've read [Collections](./01-collections.md) and [Globals](./02-globals-and-singletons.md).

## The field definition shape

A field is a plain object. There is no class to extend, no decorator, no registration step for the built-in types. You import `field` builders from `@kernel/core` (or write the object literal directly) and place them in a collection's `fields` array.

```ts
// kernel.config.ts
import { defineConfig, collection } from '@kernel/core'

export default defineConfig({
  collections: [
    collection({
      slug: 'posts',
      fields: [
        { name: 'title', type: 'text', required: true, localized: true },
        { name: 'slug', type: 'text', required: true, unique: true, index: true },
        {
          name: 'excerpt',
          type: 'textarea',
          maxLength: 280,
          admin: { description: 'Shown in listings and social cards.' },
        },
        {
          name: 'author',
          type: 'relationship',
          relationTo: 'users',
          required: true,
        },
        {
          name: 'body',
          type: 'richText',
          editor: 'blocks',
        },
      ],
    }),
  ],
})
```

Every field shares a common base contract, then narrows by `type`. The base is the part that the schema generator, the API layer, and the admin all agree on:

| Property | Type | Applies to | Purpose |
| --- | --- | --- | --- |
| `name` | `string` | data fields | Storage key and API property. Omitted on presentational fields. |
| `type` | `FieldType` | all | Discriminant. Drives storage column, validator, and React input. |
| `label` | `string \| Record<Locale, string>` | all | Admin label. Defaults to a humanized `name`. |
| `required` | `boolean` | data fields | Non-null at the storage and validation layer. |
| `unique` | `boolean` | scalar data fields | Adds a unique constraint to the generated migration. |
| `index` | `boolean \| IndexConfig` | scalar data fields | Generates a btree (or adapter-specific) index. |
| `localized` | `boolean` | data fields | Stores a value per configured locale. |
| `defaultValue` | `T \| (args) => T \| Promise<T>` | data fields | Static or computed default, run server-side. |
| `validate` | `(value, ctx) => true \| string \| Promise<...>` | data fields | Custom sync/async/cross-field validation. |
| `access` | `FieldAccess` | data fields | `read`/`create`/`update` predicates at field granularity. |
| `hooks` | `FieldHooks` | data fields | Lifecycle hooks (see below). |
| `admin` | `FieldAdminConfig` | all | Description, `condition`, `width`, `position`, custom components. |

The crucial design choice — and where KernelCMS diverges from Payload — is that the type is a **discriminated union keyed on `type`**, fully inferred. `relationTo` only exists when `type` is `'relationship'` or `'upload'`; `options` only exists on `'select'`/`'radio'`; `fields` only exists on the container types `'array'`, `'group'`, `'row'`, `'tabs'`, `'blocks'`. There is no `any` anywhere in the field tree, and the inferred document type is computed from the field array via mapped types in `@kernel/core`:

```ts
import type { InferDoc } from '@kernel/core'

type Post = InferDoc<typeof postsCollection>
//   ^? { title: string; slug: string; excerpt?: string;
//        author: string | User; body: RichTextValue; ... }
```

Sanity models with GROQ and a separate schema language; Strapi stores field metadata in JSON and reads it at runtime. KernelCMS keeps the field array as the single typed source and derives both the TypeScript shape and the runtime behavior from it, so the editor's autocomplete and the database column can never drift.

### Container fields and nesting

`array`, `blocks`, `group`, `row`, `tabs` hold child `fields`. `row` and `tabs` are layout-only for the admin and flatten at storage time; `group` namespaces its children under one key; `array` and `blocks` produce repeatable rows. Nesting is unbounded and the type inference recurses, so a `blocks` field inside an `array` inside a `tab` is still fully typed end to end. See [Field Types](./04-field-types-catalog.md) for the per-type reference.

## The field lifecycle

Every field value flows through the same ordered pipeline on every operation. The pipeline is symmetric: inbound on writes, outbound on reads. This is the contract custom fields plug into, and it's where KernelCMS earns its "server-side, on by default" tenet.

```
WRITE (create / update)                READ (find / findByID)
  ┌────────────────────────┐             ┌────────────────────────┐
  │ 1. access.create/update│             │ 1. db read (adapter)   │
  │ 2. beforeValidate hook  │             │ 2. afterRead hook       │
  │ 3. validate             │             │ 3. access.read (filter) │
  │ 4. beforeChange hook    │             │ 4. relationship populate│
  │ 5. serialize → adapter  │             │ 5. localization resolve │
  │ 6. db write (adapter)   │             │ 6. deserialize → client │
  │ 7. afterChange hook      │             └────────────────────────┘
  └────────────────────────┘
```

A few rules make this predictable:

- **Access runs first and last.** On write, a failed `access.create`/`access.update` predicate strips the field from the incoming payload before validation — an unauthorized field can't even produce a validation error. On read, `access.read` runs *after* the value is loaded and removes it from the response. This is the resource- and field-level authorization the brief requires, evaluated in the operation core, never in the client.
- **Validation sees the whole document.** The `validate(value, ctx)` signature receives `ctx.data` (the full incoming doc), `ctx.siblingData` (the immediate parent object, important inside `array`/`group`), `ctx.operation`, `ctx.req`, and `ctx.locale`. Cross-field rules ("`publishedAt` required when `status === 'published'`") are expressed naturally without a separate schema pass.
- **Serialization is the adapter boundary.** A field's logical value (`point` → `{ lat, lng }`, `richText` → a JSON document, `date` → a JS `Date`) is serialized to the adapter's storage representation by the field's `serialize`/`deserialize` pair. The Postgres/SQLite/MySQL Drizzle adapters and the MongoDB adapter each get the same logical value and decide how to persist it. A field type never writes SQL.

```ts
// validate sees siblings and the full doc — cross-field is first-class
{
  name: 'publishedAt',
  type: 'date',
  validate: (value, { siblingData }) =>
    siblingData.status !== 'published' || value != null
      ? true
      : 'publishedAt is required once the post is published',
}
```

Hooks fire in a fixed order and may be async. `beforeChange` is where you compute derived storage (slugify a title, stamp `updatedBy`); `afterRead` is where you shape outbound values (sign an upload URL). Because hooks live on the field, they travel with the field when it's reused across collections — Strapi's lifecycle hooks live on the model, not the field, so the same transform must be re-wired per content type. See [Hooks](../08-extensibility/02-hooks-and-lifecycle.md) for the collection-level counterparts.

## Data fields vs. presentational fields

KernelCMS draws a hard line between fields that own a value and fields that only affect the admin UI.

| | Data field | Presentational field |
| --- | --- | --- |
| Has `name` | Yes (required) | No |
| Generates a column / API property | Yes | No |
| Runs validation / access / hooks | Yes | No |
| Appears in `InferDoc<T>` | Yes | No |
| Examples | `text`, `relationship`, `array`, `blocks` | `ui`, `row`, `tabs` (the layout shells) |

The `ui` field is the canonical presentational type: it renders an arbitrary React component in the form — a callout, a "generate slug" button, a computed summary — but contributes nothing to storage, the API, or the inferred type.

```ts
{
  type: 'ui',
  name: 'previewBanner', // name here is a React key only, not a storage key
  admin: {
    components: {
      Field: () => <PreviewBanner />,
    },
  },
}
```

This split keeps the schema generator honest: it iterates the field tree, skips anything without a storage `name`, and never has to special-case "is this a real column?" mid-generation. Payload conflates the two more than we'd like (its `ui` field still carries a `name`); KernelCMS treats presentational fields as a distinct branch of the union so they can't accidentally leak into a migration. `row` and `tabs` are a hybrid — presentational at the storage layer (they flatten) but containers of data fields, so their *children* still produce columns.

## Custom field hook-in points

There are four escalating levels of customization, and you should reach for the lowest one that solves the problem.

1. **Override the input component only.** Keep a built-in `type` but swap its admin component. Cheapest path — storage, validation, and API are unchanged.

   ```ts
   {
     name: 'color',
     type: 'text',
     admin: { components: { Field: ColorPicker } },
   }
   ```

2. **Compose with hooks and validate.** Reshape values on the way in/out and add rules without a new type. Covers most "field that behaves differently" needs.

3. **Register a custom field type.** When you need a genuinely new storage shape (a `currency` with amount + ISO code, a `geojson` polygon), define a `FieldType` via the `@kernel/plugin-sdk`. A custom type supplies the four contracts the core needs and nothing more:

   ```ts
   import { defineFieldType } from '@kernel/plugin-sdk'

   export const currency = defineFieldType<CurrencyValue>({
     type: 'currency',
     // 1. how it persists, per adapter kind
     schema: ({ adapter }) =>
       adapter.kind === 'mongodb'
         ? { bsonType: 'object' }
         : adapter.columns({ amount: 'integer', code: 'varchar(3)' }),
     // 2. logical <-> storage
     serialize: (v) => ({ amount: v.minorUnits, code: v.currency }),
     deserialize: (row) => ({ minorUnits: row.amount, currency: row.code }),
     // 3. default validation baked into the type
     validate: (v) => (v.minorUnits >= 0 ? true : 'amount must be non-negative'),
     // 4. admin input + cell renderer
     admin: { Field: CurrencyInput, Cell: CurrencyCell },
   })
   ```

   Registered types are first-class: they get TanStack Table cells, TanStack Form bindings, and full type inference into `InferDoc<T>` exactly like built-ins.

4. **Ship a field as a plugin.** Bundle the type, its migration logic, and admin components in a `@kernel/plugin-sdk` package so other projects install it with one import. This is how third-party `slug`, `seo`, or `color` fields are distributed.

The contract is deliberately narrow — `schema`, `serialize`/`deserialize`, `validate`, `admin` — so a custom field can't reach into the request pipeline or the database directly. That boundary is what lets the same custom type run unchanged across the Postgres default, SQLite, MySQL, and MongoDB adapters, and across the REST, GraphQL, and typed RPC surfaces. Sanity's custom inputs are admin-only and don't describe storage; Strapi custom fields require separate server and admin plugins wired by hand. KernelCMS asks for one object.

## Open questions

- **Field-level migration hints.** When a registered custom type changes its `schema` shape across versions, should the type author supply an `up`/`down` migration callback, or do we rely entirely on Drizzle schema diffing plus a manual data backfill? Leaning toward an optional `migrate` hook on `defineFieldType`.
- **Computed (virtual) data fields.** A field that appears in `InferDoc<T>` and the API but has no column, resolved by an `afterRead` hook. This blurs the data/presentational line cleanly defined above; we may introduce a third `virtual: true` flag rather than a new field category.
- **Per-locale validation severity.** Whether `validate` should be able to return warnings (non-blocking) distinct from errors, and how that surfaces in the TanStack Form binding.
