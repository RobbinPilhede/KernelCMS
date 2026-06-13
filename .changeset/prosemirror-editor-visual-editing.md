---
'kernelcms': minor
---

Rich text editing is now powered by ProseMirror, replacing the deprecated
`execCommand`/contentEditable editor. The stored `KernelRichText` model and the
per-field feature allow-list are unchanged, and every change is still run through
`sanitizeRichText` (link hrefs are additionally guarded against unsafe schemes at
the editor boundary).

Adds click-to-edit live preview. The new `@kernel/visual-editing` SDK
(`kernelEditable(path)`, `useKernelPreview()`) lets any frontend become editable
inside the admin's live-preview iframe, and the built-in preview now focuses the
matching field when you click an element, with hover outlines — over an
origin-validated postMessage channel.
