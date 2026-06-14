---
"kernelcms": minor
---

Content snippets / reusable blocks. Mark a collection `snippet: true` to make it a library of reusable content fragments — a CTA, a promo banner, legal text — and reference a fragment from another collection with a `snippet`-typed field (`{ type: 'snippet', snippet: 'snippets', hasMany? }`). On read the field transcludes the fragment's **live** content (pass `depth: 1` / `?depth=1`), so editing the fragment once is reflected by every referencing document. Transclusion is access-checked — a fragment the reader can't read falls back to its raw id, never the content (and field-access on the fragment still applies); it is depth-bounded (cyclic snippet graphs can't infinite-loop), N+1-safe (batched populate), and a `snippet` field may only reference a `snippet: true` collection (validated at config load, at any nesting depth). With `depth: 0` the field stays the id.
