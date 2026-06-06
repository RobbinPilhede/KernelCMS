# Navigation & App Shell

The app shell is the persistent chrome that wraps every admin route: a collapsible sidebar, a top bar with breadcrumbs and global actions, and the routed content region. In KernelCMS it is not a hand-authored layout that grows stale as you add content types — it is generated from your `kernel.config.ts` and rendered through TanStack Router's nested layout routes. This document specifies the shell layout contract, how collection and global navigation are derived from config, how breadcrumbs are computed from the active route match, and how the whole thing collapses gracefully from a 1440px desktop down to a phone.

## App-shell layout

The shell is a single TanStack Router layout route (`/_admin`) that owns three regions and renders an `<Outlet />` into the content region. Every authenticated admin route is a child of `_admin`, so the chrome mounts once and survives navigation — only the outlet re-renders. This is the same instinct Payload and Strapi follow with a fixed sidebar, but because we sit on TanStack Router the layout is a real route node, which means loaders, pending states, and error boundaries compose at the shell level instead of being bolted on.

```
┌──────────────────────────────────────────────────────────┐
│ ☰  KernelCMS         Pages › Editing "Home"      ⌘K  👤   │  ← TopBar
├────────────┬─────────────────────────────────────────────┤
│ Dashboard  │                                              │
│ ──────────  │                                              │
│ CONTENT    │                                              │
│  Pages     │            <Outlet />                         │
│  Posts     │         (routed content region)              │
│  Media     │                                              │
│ GLOBALS    │                                              │
│  Settings  │                                              │
│ ──────────  │                                              │
│ Users      │                                              │
└────────────┴─────────────────────────────────────────────┘
   Sidebar              ContentRegion
```

The shell is exported from `@kernel/admin` as `<AppShell />` and composed from primitives in `@kernel/ui` (`Sidebar`, `TopBar`, `Breadcrumbs`, `CommandTrigger`). Layout geometry lives in design tokens so white-label builds can retheme without forking components:

```ts
// @kernel/ui tokens (consumed via CSS custom properties)
export const shellTokens = {
  '--shell-sidebar-width': '256px',
  '--shell-sidebar-width-collapsed': '64px',
  '--shell-topbar-height': '56px',
  '--shell-content-max-width': '1200px',
  '--shell-z-sidebar': '40',
  '--shell-z-topbar': '50',
} as const
```

Sidebar open/collapsed state is reactive UI state, so it lives in a TanStack Store atom — not React context, not a parent `useState` threaded through props. The store persists to `localStorage` and rehydrates on mount, so a user who collapses the sidebar keeps it collapsed across sessions and tabs.

```ts
import { Store, useStore } from '@tanstack/react-store'

export const shellStore = new Store({
  sidebarOpen: true,
  sidebarMode: 'expanded' as 'expanded' | 'collapsed',
  mobileNavOpen: false,
})

export function useSidebar() {
  const mode = useStore(shellStore, (s) => s.sidebarMode)
  return {
    mode,
    toggle: () =>
      shellStore.setState((s) => ({
        ...s,
        sidebarMode: s.sidebarMode === 'expanded' ? 'collapsed' : 'expanded',
      })),
  }
}
```

The content region clamps to `--shell-content-max-width` and centers, which keeps form line-lengths readable on ultrawide monitors — a detail Sanity gets right and that bare Strapi list views do not.

## Collection nav generation

Navigation is derived, never authored. The admin reads the resolved config from `@kernel/core` and builds a nav tree: every collection becomes a list-view entry, every global becomes a singleton entry, and entries group under section headers. This is the core wedge over Strapi, where the content-type menu and the plugin menu are separate, partly hardcoded surfaces, and over Payload, where nav grouping is config-driven but not as composable. In KernelCMS the same `admin` block that controls labels also controls grouping, ordering, icons, and visibility.

```ts
// kernel.config.ts
import { defineConfig, collection, global } from '@kernel/core'

export default defineConfig({
  collections: [
    collection('pages', {
      labels: { singular: 'Page', plural: 'Pages' },
      admin: {
        group: 'Content',
        icon: 'file-text',
        order: 1,
        useAsTitle: 'title',
      },
      fields: [/* ... */],
    }),
    collection('media', {
      admin: { group: 'Content', icon: 'image', order: 3 },
      upload: true,
      fields: [/* ... */],
    }),
    collection('users', {
      admin: { group: 'System', icon: 'users', order: 1 },
      auth: true,
      fields: [/* ... */],
    }),
  ],
  globals: [
    global('settings', {
      admin: { group: 'Globals', icon: 'settings' },
      fields: [/* ... */],
    }),
  ],
})
```

The generator is a pure function — config in, nav tree out — which makes it trivially testable and keeps the sidebar in lockstep with the schema. Access control runs here too: the nav builder evaluates each entry's `read` access against the current user via the same operation core described in [Access Control](../06-auth-security/01-authorization-and-access-control.md), so an entry a user cannot read never renders. Hidden is hidden — there is no client-side flag a curious user can flip, because the filtered tree is what the server function returns.

```ts
// @kernel/admin
import type { ResolvedConfig, NavTree, User } from '@kernel/core'

export function buildNavTree(config: ResolvedConfig, user: User): NavTree {
  const entries = [
    ...config.collections.map((c) => ({
      kind: 'collection' as const,
      slug: c.slug,
      label: c.labels.plural,
      to: '/_admin/collections/$collection',
      params: { collection: c.slug },
      group: c.admin?.group ?? 'Content',
      icon: c.admin?.icon,
      order: c.admin?.order ?? 100,
      visible: can(user, c, 'read'),
    })),
    ...config.globals.map((g) => ({
      kind: 'global' as const,
      slug: g.slug,
      label: g.label,
      to: '/_admin/globals/$global',
      params: { global: g.slug },
      group: g.admin?.group ?? 'Globals',
      icon: g.admin?.icon,
      order: g.admin?.order ?? 100,
      visible: can(user, g, 'read'),
    })),
  ].filter((e) => e.visible)

  return groupBy(entries, 'group')
}
```

The nav tree is fetched once per session through TanStack Query with a long `staleTime`, keyed on the user id, and invalidated only when the user changes or a plugin mutates the config. Each link is a typed `<Link>` from TanStack Router, so the destination route, its params, and its loader are all known at build time — a mistyped collection slug is a compile error, not a 404. Plugins extend nav through the `@kernel/plugin-sdk`, which exposes a `nav.register()` hook for non-content destinations (a dashboard, an analytics view, a custom tool) that participates in the same grouping and ordering model.

| Concern | Strapi | Payload | KernelCMS |
| --- | --- | --- | --- |
| Nav source | Partly hardcoded + plugin menu | Config-driven | Config-driven, single `admin` block |
| Access-filtered nav | Partial | Yes | Yes, server-evaluated |
| Type-safe links | No | Partial | Yes (TanStack Router) |
| Plugin nav | Separate menu | Custom views | `nav.register()`, same model |

## Breadcrumbs

Breadcrumbs are computed from the active route match chain, not stored in a global. Each route in the `_admin` tree contributes a `crumb` via TanStack Router's `staticData`, and the `<Breadcrumbs />` component reads `useMatches()` to walk from the shell root to the leaf. Dynamic segments — a document id, for instance — resolve their label from the route's loader data, so "Editing 5f3a..." becomes "Editing Home" using the collection's `useAsTitle` field.

```ts
// routes/_admin/collections/$collection/$id.tsx
export const Route = createFileRoute('/_admin/collections/$collection/$id')({
  loader: ({ params }) => fetchDocument(params.collection, params.id),
  staticData: {
    crumb: (match) => ({
      label: match.loaderData?.title ?? 'Untitled',
      to: '/_admin/collections/$collection/$id',
      params: match.params,
    }),
  },
})
```

```ts
// @kernel/admin <Breadcrumbs />
import { useMatches, Link } from '@tanstack/react-router'

export function Breadcrumbs() {
  const crumbs = useMatches()
    .map((m) => m.staticData.crumb?.(m))
    .filter((c): c is Crumb => Boolean(c))

  return (
    <nav aria-label="Breadcrumb">
      <ol>
        {crumbs.map((c, i) => (
          <li key={c.label} aria-current={i === crumbs.length - 1 ? 'page' : undefined}>
            {i < crumbs.length - 1 ? <Link to={c.to} params={c.params}>{c.label}</Link> : c.label}
          </li>
        ))}
      </ol>
    </nav>
  )
}
```

Because crumbs derive from matches, they stay correct through back/forward navigation and deep links with zero extra wiring — Sanity, whose Structure Builder makes the document path explicit, achieves something similar but requires you to author the structure; here the route tree already encodes it. The trailing crumb carries `aria-current="page"` and renders as plain text, never a link, which is both correct semantics and a small accessibility win toward WCAG 2.2 AA.

## Responsive shell

The shell targets three layout modes driven by container width, using container queries on the shell root rather than viewport media queries, so the admin behaves correctly when embedded in a split-pane live-preview workspace.

| Mode | Width | Sidebar | TopBar |
| --- | --- | --- | --- |
| Desktop | ≥ 1024px | Pinned, expanded/collapsed toggle | Full breadcrumbs + actions |
| Tablet | 640–1023px | Collapsed to icons, hover/focus to expand | Breadcrumbs truncate middle |
| Mobile | < 640px | Off-canvas drawer behind `☰` | Title + `☰` + `⌘K` only |

```
DESKTOP                          MOBILE
┌─────┬──────────┐               ┌──────────────┐
│ nav │ content  │               │ ☰  Pages  ⌘K │
│     │          │      →        ├──────────────┤
│     │          │               │   content    │
└─────┴──────────┘               └──────────────┘
                                  (nav = drawer)
```

On mobile the sidebar becomes an off-canvas `<dialog>` element — native, focus-trapping, and dismissible with `Escape` for free — toggled by the `mobileNavOpen` atom in the shell store. Opening it traps focus and sets `aria-modal`; selecting a link closes it and returns focus to the trigger. Breadcrumbs collapse to show only the first and last crumb with an ellipsis between, and the command palette (`⌘K`) becomes the primary navigation affordance on small screens, which is faster than tapping through a drawer for power users. All motion respects `prefers-reduced-motion`; the drawer slide is the only animated transition and it degrades to an instant show/hide. Touch targets in the mobile nav are a minimum of 44px, and the toggle is a real `<button>` with an `aria-label`, never a clickable `<div>`.

The same shell renders identically in self-host and KernelCMS Cloud — the only difference is that Cloud injects a tenant switcher into the top bar via the `nav.register()` slot, which the responsive rules already account for.

## Open questions

- Should sidebar group ordering be globally configurable in `kernel.config.ts` (a `admin.nav.groups` array) or inferred from first-seen order? Inferred is simpler but makes group reordering require touching collection definitions.
- For very large schemas (50+ collections), do we virtualize the sidebar with TanStack Virtual, or is a search-filter input within the nav sufficient?
- Should breadcrumb label resolution for unsaved/draft documents show the draft title or a persistent "Untitled" until first save?
