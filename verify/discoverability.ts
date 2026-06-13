/* Live AI-discoverability / GEO verification harness. Boots a real sqlite kernel with
 * `discoverability` configured, signing on (#8), and a `posts` collection holding a
 * published, a draft, and a private (owner-only) document. Proves the core security
 * property: drafts and access-restricted docs NEVER appear in any output.
 * Run: pnpm tsx verify/discoverability.ts */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig, initKernel } from '@kernel/core'
import { sqliteAdapter } from '@kernel/db-sqlite'

let pass = 0
const fails: string[] = []
const check = (n: string, c: boolean, e = '') => {
  if (c) {
    pass++
    console.log(`  \x1b[32mPASS\x1b[0m ${n}${e ? ` — ${e}` : ''}`)
  } else {
    fails.push(n)
    console.log(`  \x1b[31mFAIL\x1b[0m ${n}${e ? ` — ${e}` : ''}`)
  }
}

const isEditor = ({ req }: any) => Boolean(req.user?.roles?.includes('editor'))
const isOwner = ({ req }: any) => (req.user ? { owner: { equals: String(req.user.id) } } : false)
const editor = { req: { user: { id: 'ed', roles: ['editor'] } } } as any

const PUBLISHED_TITLE = 'How KernelCMS Works'
const DRAFT_TITLE = 'UNPUBLISHED DRAFT SECRET'
const PRIVATE_TITLE = 'OWNER ONLY PRIVATE'

const body = (text: string) => ({
  v: 1,
  type: 'doc',
  children: [
    { type: 'heading', level: 2, children: [{ type: 'text', text: 'Overview' }] },
    {
      type: 'paragraph',
      children: [
        { type: 'text', text: `${text} ` },
        { type: 'text', text: 'bold bit', marks: [{ type: 'bold' }] },
      ],
    },
  ],
})

async function main() {
  const dbFile = join(mkdtempSync(join(tmpdir(), 'kverify-disco-')), 'd.db')
  const config = defineConfig({
    secret: 'verify-secret-32-characters-long!!',
    db: sqliteAdapter({ url: `file:${dbFile}` }),
    serverURL: 'https://example.com',
    signing: { secret: 'verify-discoverability-signing-secret' },
    discoverability: {
      title: 'Example Site',
      description: 'Docs and posts, optimized for AI answer engines.',
      collections: [
        { slug: 'posts', titleField: 'title', descriptionField: 'excerpt', urlPattern: '/blog/:slug' },
        // Force-include a private collection to PROVE the anonymous read path still hides it.
        { slug: 'secrets', include: true, titleField: 'title' },
      ],
    },
    collections: [
      {
        slug: 'posts',
        versions: { drafts: true },
        access: { read: () => true, create: () => true, update: () => true, publish: isEditor },
        admin: { useAsTitle: 'title' },
        fields: [
          { name: 'title', type: 'text', required: true },
          { name: 'slug', type: 'slug', required: true, unique: true },
          { name: 'excerpt', type: 'textarea' },
          { name: 'content', type: 'richText' },
        ],
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
  const kernel = await initKernel(config, { autoMigrate: true } as any)

  // ---- seed: published + draft + private ----------------------------------
  const published = await kernel.create({
    collection: 'posts',
    data: {
      title: PUBLISHED_TITLE,
      slug: 'how-kernelcms-works',
      excerpt: 'A concise, citable summary of how KernelCMS works.',
      content: body('KernelCMS is a TypeScript-native headless CMS.'),
    },
    ...editor,
  })
  await kernel.publish({ collection: 'posts', id: published.id, ...editor })
  const draft = await kernel.create({
    collection: 'posts',
    data: { title: DRAFT_TITLE, slug: 'draft-only', content: body('This is a draft.') },
    ...editor,
  })
  const secret = await kernel.create({
    collection: 'secrets',
    data: { title: PRIVATE_TITLE, owner: 'someone-else' },
    overrideAccess: true,
  } as any)

  console.log('\n\x1b[1mDiscoverability — llms.txt index (public-only)\x1b[0m')
  const txt = await kernel.llmsTxt()
  check(
    'header has project title + description',
    txt.includes('# Example Site') && txt.includes('> Docs and posts'),
    '',
  )
  check(
    'lists the published post with title + canonical url',
    txt.includes(`[${PUBLISHED_TITLE}](https://example.com/blog/how-kernelcms-works)`),
    '',
  )
  check('summary from descriptionField included', txt.includes('A concise, citable summary'), '')
  check('SECURITY: draft title absent from llms.txt', !txt.includes(DRAFT_TITLE), 'draft string not present')
  check('SECURITY: private title absent from llms.txt', !txt.includes(PRIVATE_TITLE), 'private string not present')

  console.log('\n\x1b[1mDiscoverability — llms-full.txt corpus (markdown + provenance)\x1b[0m')
  const full = await kernel.llmsFullTxt()
  check('published doc rendered as a ## section', full.includes(`## ${PUBLISHED_TITLE}`), '')
  check('richText body rendered to markdown', full.includes('## Overview') && full.includes('**bold bit**'), '')
  check(
    'citation footer has canonical URL',
    full.includes('Canonical URL: https://example.com/blog/how-kernelcms-works'),
    '',
  )
  check(
    'citation footer notes signature-verified (signing on)',
    full.includes('Verified: content credential valid'),
    '',
  )
  check('SECURITY: draft excluded from llms-full.txt', !full.includes(DRAFT_TITLE), '')
  check('SECURITY: private excluded from llms-full.txt', !full.includes(PRIVATE_TITLE), '')

  console.log('\n\x1b[1mDiscoverability — content chunks (RAG/GEO ingestion)\x1b[0m')
  const chunks = await kernel.contentChunks()
  const titles = chunks.map((c) => c.title)
  check('chunk emitted for the published post', titles.includes(PUBLISHED_TITLE), `titles=${titles.join(',')}`)
  check('SECURITY: no chunk for the draft', !titles.includes(DRAFT_TITLE), '')
  check('SECURITY: no chunk for the private doc', !titles.includes(PRIVATE_TITLE), '')
  const chunk = chunks.find((c) => c.title === PUBLISHED_TITLE)!
  check(
    'chunk carries collection/url/text/tokens',
    chunk?.collection === 'posts' &&
      chunk.url === 'https://example.com/blog/how-kernelcms-works' &&
      chunk.text.includes('# How KernelCMS Works') &&
      chunk.tokensEstimate > 0,
    `tokens=${chunk?.tokensEstimate}`,
  )

  console.log('\n\x1b[1mDiscoverability — geoDocument (single doc, citation block)\x1b[0m')
  const md = await kernel.geoDocument({ collection: 'posts', id: published.id })
  check('published doc → markdown with # title', Boolean(md && md.includes(`# ${PUBLISHED_TITLE}`)), '')
  check(
    'geoDocument has citation block + verified note',
    Boolean(md && md.includes('Verified: content credential valid')),
    '',
  )
  const draftMd = await kernel.geoDocument({ collection: 'posts', id: draft.id })
  check('SECURITY: draft id → null', draftMd === null, `got=${draftMd === null ? 'null' : 'markdown'}`)
  const secretMd = await kernel.geoDocument({ collection: 'secrets', id: secret.id })
  check('SECURITY: private id → null', secretMd === null, `got=${secretMd === null ? 'null' : 'markdown'}`)
  const missingMd = await kernel.geoDocument({ collection: 'posts', id: 'no-such-id' })
  check('unknown id → null', missingMd === null, '')

  await kernel.destroy()
  console.log(`\n\x1b[1mDiscoverability Result: ${pass} passed, ${fails.length} failed\x1b[0m`)
  if (fails.length) {
    console.log('Failures:\n  ' + fails.join('\n  '))
    process.exit(1)
  }
  process.exit(0)
}
main().catch((e) => {
  console.error('DISCOVERABILITY HARNESS ERROR:', e)
  process.exit(2)
})
