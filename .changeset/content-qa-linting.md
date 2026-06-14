---
'kernelcms': minor
---

Content QA / linting: `kernel.lintDocument(...)` runs the configured pre-publish evals against a
document on demand (read-only) and reports every finding plus the blocking subset — the same
rules that gate `publish()`, surfaced so an editor sees blockers and quality warnings before
publishing. Exposed over REST as `GET /api/:collection/:id/lint`. Linting is an editorial tool
gated on **update access** (it inspects the live draft and its findings echo content), so a
public reader can never harvest unpublished drafts through it. Adds three pure built-in eval
factories: `requiredFieldsEval` (blocking), `readabilityEval` and `linkEval` (non-blocking
nudges).
