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
  // Field-level encryption at rest: the key that transparently encrypts `encrypted` fields.
  encryption: { key: 'e2e-field-encryption-key-32-chars!!' },
  db: sqliteAdapter({ url: ':memory:' }),
  storage: localStorage({ rootDir: './.e2e-uploads', servePath: '/files' }),
  localization: { locales: ['en', 'es'], defaultLocale: 'en' },
  // AI translation: a deterministic demo provider (a real app plugs in DeepL/OpenAI).
  translation: { translate: ({ texts, to }) => Promise.resolve(texts.map((t) => `[${to}] ${t}`)) },
  // Personalization + A/B: audience-targeted content variants + deterministic bucketing.
  audiences: { segments: ['default', 'vip'], default: 'default' },
  experiments: [{ slug: 'hero', variants: ['default', 'vip'] }],
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
  // Multi-tenancy: auto-scope the `notes` collection by the caller's `user.tenant`.
  tenancy: { field: 'tenant', collections: ['notes'] },
  // Content templates: pre-filled document skeletons for a "New from template" flow.
  templates: [
    {
      slug: 'article_starter',
      collection: 'articles',
      name: 'Article starter',
      data: { title: 'Untitled article', summary: 'Start writing…' },
    },
  ],
  // Audit log: append-only record of writes — also feeds the per-document activity timeline.
  audit: true,
  // Editorial comments: threaded review annotations on documents, gated by doc read access.
  comments: true,
  // Saved views / smart collections: named query presets (where+sort) per collection.
  views: true,
  // Outbound webhooks: a DURABLE endpoint — content writes enqueue to the `_webhook_deliveries`
  // outbox (delivered by the `processWebhooks` cron drain with retry). The loopback target opts
  // through the SSRF guard via `allowPrivateNetwork` (a dev/test affordance).
  webhooks: [
    {
      slug: 'demo_sink',
      url: 'http://127.0.0.1:3199/sink',
      secret: 'demo-webhook-secret',
      collections: ['articles'],
      durable: true,
      allowPrivateNetwork: true,
    },
    {
      // Subscription-only delivery target: `collections: []` means it never fires on a content
      // write (no double-send) — only saved-search alerts enqueue to it.
      slug: 'alerts',
      url: 'http://127.0.0.1:3199/alerts',
      collections: [],
      allowPrivateNetwork: true,
    },
  ],
  // Saved-search alerts: subscribe to a query; matches deliver via the `alerts` webhook.
  subscriptions: true,
  // Content releases: stage drafts into a named bundle and publish them atomically.
  releases: true,
  // Content lifecycle: articles auto-archive when their expire_at passes (cron-driven).
  lifecycle: { collections: [{ slug: 'articles', expireField: 'expire_at', onExpire: 'archive' }] },
  // Content analytics: capture views/searches/AI-retrievals → aggregate insights (no PII).
  analytics: { enabled: true, autoCapture: true },
  // Real-time: a durable change feed (CDC) + live SSE stream for reactive UIs/agents.
  realtime: { enabled: true },
  // Edge delivery: surrogate cache tags on public reads + a change-driven purge feed.
  edge: { enabled: true, cacheControl: 'public, s-maxage=600, stale-while-revalidate=60' },
  // Structured data: schema.org JSON-LD generated from the typed model for SEO + AI.
  structuredData: {
    baseUrl: 'http://localhost:3100',
    collections: [{ slug: 'articles', type: 'Article', urlPattern: '/articles/:id' }],
  },
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
      // Field-level encryption: `secret` is stored as AES-256-GCM ciphertext at rest and
      // decrypted on read; it can't be filtered/sorted on (opaque ciphertext).
      slug: 'vault_items',
      access: { read: ({ req }) => Boolean(req.user), create: ({ req }) => Boolean(req.user) },
      fields: [
        { name: 'label', type: 'text' },
        { name: 'secret', type: 'text', encrypted: true },
        { name: 'meta', type: 'json', encrypted: true },
      ],
    },
    {
      // Private uploads: only an authenticated user can read the doc (and thus the file via
      // the session path). A signed capability URL fetches it without a session until expiry.
      slug: 'secure_media',
      access: { read: ({ req }) => Boolean(req.user), create: ({ req }) => Boolean(req.user) },
      upload: { mimeTypes: ['image/*', 'text/*'], maxFileSize: 5 * 1024 * 1024 },
      fields: [{ name: 'alt', type: 'text' }],
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
        // The tenant claim — flows into req.user.tenant on auth and scopes `notes`.
        { name: 'tenant', type: 'text' },
      ],
    },
    {
      // Tenant-scoped: each tenant only ever sees/touches their own notes.
      slug: 'notes',
      access: {
        read: () => true,
        create: ({ req }) => Boolean(req.user),
        update: ({ req }) => Boolean(req.user),
        delete: ({ req }) => Boolean(req.user),
      },
      fields: [{ name: 'body', type: 'text' }],
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
        { name: 'tagline', type: 'text', personalized: true },
        { name: 'body', type: 'richText', preset: 'standard' },
        // Self-relationship so the knowledge graph has edges to traverse.
        { name: 'related', type: 'relationship', relationTo: 'articles', hasMany: true },
        // Lifecycle: when this passes, the article auto-archives on the next cron drain.
        { name: 'expire_at', type: 'date' },
      ],
    },
  ],
})
