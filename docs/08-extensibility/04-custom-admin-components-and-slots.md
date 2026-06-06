# Custom Admin Components & Slots

The KernelCMS admin is a TanStack Start application whose every visible surface is a replaceable React component. You inject UI three ways: **slots** (override or wrap a named region the admin already renders), **views** (mount your own TanStack Router routes), and **providers** (wrap the whole tree to install context). All three are declared in `kernel.config.ts` and resolved through the same component registry, so a plugin and a project use identical APIs. This document specifies that registry, the slot taxonomy, the routing contract, the provider chain, and how to build against `@kernel/ui` so your components inherit tokens, dark mode, and WCAG 2.2 AA behavior for free.

## The component registry

Every customizable surface in the admin reads from a single registry keyed by a stable slot path. Payload reaches the same goal with a deep `admin.components` config object; Sanity uses a Studio-wide `components` API plus structure builder callbacks; Strapi ships an `app.registerPlugin` injection-zone system. KernelCMS unifies all of it under one resolver and one config shape, and — unlike Strapi's runtime string-keyed zones — every slot is typed.

```ts
// kernel.config.ts
import { defineConfig } from '@kernel/core'
import { postgres } from '@kernel/db-postgres'
import { LogoMark } from './admin/LogoMark'
import { SeoSidebar } from './admin/SeoSidebar'

export default defineConfig({
  db: postgres({ url: process.env.DATABASE_URL! }),
  collections: [/* ... */],
  admin: {
    components: {
      // Global slots
      'nav.logo': LogoMark,
      'actions.afterUserMenu': [() => <SupportLink />],

      // Scoped to one collection's document view
      'collection:posts': {
        'edit.sidebar.before': SeoSidebar,
      },
    },
  },
})
```

A slot value is either a single component, an array (rendered in order), or a lazy import. References never run at config-eval time — the registry stores thunks and the admin code-splits them per route via `React.lazy`, so a plugin that overrides ten document views adds nothing to the initial admin bundle.

```ts
type SlotEntry = AdminComponent | AdminComponent[] | { component: AdminComponent; lazy?: boolean; order?: number }
```

## Component slots and overrides

Slots come in three flavors, and the distinction is deliberate:

| Kind          | Behavior                                 | Example slot                                   |
| ------------- | ---------------------------------------- | ---------------------------------------------- |
| **Override**  | Replaces the default entirely            | `nav.logo`, `views.dashboard`                  |
| **Wrapper**   | Receives `children`, the default render  | `edit.document`, `app.root`                    |
| **Insertion** | Appends to a region without replacing it | `actions.afterUserMenu`, `edit.sidebar.before` |

Insertion slots are named with a `before`/`after` suffix and accept arrays so multiple plugins coexist without clobbering each other — the failure mode Strapi injection zones hit when two plugins target the same zone. Override and wrapper slots are single-valued; the last writer wins, and the resolution order is **project config > plugins (registration order) > defaults**, so a project can always reclaim a slot a plugin grabbed.

### The slot map

```
app.root                      ← wrapper, outermost (after providers)
├─ nav
│  ├─ nav.logo                ← override
│  ├─ nav.before / nav.after  ← insertion
│  └─ nav.collectionLink      ← override, per-link
├─ header
│  └─ actions.afterUserMenu   ← insertion
└─ views.<route>              ← override (dashboard, account, …)
   └─ collection:<slug>
      ├─ list.beforeTable     ← insertion
      ├─ list.cell.<field>    ← override, per-column
      ├─ edit.document        ← wrapper
      ├─ edit.sidebar.before  ← insertion
      └─ field.<path>         ← override, per-field
```

Field-level slots (`field.<path>` and `list.cell.<field>`) are the most-used override in practice. A field component receives a typed binding from TanStack Form rather than the loosely-typed `value`/`onChange` pair Payload passes:

```ts
import type { FieldComponent } from '@kernel/ui'

// admin/ColorField.tsx
export const ColorField: FieldComponent<'text'> = ({ field, schema }) => {
  // `field` is the TanStack Form field API, fully typed to the field's value
  return (
    <label className="kc-field">
      <span>{schema.label}</span>
      <input
        type="color"
        value={field.state.value ?? '#000000'}
        onChange={(e) => field.handleChange(e.target.value)}
        onBlur={field.handleBlur}
        aria-invalid={field.state.meta.errors.length > 0}
      />
    </label>
  )
}
```

Wire it on the field, not globally, so it only applies where intended:

```ts
{
  name: 'brandColor',
  type: 'text',
  admin: { components: { field: ColorField } },
}
```

Because the binding comes from TanStack Form, async and cross-field validation, dirty state, and error surfacing already flow through `field.state.meta` — you don't re-implement form plumbing the way a Sanity custom input must when it reaches for `patch` events. See [field types](../02-data-modeling/04-field-types-catalog.md) and validation for the schema side.

## Custom views and routes

A view is a full page in the admin shell. Because the admin is TanStack Start, you register a real TanStack Router route, get type-safe params and search-param state, and inherit the nav frame, auth guard, and command palette automatically. This is a genuine advantage over Strapi, where custom admin pages live in a parallel plugin runtime, and over Sanity, whose custom "tools" sit beside Studio's structure rather than inside its router.

```ts
// kernel.config.ts
admin: {
  views: [
    {
      path: '/analytics',
      label: 'Analytics',
      icon: 'chart',
      nav: 'main',                 // show in the primary nav group
      access: ({ user }) => user.roles.includes('editor'),
      component: () => import('./admin/views/Analytics'),
    },
  ],
}
```

```tsx
// admin/views/Analytics.tsx
import { useKernelQuery } from '@kernel/client'
import { useView, Page, Card } from '@kernel/ui'

export default function Analytics() {
  const { search } = useView('/analytics') // typed search params
  const { data, isPending } = useKernelQuery((api) =>
    api.collection('posts').count({ where: { status: { equals: 'published' } } }),
  )

  return (
    <Page title="Analytics">
      <Card loading={isPending}>{data?.count} published posts</Card>
    </Page>
  )
}
```

Notes that matter:

- **Data goes through `@kernel/client` / `useKernelQuery`**, which is TanStack Query over typed RPC server functions. You never hand-roll `fetch`; caching and invalidation match the rest of the admin, and access control is enforced server-side regardless of what the route's `access` predicate allows (that predicate only governs nav visibility and client routing). See [the typed client](../05-api/03-typed-rpc-and-local-api.md).
- **`access` runs client-side for UX**; the underlying operations still re-check authorization on the server. Never treat a hidden nav item as a security boundary — see [access control](../06-auth-security/01-authorization-and-access-control.md).
- **Search-param state is typed** via `useView`, so filters and tabs are shareable URLs without manual serialization.

Views can also be nested under a collection (`scope: 'collection:posts'`) to add a tab beside the default edit/list views, sharing that collection's breadcrumb and document context.

## Providers

Providers wrap the entire admin tree to install React context — a feature flag client, an analytics SDK, a theme override, an i18n bridge. They run **outside** every slot and view, so anything you put in context is available everywhere downstream.

```
KernelAdminRoot
└─ <Provider[]>            ← your providers, in declared order
   └─ QueryClientProvider  ← TanStack Query (kernel-owned)
      └─ RouterProvider    ← TanStack Router (kernel-owned)
         └─ app.root slot
            └─ views / slots
```

```ts
// kernel.config.ts
import { PostHogProvider } from './admin/providers/PostHog'

admin: {
  providers: [
    PostHogProvider,                       // component
    { component: FlagsProvider, order: -10 }, // run earlier (lower = outer)
  ],
}
```

A provider is an ordinary wrapper component; the only contract is that it renders `children`.

```tsx
// admin/providers/PostHog.tsx
import type { AdminProvider } from '@kernel/ui'
import { posthog } from 'posthog-js'

export const PostHogProvider: AdminProvider = ({ children }) => {
  useEffect(() => {
    posthog.init(import.meta.env.VITE_PH_KEY)
  }, [])
  return <>{children}</>
}
```

Kernel-owned providers (`QueryClientProvider`, `RouterProvider`, the `@kernel/ui` `ThemeProvider`) are fixed in the chain and not reorderable — your providers always sit outside them, which is why you can read your own context from inside any slot but must use the kernel hooks (`useKernelQuery`, `useView`) to touch kernel state. Providers contributed by plugins and by the project merge into one ordered list; ordering is by `order` then registration sequence.

## Reusing the design system

Custom components must look native, not bolted-on. Everything you build should import from `@kernel/ui`, which exposes the same primitives the admin uses internally plus the token layer.

- **Tokens, not hard-coded values.** Colors, spacing, radii, and typography are CSS custom properties (`--kc-color-bg`, `--kc-space-3`, `--kc-radius-md`). Reference them; never ship hex codes. Dark mode, high-contrast, and white-label themes flip these variables at the root, so token-driven components re-theme with zero extra code.
- **Primitives.** `Button`, `Card`, `Page`, `Field`, `Select`, `Dialog` (native `<dialog>`), `Popover`, `Toast`, and the data primitives that wrap TanStack Table for list views. They are keyboard-accessible, focus-visible-correct, and `prefers-reduced-motion`-aware by default.
- **Hooks.** `useTheme`, `useKernelUser`, `useCommandPalette` (register actions), `useToast`, and `useLocale` (i18n + RTL).

```tsx
import { Button, Card, useToast, useCommandPalette } from '@kernel/ui'

export function PublishWidget({ docId }: { docId: string }) {
  const toast = useToast()
  useCommandPalette({ id: 'publish', title: 'Publish document', run: publish })

  return (
    <Card>
      <Button variant="primary" onClick={() => publish().then(() => toast.success('Published'))}>
        Publish
      </Button>
    </Card>
  )
}
```

Styling rule: components ship CSS Modules or Tailwind referencing the token variables — no inline styles, no runtime CSS-in-JS. This keeps custom UI inside the admin's performance budget and guarantees white-label theming applies. Where Sanity gives you `styled-components` and a `theme` object and Payload leans on global SCSS, KernelCMS standardizes on tokens so a third-party plugin's UI re-skins automatically under a customer's brand without the plugin author doing anything.

For deeper theming (logos, palette, custom token sets) see white-label theming; for shipping these as a reusable package see building plugins and the [plugin SDK](./01-plugin-sdk-and-authoring.md).

## Open questions

- **Server components in slots.** TanStack Start supports server functions throughout; whether a slot may itself be an RSC (vs. a client component calling `useKernelQuery`) is undecided. Leaning client-only for v1 to keep the registry contract simple.
- **Slot versioning.** Slot paths are part of the public API. We need a deprecation policy (alias old paths, warn for one minor) before the slot map freezes at 1.0.
- **Cross-plugin slot conflicts on override slots.** Insertion slots compose; override slots are last-writer-wins. Whether to emit a dev-time warning when two plugins fight over the same override slot, or fail hard, is still open.
