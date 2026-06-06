import { defineConfig } from '@kernel/core'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { localStorage } from '@kernel/storage'

// Isolated E2E fixture: fresh in-memory DB each boot, built-in preview renderer
// (no external frontend needed). Mirrors the demo content model.
export default defineConfig({
  secret: 'e2e-secret',
  db: sqliteAdapter({ url: ':memory:' }),
  storage: localStorage({ rootDir: './.e2e-uploads', servePath: '/files' }),
  localization: { locales: ['en', 'es'], defaultLocale: 'en' },
  collections: [
    {
      slug: 'media',
      labels: { singular: 'Media', plural: 'Media' },
      admin: { useAsTitle: 'filename', defaultColumns: ['filename'] },
      access: { read: () => true },
      upload: { mimeTypes: ['image/*'], maxFileSize: 5 * 1024 * 1024 },
      fields: [{ name: 'alt', type: 'text', required: true }],
    },
    {
      slug: 'users',
      auth: true,
      access: { read: () => true, create: () => true, update: () => true },
      fields: [
        {
          name: 'roles',
          type: 'select',
          options: ['user', 'admin'],
          hasMany: true,
          defaultValue: ['user'],
          access: {
            create: ({ req }) => Boolean(req.user?.roles?.includes('admin')),
            update: ({ req }) => Boolean(req.user?.roles?.includes('admin')),
          },
        },
      ],
    },
    {
      slug: 'pages',
      labels: { singular: 'Page', plural: 'Pages' },
      admin: { useAsTitle: 'title', defaultColumns: ['title', 'slug', 'status'] },
      access: { read: () => true },
      fields: [
        { name: 'title', type: 'text', required: true, admin: { tab: 'Content' } },
        { name: 'slug', type: 'slug', required: true, unique: true, index: true, admin: { tab: 'Content' } },
        {
          name: 'status',
          type: 'select',
          options: ['draft', 'published'],
          defaultValue: 'draft',
          admin: { position: 'sidebar' },
        },
        {
          name: 'layout',
          type: 'blocks',
          admin: { tab: 'Content', description: 'Compose the page from sections.' },
          blocks: [
            {
              slug: 'hero',
              labels: { singular: 'Hero', plural: 'Heroes' },
              admin: { group: 'Layout', description: 'Full-width banner with a heading.' },
              fields: [
                { name: 'heading', type: 'text', required: true },
                { name: 'subheading', type: 'text' },
              ],
            },
          ],
        },
      ],
    },
    {
      slug: 'articles',
      labels: { singular: 'Article', plural: 'Articles' },
      admin: { useAsTitle: 'title', defaultColumns: ['title'] },
      access: { read: () => true },
      versions: { drafts: true },
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'summary', type: 'text', localized: true },
        { name: 'body', type: 'richText', preset: 'standard' },
      ],
    },
  ],
})
