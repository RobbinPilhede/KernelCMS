# Content templates

A **content template** is a reusable document skeleton — a landing-page block layout, a
standard article shell, a pre-filled campaign brief — that an editor can instantiate in one
click. Instead of starting every new document from an empty form (and re-building the same
hero/feature/CTA layout each time, or forgetting the house-style fields), you define the
skeleton once and give editors a "New from template" that pre-fills a fresh document with
sensible defaults — with all your access rules and validation still intact.

A template is *just defaults*: it pre-fills a normal create. Everything that makes a create
safe — access control, field scope, validation, the agent draft-only brake — still applies,
because creating from a template **is** a create.

## Opt in

Templates are off until you declare them. Add a `templates` array to the config; each entry
describes one skeleton.

```ts
export default defineConfig({
  templates: [
    {
      slug: 'landing_page',        // unique, snake_case
      collection: 'pages',         // the collection this template creates into
      name: 'Landing page',        // optional, shown in the admin picker
      description: 'Hero + feature grid + CTA', // optional
      data: {                      // default field values for a new document
        title: 'Untitled landing page',
        layout: [
          { blockType: 'hero', heading: 'Headline goes here' },
          { blockType: 'features', items: [] },
          { blockType: 'cta', label: 'Get started', href: '/signup' },
        ],
      },
    },
  ],
  collections: [
    // a `pages` collection whose `layout` is a blocks field with hero/features/cta variants
    { slug: 'pages', /* … */ },
  ],
})
```

Each `slug` must be **unique** and `snake_case`; `collection` must be a real collection;
`name` and `description` are optional metadata for the admin. `data` is a plain object of
default field values and **may include a blocks `layout`, default text, default selects —
anything a normal document body holds**.

> **`data` is deep-frozen.** The template's `data` is frozen at config load, so a single
> instantiation can never mutate the skeleton that the next one starts from. Every
> "New from template" begins from the same pristine defaults.

## The operations

Both ops are on the Local API (`kernel`):

| Op | Effect |
| -- | ------ |
| `listTemplates({ collection? })` | List template **metadata** (`slug`, `collection`, `name`, `description`), optionally filtered by `collection`. **Never** returns the raw `data`. |
| `createFromTemplate({ template, data?, req })` | Look up the template, deep-merge its defaults with the caller's `data`, and create the document through the normal create pipeline. Returns the created document. |

### Listing templates (metadata only)

`listTemplates` is what the admin's "New from template" picker reads. It returns only the
**metadata** of each template — `slug`, `collection`, `name`, `description` — and **never**
the `data` payload. Pass a `collection` to scope the list to the templates that target it.

```ts
// every template
const all = await kernel.listTemplates()

// only the templates that create into `pages`
const pageTemplates = await kernel.listTemplates({ collection: 'pages' })
// → [{ slug: 'landing_page', collection: 'pages', name: 'Landing page', description: '…' }]
```

### Creating from a template

`createFromTemplate` looks up the template by `slug`, **deep-merges** its defaults with the
caller's optional `data`, and creates the document through the **normal create path** — the
same one a plain `kernel.create` takes. It returns the created document.

```ts
const page = await kernel.createFromTemplate({
  template: 'landing_page',
  data: { title: 'Spring launch' }, // overrides the default title; the layout is inherited
  req,
})
```

The merge is **deep**, and the **caller wins** on any conflict:

- A scalar the caller supplies (`title`) replaces the template's default.
- Nested objects are merged key-by-key, not replaced wholesale — so the caller can override
  one nested value while inheriting the rest of the template's defaults.
- Anything the caller omits falls back to the template's default.

Because the result is a normal create, the merged document then runs through defaults,
access, field scope, validation, and hooks exactly as a hand-written create would.

## The REST surface

```http
GET  /api/_admin/templates?collection=     # list template metadata (admin/editor-gated)
POST /api/:collection/from-template         # create from a template { template, data? }
```

- `GET /api/_admin/templates` is **admin/editor-gated** and returns metadata only — the
  same shape as `listTemplates`.
- `POST /api/:collection/from-template` takes a body of `{ template, data? }` and creates
  the document as the **request principal**. The route's `:collection` **must match the
  template's configured `collection`** — a template can never be used to create into a
  different collection than it declares.

```bash
curl "http://localhost:3000/api/_admin/templates?collection=pages"

curl -X POST "http://localhost:3000/api/pages/from-template" \
  -d '{"template":"landing_page","data":{"title":"Spring launch"}}'
```

## The guarantees

Creating from a template is held to **exactly the same bar as a direct create** — there is
no second, looser code path for spawning a document.

- **It is a normal create.** The collection's `access.create` rule runs, so a caller who
  cannot create in the collection cannot use a template to do it. Validation, defaults, and
  hooks all fire.
- **An agent's result is still a draft.** The agent draft-only brake holds: a template whose
  `data` sets `_status: 'published'` does **not** publish when an agent instantiates it — the
  document is created as a draft, same as any agent create.
- **Out-of-scope fields are stripped.** An agent only writes the fields in its `fieldScope`;
  template defaults for fields outside that scope are dropped before per-field rules run.
- **The override is prototype-pollution-guarded.** The caller's `data` is guarded against
  `__proto__` / `constructor` / `prototype` keys, so a crafted override can't pollute the
  prototype through the merge.
- **The config is frozen.** The template's `data` is deep-frozen, so one instantiation can
  never mutate the skeleton the next one starts from.
- **Collection-match.** A template only ever creates into its configured `collection`; the
  REST route's `:collection` must match it.

Red-teamed to **Risk LOW**. Content templates pair naturally with the
[blocks page builder](https://kernelcms.com/docs/fields) and the
[draft/publish lifecycle](conventions.md#drafts-publish-and-the-default-read-view).
