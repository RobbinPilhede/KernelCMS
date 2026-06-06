# Dashboard & Home

The dashboard is the first screen an editor sees after login. In KernelCMS it is not a static welcome page — it is a config-driven grid of widgets backed by the same Local API and TanStack Query cache that power the rest of the admin. This document specifies the default dashboard, the widget model, the `slots` extension surface, and the recent activity feed, including how each piece is declared in `kernel.config.ts` and rendered by `@kernel/admin`.

## The default dashboard

Out of the box, the dashboard lives at the route `/admin` (handled by TanStack Router) and renders a responsive widget grid. KernelCMS ships an opinionated default layout so a fresh install is useful on first boot, rather than the empty "Welcome to the admin" splash that Strapi shows or the document-list-as-homepage that Payload defaults to.

The default layout is computed, not hardcoded. `@kernel/admin` introspects the resolved config — collections, globals, the user's access rules — and assembles a sensible grid:

```
┌─────────────────────────────────────────────────────────┐
│  Welcome, {user.name}                      [Command ⌘K]  │
├──────────────────────────┬──────────────────────────────┤
│  Collections             │  Recent activity             │
│  ┌────────┐ ┌────────┐    │  • Nora published "Pricing"  │
│  │ Posts  │ │ Authors│    │  • Lars created "Q3 Report"  │
│  │  142   │ │   18   │    │  • Saga edited Settings      │
│  └────────┘ └────────┘    │  • Rune uploaded hero.webp   │
│  ┌────────┐               │  …                           │
│  │ Pages  │               │                              │
│  │   9    │               │                              │
│  └────────┘               │                              │
├──────────────────────────┴──────────────────────────────┤
│  Your drafts (3)          Globals          Media (1.2k)  │
└─────────────────────────────────────────────────────────┘
```

The default widgets are:

| Widget | Purpose | Data source |
| --- | --- | --- |
| `collections-overview` | Card per collection with live document counts and a quick "create" action | `count` op per collection, batched |
| `recent-activity` | Cross-collection feed of create/update/publish/delete events | Activity log adapter |
| `my-drafts` | Documents the current user has unpublished drafts on | `find` with `where: { _status: 'draft', updatedBy: userId } ` |
| `globals` | Quick links to each global (singleton) | Resolved config |
| `media-summary` | Object count and total size from the active storage adapter | `@kernel/storage` stats |

Counts are fetched through the Local API and cached by TanStack Query with a 30-second `staleTime`, so navigating away and back does not re-hit the database. Every widget respects access control: if the current user cannot `read` a collection, its card never renders — the dashboard is filtered at the data layer, not hidden with CSS. See [Access Control](../06-auth-security/01-authorization-and-access-control.md) for how operation-level rules are evaluated.

Editors can rearrange, resize, hide, and show widgets. That per-user layout is persisted server-side (keyed by user id) so it follows them across browsers, unlike Strapi's homepage, which is fixed, and Sanity's Studio, which has no dashboard concept at all without the optional `@sanity/dashboard` plugin.

## Widgets

A widget is a typed React component plus a small descriptor. The descriptor declares identity, default placement, data requirements, and access. KernelCMS provides a `defineWidget` helper from `@kernel/admin` so the contract is fully inferred — there is no untyped registry of strings.

```ts
// widgets/published-this-week.tsx
import { defineWidget } from '@kernel/admin'
import { useLocalQuery } from '@kernel/client'

export const publishedThisWeek = defineWidget({
  id: 'published-this-week',
  title: 'Published this week',
  // Grid sizing in a 12-column layout; users can resize within min/max.
  defaultSize: { w: 4, h: 2, minW: 3, minH: 2 },
  // Only show to users who can read at least one of these collections.
  access: ({ user }) => user.roles.includes('editor'),
  Component: () => {
    const since = startOfWeek(new Date())
    const { data, isLoading } = useLocalQuery('posts', {
      operation: 'count',
      where: { _status: { equals: 'published' }, publishedAt: { greater_than: since } },
    })
    if (isLoading) return <Widget.Skeleton lines={1} />
    return <Widget.Stat value={data.totalDocs} label="published" trend="up" />
  },
})
```

Key properties of the widget contract:

- **`id`** — stable, unique. Layout persistence and slot targeting key off it.
- **`Component`** — a function component. It may use any TanStack hook; `useLocalQuery` from `@kernel/client` is the in-process, type-inferred path to the operation core (the same call the REST and GraphQL layers wrap).
- **`access`** — evaluated server-side during dashboard assembly. A widget the user cannot see is never serialized to the client, so it cannot leak counts or titles. This is stricter than Strapi, where homepage widgets render client-side and rely on the API to reject the follow-up request.
- **`defaultSize` / `refetch`** — placement and an optional polling interval (the activity feed uses this).

Widgets are registered in config:

```ts
// kernel.config.ts
import { defineConfig } from '@kernel/core'
import { publishedThisWeek } from './widgets/published-this-week'
import { deploymentStatus } from './widgets/deployment-status'

export default defineConfig({
  admin: {
    dashboard: {
      widgets: [publishedThisWeek, deploymentStatus],
      // Override the default layout for everyone; users can still customize.
      defaultLayout: [
        { id: 'collections-overview', w: 8, h: 3, x: 0, y: 0 },
        { id: 'recent-activity', w: 4, h: 6, x: 8, y: 0 },
        { id: 'published-this-week', w: 4, h: 2, x: 0, y: 3 },
      ],
    },
  },
})
```

The grid itself is virtualized with TanStack Virtual once a dashboard exceeds the viewport, so a workspace with 40 collection cards stays responsive. Drag-and-resize state is held in TanStack Store and flushed to the persistence endpoint on drop (debounced), not on every pointer move.

### Rendering and error isolation

Each widget is wrapped in its own error boundary. A widget that throws — a bad third-party API call, a null deref — renders a compact "This widget failed to load" tile with a retry button, while the rest of the dashboard stays interactive. One broken widget never blanks the whole home screen. Loading and empty states are mandated by the `Widget.Skeleton` / `Widget.Empty` primitives, matching the always-on async-state rule the rest of the admin follows.

## Custom dashboard slots

Widgets answer "what cards appear in the grid." Slots answer "what appears in the named regions around and inside the dashboard." Slots are KernelCMS's general extension mechanism for the admin shell, and the dashboard exposes a specific set of them. This is how plugins and `@kernel/plugin-sdk` authors inject UI without forking the admin — closer to Sanity's pluggable Studio than to Payload's fixed `admin.components` map or Strapi's injection-zone API.

The dashboard slots:

| Slot | Location | Typical use |
| --- | --- | --- |
| `dashboard.header` | Above the grid | Environment banner, onboarding checklist |
| `dashboard.beforeWidgets` | Top of grid column | Announcements, broadcast messages |
| `dashboard.afterWidgets` | Bottom of grid | Support links, version/diagnostics footer |
| `dashboard.sidebar` | Right rail | Pinned tasks, scheduled publishes |

Slots accept components from any plugin and from app config. Resolution is deterministic and ordered, so two plugins targeting the same slot do not race:

```ts
// kernel.config.ts
import { OnboardingChecklist } from '@/admin/onboarding'

export default defineConfig({
  admin: {
    slots: {
      'dashboard.header': [
        { component: OnboardingChecklist, order: 0 },
      ],
    },
  },
})
```

A plugin contributes to the same slot through the SDK, and the host merges both lists by `order`:

```ts
// @kernel/plugin-sdk
export const auditPlugin = definePlugin({
  name: 'audit-log',
  admin: {
    slots: {
      'dashboard.sidebar': [{ component: PendingReviewList, order: 10 }],
    },
  },
})
```

Slot components receive a typed `AdminContext` (current user, active locale, resolved config, the `@kernel/client` instance) so they can run their own queries through the Local API. Because the same `slots` map drives the collection list and document edit views, learning it once unlocks the entire admin surface — there is no separate concept per page.

## Recent activity feed

The activity feed is the dashboard's most-used widget, and it has real product weight: it is the answer to "what changed, by whom, when." KernelCMS records an activity entry for every mutating operation — `create`, `update`, `delete`, publish, unpublish, restore, and uploads — emitted from the operation core itself, not from individual route handlers. That means activity is captured identically whether the change came in over REST, GraphQL, RPC, or a direct Local API call from a script. Payload has document versions but no unified activity stream; Strapi's audit log is an Enterprise-only feature. KernelCMS treats the feed as core.

Activity is persisted through a dedicated adapter so the stream can live wherever it scales best — the primary database by default, or a separate append-only store / log pipeline for high-write workspaces:

```ts
// kernel.config.ts
import { sqlActivity } from '@kernel/server/activity'

export default defineConfig({
  admin: {
    activity: sqlActivity({
      retentionDays: 90,
      // Field-level diffs are stored for these collections; others store metadata only.
      diff: ['posts', 'pages'],
    }),
  },
})
```

Each entry is a typed record:

```ts
interface ActivityEntry {
  id: string
  actor: { id: string; name: string }
  action: 'create' | 'update' | 'delete' | 'publish' | 'unpublish' | 'restore' | 'upload'
  target: { collection: string; documentId: string; title: string }
  locale?: string
  diff?: FieldDiff[]   // present only when diff capture is enabled for the collection
  at: string           // ISO 8601
}
```

The feed widget streams updates rather than relying on cold polling. It opens a server-sent events channel via a TanStack Start server function; new entries push into the TanStack Query cache and animate in, so an editor watching the dashboard sees a colleague's publish appear within a second. If the SSE connection drops, the widget degrades to a 15-second `refetch` interval — the `refetch` property on the widget descriptor — and reconnects in the background.

Access control applies per entry: the feed only shows activity on documents the current user can `read`. The filtering happens in the activity adapter query, so a writer scoped to one collection never even receives entries for collections they cannot see. Clicking an entry deep-links to the document, and when a `diff` is present, to the specific version in [Version History](../02-data-modeling/10-versioning-drafts-and-autosave.md).

## Open questions

- **Layout portability between self-host and Cloud.** Per-user widget layouts are persisted server-side. Should they be part of the portable config/content export, or treated as ephemeral per-environment UI state that does not migrate?
- **Activity retention vs. version history overlap.** Field-level diffs are stored both in version history and (optionally) in activity entries. We may collapse these into a single source to avoid double-writes, at the cost of coupling the feed to the versions table.
- **Real-time backend.** SSE is the default transport for the feed. Whether to offer an optional TanStack DB-backed live collection for the whole dashboard (so all widgets are reactive, not just activity) is still undecided pending performance budgets.
