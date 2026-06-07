import { defineConfig } from '@kernel/core'
import type { Kernel } from '@kernel/core'
import { sqliteAdapter } from '@kernel/db-sqlite'

/**
 * Example KernelCMS configuration: a small blog with authors, categories,
 * posts, and site settings. Reads are public; writes require auth (or the
 * system API key over HTTP).
 */
export default defineConfig({
  serverURL: process.env.SERVER_URL ?? 'http://localhost:3000',
  secret: process.env.KERNEL_SECRET ?? 'blog-dev-secret',
  db: sqliteAdapter({ url: process.env.KERNEL_DB_URL ?? 'file:./blog.db' }),

  collections: [
    {
      slug: 'users',
      auth: true,
      admin: { useAsTitle: 'email' },
      // RBAC: admins manage everyone; a user may read/update only their own record.
      access: {
        read: ({ req }) =>
          Boolean(req.user?.roles?.includes('admin')) || (req.user ? { id: { equals: req.user.id } } : false),
        create: ({ req }) => Boolean(req.user?.roles?.includes('admin')),
        update: ({ req }) =>
          Boolean(req.user?.roles?.includes('admin')) || (req.user ? { id: { equals: req.user.id } } : false),
        delete: ({ req }) => Boolean(req.user?.roles?.includes('admin')),
      },
      fields: [
        { name: 'name', type: 'text' },
        // `roles` is a privilege field. Even though `access.update` above lets a
        // user edit their own record, KernelCMS write-locks authority fields
        // (roles/permissions/…) to admins by default — so a user can't
        // `PATCH /api/users/<own-id> { "roles": ["admin"] }` to self-promote.
        // Override with a field-level `access` rule if you need different behaviour.
        { name: 'roles', type: 'select', hasMany: true, options: ['admin', 'editor'], defaultValue: ['editor'] },
      ],
    },
    {
      slug: 'authors',
      labels: { singular: 'Author', plural: 'Authors' },
      admin: { useAsTitle: 'name' },
      access: { read: () => true },
      fields: [
        { name: 'name', type: 'text', required: true },
        { name: 'email', type: 'email', unique: true },
        { name: 'bio', type: 'textarea' },
      ],
    },
    {
      slug: 'categories',
      admin: { useAsTitle: 'name' },
      access: { read: () => true },
      fields: [
        { name: 'name', type: 'text', required: true },
        { name: 'slug', type: 'slug', required: true, unique: true },
      ],
    },
    {
      slug: 'posts',
      admin: { useAsTitle: 'title', defaultColumns: ['title', 'status', 'published_at'] },
      access: { read: () => true },
      fields: [
        { name: 'title', type: 'text', required: true, minLength: 3 },
        { name: 'slug', type: 'slug', required: true, unique: true, index: true },
        { name: 'excerpt', type: 'textarea', maxLength: 280 },
        { name: 'body', type: 'richText' },
        {
          name: 'status',
          type: 'select',
          options: [
            { label: 'Draft', value: 'draft' },
            { label: 'Published', value: 'published' },
          ],
          defaultValue: 'draft',
          index: true,
        },
        { name: 'featured', type: 'boolean', defaultValue: false },
        { name: 'published_at', type: 'date' },
        { name: 'author', type: 'relationship', relationTo: 'authors' },
        { name: 'categories', type: 'relationship', relationTo: 'categories', hasMany: true },
        { name: 'tags', type: 'select', hasMany: true, options: ['release', 'guide', 'news', 'tutorial'] },
      ],
    },
  ],

  globals: [
    {
      slug: 'site_settings',
      access: { read: () => true },
      fields: [
        { name: 'site_name', type: 'text', defaultValue: 'The Kernel Blog' },
        { name: 'description', type: 'textarea' },
      ],
    },
  ],
})

/** Idempotent seed used by `kernel seed`. */
export async function seed(kernel: Kernel): Promise<void> {
  const sys = { overrideAccess: true } as const
  const existing = await kernel.count({ collection: 'authors', ...sys })
  if (existing > 0) {
    console.log('  Database already seeded — skipping.')
    return
  }

  await kernel.create({
    collection: 'users',
    data: { email: 'admin@example.com', password: 'password123', name: 'Admin', roles: ['admin'] },
    ...sys,
  })

  const ada = await kernel.create({
    collection: 'authors',
    data: { name: 'Ada Lovelace', email: 'ada@example.com', bio: 'Wrote the first algorithm.' },
    ...sys,
  })

  const eng = await kernel.create({
    collection: 'categories',
    data: { name: 'Engineering', slug: 'engineering' },
    ...sys,
  })
  const product = await kernel.create({
    collection: 'categories',
    data: { name: 'Product', slug: 'product' },
    ...sys,
  })

  await kernel.create({
    collection: 'posts',
    data: {
      title: 'Hello, KernelCMS',
      slug: 'hello-kernelcms',
      excerpt: 'A TanStack-native, adapter-based CMS you actually own.',
      body: {
        v: 1,
        type: 'doc',
        children: [{ type: 'paragraph', children: [{ type: 'text', text: 'Welcome to KernelCMS.' }] }],
      },
      status: 'published',
      featured: true,
      published_at: new Date('2026-01-01').toISOString(),
      author: ada.id,
      categories: [eng.id],
      tags: ['release'],
    },
    ...sys,
  })

  await kernel.create({
    collection: 'posts',
    data: {
      title: 'Choose Everything: The Adapter Pattern',
      slug: 'choose-everything',
      excerpt: 'Database, storage, auth, search — all swappable.',
      status: 'published',
      author: ada.id,
      categories: [eng.id, product.id],
      tags: ['guide'],
    },
    ...sys,
  })

  await kernel.create({
    collection: 'posts',
    data: { title: 'Draft: Roadmap', slug: 'roadmap-draft', status: 'draft', author: ada.id },
    ...sys,
  })

  await kernel.updateGlobal({
    slug: 'site_settings',
    data: { site_name: 'The Kernel Blog', description: 'News and guides from the KernelCMS team.' },
    ...sys,
  })

  console.log('  Seeded 1 author, 2 categories, 3 posts, and site settings.')
}
