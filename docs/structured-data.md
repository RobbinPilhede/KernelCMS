# Structured data (schema.org JSON-LD)

KernelCMS can emit **schema.org JSON-LD** for your documents — the structured-data format
search engines and AI answer engines read to understand *what a page actually is*. The
lever is one optional `structuredData` block, and the output is generated straight from
your typed content model through the **same access-checked read path** as every other read.

The point: your config already describes your content — a `posts` collection has a title, a
body, a publish date, an author. Rather than hand-writing a `<script type="application/ld+json">`
block on every template (and watching it drift from the real data), KernelCMS maps your
fields to schema.org properties and renders the JSON-LD for you, per document, on demand.

> TL;DR: add a top-level `structuredData: { … }` listing collections and their schema.org
> `type`, then call `kernel.jsonLdScript({ collection, id, req })` to get an embeddable
> `<script>` for a page (or `kernel.jsonLd(...)` for the raw object), or hit
> `GET /api/:collection/:id/jsonld`. Omitting the block disables the feature.

---

## 1. What JSON-LD and schema.org are, and why

[Schema.org](https://schema.org) is a shared vocabulary of *types* (`Article`, `Product`,
`Person`, `Event`, `Recipe`, …) and *properties* (`headline`, `author`, `datePublished`,
`price`, …). [JSON-LD](https://json-ld.org) is the JSON encoding of that vocabulary that
goes in a `<script type="application/ld+json">` tag in your page. Together they turn a
human-readable page into machine-understandable facts.

Two audiences consume it:

- **Search engines (SEO).** Google, Bing, and others use JSON-LD to render *rich results* —
  the article cards, product price/rating snippets, breadcrumbs, and author bylines that
  stand out in a results page. No JSON-LD, no rich result.
- **AI answer engines (GEO).** ChatGPT, Claude, Perplexity, and Google AI lean on the same
  structured facts to ingest and attribute content reliably. Explicit `@type`,
  `datePublished`, and `author` are far less ambiguous than prose.

Structured data is the third leg of the discoverability trio: [semantic
search](./semantic-search.md) makes content *retrievable*, [llms.txt / GEO](./ai-discoverability.md)
makes it *ingestible and citable*, and JSON-LD makes a single page *machine-understandable*.

## 2. Configure `structuredData`

The feature is **off until you add the block**. Each entry names a collection, the
schema.org `type` to emit, and (optionally) a `mapping` and a `urlPattern`.

```ts
// kernel.config.ts
import { defineConfig } from 'kernelcms'

export default defineConfig({
  // …
  structuredData: {
    baseUrl: 'https://acme.com',          // builds absolute canonical @id / image URLs

    collections: [
      // Smart defaults: fields are mapped automatically (see §3).
      { slug: 'posts', type: 'BlogPosting', urlPattern: '/blog/:slug' },

      // Explicit mapping: schema.org property → your field name.
      {
        slug: 'authors',
        type: 'Person',
        mapping: { name: 'full_name', email: 'contact', image: 'avatar' },
      },

      // Any schema.org type works.
      { slug: 'products', type: 'Product', urlPattern: '/shop/:slug' },
    ],
  },

  collections: [/* … */],
})
```

Top-level and per-collection options:

| Option       | Where            | Meaning                                                                                       |
| ------------ | ---------------- | --------------------------------------------------------------------------------------------- |
| `baseUrl`    | top-level        | Origin used to build absolute canonical `@id` and `image` URLs.                               |
| `slug`       | per-collection   | The collection to emit JSON-LD for (required).                                                |
| `type`       | per-collection   | The schema.org `@type`, e.g. `'Article'`, `'BlogPosting'`, `'Product'`, `'Person'` (required). |
| `mapping`    | per-collection   | `Record<schemaProperty, fieldName>` — overrides the smart defaults entirely.                  |
| `urlPattern` | per-collection   | Path template, e.g. `'/blog/:slug'`; `:token`s resolve against the document, joined to `baseUrl` to form `@id`. |

## 3. Smart-default mapping

When a collection has **no explicit `mapping`**, KernelCMS infers a sensible mapping from
your field set. This is what gets emitted by default:

| schema.org property | Mapped from                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------------- |
| `name` + `headline` | The title field (`useAsTitle`, or a field named `title`).                                      |
| `articleBody`       | The first `richText` / `textarea` field (rendered to text).                                    |
| `description`       | The same body field, truncated to a short summary.                                             |
| `datePublished`     | A `date` field named `publish*` / `posted*` / `created*`, else `createdAt`.                     |
| `dateModified`      | A `date` field named `updated*` / `modified*`, else `updatedAt`.                                |
| `email`             | An `email` field.                                                                              |
| `image`             | An `image` / `upload` field, emitted as its URL.                                                |
| `author`            | An author-ish `relationship`, emitted as `{ '@type': 'Person', name }`.                         |

An explicit `mapping` **replaces** the defaults for that collection — list every property
you want. Use defaults for content-shaped collections (posts, articles) and an explicit
mapping when your field names or the target type don't line up with the heuristics.

## 4. The two operations

Both are on the Local API (`kernel.*`) and both read through the access-checked pipeline,
with the principal taken from `req` (see [the access guarantee](#6-the-access-checked-guarantee)).

```ts
// (a) The JSON-LD object, or null if the doc is missing / not readable / disabled.
const ld = await kernel.jsonLd({ collection: 'posts', id, req })
//   → { '@context': 'https://schema.org', '@type': 'BlogPosting',
//       '@id': 'https://acme.com/blog/hello', name: '…', headline: '…',
//       articleBody: '…', datePublished: '…', author: { '@type': 'Person', name: '…' } }

// (b) The ready-to-embed <script> string, HTML-escaped; '' when there's no doc.
const script = await kernel.jsonLdScript({ collection: 'posts', id, req })
//   → '<script type="application/ld+json">{…}</script>'
```

`jsonLd` returns the raw object — reach for it when you want to merge, post-process, or
serialize it yourself. `jsonLdScript` returns the **embeddable, HTML-escaped** `<script>`
tag — reach for it when you're rendering a page.

## 5. Embedding it in a page

Drop the `jsonLdScript` string into your page `<head>`. It's already a complete,
escaped `<script>` element, so render it as raw HTML:

```ts
// e.g. a server-rendered route / SSR template
const script = await kernel.jsonLdScript({ collection: 'posts', id: post.id, req })

return `
  <head>
    <title>${post.title}</title>
    ${script}
  </head>
`
```

In a React/JSX page, inject it the same way you would any pre-escaped HTML string (e.g.
`dangerouslySetInnerHTML`) — the escaping is done for you, so the content cannot break out
of the tag.

The JSON-LD is generated per document on read; it always reflects the current,
access-checked state of the document.

## 6. The access-checked guarantee

The op reads the document through the **same access-checked pipeline** as a live read,
using the principal on `req` — there is no second code path.

- **Drafts never leak.** A draft (or scheduled-but-unpublished) document an anonymous
  caller can't read yields `null` / `''`.
- **Restricted docs never leak.** If the caller can't read the document, neither op emits it.
- **Read-denied fields never leak.** Field-level access is applied before mapping, so a
  field the caller can't read never lands in a JSON-LD property.

In short: JSON-LD has the **same visibility as the live read**. A public, anonymous caller
(the typical case for a page baked for SEO) sees only published, publicly readable content
and fields — exactly what you'd serve a logged-out visitor through `GET /api/posts/:id`.
When the doc is missing, not readable, or the feature is disabled for that collection,
`jsonLd` returns `null` and `jsonLdScript` returns `''`.

## 7. XSS- and URL-safety

Embedding model-controlled content in a `<script>` tag is a classic injection vector, so
the two safety properties are part of the contract:

- **`<script>` escaping.** `jsonLdScript` HTML-escapes `<`, `>`, and `&` in the serialized
  JSON, so a body containing `</script>` (or any markup) **cannot** break out of the tag
  and inject executable HTML. The string is safe to drop into a page as-is.
- **URL safety.** The `@id` and `image` URLs are built from `baseUrl` + `urlPattern` (and
  upload URLs) and validated — no `javascript:` / `data:` schemes and no path traversal —
  so a malicious field value can't smuggle a dangerous URL into the structured data.

This surface was red-teamed to **Risk LOW**.

## 8. The REST surface

Each document's JSON-LD is also available over HTTP:

```bash
curl http://localhost:3000/api/posts/<id>/jsonld   # application/ld+json
```

`GET /api/:collection/:id/jsonld` returns `application/ld+json`. It is **access-checked** —
the principal is resolved from the request exactly like any other API call — and returns
`404` when the document is `null` (missing / not readable) or structured data is disabled
for that collection. Anonymous callers get only published, publicly readable documents.

---

## Notes & honest limits

- **Opt-in, per collection.** Only collections listed under `structuredData.collections`
  emit JSON-LD; everything else is untouched.
- **The standalone op is the surface.** JSON-LD is served through `jsonLd` /
  `jsonLdScript` / the `/jsonld` route — it is *not* auto-injected into the
  [llms.txt / GEO](./ai-discoverability.md) output. Embed it where you render your pages.
- **Smart defaults are heuristics.** They cover the common content shape; when your field
  names or target type are unusual, set an explicit `mapping`.

---

See [conventions.md](./conventions.md) for the deny-by-default access model the
access-checked guarantee builds on, [ai-discoverability.md](./ai-discoverability.md) for
the llms.txt / GEO surface it sits beside, and the README's **Structured data** section for
the one-paragraph version.
