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
