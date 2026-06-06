# Admin i18n & RTL

The KernelCMS admin panel ships translatable from the first commit, not as a retrofit. Every string the panel renders flows through a single typed translation registry, locale bundles are code-split and loaded on demand through TanStack Query, layout direction is derived from the active locale rather than hand-toggled, and dates and numbers are formatted with the platform `Intl` APIs against that locale. This document specifies how admin UI translation, locale loading, RTL layout, and date/number formatting work, and how plugins and self-hosters extend or override them. It covers the *admin chrome* — the panel's own UI language — which is orthogonal to field-level content localization: a German editor can author Arabic content, and a single editor can flip the panel to RTL without touching the locales their content is published in.

## The UI translation system

The unit of translation is a **namespaced message key** resolved against the active admin locale. Core ships keys under reserved namespaces (`general`, `fields`, `auth`, `version`, `upload`, …); every plugin and project owns its own namespace. Keys are flat dotted strings, never deeply nested objects, because flat keys diff cleanly in PRs and let us generate a literal-union type of every valid key.

```ts
// kernel.config.ts
import { defineConfig } from '@kernel/core'
import { en, ar, de } from '@kernel/admin/i18n'

export default defineConfig({
  admin: {
    i18n: {
      supportedLocales: ['en', 'ar', 'de'],
      defaultLocale: 'en',
      fallbackLocale: 'en',
      translations: {
        // Override or extend any namespace, per locale.
        en: { 'general.dashboard': 'Home' },
        ar: { 'myPlugin.publishNow': 'انشر الآن' },
      },
    },
  },
})
```

Inside a React component or custom field you read messages through the `useTranslation` hook from `@kernel/admin`. The hook is backed by a TanStack Store atom that holds the resolved message map for the active locale, so a locale switch re-renders only subscribers, never the whole tree.

```ts
import { useTranslation } from '@kernel/admin'

function PublishButton() {
  const { t, locale, dir } = useTranslation('myPlugin')
  // namespace passed once -> keys are scoped and autocompleted
  return <button dir={dir}>{t('publishNow')}</button>
}
```

`t` supports ICU MessageFormat for plurals, selects, and interpolation, because half-translated panels fall apart on pluralization the moment you leave English:

```ts
t('upload.selected', { count }) // "{count, plural, one {# file} other {# files}} selected"
```

The key advantage over the field is **type safety**. `@kernel/core` generates an augmentation file during `kernel generate` that registers every known key as a literal union, so `t('publsihNow')` is a compile error, not a runtime `myPlugin.publsihNow` leak. Payload's i18n (i18next-based) and Strapi's (formatjs-based) both validate keys only at runtime; a typo ships as raw key text. Sanity Studio's `defineLocaleResourceBundle` is closer in spirit but still untyped at the call site. KernelCMS treats a missing translation key the same way it treats a missing route param — a build-time failure in CI, a logged warning plus fallback-locale string at runtime, never a silent blank.

| Concern | KernelCMS | Payload | Strapi | Sanity |
| --- | --- | --- | --- | --- |
| Engine | Custom, ICU-based | i18next | formatjs | Custom bundles |
| Key typing | Compile-time union | Runtime | Runtime | Runtime |
| Bundle loading | Code-split per locale | Eager merge | Eager | Lazy bundles |
| RTL | Derived from locale | Manual flag | Partial | Manual |

## Locale loading

Admin locales are **code-split bundles**, one ESM chunk per locale per namespace, never one monolithic JSON object shipped to every user. The English speaker never downloads the Arabic strings. Resolution order on first paint:

```
URL ?locale=  ->  user.adminLocale (DB)  ->  Accept-Language  ->  defaultLocale
```

The chosen locale is resolved on the server inside the TanStack Start root loader so the very first SSR render is already in the right language and direction — no English flash, no layout shift when RTL kicks in. The resolved locale and its core bundle are serialized into the initial payload; additional namespace bundles (a plugin's strings, the rich-text editor's strings) are fetched client-side through TanStack Query and cached with a long `staleTime`, since translations are immutable for a deploy.

```ts
import { queryOptions } from '@tanstack/react-query'
import { loadLocaleBundle } from '@kernel/admin/i18n'

export const localeBundleQuery = (locale: string, ns: string) =>
  queryOptions({
    queryKey: ['i18n', locale, ns],
    queryFn: () => loadLocaleBundle(locale, ns), // dynamic import() of the chunk
    staleTime: Infinity, // immutable per deploy; cache-busted by build hash
    gcTime: Infinity,
  })
```

```
  switch locale -> "ar"
        │
        ├─ store.setLocale('ar')           (instant: dir + cached bundles)
        ├─ queryClient.ensure(core/ar)     (usually already prefetched)
        └─ prefetch(plugin/ar, richtext/ar) (background, on idle)
```

Switching locales does not reload the page. `useTranslation` reads from the Store atom, so once the target bundles are in the Query cache the switch is a synchronous atom write. We prefetch the next-most-likely locales (the user's last two) on idle, so the common switch is instant. A custom locale is just another entry in `supportedLocales` plus a bundle:

```ts
import { registerLocale } from '@kernel/admin/i18n'

registerLocale('ckb', {
  dir: 'rtl',
  bundle: () => import('./locales/ckb.ts'), // Central Kurdish
  dateLocale: 'ckb',
  fallback: 'ar',
})
```

This is a sharper contract than Payload, which merges all imported translations into one runtime object regardless of the active language, and than Strapi, whose admin translations are bundled per-plugin but not lazily resolved by route. See [Admin theming](./12-theming-and-white-label.md) for how the same code-split strategy applies to white-label assets.

## RTL layout

Direction is a **property of the locale**, declared once in its registration (`dir: 'rtl'`), then propagated structurally — never as a pile of `if (isRTL)` branches in components. On locale change the admin sets `dir` on the document root and on the `<html lang>` attribute; everything else falls out of CSS.

The non-negotiable rule: **logical CSS properties only** in admin and `@kernel/ui`. No `margin-left`, no `left:`, no `text-align: left`. The lint config bans physical properties in panel styles.

```css
/* @kernel/ui — written once, correct in both directions */
.field {
  margin-inline-start: var(--space-4);
  padding-inline: var(--space-3);
  border-inline-start: 2px solid var(--color-border);
  text-align: start;
}
.field__icon { inset-inline-end: var(--space-2); } /* flips automatically */
```

Direction is exposed to JS through the same hook (`const { dir } = useTranslation()`) and through a `useDirection()` selector for components that must compute geometry — virtualized tables, the rich-text caret, drag-and-drop reordering — where CSS logical properties cannot reach. TanStack Table column resizing, TanStack Virtual horizontal offsets, and the command palette's arrow-key navigation all read `dir` to mirror their math.

```ts
import { useDirection } from '@kernel/admin'

function ResizableColumn() {
  const dir = useDirection() // 'ltr' | 'rtl'
  const sign = dir === 'rtl' ? -1 : 1
  const onDrag = (dx: number) => setWidth(w => w + dx * sign)
  // ...
}
```

Three classes of UI need explicit handling beyond logical properties:

1. **Directional iconography** — chevrons, back/forward, list indents. These use a `<DirectionalIcon>` wrapper that swaps the glyph (or applies `scale-x: -1`) under RTL. Brand and content-neutral icons (search, settings, trash) never flip.
2. **Bidi content** — editor fields hold mixed LTR/RTL runs (an Arabic paragraph quoting a URL). We set the field `dir="auto"` and rely on the Unicode Bidirectional Algorithm, isolating interpolated values with `<bdi>`/`⁨…⁩` so a user-supplied RTL name can't reorder surrounding LTR chrome.
3. **Mirrored interactions** — the [media library](./09-media-library-ui.md) gallery, [live preview](./10-live-preview-and-visual-editing.md) split pane, and progress bars flip their primary axis with `flex-direction` honoring `dir`, no manual swap.

Payload and Strapi added RTL support after the fact and still carry physical-property debt; Sanity Studio handles bidi text well in the editor but the surrounding studio chrome is not fully mirrored. KernelCMS makes RTL a CI gate: a visual-regression run renders the panel in `ar` and fails on any physical-property leak or un-mirrored layout.

## Date and number formatting

All locale-sensitive formatting goes through `Intl`, never a hand-rolled formatter and never a heavy date library bundled into the admin. `@kernel/admin/i18n` exposes thin, memoized wrappers that bind the active locale, the configured time zone, and per-call options.

```ts
import { useFormatters } from '@kernel/admin'

function VersionRow({ savedAt, bytes }: { savedAt: Date; bytes: number }) {
  const { date, relativeTime, number, fileSize } = useFormatters()
  return (
    <>
      <span>{date(savedAt, { dateStyle: 'medium', timeStyle: 'short' })}</span>
      <span>{relativeTime(savedAt)}</span>     {/* "3 hours ago" / "منذ ٣ ساعات" */}
      <span>{fileSize(bytes)}</span>            {/* "2.4 MB" with locale digits */}
    </>
  )
}
```

The formatters resolve a `dateLocale` that can differ from the UI locale — a German editor may want UI in `de` but timestamps in their own region's conventions, so locale and format-locale are separable config:

```ts
admin: {
  i18n: {
    formatting: {
      timeZone: 'admin-user',          // 'utc' | IANA zone | per-user setting
      numberLocale: 'inherit',          // or pin a BCP-47 tag
      firstDayOfWeek: 'locale',         // drives the date-picker grid
      numberingSystem: 'latn',          // 'arab' for Eastern Arabic digits, etc.
    },
  },
}
```

Three things matter here that off-the-shelf CMS admins routinely get wrong:

- **Numbering systems.** `Intl.NumberFormat` with `numberingSystem: 'arab'` renders `٢٬٤٠٠`, not `2,400`. We surface this as config because the correct choice is editorial, not automatic — many Arabic-language teams prefer Western digits in a CMS.
- **Time zones.** Timestamps are stored UTC and rendered in the user's zone via `Intl.DateTimeFormat({ timeZone })`. The version-history and [drafts/publish](../02-data-modeling/10-versioning-drafts-and-autosave.md) timelines depend on this being consistent across surfaces.
- **Relative time.** `Intl.RelativeTimeFormat` powers "edited 3 hours ago" labels and is locale- and direction-correct for free.

| Value | `en-US` | `ar-EG` (arab) | `de-DE` |
| --- | --- | --- | --- |
| `number(2400.5)` | `2,400.5` | `٢٬٤٠٠٫٥` | `2.400,5` |
| `date(d)` medium | `Jan 5, 2026` | `٥ يناير ٢٠٢٦` | `05.01.2026` |
| `fileSize(2_516_582)` | `2.4 MB` | `٢٫٤ م.ب` | `2,4 MB` |

Because everything routes through `Intl`, adding a locale adds zero formatting code; the runtime is already in every supported JS engine, so the admin bundle stays small. Payload and Strapi both pull in `date-fns`/`dayjs` locale data; KernelCMS ships none of it.

## Open questions

- **Per-document direction override.** Should an editor be able to pin a single document's edit form to RTL independent of their UI locale (e.g. an English-UI editor authoring Hebrew)? Today direction follows the UI locale; a per-content override may belong in field localization instead.
- **Translation sourcing for plugins.** Whether to define a community translation-contribution pipeline (Crowdin-style) for first-party namespaces, or leave all non-English bundles to plugin authors.
- **Pseudo-locale in dev.** A built-in `en-XA` pseudo-locale (accented, padded strings) to catch hardcoded text and truncation before translation — likely worth shipping behind a dev flag.
- **Numbering-system inheritance.** Whether `numberingSystem` should default per-locale (`arab` for `ar`) or always default to `latn` and require opt-in. Current lean is `latn` everywhere, opt-in per locale.
