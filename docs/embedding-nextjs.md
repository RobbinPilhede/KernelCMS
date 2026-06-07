# Embedding KernelCMS in Next.js

KernelCMS ships a web-standard `Request -> Response` handler, so you can mount the
whole CMS — REST API, GraphQL, OpenAPI docs, and the admin UI — inside a Next.js
app without running a separate server. This guide covers the four things that
actually trip people up: the runtime, bundling native modules, the kernel
singleton, and rate limiting behind a platform proxy.

> TL;DR: create the kernel **once** behind a `globalThis` singleton, mount
> `createRequestHandler` from a catch-all route, force the **Node.js runtime**,
> mark the DB driver as an external package, and pass `rateLimit.clientKey` so the
> limiter can see the real client IP.

---

## 1. Install

```bash
npm install kernelcms
# plus one database adapter:
npm install   # node:sqlite is built in — nothing to add for kernelcms/sqlite
# or, for Postgres:
npm install pg
```

## 2. Define the config and a single kernel instance

`initKernel()` opens a database connection (and a pool, for Postgres). You want
**exactly one** instance for the lifetime of the server process — never one per
request, and never a fresh one on every hot reload in dev. The standard trick is
to cache the promise on `globalThis`.

```ts
// lib/kernel.ts
import 'server-only'
import { defineConfig, initKernel, type Kernel } from 'kernelcms'
import { sqliteAdapter } from 'kernelcms/sqlite'
import { localStorage } from 'kernelcms/storage'

const config = defineConfig({
  secret: process.env.KERNEL_SECRET!,
  db: sqliteAdapter({ url: process.env.DATABASE_URL ?? 'file:./kernel.db' }),
  storage: localStorage({ rootDir: './.uploads', servePath: '/files' }),
  collections: [
    { slug: 'users', auth: true, access: { read: () => true }, fields: [] },
    {
      slug: 'posts',
      access: { read: () => true },
      versions: { drafts: true },
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'body', type: 'richText' },
      ],
    },
  ],
})

// Cache across module reloads so dev HMR doesn't open a new connection each save.
const globalForKernel = globalThis as unknown as { kernel?: Promise<Kernel> }

export function getKernel(): Promise<Kernel> {
  globalForKernel.kernel ??= initKernel(config)
  return globalForKernel.kernel
}
```

Run migrations as a **discrete deploy step** (`npx kernel migrate`), not on boot —
the embedded handler assumes the schema already exists. (KernelCMS registers the
table registry on every boot, so reads/writes work without `autoMigrate`; you just
need the tables to have been created once.)

## 3. Mount the handler from a catch-all route

```ts
// app/api/[[...kernel]]/route.ts
import { createRequestHandler } from 'kernelcms/server'
import { getKernel } from '@/lib/kernel'

// node:sqlite and pg are native — they cannot run on the Edge runtime.
export const runtime = 'nodejs'
// The CMS is dynamic; never statically cache these routes.
export const dynamic = 'force-dynamic'

async function handler(request: Request): Promise<Response> {
  const kernel = await getKernel()
  const handle = createRequestHandler(kernel, {
    apiKey: process.env.KERNEL_API_KEY,
    admin: true,
    // See §5 — resolve the client IP from a header your platform sets and you trust.
    rateLimit: { clientKey: (req) => req.headers.get('x-real-ip') ?? undefined },
  })
  return handle(request)
}

export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE, handler as OPTIONS }
```

If you mount at `app/api/[[...kernel]]`, the API lives under `/api/...` and the
admin under `/api/admin`. To serve the admin at a top-level `/admin` instead, give
it its own catch-all route (`app/admin/[[...path]]/route.ts`) and pass
`admin: { path: '/admin' }`, or set `routes.api` in your config.

## 4. Bundling: keep the native driver external

Next.js (Turbopack/webpack) will try to trace and bundle your server
dependencies. The database drivers must stay as real Node modules:

```js
// next.config.js
module.exports = {
  // node:sqlite is a Node built-in (loaded via createRequire); pg is native.
  serverExternalPackages: ['pg'],
}
```

`kernelcms/sqlite` loads `node:sqlite` through `createRequire` specifically so
bundlers don't try to statically resolve it, but forcing `runtime = 'nodejs'`
(step 3) is still required — the Edge runtime has no `node:sqlite`, no `pg`, and no
filesystem for local uploads.

## 4b. tsconfig: let TypeScript accept the config's `.ts` imports

Node runs `kernel.config.ts` natively and requires **`.ts` extensions on relative
imports** (`import { X } from './x.ts'`). TypeScript under Next's default
`moduleResolution: "bundler"` rejects those extensions unless you opt in. Set this
in the tsconfig that covers your config and schema:

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "noEmit": true,
  },
}
```

Do **not** add the config/schema to `exclude` to silence the error — you'd lose
type-checking on exactly the files that define your content model. `npx kernel init`
prints these settings in its next-steps output.

## 5. Rate limiting behind a proxy or platform

The bundled Node listener (`serve()` / `toNodeListener()`) attaches the socket
peer address for rate limiting. When you call `createRequestHandler` **directly**
— which is exactly what embedding does — that socket address never reaches the
handler. Without help, every visitor collapses into one shared rate-limit bucket,
so the limiter silently throttles your whole site as if it were a single client.
KernelCMS warns once on the server console when this happens.

Fix it by telling the limiter how to read the client IP from a header your platform
sets and **overwrites** (so a client can't spoof it):

```ts
rateLimit: {
  // Use the single-value header your platform controls:
  //   Vercel      → x-real-ip
  //   Cloudflare  → cf-connecting-ip
  clientKey: (req) => req.headers.get('x-real-ip') ?? undefined,
}
```

> ⚠️ **Don't trust `x-forwarded-for`'s first hop unless a proxy you control
> overwrites it.** If your app is also reachable directly (not only through the
> proxy), a client can send a forged `x-forwarded-for` and rotate it to bypass the
> rate limit / brute-force protection. Prefer a platform header that's always set
> server-side; only fall back to `x-forwarded-for` behind a proxy that replaces it.
> If you're not behind a proxy at all, omit `clientKey` and let the built-in socket
> resolution handle it.

`clientKey` takes precedence over `trustProxy`. Returning `undefined` falls through
to the built-in resolution. For multi-node deploys, also pass a shared
`store` (e.g. a Redis-backed `RateLimitStore`) so limits are enforced across
instances instead of per-process:

```ts
import type { RateLimitStore } from 'kernelcms/server'
```

## 5b. Revalidating Next.js ISR on publish

KernelCMS fires signed outbound webhooks on change; point one at a Next route that
revalidates the affected tags/paths, so published edits show up without waiting for
the ISR window.

```ts
// kernel.config.ts — fire a webhook on writes to content collections.
export default defineConfig({
  /* … */
  webhooks: [{ url: 'https://your-site/api/revalidate', secret: process.env.REVALIDATE_SECRET! }],
})
```

```ts
// app/api/revalidate/route.ts
import { revalidateTag } from 'next/cache'
import { createHmac, timingSafeEqual } from 'node:crypto'

export const runtime = 'nodejs'

export async function POST(request: Request): Promise<Response> {
  const raw = await request.text()
  // KernelCMS signs the body as `x-kernel-signature: sha256=<hex>`. Verify it so
  // only your CMS can trigger a revalidation.
  const sig = request.headers.get('x-kernel-signature') ?? ''
  const expected = `sha256=${createHmac('sha256', process.env.REVALIDATE_SECRET!).update(raw).digest('hex')}`
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return new Response('bad signature', { status: 401 })
  }
  // Payload: { event, collection, id, doc?, timestamp }
  const { collection } = JSON.parse(raw) as { collection: string }
  revalidateTag(collection)
  return Response.json({ revalidated: true })
}
```

Tag your fetches with the collection slug (`fetch(url, { next: { tags: ['posts'] } })`)
so `revalidateTag('posts')` invalidates exactly the pages that read it.

## 6. Authentication

By default the handler reads the `Authorization` header (the session token issued
by `kernel.login(...)`, or the `apiKey` for trusted system calls). To integrate
with your app's existing session, provide `getUser`:

```ts
createRequestHandler(kernel, {
  getUser: async (request) => resolveUserFromYourSession(request),
})
```

The Local API (`kernel.find`, `kernel.create`, …) is also available directly in
your Server Components and Route Handlers — you don't have to go through HTTP for
server-side reads.

## 7. A note on bundle size

The admin UI is a single-file SPA (~660 KB, ~205 KB gzipped) inlined into the
server package and served as one HTML document. It is delivered only when an
`/admin` route is requested — it is never part of your app's client bundle and has
no effect on your pages' JavaScript. If you don't need the embedded admin in a
given deployment, pass `admin: false` (or simply don't mount the admin route).

---

## Checklist

- [ ] One kernel instance, cached on `globalThis`.
- [ ] `export const runtime = 'nodejs'` on every kernel route.
- [ ] `export const dynamic = 'force-dynamic'`.
- [ ] `serverExternalPackages: ['pg']` (and keep `node:sqlite` external).
- [ ] Migrations run as a deploy step, not on boot.
- [ ] `rateLimit.clientKey` resolves the real IP (and a shared `store` if multi-node).
- [ ] `KERNEL_SECRET` set to a long random value in production.

See [conventions.md](./conventions.md) for the smaller defaults and naming rules
that this guide assumes.
