# Saved views

A **saved view** (a *smart collection*) is a named query preset for **one** collection — a
stored `where` + `sort` + display `columns` that an editor saves once and re-applies in a
single click. "Published this month", "My drafts", "Out of stock": instead of re-typing the
same filter every time, you save it, name it, and it's there in the sidebar — yours, or shared
with everyone who can read the collection.

A view is *just a stored query*: applying it runs the **normal, access-checked `find`**. The
stored `where`/`sort` are validated against the collection on save **and** on apply, so a view
can only ever **narrow** results within the caller's own access — it can never widen, bypass,
or probe past what a plain `find` would already return.

## Opt in

Saved views are off until you enable them. Set `views: true` (or an object — reserved for
future options) on the config:

```ts
export default defineConfig({
  views: true,
  collections: [/* … */],
})
```

Enabling views registers a private `_views` system table. Like every system table it is
**not** reachable through generic CRUD (`find`/`create` on `_views` is rejected) — views are
only ever touched through the dedicated operations below, which enforce the access gate.

## The operations

All ops are on the Local API (`kernel`):

| Op | Effect |
| -- | ------ |
| `saveView({ collection, name, where?, sort?, columns?, shared?, req })` | Save a named preset for a collection you can read. Owner comes from `req`. Returns the `ViewDoc`. |
| `listViews({ collection?, req })` | List the views visible to the caller — your own plus shared views on collections you can read — optionally scoped to one `collection`. |
| `getView({ viewId, req })` | Fetch a single view you own (or a shared one on a readable collection). |
| `updateView({ viewId, name?, where?, sort?, columns?, shared?, req })` | Edit a view's preset or sharing. Owner or admin only. Returns the `ViewDoc`. |
| `deleteView({ viewId, req })` | Delete a view. Owner or admin only. Returns `{ id }`. |
| `applyView({ viewId, where?, sort?, draft?, limit?, page?, req })` | Run the view's stored query as an access-checked `find`. Per-call `where`/`sort` further narrow it. Returns a `PaginatedResult`. |

### Saving a view

```ts
const view = await kernel.saveView({
  collection: 'products',
  name: 'Out of stock',
  where: { stock: { equals: 0 } },
  sort: '-updatedAt',
  columns: ['title', 'stock', 'updatedAt'], // display columns for the admin list
  shared: false,                            // private to the owner (the default)
  req,                                      // the principal owns the view
})
// view.ownerId === req.user.id   (a forged ownerId in the call is ignored)
// view.shared === false
```

The `name` is **required, trimmed, and length-bounded**. `where` and `sort` are **validated
against the collection** — every field referenced must be a real, queryable field, so a saved
view can never smuggle in an unknown column or a malformed filter. `columns`, when present,
must name real fields. `shared` defaults to `false` (private to the owner).

### Listing and reading views

```ts
const mine = await kernel.listViews({ collection: 'products', req }) // views on `products`
const all = await kernel.listViews({ req })                         // every visible view
const one = await kernel.getView({ viewId: view.id, req })
```

`listViews` returns the views the caller can see: their **own** views, plus **shared** views on
collections the caller can read. A shared view on a collection you *can't* read is never
listed — the view surface can't be used to probe for collections you don't have access to.

### Updating and deleting

```ts
await kernel.updateView({ viewId: view.id, name: 'Sold out', shared: true, req }) // edit + share
await kernel.deleteView({ viewId: view.id, req })                                 // delete -> { id }
```

Update and delete are **owner-or-admin only** — an editor can't rename or remove someone else's
view. Any `where`/`sort` supplied to `updateView` is re-validated against the collection, exactly
as on save.

### Applying a view

```ts
const page = await kernel.applyView({
  viewId: view.id,
  where: { price: { greater_than: 100 } }, // further narrows the view's stored where (AND)
  sort: '-price',                          // overrides the stored sort for this call
  draft: false,
  limit: 20,
  page: 1,
  req,
})
// page.docs, page.totalDocs, page.page, page.totalPages …
```

`applyView` runs the view's stored `where`/`sort` through the **normal `find` pipeline** — the
same one a plain `kernel.find` takes, with the collection's `access.read` rule and row-scope
applied. A per-call `where` is **AND-ed** onto the stored one (it can only narrow further), and a
per-call `sort` overrides the stored sort for that call. Because it's a normal `find`, the result
is held to the caller's read access — applying someone's shared view never returns a row you
couldn't already read yourself.

## The REST surface

```http
GET    /api/_admin/views?collection=                 # list visible views (auth required)
POST   /api/_admin/views  { collection, name, where?, sort?, columns?, shared? }  # save (201)
GET    /api/_admin/views/:id                          # read a single view
PATCH  /api/_admin/views/:id  { name?, where?, sort?, columns?, shared? }  # update (owner/admin)
DELETE /api/_admin/views/:id                          # delete (owner/admin)
POST   /api/_admin/views/:id/apply  { where?, sort?, draft?, limit?, page? }  # apply -> PaginatedResult
```

Every view route **requires authentication** up front — an anonymous request is rejected with
`401` before any view data is read, so the HTTP surface never leaks a view to an unauthenticated
caller. The acting identity is always the server-resolved principal; the client body never names
the owner.

```bash
# save a view as the authenticated user (owner comes from the token, not the body)
curl -X POST "http://localhost:3000/api/_admin/views" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"collection":"products","name":"Out of stock","where":{"stock":{"equals":0}},"sort":"-updatedAt"}'

# apply it, narrowing further for this call
curl -X POST "http://localhost:3000/api/_admin/views/$VIEW_ID/apply" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"where":{"price":{"greater_than":100}},"limit":20,"page":1}'
```

## The guarantees

A saved view is held to the **same access bar as a read** — there is no looser path through a
view than through the collection it queries.

- **Apply is a normal, access-checked `find`.** `applyView` runs the stored query through the
  standard `find` pipeline, so the collection's `access.read` rule and row-scope are enforced
  every time. A view can only ever return rows the caller could already read — applying a shared
  view never widens, bypasses, or escalates the caller's access.
- **A view can only narrow.** The stored `where`/`sort` are **validated against the collection**
  on save **and** on apply, and any per-call `where` is AND-ed onto the stored one. There is no
  way for a saved view to broaden results beyond a plain `find`.
- **Owner from the principal, never the client.** The recorded `ownerId` comes from the
  authenticated principal. A forged `ownerId` in the call is ignored.
- **Private by default, shared is read-gated.** A view is private to its owner unless `shared`,
  and a shared view is visible only to principals who can **read its collection** — the view
  surface can't be used to probe for collections you can't see.
- **Owner-or-admin for update/delete.** Editing or deleting a view is limited to its owner or an
  admin — an editor can't touch someone else's view.
- **System-table isolation + injection-safe.** `_views` is unreachable via generic CRUD, and
  ids/fields are validated against prototype-pollution keys (`__proto__`/`constructor`/
  `prototype`).
- **Audited.** View create/update/delete are recorded in the [audit log](conventions.md) as
  `view.create` / `view.update` / `view.delete` when auditing is on.

Red-teamed to **Risk LOW**. Saved views pair naturally with the
[Where query syntax](https://kernelcms.com/docs/querying) and
[content reviews](releases.md).
