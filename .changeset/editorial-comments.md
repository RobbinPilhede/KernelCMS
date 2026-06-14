---
"kernelcms": minor
---

Editorial comments — threaded review annotations on documents. Opt in with `comments: true` and editors can leave field-anchored or document-level comments, thread replies, and resolve them. Gated by the target document's read access (rule + row-scope) on every operation — including the anonymous Local-API path — so the comment surface never leaks a document you can't read. The author is recorded from the authenticated principal (never the client body); resolve is limited to the author or a reviewer (`admin`/`editor`), delete to the author or an `admin`. Adds `kernel.addComment`, `listComments`, `commentCount`, `resolveComment`, `deleteComment`, the `_comments` system table (unreachable via generic CRUD), and REST routes (`/:collection/:id/comments`, `/_admin/comments/:commentId`). Create/resolve/delete are audited.
