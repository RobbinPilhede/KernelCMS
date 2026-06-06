/** Scaffold templates for `kernel generate:*`. Pure string builders (testable). */

/** Normalize a name to a snake_case slug. */
export function toSlug(name: string): string {
  return name
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
}

/** camelCase identifier for the exported module const. */
function toCamel(slug: string): string {
  return slug.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase())
}

/** A starter `kernel.config.ts` — SQLite + an auth collection + a public posts
 *  collection. The fastest path from `npx kernel init` to a running CMS. */
export function configTemplate(): string {
  return `import { defineConfig } from 'kernelcms'
import { sqliteAdapter } from 'kernelcms/sqlite'
import { postgresAdapter } from 'kernelcms/postgres'
import { localStorage, s3Storage, r2 } from 'kernelcms/storage'

// Env-driven database: use PostgreSQL when DATABASE_URL is set (the admin setup
// can write this to .env for you), otherwise the zero-config local SQLite file.
const db = process.env.DATABASE_URL
  ? postgresAdapter({ url: process.env.DATABASE_URL })
  : sqliteAdapter({ url: 'file:./content.db' })

// Env-driven storage: Cloudflare R2 when R2_ENDPOINT is set, AWS S3 when only
// S3_BUCKET is set, otherwise local disk (zero-config). The admin setup writes
// these to .env for you.
const storage = process.env.R2_ENDPOINT
  ? r2({ bucket: process.env.S3_BUCKET!, endpoint: process.env.R2_ENDPOINT })
  : process.env.S3_BUCKET
    ? s3Storage({ bucket: process.env.S3_BUCKET, region: process.env.AWS_REGION })
    : localStorage({ rootDir: './uploads', servePath: '/files' })

export default defineConfig({
  // Set KERNEL_SECRET in any non-local environment.
  secret: process.env.KERNEL_SECRET ?? 'dev-only-secret',
  db,
  storage,
  collections: [
    {
      slug: 'users',
      auth: true, // email + password sign-in, included
      fields: [{ name: 'name', type: 'text' }],
    },
    {
      slug: 'posts',
      access: { read: () => true }, // public reads
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'body', type: 'richText' },
        { name: 'author', type: 'relationship', relationTo: 'users' },
      ],
    },
  ],
})
`
}

/** A starter module: one collection + one custom endpoint, wired with defineModule. */
export function moduleTemplate(name: string): string {
  const slug = toSlug(name)
  const ident = toCamel(slug)
  return `import { defineModule, defineEndpoint } from 'kernelcms'

/**
 * The "${slug}" module — a self-contained vertical slice. Add it to your config:
 *   import { ${ident}Module } from './${slug}.module'
 *   export default defineConfig({ ..., plugins: [${ident}Module] })
 */
export const ${ident}Module = defineModule({
  name: '${slug}',
  version: '0.1.0',
  collections: [
    {
      slug: '${slug}',
      access: { read: () => true },
      fields: [{ name: 'title', type: 'text', required: true }],
    },
  ],
  endpoints: [
    defineEndpoint({
      method: 'GET',
      path: '/${slug}/ping',
      access: () => true,
      handler: () => ({ ok: true }),
    }),
  ],
})
`
}
