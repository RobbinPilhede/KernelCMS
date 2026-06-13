/* Live schema.org structured-data (JSON-LD) verification harness. Boots a real sqlite
 * kernel with `structuredData` configured and a `posts` collection (richText body, dates,
 * an author relationship, a read-denied field) plus an owner-scoped `secrets` collection.
 * Proves: smart-default + explicit mapping; the ACCESS security property (draft/private/
 * read-denied never emitted); <script> escaping of `</script>`; and URL injection safety.
 * Run: pnpm tsx verify/structured-data.ts */
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
const SECRET_FIELD = 'TOP SECRET FIELD VALUE'
const XSS_TITLE = '</script><img src=x onerror=alert(1)>'

const body = (text: string) => ({
  v: 1,
  type: 'doc',
  children: [
    { type: 'heading', level: 2, children: [{ type: 'text', text: 'Overview' }] },
    { type: 'paragraph', children: [{ type: 'text', text }] },
  ],
})

async function main() {
  const dbFile = join(mkdtempSync(join(tmpdir(), 'kverify-sd-')), 'd.db')
  const config = defineConfig({
    secret: 'verify-secret-32-characters-long!!',
    db: sqliteAdapter({ url: `file:${dbFile}` }),
    serverURL: 'https://example.com',
    structuredData: {
      collections: [
        // Smart defaults: no explicit mapping. title→name/headline, content→articleBody, dates auto.
        // urlPattern uses a free-form `url_key` text field so hostile values reach safeSegment.
        { slug: 'posts', type: 'Article', urlPattern: '/blog/:url_key' },
        // Explicit mapping overrides the smart defaults.
        { slug: 'products', type: 'Product', mapping: { name: 'label', description: 'blurb' } },
        // Force a private collection in to PROVE the access path still hides it.
        { slug: 'secrets', type: 'Thing', urlPattern: '/secret/:slug' },
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
          // A read-denied field — must NEVER surface in the JSON-LD.
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
          { name: 'slug', type: 'slug' },
          { name: 'owner', type: 'text' },
        ],
      },
    ],
  })
  const kernel = await initKernel(config, { autoMigrate: true } as any)

  // ---- seed ----------------------------------------------------------------
  const author = await kernel.create({ collection: 'authors', data: { name: 'Ada Lovelace' }, ...editor })
  const published = await kernel.create({
    collection: 'posts',
    data: {
      title: PUBLISHED_TITLE,
      slug: 'how-kernelcms-works',
      url_key: 'how-kernelcms-works',
      content: body('KernelCMS is a TypeScript-native headless CMS.'),
      published_date: '2026-01-15T00:00:00.000Z',
      author: author.id,
      internal_note: SECRET_FIELD,
    },
    ...editor,
  })
  await kernel.publish({ collection: 'posts', id: published.id, ...editor })
  const draft = await kernel.create({
    collection: 'posts',
    data: { title: DRAFT_TITLE, slug: 'draft-only', content: body('Draft.') },
    ...editor,
  })
  const product = await kernel.create({
    collection: 'products',
    data: { label: 'Widget', slug: 'widget', blurb: 'A fine widget for all your needs.' },
    ...editor,
  })
  const secret = await kernel.create({
    collection: 'secrets',
    data: { title: PRIVATE_TITLE, slug: 'classified', owner: 'someone-else' },
    overrideAccess: true,
  } as any)
  // An XSS-laden published post: title carries a script-breakout payload + js-scheme url_key.
  const xss = await kernel.create({
    collection: 'posts',
    data: { title: XSS_TITLE, slug: 'xss-post', url_key: 'javascript:alert(1)', content: body('payload') },
    ...editor,
  })
  await kernel.publish({ collection: 'posts', id: xss.id, ...editor })
  // A traversal url_key to prove the @id URL can't escape the base path.
  const trav = await kernel.create({
    collection: 'posts',
    data: { title: 'Traversal', slug: 'trav-post', url_key: '../../etc/passwd', content: body('x') },
    ...editor,
  })
  await kernel.publish({ collection: 'posts', id: trav.id, ...editor })

  // ---- jsonLd: smart defaults ----------------------------------------------
  console.log('\n\x1b[1mStructured data — jsonLd smart defaults (Article)\x1b[0m')
  const obj = (await kernel.jsonLd({ collection: 'posts', id: published.id }))!
  check('@context is schema.org', obj?.['@context'] === 'https://schema.org', String(obj?.['@context']))
  check('@type is Article', obj?.['@type'] === 'Article', String(obj?.['@type']))
  check(
    '@id is the canonical url',
    obj?.['@id'] === 'https://example.com/blog/how-kernelcms-works',
    String(obj?.['@id']),
  )
  check('title → name', obj?.name === PUBLISHED_TITLE, String(obj?.name))
  check('title → headline', obj?.headline === PUBLISHED_TITLE, String(obj?.headline))
  check(
    'richText body → articleBody (plain text)',
    typeof obj?.articleBody === 'string' && (obj.articleBody as string).includes('TypeScript-native'),
    String(obj?.articleBody),
  )
  check(
    'datePublished mapped from date field (ISO)',
    obj?.datePublished === '2026-01-15T00:00:00.000Z',
    String(obj?.datePublished),
  )
  check('dateModified falls back to updatedAt', typeof obj?.dateModified === 'string', String(obj?.dateModified))
  check(
    'author → Person { name }',
    Boolean(obj?.author) && (obj.author as any)['@type'] === 'Person' && (obj.author as any).name === 'Ada Lovelace',
    JSON.stringify(obj?.author),
  )

  // ---- SECURITY: read-denied field never appears ---------------------------
  console.log('\n\x1b[1mStructured data — access security property\x1b[0m')
  check(
    'SECURITY: read-denied field value absent from JSON-LD',
    !JSON.stringify(obj).includes(SECRET_FIELD),
    'internal_note stripped by access pipeline',
  )
  const draftObj = await kernel.jsonLd({ collection: 'posts', id: draft.id })
  check('SECURITY: draft → null', draftObj === null, `got=${draftObj === null ? 'null' : 'object'}`)
  const secretObj = await kernel.jsonLd({ collection: 'secrets', id: secret.id })
  check(
    'SECURITY: private/owner-scoped → null (anonymous)',
    secretObj === null,
    `got=${secretObj === null ? 'null' : 'object'}`,
  )
  const missing = await kernel.jsonLd({ collection: 'posts', id: 'no-such-id' })
  check('unknown id → null', missing === null, '')

  // ---- explicit mapping overrides ------------------------------------------
  console.log('\n\x1b[1mStructured data — explicit mapping overrides defaults (Product)\x1b[0m')
  const prod = (await kernel.jsonLd({ collection: 'products', id: product.id }))!
  check('@type is Product', prod?.['@type'] === 'Product', String(prod?.['@type']))
  check('explicit mapping: name ← label', prod?.name === 'Widget', String(prod?.name))
  check(
    'explicit mapping: description ← blurb',
    prod?.description === 'A fine widget for all your needs.',
    String(prod?.description),
  )
  check(
    'explicit mapping suppresses smart headline',
    prod?.headline === undefined,
    `headline=${String(prod?.headline)}`,
  )

  // ---- jsonLdScript escaping -----------------------------------------------
  console.log('\n\x1b[1mStructured data — jsonLdScript XSS escaping\x1b[0m')
  const script = await kernel.jsonLdScript({ collection: 'posts', id: xss.id })
  check(
    'script tag wrapper present',
    script.startsWith('<script type="application/ld+json">') && script.endsWith('</script>'),
    '',
  )
  // The only literal </script> allowed is the trailing wrapper close; the payload one must be escaped.
  const innerJson = script.slice('<script type="application/ld+json">'.length, -'</script>'.length)
  check(
    'SECURITY: raw </script> from content is escaped (not present in payload)',
    !innerJson.includes('</script>'),
    '',
  )
  check('SECURITY: raw <img from content is escaped (not present in payload)', !innerJson.includes('<img'), '')
  check('escaped marker \\u003c present for the < char', innerJson.includes('\\u003c'), '')

  // ---- URL injection safety ------------------------------------------------
  console.log('\n\x1b[1mStructured data — @id URL injection safety\x1b[0m')
  const xssObj = (await kernel.jsonLd({ collection: 'posts', id: xss.id }))!
  const xssId = String(xssObj?.['@id'])
  check(
    'SECURITY: js-scheme slug does not inject a scheme into @id',
    xssId.startsWith('https://example.com/blog/'),
    xssId,
  )
  check('SECURITY: @id has no raw javascript: scheme', !/javascript:/i.test(xssId), xssId)
  const travObj = (await kernel.jsonLd({ collection: 'posts', id: trav.id }))!
  const travId = String(travObj?.['@id'])
  // safeSegment drops `..`/`.` dot-segments, so the value stays UNDER /blog/ (here
  // /blog/etc/passwd) and can never traverse above the base path.
  check(
    'SECURITY: traversal slug does not escape base path (no ../ dot-segments)',
    !travId.includes('..') && travId.startsWith('https://example.com/blog/'),
    travId,
  )

  await kernel.destroy()
  console.log(`\n\x1b[1mStructured Data Result: ${pass} passed, ${fails.length} failed\x1b[0m`)
  if (fails.length) {
    console.log('Failures:\n  ' + fails.join('\n  '))
    process.exit(1)
  }
  process.exit(0)
}
main().catch((e) => {
  console.error('STRUCTURED-DATA HARNESS ERROR:', e)
  process.exit(2)
})
