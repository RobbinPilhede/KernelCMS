# Content snippets

A **content snippet** is a reusable content fragment — a CTA, a promo banner, a block of
legal text — that you **define once and reuse everywhere**. Instead of re-typing the same
copy into every page (and chasing down a dozen documents when the phone number or the
disclaimer changes), you store the fragment in a dedicated library collection and reference
it from anywhere. Edit the fragment once and every document that points at it reflects the
change — no copy, no drift.

A snippet field is *just a relationship* to a snippet library: nothing is copied into the
referencing document, only the fragment's id is stored. On read, with depth, the id is
replaced by the **live** fragment — resolved through the normal, access-checked read path,
exactly like any relationship.

## Define a snippet library

A snippet library is an ordinary collection flagged `snippet: true`. Its documents are the
reusable fragments; everything else about it — fields, access rules, hooks, the draft/publish
lifecycle — behaves like a normal collection.

```ts
export default defineConfig({
  collections: [
    {
      slug: 'snippets',
      snippet: true,                         // this collection is a fragment library
      fields: [
        { name: 'label', type: 'text' },
        { name: 'body', type: 'richText' },
      ],
    },
  ],
})
```

Only a collection flagged `snippet: true` may be the target of a `snippet` field. A `snippet`
field that points at a collection without the flag (or at a slug that doesn't exist) is
**rejected at config load** — the bad target throws before the server starts, so a typo can
never silently resolve to nothing.

## Reference a snippet

Add a `snippet`-typed field to any collection and name the library it draws from with
`snippet: '<slug>'`. Use a single field for one fragment, or `hasMany: true` for an ordered
list of fragments:

```ts
export default defineConfig({
  collections: [
    { slug: 'snippets', snippet: true, fields: [
      { name: 'label', type: 'text' },
      { name: 'body', type: 'richText' },
    ] },
    { slug: 'pages', fields: [
      { name: 'title', type: 'text' },
      { name: 'cta', type: 'snippet', snippet: 'snippets' },             // one fragment
      { name: 'banners', type: 'snippet', snippet: 'snippets', hasMany: true }, // an ordered list
    ] },
  ],
})
```

What's stored on the referencing document is **only the id** (or, for `hasMany`, an ordered
array of ids) — never a copy of the fragment's content. That's what makes
edit-once-update-everywhere work: there is one source of truth, and every reference points at
it.

## Transclusion on read

A `snippet` field is populated exactly like a [relationship](conventions.md): it expands only
when the request carries `depth`.

- **At `depth: 1`** (REST `?depth=1`, Local API `{ depth: 1 }`) the stored id is replaced by
  the **live snippet document** — its current `label`, `body`, and the rest. This is
  *transclusion*: you read the fragment's content as it exists right now, not a snapshot taken
  when the reference was made. Edit the fragment and the next read of every referencing
  document reflects it.
- **At `depth: 0`** the field stays the raw **id** (or array of ids for `hasMany`) —
  unresolved, exactly as stored. Ask for depth when you want the content; leave it off when
  you only need the link.

```ts
// id only — nothing transcluded
const page = await kernel.findById({ collection: 'pages', id, depth: 0 })
// page.cta === 'snp_abc'   (the stored id)

// transcluded — the live fragment is inlined
const populated = await kernel.findById({ collection: 'pages', id, depth: 1 })
// populated.cta === { id: 'snp_abc', label: 'Get started', body: { /* live richText */ } }
// populated.banners === [ { id: 'snp_1', … }, { id: 'snp_2', … } ]  // in stored order
```

```bash
curl "http://localhost:3000/api/pages/$ID?depth=0"   # cta is the snippet id
curl "http://localhost:3000/api/pages/$ID?depth=1"   # cta is the live snippet document
```

Transclusion is **access-checked**. Each fragment is fetched through the normal read path with
the snippet collection's `access.read` rule and row-scope applied. A fragment the reader can't
read falls back to its **raw id** — never the content — so the snippet field can't be used to
read a fragment you couldn't fetch directly. This is the same fallback a relationship makes to
an unreadable target.

Snippet-to-snippet references are **depth-bounded**. A fragment may itself contain `snippet`
fields, but population is capped by the engine's populate depth limit (**10**): each level
decrements the remaining depth, so a cycle — even a snippet that references itself — is bounded
and can never infinite-loop.

## The guarantees

A snippet field is held to the **same bar as a relationship** — there is no looser path
through a snippet than through the collection it references.

- **Edit-once, update-everywhere.** A reference stores only the fragment's id; the content is
  **transcluded live** on read, never copied. Edit the fragment once and every referencing
  document reflects it on the next read — there is no snapshot to go stale.
- **Access-checked transclusion.** Each fragment is resolved through the normal access-checked
  read path; an unreadable fragment falls back to its **raw id**, never its content — the
  snippet field can't leak a fragment you couldn't read directly.
- **Depth-bounded.** Population is capped by the engine's populate depth limit (10), so cyclic
  snippet→snippet references are bounded and can never recurse infinitely.
- **Config-validated target.** A `snippet` field may only reference a collection flagged
  `snippet: true`; a bad target throws at config load, before the server starts.

Red-teamed to **Risk LOW**. Content snippets pair naturally with
[relationships & joins](conventions.md) and the
[blocks page builder](https://kernelcms.com/docs/fields), and follow the populate-depth and
access conventions in [conventions.md](conventions.md).
