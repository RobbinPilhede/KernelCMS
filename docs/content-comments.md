# Editorial comments

**Editorial comments** are threaded review annotations on a document — "tighten this intro",
"who signed off on this price?", "ready to publish?" — kept *beside* the content rather than
in a separate Slack thread or spreadsheet. A comment can be anchored to a specific field or
left at the document level, replies thread under it, and a reviewer resolves it when the
feedback is addressed.

Comments are gated by the **target document's read access**. You can only see or add comments
on a document you can already read, the author is recorded from the **authenticated
principal** (never the client body), and resolve/delete are limited to the author or a
reviewer/admin. The comment surface can't be used to probe for documents you can't see.

## Opt in

Comments are off until you enable them. Set `comments: true` (or an object — reserved for
future options) on the config:

```ts
export default defineConfig({
  comments: true,
  collections: [/* … */],
})
```

Enabling comments registers a private `_comments` system table. Like every system table it is
**not** reachable through generic CRUD (`find`/`create` on `_comments` is rejected) — comments
are only ever touched through the dedicated operations below, which enforce the access gate.

## The operations

All ops are on the Local API (`kernel`):

| Op | Effect |
| -- | ------ |
| `addComment({ collection, id, body, field?, parentId?, req })` | Add a comment (or threaded reply) to a document you can read. Author comes from `req`. Returns the `CommentDoc`. |
| `listComments({ collection, id, field?, includeResolved?, req })` | List a document's comments, oldest → newest. Hides resolved unless `includeResolved`. |
| `commentCount({ collection, id, includeResolved?, req })` | Count a document's open (or all) comments — for an "N comments" badge. |
| `resolveComment({ commentId, resolved?, req })` | Resolve (default) or reopen (`resolved: false`) a comment. Author or reviewer only. |
| `deleteComment({ commentId, req })` | Delete a comment. Author or admin only. Returns `{ id }`. |

### Adding a comment

```ts
const comment = await kernel.addComment({
  collection: 'articles',
  id: article.id,
  body: '  tighten the intro  ', // trimmed -> "tighten the intro"
  field: 'summary',             // optional anchor to a real field (or omit for doc-level)
  req,                          // the principal authors the comment
})
// comment.authorId === req.user.id   (a forged authorId in the call is ignored)
// comment.resolved === false
```

The `body` is **required, trimmed, and length-bounded**. `field`, when present, must name a
real field of the collection. A `parentId` makes the comment a **threaded reply** and is
validated to belong to the **same document** — there is no cross-document or cross-collection
threading.

### Listing and counting

```ts
const open = await kernel.listComments({ collection: 'articles', id: article.id, req })
const all = await kernel.listComments({ collection: 'articles', id: article.id, includeResolved: true, req })
const badge = await kernel.commentCount({ collection: 'articles', id: article.id, req }) // open count
```

`listComments` returns comments **oldest → newest** so a thread reads top-to-bottom. Resolved
comments are hidden unless you pass `includeResolved: true`; `commentCount` counts the same way.

### Resolving and deleting

```ts
await kernel.resolveComment({ commentId: comment.id, req })                 // resolve
await kernel.resolveComment({ commentId: comment.id, resolved: false, req }) // reopen
await kernel.deleteComment({ commentId: comment.id, req })                   // delete
```

Resolve is allowed for the comment's **author** or a **reviewer** (a principal whose roles
include `admin` or `editor`). Delete is stricter — the **author** or an **admin** only (an
editor is not enough to delete someone else's comment).

## The REST surface

```http
GET    /api/:collection/:id/comments?field=&includeResolved=   # list (auth required)
POST   /api/:collection/:id/comments  { body, field?, parentId? }  # add (201)
PATCH  /api/_admin/comments/:commentId  { resolved? }          # resolve / reopen
DELETE /api/_admin/comments/:commentId                         # delete
```

Every comment route **requires authentication** up front — an anonymous request is rejected
with `401` before any comment data is read, so the HTTP surface never leaks a comment to an
unauthenticated caller. The acting identity is always the server-resolved principal; the
client body never names the author.

```bash
# add a comment as the authenticated user
curl -X POST "http://localhost:3000/api/articles/$ID/comments" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"body":"ready to publish?","field":"summary"}'

# resolve it
curl -X PATCH "http://localhost:3000/api/_admin/comments/$COMMENT_ID" \
  -H "Authorization: Bearer $TOKEN" -d '{"resolved":true}'
```

## The guarantees

The comment surface is held to the **same access bar as a read** — there is no looser path to
a comment than to the document it annotates.

- **Gated by document read access.** Every op (`add`/`list`/`count`/`resolve`/`delete`) checks
  the target document's `access.read` rule **and** its row-scope (`where`) before returning any
  comment data or mutating. A caller who can't read the document gets Forbidden/NotFound — never
  a comment, a count, or even a hint the document exists. This holds for the **anonymous
  Local-API path** too: a null-user caller is held to the read rule exactly like an
  authenticated one (no "no user = trusted" shortcut).
- **Author from the principal, never the client.** The recorded `authorId`/`authorType` come
  from the authenticated principal. A forged `authorId` in the call is ignored.
- **Resolve/delete re-gate on the live document.** Resolving or deleting re-checks the *current*
  read access of the comment's target document before the author/role check — a document that
  fell out of scope is denied regardless of who wrote the comment.
- **Threading stays within one document.** A `parentId` must belong to the same document; a
  foreign parent or a comment id from another collection is rejected.
- **System-table isolation + injection-safe.** `_comments` is unreachable via generic CRUD, and
  ids/anchors are validated against prototype-pollution keys (`__proto__`/`constructor`/
  `prototype`).
- **Audited.** Comment create/resolve/delete are recorded in the [audit log](conventions.md)
  when auditing is on.

Red-teamed to **Risk LOW**. Editorial comments pair naturally with
[content reviews](releases.md) and the
[draft/publish lifecycle](conventions.md#drafts-publish-and-the-default-read-view).
