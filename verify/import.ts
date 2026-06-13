/* Live importer verification: boot a real sqlite kernel, then for EACH source with a
 * fixture export run the adapter + engine and assert real behaviour — correct per-collection
 * doc counts, a known field landed, a relationship resolved to the right new id, unknown-type
 * records skipped (not fatal), extra fields dropped + reported, and — the headline — a
 * dry-run writes NOTHING (count before === count after) while still producing a full report.
 * Run: pnpm tsx verify/import.ts */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { defineConfig, initKernel } from '@kernel/core'
import type { Kernel } from '@kernel/core'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { loadAdapter, runImport, type ImportSource } from '../packages/cli/src/import'

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

const fixture = (name: string): string => resolve(import.meta.dirname, 'fixtures', 'import', name)

/** A config with every target slug the five fixtures land in. Drafts on `posts`/`article`
 *  so the dry-run + status paths exercise drafts-enabled collections too. */
function buildConfig(dbFile: string) {
  const rel = (relationTo: string, hasMany = false) => ({
    name: '',
    type: 'relationship' as const,
    relationTo,
    hasMany,
  })
  return defineConfig({
    secret: 'verify-secret-32-characters-long!!',
    db: sqliteAdapter({ url: `file:${dbFile}` }),
    collections: [
      {
        slug: 'authors',
        fields: [
          { name: 'name', type: 'text' },
          { name: 'email', type: 'text' },
          { name: 'bio', type: 'text' },
        ],
      },
      {
        slug: 'categories',
        fields: [
          { name: 'name', type: 'text' },
          { name: 'slug', type: 'text' },
        ],
      },
      {
        slug: 'tags',
        fields: [
          { name: 'name', type: 'text' },
          { name: 'slug', type: 'text' },
        ],
      },
      {
        slug: 'media',
        fields: [
          { name: 'alt', type: 'text' },
          { name: 'url', type: 'text' },
          { name: 'filename', type: 'text' },
        ],
      },
      {
        slug: 'pages',
        fields: [
          { name: 'title', type: 'text' },
          { name: 'slug', type: 'text' },
          { name: 'content', type: 'text' },
        ],
      },
      {
        slug: 'posts',
        versions: { drafts: true },
        access: { read: () => true, create: () => true, update: () => true, publish: () => true },
        fields: [
          { name: 'title', type: 'text' },
          { name: 'slug', type: 'text' },
          { name: 'content', type: 'text' },
          { name: 'excerpt', type: 'text' },
          { ...rel('authors'), name: 'author' },
          { ...rel('categories', true), name: 'categories' },
          { ...rel('tags', true), name: 'tags' },
        ],
      },
      // Strapi singular slugs (api::author.author -> author, api::article.article -> article).
      {
        slug: 'author',
        fields: [
          { name: 'name', type: 'text' },
          { name: 'bio', type: 'text' },
        ],
      },
      {
        slug: 'article',
        versions: { drafts: true },
        access: { read: () => true, create: () => true, update: () => true, publish: () => true },
        fields: [
          { name: 'title', type: 'text' },
          { name: 'content', type: 'text' },
          { ...rel('author'), name: 'author' },
        ],
      },
    ],
  })
}

async function countAll(kernel: Kernel, slugs: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const slug of slugs) out[slug] = await kernel.count({ collection: slug, overrideAccess: true })
  return out
}

const ALL_SLUGS = ['authors', 'categories', 'tags', 'media', 'pages', 'posts', 'author', 'article']

async function importFixture(kernel: Kernel, source: ImportSource, file: string, dryRun: boolean) {
  const adapter = await loadAdapter(source)
  const dataset = await adapter.read({ file })
  return runImport(kernel, dataset, { dryRun, defaultStatus: 'published', source })
}

async function main() {
  const dbFile = join(mkdtempSync(join(tmpdir(), 'kverify-import-')), 'i.db')
  const kernel = await initKernel(buildConfig(dbFile), { autoMigrate: true } as never)

  // ---- DRY RUN writes nothing (the headline safety feature) ----------------
  console.log('\n\x1b[1mDry-run — full report, ZERO writes\x1b[0m')
  const before = await countAll(kernel, ALL_SLUGS)
  const dryReports = await Promise.all([
    importFixture(kernel, 'wordpress', fixture('wordpress.xml'), true),
    importFixture(kernel, 'contentful', fixture('contentful.json'), true),
    importFixture(kernel, 'sanity', fixture('sanity.ndjson'), true),
    importFixture(kernel, 'strapi', fixture('strapi.json'), true),
    importFixture(kernel, 'payload', fixture('payload.json'), true),
  ])
  const after = await countAll(kernel, ALL_SLUGS)
  check(
    'dry-run wrote NOTHING (every collection count unchanged)',
    ALL_SLUGS.every((s) => before[s] === after[s]),
    `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
  )
  check(
    'dry-run still produced populated reports (would-create counts)',
    dryReports.every((r) => Object.values(r.created).reduce((a, b) => a + b, 0) > 0 && r.dryRun),
    `created sums=${dryReports.map((r) => Object.values(r.created).reduce((a, b) => a + b, 0)).join(',')}`,
  )

  // ---- WordPress (WXR) -----------------------------------------------------
  console.log('\n\x1b[1mWordPress (WXR XML) — types, fields, taxonomy + author relations\x1b[0m')
  const wp = await importFixture(kernel, 'wordpress', fixture('wordpress.xml'), false)
  check('2 posts imported', wp.created.posts === 2, `posts=${wp.created.posts}`)
  check('1 page imported', wp.created.pages === 1, `pages=${wp.created.pages}`)
  check('1 attachment -> media', wp.created.media === 1, `media=${wp.created.media}`)
  check(
    'author + category + tag records created',
    wp.created.authors === 1 && wp.created.categories === 1 && wp.created.tags === 1,
    '',
  )
  check(
    'nav_menu_item skipped (unknown type, not fatal)',
    wp.skipped.some((s) => s.sourceType === 'nav_menu_item'),
    `skipped=${wp.skipped.length}`,
  )
  const helloList = await kernel.find({
    collection: 'posts',
    where: { slug: { equals: 'hello-world' } },
    overrideAccess: true,
  })
  const hello = helloList.docs[0]
  check(
    'known field landed (CDATA HTML content preserved verbatim)',
    typeof hello?.content === 'string' &&
      hello.content.includes('<p>The first post') &&
      hello.content.includes('warm welcome'),
    `content=${String(hello?.content).slice(0, 40)}`,
  )
  const wpAuthors = await kernel.find({ collection: 'authors', overrideAccess: true })
  const jane = wpAuthors.docs.find((a) => a.name === 'Jane Writer')
  check(
    'post.author relation resolved to the imported author id',
    hello?.author === jane?.id,
    `author=${hello?.author} jane=${jane?.id}`,
  )
  const newsCat = (await kernel.find({ collection: 'categories', overrideAccess: true })).docs.find(
    (c) => c.slug === 'news',
  )
  check(
    'post.categories hasMany resolved',
    Array.isArray(hello?.categories) && (hello?.categories as string[]).includes(String(newsCat?.id)),
    `cats=${JSON.stringify(hello?.categories)}`,
  )

  // ---- Contentful ----------------------------------------------------------
  console.log('\n\x1b[1mContentful (export JSON) — locale unwrap + Link refs\x1b[0m')
  const cf = await importFixture(kernel, 'contentful', fixture('contentful.json'), false)
  check(
    '2 posts + 1 author imported',
    cf.created.posts === 2 && cf.created.authors === 1,
    `posts=${cf.created.posts} authors=${cf.created.authors}`,
  )
  check('1 asset -> media', cf.created.media === 1, `media=${cf.created.media}`)
  const cfPost = (
    await kernel.find({ collection: 'posts', where: { title: { equals: 'Analytical Engine' } }, overrideAccess: true })
  ).docs[0]
  check(
    'default-locale value taken (en-US, not de-DE)',
    cfPost?.title === 'Analytical Engine',
    `title=${cfPost?.title}`,
  )
  const ada = (await kernel.find({ collection: 'authors', overrideAccess: true })).docs.find(
    (a) => a.name === 'Ada Lovelace',
  )
  check('Link field resolved to imported author', cfPost?.author === ada?.id, `author=${cfPost?.author} ada=${ada?.id}`)

  // ---- Sanity --------------------------------------------------------------
  console.log('\n\x1b[1mSanity (NDJSON) — reference resolution + system-doc skip\x1b[0m')
  const sn = await importFixture(kernel, 'sanity', fixture('sanity.ndjson'), false)
  check(
    '2 posts + 1 author imported',
    sn.created.posts === 2 && sn.created.authors === 1,
    `posts=${sn.created.posts} authors=${sn.created.authors}`,
  )
  check('sanity.* system doc not imported', !('imageAsset' in sn.created) && sn.created.media === undefined, '')
  const grace = (await kernel.find({ collection: 'authors', overrideAccess: true })).docs.find(
    (a) => a.name === 'Grace Hopper',
  )
  const snPost = (
    await kernel.find({ collection: 'posts', where: { title: { equals: 'The First Compiler' } }, overrideAccess: true })
  ).docs[0]
  check('_ref resolved to imported author', snPost?.author === grace?.id, `author=${snPost?.author} grace=${grace?.id}`)

  // ---- Strapi --------------------------------------------------------------
  console.log('\n\x1b[1mStrapi (v4 JSON) — uid->slug + relation data\x1b[0m')
  const st = await importFixture(kernel, 'strapi', fixture('strapi.json'), false)
  check(
    '2 articles + 1 author imported',
    st.created.article === 2,
    `article=${st.created.article} author=${st.created.author}`,
  )
  const linus = (await kernel.find({ collection: 'author', overrideAccess: true })).docs.find(
    (a) => a.name === 'Linus Torvalds',
  )
  const stArticle = (
    await kernel.find({
      collection: 'article',
      where: { title: { equals: 'On Version Control' } },
      overrideAccess: true,
    })
  ).docs[0]
  check(
    'Strapi {data:{id}} relation resolved',
    stArticle?.author === linus?.id,
    `author=${stArticle?.author} linus=${linus?.id}`,
  )

  // ---- Payload -------------------------------------------------------------
  console.log('\n\x1b[1mPayload (JSON) — populated + bare-id rels, extra field dropped\x1b[0m')
  const pl = await importFixture(kernel, 'payload', fixture('payload.json'), false)
  check(
    '2 posts + 1 author imported',
    pl.created.posts === 2 && pl.created.authors === 1,
    `posts=${pl.created.posts} authors=${pl.created.authors}`,
  )
  check(
    'unknown source field reported as dropped',
    (pl.droppedFields.posts ?? []).includes('extraField'),
    `dropped=${JSON.stringify(pl.droppedFields.posts)}`,
  )
  const margaret = (await kernel.find({ collection: 'authors', overrideAccess: true })).docs.find(
    (a) => a.name === 'Margaret Hamilton',
  )
  const plPost1 = (
    await kernel.find({
      collection: 'posts',
      where: { title: { equals: 'Software Engineering' } },
      overrideAccess: true,
    })
  ).docs[0]
  const plPost2 = (
    await kernel.find({ collection: 'posts', where: { title: { equals: 'On Reliability' } }, overrideAccess: true })
  ).docs[0]
  check('populated {id} relation resolved', plPost1?.author === margaret?.id, `author=${plPost1?.author}`)
  check(
    'bare-id relation promoted + resolved (config-aware)',
    plPost2?.author === margaret?.id,
    `author=${plPost2?.author} margaret=${margaret?.id}`,
  )

  await kernel.destroy()
  console.log(`\n\x1b[1mImport Result: ${pass} passed, ${fails.length} failed\x1b[0m`)
  if (fails.length) {
    console.log('Failures:\n  ' + fails.join('\n  '))
    process.exit(1)
  }
  process.exit(0)
}
main().catch((e) => {
  console.error('IMPORT HARNESS ERROR:', e)
  process.exit(2)
})
