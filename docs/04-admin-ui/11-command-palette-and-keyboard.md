# Command Palette & Keyboard UX

The KernelCMS admin is built for people who live in it eight hours a day. Mouse-driven CRUD is the floor, not the ceiling. Every navigation target, every document action, and every collection is reachable from the keyboard through a command palette and a global shortcut layer. This document specifies the palette, the shortcut registry, the quick switcher, and how all three stay accessible under WCAG 2.2 AA. The implementation leans on TanStack Router for type-safe navigation, TanStack Store for reactive palette state, and TanStack Query for live search results.

Payload ships a serviceable nav and a recent-documents list but no command palette. Sanity's Studio has a global search (`Ctrl/Cmd+K`) that is genuinely good for jumping to documents, but it is search-first and does not expose actions or settings as first-class commands. Strapi has neither. KernelCMS treats the palette as the primary control surface — navigation, actions, and search share one ranked, keyboard-driven list, and plugins register into it through the same `@kernel/plugin-sdk` contract the core uses.

## The command palette

The palette is a single overlay (`Cmd+K` / `Ctrl+K`) that unifies three result kinds: **commands** (verbs — "Publish document", "Toggle dark mode"), **navigation** (collections, globals, settings routes), and **search** (live document matches from your configured search adapter). It is mode-switching, not modal: typing `>` filters to commands only, `#` to settings, `/` to documents, and a bare query searches everything ranked together.

```
┌─────────────────────────────────────────────────┐
│  >  publish                                   ⌘K │
├─────────────────────────────────────────────────┤
│  ⚡ Publish document            ⌘ ⇧ P            │
│  ⚡ Publish and create another                   │
│  ⚡ Schedule publish…                            │
├─ Recent ────────────────────────────────────────┤
│  📄 "Q3 launch post"          Posts             │
│  📄 "Pricing"                 Pages             │
└─────────────────────────────────────────────────┘
```

Commands are contributed declaratively. A command has an id, a title, an optional keybinding, a `when` predicate that gates visibility against the current context (active route, selected document, user permissions), and a `run` handler. Access control is evaluated here too — a command that the current user cannot perform never renders.

```ts
// @kernel/admin command contract
import type { CommandContext } from '@kernel/admin'

interface Command {
  id: string                       // 'document.publish'
  title: string | ((ctx: CommandContext) => string)
  group?: string                   // 'Document' | 'Navigation' | 'Settings'
  keybinding?: string              // 'mod+shift+p'  (mod = ⌘ on macOS, Ctrl elsewhere)
  icon?: string
  when?: (ctx: CommandContext) => boolean
  run: (ctx: CommandContext) => void | Promise<void>
}
```

The context object is the seam that keeps commands honest. It carries the resolved route, the active document and its draft state, the current locale, and a permission helper backed by the same server-side access rules the operation core enforces — so the palette can never offer an action the API would reject.

```ts
interface CommandContext {
  route: RouteMatch
  document?: { id: string; collection: string; status: 'draft' | 'published' }
  locale: string
  can: (action: string, scope?: { collection?: string; id?: string }) => boolean
  router: Router          // TanStack Router instance
  query: QueryClient      // TanStack Query client for invalidation
  toast: ToastApi
}
```

Registering a command from a plugin or from `kernel.config.ts` is the same call. Core commands ("Save", "Publish", "Duplicate", "Go to collection…") ship registered; you add yours alongside.

```ts
// kernel.config.ts
import { defineConfig } from '@kernel/core'
import { defineCommand } from '@kernel/admin'

export default defineConfig({
  admin: {
    commands: [
      defineCommand({
        id: 'post.requestReview',
        title: 'Request editorial review',
        group: 'Document',
        keybinding: 'mod+shift+r',
        when: (ctx) =>
          ctx.document?.collection === 'posts' &&
          ctx.document.status === 'draft' &&
          ctx.can('update', { collection: 'posts', id: ctx.document.id }),
        run: async (ctx) => {
          await ctx.query.fetchQuery(requestReviewMutation(ctx.document!.id))
          ctx.toast.success('Review requested')
        },
      }),
    ],
  },
})
```

### Ranking and result fusion

Results come from three providers — command index, route index, and the search adapter — and are merged into one ranked list. Commands and routes rank locally with a fuzzy matcher (subsequence match plus prefix and word-boundary bonuses, recency boost from a per-user MRU list in TanStack Store). Document hits arrive asynchronously from `@kernel/client` against your search adapter and are deboucned and streamed in as they resolve, so the palette never blocks on a network round-trip.

| Provider        | Source                          | Latency      | Ranking inputs                          |
|-----------------|---------------------------------|--------------|-----------------------------------------|
| Commands        | in-memory registry              | synchronous  | fuzzy score, MRU, `group` weight        |
| Navigation      | TanStack Router route tree      | synchronous  | fuzzy score, MRU                        |
| Documents       | search adapter via TanStack Query | async/debounced | adapter relevance, collection weight |

Synchronous providers render on the first keystroke; the async document list fills in underneath without reflowing the selected row. The selection index is anchored to a stable result id, never to a list position, so an item never shifts under the user's cursor mid-keystroke — a subtle but important correctness property for keyboard navigation.

## Keyboard shortcuts

Shortcuts are a registry, not a pile of `keydown` listeners. `@kernel/admin` exposes a single `useKeybindings` hook backed by one document-level dispatcher. The dispatcher resolves a chord against the active scope stack and fires the matching command. Centralizing dispatch means no two features silently bind the same chord, and conflicts are detected at registration time and surfaced in the console during development.

### Default bindings

`mod` resolves to `⌘` on macOS and `Ctrl` elsewhere. Bindings live in three scopes: **global** (always active), **list** (collection list view), and **document** (edit view).

| Chord            | Scope     | Action                          |
|------------------|-----------|---------------------------------|
| `mod+k`          | global    | Open command palette            |
| `mod+p`          | global    | Quick switcher (documents)      |
| `mod+shift+p`    | document  | Publish document                |
| `mod+s`          | document  | Save (draft or autosave flush)  |
| `mod+enter`      | document  | Save and close                  |
| `mod+/`          | global    | Open keyboard shortcut help     |
| `g` then `c`     | global    | Go to Collections               |
| `g` then `m`     | global    | Go to Media library             |
| `j` / `k`        | list      | Move selection down / up        |
| `x`              | list      | Toggle row selection            |
| `mod+a`          | list      | Select all (current page)       |
| `?`              | global    | Toggle shortcut cheat sheet     |

The `g`-prefixed sequences are two-key chords (Gmail-style), handled by a short-lived chord buffer that times out after 1000ms. Single-letter bindings (`j`, `k`, `x`) only fire when focus is not inside a text input, which the dispatcher checks via the focused element's role and `contenteditable` state.

### Scopes and the dispatch model

Scopes form a stack. The document edit view pushes `document`; opening the palette pushes `palette`, which is *exclusive* — it suppresses everything below it so Escape and arrow keys belong to the overlay alone. This is what prevents the classic bug where an arrow key both moves the palette selection and scrolls the page behind it.

```
focus enters edit view  → push 'document'
open palette            → push 'palette' (exclusive)
                          dispatch resolves top-down, stops at exclusive
close palette           → pop 'palette'
```

```ts
import { useKeybindings } from '@kernel/admin'

function DocumentEditor() {
  useKeybindings('document', {
    'mod+s': (ctx) => ctx.run('document.save'),
    'mod+shift+p': (ctx) => ctx.run('document.publish'),
    'mod+enter': (ctx) => ctx.run('document.saveAndClose'),
  })
  // …
}
```

Note that bindings dispatch to command ids rather than inline handlers wherever possible. That keeps one definition of "what publish does" — the palette, the toolbar button, and the shortcut all call `document.publish`, so behavior, access checks, and toasts stay identical across every entry point. This is the central discipline that Strapi lacks entirely and that Payload only partially achieves through its toolbar.

### User and config overrides

Operators rebind defaults in `kernel.config.ts`; individual users override in their profile preferences, persisted per-user. User preferences win over config, config wins over defaults. A rebind that collides with a reserved global (`mod+k`) is rejected at validation time with a clear error rather than silently shadowing it.

```ts
admin: {
  keybindings: {
    'document.publish': 'mod+shift+enter',  // org-wide override
    'navigation.media': false,              // disable a default
  },
}
```

## The quick switcher

The quick switcher (`Cmd+P` / `Ctrl+P`) is a focused subset of the palette tuned for one job: jump to a document fast. No command results, no settings — just documents, ranked by recency first and relevance second. It opens pre-seeded with your most recently edited documents (per-user MRU from TanStack Store, hydrated from the server), so the common case — "back to the thing I was just editing" — is zero keystrokes after the chord.

Typing filters across collections by default. Scope it with a collection prefix and a colon: `posts: launch` searches only the `posts` collection. The colon syntax is parsed client-side into the shared query language (`where` / `sort` / `depth`) so the same request shape hits any search adapter — Postgres full-text, a SQLite FTS index, or an external engine like Typesense — without the switcher knowing which is configured.

```
┌─────────────────────────────────────────────────┐
│  posts: launch                                ⌘P │
├─────────────────────────────────────────────────┤
│  📄 Q3 launch post              Posts  · edited 2m│
│  📄 Launch checklist            Posts  · edited 1d│
│  📄 Pre-launch FAQ              Posts  · draft    │
└─────────────────────────────────────────────────┘
```

Each row shows collection, status badge (draft/published), and relative edit time. `Enter` opens in the current locale; `mod+Enter` opens in a new tab. Selection is keyboard-only by default but fully clickable. Because results stream through TanStack Query, an open switcher revalidates in the background — reopen it after publishing and the status badge is already current, no manual refresh.

This is the feature most directly comparable to Sanity's global search, and the deliberate difference is separation of concerns: KernelCMS keeps document-jumping (`mod+p`) distinct from the command surface (`mod+k`). Two muscle-memory paths, each instant, instead of one overloaded box you have to mentally filter.

## Accessibility of shortcuts

Keyboard power features are an accessibility liability if they trap or surprise screen-reader users, so the rules below are non-negotiable and verified in CI against the accessibility budget.

- **Single-character shortcuts are escapable and gated.** Per WCAG 2.2 SC 2.1.4 (Character Key Shortcuts), every single-key binding (`j`, `k`, `x`, `?`) only fires outside text-entry contexts and can be disabled globally in user preferences. They never fire while a field, the rich-text editor, or any `contenteditable` has focus.
- **The palette is a proper dialog.** It renders as `role="dialog"` with `aria-modal="true"`, moves focus in on open, restores focus to the triggering element on close, and traps Tab within the overlay. Escape always closes it.
- **Results are an ARIA listbox.** The input owns `role="combobox"` with `aria-expanded` and `aria-controls`; results are `role="listbox"` / `role="option"`. The active row is tracked with `aria-activedescendant` so arrow keys move a virtual cursor without ever stealing DOM focus from the input — the screen reader announces each option as you navigate.
- **Streaming results are announced politely.** When async document hits arrive, an `aria-live="polite"` region announces the updated count ("8 results") so non-sighted users learn the list grew without being interrupted mid-typing.
- **No keyboard trap, ever (SC 2.1.2).** Every overlay and chord buffer has an unconditional escape. The chord buffer auto-clears on timeout, and pressing Escape mid-chord cancels it.
- **Visible focus (SC 2.4.7) and motion respect.** The active option has a `:focus-visible`-equivalent indicator meeting 3:1 contrast against its background, and open/close transitions honor `prefers-reduced-motion: reduce`.

A discoverable cheat sheet (`?` or `mod+/`) lists every active binding for the current scope, reads its source from the same registry that drives dispatch — so the help is never stale — and is itself a focus-trapped, Escape-dismissible dialog. The cheat sheet doubles as documentation: there is exactly one source of truth for what each chord does.

## Open questions

- **Conflict resolution UI.** When a user override collides with a plugin-registered binding, should we resolve silently (user wins) or prompt once in a settings surface? Leaning toward user-wins with a non-blocking notice, but the plugin author's intent may matter for safety-critical actions.
- **Server-side command execution.** Some commands are pure client navigation; others are mutations. Should long-running commands ("Reindex search", "Bulk publish") move to a job queue adapter with palette-driven progress, rather than running inline? Likely yes, but the progress affordance inside a transient palette is unresolved.
- **Cross-locale switcher results.** Should the quick switcher surface a single document once, or once per localized variant? Current plan is one row per document with a locale switch on open, but multi-locale teams may want per-locale rows.
