# Validation & Constraints

KernelCMS validates content at two levels — the **field**, where a single value is checked against its type and rules, and the **document**, where the whole record is checked for cross-field invariants. Validation is part of the operation core, not a separate layer bolted onto the admin panel. The same validators run in the Local API, REST, GraphQL, and typed RPC, so a value that survives one surface survives all of them. This document covers built-in validators, custom validators, async validation, and cross-field constraints, and explains how each is wired through `kernel.config.ts`.

## Where validation runs

Validation is server-side by default and on by default. The admin panel mirrors the same rules through TanStack Form for instant feedback, but the client check is an optimization, never the gate. Every write path re-runs validation before persistence.

```
create / update request
        │
        ▼
  access control (operation level)
        │
        ▼
  field validation ──► per-field validators (type + rules)
        │
        ▼
  document validation ──► cross-field validate() hook
        │
        ▼
  access control (field level)
        │
        ▼
  adapter.write (Drizzle / MongoDB)
```

A failed validator never reaches the adapter. Errors are collected, not thrown on first failure, so the client receives every problem in one response rather than fixing them one round-trip at a time. This is a deliberate difference from Strapi, whose default validation surfaces a single error per request and forces iterative correction.

## Built-in validators

Every field type in KernelCMS ships a default validator keyed to its semantics. You configure the common constraints declaratively on the field; `@kernel/core` compiles them into a validator function at config load. No imports, no boilerplate.

```ts
// kernel.config.ts
import { defineCollection } from '@kernel/core'

export const Products = defineCollection({
  slug: 'products',
  fields: [
    { name: 'title', type: 'text', required: true, minLength: 3, maxLength: 120 },
    { name: 'sku', type: 'text', required: true, unique: true, pattern: /^[A-Z]{3}-\d{4}$/ },
    { name: 'price', type: 'number', required: true, min: 0, max: 1_000_000 },
    { name: 'stock', type: 'number', min: 0, integer: true },
    { name: 'contact', type: 'email' },
    { name: 'launchDate', type: 'date', after: '2020-01-01' },
    { name: 'status', type: 'select', options: ['draft', 'active', 'retired'], required: true },
  ],
})
```

The declarative constraints map to validators per type:

| Field type     | Built-in constraints                                                |
| -------------- | ------------------------------------------------------------------ |
| `text`         | `required`, `minLength`, `maxLength`, `pattern`, `unique`          |
| `textarea`     | `required`, `minLength`, `maxLength`                                |
| `number`       | `required`, `min`, `max`, `integer`, `step`                        |
| `boolean`      | `required` (must be explicitly set)                                |
| `date`         | `required`, `before`, `after`                                       |
| `email`        | `required`, RFC-5322 shape, `unique`                               |
| `select`/`radio` | `required`, value ∈ `options`, `hasMany` cardinality             |
| `relationship` | `required`, target exists, `min`/`max` for `hasMany`               |
| `upload`       | `required`, `mimeTypes`, `maxFileSize`, target exists              |
| `array`        | `minRows`, `maxRows`                                                |
| `blocks`       | `minRows`, `maxRows`, block type ∈ allowed set                     |
| `json`/`code`  | `required`, JSON-schema or parse validity                          |
| `point`        | `required`, `[lng, lat]` range bounds                              |

`unique` constraints are pushed down to the database where the adapter supports it — a Drizzle unique index on Postgres/SQLite/MySQL, a unique index on MongoDB — so the guarantee holds even under concurrent writes, not just at the application layer. KernelCMS validates application-side first for a friendly error, then relies on the constraint as the race-safe backstop. Payload performs uniqueness as an application query, which leaves a thin window under concurrency; pushing the index down closes it.

Field-level localization interacts with built-in validators in the obvious way: a `required` localized field is validated per active locale, and you can require a value in the default locale while leaving translations optional. See [Localization](./09-localization-and-i18n.md) for the locale resolution rules.

## Custom validators

When declarative constraints aren't enough, attach a `validate` function to any field. It receives the value and a rich context, and returns `true` on success or a string message on failure. The signature is fully typed from `@kernel/core` against the field's value type — no `any`, no casting.

```ts
import type { FieldValidate } from '@kernel/core'

const validateSlug: FieldValidate<string> = (value, { siblingData, operation }) => {
  if (operation === 'create' && !value) return 'A slug is required on publish.'
  if (value && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    return 'Use lowercase words separated by single hyphens.'
  }
  return true
}

export const Posts = defineCollection({
  slug: 'posts',
  fields: [
    { name: 'title', type: 'text', required: true },
    { name: 'slug', type: 'text', validate: validateSlug },
  ],
})
```

The context object gives a custom validator everything it needs without reaching into globals:

| Context key   | Meaning                                                       |
| ------------- | ------------------------------------------------------------ |
| `siblingData` | The other fields in the same group/row/array item            |
| `data`        | The full incoming document                                   |
| `operation`   | `'create'` or `'update'`                                      |
| `req`         | Request context: `user`, `locale`, `t` (i18n), `payload` API |
| `id`          | Document id on update, `undefined` on create                 |
| `path`        | Dot-path to the field, e.g. `variants.2.price`               |

Returning a string rather than throwing keeps the error-collection model intact. Messages should run through `req.t` so they localize for the editor's admin locale — a detail Sanity leaves to you and Payload supports only partially. KernelCMS treats validator messages as first-class translatable strings.

A custom validator never replaces the built-in one — it runs after it. `required` and type-shape checks always fire first, so your function can assume the value is the declared type when present.

## Async validation

Validators may be async. Return a `Promise<true | string>` and KernelCMS awaits it. This is how you enforce constraints that need a database read, an external API call, or any I/O — the canonical case being conditional uniqueness or referential checks that the schema can't express.

```ts
const validateUniquePerTenant: FieldValidate<string> = async (value, { req, id, data }) => {
  if (!value) return true
  const existing = await req.payload.find({
    collection: 'invoices',
    where: {
      and: [
        { number: { equals: value } },
        { tenant: { equals: data.tenant } },
        ...(id ? [{ id: { not_equals: id } }] : []),
      ],
    },
    limit: 1,
    depth: 0,
  })
  return existing.docs.length === 0 || `Invoice number ${value} already exists for this tenant.`
}
```

Async validators run with the same query language (`where` / `sort` / `pagination` / `depth`) as the rest of KernelCMS, so the lookup above is identical whether the backend is Drizzle-on-Postgres or MongoDB. A few rules keep them sane in production:

- **Field-level async validators within a document run concurrently.** They're independent by contract, so KernelCMS fans them out with `Promise.all` and joins the results. Document-level validation waits for all of them.
- **Budget them.** Each async validator runs under the operation's performance budget; a slow external call is a slow write. Prefer pushing uniqueness to a DB index and reserving async validators for genuinely relational checks.
- **Debounced on the client.** TanStack Form runs async validators on blur, not per keystroke, and dedupes in-flight requests so the typed RPC endpoint isn't hammered. The authoritative run still happens server-side on submit.

In the admin panel, async field state surfaces as a pending indicator on the field via TanStack Form's validation status, with the loading/error/empty states the design system requires.

## Cross-field constraints

Single-field validators can't express rules that span fields — "end date must follow start date," "discount requires a coupon code." Those belong in a collection- or global-level `validate` hook that runs after every field has passed. It receives the assembled document and returns `true` or a `{ field, message }` list so errors attach to the right inputs in the UI.

```ts
import { defineCollection } from '@kernel/core'
import type { DocumentValidate } from '@kernel/core'

const validateEvent: DocumentValidate = ({ data }) => {
  const errors: { field: string; message: string }[] = []

  if (data.endsAt && data.startsAt && data.endsAt <= data.startsAt) {
    errors.push({ field: 'endsAt', message: 'End must be after start.' })
  }
  if (data.requiresApproval && !data.approver) {
    errors.push({ field: 'approver', message: 'Approver is required when approval is on.' })
  }
  return errors.length ? errors : true
}

export const Events = defineCollection({
  slug: 'events',
  validate: validateEvent,
  fields: [
    { name: 'startsAt', type: 'date', required: true },
    { name: 'endsAt', type: 'date', required: true },
    { name: 'requiresApproval', type: 'boolean' },
    { name: 'approver', type: 'relationship', relationTo: 'users' },
  ],
})
```

Returning structured `{ field, message }` errors is what makes cross-field validation usable in the admin. Sanity's validation can flag an arbitrary path, but Payload has no first-class document-level validator at all — cross-field rules get smuggled into field `validate` functions reading `siblingData`, which works for shallow cases and breaks down across tabs and groups. KernelCMS gives the document validator the full, depth-`0` data tree, so a rule comparing a field in `tabs[0]` with one in a nested `group` is straightforward.

Document validators are async-capable on the same terms as field validators, and they share the request context, so a cross-field rule can also hit the database (for example, validating that a chosen relationship doesn't violate a quota across sibling documents).

### Draft vs. publish

Validation severity depends on document status. Drafts save with relaxed rules so editors aren't blocked mid-work; the full constraint set is enforced on publish. Configure which validators are publish-only with `validateOn`:

```ts
{ name: 'seoDescription', type: 'textarea', required: true, validateOn: 'publish' }
```

This pairs with the drafts/versioning model in [Drafts & Versions](./10-versioning-drafts-and-autosave.md) — autosaved versions never fail on incomplete required fields, but the published revision must satisfy every constraint.

## Error shape

All validation errors share one wire format across REST, GraphQL, and RPC, so clients render them uniformly:

```ts
type ValidationError = {
  message: string            // top-level summary
  errors: {
    path: string             // 'variants.2.price'
    message: string          // localized via req.t
    code: 'required' | 'pattern' | 'unique' | 'custom' | string
  }[]
}
```

REST returns HTTP `422` with this body; GraphQL surfaces it in the `extensions` of a typed error; RPC rejects with the same typed shape so TanStack Query's `onError` and TanStack Form's field-error binding can consume it without translation.

## Open questions

- **JSON-schema field validation surface.** Whether `json`/`code` fields should accept a Zod schema, a raw JSON Schema, or both as escape hatches is undecided. Leaning toward Zod for type inference parity with the rest of `@kernel/core`.
- **Validator execution order guarantees.** Field-level async validators run concurrently today; we may expose an opt-in sequential mode for rules with side effects, though side-effecting validators are an anti-pattern we'd rather discourage than support.
- **Cross-document constraints.** Uniqueness and quotas across documents currently live in async validators. A declarative `constraints` block at the collection level (compiled to DB constraints where possible) is under consideration but risks leaking adapter-specific behavior.
