# Theming & White-Label

KernelCMS treats the admin panel as a product surface that agencies and enterprises ship under their own brand. Theming is config-as-code: you declare a theme in `kernel.config.ts`, layer in a scoped CSS file when you need pixel control, and — on KernelCMS Cloud or any multi-tenant self-host — resolve a different theme per tenant at request time. There is no theme database table to migrate, no admin-UI form that silently overrides your code, and no proprietary "studio config" format. Everything is typed, versioned in git, and reviewable in a PR.

## The theme override API

A theme in KernelCMS is a plain object validated against the `Theme` type exported from `@kernel/ui`. You pass it to `admin.theme` in `kernel.config.ts`. The object is split into **tokens** (design primitives), **branding** (logo, product name, favicon), **copy** (overridable strings), and **components** (rare, surgical component swaps).

```ts
// kernel.config.ts
import { defineConfig } from '@kernel/core'
import { defineTheme } from '@kernel/ui'

const acmeTheme = defineTheme({
  name: 'acme',
  colorScheme: 'system', // 'light' | 'dark' | 'system'
  tokens: {
    color: {
      brand: { 500: '#1f6feb', 600: '#1a5fd0', 700: '#1550b8' },
      accent: { 500: '#d83b9c' },
      // Semantic tokens resolve from the ramps above:
      'bg-canvas': 'light-dark(#ffffff, #0d1117)',
      'text-default': 'light-dark(#1c2128, #e6edf3)',
    },
    radius: { sm: '4px', md: '8px', lg: '12px' },
    font: {
      sans: '"Acme Grotesk", system-ui, sans-serif',
      mono: '"Berkeley Mono", ui-monospace, monospace',
    },
    space: { unit: '4px' }, // all spacing is derived from this base
  },
  branding: {
    productName: 'Acme Content',
    logo: { light: '/brand/acme-light.svg', dark: '/brand/acme-dark.svg' },
    favicon: '/brand/acme-favicon.svg',
  },
})

export default defineConfig({
  admin: {
    theme: acmeTheme,
    css: ['./admin/overrides.css'], // see "A custom CSS layer"
  },
})
```

`defineTheme` is the escape-hatch-friendly entry point. It does three things: validates the shape against the `Theme` type (zero `any`, full inference downstream), fills unspecified tokens from the KernelCMS default theme, and emits the token set as CSS custom properties at the admin root. Because everything funnels through CSS variables, the admin app re-themes without a rebuild — change a token, the running app reflects it on the next render.

### Token resolution order

```
default theme tokens
   └─► admin.theme tokens          (your kernel.config.ts)
        └─► per-tenant theme        (resolved at request time)
             └─► admin.css overrides (raw CSS, highest precedence)
```

Each layer is a shallow-merged patch over the previous. You never have to restate the full token set — declare only what differs. This is deliberately unlike Strapi, where admin customization historically meant editing files inside `src/admin/` and rebuilding the admin bundle, and unlike Sanity, where studio theming runs through the `theme` prop on a React component you own but cannot resolve per-tenant without forking the studio. KernelCMS keeps the theme as data so it can flow through the same resolution pipeline regardless of where it comes from.

### Typed tokens, not stringly-typed CSS

Token keys are part of the `Theme` type, so a typo is a compile error, and `@kernel/ui` components consume them through a `token()` helper rather than hardcoded hex:

```ts
import { token } from '@kernel/ui'

// In a custom field component:
const accent = token('color.accent.500') // typed; autocompletes; fails build if missing
```

Compare Payload: its admin theming is good and config-driven, but custom components reach for SCSS variables and `[data-theme]` selectors. KernelCMS exposes the same primitives as **typed values in code** so a custom field component and the core admin share one source of truth.

## Logo, colors, and copy

The three things every white-label request asks for are the logo, the palette, and the words. Each has a first-class slot so you never patch CSS for the common case.

### Logo and favicon

`branding.logo` accepts separate light/dark assets (resolved against `colorScheme`) and an optional `icon` for the collapsed sidebar and the browser tab. Assets are served by your configured `@kernel/storage` adapter or from the app's static directory.

```ts
branding: {
  logo: {
    light: '/brand/acme-light.svg',
    dark: '/brand/acme-dark.svg',
    icon: '/brand/acme-mark.svg',  // square mark for collapsed nav + login
    height: 28,                    // px; width auto from aspect-ratio
  },
  favicon: '/brand/acme-favicon.svg',
}
```

For full control — animated marks, conditional badges per environment — pass a component instead of a path. The admin renders it inside the same slot:

```ts
import { AcmeLogo } from './admin/AcmeLogo'

branding: { logo: AcmeLogo } // a React component receiving { colorScheme, collapsed }
```

### Colors

Define brand color ramps once; semantic tokens reference them. The admin uses semantic tokens (`bg-canvas`, `text-default`, `border-subtle`, `brand`, `danger`) everywhere, so overriding the ramp re-skins the entire surface — buttons, focus rings, table selection, command palette — without touching component code. Use the CSS `light-dark()` function for paired values and let `colorScheme` drive the mode. Contrast is enforced: a build-time check flags any semantic pair below WCAG 2.2 AA (4.5:1 for body text), because accessibility is non-negotiable, not a theme-author's responsibility.

| Slot | Token group | Drives |
| --- | --- | --- |
| Logo | `branding.logo` | Sidebar, login screen, collapsed nav |
| Palette | `tokens.color.*` | All surfaces via semantic tokens |
| Copy | `copy.*` | Product name, login text, empty states, emails |
| Typography | `tokens.font.*` | UI font and code/mono font |
| Shape | `tokens.radius`, `tokens.space.unit` | Corner rounding, density |

### Copy

White-label is not finished until "Powered by KernelCMS" is gone and the login screen says the client's name. The `copy` map overrides any UI string by key. Keys are flat, namespaced, and typed; unspecified keys fall back to the active [i18n](./14-admin-i18n-and-rtl.md) locale.

```ts
defineTheme({
  copy: {
    'app.title': 'Acme Content',
    'auth.login.heading': 'Sign in to Acme',
    'auth.login.subheading': 'Use your Acme SSO account',
    'nav.footer.poweredBy': '',           // empty string removes it entirely
    'collection.empty.cta': 'Create your first article',
  },
})
```

Because copy lives in the theme, it travels with per-tenant resolution: tenant A sees "Acme Content" and tenant B sees "Globex CMS" from the same running process. Sanity and Strapi both support UI string overrides, but neither resolves them per-tenant from a single deployment without separate studio builds.

## A custom CSS layer

Tokens cover the 90% case. For the rest — a client's exact button shadow, a bespoke login background, a denser table — KernelCMS gives you a scoped CSS layer instead of forcing a component fork. List files under `admin.css`; they load last and win.

```ts
// kernel.config.ts
admin: {
  theme: acmeTheme,
  css: ['./admin/overrides.css'],
}
```

The admin ships its styles inside the named cascade layer `kernel`, and your overrides live in a later `kernel-overrides` layer, so you win predictably **without `!important`**:

```css
/* admin/overrides.css */
@layer kernel-overrides {
  /* Retune a token for one surface only */
  .kernel-login {
    --bg-canvas: url('/brand/acme-login-bg.jpg') center / cover;
  }

  /* Reach an internal element via a stable data-attribute hook */
  [data-kernel="table-row"][data-selected="true"] {
    box-shadow: inset 3px 0 0 var(--color-brand-500);
  }

  /* Density tweak honoring reduced-motion and logical properties */
  [data-kernel="field"] { padding-block: calc(var(--space-unit) * 1.5); }
}
```

Two rules make this safe. First, every targetable element exposes a stable `data-kernel="..."` attribute that is part of the public contract — class names are internal and may change between releases; `data-kernel` hooks will not. Second, overrides are CSS only; they cannot run JavaScript, so a malicious or sloppy override cannot exfiltrate a session or call the API. This is the deliberate dividing line: token + CSS for appearance, the [plugin SDK](../08-extensibility/04-custom-admin-components-and-slots.md) for behavior.

```
appearance  ──► tokens (kernel.config.ts) ──► admin.css (scoped CSS)
behavior    ──► @kernel/plugin-sdk (custom components, views, fields)
```

Strapi's classic answer to "I need a different look" was overriding admin source and rebuilding; Payload offers SCSS overrides and component swaps. KernelCMS narrows the appearance path to data and scoped CSS specifically so design changes don't drag a bundle rebuild or a security review with them.

## Per-tenant theming

A single KernelCMS deployment can serve many brands. This is the agency and the KernelCMS Cloud use case: one process, N clients, each seeing their own logo, palette, and copy. The mechanism is a resolver function — `admin.resolveTheme` — invoked per request with the resolved tenant context.

```ts
// kernel.config.ts
import { defineConfig } from '@kernel/core'
import { themesByTenant, defaultTheme } from './admin/themes'

export default defineConfig({
  admin: {
    theme: defaultTheme,
    async resolveTheme({ request, tenant }) {
      // tenant is populated by your tenancy strategy (subdomain, header, JWT claim)
      return themesByTenant[tenant.id] ?? defaultTheme
    },
  },
})
```

The resolver runs inside a TanStack Start server function, so it has typed access to the request and the tenant resolved by your tenancy middleware. The returned theme is serialized to CSS custom properties and branding/copy props in the SSR response — the correct brand paints on first byte, with no flash of the default theme and no client-side theme fetch. TanStack Query caches the resolved theme keyed by tenant for subsequent navigations.

### How tenant identity reaches the resolver

```
request ──► tenancy middleware ──► tenant{id, ...} ──► resolveTheme() ──► SSR'd CSS vars + branding
            (subdomain / header /                       (per-request)       (no FOUC, no extra fetch)
             JWT claim / Cloud routing)
```

The resolver is intentionally pure data-in, theme-out. Keep it fast and side-effect-free; if you load themes from a database, cache them in-process (or behind your `@kernel/cache` adapter) and key the cache by tenant. A slow resolver blocks SSR for every admin request.

### Cloud vs. self-host

On KernelCMS Cloud, per-tenant theming is wired into managed multi-tenant routing — each tenant maps to a theme record edited through Cloud's branding UI, which writes the same `Theme` object you'd hand-author. Self-hosted, you own the resolver and the source of truth (a config map, a `branding` global, or a row in your database). Either way the theme shape is identical and portable: export from Cloud, drop into `kernel.config.ts`, no translation. That portability is the whole point of config-as-code — no lock-in, even on branding.

### Security and authorization

Theme resolution is appearance, but it still rides on tenant context, so the same isolation rules apply. The resolver must never trust a client-supplied tenant id directly; it consumes the tenant already authenticated by middleware. A user who can switch their visible brand by editing a header is a tenant-isolation bug, not a theming feature. Theme assets (logos, backgrounds) are served through the storage adapter with the same access rules as any other media — see [access control](../06-auth-security/01-authorization-and-access-control.md).

## Open questions

- **Runtime theme editing.** Should self-host expose an optional in-admin theme editor (writing back to a `branding` global), or stay code-only to keep config-as-code the single source of truth? Current lean: code-only by default, opt-in editor behind a flag for Cloud parity.
- **Component-level overrides.** `theme.components` allows surgical swaps of a small allowlist of primitives. How large should that allowlist be before we tell authors to use the plugin SDK instead? We want to avoid Strapi's "override the source" gravity well.
- **Per-tenant CSS layer.** Tokens and copy resolve per tenant cleanly; arbitrary per-tenant raw CSS is riskier (cascade bleed, caching). Do we support per-tenant `css` entries, and if so, do we sandbox them in a separate cascade layer per tenant?
- **Theme versioning on Cloud.** Should Cloud snapshot theme history alongside content [version history](../02-data-modeling/10-versioning-drafts-and-autosave.md), so a brand rollback is one click? Likely yes, but it needs its own retention policy.
