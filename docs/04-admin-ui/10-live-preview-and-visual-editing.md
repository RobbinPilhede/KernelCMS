# Live Preview & Visual Editing

KernelCMS renders your real front end inside the admin, hydrated with unsaved draft data, and lets editors click any rendered element to jump to the field that produced it. The whole pipeline is built on the same primitives as the rest of the admin — TanStack Query for draft fetching, TanStack Store for the editor-to-iframe channel, and TanStack Form for the document model — so preview state and edit state are never two diverging copies of the truth. This document specifies the iframe contract, the draft-data path, the overlay system, and where KernelCMS lands relative to Sanity's Presentation tool.

## The live-preview iframe

Live preview is an `<iframe>` that points at _your_ application — the Next.js, Astro, SvelteKit, or TanStack Start site you already deploy — running in a special draft mode. KernelCMS does not re-implement your front end or ask you to rebuild components inside the admin. That is the same stance Sanity took with Presentation and the opposite of Strapi's older preview, which only ever embedded a single configured URL with no two-way channel.

You opt a collection into preview by giving it a URL resolver in `kernel.config.ts`:

```ts
import { defineConfig } from '@kernel/core'
import { livePreview } from '@kernel/admin'

export default defineConfig({
  collections: [
    {
      slug: 'pages',
      admin: {
        livePreview: livePreview({
          // Resolve a preview URL from the in-progress document.
          url: ({ doc, locale }) => `https://app.example.com/${locale}/${doc.slug}?preview=1`,
          // Breakpoints the editor can toggle in the preview toolbar.
          breakpoints: [
            { label: 'Mobile', width: 375, height: 667 },
            { label: 'Tablet', width: 768, height: 1024 },
            { label: 'Desktop', width: 1440, height: 900 },
          ],
        }),
      },
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'slug', type: 'text', required: true },
        {
          name: 'hero',
          type: 'group',
          fields: [
            /* ... */
          ],
        },
        {
          name: 'body',
          type: 'blocks',
          blocks: [
            /* ... */
          ],
        },
      ],
    },
  ],
})
```

The admin route `/admin/collections/pages/:id` splits into a two-pane layout: the TanStack Form document editor on the left, the preview iframe on the right. The split is resizable and persisted to TanStack Store, and the iframe width snaps to the active breakpoint.

```
┌───────────── /admin/collections/pages/:id ─────────────┐
│  Document editor (TanStack Form)  │  Live preview frame │
│                                   │  ┌────────────────┐ │
│  [ title  ]                       │  │ <iframe        │ │
│  [ slug   ]                       │  │   src=preview  │ │
│  [ hero…  ]   ◄── field focus ───►│  │   sandbox >    │ │
│  [ body…  ]                       │  │  your site     │ │
│                                   │  └────────────────┘ │
│  drafts · autosave · publish      │  📱 📱 🖥  ↻  ⤢      │
└────────────────────────────────────────────────────────┘
```

Because the iframe loads a cross-origin app, the security posture matters. The frame is rendered with an explicit `sandbox` allowlist (`allow-scripts allow-same-origin allow-forms`) and we pin the expected origin. Every `postMessage` exchange validates `event.origin` against the resolver's host and a per-session nonce minted when the editor route mounts. Origins not on the allowlist are dropped silently. See [Access Control](../06-auth-security/01-authorization-and-access-control.md) for how draft visibility is gated server-side regardless of what the iframe requests.

## Passing draft data

The hard part of live preview is showing content that has not been saved yet — and certainly not published. KernelCMS supports two delivery modes, and you choose per project based on how aggressively your front end is cached.

| Mode                   | Mechanism                                                        | Latency                   | Best for                                               |
| ---------------------- | ---------------------------------------------------------------- | ------------------------- | ------------------------------------------------------ |
| **Server draft fetch** | Front end reads drafts from `@kernel/client` using a draft token | One round-trip per change | SSR / RSC apps, server components                      |
| **postMessage push**   | Editor streams the in-memory form doc to the iframe              | Per-keystroke, no network | SPA / islands front ends that can re-render from props |

### Server draft fetch

In this mode the iframe just reloads (or revalidates) and the front end pulls the latest draft itself. The admin sets a short-lived, httpOnly draft cookie scoped to the preview origin; your front end forwards it to the Local/RPC API. Drafts are served only when the request carries a valid draft token whose access policy permits the current user — this is the same `where`/`depth` query language documented in Query Language, with `draft: true` flipped on.

```ts
// app/[locale]/[slug]/page.tsx — your Next.js front end
import { createClient } from '@kernel/client'
import { draftMode } from 'next/headers'

const kernel = createClient({ url: process.env.KERNEL_URL })

export default async function Page({ params }) {
  const { isEnabled } = draftMode()
  const page = await kernel.collections.pages.find({
    where: { slug: { equals: params.slug } },
    locale: params.locale,
    draft: isEnabled,   // serve unpublished version inside preview
    depth: 2,
  })
  return <PageRenderer doc={page.docs[0]} />
}
```

This mirrors Payload's draft-preview approach and is the right default when your renderer is server-side: there is exactly one rendering path, and preview is just that path with `draft: true`.

### postMessage push

For client-rendered front ends you can skip the round-trip entirely. The editor serializes the live TanStack Form document and pushes it through a typed channel the moment a field changes. The `@kernel/client` preview bridge listens inside the iframe and hands your app a reactive doc.

```ts
// editor side — wired automatically by @kernel/admin
import { previewChannel } from '@kernel/admin'

form.subscribe((state) => {
  previewChannel.send({
    type: 'kernel:doc',
    collection: 'pages',
    id: doc.id,
    locale,
    data: state.values, // the unsaved draft, fully typed
  })
})
```

```ts
// front-end side
import { useKernelPreview } from '@kernel/client/preview'

export function PageRenderer({ doc: initial }) {
  // Falls back to `initial` (the SSR doc) until the first message arrives.
  const doc = useKernelPreview({ collection: 'pages', fallback: initial })
  return <Hero {...doc.hero} />
}
```

The push channel is debounced (default 80 ms) and coalesces rapid keystrokes. Large fields like `richText` and `blocks` are diffed so we send patches, not the whole document, keeping the channel cheap even on long documents that TanStack Virtual is paging through in the editor.

## Visual editing overlays

Overlays are the click-to-edit layer. When the front end renders a value, it tags the surrounding DOM with provenance — which document, which field path, which array index — and the admin draws an interactive overlay on top of the iframe so editors can click rendered content to focus the matching field.

You emit provenance with a single helper from `@kernel/client`:

```tsx
import { edit } from '@kernel/client/preview'

export function Hero({ doc }) {
  return (
    <section {...edit(doc, 'hero.heading')}>
      <h1 {...edit(doc, 'hero.heading')}>{doc.hero.heading}</h1>
      <p {...edit(doc, 'hero.subheading')}>{doc.hero.subheading}</p>
    </section>
  )
}
```

`edit()` expands to `data-kernel-*` attributes encoding the collection, document id, locale, and the dotted field path. The overlay engine in `@kernel/admin` scans the iframe document for these attributes (and re-scans on a `MutationObserver` tick), computes bounding boxes via `getBoundingClientRect`, and paints absolutely-positioned hit regions in the admin coordinate space. The data flow is intentionally one direction for selection and another for sync:

```
   editor (form)                         iframe (your site)
        │                                       │
        │   kernel:doc  (draft values) ───────► │  re-render
        │                                       │
        │ ◄─── kernel:overlay (field paths) ─── │  data-kernel-* attrs
        │                                       │
   click overlay ──► focus + scroll field      │
        │   kernel:focus (highlight el) ──────► │  outline element
```

Clicking an overlay does three things: focuses the corresponding TanStack Form field, scrolls it into view in the left pane, and sends `kernel:focus` back so the iframe outlines the live element. Hovering a field in the editor reverse-highlights its rendered output. Array and `blocks` items get richer affordances — the overlay surfaces add / remove / reorder controls bound to the same TanStack Form array helpers used in the normal editor, so a drag in the preview is the identical mutation as a drag in the field UI.

| Capability                 | Bound to                 | Notes                                                                                    |
| -------------------------- | ------------------------ | ---------------------------------------------------------------------------------------- |
| Click → focus field        | TanStack Form `setFocus` | Resolves dotted path to field node                                                       |
| Hover field → highlight el | `kernel:focus` message   | Debounced, outline only                                                                  |
| Reorder `array`/`blocks`   | Form array helpers       | Same op as field-UI drag                                                                 |
| Add/remove block           | Block registry + Form    | Insert at clicked position                                                               |
| Localized field badge      | Field config `localized` | Shows active locale, see [Localization](../02-data-modeling/09-localization-and-i18n.md) |

Overlays degrade gracefully: a front end that ships zero `edit()` calls still gets full live preview, just without click-to-edit. This keeps adoption incremental — wire preview first, sprinkle `edit()` in later.

## Comparison to Sanity Presentation

Sanity's Presentation tool established the modern pattern: an iframe of the real site, drafts delivered via a content source map / stega-encoded strings, and click-to-edit overlays driven by `@sanity/visual-editing`. KernelCMS adopts the same shape on purpose, then diverges where the architecture lets us do better.

| Dimension      | Sanity Presentation                                     | KernelCMS                                                  |
| -------------- | ------------------------------------------------------- | ---------------------------------------------------------- |
| Draft delivery | Perspective + content source map; stega-encoded strings | Explicit `draft: true` query _or_ typed `postMessage` push |
| Provenance     | Invisible stega chars embedded in string values         | Explicit `edit()` → `data-kernel-*` attributes             |
| Editor state   | Sanity Studio (Structure)                               | TanStack Form, same model as the field UI                  |
| Field binding  | Path resolution back into Studio                        | Direct TanStack Form node focus                            |
| Live updates   | Loader + listen query                                   | TanStack Query invalidation or push channel                |
| Type safety    | Typed via GROQ codegen                                  | End-to-end inference from `kernel.config.ts`               |

The substantive difference is provenance. Sanity's stega approach hides zero-width characters inside string content so any rendered string carries its own edit metadata — clever, framework-agnostic, but it leaks invisible characters into your DOM, breaks on `===` comparisons and `.length`, and can't tag non-string output (an image, a number, a boolean toggle) without extra work. KernelCMS uses explicit attributes via `edit()`. It costs one prop per editable element, but it tags _anything_, never mutates your content, and survives copy-paste and string comparison untouched. For teams that genuinely want zero front-end changes, the `postMessage` push mode plus a build-time codemod that injects `edit()` is on the roadmap.

The second difference is the editor model. In Sanity, the iframe talks to Studio's document store; in KernelCMS the overlay talks to the _same TanStack Form instance_ that powers the normal editor. There is no second source of truth to reconcile — autosave, [version history](../02-data-modeling/10-versioning-drafts-and-autosave.md), validation, and access control behave identically whether the edit originated from a field input or an overlay click.

## Open questions

- **Default delivery mode.** Should `livePreview()` default to server draft fetch (safe, one path) or auto-detect SPA front ends and prefer the push channel? Leaning toward server fetch as the default with an explicit `mode: 'push'` opt-in.
- **Cross-origin overlay precision.** `getBoundingClientRect` across origins is fine, but transformed/animated elements may drift between paints. Do we sample on `requestAnimationFrame` during interaction, or accept a small lag outside drag operations?
- **Codemod scope.** A build-time injector for `edit()` would remove the manual-prop cost, but reliably mapping arbitrary JSX expressions back to field paths is hard. Ship it as a best-effort `@kernel/plugin-sdk` transform, or keep provenance explicit and documented?
- **Block insertion UX.** When adding a `blocks` item from an overlay, do we open the block picker as a floating menu anchored in the iframe coordinate space, or always route it back to the left pane?
