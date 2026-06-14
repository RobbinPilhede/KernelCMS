---
"kernelcms": minor
---

Content branches (git-for-content). Opt in with `branches: true` and get a named workspace where edits are STAGED as a copy-on-write overlay (the live document is never touched), previewed and diffed, then merged or discarded. `kernel.createBranch`, `listBranches`, `stageChange({ branch, collection, id, data })`, `previewBranch` (the live access-checked doc with the staged overlay applied), `diffBranch`, `mergeBranch` → `{ merged, failed }`, `discardBranch`. REST (reviewer-gated): `GET/POST /api/_admin/branches`, `GET /api/_admin/branches/:name/diff`, `GET .../preview?collection=&id=`, `POST .../stage`, `POST .../merge`, `POST .../discard`.

Staging requires update access to the target document; merging replays each staged change through the normal access-checked `update`, so the publish gate (incl. the agent draft-only brake), field-level access, and validation all apply — a branch can never bypass them. System columns (`_status`, `id`, …) and auth fields can't be staged; create/merge/discard are reviewer-gated (admin/editor) and audited; `_branches`/`_branch_docs` are unreachable via generic CRUD. This is field-level staged overlays + replayed merge (last-write-wins over the current live doc), not a three-way git merge; a partial merge reports per-change failures in `failed[]`.
