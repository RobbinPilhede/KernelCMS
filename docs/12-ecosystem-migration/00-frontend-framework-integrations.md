# Frontend Framework Integrations

KernelCMS is headless: the content layer and the frontend that renders it are separate processes that talk over typed RPC, REST, or GraphQL. This document specifies how to consume KernelCMS from each major frontend framework — TanStack Start (the first-class target), Next.js, Remix, Astro, Nuxt, and SvelteKit — and how draft/preview, ISR, and on-demand revalidation work across them. The guiding principle: the type-safe path is the default, every wire format is available as an escape hatch, and nothing about your frontend choice is dictated by KernelCMS.

## The integration surface

Every frontend talks to a running KernelCMS server through one of four surfaces. The Local/RPC API is the only one with full end-to-end type inference, and it is the one we optimize for.

```
                ┌──────────────────────────────────────────┐
   frontend ───▶│  @kernel/client  (typed, where/sort/depth)│
                └───────────────┬──────────────────────────┘
                                │
            ┌───────────────────┼───────────────────┐
            ▼                   ▼                   ▼
      RPC (server fns)        REST              GraphQL
            │                   │                   │
            └───────────────────┴───────────────────┘
                                ▼
                        @kernel/server  (operation core)
                                ▼
                  @kernel/db-* adapter → database
```

`@kernel/client` is a thin, fully typed client generated from your `kernel.config.ts`. It speaks the same query language — `where`, `sort`, pagination, `depth` — regardless of which transport it resolves to. Unlike Sanity's GROQ (a separate query language you must learn) or Strapi's REST query syntax (stringly-typed `filters[field][$eq]` params), the KernelCMS query object is the _same shape_ in the Local API, RPC, REST, and the GraphQL variables. Learn it once.

```ts
import { createClient } from '@kernel/client'
import type { Config } from './kernel.config'

export const cms = createClient<Config>({
  url: process.env.KERNEL_URL!,
  token: process.env.KERNEL_API_TOKEN, // server-side only
})

const { docs } = await cms.collections.posts.find({
  where: { status: { equals: 'published' }, locale: { equals: 'en' } },
  sort: '-publishedAt',
  depth: 2,
  limit: 12,
})
//    ^? Post[]  — fully inferred, including resolved relationships at depth 2
```

## TanStack Start as first-class

TanStack Start is not "a framework we also support" — it is the framework KernelCMS itself is built on, so the admin panel and your frontend share the same primitives. The win is that there is no client boundary: a TanStack Start frontend can call the **same operation core** the admin uses, in-process when co-located or over typed RPC when split.

Data loads in route loaders and is cached by TanStack Query. Because `@kernel/client` server functions are themselves TanStack Start server functions, the inferred types flow straight into `useSuspenseQuery` without codegen or a GraphQL schema build step.

```ts
// app/routes/posts.$slug.tsx
import { createFileRoute } from '@tanstack/react-router'
import { queryOptions, useSuspenseQuery } from '@tanstack/react-query'
import { cms } from '~/cms'

const postQuery = (slug: string) =>
  queryOptions({
    queryKey: ['post', slug],
    queryFn: () =>
      cms.collections.posts
        .find({ where: { slug: { equals: slug } }, depth: 2, limit: 1 })
        .then((r) => r.docs[0] ?? null),
  })

export const Route = createFileRoute('/posts/$slug')({
  loader: ({ context, params }) => context.queryClient.ensureQueryData(postQuery(params.slug)),
  component: Post,
})

function Post() {
  const { slug } = Route.useParams()
  const { data } = useSuspenseQuery(postQuery(slug))
  // render…
}
```

For live or offline-capable frontends, swap the static fetch for a **TanStack DB** collection backed by `@kernel/client`. Documents become reactive client-side rows that update from the server without manual `invalidateQueries` calls — the same mechanism the admin uses for live collaboration. No other CMS ships a reactive client collection layer; with Sanity you wire up its listener API by hand, and with Payload/Strapi you poll or build your own websocket.

| Concern        | TanStack Start                      | Other frameworks             |
| -------------- | ----------------------------------- | ---------------------------- |
| Type inference | In-process, zero codegen            | RPC client + generated types |
| Data fetching  | TanStack Query loaders              | Framework loader + fetch     |
| Live updates   | TanStack DB collections             | Manual / polling             |
| Preview        | Shared session, no token round-trip | Cookie + draft token         |

## Next.js

Next.js (App Router) is the most common consumer. Fetch with `@kernel/client` inside Server Components and tag the requests so revalidation can target them precisely.

```ts
// app/posts/[slug]/page.tsx
import { cms } from '@/lib/cms'

export default async function PostPage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const post = await cms.collections.posts.findOne(
    { where: { slug: { equals: slug } }, depth: 2 },
    { next: { tags: [`post:${slug}`, 'posts'] } }, // forwarded to fetch()
  )
  if (!post) notFound()
  return <Article post={post} />
}
```

`@kernel/client` accepts a per-call `next` option that it forwards onto the underlying `fetch`, so Next's cache tags and `revalidate` windows work without a wrapper. Use `generateStaticParams` to pre-render published documents at build time and let on-demand revalidation (below) handle updates. Compared to Payload's Next adapter — which couples you to Payload's own Next app — KernelCMS stays a separate service, so you can deploy the frontend and the CMS independently and on different runtimes.

## Remix / React Router

Remix loads data in `loader` functions on the server, which is exactly where `@kernel/client` wants to run (it holds the API token). Return the documents and let Remix handle serialization.

```ts
// app/routes/posts.$slug.tsx
import type { LoaderFunctionArgs } from '@remix-run/node'
import { json } from '@remix-run/node'
import { cms } from '~/cms.server'

export async function loader({ params }: LoaderFunctionArgs) {
  const post = await cms.collections.posts.findOne({
    where: { slug: { equals: params.slug } },
    depth: 2,
  })
  if (!post) throw new Response('Not found', { status: 404 })
  return json({ post }, { headers: { 'Cache-Control': 'max-age=60, s-maxage=300' } })
}
```

Remix has no built-in ISR, so revalidation is HTTP-cache driven: set `Cache-Control` and let your CDN hold the response, then purge tags on publish via the webhook in the revalidation section. The `.server.ts` filename suffix guarantees the token never leaks to the client bundle.

## Astro

Astro is content-heavy and mostly static, which fits KernelCMS's published/draft model well. Fetch in frontmatter for SSG, or use server endpoints for dynamic routes.

```astro
---
// src/pages/posts/[slug].astro
import { cms } from '../../lib/cms'
export async function getStaticPaths() {
  const { docs } = await cms.collections.posts.find({
    where: { status: { equals: 'published' } },
    limit: 0, // all
  })
  return docs.map((p) => ({ params: { slug: p.slug }, props: { post: p } }))
}
const { post } = Astro.props
---
<Article post={post} />
```

For Astro's hybrid/server mode, read the draft cookie (see below) inside an endpoint and pass `draft: true` to fetch unpublished versions. KernelCMS does not ship an Astro content-loader integration that owns your data the way Astro's built-in content collections do — content stays in KernelCMS, and Astro is purely a rendering client.

## Nuxt and SvelteKit

Both are first-class even though they are not React. They consume KernelCMS over REST or GraphQL, and we publish a generated **typed REST schema** (OpenAPI) plus a GraphQL SDL so you keep type safety without `@kernel/client`'s React assumptions.

**Nuxt** — use `useAsyncData` with `$fetch` against the REST surface, or `nuxt-graphql-client` against `/graphql`:

```ts
// pages/posts/[slug].vue (script setup)
const { params } = useRoute()
const { data: post } = await useAsyncData(`post-${params.slug}`, () =>
  $fetch('/api/posts', {
    baseURL: useRuntimeConfig().kernelUrl,
    query: { 'where[slug][equals]': params.slug, depth: 2, limit: 1 },
  }).then((r) => r.docs[0]),
)
```

**SvelteKit** — fetch in `+page.server.ts` load functions:

```ts
// src/routes/posts/[slug]/+page.server.ts
import { error } from '@sveltejs/kit'
import { KERNEL_URL, KERNEL_API_TOKEN } from '$env/static/private'

export async function load({ params, fetch }) {
  const res = await fetch(`${KERNEL_URL}/api/posts?where[slug][equals]=${params.slug}&depth=2`, {
    headers: { Authorization: `Bearer ${KERNEL_API_TOKEN}` },
  })
  const { docs } = await res.json()
  if (!docs[0]) throw error(404)
  return { post: docs[0] }
}
```

This is where the single shared query language pays off: the `where`/`sort`/`depth` params in the Nuxt and SvelteKit examples are byte-for-byte the same query you'd build with `@kernel/client`. Strapi forces you to relearn its `populate`/`filters` syntax per surface; KernelCMS does not.

## Draft and preview integration

Preview means rendering _unpublished_ content for an authenticated editor while the public sees only published documents. The flow is identical across frameworks; only the cookie-setting glue differs.

```
editor clicks "Preview" in admin
        │
        ▼
GET /preview?collection=posts&id=…&token=<signed, short-lived>
        │  @kernel/server verifies token + access control
        ▼
sets httpOnly draft cookie → 302 to frontend route
        │
        ▼
frontend load reads cookie → cms.…find({ draft: true })
```

The admin generates a **signed, short-lived preview token** scoped to the document and the editor's permissions. Your frontend exposes a single preview route that verifies the token with `@kernel/auth`, sets a `Secure`, `HttpOnly`, `SameSite=Lax` cookie, and redirects. Every data fetch then checks for that cookie and passes `draft: true`, which makes the operation core return the latest version (including autosaved drafts) instead of the published one.

```ts
// Next.js: app/api/preview/route.ts
import { verifyPreviewToken } from '@kernel/auth'
import { draftMode } from 'next/headers'

export async function GET(req: Request) {
  const url = new URL(req.url)
  const claim = await verifyPreviewToken(url.searchParams.get('token'))
  if (!claim) return new Response('Invalid token', { status: 401 })
  ;(await draftMode()).enable() // Next's own httpOnly draft cookie
  return Response.redirect(new URL(claim.path, url).toString(), 302)
}
```

In TanStack Start, preview needs no token round-trip when the frontend shares the admin's session — the server function already knows the editor and resolves `draft: true` by checking access control directly. For live, in-place visual editing, the admin loads your preview URL in an iframe and uses `@kernel/admin`'s field-overlay bridge to highlight editable regions; this is the equivalent of Sanity's Presentation tool, but driven by your real frontend rather than a Sanity-hosted preview. Always evaluate access control server-side on the `draft: true` path — never trust the cookie alone.

## ISR and revalidation

Published content should be statically cached and invalidated precisely on change. KernelCMS drives this with **outbound webhooks** fired from the operation core after a document is published or unpublished, configured in `kernel.config.ts`:

```ts
// kernel.config.ts
import { defineConfig } from '@kernel/core'

export default defineConfig({
  hooks: {
    afterChange: [
      async ({ collection, doc, operation }) => {
        if (operation !== 'publish' && operation !== 'unpublish') return
        await fetch(`${process.env.FRONTEND_URL}/api/revalidate`, {
          method: 'POST',
          headers: { 'x-kernel-signature': sign(doc.id) },
          body: JSON.stringify({ collection: collection.slug, slug: doc.slug }),
        })
      },
    ],
  },
})
```

The receiving endpoint verifies the HMAC signature and invokes the framework's revalidation primitive. The signature check is mandatory — an unauthenticated revalidation endpoint is a cache-poisoning and denial-of-service vector.

| Framework      | Primitive                             | Granularity     |
| -------------- | ------------------------------------- | --------------- |
| Next.js        | `revalidateTag` / `revalidatePath`    | Per tag or path |
| TanStack Start | `queryClient.invalidateQueries`       | Per query key   |
| Remix          | CDN purge by `Cache-Tag`              | Per tag (CDN)   |
| Astro          | Rebuild or SSR + CDN purge            | Page or tag     |
| Nuxt           | `refreshNuxtData` / Nitro cache purge | Key or route    |
| SvelteKit      | CDN purge / `invalidate`              | Tag or load dep |

```ts
// Next.js: app/api/revalidate/route.ts
import { revalidateTag } from 'next/cache'
import { verifySignature } from '@kernel/client'

export async function POST(req: Request) {
  const body = await req.text()
  if (!verifySignature(req.headers.get('x-kernel-signature'), body)) {
    return new Response('Bad signature', { status: 401 })
  }
  const { collection, slug } = JSON.parse(body)
  revalidateTag(`${collection}`)
  revalidateTag(`post:${slug}`)
  return Response.json({ revalidated: true })
}
```

This webhook-plus-tags model is more portable than Sanity's CDN-purge-via-API or Strapi's lifecycle-hook scripts because the revalidation contract is the same HMAC-signed payload everywhere — only the three lines that call the framework primitive change. Pair tag-based revalidation with a sane stale-while-revalidate window so a missed webhook self-heals rather than serving stale content indefinitely.

See also: [REST API](../05-api/01-rest-api.md), [GraphQL API](../05-api/02-graphql-api.md), [Local & RPC API](../05-api/03-typed-rpc-and-local-api.md), Drafts & Preview, and [Access Control](../06-auth-security/01-authorization-and-access-control.md).

## Open questions

- **Generated client per framework.** `@kernel/client` is React-flavored (it ships `queryOptions` helpers). Do we publish a `@kernel/client/vanilla` core for Nuxt/SvelteKit, or lean on the OpenAPI/SDL generators and a community Vue/Svelte wrapper?
- **Visual editing protocol.** Should the field-overlay bridge use a standardized scheme (e.g. content source maps à la Sanity's `stega`) so non-TanStack frontends get in-place editing, or stay TanStack-first?
- **Webhook delivery guarantees.** At-least-once delivery with retry/backoff and a dead-letter queue via `@kernel/cloud`, versus best-effort plus a periodic reconciliation sweep — what's the default for self-host?
- **Edge token verification.** Whether `@kernel/auth` preview-token verification should run on edge runtimes without a Node crypto dependency, to keep preview cheap on Cloudflare/Vercel Edge.
