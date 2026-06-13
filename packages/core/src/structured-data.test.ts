import { describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { defineConfig, initKernel } from './index'
import type { Kernel } from './index'
import type { KernelRichText } from '@kernel/richtext'

// schema.org JSON-LD generation over the real access pipeline. The properties that matter:
// (1) a draft/private doc or a read-denied field is NEVER emitted (read through `find` with
// the caller's principal); (2) the `<script>` embedding escapes `<`/`>`/`&` so content can't
// break out; (3) the canonical `@id` URL is injection-safe; (4) explicit `mapping` overrides
// the smart defaults and prototype-pollution mapping keys are rejected at config time.

const isEditor = ({ req }: any) => Boolean(req.user?.roles?.includes('editor'))
const isOwner = ({ req }: any) => (req.user ? { owner: { equals: String(req.user.id) } } : false)
const editor = { req: { user: { id: 'ed', roles: ['editor'] } } }

const body = (text: string): KernelRichText => ({
  v: 1,
  type: 'doc',
  children: [
    { type: 'heading', level: 2, children: [{ type: 'text', text: 'Section' }] },
    { type: 'paragraph', children: [{ type: 'text', text }] },
  ],
})

async function bootKernel(): Promise<Kernel> {
  const config = defineConfig({
    secret: 'structured-data-test-secret-xx',
    db: sqliteAdapter({ url: ':memory:' }),
    serverURL: 'https://example.com',
    structuredData: {
      collections: [
        // Smart defaults — no explicit mapping. urlPattern uses a free-form text field so
        // hostile values reach the safe-segment encoder.
        { slug: 'posts', type: 'Article', urlPattern: '/blog/:url_key' },
        // Explicit mapping overrides the smart defaults.
        { slug: 'products', type: 'Product', mapping: { name: 'label', description: 'blurb' } },
        // Force-include a private collection to prove the access path still hides it.
        { slug: 'secrets', type: 'Thing' },
      ],
    },
    collections: [
      {
        slug: 'authors',
        access: { read: () => true, create: () => true },
        admin: { useAsTitle: 'name' },
        fields: [{ name: 'name', type: 'text', required: true }],
      },
      {
        slug: 'posts',
        versions: { drafts: true },
        access: { read: () => true, create: () => true, update: () => true, publish: isEditor },
        admin: { useAsTitle: 'title' },
        fields: [
          { name: 'title', type: 'text', required: true },
          { name: 'slug', type: 'slug', required: true, unique: true },
          { name: 'url_key', type: 'text' },
          { name: 'content', type: 'richText' },
          { name: 'published_date', type: 'date' },
          { name: 'author', type: 'relationship', relationTo: 'authors' },
          { name: 'internal_note', type: 'text', access: { read: () => false } },
        ],
      },
      {
        slug: 'products',
        access: { read: () => true, create: () => true },
        admin: { useAsTitle: 'label' },
        fields: [
          { name: 'label', type: 'text', required: true },
          { name: 'slug', type: 'slug', required: true, unique: true },
          { name: 'blurb', type: 'textarea' },
        ],
      },
      {
        slug: 'secrets',
        access: { read: isOwner, create: () => true, update: () => true },
        admin: { useAsTitle: 'title' },
        fields: [
          { name: 'title', type: 'text', required: true },
          { name: 'owner', type: 'text' },
        ],
      },
    ],
  })
  return initKernel(config, { autoMigrate: true })
}

const SECRET_FIELD = 'TOP SECRET FIELD VALUE'

async function seedPost(kernel: Kernel) {
  const author = await kernel.create({ collection: 'authors', data: { name: 'Ada Lovelace' }, ...editor })
  const published = await kernel.create({
    collection: 'posts',
    data: {
      title: 'How It Works',
      slug: 'how-it-works',
      url_key: 'how-it-works',
      content: body('Plain body text.'),
      published_date: '2026-01-15T00:00:00.000Z',
      author: author.id,
      internal_note: SECRET_FIELD,
    },
    ...editor,
  })
  await kernel.publish({ collection: 'posts', id: published.id, ...editor })
  return published.id
}

describe('structured data — smart defaults', () => {
  it('maps title→name/headline, body→articleBody, date→datePublished, author→Person', async () => {
    const kernel = await bootKernel()
    const id = await seedPost(kernel)

    const obj = await kernel.jsonLd({ collection: 'posts', id })

    expect(obj).not.toBeNull()
    expect(obj!['@context']).toBe('https://schema.org')
    expect(obj!['@type']).toBe('Article')
    expect(obj!['@id']).toBe('https://example.com/blog/how-it-works')
    expect(obj!.name).toBe('How It Works')
    expect(obj!.headline).toBe('How It Works')
    expect(obj!.articleBody).toContain('Plain body text.')
    expect(obj!.datePublished).toBe('2026-01-15T00:00:00.000Z')
    expect(typeof obj!.dateModified).toBe('string')
    expect(obj!.author).toEqual({ '@type': 'Person', name: 'Ada Lovelace' })
  })

  it('explicit mapping overrides the smart defaults', async () => {
    const kernel = await bootKernel()
    const product = await kernel.create({
      collection: 'products',
      data: { label: 'Widget', slug: 'widget', blurb: 'A fine widget.' },
      ...editor,
    })

    const obj = await kernel.jsonLd({ collection: 'products', id: product.id })

    expect(obj!['@type']).toBe('Product')
    expect(obj!.name).toBe('Widget')
    expect(obj!.description).toBe('A fine widget.')
    // The smart `headline` default is not applied when an explicit mapping is given.
    expect(obj!.headline).toBeUndefined()
  })
})

describe('structured data — access security property', () => {
  it('never emits a read-denied field', async () => {
    const kernel = await bootKernel()
    const id = await seedPost(kernel)

    const obj = await kernel.jsonLd({ collection: 'posts', id })

    expect(JSON.stringify(obj)).not.toContain(SECRET_FIELD)
  })

  it('returns null for a draft read anonymously', async () => {
    const kernel = await bootKernel()
    const draft = await kernel.create({
      collection: 'posts',
      data: { title: 'Draft', slug: 'draft', content: body('x') },
      ...editor,
    })

    const obj = await kernel.jsonLd({ collection: 'posts', id: draft.id })

    expect(obj).toBeNull()
  })

  it('returns null for an owner-scoped doc the caller cannot read', async () => {
    const kernel = await bootKernel()
    const secret = await kernel.create({
      collection: 'secrets',
      data: { title: 'Classified', owner: 'someone-else' },
      overrideAccess: true,
    })

    const obj = await kernel.jsonLd({ collection: 'secrets', id: secret.id })

    expect(obj).toBeNull()
  })

  it('returns null for an unknown id', async () => {
    const kernel = await bootKernel()
    expect(await kernel.jsonLd({ collection: 'posts', id: 'no-such-id' })).toBeNull()
  })
})

describe('structured data — jsonLdScript escaping', () => {
  it('escapes </script> and < from document content so it cannot break out of the tag', async () => {
    const kernel = await bootKernel()
    const xss = await kernel.create({
      collection: 'posts',
      data: {
        title: '</script><img src=x onerror=alert(1)>',
        slug: 'xss',
        content: body('payload'),
      },
      ...editor,
    })
    await kernel.publish({ collection: 'posts', id: xss.id, ...editor })

    const script = await kernel.jsonLdScript({ collection: 'posts', id: xss.id })

    expect(script.startsWith('<script type="application/ld+json">')).toBe(true)
    expect(script.endsWith('</script>')).toBe(true)
    const inner = script.slice('<script type="application/ld+json">'.length, -'</script>'.length)
    // The payload's </script> and <img must be escaped (entity refs), not literal markup.
    expect(inner).not.toContain('</script>')
    expect(inner).not.toContain('<img')
    expect(inner).toContain('\\u003c')
  })

  it('returns an empty string when there is no readable document', async () => {
    const kernel = await bootKernel()
    expect(await kernel.jsonLdScript({ collection: 'posts', id: 'missing' })).toBe('')
  })
})

describe('structured data — URL injection safety', () => {
  it('never injects a scheme or traverses above the base path in the @id', async () => {
    const kernel = await bootKernel()
    const jsScheme = await kernel.create({
      collection: 'posts',
      data: { title: 'JS', slug: 'js', url_key: 'javascript:alert(1)', content: body('x') },
      ...editor,
    })
    await kernel.publish({ collection: 'posts', id: jsScheme.id, ...editor })
    const traversal = await kernel.create({
      collection: 'posts',
      data: { title: 'Trav', slug: 'trav', url_key: '../../etc/passwd', content: body('x') },
      ...editor,
    })
    await kernel.publish({ collection: 'posts', id: traversal.id, ...editor })

    const a = await kernel.jsonLd({ collection: 'posts', id: jsScheme.id })
    const b = await kernel.jsonLd({ collection: 'posts', id: traversal.id })

    expect(String(a!['@id'])).toMatch(/^https:\/\/example\.com\/blog\//)
    expect(String(a!['@id'])).not.toMatch(/javascript:/i)
    expect(String(b!['@id'])).not.toContain('..')
    expect(String(b!['@id']).startsWith('https://example.com/blog/')).toBe(true)
  })
})

describe('structured data — config validation', () => {
  it('rejects a prototype-pollution key in an explicit mapping', async () => {
    const make = () =>
      initKernel(
        defineConfig({
          secret: 'structured-data-test-secret-xx',
          db: sqliteAdapter({ url: ':memory:' }),
          structuredData: {
            // JSON.parse yields an OWN enumerable `__proto__` key (a literal would set the
            // prototype instead) — exactly the prototype-pollution vector sanitize must reject.
            collections: [{ slug: 'posts', type: 'Article', mapping: JSON.parse('{"__proto__":"title"}') }],
          },
          collections: [
            {
              slug: 'posts',
              access: { read: () => true },
              fields: [{ name: 'title', type: 'text', required: true }],
            },
          ],
        }),
        { autoMigrate: true },
      )

    await expect(make()).rejects.toThrow(/illegal property key|__proto__/)
  })

  it('rejects an empty schema.org type', async () => {
    const make = () =>
      initKernel(
        defineConfig({
          secret: 'structured-data-test-secret-xx',
          db: sqliteAdapter({ url: ':memory:' }),
          structuredData: { collections: [{ slug: 'posts', type: '   ' }] },
          collections: [
            {
              slug: 'posts',
              access: { read: () => true },
              fields: [{ name: 'title', type: 'text', required: true }],
            },
          ],
        }),
        { autoMigrate: true },
      )

    await expect(make()).rejects.toThrow(/non-empty schema\.org `type`/)
  })

  it('rejects an unknown collection slug', async () => {
    const make = () =>
      initKernel(
        defineConfig({
          secret: 'structured-data-test-secret-xx',
          db: sqliteAdapter({ url: ':memory:' }),
          structuredData: { collections: [{ slug: 'nope', type: 'Article' }] },
          collections: [
            {
              slug: 'posts',
              access: { read: () => true },
              fields: [{ name: 'title', type: 'text', required: true }],
            },
          ],
        }),
        { autoMigrate: true },
      )

    await expect(make()).rejects.toThrow(/unknown collection "nope"/)
  })
})
