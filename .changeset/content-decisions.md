---
'kernelcms': minor
---

Content decisions: named delivery slots that pick the single best PUBLISHED document for the
caller's audience + a sticky per-viewer choice, served at `GET /api/_decide/:slug` (or
`kernel.decide(...)`). Stateless — it composes the existing access-checked published read,
audience resolution, and deterministic bucketing into one request-time delivery surface.
Published-only and access-checked (never surfaces a draft, private doc, or read-restricted
field); the choice is sticky per `?viewer=` (only the hash of the key is used — no PII), an
unknown `?audience=` collapses to the default segment, and the impression is auto-captured as a
`variant_impression`. Configure with `decisions: [{ slug, collection, where?, sort?,
audienceField?, fallback? }]`.
