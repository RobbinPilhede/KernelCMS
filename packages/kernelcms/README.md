# kernelcms

The TanStack-native, adapter-based, end-to-end type-safe **headless CMS** — config-as-code and fully self-hosted.

```bash
npm install kernelcms
```

> Requires **Node >= 22** and a **PostgreSQL** database (set `DATABASE_URL`).

## Quickstart

```ts
// kernel.config.ts
import { defineConfig } from 'kernelcms'
import { postgresAdapter } from 'kernelcms/postgres'

export default defineConfig({
  secret: process.env.KERNEL_SECRET,
  db: postgresAdapter(), // reads DATABASE_URL
  collections: [
    {
      slug: 'posts',
      access: { read: () => true },
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'body', type: 'richText' },
      ],
    },
  ],
})
```

```bash
export DATABASE_URL="postgres://user:pass@localhost:5432/mydb"
```

```ts
import { initKernel } from 'kernelcms'
import config from './kernel.config'

const kernel = await initKernel(config, { autoMigrate: true })
const post = await kernel.create({ collection: 'posts', data: { title: 'Hello' }, overrideAccess: true })
```

## Entry points

| Import | What you get |
| --- | --- |
| `kernelcms` | Config, fields, the Local API (`initKernel`), auth, access, codegen, error types |
| `kernelcms/postgres` | `postgresAdapter` — the default PostgreSQL adapter (pooled, concurrent transactions) |
| `kernelcms/sqlite` | `sqliteAdapter` — an optional `node:sqlite` adapter, handy for local dev and tests |
| `kernelcms/server` | `createRequestHandler`, `serve` — the REST handler + Node http adapter |
| `kernelcms/client` | `createClient` — a tiny typed fetch client (browser/edge/Node) |

## CLI

```bash
npx kernel migrate          # create/update tables from the config
npx kernel seed             # run the exported seed()
npx kernel dev              # migrate + start the REST API
npx kernel generate:types   # emit TypeScript types for the content model
```

The CLI imports your `kernel.config.ts` directly — run on Node ≥ 22.6 (type
stripping) or point `--config` at a compiled `.js`/`.mjs`.

## License

MIT
