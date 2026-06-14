# Document activity timeline

The **document activity timeline** merges everything that ever happened to one document
into a single, newest-first feed — instead of four separate panels an editor has to
cross-reference. Saved versions, editorial comments, agent-draft reviews, and audit-log
entries all land in one stream: "who changed the price, who flagged it, who approved it,
when it went live" answered in one read, in time order, for the document open in front of
you.

The whole feed is gated on the document's **read access**: a caller who can't read the
document gets Forbidden/NotFound — never an event, a count, or even a hint the document
exists. The two reviewer-only sources (review + audit) are folded in **only for an
admin/editor principal**; a non-reviewer gets the version + comment stream and
`includesReviewerEvents: false`. Each source keeps its own access rules underneath — history
field-strips, comments are doc-read-gated — and a source whose feature is off
(`versions`/`comments`/`review`/`audit`) is simply skipped. The timeline is a *view into*
the same access-checked sources, never a side door around them.

## Read the timeline

`documentActivity` takes a `collection` + `id`, merges the available sources, and returns the
events newest-first. `types` filters to specific event kinds; `limit` caps the feed (default
`100`, max `500`):

```ts
const { events, includesReviewerEvents } = await kernel.documentActivity({
  collection: 'articles',
  id: article.id,
  types: ['version', 'comment', 'review', 'audit'], // optional filter (default: all available)
  limit: 100,                                        // default 100, clamped to 500
  req,                                               // gated on the document's read access
})
// includesReviewerEvents === true only for an admin/editor principal
```

Each `event` is one entry on the merged feed:

```ts
// Array<{
//   type: 'version' | 'comment' | 'review' | 'audit',
//   at,                       // when it happened (newest-first across the whole feed)
//   actor: { id, type },      // who did it (type: 'user' | 'agent')
//   action,                   // e.g. 'saved', 'commented', 'approved', 'document.publish'
//   data,                     // type-specific payload (see below)
// }>
```

The REST surface is a single read on the document:

```http
GET /api/:collection/:id/activity?types=&limit=   # merged feed (auth follows the doc read gate)
```

`types` is a **comma-separated** list of event kinds to include; `limit` caps the feed (max
`500`). Omit `types` and you get every source the caller is allowed to see.

```bash
# the whole timeline for one document
curl "http://localhost:3000/api/articles/$ID/activity" \
  -H "Authorization: Bearer $TOKEN"

# just versions and comments, last 20 events
curl "http://localhost:3000/api/articles/$ID/activity?types=version,comment&limit=20" \
  -H "Authorization: Bearer $TOKEN"
```

## What each event type carries

Every event shares the `{ type, at, actor, action, data }` shape; the `data` payload is what
differs per source. The four sources, their key `data` fields, and who sees them:

| `type` | Source | Key `data` fields | Who sees it |
| ------ | ------ | ----------------- | ----------- |
| `version` | a saved snapshot | `status`, `changedFields`, `autosave` | any reader of the doc |
| `comment` | an editorial comment | `body`, `field`, `resolved` | any reader of the doc |
| `review` | an agent-draft review decision | `decision` (`approved` / `changes_requested`), `note` | reviewers only (admin/editor) |
| `audit` | an audit-log entry | `action`, `fields`, `meta` | reviewers only (admin/editor) |

`version` and `comment` events form the baseline feed every reader of the document sees.
`review` and `audit` events are the reviewer-only layer — present only when
`includesReviewerEvents` is `true`.

## Who sees what

The timeline is held to the **same access bar as a read**, and the reviewer-only sources
sit one rung higher:

- **The whole feed is doc-read-gated.** Every call checks the target document's `access.read`
  rule **and** its row-scope before merging a single source. A caller who can't read the
  document gets Forbidden/NotFound — no events, no count, no hint it exists. This holds for the
  anonymous Local-API path too: a null-user caller is held to the read rule exactly like an
  authenticated one (no "no user = trusted" shortcut).
- **Version + comment are shown to any reader.** A snapshot is shown to anyone who can read
  the document; a comment is shown to anyone who can read the document it annotates — the same
  gate the comment surface uses on its own.
- **Review + audit are reviewers-only.** The two reviewer-only sources are folded in **only for
  an admin/editor principal**. A non-reviewer who can read the document still gets the
  version + comment feed, with `includesReviewerEvents: false` — they're never told a review or
  an audit entry exists.
- **Each source keeps its own rules.** Merging doesn't loosen anything: version events
  field-strip exactly as `history` does (a read-denied field never appears in `changedFields`),
  and comment visibility follows the comment surface. A source whose feature is off is skipped.

## The guarantees

The activity timeline is a read-only merge of sources the caller is **already** allowed to
see — there is no looser path through the timeline than through the four sources it composes.

- **Doc-read-gated as a whole.** The merged feed runs the document's `access.read` rule and
  row-scope up front; a caller who can't read the document gets Forbidden/NotFound, never an
  event or a count — including on the anonymous Local-API path (no "no user = trusted"
  shortcut).
- **Reviewer-only sources stay reviewer-only.** `review` and `audit` events are included only
  for an admin/editor principal; a non-reviewer gets `includesReviewerEvents: false` and only
  the version + comment feed, with no signal the reviewer events exist.
- **Each source keeps its own access rules.** Version events field-strip like
  [`history`](time-machine.md) (read-denied fields never surface in `changedFields`), comments
  follow the [editorial comment](content-comments.md) read gate — the merge never widens any of
  them.
- **Features off are simply absent.** A source whose feature isn't enabled
  (`versions`/`comments`/`review`/`audit`) contributes nothing — no error, no empty placeholder,
  no leak that the feature exists.
- **Bounded and read-only.** The feed is `limit`-capped (default `100`, hard max `500`) and
  newest-first; `documentActivity` only ever reads — it never mutates a version, comment,
  review, or audit row.

Red-teamed to **Risk LOW.** The activity timeline sits on top of the
[content time-machine](time-machine.md), [editorial comments](content-comments.md), and the
[audit log](conventions.md) — the same access model described in
[conventions.md](conventions.md).
