# ADR 0004: React for the Admin Panel

KernelCMS ships a single first-party admin panel built with React on TanStack Start. This ADR records why we chose React over Vue, Svelte, Solid, or a framework-agnostic web-component approach, why we coupled it to TanStack Start specifically rather than to React-the-library in isolation, and how we keep the door open for additional admin runtimes without forking the product. The decision is deliberately narrow: React is the framework for _the panel we ship_, not a constraint on the content API, the SDK, or what consumers build on their own frontends.

## Context

The admin panel is the most code-heavy surface in KernelCMS. It renders config-driven document forms with TanStack Form, virtualized collection lists with TanStack Table and TanStack Virtual, a block-based rich-text editor, a media library, live preview, and a command palette — all while staying WCAG 2.2 AA compliant, i18n-aware, and white-labelable. This is a large, stateful, long-lived single-page application with deep data-fetching and caching needs.

Three forces constrain the framework choice.

**The TanStack bet is the product wedge.** KernelCMS is positioned as the TanStack-native CMS. Router, Query, Table, Form, Store, Virtual, and DB are first-class dependencies of the admin. Today, [TanStack Start](./0001-tanstack-start-foundation.md) — our SSR, server-function, and routing host — is a React framework. Choosing a non-React admin would mean either reimplementing the TanStack primitives the admin leans on or running the panel on a parallel stack. Both contradict the wedge. The framework decision is therefore downstream of a strategic decision we already made: _bet the stack on TanStack_.

**The competitors made instructive choices.** Payload's admin is React, tightly integrated with Next.js App Router, and its custom-component story assumes React. Strapi's admin is React with a Redux-era core and a Webpack/Vite plugin pipeline; its extension model is React components registered through a plugin API. Sanity Studio is React, configured in code, with a component-override system that is genuinely excellent — Studio is the bar for "config-as-code admin done well." None of the three offer a non-React admin. The ecosystem expectation for "extend the CMS admin" is _write a React component_. Fighting that expectation costs us adoption for no functional gain.

**The extension surface must be ergonomic and typed.** A headless CMS lives or dies on how easily teams customize the admin: custom field types, custom cells, dashboard widgets, and view overrides. Whatever framework we pick becomes the contract every plugin author writes against via [`@kernel/plugin-sdk`](../../08-extensibility/01-plugin-sdk-and-authoring.md). We want that contract to be boring, well-documented, and backed by the largest component ecosystem available.

We explicitly considered the alternatives:

| Option                              | Pro                                                                                       | Con                                                                                                    | Verdict                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| **React + TanStack Start**          | TanStack-native, largest ecosystem, matches competitor expectations, typed escape hatches | React's runtime overhead; ties us to React's release cadence                                           | **Chosen**                                                                     |
| Svelte / SvelteKit                  | Smaller bundles, compiler-driven reactivity                                               | No TanStack Start equivalent; would fork the stack; tiny plugin ecosystem for CMS                      | Rejected                                                                       |
| Solid + SolidStart                  | Fine-grained reactivity, fast                                                             | TanStack support is partial; plugin authors don't know it; risk on hiring                              | Rejected                                                                       |
| Vue / Nuxt                          | Large ecosystem, good DX                                                                  | Parallel TanStack story is immature; splits our maintenance                                            | Rejected                                                                       |
| Web Components (framework-agnostic) | Embed anywhere                                                                            | TanStack primitives are React-shaped; forms/tables become reinvention; weak typing across the boundary | Rejected as the _primary_ panel; revisited in "Future multi-framework support" |

## Decision

**The KernelCMS admin panel is React, hosted by TanStack Start, and that is the only admin we ship in v1.** Concretely:

1. `@kernel/admin` is a React application. It renders the entire panel from content config — there are no hand-written collection screens.
2. TanStack Start provides SSR, file-based routing, and server functions. The same Start server that serves the admin also hosts the typed [RPC API](../../05-api/03-typed-rpc-and-local-api.md) via server functions, so the admin talks to the operation core in-process during SSR and over typed RPC on the client.
3. `@kernel/ui` is the React component library and design-token layer the admin is built from. It is published independently so plugin authors and white-label builds consume the same primitives.
4. The plugin and field-extension contract in `@kernel/plugin-sdk` is expressed as React components and hooks. Custom field types, list cells, and dashboard widgets are React.

A field component looks like this — the SDK gives you typed access to the field value through TanStack Form, never untyped props:

```ts
// my-plugin/fields/ColorPicker.tsx
import { defineFieldType } from '@kernel/plugin-sdk'
import { useFieldBinding } from '@kernel/admin'

export const ColorPicker = defineFieldType<string>({
  name: 'colorPicker',
  Cell: ({ value }) => <span style={{ background: value }} className="kc-swatch" />,
  Field: ({ path }) => {
    // useFieldBinding wraps TanStack Form's field API with KernelCMS validation + localization
    const field = useFieldBinding<string>(path)
    return (
      <input
        type="color"
        value={field.value ?? '#000000'}
        aria-invalid={field.errors.length > 0}
        onChange={(e) => field.setValue(e.target.value)}
        onBlur={field.handleBlur}
      />
    )
  },
})
```

Wiring it into a collection stays config-as-code:

```ts
// kernel.config.ts
import { defineConfig, collection } from '@kernel/core'
import { ColorPicker } from './my-plugin/fields/ColorPicker'

export default defineConfig({
  collections: [
    collection('themes', {
      fields: [
        { name: 'name', type: 'text', required: true },
        { name: 'accent', type: 'custom', component: ColorPicker },
      ],
      admin: {
        // List view is TanStack Table; defaultColumns drives column config
        defaultColumns: ['name', 'accent'],
      },
    }),
  ],
})
```

The data layer is uniformly TanStack Query, keyed off the shared query language (`where` / `sort` / pagination / `depth`) so admin caching and invalidation behave identically across REST, GraphQL, and RPC surfaces:

```ts
import { useQuery } from '@tanstack/react-query'
import { kernel } from '@kernel/client'

function useThemes() {
  return useQuery({
    queryKey: ['themes', { sort: '-updatedAt', depth: 1 }],
    queryFn: () => kernel.collections.themes.find({ sort: '-updatedAt', depth: 1 }),
  })
}
```

### Why React specifically, not just "a framework"

We are coupling to React for three reasons that survive scrutiny. First, **TanStack Start is React today**, and Start is load-bearing — it unifies the admin host and the RPC API host in one server. Second, **the plugin ecosystem expectation is React**; Payload, Sanity, and Strapi have already trained the market, and matching that lowers the cost of every plugin ever written for KernelCMS. Third, **React's escape-hatch story is mature**: refs, portals, context, and a vast component supply mean teams can drop to raw DOM or integrate a third-party editor without fighting the framework — which matters because our engineering tenet is _always provide escape hatches_.

## Consequences

```
                   kernel.config.ts (single source of truth)
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
   ┌──────────────────────┐         ┌────────────────────┐
   │  @kernel/server      │         │  @kernel/admin      │
   │  operation core      │◄────────│  React + TanStack   │
   │  (REST/GraphQL/RPC)  │  in-proc │  Start (SSR+routing)│
   └──────────────────────┘  + RPC  └────────────────────┘
              │                               │
              ▼                               ▼
        adapters (db/storage/…)        @kernel/ui + @kernel/plugin-sdk
```

**Positive.**

- One stack to learn. Contributors and plugin authors who know React and any TanStack library are productive immediately. We don't maintain a bespoke reactivity system.
- SSR and the typed RPC API share a host. There's no second server, no CORS dance for the admin, and the admin can call the operation core in-process during render.
- The component-override model (Sanity's strongest feature) is straightforward in React: every panel slot is a component with a typed default that config can replace.
- Type safety runs end to end. Field components receive typed values; `@kernel/client` returns typed documents; there is zero `any` across the SDK boundary.

**Negative / costs we accept.**

- We inherit React's runtime weight. We mitigate with route-level code splitting via TanStack Router, TanStack Virtual for long lists and documents, and enforced [performance budgets](../../11-quality/02-performance-benchmarks-and-budgets.md) on the admin bundle.
- We are exposed to React's release cadence and to TanStack Start's maturity. We pin versions and gate upgrades behind the admin e2e suite.
- Non-React shops cannot extend the _admin_ in their preferred framework today. This is the real cost, and the next section addresses it.

**Explicitly not affected.** This decision constrains _only the panel we ship_. The content APIs (REST, GraphQL, RPC), `@kernel/client`, and the field config schema are framework-neutral. A team building a Vue or Svelte frontend against KernelCMS content is unaffected — they consume the typed client and the query language, not the admin. KernelCMS is headless; React is an admin-implementation detail, not a content-layer constraint.

## Future multi-framework support

We are not promising a Vue admin. We are committing to _not painting ourselves into a corner_, and to a concrete escape path if demand materializes. Three layers make alternative runtimes feasible without a fork:

1. **The panel is generated from config, not hand-coded.** Because every screen is derived from `kernel.config.ts` through a renderer, a second renderer for a different framework consumes the same config and the same operation core. The schema, validation, access control, and query language are framework-agnostic by construction.

2. **The SDK boundary is the only React-shaped surface.** Field types, cells, and widgets are the React-specific contract. If we add a second runtime, `@kernel/plugin-sdk` grows a parallel, clearly-versioned entrypoint (e.g. `@kernel/plugin-sdk/web-components`) rather than mutating the React one. Plugins declare which runtime(s) they target.

3. **Web Components are the most likely embed target, not a full second studio.** The pragmatic near-term path is exposing select admin widgets (a document editor, a media picker) as framework-agnostic custom elements that wrap the React implementation, so a Vue or Svelte host app can embed KernelCMS editing UI without adopting React wholesale. This is strictly easier than a ground-up second admin and covers the common "embed an editor in our own app" request.

A sketch of how a second renderer would register, kept deliberately symmetric with the React path:

```ts
// hypothetical, post-v1
import { defineConfig } from '@kernel/core'
import { reactAdmin } from '@kernel/admin'
// import { vueAdmin } from '@kernel/admin-vue'  // future

export default defineConfig({
  admin: {
    renderer: reactAdmin(), // swappable; same config feeds any renderer
  },
})
```

This mirrors how we treat every other infrastructure concern in KernelCMS: the database, storage, email, auth, search, cache, and queue are all swappable [adapters](../05-the-adapter-pattern.md). The admin renderer is architecturally the same shape — a swappable implementation behind a stable, config-driven contract — we simply ship exactly one (React) and only invest in a second when real demand, not speculation, justifies it. That keeps us honest with the _choose everything_ promise without diluting effort across two immature studios on day one.

## Open questions

- **How much of the panel can a single renderer interface realistically abstract?** Forms and lists are tractable; the rich-text editor and live-preview visual editing are deeply React-coupled today and may resist a clean renderer boundary.
- **Web Components vs. a full second renderer for the first non-React deliverable** — the embed-widgets path is cheaper, but does it satisfy the loudest user requests, or do they actually want a full Vue/Svelte studio?
- **Plugin compatibility signaling.** If a second runtime ships, plugins need a machine-readable way to declare supported runtimes so the CLI can warn on mismatch at install time. The exact field in the plugin manifest is undecided.
