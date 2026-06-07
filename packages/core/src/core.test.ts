import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { localStorage, memoryStorage } from '@kernel/storage'
import {
  ForbiddenError,
  PluginConflictError,
  PluginCycleError,
  TooManyRequestsError,
  UnauthorizedError,
  ValidationError,
  defineConfig,
  definePlugin,
  describeConfig,
  importData,
  initKernel,
  runDoctor,
  sanitizeConfig,
  signToken,
  systemInfo,
  verifyToken,
} from './index'
import type { AuthUser, Kernel, KernelPlugin } from './index'

const isAdmin = ({ req }: { req: { user: AuthUser | null } }): boolean => Boolean(req.user?.roles?.includes('admin'))

function buildConfig() {
  return defineConfig({
    secret: 'test-secret',
    localization: { locales: ['en', 'es'], defaultLocale: 'en', fallback: true },
    db: sqliteAdapter({ url: ':memory:' }),
    storage: memoryStorage({ servePath: '/files' }),
    collections: [
      {
        slug: 'media',
        access: { read: () => true },
        upload: { mimeTypes: ['image/*', 'application/pdf'], maxFileSize: 1024 },
        fields: [{ name: 'alt', type: 'text', required: true }],
      },
      {
        slug: 'authors',
        access: { read: () => true },
        fields: [
          { name: 'name', type: 'text', required: true },
          { name: 'email', type: 'email' },
        ],
      },
      {
        slug: 'posts',
        access: { read: () => true },
        versions: true,
        fields: [
          { name: 'title', type: 'text', required: true, minLength: 3, localized: true },
          { name: 'status', type: 'select', options: ['draft', 'published'], defaultValue: 'draft' },
          { name: 'views', type: 'number', defaultValue: 0 },
          { name: 'author', type: 'relationship', relationTo: 'authors' },
          { name: 'tags', type: 'select', options: ['a', 'b', 'c'], hasMany: true },
        ],
      },
      {
        slug: 'builder',
        access: { read: () => true },
        fields: [
          { name: 'title', type: 'text', required: true },
          { name: 'body', type: 'richText', preset: 'standard' },
          {
            name: 'layout',
            type: 'blocks',
            minRows: 0,
            maxRows: 5,
            blocks: [
              {
                slug: 'hero',
                labels: { singular: 'Hero', plural: 'Heroes' },
                fields: [
                  { name: 'heading', type: 'text', required: true },
                  { name: 'subheading', type: 'text' },
                ],
              },
              {
                slug: 'cta',
                fields: [
                  { name: 'label', type: 'text', required: true },
                  { name: 'href', type: 'text' },
                ],
              },
            ],
          },
        ],
      },
      {
        slug: 'articles',
        access: { read: () => true },
        versions: { drafts: true },
        fields: [{ name: 'title', type: 'text', required: true }],
      },
    ],
    globals: [
      {
        slug: 'settings',
        access: { read: () => true },
        fields: [{ name: 'site_name', type: 'text', defaultValue: 'KernelCMS' }],
      },
    ],
  })
}

/** Config with an auth collection + an owner-scoped collection for security tests. */
function buildSecurityConfig() {
  return defineConfig({
    secret: 'test-secret',
    db: sqliteAdapter({ url: ':memory:' }),
    collections: [
      {
        slug: 'users',
        auth: true,
        // Anyone may read/create/update at the document level; field-level rules
        // are what guard privilege escalation.
        access: { read: () => true, create: () => true, update: () => true },
        fields: [
          { name: 'name', type: 'text' },
          {
            name: 'roles',
            type: 'select',
            options: ['user', 'admin'],
            hasMany: true,
            defaultValue: ['user'],
            // Only an existing admin may set or change roles.
            access: { create: isAdmin, update: isAdmin },
          },
          // Only admins may READ this field; stripped from output otherwise.
          { name: 'secret', type: 'text', access: { read: isAdmin } },
        ],
      },
      {
        slug: 'notes',
        access: {
          read: ({ req }) => (req.user ? { owner: { equals: req.user.id } } : false),
          create: () => true,
          update: ({ req }) => (req.user ? { owner: { equals: req.user.id } } : false),
          delete: ({ req }) => (req.user ? { owner: { equals: req.user.id } } : false),
        },
        fields: [
          { name: 'owner', type: 'text' },
          { name: 'body', type: 'text' },
        ],
      },
    ],
  })
}

let kernel: Kernel
const admin = { overrideAccess: true } as const

beforeEach(async () => {
  kernel = await initKernel(buildConfig(), { logLevel: 'error' })
  await kernel.migrate()
})

afterEach(async () => {
  await kernel.destroy()
})

describe('CRUD', () => {
  it('creates a document and reads it back by id', async () => {
    const created = await kernel.create({ collection: 'authors', data: { name: 'Ada' }, ...admin })
    expect(created.id).toBeTypeOf('string')

    const found = await kernel.findByID({ collection: 'authors', id: created.id, ...admin })
    expect(found?.name).toBe('Ada')
  })

  it('applies field default values on create', async () => {
    const post = await kernel.create({ collection: 'posts', data: { title: 'Hello world' }, ...admin })
    expect(post.status).toBe('draft')
    expect(post.views).toBe(0)
  })

  it('updates a document and persists the change', async () => {
    const post = await kernel.create({ collection: 'posts', data: { title: 'Hello world' }, ...admin })
    const updated = await kernel.update({ collection: 'posts', id: post.id, data: { views: 42 }, ...admin })
    expect(updated?.views).toBe(42)
    expect(updated?.title).toBe('Hello world')
  })

  it('deletes a document', async () => {
    const post = await kernel.create({ collection: 'posts', data: { title: 'Goodbye' }, ...admin })
    await kernel.delete({ collection: 'posts', id: post.id, ...admin })
    const found = await kernel.findByID({ collection: 'posts', id: post.id, ...admin })
    expect(found).toBeNull()
  })
})

describe('bulk operations', () => {
  it('updateMany updates every matching document and reports the count', async () => {
    for (const n of [1, 2, 3]) await kernel.create({ collection: 'posts', data: { title: `Post ${n}` }, ...admin })
    const result = await kernel.updateMany({
      collection: 'posts',
      where: { status: { equals: 'draft' } },
      data: { status: 'published' },
      ...admin,
    })
    expect(result.count).toBe(3)
    expect(result.docs.every((d) => d.status === 'published')).toBe(true)
    const remaining = await kernel.count({ collection: 'posts', where: { status: { equals: 'draft' } }, ...admin })
    expect(remaining).toBe(0)
  })

  it('deleteMany removes only the matching documents', async () => {
    await kernel.create({ collection: 'posts', data: { title: 'Keep me' }, ...admin })
    await kernel.create({ collection: 'posts', data: { title: 'Trash one', views: 99 }, ...admin })
    await kernel.create({ collection: 'posts', data: { title: 'Trash two', views: 99 }, ...admin })
    const result = await kernel.deleteMany({ collection: 'posts', where: { views: { equals: 99 } }, ...admin })
    expect(result.count).toBe(2)
    const left = await kernel.find({ collection: 'posts', ...admin })
    expect(left.totalDocs).toBe(1)
    expect(left.docs[0]?.title).toBe('Keep me')
  })
})

describe('validation', () => {
  it('rejects a document missing a required field', async () => {
    await expect(kernel.create({ collection: 'posts', data: {}, ...admin })).rejects.toBeInstanceOf(ValidationError)
  })

  it('reports the failing field path and message', async () => {
    try {
      await kernel.create({ collection: 'posts', data: { title: 'ab' }, ...admin })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError)
      expect((err as ValidationError).errors[0]?.path).toBe('title')
    }
  })
})

describe('querying', () => {
  it('paginates a list and reports totals', async () => {
    for (const n of [1, 2, 3]) {
      await kernel.create({ collection: 'posts', data: { title: `Post ${n}` }, ...admin })
    }
    const page = await kernel.find({ collection: 'posts', limit: 2, ...admin })
    expect(page.totalDocs).toBe(3)
    expect(page.docs).toHaveLength(2)
    expect(page.totalPages).toBe(2)
    expect(page.hasNextPage).toBe(true)
  })

  it('filters with a where clause', async () => {
    await kernel.create({ collection: 'posts', data: { title: 'Keep me', status: 'published' }, ...admin })
    await kernel.create({ collection: 'posts', data: { title: 'Hide me', status: 'draft' }, ...admin })
    const result = await kernel.find({
      collection: 'posts',
      where: { status: { equals: 'published' } },
      ...admin,
    })
    expect(result.totalDocs).toBe(1)
    expect(result.docs[0]?.title).toBe('Keep me')
  })

  it('stores hasMany select values as an array', async () => {
    const post = await kernel.create({
      collection: 'posts',
      data: { title: 'Tagged', tags: ['a', 'b'] },
      ...admin,
    })
    const found = await kernel.findByID({ collection: 'posts', id: post.id, ...admin })
    expect(found?.tags).toEqual(['a', 'b'])
  })
})

describe('relationships', () => {
  it('populates a relationship when depth is requested', async () => {
    const author = await kernel.create({ collection: 'authors', data: { name: 'Grace' }, ...admin })
    const post = await kernel.create({
      collection: 'posts',
      data: { title: 'Linked post', author: author.id },
      ...admin,
    })

    const shallow = await kernel.findByID({ collection: 'posts', id: post.id, ...admin })
    expect(shallow?.author).toBe(author.id)

    const deep = await kernel.findByID({ collection: 'posts', id: post.id, depth: 1, ...admin })
    expect((deep?.author as { name: string }).name).toBe('Grace')
  })
})

describe('localization', () => {
  it('stores and resolves per-locale values', async () => {
    const post = await kernel.create({
      collection: 'posts',
      data: { title: 'Hello' },
      req: { locale: 'en' },
      ...admin,
    })
    await kernel.update({
      collection: 'posts',
      id: post.id,
      data: { title: 'Hola' },
      req: { locale: 'es' },
      ...admin,
    })

    const en = await kernel.findByID({ collection: 'posts', id: post.id, req: { locale: 'en' }, ...admin })
    const es = await kernel.findByID({ collection: 'posts', id: post.id, req: { locale: 'es' }, ...admin })
    expect(en?.title).toBe('Hello')
    expect(es?.title).toBe('Hola')
  })
})

describe('access control', () => {
  it('denies anonymous create by default (secure by default)', async () => {
    await expect(kernel.create({ collection: 'posts', data: { title: 'Sneaky' } })).rejects.toBeInstanceOf(
      ForbiddenError,
    )
  })

  it('allows anonymous read on a publicly readable collection', async () => {
    await kernel.create({ collection: 'posts', data: { title: 'Public post' }, ...admin })
    const result = await kernel.find({ collection: 'posts' })
    expect(result.totalDocs).toBe(1)
  })
})

describe('blocks', () => {
  it('round-trips a typed block array through storage', async () => {
    const created = await kernel.create({
      collection: 'builder',
      data: {
        title: 'Landing',
        layout: [
          { blockType: 'hero', heading: 'Welcome', subheading: 'Hi there' },
          { blockType: 'cta', label: 'Get started', href: '/start' },
        ],
      },
      ...admin,
    })
    const found = await kernel.findByID({ collection: 'builder', id: created.id, ...admin })
    expect(found?.layout).toEqual([
      { blockType: 'hero', heading: 'Welcome', subheading: 'Hi there' },
      { blockType: 'cta', label: 'Get started', href: '/start' },
    ])
  })

  it('rejects an unknown block type', async () => {
    await expect(
      kernel.create({
        collection: 'builder',
        data: { title: 'X', layout: [{ blockType: 'nope', foo: 1 }] },
        ...admin,
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('validates a block’s required field with the nested path', async () => {
    try {
      await kernel.create({
        collection: 'builder',
        data: { title: 'X', layout: [{ blockType: 'hero', subheading: 'no heading' }] },
        ...admin,
      })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError)
      expect((err as ValidationError).errors[0]?.path).toBe('layout.0.heading')
    }
  })

  it('enforces maxRows on a blocks field', async () => {
    const six = Array.from({ length: 6 }, () => ({ blockType: 'cta', label: 'x' }))
    await expect(
      kernel.create({ collection: 'builder', data: { title: 'X', layout: six }, ...admin }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('describes blocks (with their nested fields) for the admin', () => {
    const schema = describeConfig(kernel.config)
    const builder = schema.collections.find((c) => c.slug === 'builder')!
    const layout = builder.fields.find((f) => f.name === 'layout')!
    expect(layout.type).toBe('blocks')
    expect(layout.blocks?.map((b) => b.slug).sort()).toEqual(['cta', 'hero'])
    const hero = layout.blocks!.find((b) => b.slug === 'hero')!
    expect(hero.labels.plural).toBe('Heroes')
    expect(hero.fields.map((f) => f.name)).toEqual(['heading', 'subheading'])
  })

  it('exposes versions/drafts state per collection for the admin', () => {
    const schema = describeConfig(kernel.config)
    const articles = schema.collections.find((c) => c.slug === 'articles')!
    expect(articles.versions).toEqual({ enabled: true, drafts: true })
    const posts = schema.collections.find((c) => c.slug === 'posts')!
    expect(posts.versions).toEqual({ enabled: true, drafts: false })
    const builder = schema.collections.find((c) => c.slug === 'builder')!
    expect(builder.versions).toBeUndefined()
  })
})

describe('richText (engine)', () => {
  const para = (text: string, marks?: { type: string }[]) => ({
    type: 'doc',
    v: 1,
    children: [{ type: 'paragraph', children: [{ type: 'text', text, ...(marks ? { marks } : {}) }] }],
  })

  it('sanitizes disallowed nodes/marks on write (standard preset)', async () => {
    const dirty = {
      v: 1,
      type: 'doc',
      children: [
        { type: 'paragraph', children: [{ type: 'text', text: 'kept', marks: [{ type: 'bold' }, { type: 'sup' }] }] },
        { type: 'codeBlock', code: 'rm -rf /' }, // codeBlock not allowed in 'standard'
      ],
    }
    const doc = await kernel.create({ collection: 'builder', data: { title: 'RT', body: dirty }, ...admin })
    const body = doc.body as { children: { type: string; children?: { marks?: { type: string }[] }[] }[] }
    // codeBlock stripped; only the paragraph remains.
    expect(body.children.map((c) => c.type)).toEqual(['paragraph'])
    // 'sup' is not in the standard preset → stripped; 'bold' kept.
    expect(body.children[0]!.children![0]!.marks).toEqual([{ type: 'bold' }])
  })

  it('upgrades a legacy string value to the document model on write', async () => {
    const doc = await kernel.create({ collection: 'builder', data: { title: 'Legacy', body: 'plain text' }, ...admin })
    expect(doc.body).toEqual(para('plain text'))
  })

  it('rejects a value that is not a rich-text document', async () => {
    await expect(
      kernel.create({ collection: 'builder', data: { title: 'Bad', body: { foo: 1 } }, ...admin }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('describes the resolved richText allow-list for the admin', () => {
    const schema = describeConfig(kernel.config)
    const builder = schema.collections.find((c) => c.slug === 'builder')!
    const body = builder.fields.find((f) => f.name === 'body')!
    expect(body.richText?.marks).toContain('bold')
    expect(body.richText?.marks).not.toContain('sup')
    expect(body.richText?.headingLevels).toEqual([2, 3])
    expect(body.richText?.link.enabled).toBe(true)
  })
})

describe('uploads', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

  it('injects system fields and stores the file as a document', async () => {
    const doc = await kernel.upload({
      collection: 'media',
      file: { data: PNG, name: 'Launch Shot.png', mimeType: 'image/png' },
      data: { alt: 'Launch keynote' },
      ...admin,
    })
    expect(doc.alt).toBe('Launch keynote')
    expect(doc.filename).toBe('Launch Shot.png')
    expect(doc.mime_type).toBe('image/png')
    expect(doc.filesize).toBe(PNG.length)
    expect(doc.checksum).toMatch(/^[a-f0-9]{64}$/)
    expect(doc.url).toContain('/files/')
    // It is a normal document — readable through the query layer.
    const found = await kernel.findByID({ collection: 'media', id: doc.id, ...admin })
    expect(found?.url).toBe(doc.url)
  })

  it('rejects a file whose bytes do not match the declared type (magic-byte sniff)', async () => {
    const php = Buffer.from('<?php system($_GET["c"]); ?>', 'utf8')
    await expect(
      kernel.upload({
        collection: 'media',
        file: { data: php, name: 'evil.png', mimeType: 'image/png' },
        data: { alt: 'x' },
        ...admin,
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('enforces the size limit and the mime allow-list', async () => {
    const tooBig = Buffer.concat([PNG, Buffer.alloc(2048)])
    await expect(
      kernel.upload({
        collection: 'media',
        file: { data: tooBig, name: 'big.png', mimeType: 'image/png' },
        data: { alt: 'x' },
        ...admin,
      }),
    ).rejects.toBeInstanceOf(ValidationError)

    const gif = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
    // image/gif matches 'image/*', so the allow-list passes — but declare a disallowed type.
    await expect(
      kernel.upload({
        collection: 'media',
        file: { data: gif, name: 'a.txt', mimeType: 'text/plain' },
        data: { alt: 'x' },
        ...admin,
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('does not leave an orphaned binary when the document write fails', async () => {
    const store = kernel.config.storage as ReturnType<typeof memoryStorage>
    const before = store._store.size
    // Missing required `alt` → create() throws after the byte is stored; it must be swept.
    await expect(
      kernel.upload({ collection: 'media', file: { data: PNG, name: 'noalt.png', mimeType: 'image/png' }, ...admin }),
    ).rejects.toBeInstanceOf(ValidationError)
    expect(store._store.size).toBe(before)
  })
})

describe('versions', () => {
  it('records a version on create and on each update', async () => {
    const post = await kernel.create({ collection: 'posts', data: { title: 'Version one' }, ...admin })
    await kernel.update({ collection: 'posts', id: post.id, data: { title: 'Version two' }, ...admin })
    const versions = await kernel.findVersions({ collection: 'posts', id: post.id, ...admin })
    expect(versions.totalDocs).toBe(2)
    const titles = versions.docs.map((v) => (v.version as { title?: string }).title).sort()
    expect(titles).toEqual(['Version one', 'Version two'])
  })

  it('restores a prior version (and snapshots the restore)', async () => {
    const post = await kernel.create({ collection: 'posts', data: { title: 'Original title' }, ...admin })
    await kernel.update({ collection: 'posts', id: post.id, data: { title: 'Changed title' }, ...admin })

    const versions = await kernel.findVersions({ collection: 'posts', id: post.id, ...admin })
    const original = versions.docs.find((v) => (v.version as { title?: string }).title === 'Original title')!
    expect(original).toBeTruthy()

    const restored = await kernel.restoreVersion({ collection: 'posts', id: post.id, versionId: original.id, ...admin })
    expect(restored?.title).toBe('Original title')

    const live = await kernel.findByID({ collection: 'posts', id: post.id, ...admin })
    expect(live?.title).toBe('Original title')

    const after = await kernel.findVersions({ collection: 'posts', id: post.id, ...admin })
    expect(after.totalDocs).toBe(3) // create + update + restore
  })

  it('rejects findVersions on a non-versioned collection', async () => {
    const author = await kernel.create({ collection: 'authors', data: { name: 'Ada' }, ...admin })
    await expect(kernel.findVersions({ collection: 'authors', id: author.id, ...admin })).rejects.toBeTruthy()
  })
})

describe('drafts & publish', () => {
  it('new documents are drafts, hidden from published reads', async () => {
    const a = await kernel.create({ collection: 'articles', data: { title: 'Draft A' }, ...admin })
    expect(a._status).toBe('draft')
    const list = await kernel.find({ collection: 'articles', ...admin })
    expect(list.docs.find((d) => d.id === a.id)).toBeUndefined()
    expect(await kernel.findByID({ collection: 'articles', id: a.id, ...admin })).toBeNull()
    // draft:true reveals it
    const draftView = await kernel.findByID({ collection: 'articles', id: a.id, draft: true, ...admin })
    expect(draftView?.title).toBe('Draft A')
  })

  it('publish exposes the document; unpublish hides it again', async () => {
    const a = await kernel.create({ collection: 'articles', data: { title: 'To publish' }, ...admin })
    await kernel.publish({ collection: 'articles', id: a.id, ...admin })
    const pub = await kernel.findByID({ collection: 'articles', id: a.id, ...admin })
    expect(pub?._status).toBe('published')
    expect(pub?.title).toBe('To publish')

    await kernel.unpublish({ collection: 'articles', id: a.id, ...admin })
    expect(await kernel.findByID({ collection: 'articles', id: a.id, ...admin })).toBeNull()
  })

  it('published find() excludes drafts; draft find() includes them', async () => {
    await kernel.create({ collection: 'articles', data: { title: 'Hidden draft' }, ...admin })
    const p = await kernel.create({ collection: 'articles', data: { title: 'Live one' }, ...admin })
    await kernel.publish({ collection: 'articles', id: p.id, ...admin })

    const published = await kernel.find({ collection: 'articles', ...admin })
    const drafts = await kernel.find({ collection: 'articles', draft: true, ...admin })
    expect(published.docs.every((d) => d._status === 'published')).toBe(true)
    expect(drafts.totalDocs).toBeGreaterThan(published.totalDocs)
  })

  it('autosave flags the version snapshot without publishing', async () => {
    const a = await kernel.create({ collection: 'articles', data: { title: 'Draft' }, ...admin })
    await kernel.update({ collection: 'articles', id: a.id, data: { title: 'Auto-saved' }, autosave: true, ...admin })
    const reread = await kernel.findByID({ collection: 'articles', id: a.id, draft: true, ...admin })
    expect(reread?._status).toBe('draft') // still a draft
    const versions = await kernel.findVersions({ collection: 'articles', id: a.id, ...admin })
    expect(versions.docs.some((v) => v.autosave === true)).toBe(true)
  })

  it('schedules a future publish (stays draft) and releases it when due', async () => {
    const a = await kernel.create({ collection: 'articles', data: { title: 'Embargoed' }, ...admin })
    const future = new Date(Date.now() + 60_000).toISOString()
    await kernel.publish({ collection: 'articles', id: a.id, publishAt: future, ...admin })
    // Still a draft — not visible to a published read.
    expect(await kernel.findByID({ collection: 'articles', id: a.id, ...admin })).toBeNull()

    // Nothing due "now"; everything due an hour later.
    const noneYet = await kernel.processScheduledPublishes({ now: Date.now() })
    expect(noneYet.published).not.toContain(a.id)
    const released = await kernel.processScheduledPublishes({ now: Date.now() + 120_000 })
    expect(released.published).toContain(a.id)

    const pub = await kernel.findByID({ collection: 'articles', id: a.id, ...admin })
    expect(pub?._status).toBe('published')
  })
})

describe('globals', () => {
  it('returns defaults before the global is written', async () => {
    const settings = await kernel.findGlobal({ slug: 'settings', ...admin })
    expect(settings.site_name).toBe('KernelCMS')
  })

  it('persists global updates', async () => {
    await kernel.updateGlobal({ slug: 'settings', data: { site_name: 'My Site' }, ...admin })
    const settings = await kernel.findGlobal({ slug: 'settings' })
    expect(settings.site_name).toBe('My Site')
  })
})

describe('query safety', () => {
  it('treats LIKE wildcards in `contains` as literal characters', async () => {
    await kernel.create({ collection: 'authors', data: { name: '100% legit' }, ...admin })
    await kernel.create({ collection: 'authors', data: { name: 'nope' }, ...admin })

    const percent = await kernel.find({ collection: 'authors', where: { name: { contains: '100%' } }, ...admin })
    expect(percent.totalDocs).toBe(1)
    expect(percent.docs[0]?.name).toBe('100% legit')

    // A bare '%' must not act as a match-everything wildcard.
    const wildcard = await kernel.find({ collection: 'authors', where: { name: { contains: '%' } }, ...admin })
    expect(wildcard.totalDocs).toBe(1)

    // '_' must not act as a single-character wildcard ("nope" !~ "n_pe").
    const underscore = await kernel.find({ collection: 'authors', where: { name: { contains: 'n_pe' } }, ...admin })
    expect(underscore.totalDocs).toBe(0)
  })
})

describe('auth tokens', () => {
  it('round-trips a valid token', () => {
    const token = signToken({ sub: 'u1', collection: 'users' }, 'secret')
    expect(verifyToken(token, 'secret')?.sub).toBe('u1')
  })

  it('rejects a token whose payload was tampered with', () => {
    const token = signToken({ sub: 'u1', collection: 'users' }, 'secret')
    const [header, , sig] = token.split('.')
    const forgedBody = Buffer.from(JSON.stringify({ sub: 'admin', collection: 'users' })).toString('base64url')
    expect(verifyToken(`${header}.${forgedBody}.${sig}`, 'secret')).toBeNull()
  })

  it('rejects a token signed with a different secret', () => {
    const token = signToken({ sub: 'u1', collection: 'users' }, 'secret-a')
    expect(verifyToken(token, 'secret-b')).toBeNull()
  })

  it('rejects an expired token', () => {
    const token = signToken({ sub: 'u1', collection: 'users' }, 'secret', -1)
    expect(verifyToken(token, 'secret')).toBeNull()
  })
})

describe('field-level access control', () => {
  let secure: Kernel
  const asUser = (id: string) => ({ req: { user: { id, roles: ['user'], collection: 'users' } } })
  const asAdmin = { req: { user: { id: 'root', roles: ['admin'], collection: 'users' } } }

  beforeEach(async () => {
    secure = await initKernel(buildSecurityConfig(), { logLevel: 'error' })
    await secure.migrate()
  })
  afterEach(async () => {
    await secure.destroy()
  })

  it('strips a protected field a non-admin tries to set on create', async () => {
    const created = await secure.create({
      collection: 'users',
      data: { email: 'a@example.com', password: 'password123', roles: ['admin'] },
      ...asUser('self'),
    })
    expect(created.roles).toEqual(['user'])
  })

  it('blocks a user from escalating their own roles on update', async () => {
    const user = await secure.create({
      collection: 'users',
      data: { email: 'b@example.com', password: 'password123', name: 'B' },
      ...admin,
    })
    expect(user.roles).toEqual(['user'])

    const updated = await secure.update({
      collection: 'users',
      id: user.id,
      data: { name: 'B renamed', roles: ['admin'] },
      ...asUser(user.id),
    })
    expect(updated?.name).toBe('B renamed') // unprotected field still written
    expect(updated?.roles).toEqual(['user']) // protected field rejected
  })

  it('allows an admin to set the protected field', async () => {
    const user = await secure.create({
      collection: 'users',
      data: { email: 'c@example.com', password: 'password123' },
      ...admin,
    })
    const promoted = await secure.update({
      collection: 'users',
      id: user.id,
      data: { roles: ['admin'] },
      ...asAdmin,
    })
    expect(promoted?.roles).toEqual(['admin'])
  })
})

describe('authority fields are admin-write by default (no explicit field access)', () => {
  // Mirrors the real-world footgun: an auth collection whose `update` lets a user
  // edit their OWN record, and a `roles` field with NO field-level access rule.
  // The framework must still block self-promotion without the developer doing
  // anything — that is the secure-by-default contract.
  function buildDefaultConfig() {
    return defineConfig({
      secret: 'test-secret',
      db: sqliteAdapter({ url: ':memory:' }),
      collections: [
        {
          slug: 'users',
          auth: true,
          access: {
            read: () => true,
            create: () => true,
            // Self-scoped update — exactly the pattern that made escalation possible.
            update: ({ req }) =>
              Boolean(req.user?.roles?.includes('admin')) || (req.user ? { id: { equals: req.user.id } } : false),
          },
          // No field-level access anywhere — the framework supplies the default.
          fields: [
            { name: 'name', type: 'text' },
            { name: 'roles', type: 'select', hasMany: true, options: ['user', 'admin'], defaultValue: ['user'] },
          ],
        },
      ],
    })
  }

  let secure: Kernel
  beforeEach(async () => {
    secure = await initKernel(buildDefaultConfig(), { logLevel: 'error' })
    await secure.migrate()
  })
  afterEach(async () => {
    await secure.destroy()
  })

  it('blocks a user from self-promoting their own roles with no explicit field rule', async () => {
    const user = await secure.create({
      collection: 'users',
      data: { email: 'editor@example.com', password: 'password123', name: 'Editor' },
      ...admin,
    })
    expect(user.roles).toEqual(['user'])

    const updated = await secure.update({
      collection: 'users',
      id: user.id,
      data: { name: 'Editor renamed', roles: ['admin'] },
      req: { user: { id: user.id, roles: ['user'], collection: 'users' } },
    })
    expect(updated?.name).toBe('Editor renamed') // ordinary field still writable
    expect(updated?.roles).toEqual(['user']) // privilege field rejected by default
  })

  it('strips roles a non-admin sets at create with no explicit field rule', async () => {
    const created = await secure.create({
      collection: 'users',
      data: { email: 'new@example.com', password: 'password123', roles: ['admin'] },
      req: { user: { id: 'someone', roles: ['user'], collection: 'users' } },
    })
    expect(created.roles).toEqual(['user'])
  })

  it('still lets an admin set roles, and trusted (overrideAccess) bootstrapping works', async () => {
    const user = await secure.create({
      collection: 'users',
      data: { email: 'p@example.com', password: 'password123' },
      ...admin,
    })
    const promoted = await secure.update({
      collection: 'users',
      id: user.id,
      data: { roles: ['admin'] },
      req: { user: { id: 'root', roles: ['admin'], collection: 'users' } },
    })
    expect(promoted?.roles).toEqual(['admin'])

    // overrideAccess (seed / first-admin setup / OAuth) bypasses field access.
    const seeded = await secure.create({
      collection: 'users',
      data: { email: 'admin@example.com', password: 'password123', roles: ['admin'] },
      ...admin,
    })
    expect(seeded.roles).toEqual(['admin'])
  })
})

describe('field-level read access', () => {
  let secure: Kernel
  const asUser = { req: { user: { id: 'u1', roles: ['user'], collection: 'users' } } }
  const asAdmin = { req: { user: { id: 'root', roles: ['admin'], collection: 'users' } } }

  beforeEach(async () => {
    secure = await initKernel(buildSecurityConfig(), { logLevel: 'error' })
    await secure.migrate()
    await secure.create({
      collection: 'users',
      data: { email: 'r@example.com', password: 'password123', secret: 'top-secret' },
      ...admin,
    })
  })
  afterEach(async () => {
    await secure.destroy()
  })

  it('strips a read-protected field for a non-admin (findByID)', async () => {
    const list = await secure.find({ collection: 'users', ...admin })
    const id = list.docs[0]!.id
    const seen = await secure.findByID({ collection: 'users', id, ...asUser })
    expect(seen?.email).toBe('r@example.com')
    expect(seen?.secret).toBeUndefined()
  })

  it('keeps the field for admins and for overrideAccess', async () => {
    const list = await secure.find({ collection: 'users', ...admin })
    const id = list.docs[0]!.id
    expect((await secure.findByID({ collection: 'users', id, ...asAdmin }))?.secret).toBe('top-secret')
    expect((await secure.findByID({ collection: 'users', id, ...admin }))?.secret).toBe('top-secret')
  })

  it('strips the field across a find() list for non-admins', async () => {
    const list = await secure.find({ collection: 'users', ...asUser })
    expect(list.docs.length).toBeGreaterThan(0)
    expect(list.docs.every((d) => d.secret === undefined)).toBe(true)
  })
})

describe('row-scoped access control', () => {
  let secure: Kernel
  const asAlice = { req: { user: { id: 'alice', roles: ['user'], collection: 'users' } } }

  beforeEach(async () => {
    secure = await initKernel(buildSecurityConfig(), { logLevel: 'error' })
    await secure.migrate()
    await secure.create({ collection: 'notes', data: { owner: 'alice', body: 'mine' }, ...admin })
    await secure.create({ collection: 'notes', data: { owner: 'bob', body: 'theirs' }, ...admin })
  })
  afterEach(async () => {
    await secure.destroy()
  })

  it('lists only rows the requester owns', async () => {
    const result = await secure.find({ collection: 'notes', ...asAlice })
    expect(result.totalDocs).toBe(1)
    expect(result.docs[0]?.body).toBe('mine')
  })

  it("forbids reading another owner's row by id", async () => {
    const bobNote = await secure.find({ collection: 'notes', where: { owner: { equals: 'bob' } }, ...admin })
    const id = bobNote.docs[0]!.id
    await expect(secure.findByID({ collection: 'notes', id, ...asAlice })).rejects.toBeInstanceOf(ForbiddenError)
  })

  it("forbids updating another owner's row", async () => {
    const bobNote = await secure.find({ collection: 'notes', where: { owner: { equals: 'bob' } }, ...admin })
    const id = bobNote.docs[0]!.id
    await expect(
      secure.update({ collection: 'notes', id, data: { body: 'hijacked' }, ...asAlice }),
    ).rejects.toBeInstanceOf(ForbiddenError)
  })
})

describe('login + brute-force protection', () => {
  let secure: Kernel
  beforeEach(async () => {
    secure = await initKernel(buildSecurityConfig(), { logLevel: 'error' })
    await secure.migrate()
  })
  afterEach(async () => {
    await secure.destroy()
  })

  it('authenticates a valid user and issues a usable token', async () => {
    await secure.create({
      collection: 'users',
      data: { email: 'real@example.com', password: 'password123' },
      ...admin,
    })
    const result = await secure.login({ collection: 'users', email: 'real@example.com', password: 'password123' })
    expect(result.token).toBeTypeOf('string')

    const who = await secure.authenticate(result.token)
    expect(who?.email).toBe('real@example.com')
  })

  it('rejects authentication of a forged token', async () => {
    const forged = signToken({ sub: 'nobody', collection: 'users' }, 'a-different-secret')
    expect(await secure.authenticate(forged)).toBeNull()
  })

  it('locks the identifier after repeated failures', async () => {
    const attempt = () => secure.login({ collection: 'users', email: 'ghost@example.com', password: 'wrong-password' })

    for (let i = 0; i < 10; i++) {
      await expect(attempt()).rejects.toBeInstanceOf(UnauthorizedError)
    }
    await expect(attempt()).rejects.toBeInstanceOf(TooManyRequestsError)
  })
})

describe('presentational fields (row / tabs / ui)', () => {
  async function layoutKernel(): Promise<Kernel> {
    const k = await initKernel(
      defineConfig({
        secret: 'layout-secret',
        db: sqliteAdapter({ url: ':memory:' }),
        collections: [
          {
            slug: 'pages',
            access: { read: () => true },
            fields: [
              {
                type: 'row',
                fields: [
                  { name: 'title', type: 'text', required: true },
                  { name: 'subtitle', type: 'text' },
                ],
              },
              {
                type: 'tabs',
                tabs: [
                  { label: 'SEO', fields: [{ name: 'meta_title', type: 'text' }] },
                  { label: 'Body', fields: [{ name: 'body', type: 'textarea', required: true }] },
                ],
              },
              { type: 'ui', name: 'preview_button' },
            ],
          },
        ],
      }),
      { logLevel: 'error' },
    )
    await k.migrate()
    return k
  }

  it('persists fields nested in row/tabs at the parent level and ignores ui', async () => {
    const k = await layoutKernel()
    const doc = await k.create({
      collection: 'pages',
      data: { title: 'Hello', subtitle: 'Sub', meta_title: 'SEO', body: 'Body text', preview_button: 'ignored' },
      ...admin,
    })
    expect(doc.title).toBe('Hello')
    expect(doc.meta_title).toBe('SEO')
    expect(doc.body).toBe('Body text')
    expect(doc.preview_button).toBeUndefined() // ui holds no data
    await k.destroy()
  })

  it('validates required fields declared inside a tab', async () => {
    const k = await layoutKernel()
    await expect(
      k.create({ collection: 'pages', data: { title: 'X' }, ...admin }), // missing required `body` (in a tab)
    ).rejects.toBeInstanceOf(ValidationError)
    await k.destroy()
  })

  it('flattens presentational fields in the admin descriptor', () => {
    const schema = describeConfig(
      sanitizeConfig(
        defineConfig({
          secret: 'x-aaaaaaaaaaaaaaaa',
          db: sqliteAdapter({ url: ':memory:' }),
          collections: [
            {
              slug: 'pages',
              access: { read: () => true },
              fields: [
                { type: 'row', fields: [{ name: 'title', type: 'text' }] },
                { type: 'ui', name: 'btn' },
              ],
            },
          ],
        }),
      ),
    )
    const names = schema.collections.find((c) => c.slug === 'pages')!.fields.map((f) => f.name)
    expect(names).toContain('title')
    expect(names).not.toContain('btn')
  })
})

describe('systemInfo', () => {
  it('summarizes the instance: collections, globals, and derived capabilities', () => {
    const info = systemInfo(kernel)
    expect(info.name).toBe('KernelCMS')
    expect(info.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(info.collections.map((c) => c.slug)).toEqual(
      expect.arrayContaining(['media', 'authors', 'posts', 'articles']),
    )
    expect(info.globals).toContain('settings')
    // Derived from the buildConfig fixture: media=upload+storage, articles=drafts, posts=versions.
    expect(info.capabilities.uploads).toBe(true)
    expect(info.capabilities.storage).toBe(true)
    expect(info.capabilities.drafts).toBe(true)
    expect(info.capabilities.versions).toBe(true)
    expect(info.capabilities.localization).toBe(true)
    const media = info.collections.find((c) => c.slug === 'media')!
    expect(media.upload).toBe(true)
  })
})

describe('importData (migration)', () => {
  it('imports a portable payload across collections and reports counts', async () => {
    const author = await kernel.create({ collection: 'authors', data: { name: 'Seed' }, ...admin })
    const report = await importData(kernel, {
      authors: [{ name: 'Imported A' }, { name: 'Imported B' }],
      posts: [{ title: 'Imported post', author: author.id }],
    })
    expect(report.ok).toBe(true)
    expect(report.created.authors).toBe(2)
    expect(report.created.posts).toBe(1)
    expect(report.errors).toHaveLength(0)
  })

  it('collects per-row validation errors and keeps importing the rest', async () => {
    const report = await importData(kernel, {
      authors: [{ name: 'Valid' }, {}, { name: 'Also valid' }], // middle row missing required name
    })
    expect(report.created.authors).toBe(2)
    expect(report.errors).toHaveLength(1)
    expect(report.errors[0]).toMatchObject({ collection: 'authors', index: 1 })
    expect(report.ok).toBe(false)
  })

  it('reports an unknown collection without throwing', async () => {
    const report = await importData(kernel, { ghosts: [{ x: 1 }] })
    expect(report.errors[0]?.message).toMatch(/unknown collection/i)
  })
})

describe('doctor', () => {
  const codes = (config: Parameters<typeof sanitizeConfig>[0], env = 'development') =>
    runDoctor(sanitizeConfig(config), { env }).diagnostics.map((d) => d.code)

  it('flags an upload collection with no storage adapter as an error', () => {
    const report = runDoctor(
      sanitizeConfig({
        secret: 'a-sufficiently-long-secret-value',
        db: sqliteAdapter({ url: ':memory:' }),
        collections: [
          { slug: 'media', upload: true, access: { read: () => true }, fields: [{ name: 'alt', type: 'text' }] },
        ],
      }),
    )
    expect(report.ok).toBe(false)
    expect(report.diagnostics.some((d) => d.code === 'upload-no-storage' && d.level === 'error')).toBe(true)
  })

  it('flags a relationship to an unknown collection', () => {
    expect(
      codes({
        secret: 'a-sufficiently-long-secret-value',
        db: sqliteAdapter({ url: ':memory:' }),
        collections: [
          {
            slug: 'posts',
            access: { read: () => true },
            fields: [{ name: 'author', type: 'relationship', relationTo: 'ghosts' }],
          },
        ],
      }),
    ).toContain('unknown-relation')
  })

  it('escalates the insecure dev secret to an error in production', () => {
    const cfg = defineConfig({
      db: sqliteAdapter({ url: ':memory:' }),
      collections: [
        { slug: 'posts', auth: true, access: { read: () => true }, fields: [{ name: 'title', type: 'text' }] },
      ],
    })
    const dev = runDoctor(sanitizeConfig(cfg), { env: 'development' })
    const prod = runDoctor(sanitizeConfig(cfg), { env: 'production' })
    expect(dev.diagnostics.find((d) => d.code === 'insecure-secret')?.level).toBe('warn')
    expect(prod.diagnostics.find((d) => d.code === 'insecure-secret')?.level).toBe('error')
  })

  it('is clean for a well-formed config', () => {
    const report = runDoctor(
      sanitizeConfig({
        secret: 'a-sufficiently-long-secret-value',
        // Durable storage — memoryStorage would (correctly) raise ephemeral-storage.
        storage: localStorage({ rootDir: './.uploads' }),
        db: sqliteAdapter({ url: ':memory:' }),
        collections: [
          { slug: 'users', auth: true, access: { read: () => true }, fields: [{ name: 'name', type: 'text' }] },
          {
            slug: 'media',
            upload: true,
            access: { read: () => true },
            admin: { useAsTitle: 'alt' },
            fields: [{ name: 'alt', type: 'text' }],
          },
        ],
      }),
    )
    expect(report.errors).toBe(0)
    expect(report.warnings).toBe(0)
  })
})

describe('API keys', () => {
  async function apiKeyKernel(): Promise<Kernel> {
    const k = await initKernel(
      {
        secret: 'apikey-secret',
        db: sqliteAdapter({ url: ':memory:' }),
        collections: [
          {
            slug: 'machines',
            auth: { useAPIKey: true },
            access: { read: () => true, create: () => true },
            fields: [{ name: 'name', type: 'text' }],
          },
        ],
      },
      { logLevel: 'error' },
    )
    await k.migrate()
    return k
  }

  it('authenticates a user from a generated API key and rejects a wrong one', async () => {
    const k = await apiKeyKernel()
    const user = await k.create({
      collection: 'machines',
      data: { email: 'bot@example.com', password: 'a-long-password', name: 'CI bot' },
      overrideAccess: true,
    })
    const { key } = await k.createAPIKey({ collection: 'machines', id: user.id })
    expect(key).toMatch(/^machines_/)

    const authed = await k.authenticateAPIKey('machines', key)
    expect(authed?.id).toBe(user.id)
    // The key hash is never exposed on the resolved user.
    expect(authed?.api_key).toBeUndefined()

    expect(await k.authenticateAPIKey('machines', 'machines_not-a-real-key')).toBeNull()
    await k.destroy()
  })

  it('rotating the key invalidates the previous one', async () => {
    const k = await apiKeyKernel()
    const user = await k.create({
      collection: 'machines',
      data: { email: 'bot2@example.com', password: 'a-long-password' },
      overrideAccess: true,
    })
    const first = (await k.createAPIKey({ collection: 'machines', id: user.id })).key
    const second = (await k.createAPIKey({ collection: 'machines', id: user.id })).key
    expect(second).not.toBe(first)
    expect(await k.authenticateAPIKey('machines', first)).toBeNull()
    expect((await k.authenticateAPIKey('machines', second))?.id).toBe(user.id)
    await k.destroy()
  })
})

describe('plugins', () => {
  const admin = { overrideAccess: true }
  const slugify = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')

  async function pluginKernel(plugins: KernelPlugin[]): Promise<Kernel> {
    const k = await initKernel(
      {
        secret: 'plugin-secret',
        db: sqliteAdapter({ url: ':memory:' }),
        collections: [
          { slug: 'posts', access: { read: () => true }, fields: [{ name: 'title', type: 'text', required: true }] },
        ],
        plugins,
      },
      { logLevel: 'error' },
    )
    await k.migrate()
    return k
  }

  it('lets a plugin add a new collection', async () => {
    const tagsPlugin = definePlugin(() => ({
      name: 'test/tags',
      setup: (ctx) =>
        ctx.extend.addCollections({
          slug: 'tags',
          access: { read: () => true },
          fields: [{ name: 'name', type: 'text', required: true }],
        }),
    }))
    const k = await pluginKernel([tagsPlugin()])
    const tag = await k.create({ collection: 'tags', data: { name: 'release' }, ...admin })
    expect(tag.name).toBe('release')
    await k.destroy()
  })

  it('lets a plugin add a field and a beforeChange hook to existing collections', async () => {
    const slugPlugin = definePlugin<{ from: string }>((options) => ({
      name: 'test/slug',
      setup: (ctx) =>
        ctx.extend.collections(['posts'], (collection) => ({
          ...collection,
          fields: [...collection.fields, { name: 'auto_slug', type: 'text' }],
          hooks: {
            ...collection.hooks,
            beforeChange: [
              ...(collection.hooks?.beforeChange ?? []),
              ({ data }: { data: Record<string, unknown> }) => ({
                ...data,
                auto_slug: slugify(String(data[options.from] ?? '')),
              }),
            ],
          },
        })),
    }))
    const k = await pluginKernel([slugPlugin({ from: 'title' })])
    const post = await k.create({ collection: 'posts', data: { title: 'Hello World' }, ...admin })
    expect(post.auto_slug).toBe('hello-world')
    await k.destroy()
  })

  it('respects dependsOn ordering regardless of array position', async () => {
    // `b` transforms a collection that `a` adds; placed out of order, dependsOn fixes it.
    const a = definePlugin(() => ({
      name: 'test/a',
      setup: (ctx) =>
        ctx.extend.addCollections({
          slug: 'widgets',
          access: { read: () => true },
          fields: [{ name: 'name', type: 'text' }],
        }),
    }))
    const b = definePlugin(() => ({
      name: 'test/b',
      dependsOn: ['test/a'],
      setup: (ctx) =>
        ctx.extend.collections(['widgets'], (c) => ({ ...c, fields: [...c.fields, { name: 'color', type: 'text' }] })),
    }))
    const k = await pluginKernel([b(), a()]) // b before a in the array
    const schema = describeConfig(k.config)
    const widgets = schema.collections.find((c) => c.slug === 'widgets')!
    expect(widgets.fields.map((f) => f.name)).toEqual(['name', 'color'])
    await k.destroy()
  })

  it('rejects a plugin that adds a duplicate collection slug', async () => {
    const dup = definePlugin(() => ({
      name: 'test/dup',
      setup: (ctx) => ctx.extend.addCollections({ slug: 'posts', fields: [{ name: 'x', type: 'text' }] }),
    }))
    await expect(pluginKernel([dup()])).rejects.toBeInstanceOf(PluginConflictError)
  })

  it('rejects a dependency cycle', async () => {
    const a = definePlugin(() => ({ name: 'test/a', dependsOn: ['test/b'], setup: (ctx) => ctx.config }))
    const b = definePlugin(() => ({ name: 'test/b', dependsOn: ['test/a'], setup: (ctx) => ctx.config }))
    await expect(pluginKernel([a(), b()])).rejects.toBeInstanceOf(PluginCycleError)
  })
})
