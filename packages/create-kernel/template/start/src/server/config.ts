import { defineConfig } from '@kernel/core'
import type { Kernel } from '@kernel/core'
import { sqliteAdapter } from '@kernel/db-sqlite'

/** A small blog content model, served entirely by the KernelCMS Local API. */
export const config = defineConfig({
  secret: process.env.KERNEL_SECRET ?? 'start-dev-secret',
  db: sqliteAdapter({ url: process.env.KERNEL_DB_URL ?? 'file:./kernelcms.db' }),
  collections: [
    {
      slug: 'authors',
      admin: { useAsTitle: 'name' },
      access: { read: () => true },
      fields: [
        { name: 'name', type: 'text', required: true },
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
      admin: { useAsTitle: 'title' },
      access: { read: () => true },
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'slug', type: 'slug', required: true, unique: true, index: true },
        { name: 'excerpt', type: 'textarea' },
        { name: 'body', type: 'textarea' },
        { name: 'status', type: 'select', options: ['draft', 'published'], defaultValue: 'draft', index: true },
        { name: 'published_at', type: 'date' },
        { name: 'author', type: 'relationship', relationTo: 'authors' },
        { name: 'categories', type: 'relationship', relationTo: 'categories', hasMany: true },
      ],
    },
  ],
  globals: [
    {
      slug: 'site_settings',
      access: { read: () => true },
      fields: [
        { name: 'site_name', type: 'text', defaultValue: 'The Kernel Blog' },
        { name: 'tagline', type: 'text', defaultValue: 'Built with KernelCMS on TanStack Start' },
      ],
    },
  ],
})

/** Idempotent seed run once on first boot. */
export async function seed(kernel: Kernel): Promise<void> {
  const sys = { overrideAccess: true } as const

  const ada = await kernel.create({
    collection: 'authors',
    data: { name: 'Ada Lovelace', bio: 'Wrote the first algorithm intended for a machine.' },
    ...sys,
  })
  const grace = await kernel.create({
    collection: 'authors',
    data: { name: 'Grace Hopper', bio: 'Pioneered machine-independent programming languages.' },
    ...sys,
  })
  const eng = await kernel.create({ collection: 'categories', data: { name: 'Engineering', slug: 'engineering' }, ...sys })
  const product = await kernel.create({ collection: 'categories', data: { name: 'Product', slug: 'product' }, ...sys })

  const posts = [
    {
      title: 'Hello from KernelCMS on TanStack Start',
      slug: 'hello-kernelcms',
      excerpt: 'This page is server-rendered by TanStack Start, with content read from the KernelCMS Local API — no HTTP round-trip.',
      body:
        'Everything you see here flows from a single kernel.config.ts. TanStack Start calls the KernelCMS Local API inside a server function, queries SQLite through the database adapter, and streams HTML to your browser. The same operations are also available as a REST and typed RPC API.',
      author: ada.id,
      categories: [eng.id],
      pub: '2026-01-03',
    },
    {
      title: 'Choose Everything: The Adapter Pattern',
      slug: 'choose-everything',
      excerpt: 'Database, storage, auth, search — every infrastructure concern is a swappable adapter behind one contract.',
      body:
        'The KernelCMS core never imports a driver. It is written against contracts, so the very same content config runs on Postgres in production, SQLite in development, or MongoDB on a teammate’s laptop with a one-line change.',
      author: ada.id,
      categories: [eng.id, product.id],
      pub: '2026-01-02',
    },
    {
      title: 'Type-safe content, end to end',
      slug: 'type-safe-content',
      excerpt: 'Model content as code and get generated TypeScript types, validation, and a typed client for free.',
      body:
        'Define a collection once and KernelCMS gives you migrations, validation, access control, a REST + GraphQL-ready API surface, and generated types your frontend can import. No drift between your schema and your code.',
      author: grace.id,
      categories: [product.id],
      pub: '2026-01-01',
    },
  ]

  for (const p of posts) {
    await kernel.create({
      collection: 'posts',
      data: {
        title: p.title,
        slug: p.slug,
        excerpt: p.excerpt,
        body: p.body,
        status: 'published',
        published_at: new Date(p.pub).toISOString(),
        author: p.author,
        categories: p.categories,
      },
      ...sys,
    })
  }

  await kernel.updateGlobal({
    slug: 'site_settings',
    data: { site_name: 'The Kernel Blog', tagline: 'Built with KernelCMS on TanStack Start' },
    ...sys,
  })
}
