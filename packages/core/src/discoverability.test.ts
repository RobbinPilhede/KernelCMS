import { describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { defineConfig, initKernel } from './index'
import type { Kernel } from './index'
import type { KernelRichText } from '@kernel/richtext'

// The discoverability / GEO layer over the real access pipeline. The ONE property that
// matters: drafts and access-restricted documents NEVER appear in any output. Every
// generator reads as an anonymous principal, published-only, through `find`.

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
    secret: 'discoverability-test-secret-xx',
    db: sqliteAdapter({ url: ':memory:' }),
    serverURL: 'https://example.com',
    signing: { secret: 'discoverability-signing-secret' },
    discoverability: {
      title: 'Example Site',
      description: 'A test site for AI discoverability.',
      collections: [
        { slug: 'posts', titleField: 'title', descriptionField: 'excerpt', urlPattern: '/blog/:slug' },
        // A private collection is force-included to PROVE the anonymous read still hides it.
        { slug: 'secrets', include: true, titleField: 'title' },
      ],
    },
    collections: [
      {
        slug: 'posts',
        versions: { drafts: true },
        access: { read: () => true, create: () => true, update: () => true, publish: isEditor },
        fields: [
          { name: 'title', type: 'text', required: true },
          { name: 'slug', type: 'slug', required: true, unique: true },
          { name: 'excerpt', type: 'textarea' },
          { name: 'content', type: 'richText' },
        ],
        admin: { useAsTitle: 'title' },
      },
      {
        slug: 'secrets',
        access: { read: isOwner, create: () => true, update: () => true },
        fields: [
          { name: 'title', type: 'text', required: true },
          { name: 'owner', type: 'text' },
        ],
      },
    ],
  })
  return initKernel(config, { autoMigrate: true })
}

const PUBLISHED_TITLE = 'Public Post'
const DRAFT_TITLE = 'Secret Draft Title'
const PRIVATE_TITLE = 'Owner Only Secret'

async function seed(kernel: Kernel) {
  // A published post (the only thing that should ever appear).
  const published = await kernel.create({
    collection: 'posts',
    data: {
      title: PUBLISHED_TITLE,
      slug: 'public-post',
      excerpt: 'The public summary.',
      content: body('This is published body text.'),
    },
    ...editor,
  })
  await kernel.publish({ collection: 'posts', id: published.id, ...editor })

  // A draft post — never published, must be excluded everywhere.
  const draft = await kernel.create({
    collection: 'posts',
    data: { title: DRAFT_TITLE, slug: 'secret-draft', content: body('Draft body.') },
    ...editor,
  })

  // A private (owner-only) doc — readable by its owner, never by the public.
  const secret = await kernel.create({
    collection: 'secrets',
    data: { title: PRIVATE_TITLE, owner: 'someone-else' },
    overrideAccess: true,
  })

  return { publishedId: published.id, draftId: draft.id, secretId: secret.id }
}

describe('discoverability — public-only generation', () => {
  it('llmsTxt lists the published post and excludes the draft and private doc', async () => {
    const kernel = await bootKernel()
    await seed(kernel)
    const txt = await kernel.llmsTxt()

    expect(txt).toContain('# Example Site')
    expect(txt).toContain('> A test site for AI discoverability.')
    // The published post appears with title + canonical URL from the urlPattern.
    expect(txt).toContain(`[${PUBLISHED_TITLE}](https://example.com/blog/public-post)`)
    expect(txt).toContain('The public summary.')
    // SECURITY: the draft and private titles must be absent.
    expect(txt).not.toContain(DRAFT_TITLE)
    expect(txt).not.toContain(PRIVATE_TITLE)
    await kernel.destroy()
  })

  it('llmsFullTxt includes the published body as markdown + a citation footer, excluding draft/private', async () => {
    const kernel = await bootKernel()
    await seed(kernel)
    const full = await kernel.llmsFullTxt()

    expect(full).toContain(`## ${PUBLISHED_TITLE}`)
    // The richText body is rendered to markdown (heading + prose).
    expect(full).toContain('## Section')
    expect(full).toContain('This is published body text.')
    // Citation footer: canonical URL + verified note (signing is on).
    expect(full).toContain('Canonical URL: https://example.com/blog/public-post')
    expect(full).toContain('Verified: content credential valid')
    // SECURITY: excluded.
    expect(full).not.toContain(DRAFT_TITLE)
    expect(full).not.toContain(PRIVATE_TITLE)
    await kernel.destroy()
  })

  it('contentChunks returns chunks only for public docs, with title/url/text', async () => {
    const kernel = await bootKernel()
    await seed(kernel)
    const chunks = await kernel.contentChunks()

    const titles = chunks.map((c) => c.title)
    expect(titles).toContain(PUBLISHED_TITLE)
    expect(titles).not.toContain(DRAFT_TITLE)
    expect(titles).not.toContain(PRIVATE_TITLE)

    const chunk = chunks.find((c) => c.title === PUBLISHED_TITLE)!
    expect(chunk.collection).toBe('posts')
    expect(chunk.url).toBe('https://example.com/blog/public-post')
    expect(chunk.text).toContain('# Public Post')
    expect(chunk.text).toContain('This is published body text.')
    expect(chunk.tokensEstimate).toBeGreaterThan(0)
    await kernel.destroy()
  })

  it('geoDocument returns markdown with a citation block for a published doc, null for draft/private', async () => {
    const kernel = await bootKernel()
    const { publishedId, draftId, secretId } = await seed(kernel)

    const md = await kernel.geoDocument({ collection: 'posts', id: publishedId })
    expect(md).toContain(`# ${PUBLISHED_TITLE}`)
    expect(md).toContain('This is published body text.')
    expect(md).toContain('Canonical URL: https://example.com/blog/public-post')
    expect(md).toContain('Verified: content credential valid')

    // SECURITY: a draft id resolves to null (never readable by the public path).
    expect(await kernel.geoDocument({ collection: 'posts', id: draftId })).toBeNull()
    // SECURITY: a private (owner-only) id resolves to null.
    expect(await kernel.geoDocument({ collection: 'secrets', id: secretId })).toBeNull()
    // An unknown id is null.
    expect(await kernel.geoDocument({ collection: 'posts', id: 'does-not-exist' })).toBeNull()
    await kernel.destroy()
  })

  it('respects the per-collection output cap (DoS bound)', async () => {
    const kernel = await bootKernel()
    // Publish several posts, then cap the index to 2.
    for (let i = 0; i < 4; i++) {
      const p = await kernel.create({
        collection: 'posts',
        data: { title: `Capped ${i}`, slug: `capped-${i}`, content: body(`Body ${i}`) },
        ...editor,
      })
      await kernel.publish({ collection: 'posts', id: p.id, ...editor })
    }
    const chunks = await kernel.contentChunks({ collection: 'posts', limit: 2 })
    expect(chunks.length).toBe(2)
    await kernel.destroy()
  })

  it('throws cleanly when discoverability is not configured', async () => {
    const kernel = await initKernel(
      defineConfig({
        secret: 'discoverability-test-secret-xx',
        db: sqliteAdapter({ url: ':memory:' }),
        collections: [{ slug: 'posts', fields: [{ name: 'title', type: 'text' }] }],
      }),
      { autoMigrate: true },
    )
    await expect(kernel.llmsTxt()).rejects.toThrow(/not enabled/i)
    await kernel.destroy()
  })
})
