/**
 * Starter content models for create-kernel.
 *
 * Each model is a PLAIN data description (collections + globals + seed rows + a
 * `view` descriptor for the generic TanStack routes). It is intentionally free of
 * functions so it can be (a) JSON-serialized into the scaffolded `src/server/config.ts`
 * and (b) imported directly by the verify harness to boot the SAME model through a
 * real kernel — the scaffolder and the test consume one source of truth.
 *
 * Honesty note: this is a CURATED, offline set of real models — not a live LLM.
 * `--from-brief` maps keywords to the closest model deterministically (see chooseModel).
 *
 * Zero dependencies (used by the zero-dep scaffolder). No semicolons, 2-space, single quotes.
 */

/**
 * @typedef {Object} StarterModel
 * @property {string} label       Short human name.
 * @property {string} description One-line summary for --help / prompts.
 * @property {string[]} keywords  Brief keywords --from-brief matches against.
 * @property {Object} view        Descriptor the generic routes render against.
 * @property {string} view.primary  Collection slug listed on the home page.
 * @property {string} view.settings Global slug for site name / tagline.
 * @property {string} view.title    Field used as the list/detail title.
 * @property {string} [view.excerpt] Field used as the list/detail summary.
 * @property {string} [view.date]    Date field shown as a timestamp.
 * @property {string} view.slug     Slug field used to route to a detail page.
 * @property {Object[]} collections Collection configs (no access fns; injected on render).
 * @property {Object[]} globals     Global configs (no access fns; injected on render).
 * @property {Object} seed          { [slug]: row[] } seed rows + { _globals: { [slug]: row } }.
 */

const siteSettings = (name, tagline) => ({
  slug: 'site_settings',
  fields: [
    { name: 'site_name', type: 'text', defaultValue: name },
    { name: 'tagline', type: 'text', defaultValue: tagline },
  ],
})

/** @type {Record<string, StarterModel>} */
export const MODELS = {
  blog: {
    label: 'Blog',
    description: 'Posts, authors, categories — the classic editorial model',
    keywords: ['blog', 'post', 'article', 'news', 'editorial', 'writing', 'magazine', 'cms'],
    view: {
      primary: 'posts',
      settings: 'site_settings',
      title: 'title',
      excerpt: 'excerpt',
      date: 'published_at',
      slug: 'slug',
    },
    collections: [
      {
        slug: 'authors',
        admin: { useAsTitle: 'name' },
        fields: [
          { name: 'name', type: 'text', required: true },
          { name: 'bio', type: 'textarea' },
        ],
      },
      {
        slug: 'categories',
        admin: { useAsTitle: 'name' },
        fields: [
          { name: 'name', type: 'text', required: true },
          { name: 'slug', type: 'slug', required: true, unique: true },
        ],
      },
      {
        slug: 'posts',
        admin: { useAsTitle: 'title' },
        fields: [
          { name: 'title', type: 'text', required: true },
          { name: 'slug', type: 'slug', required: true, unique: true, index: true },
          { name: 'excerpt', type: 'textarea' },
          { name: 'body', type: 'textarea' },
          { name: 'status', type: 'select', options: ['draft', 'published'], defaultValue: 'published', index: true },
          { name: 'published_at', type: 'date' },
          { name: 'author', type: 'relationship', relationTo: 'authors' },
          { name: 'categories', type: 'relationship', relationTo: 'categories', hasMany: true },
        ],
      },
    ],
    globals: [siteSettings('The Kernel Blog', 'Built with KernelCMS on TanStack Start')],
    seed: {
      authors: [
        { _ref: 'ada', name: 'Ada Lovelace', bio: 'Wrote the first algorithm intended for a machine.' },
        { _ref: 'grace', name: 'Grace Hopper', bio: 'Pioneered machine-independent programming languages.' },
      ],
      categories: [
        { _ref: 'eng', name: 'Engineering', slug: 'engineering' },
        { _ref: 'product', name: 'Product', slug: 'product' },
      ],
      posts: [
        {
          title: 'Hello from KernelCMS on TanStack Start',
          slug: 'hello-kernelcms',
          excerpt: 'Server-rendered by TanStack Start, content read from the KernelCMS Local API — no HTTP round-trip.',
          body: 'Everything you see flows from a single config.ts. The same operations are also a REST + typed RPC API.',
          status: 'published',
          published_at: '2026-01-03',
          author: '@ada',
          categories: ['@eng'],
        },
        {
          title: 'Choose Everything: The Adapter Pattern',
          slug: 'choose-everything',
          excerpt: 'Database, storage, auth, search — every infrastructure concern is a swappable adapter.',
          body: 'The core never imports a driver. The same content config runs on Postgres, SQLite, or MongoDB.',
          status: 'published',
          published_at: '2026-01-02',
          author: '@ada',
          categories: ['@eng', '@product'],
        },
        {
          title: 'Type-safe content, end to end',
          slug: 'type-safe-content',
          excerpt: 'Model content as code and get generated TypeScript types and a typed client for free.',
          body: 'Define a collection once and get migrations, validation, access control, and types your frontend imports.',
          status: 'published',
          published_at: '2026-01-01',
          author: '@grace',
          categories: ['@product'],
        },
      ],
      _globals: { site_settings: { site_name: 'The Kernel Blog', tagline: 'Built with KernelCMS on TanStack Start' } },
    },
  },

  shop: {
    label: 'Shop',
    description: 'Products, collections, orders — a small commerce catalog',
    keywords: ['shop', 'store', 'commerce', 'ecommerce', 'product', 'catalog', 'order', 'cart', 'retail', 'sell'],
    view: {
      primary: 'products',
      settings: 'site_settings',
      title: 'title',
      excerpt: 'description',
      date: 'created_at',
      slug: 'slug',
    },
    collections: [
      {
        slug: 'product_collections',
        labels: { singular: 'Collection', plural: 'Collections' },
        admin: { useAsTitle: 'name' },
        fields: [
          { name: 'name', type: 'text', required: true },
          { name: 'slug', type: 'slug', required: true, unique: true },
          { name: 'description', type: 'textarea' },
        ],
      },
      {
        slug: 'products',
        admin: { useAsTitle: 'title' },
        fields: [
          { name: 'title', type: 'text', required: true },
          { name: 'slug', type: 'slug', required: true, unique: true, index: true },
          { name: 'description', type: 'textarea' },
          { name: 'price_cents', type: 'number', required: true, integer: true, min: 0 },
          { name: 'currency', type: 'select', options: ['USD', 'EUR', 'GBP'], defaultValue: 'USD' },
          { name: 'sku', type: 'text', unique: true },
          { name: 'stock', type: 'number', integer: true, min: 0, defaultValue: 0 },
          {
            name: 'status',
            type: 'select',
            options: ['draft', 'active', 'archived'],
            defaultValue: 'active',
            index: true,
          },
          { name: 'collection', type: 'relationship', relationTo: 'product_collections' },
          { name: 'created_at', type: 'date' },
        ],
      },
      {
        slug: 'orders',
        admin: { useAsTitle: 'reference' },
        fields: [
          { name: 'reference', type: 'text', required: true, unique: true, index: true },
          { name: 'email', type: 'email', required: true },
          {
            name: 'status',
            type: 'select',
            options: ['pending', 'paid', 'shipped', 'cancelled'],
            defaultValue: 'pending',
            index: true,
          },
          { name: 'total_cents', type: 'number', required: true, integer: true, min: 0 },
          { name: 'product', type: 'relationship', relationTo: 'products' },
          { name: 'quantity', type: 'number', integer: true, min: 1, defaultValue: 1 },
          { name: 'placed_at', type: 'date' },
        ],
      },
    ],
    globals: [siteSettings('Kernel Goods', 'A tiny shop powered by KernelCMS')],
    seed: {
      product_collections: [
        { _ref: 'apparel', name: 'Apparel', slug: 'apparel', description: 'Wearable Kernel merch.' },
        { _ref: 'desk', name: 'Desk', slug: 'desk', description: 'Things for your workspace.' },
      ],
      products: [
        {
          _ref: 'tee',
          title: 'Kernel Tee',
          slug: 'kernel-tee',
          description: 'Soft cotton tee with the Kernel mark.',
          price_cents: 2400,
          currency: 'USD',
          sku: 'TEE-001',
          stock: 120,
          status: 'active',
          collection: '@apparel',
          created_at: '2026-01-02',
        },
        {
          title: 'Adapter Mug',
          slug: 'adapter-mug',
          description: '12oz mug. Swappable handle not included.',
          price_cents: 1600,
          currency: 'USD',
          sku: 'MUG-001',
          stock: 80,
          status: 'active',
          collection: '@desk',
          created_at: '2026-01-01',
        },
      ],
      orders: [
        {
          reference: 'ORD-1001',
          email: 'buyer@example.com',
          status: 'paid',
          total_cents: 2400,
          product: '@tee',
          quantity: 1,
          placed_at: '2026-01-03',
        },
      ],
      _globals: { site_settings: { site_name: 'Kernel Goods', tagline: 'A tiny shop powered by KernelCMS' } },
    },
  },

  docs: {
    label: 'Docs',
    description: 'Documentation pages with sections and ordered navigation',
    keywords: ['docs', 'documentation', 'guide', 'manual', 'handbook', 'wiki', 'knowledge', 'reference', 'help'],
    view: {
      primary: 'doc_pages',
      settings: 'site_settings',
      title: 'title',
      excerpt: 'summary',
      date: 'updated_at',
      slug: 'slug',
    },
    collections: [
      {
        slug: 'doc_sections',
        labels: { singular: 'Section', plural: 'Sections' },
        admin: { useAsTitle: 'name' },
        fields: [
          { name: 'name', type: 'text', required: true },
          { name: 'slug', type: 'slug', required: true, unique: true },
          { name: 'order', type: 'number', integer: true, defaultValue: 0 },
        ],
      },
      {
        slug: 'doc_pages',
        labels: { singular: 'Page', plural: 'Pages' },
        admin: { useAsTitle: 'title' },
        fields: [
          { name: 'title', type: 'text', required: true },
          { name: 'slug', type: 'slug', required: true, unique: true, index: true },
          { name: 'summary', type: 'textarea' },
          { name: 'body', type: 'richText' },
          { name: 'section', type: 'relationship', relationTo: 'doc_sections' },
          { name: 'order', type: 'number', integer: true, defaultValue: 0 },
          { name: 'status', type: 'select', options: ['draft', 'published'], defaultValue: 'published', index: true },
          { name: 'updated_at', type: 'date' },
        ],
      },
    ],
    globals: [siteSettings('Kernel Docs', 'Documentation, built with KernelCMS')],
    seed: {
      doc_sections: [
        { _ref: 'start', name: 'Getting Started', slug: 'getting-started', order: 0 },
        { _ref: 'guides', name: 'Guides', slug: 'guides', order: 1 },
      ],
      doc_pages: [
        {
          title: 'Introduction',
          slug: 'introduction',
          summary: 'What KernelCMS is and why it exists.',
          section: '@start',
          order: 0,
          status: 'published',
          updated_at: '2026-01-03',
        },
        {
          title: 'Installation',
          slug: 'installation',
          summary: 'Scaffold a project in minutes with create-kernel.',
          section: '@start',
          order: 1,
          status: 'published',
          updated_at: '2026-01-02',
        },
        {
          title: 'Modeling content',
          slug: 'modeling-content',
          summary: 'Collections, fields, relationships, and the page builder.',
          section: '@guides',
          order: 0,
          status: 'published',
          updated_at: '2026-01-01',
        },
      ],
      _globals: { site_settings: { site_name: 'Kernel Docs', tagline: 'Documentation, built with KernelCMS' } },
    },
  },

  portfolio: {
    label: 'Portfolio',
    description: 'Projects and an about page — a personal/agency site',
    keywords: ['portfolio', 'project', 'showcase', 'agency', 'personal', 'work', 'case study', 'studio', 'design'],
    view: {
      primary: 'projects',
      settings: 'site_settings',
      title: 'title',
      excerpt: 'summary',
      date: 'completed_at',
      slug: 'slug',
    },
    collections: [
      {
        slug: 'projects',
        admin: { useAsTitle: 'title' },
        fields: [
          { name: 'title', type: 'text', required: true },
          { name: 'slug', type: 'slug', required: true, unique: true, index: true },
          { name: 'summary', type: 'textarea' },
          { name: 'role', type: 'text' },
          { name: 'client', type: 'text' },
          { name: 'url', type: 'text' },
          { name: 'tags', type: 'select', options: ['web', 'mobile', 'design', 'branding', 'infra'], hasMany: true },
          { name: 'featured', type: 'boolean', defaultValue: false, index: true },
          { name: 'completed_at', type: 'date' },
        ],
      },
    ],
    globals: [
      siteSettings('Kernel Studio', 'Selected work, built with KernelCMS'),
      {
        slug: 'about',
        fields: [
          { name: 'headline', type: 'text', defaultValue: 'We build things on the web.' },
          { name: 'body', type: 'textarea' },
          { name: 'email', type: 'email' },
        ],
      },
    ],
    seed: {
      projects: [
        {
          title: 'Atlas Redesign',
          slug: 'atlas-redesign',
          summary: 'A ground-up rebuild of a logistics dashboard.',
          role: 'Lead Engineer',
          client: 'Atlas Freight',
          url: 'https://example.com/atlas',
          tags: ['web', 'design'],
          featured: true,
          completed_at: '2026-01-02',
        },
        {
          title: 'Beacon Mobile',
          slug: 'beacon-mobile',
          summary: 'A cross-platform companion app.',
          role: 'Engineer',
          client: 'Beacon',
          url: 'https://example.com/beacon',
          tags: ['mobile'],
          featured: false,
          completed_at: '2026-01-01',
        },
      ],
      _globals: {
        site_settings: { site_name: 'Kernel Studio', tagline: 'Selected work, built with KernelCMS' },
        about: {
          headline: 'We build things on the web.',
          body: 'A small studio shipping fast, durable software.',
          email: 'hello@example.com',
        },
      },
    },
  },
}

export const DEFAULT_MODEL = 'blog'

/** Deterministic, OFFLINE brief → model mapping. Scores each model by how many of
 *  its keywords appear in the brief; ties break toward the default. NOT an LLM. */
export function chooseModel(brief) {
  if (!brief) return DEFAULT_MODEL
  const text = String(brief).toLowerCase()
  let best = DEFAULT_MODEL
  let bestScore = 0
  for (const [name, model] of Object.entries(MODELS)) {
    let score = 0
    for (const kw of model.keywords) if (text.includes(kw)) score++
    if (score > bestScore) {
      bestScore = score
      best = name
    }
  }
  return best
}

export function modelNames() {
  return Object.keys(MODELS)
}

// ---------------------------------------------------------------------------
// Shared seed semantics (one source of truth for both the rendered config.ts and
// the verify harness). A seed row may carry:
//   - `_ref`: register this row's created id under that key for later references.
//   - `'@ref'` string values: resolved to a previously-registered created id.
//   - date fields ending in `_at`: passed through as-is (ISO date strings).
// Collections are created in declaration order, so referenced rows exist first.
// ---------------------------------------------------------------------------

/** Strip the seed-only `_ref` marker and resolve any `@ref` placeholders against
 *  the id map. Returns a clean data row ready for `kernel.create`. */
function resolveRow(row, refs) {
  const out = {}
  for (const [key, value] of Object.entries(row)) {
    if (key === '_ref') continue
    if (typeof value === 'string' && value.startsWith('@')) out[key] = refs[value.slice(1)]
    else if (Array.isArray(value))
      out[key] = value.map((v) => (typeof v === 'string' && v.startsWith('@') ? refs[v.slice(1)] : v))
    else out[key] = value
  }
  return out
}

/** Run a model's seed against a booted kernel. Idempotent at the call site (the
 *  caller gates on an empty primary collection). Shared by the test + the scaffold. */
export async function runSeed(kernel, model) {
  const sys = { overrideAccess: true }
  const refs = {}
  const seed = model.seed || {}
  for (const collection of model.collections) {
    const rows = seed[collection.slug] || []
    for (const row of rows) {
      const created = await kernel.create({ collection: collection.slug, data: resolveRow(row, refs), ...sys })
      if (row._ref) refs[row._ref] = created.id
    }
  }
  const globals = seed._globals || {}
  for (const slug of Object.keys(globals)) {
    await kernel.updateGlobal({ slug, data: globals[slug], ...sys })
  }
}

/** Build a live runtime model (collections/globals with open read access + a seed
 *  closure) for the verify harness, mirroring exactly what the scaffold renders. */
export function buildRuntime(model) {
  const open = { read: () => true }
  const collections = model.collections.map((c) => ({ ...c, access: { ...open } }))
  const globals = model.globals.map((g) => ({ ...g, access: { ...open } }))
  return { collections, globals, view: model.view, seed: (kernel) => runSeed(kernel, model) }
}

// ---------------------------------------------------------------------------
// Render a standalone `src/server/config.ts` for a model. The output imports only
// the vendored engine (`@kernel/core`, `@kernel/db-sqlite`) — never this module —
// and inlines an idempotent seed using the SAME @ref semantics as runSeed.
// ---------------------------------------------------------------------------

/** Pretty-print a value as TS source (objects/arrays multi-line, 2-space indent). */
function lit(value, indent = '') {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const inner = indent + '  '
    const items = value.map((v) => inner + lit(v, inner)).join(',\n')
    return `[\n${items},\n${indent}]`
  }
  const inner = indent + '  '
  const entries = Object.entries(value)
  if (entries.length === 0) return '{}'
  const body = entries.map(([k, v]) => `${inner}${k}: ${lit(v, inner)}`).join(',\n')
  return `{\n${body},\n${indent}}`
}

/** Render a collection with an injected open `read` access rule. */
function renderCollection(collection) {
  const rest = { ...collection }
  const fields = rest.fields
  delete rest.fields
  const head = Object.entries(rest)
    .map(([k, v]) => `      ${k}: ${lit(v, '      ')},`)
    .join('\n')
  return `    {
${head}
      access: { read: () => true },
      fields: ${lit(fields, '      ')},
    },`
}

function renderGlobal(global) {
  const rest = { ...global }
  const fields = rest.fields
  delete rest.fields
  const head = Object.entries(rest)
    .map(([k, v]) => `      ${k}: ${lit(v, '      ')},`)
    .join('\n')
  return `    {
${head}
      access: { read: () => true },
      fields: ${lit(fields, '      ')},
    },`
}

/** The full `src/server/config.ts` source for a model. */
export function renderConfigModule(model, modelName) {
  const collections = model.collections.map(renderCollection).join('\n')
  const globals = model.globals.map(renderGlobal).join('\n')
  const seedData = lit(model.seed || {}, '  ')
  const view = lit(model.view, '  ')

  return `import { defineConfig } from '@kernel/core'
import type { Kernel } from '@kernel/core'
import { sqliteAdapter } from '@kernel/db-sqlite'

/**
 * Content model: ${model.label} (${modelName}).
 * ${model.description}
 *
 * Generated by create-kernel. Edit freely — add a field, delete kernelcms.db,
 * restart, and the migration is generated automatically.
 */
export const config = defineConfig({
  secret: process.env.KERNEL_SECRET ?? 'start-dev-secret',
  db: sqliteAdapter({ url: process.env.KERNEL_DB_URL ?? 'file:./kernelcms.db' }),
  collections: [
${collections}
  ],
  globals: [
${globals}
  ],
})

/** Drives the generic home + detail routes (which field is the title, etc.). */
export const view = ${view} as const

/** Seed rows for first boot. \`@ref\` values resolve to ids created earlier in the run. */
const seedData: Record<string, any> = ${seedData}

function resolveRow(row: Record<string, any>, refs: Record<string, string>): Record<string, any> {
  const out: Record<string, any> = {}
  for (const [key, value] of Object.entries(row)) {
    if (key === '_ref') continue
    if (typeof value === 'string' && value.startsWith('@')) out[key] = refs[value.slice(1)]
    else if (Array.isArray(value))
      out[key] = value.map((v) => (typeof v === 'string' && v.startsWith('@') ? refs[v.slice(1)] : v))
    else out[key] = value
  }
  return out
}

/** Idempotent seed run once on first boot. */
export async function seed(kernel: Kernel): Promise<void> {
  const sys = { overrideAccess: true } as const
  const refs: Record<string, string> = {}
  for (const collection of config.collections) {
    const rows: Record<string, any>[] = seedData[collection.slug] ?? []
    for (const row of rows) {
      const created = await kernel.create({ collection: collection.slug, data: resolveRow(row, refs), ...sys })
      if (row._ref) refs[row._ref] = created.id
    }
  }
  const globals: Record<string, Record<string, any>> = seedData._globals ?? {}
  for (const slug of Object.keys(globals)) {
    await kernel.updateGlobal({ slug, data: globals[slug], ...sys })
  }
}
`
}
