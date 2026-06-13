import { defineConfig, memorySearch } from '@kernel/core'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { localStorage } from '@kernel/storage'

// Deterministic, dependency-free embedder for the E2E demo: bag-of-words hashed
// into a fixed 64-dim vector. Topically-overlapping text shares dimensions, so
// cosine similarity ranks related content together — enough to exercise the real
// semantic/hybrid pipeline end-to-end over HTTP (a production app plugs in a real
// embedding provider here: OpenAI, Cohere, a local model, etc.).
const DIM = 64
function demoEmbed(texts: string[]): Promise<number[][]> {
  return Promise.resolve(
    texts.map((text) => {
      const v = new Array(DIM).fill(0)
      for (const tokenRaw of text.toLowerCase().split(/[^a-z0-9]+/)) {
        if (tokenRaw.length < 2) continue
        let h = 0
        for (let i = 0; i < tokenRaw.length; i++) h = (h * 31 + tokenRaw.charCodeAt(i)) >>> 0
        v[h % DIM] += 1
      }
      return v
    }),
  )
}

// Isolated E2E fixture: fresh in-memory DB each boot, built-in preview renderer
// (no external frontend needed). Mirrors the demo content model.
export default defineConfig({
  secret: 'e2e-secret',
  db: sqliteAdapter({ url: ':memory:' }),
  storage: localStorage({ rootDir: './.e2e-uploads', servePath: '/files' }),
  localization: { locales: ['en', 'es'], defaultLocale: 'en' },
  // Agentic workflow demo: a scoped, draft-only agent runs an autonomous step.
  agents: [{ id: 'demo-bot', token: 'demo-bot-token', roles: ['editor'], fieldScope: { allow: ['title', 'summary'] } }],
  workflows: [
    {
      slug: 'draft_welcome',
      agent: 'demo-bot',
      trigger: { on: 'manual' },
      steps: [
        {
          name: 'draft-article',
          async run(ctx) {
            await ctx.kernel.create({
              collection: 'articles',
              data: { title: 'Workflow draft', summary: 'made by an agent step' },
            })
          },
        },
      ],
    },
  ],
  // RAG-native: full-text adapter + a pluggable embedder power /semantic + /hybrid.
  search: memorySearch(),
  embeddings: { embed: demoEmbed, dimensions: DIM },
  // AI discoverability (GEO): /api/llms.txt, /api/llms-full.txt, /geo — public,
  // published-only. Exposes articles for AI answer engines to ingest + cite.
  discoverability: {
    title: 'KernelCMS Demo',
    description: 'Demo content served for AI discoverability tests.',
    baseUrl: 'http://localhost:3100',
    collections: [{ slug: 'articles', titleField: 'title', descriptionField: 'summary', urlPattern: '/articles/:id' }],
  },
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
      access: { read: () => true, create: ({ req }) => Boolean(req.user), update: ({ req }) => Boolean(req.user) },
      versions: { drafts: true },
      // Semantic + hybrid search index the title + summary on every write.
      search: { fields: ['title', 'summary'], semantic: true },
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'summary', type: 'text', localized: true },
        { name: 'body', type: 'richText', preset: 'standard' },
      ],
    },
  ],
})
