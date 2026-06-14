# Content QA & linting

KernelCMS already runs **pre-publish evals** — "content CI" — at the publish chokepoint: a
blocking rule that returns an `error` finding **rejects the publish**. **Content QA** extends
that gate with an *on-demand* lint: `kernel.lintDocument(...)` runs the **same configured
rules** against a document read-only, so an editor sees the blocking errors and the quality
warnings **before** they try to publish — not as a publish that bounces.

The point: catch content problems before publish, and let an editor check on demand. The
rules that gate a publish and the rules an editor lints against are *the same rules* — a
green lint means a publishable document, for the configured checks. This release also adds
three new built-in rule factories (readability, required-fields, links) and per-rule
scoping (`appliesTo`, `blocking`).

## Configure the rules

Content QA is off until you list rules. Drop the built-in factories into `config.evals`;
each is a small, pure rule and they compose:

```ts
import {
  defineConfig,
  requiredFieldsEval,
  seoEval,
  a11yEval,
  readabilityEval,
  linkEval,
  policyEval,
  brandEval,
} from '@kernel/core'

export default defineConfig({
  evals: [
    // BLOCKING — these reject a publish:
    requiredFieldsEval({ fields: ['summary', 'hero', 'category'] }),
    seoEval({ titleField: 'title', descriptionField: 'meta_description' }),
    a11yEval(),
    policyEval({ bannedTerms: ['lorem ipsum', 'TODO'] }),
    brandEval({ requiredDisclaimers: ['Past performance is not indicative…'] }),

    // NON-BLOCKING — quality warnings, never reject a publish:
    readabilityEval({ fields: ['body'] }),
    linkEval(),

    // scope a rule to specific collections; default is every collection:
    seoEval({ titleField: 'headline' }), // … or
    { ...a11yEval(), appliesTo: ['posts', 'pages'] },
  ],
  collections: [/* … */],
})
```

Two knobs control how a rule behaves at the gate:

- **`blocking`** (default `true`) — whether an `error` finding from this rule **rejects the
  publish**. A non-blocking rule (`blocking: false`) only ever produces warnings/info; it
  surfaces in the lint but never stops a publish. `warn`/`info` findings **never block**,
  even from a blocking rule — only an `ok:false` `error` from a blocking rule does.
- **`appliesTo: ['slug', …]`** — scope the rule to those collection slugs. Omit it and the
  rule applies to **every** collection.

The built-ins are **pure**: each reads only the fields it declares, never touches the
network, and never mutates the document — so a lint (and the publish gate) is deterministic.

## The built-in checks

Seven factories ship in `@kernel/core`. Each returns an `EvalRule` you drop into
`config.evals`:

| Check | What it does | Blocking? |
| ----- | ------------ | --------- |
| `a11yEval()` | Embedded images in rich text must carry `alt`; heading levels must not skip (no h2→h4); flags a top-level upload field with no associated alt. | **Yes** |
| `seoEval({ titleField, descriptionField? })` | Title must be present and within length bounds (default 10–60); optional meta description must be present and within 50–160 (warn). | **Yes** (title) |
| `policyEval({ bannedTerms, fields? })` | Rejects a publish whose content contains any banned term (case-insensitive). | **Yes** |
| `brandEval({ requiredDisclaimers, fields? })` | Required disclaimer/legal phrases must appear in the content. | **Yes** |
| `readabilityEval({ fields, maxAvgSentenceWords?, maxLongWordRatio? })` | Warns when prose runs long-winded — high average sentence length (default ≤ 25 words) or a high share of long words (default ≤ 20%). | No (warn) |
| `requiredFieldsEval({ fields })` | A listed field must be non-empty (no blank string, empty list, or null) to publish — "no publish without a summary / hero image / category". | **Yes** |
| `linkEval({ fields? })` | Warns on rich-text links with an empty/`#`/malformed target. | No (warn) |

`a11yEval`, `policyEval`, `brandEval`, `readabilityEval`, and `linkEval` read the
collection's schema (wired automatically at lint/publish time), so they walk the right
rich-text and upload fields without you naming them. `requiredFieldsEval` and the
field-scoped scans take an explicit `fields` list.

## Lint on demand

`kernel.lintDocument` runs every applicable rule against a document **right now**, read-only,
and returns what the publish gate would see:

```ts
const { ok, findings, blocking } = await kernel.lintDocument({
  collection: 'posts',
  id,
  req, // the request principal — access is enforced
})
```

Linting is an **editorial pre-publish tool**, so it is **gated on update access**, not plain
read: it inspects the live **draft** (so you can lint a work-in-progress) and its findings echo
content (banned terms, link targets, field presence). The caller must be able to **edit** the
document — exactly as if they were about to publish it — so a public reader who can't publish can
never harvest unpublished drafts through the lint surface. A document that doesn't exist throws
`NotFound`; one the caller can't edit is `Forbidden`. Nothing is written.

### REST

```bash
# Lint a document — runs the configured evals read-only; requires UPDATE access (an editor token)
curl -H "Authorization: Bearer <editor-token>" "http://localhost:3000/api/posts/<id>/lint"
```

`GET /api/:collection/:id/lint` resolves the caller exactly like every other REST route — an
anonymous request only lints a document `access.read` allows it to read.

### The result shape

```ts
{
  ok: boolean,            // true when NOTHING would block a publish
  findings: [             // every result from every applicable rule
    {
      rule: string,       // the rule that produced it (e.g. 'a11y', 'required-fields')
      ok: boolean,
      severity: 'error' | 'warn' | 'info',
      message: string,
      field?: string,     // the field it pertains to, when applicable
      blocking: boolean,  // whether this rule's `error` would reject a publish
    },
    // …
  ],
  blocking: [ /* the subset of findings that WOULD reject a publish */ ],
}
```

`findings` is the complete picture — errors, warnings, and the info "all good" notes —
so an editor sees both the hard blockers and the soft nudges. `blocking` is the subset that
would reject a publish (blocking rules with an `error`), and `ok` is `true` exactly when
`blocking` is empty.

## At publish

The same rules gate the publish. When a document is published, KernelCMS runs `config.evals`
against the to-be-published content at the publish chokepoint; if **any** blocking rule
returns an `ok:false` `error`, the publish is **rejected** with those findings. Warnings and
info are recorded (in the publish's audit meta) but never block.

So `lintDocument` returns **exactly what the publish gate would see**: a green lint
(`ok: true`) is a publishable document, for the configured rules. A rule that *throws* is
converted to a blocking error — a crashing rule never silently passes content through, nor
500s the publish. The same gate also runs inside
[content releases](releases.md#the-guarantees) (every member is dry-run through it, and
again on the scheduled drain) and the [agentic workflow](agentic-workflows.md) `evalGate`
step — one set of rules, every publish path.

## The guarantees

- **`lintDocument` is read-only.** It loads the document and runs the rules; it never writes,
  never mutates the document, and has no side effects.
- **It is gated on update access.** Lint exposes the live draft and its findings echo content,
  so it requires the same right as publishing — **only an editor of the document can lint it**,
  never a public reader. A non-editor is `Forbidden`; a missing document is `NotFound`. Drafts
  can't leak through the lint surface.
- **A green lint is a publishable doc.** `lintDocument` runs the **same `config.evals`** the
  publish gate runs, so its result is exactly what publish would see — for the configured
  rules, `ok: true` means the document clears the gate.
- **Built-in rules are pure and deterministic.** Each reads only the fields it declares,
  never touches the network, and never mutates the document — so the lint and the gate give
  the same answer every time.
- **A crashing rule fails closed.** A rule that throws is converted to a blocking error, not
  a silent pass and not a 500 — content never slips through on a buggy rule.

Red-teamed to **Risk LOW**.

---

Pairs naturally with the publish gate inside [content releases](releases.md) (the blocking
eval / content-CI gate runs in the release pre-flight and again on the scheduled drain) and
the [agentic workflow](agentic-workflows.md) quality step. See
[conventions.md](conventions.md#drafts-publish-and-the-default-read-view) for the
draft/publish lifecycle these rules gate, and the README's **Content QA & linting** section
for the one-paragraph version.
