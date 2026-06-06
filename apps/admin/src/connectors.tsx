// Connectors: a Coolify-style catalog of the databases, storage, email, auth, and
// cache providers KernelCMS can wire up. Each connector is a clean on/off switch.
// Flip it on and the minimal field(s) appear; everything else (run-it-locally, the
// kernel.config.ts snippet, the .env template, and an AI prompt) tucks behind a
// small "Manual setup" disclosure so cards stay short. Used in the first-run wizard
// and in the Connectors panel.
import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { EASE_OUT, itemVariants, listContainer } from './motion'

// ── status ──────────────────────────────────────────────────────────────────

/** Normalized connector status, derived from either the first-run runtime or the
 *  authenticated `/_admin/connectors` response. */
export interface ConnectorState {
  db: string
  storage: boolean
  email: boolean
  oauth: string[]
  image: boolean
}

type CardState = 'connected' | 'available'

// ── brand logos ───────────────────────────────────────────────────────────────
// Full-colour marks so the catalog reads like a real provider grid. Each sits on a
// neutral chip (.cx-tile) and carries its own brand colours.

function Tile({ children }: { children: React.ReactNode }) {
  return <span className="cx-tile">{children}</span>
}

const PostgresLogo = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden>
    {/* ears */}
    <ellipse cx="6.7" cy="9.6" rx="3" ry="3.9" fill="#336791" />
    <ellipse cx="17.3" cy="9.6" rx="3" ry="3.9" fill="#336791" />
    {/* head + trunk */}
    <path
      fill="#336791"
      d="M12 5.4c-3.1 0-5.6 2.3-5.6 5.2 0 2 1.1 3.7 2.8 4.6v2.4c0 .8.6 1.5 1.4 1.5.8 0 1.4-.7 1.4-1.5 0-.5.4-1 1-1s1 .5 1 1v.2c0 .8.6 1.5 1.4 1.5.8 0 1.4-.7 1.4-1.5v-2.6c1.5-1 2.4-2.6 2.4-4.5 0-2.9-2.5-5.2-5.6-5.2z"
    />
    {/* eyes */}
    <circle cx="10" cy="10.1" r="0.95" fill="#fff" />
    <circle cx="14" cy="10.1" r="0.95" fill="#fff" />
  </svg>
)

const MysqlLogo = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden>
    {/* leaping dolphin body */}
    <path
      fill="#00758F"
      d="M2.4 16.4c3 .5 5.3-.3 7-2.1 1-1.1 1.8-2.5 3.2-3.3 1.7-1 3.7-1.1 5.4-.4-.9.1-1.6.6-2 1.4.8-.1 1.5.2 2 .8-1.6-.3-2.8.4-3.8 1.5-1.5 1.6-3.1 3.1-5.7 3.4-2.4.3-4.6-.3-6.3-1.3z"
    />
    {/* dorsal fin */}
    <path fill="#00758F" d="M11.2 10.6c.6-1.4 1.8-2.6 3.4-3.1-.5 1-.7 2-.6 3-.9-.1-1.9 0-2.8.1z" />
    {/* tail */}
    <path fill="#F29111" d="M19.4 11.7c1.1.2 2 .9 2.6 1.9-1-.4-1.8-.3-2.5.2.1-.8 0-1.5-.1-2.1z" />
    <circle cx="5.9" cy="14.2" r="0.8" fill="#fff" />
  </svg>
)

const MongoLogo = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M12 2.5c1 2.1 6.2 5.3 6.2 11 0 4.2-2.8 6.7-5.2 7.6V2.5z" fill="#00684A" />
    <path d="M12 2.5c-1 2.1-6.2 5.3-6.2 11 0 4.2 2.8 6.7 5.2 7.6V2.5z" fill="#00ED64" />
    <path d="M12 20.4c0 .7.2 1.7.4 2.6h-.8c.2-.9.4-1.9.4-2.6z" fill="#00684A" />
  </svg>
)

const RedisLogo = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M12 14.6 2.6 11l9.4-3.6L21.4 11 12 14.6z" fill="#FF4438" />
    <path d="M2.6 14.3 12 17.9l9.4-3.6v2.6L12 20.5l-9.4-3.6v-2.6z" fill="#A41E11" />
    <path d="M2.6 7.7 12 4.1l9.4 3.6L12 11.3 2.6 7.7z" fill="#FF4438" opacity="0.55" />
  </svg>
)

const SqliteLogo = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
    <ellipse cx="12" cy="5.5" rx="6.5" ry="2.6" stroke="#0F80CC" strokeWidth="1.7" />
    <path d="M5.5 5.5v13c0 1.4 2.9 2.6 6.5 2.6s6.5-1.2 6.5-2.6v-13" stroke="#0F80CC" strokeWidth="1.7" />
    <path d="M5.5 12c0 1.4 2.9 2.6 6.5 2.6s6.5-1.2 6.5-2.6" stroke="#0F80CC" strokeWidth="1.7" />
  </svg>
)

const StorageLogo = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
    <path
      d="M5 7.5 6.3 19a2 2 0 0 0 2 1.8h7.4a2 2 0 0 0 2-1.8L19 7.5"
      stroke="#F38020"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path d="M3.4 7.5h17.2" stroke="#F38020" strokeWidth="1.7" strokeLinecap="round" />
    <path
      d="M9 7.5V6a3 3 0 0 1 6 0v1.5"
      stroke="#F38020"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

const MailLogo = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
    <rect x="3" y="5" width="18" height="14" rx="2.5" stroke="#6366F1" strokeWidth="1.7" />
    <path d="m3.6 7 8.4 6 8.4-6" stroke="#6366F1" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const GoogleLogo = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden>
    <path
      fill="#4285F4"
      d="M23.52 12.273c0-.851-.076-1.67-.218-2.455H12v4.642h6.458a5.52 5.52 0 0 1-2.394 3.622v3.01h3.878c2.27-2.09 3.578-5.17 3.578-8.819z"
    />
    <path
      fill="#34A853"
      d="M12 24c3.24 0 5.956-1.075 7.942-2.908l-3.878-3.01c-1.075.72-2.45 1.146-4.064 1.146-3.125 0-5.77-2.11-6.714-4.944H1.276v3.106A11.997 11.997 0 0 0 12 24z"
    />
    <path
      fill="#FBBC05"
      d="M5.286 14.284A7.2 7.2 0 0 1 4.91 12c0-.792.137-1.562.376-2.284V6.61H1.276A11.997 11.997 0 0 0 0 12c0 1.936.464 3.768 1.276 5.39l4.01-3.106z"
    />
    <path
      fill="#EA4335"
      d="M12 4.772c1.762 0 3.345.606 4.59 1.795l3.44-3.44C17.952 1.19 15.236 0 12 0A11.997 11.997 0 0 0 1.276 6.61l4.01 3.106C6.23 6.882 8.875 4.772 12 4.772z"
    />
  </svg>
)

const GithubLogo = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden>
    <path
      fill="currentColor"
      fillRule="evenodd"
      clipRule="evenodd"
      d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.438 9.8 8.205 11.387.6.113.82-.26.82-.577 0-.285-.01-1.04-.016-2.04-3.338.726-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.09-.745.083-.73.083-.73 1.205.085 1.84 1.237 1.84 1.237 1.07 1.835 2.807 1.305 3.492.998.108-.776.42-1.305.762-1.605-2.665-.303-5.467-1.332-5.467-5.93 0-1.31.468-2.382 1.236-3.222-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.3 1.23A11.5 11.5 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.29-1.552 3.297-1.23 3.297-1.23.653 1.652.242 2.873.118 3.176.77.84 1.235 1.912 1.235 3.222 0 4.61-2.807 5.625-5.48 5.922.432.372.816 1.102.816 2.222 0 1.605-.015 2.898-.015 3.293 0 .322.216.697.825.578C20.565 21.796 24 17.297 24 12 24 5.37 18.627 0 12 0z"
    />
  </svg>
)

const WandLogo = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M5 19 16 8" stroke="#C8A96A" strokeWidth="1.8" strokeLinecap="round" />
    <path
      d="m14.5 3.5 1.4 1.4M19.5 8.5l1.4 1.4M4 8l1 1M9.5 3.5l1 1"
      stroke="#C8A96A"
      strokeWidth="1.8"
      strokeLinecap="round"
    />
  </svg>
)

// ── catalog ───────────────────────────────────────────────────────────────────

type Category = 'Database' | 'Storage' | 'Email' | 'Authentication' | 'Cache' | 'Migrate'

interface ConnectorDef {
  id: string
  name: string
  category: Category
  Icon: () => JSX.Element
  blurb: string
  state: (s: ConnectorState) => CardState
  /** Built-in adapters apply on restart. Adapter-based ones save the connection but
   *  need a one-time wiring step (shown in Manual setup). */
  requiresAdapter?: boolean
  localNote?: string
  env?: { key: string; example: string }[]
  snippet?: string
  prompt?: string
}

// The single, super-detailed migration prompt the user can hand to their AI.
const MIGRATION_PROMPT = `I have an existing static website (plain HTML/CSS, or a framework export) that I want to migrate into KernelCMS 1:1, keeping its exact look and turning each part of the page into editable content sections.

Context: KernelCMS is a config-as-code headless CMS. Content is modeled in kernel.config.ts as collections with fields. A page is best modeled as a collection with a "blocks" field (a page builder): each block is a reusable section type (hero, features, gallery, faq, cta, richText, …) with its own fields. The frontend renders the blocks array in order.

Please do this step by step and confirm each step before moving on:

1. AUDIT my site. List every distinct visual section (hero, nav, feature grid, testimonials, pricing, FAQ, footer, …) and, for each, the editable fields it contains (headings, body text, images, links, button labels/URLs, list items). Keep the EXACT copy and image references from my current site. Do not rewrite or invent content.

2. DESIGN the content model. Propose a "pages" collection with a "blocks" field whose block types map 1:1 to my sections. Give me the kernel.config.ts for it: snake_case field names, required where appropriate, "richText" for prose, "upload" (with a "media" collection) for images, "relationship" where things link. Do not add sections that aren't on my site.

3. PRESERVE styling exactly. I want pixel-identical output. Generate one frontend component per block type that reproduces my existing HTML/CSS verbatim (copy my classes/markup/styles; do NOT restyle). The CMS only supplies the content; the markup and CSS stay mine. Keep my approach (Tailwind / CSS modules / plain CSS).

4. SEED the content. Convert my current page's actual content into a seed (or import JSON) so the migrated page renders identically on first run. Map every existing string and image into the right block fields.

5. WIRE it up. Show how my frontend fetches the page from KernelCMS (REST: GET /api/pages?where[slug][equals]=home&depth=2, or the typed client) and renders the blocks array in order, picking the component by blockType.

6. VERIFY 1:1. Give me a checklist to diff the migrated page against the original: same sections, same order, same copy, same images, same links, same responsive behavior. Flag anything that can't be represented and propose the closest editable model.

Constraints: keep it editable in small sections (one block = one section), keep my styling untouched, and don't drop or rewrite any of my existing content. Ask me for my current HTML/source whenever you need it.`

const CONNECTORS: ConnectorDef[] = [
  {
    id: 'sqlite',
    name: 'SQLite',
    category: 'Database',
    Icon: SqliteLogo,
    blurb: 'Built-in, zero-config database saved to a local file. Perfect while you build.',
    state: (s) => (s.db === 'sqlite' ? 'connected' : 'available'),
    localNote: 'Already the default. Stored at file:./content.db with no native dependencies.',
    snippet: `import { sqliteAdapter } from 'kernelcms/sqlite'

db: sqliteAdapter({ url: 'file:./content.db' }),`,
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    category: 'Database',
    Icon: PostgresLogo,
    blurb: 'Production-grade SQL database. Recommended when you deploy.',
    state: (s) => (s.db === 'postgres' ? 'connected' : 'available'),
    localNote:
      'Run locally with Docker:\ndocker run --name kernel-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 -d postgres:16\nthen set DATABASE_URL to postgres://postgres:postgres@localhost:5432/postgres',
    env: [{ key: 'DATABASE_URL', example: 'postgres://user:password@host:5432/database' }],
    snippet: `import { postgresAdapter } from 'kernelcms/postgres'

db: postgresAdapter({ url: process.env.DATABASE_URL }),`,
    prompt: `I'm using KernelCMS and want to switch from SQLite to PostgreSQL. Walk me through it: if I don't have a Postgres database, recommend a free one (Neon, Supabase, or local Docker) with click-by-click steps; put the connection string in .env as DATABASE_URL (and gitignore .env); in kernel.config.ts replace the sqlite adapter with postgresAdapter({ url: process.env.DATABASE_URL }) from 'kernelcms/postgres'; then run "npx kernel migrate" and "npx kernel dev".`,
  },
  {
    id: 'mysql',
    name: 'MySQL',
    category: 'Database',
    Icon: MysqlLogo,
    blurb: 'Popular SQL database. Save your connection, then wire the adapter (one-time).',
    state: () => 'available',
    requiresAdapter: true,
    env: [{ key: 'MYSQL_URL', example: 'mysql://user:password@host:3306/database' }],
    localNote:
      'Run locally with Docker:\ndocker run --name kernel-mysql -e MYSQL_ROOT_PASSWORD=mysql -e MYSQL_DATABASE=kernel -p 3306:3306 -d mysql:8',
    prompt: `I'm using KernelCMS, which is adapter-based: databases implement the DatabaseAdapter contract from @kernel/db (init, migrate, find, findByID, create, update, delete, count, health, plus a query AST). I want a MySQL adapter. Study the existing @kernel/db-postgres adapter as a reference and implement an equivalent MySQL adapter (mysql2 driver), keeping identifier quoting and parameterized values, reading the connection from process.env.MYSQL_URL, then wire it into kernel.config.ts as the db.`,
  },
  {
    id: 'mongodb',
    name: 'MongoDB',
    category: 'Database',
    Icon: MongoLogo,
    blurb: 'Document database. Save your connection, then wire the adapter (one-time).',
    state: () => 'available',
    requiresAdapter: true,
    env: [{ key: 'MONGODB_URI', example: 'mongodb+srv://user:password@cluster.mongodb.net/db' }],
    localNote:
      'Run locally with Docker:\ndocker run --name kernel-mongo -p 27017:27017 -d mongo:7\nor create a free cluster at mongodb.com/atlas',
    prompt: `I'm using KernelCMS, which is adapter-based: databases implement the DatabaseAdapter contract from @kernel/db. I want a MongoDB adapter. Map collections to Mongo collections, translate the query AST (where/sort/limit/page) to Mongo queries, and implement migrate as index/collection setup. Read the connection from process.env.MONGODB_URI. Use @kernel/db-postgres as the reference for the contract shape, then wire it into kernel.config.ts.`,
  },
  {
    id: 'redis',
    name: 'Redis',
    category: 'Cache',
    Icon: RedisLogo,
    blurb: 'In-memory store for caching, rate limits, and background job queues.',
    state: () => 'available',
    requiresAdapter: true,
    env: [{ key: 'REDIS_URL', example: 'redis://localhost:6379' }],
    localNote:
      'Run locally with Docker:\ndocker run --name kernel-redis -p 6379:6379 -d redis:7\nor use a managed one (Upstash).',
    snippet: `// Read REDIS_URL in a custom module, job handler, or cache helper.
// Example with ioredis:
// import Redis from 'ioredis'
// const redis = new Redis(process.env.REDIS_URL!)`,
    prompt: `I'm using KernelCMS and want to add Redis for caching and/or a background-job queue. Help me: run Redis locally with Docker (or pick a managed one like Upstash), put REDIS_URL in .env (gitignored), and wire it through a KernelCMS module/job handler using ioredis that reads process.env.REDIS_URL. Show a small cache helper and a queue example.`,
  },
  {
    id: 'object-storage',
    name: 'Object storage (S3 / R2)',
    category: 'Storage',
    Icon: StorageLogo,
    blurb: 'Store uploads in S3, Cloudflare R2, MinIO, or any S3-compatible bucket. Local disk is the default.',
    state: (s) => (s.storage ? 'connected' : 'available'),
    localNote:
      'Local disk is the zero-config default:\nstorage: localStorage({ rootDir: "./uploads", servePath: "/files" })',
    env: [
      { key: 'S3_BUCKET', example: 'my-bucket' },
      { key: 'AWS_REGION', example: 'auto' },
      { key: 'AWS_ACCESS_KEY_ID', example: '••••' },
      { key: 'AWS_SECRET_ACCESS_KEY', example: '••••' },
      { key: 'R2_ENDPOINT', example: 'https://<account-id>.r2.cloudflarestorage.com' },
    ],
    snippet: `import { s3Storage, r2 } from 'kernelcms/storage'

// AWS S3 (credentials from the standard AWS env chain):
storage: s3Storage({ bucket: process.env.S3_BUCKET!, region: process.env.AWS_REGION }),

// or Cloudflare R2:
storage: r2({ bucket: process.env.S3_BUCKET!, endpoint: process.env.R2_ENDPOINT }),`,
    prompt: `I'm using KernelCMS and want uploaded files stored in object storage instead of local disk. I'd like Cloudflare R2 (or AWS S3). Give me click-by-click steps to create a bucket + access keys, put them in .env (gitignored), and configure storage in kernel.config.ts using r2(...) or s3Storage(...) from 'kernelcms/storage', reading creds from process.env.`,
  },
  {
    id: 'email',
    name: 'Email (Resend / HTTP)',
    category: 'Email',
    Icon: MailLogo,
    blurb: 'Send password-reset and verification email through any HTTP provider (Resend by default).',
    state: (s) => (s.email ? 'connected' : 'available'),
    localNote: 'For local dev, a console adapter prints emails to the terminal automatically, with no setup needed.',
    env: [
      { key: 'EMAIL_API_KEY', example: 're_••••' },
      { key: 'EMAIL_FROM', example: 'noreply@yourdomain.com' },
    ],
    snippet: `import { httpEmail } from 'kernelcms'

email: httpEmail({
  apiKey: process.env.EMAIL_API_KEY!,
  from: process.env.EMAIL_FROM ?? 'noreply@example.com',
  // defaults to Resend; pass endpoint/toBody for SendGrid, Postmark, etc.
}),`,
    prompt: `I'm using KernelCMS and want transactional email (password reset, verification). Help me set up Resend (or another provider): create an account + API key, add EMAIL_API_KEY and EMAIL_FROM to .env (gitignored), and configure email: httpEmail({ apiKey, from }) from 'kernelcms' in kernel.config.ts. If I pick a non-Resend provider, set the endpoint and toBody mapping.`,
  },
  {
    id: 'google',
    name: 'Google',
    category: 'Authentication',
    Icon: GoogleLogo,
    blurb: 'Let users sign in with Google (OIDC).',
    state: (s) => (s.oauth.includes('google') ? 'connected' : 'available'),
    env: [
      { key: 'GOOGLE_CLIENT_ID', example: '••••.apps.googleusercontent.com' },
      { key: 'GOOGLE_CLIENT_SECRET', example: '••••' },
    ],
    snippet: `import { googleOAuth } from 'kernelcms'

oauth: [
  googleOAuth({
    clientId: process.env.GOOGLE_CLIENT_ID!,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
  }),
],`,
    prompt: `I'm using KernelCMS and want Google sign-in. Walk me through creating an OAuth 2.0 client in Google Cloud (authorized redirect URI for my KernelCMS server), put GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env, and add googleOAuth({ clientId, clientSecret }) from 'kernelcms' to the oauth array in kernel.config.ts.`,
  },
  {
    id: 'github',
    name: 'GitHub',
    category: 'Authentication',
    Icon: GithubLogo,
    blurb: 'Let users sign in with GitHub.',
    state: (s) => (s.oauth.includes('github') ? 'connected' : 'available'),
    env: [
      { key: 'GITHUB_CLIENT_ID', example: 'Iv1.••••' },
      { key: 'GITHUB_CLIENT_SECRET', example: '••••' },
    ],
    snippet: `import { githubOAuth } from 'kernelcms'

oauth: [
  githubOAuth({
    clientId: process.env.GITHUB_CLIENT_ID!,
    clientSecret: process.env.GITHUB_CLIENT_SECRET!,
  }),
],`,
    prompt: `I'm using KernelCMS and want GitHub sign-in. Walk me through registering a GitHub OAuth App (callback URL for my KernelCMS server), put GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET in .env, and add githubOAuth({ clientId, clientSecret }) from 'kernelcms' to the oauth array in kernel.config.ts.`,
  },
  {
    id: 'migrate-static',
    name: 'Migrate an existing site',
    category: 'Migrate',
    Icon: WandLogo,
    blurb: 'Turn a static website into editable sections, 1:1, keeping its exact styling.',
    state: () => 'available',
    prompt: MIGRATION_PROMPT,
  },
]

const CATEGORY_ORDER: Category[] = ['Database', 'Cache', 'Storage', 'Email', 'Authentication', 'Migrate']
const CATEGORY_LABEL: Record<Category, string> = {
  Database: 'database',
  Cache: 'cache',
  Storage: 'storage',
  Email: 'email provider',
  Authentication: 'sign-in provider',
  Migrate: 'tool',
}

// ── components ────────────────────────────────────────────────────────────────

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      setCopied(false)
    }
  }
  return (
    <button type="button" className={`wz-copy${copied ? ' copied' : ''}`} onClick={copy} aria-live="polite">
      {copied ? 'Copied ✓' : label}
    </button>
  )
}

function Switch({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean
  disabled?: boolean
  label: string
  onChange: (next: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`cx-switch${checked ? ' on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="cx-knob" aria-hidden />
    </button>
  )
}

const Chevron = () => (
  <span className="cx-chev" aria-hidden>
    ›
  </span>
)

function ManualSetup({ c, envBlock }: { c: ConnectorDef; envBlock?: string }) {
  return (
    <div className="cx-manual-body">
      {c.localNote && (
        <div className="cx-section">
          <p className="cx-section-title">Run locally</p>
          <pre className="wz-code">{c.localNote}</pre>
        </div>
      )}
      {envBlock && (
        <div className="cx-section">
          <p className="cx-section-title">Add to your .env</p>
          <pre className="wz-code">{envBlock}</pre>
          <CopyButton text={envBlock} label="Copy .env" />
        </div>
      )}
      {c.snippet && (
        <div className="cx-section">
          <p className="cx-section-title">kernel.config.ts</p>
          <pre className="wz-code">{c.snippet}</pre>
          <CopyButton text={c.snippet} label="Copy config" />
        </div>
      )}
      {c.prompt && (
        <div className="cx-section">
          <p className="cx-section-title">Or let your AI assistant do it</p>
          <pre className="wz-code">{c.prompt}</pre>
          <CopyButton text={c.prompt} label="Copy prompt" />
        </div>
      )}
    </div>
  )
}

function ConnectorCard({
  c,
  status,
  setupMode,
  onApply,
}: {
  c: ConnectorDef
  status: ConnectorState
  setupMode?: boolean
  onApply?: (values: Record<string, string>) => Promise<void>
}) {
  const state = c.state(status)
  const connected = state === 'connected'
  const isMigrate = c.category === 'Migrate'
  const toggleable = !isMigrate
  const envBlock = c.env?.map((e) => `${e.key}=${e.example}`).join('\n')
  const hasManual = Boolean(c.localNote || envBlock || c.snippet || c.prompt)
  // During first-run, connectors with env vars can be configured right here: the
  // values are written to the project .env and applied (or wired) on next start.
  const canApply = Boolean(setupMode && onApply && c.env && c.env.length > 0)

  const [expanded, setExpanded] = useState(false)
  const [enabled, setEnabled] = useState(connected)
  const [manual, setManual] = useState(false)
  const [form, setForm] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveErr, setSaveErr] = useState<string | null>(null)

  const toggle = (next: boolean) => {
    setEnabled(next)
    setExpanded(next)
  }

  const apply = async () => {
    if (!onApply || !c.env) return
    const values: Record<string, string> = {}
    for (const e of c.env) {
      const v = (form[e.key] ?? '').trim()
      if (v) values[e.key] = v
    }
    if (Object.keys(values).length === 0) {
      setSaveErr('Enter a value first.')
      return
    }
    setSaving(true)
    setSaveErr(null)
    try {
      await onApply(values)
      setSaved(true)
    } catch (err) {
      setSaveErr(err instanceof Error ? err.message : 'Could not save.')
    } finally {
      setSaving(false)
    }
  }

  const savedMsg = c.requiresAdapter
    ? 'Saved to .env. Open Manual setup to wire the adapter (one-time), then restart.'
    : 'Saved to .env. Restart `npx kernel dev` to apply, then finish setup here.'

  return (
    <motion.div
      className={`cx-card cx-${state}${expanded ? ' open' : ''}${enabled ? ' enabled' : ''}`}
      variants={itemVariants}
    >
      <div className="cx-head">
        <button type="button" className="cx-head-main" onClick={() => setExpanded((o) => !o)} aria-expanded={expanded}>
          <Tile>
            <c.Icon />
          </Tile>
          <span className="cx-text">
            <span className="cx-name">
              {c.name}
              {connected && <span className="cx-active-dot" aria-label="active" title="Active" />}
            </span>
            <span className="cx-blurb">{c.blurb}</span>
          </span>
        </button>
        {toggleable ? (
          <Switch
            checked={enabled}
            disabled={connected}
            label={connected ? `${c.name} is active` : `Enable ${c.name}`}
            onChange={toggle}
          />
        ) : (
          <button
            type="button"
            className="cx-expand"
            onClick={() => setExpanded((o) => !o)}
            aria-expanded={expanded}
            aria-label={`Show ${c.name}`}
          >
            <Chevron />
          </button>
        )}
      </div>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            className="cx-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.24, ease: EASE_OUT }}
          >
            <div className="cx-body-inner">
              {connected && <p className="cx-active-note">This is your active {CATEGORY_LABEL[c.category]}.</p>}

              {canApply && !connected && c.env && (
                <div className="cx-apply">
                  {c.env.map((e) => (
                    <label key={e.key} className="cx-field">
                      <span className="cx-field-key">{e.key}</span>
                      <input
                        className="input"
                        type="text"
                        spellCheck={false}
                        placeholder={e.example}
                        value={form[e.key] ?? ''}
                        onChange={(ev) => {
                          setForm((f) => ({ ...f, [e.key]: ev.target.value }))
                          setSaved(false)
                        }}
                      />
                    </label>
                  ))}
                  {saveErr && <div className="alert">{saveErr}</div>}
                  {saved ? (
                    <p className="cx-saved">{savedMsg}</p>
                  ) : (
                    <button type="button" className="btn primary cx-save" onClick={apply} disabled={saving}>
                      {saving ? 'Saving…' : 'Save to .env'}
                    </button>
                  )}
                </div>
              )}

              {/* Migrate has only a guide — show it inline. Everything else tucks the
                  verbose config behind a compact "Manual setup" disclosure. */}
              {isMigrate
                ? hasManual && <ManualSetup c={c} envBlock={envBlock} />
                : hasManual && (
                    <div className="cx-manual">
                      <button
                        type="button"
                        className={`cx-manual-toggle${manual ? ' open' : ''}`}
                        onClick={() => setManual((m) => !m)}
                        aria-expanded={manual}
                      >
                        <Chevron />
                        Manual setup
                      </button>
                      <AnimatePresence initial={false}>
                        {manual && (
                          <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.2, ease: EASE_OUT }}
                            style={{ overflow: 'hidden' }}
                          >
                            <ManualSetup c={c} envBlock={envBlock} />
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

/** The full connector catalog, grouped by category. In `setupMode`, connectors
 *  with env vars become fillable forms that write to .env via `onApply`. */
export function ConnectorGrid({
  status,
  setupMode,
  onApply,
}: {
  status: ConnectorState
  setupMode?: boolean
  onApply?: (values: Record<string, string>) => Promise<void>
}) {
  return (
    <motion.div className="cx-grid" variants={listContainer} initial="initial" animate="animate">
      {CATEGORY_ORDER.map((cat) => {
        const items = CONNECTORS.filter((c) => c.category === cat)
        if (items.length === 0) return null
        return (
          <div key={cat} className="cx-group">
            <motion.p className="cx-group-title" variants={itemVariants}>
              {cat}
            </motion.p>
            {items.map((c) => (
              <ConnectorCard key={c.id} c={c} status={status} setupMode={setupMode} onApply={onApply} />
            ))}
          </div>
        )
      })}
    </motion.div>
  )
}

/** Count of connected connectors (for the sidebar badge). */
export function connectedCount(status: ConnectorState): number {
  return CONNECTORS.filter((c) => c.state(status) === 'connected').length
}
