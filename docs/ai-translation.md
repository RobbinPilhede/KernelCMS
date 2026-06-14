# AI-assisted translation

Translation auto-fills the missing locales of your **localized** content through a
machine-translation provider you supply — DeepL, OpenAI, Google, or a local model. You
already model content per-locale with `localized` fields; translation reads the values in
one locale, runs them through your provider, and writes the results into another.

It is the natural companion to [localization](https://kernelcms.com/docs/localization): a
`localized` field stores one value per locale, and translation fills the locales you
haven't authored by hand yet. KernelCMS orchestrates and guards the write — the actual
machine translation is your provider, behind one small function. There is **no hard
translation dependency** in the core.

Translation is opt-in and fully access-checked. Nothing changes until you configure
`translation`, and it requires `localization` to be configured (a translation always
targets a configured locale).

## The concept: auto-fill locales via a pluggable provider

A `translation` provider is one function: it takes N source strings (all in a `from`
locale) and returns N translations (in a `to` locale), **in order**. KernelCMS collects
the source-locale values of a document's localized text fields, hands them to the
provider, and merges the returned translations back into the target locale — leaving every
other locale untouched.

By default it only fills **missing** target values, so it is safe to re-run: already
translated (or hand-edited) locales are left alone unless you explicitly ask to overwrite.

## Configure a provider

A translation provider plugs into the same config as localization. Supply a `translate`
function that maps `{ texts, from, to }` to a `string[]` of the same length and order:

```ts
import { defineConfig } from 'kernelcms'

export default defineConfig({
  localization: {
    locales: ['en', 'sv', 'de'],
    defaultLocale: 'en',
  },
  translation: {
    // Any provider works — KernelCMS just needs string[] (from) → string[] (to), in order.
    translate: async ({ texts, from, to }) => {
      const res = await deepl.translateText(texts, from, to)
      return res.map((r) => r.text)
    },
  },
  // …
})
```

An OpenAI-style provider is the same shape — call your model, return the translations in
input order:

```ts
translation: {
  translate: async ({ texts, from, to }) => {
    const res = await openai.responses.create({
      model: 'gpt-4o-mini',
      input: `Translate each line from ${from} to ${to}. Return one line per input, same order.\n` +
        texts.join('\n'),
    })
    return res.output_text.split('\n')
  },
}
```

The provider closure may hold an API key — that is expected. KernelCMS **never logs** the
texts it sends or receives, and surfaces a generic message if the provider throws (see
[The guarantees](#the-guarantees)).

## Translate one document

`kernel.translateDocument(...)` reads a document's `from`-locale values for its localized
text fields, translates them, and writes them into the `to` locale:

```ts
const doc = await kernel.translateDocument({
  collection: 'posts',
  id,
  from: 'en',
  to: 'sv',
  // fields: ['title', 'body'], // optional — omit to translate every localized text field
  req,
})
```

It returns the updated document (or `null`). The write **merges**: only the `to` locale is
touched, every other locale is preserved.

### Fill-missing vs. overwrite

By default a target value is filled **only when it is missing**. A locale you've already
translated — by hand or on a previous run — is never clobbered:

```ts
// Fills only the 'sv' values that are currently empty; existing 'sv' values stay.
await kernel.translateDocument({ collection: 'posts', id, from: 'en', to: 'sv', req })

// Replaces existing 'sv' values too — a full re-translation.
await kernel.translateDocument({ collection: 'posts', id, from: 'en', to: 'sv', overwrite: true, req })
```

When there is nothing to translate (no source text, or every target is already filled and
`overwrite` is off), no provider call is made and no write happens.

## Bulk-fill a collection

`kernel.translateMissing(...)` finds the documents in a collection whose `to` locale is
incomplete — via the translation-status data — and translates each one, bounded by
`limit`:

```ts
const { translated, skipped } = await kernel.translateMissing({
  collection: 'posts',
  to: 'de',
  // from: 'en',   // defaults to the configured default locale
  // fields: […],  // optional field restriction
  // limit: 50,    // default 50, bounded
})
```

It returns `{ translated, skipped }` — the ids of documents whose `to` locale was filled,
and the ids that were skipped (already complete, no source text, or **not writable** by
the caller). Each document is translated through `translateDocument`, so the same
access checks and merge semantics apply per document.

## REST

Both operations are exposed over HTTP:

```bash
# Translate one document's localized fields from `from` into `to`:
curl -X POST "http://localhost:3000/api/posts/<id>/translate" \
  -H 'content-type: application/json' \
  -d '{ "from": "en", "to": "sv" }'        # add "fields": [...] to restrict; "overwrite": true to replace

# Batch-fill a collection's missing target locale (admin/editor only):
curl -X POST "http://localhost:3000/api/_admin/translate-missing" \
  -H 'content-type: application/json' \
  -d '{ "collection": "posts", "to": "de" }'   # add "from" / "limit" to scope
```

`POST /api/:collection/:id/translate` is gated by the same **update** access as editing the
document. `POST /api/_admin/translate-missing` is restricted to an admin or editor (never
an agent), and core still scopes the candidate documents by the reviewer's own read access
and enforces write access per document — so it never widens what they could change by hand.

## The guarantees

- **A translation is a normal access-checked write.** It goes through the standard update
  path, not a side door. The caller must be able to **update** the document; a caller who
  can't edit it can't translate it.
- **Strict validation still applies.** Strict-mode per-locale required validation runs on
  the write exactly as it would for a manual edit — a translation can't sneak past the
  rules that govern the target locale.
- **The agent draft-only brake still holds.** A translation **never auto-publishes**: like
  every agent-reachable write, it lands as a draft and goes through your normal review
  workflow. Translation assists humans; it doesn't bypass them.
- **Provider key and errors stay private.** The `translate` closure may hold an API key.
  KernelCMS **never logs** the source or target text, and a provider failure surfaces a
  **generic message** at the request boundary — the provider's own error text never leaks.
- **No partial writes.** A provider failure can't corrupt the document: if translation
  throws, nothing is written. The document is left exactly as it was.
- **Locales are validated.** `from` and `to` must be configured locales (and `from ≠ to`);
  an unknown locale — or a crafted value like `__proto__` — is rejected, so a translation
  can't reach an undeclared or prototype-polluting locale slot.
- **Read-denied fields never leak.** A localized field the caller can't read is never sent
  to the provider and never written — translation respects field read-access like every
  other read.
- **Input is bounded.** Per-field input is size-bounded, so a pathological document can't
  blow up a provider call.

The feature was red-teamed to **Risk LOW**. It pairs with localization strict mode and the
translation-status dashboard, which together show which locales are still missing and let a
human review every machine-translated draft before it goes live.
