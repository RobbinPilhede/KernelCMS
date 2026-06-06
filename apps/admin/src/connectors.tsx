// Connectors: a Coolify-style catalog of the databases, storage, email, and auth
// providers KernelCMS can wire up. Each card shows whether it is connected and,
// when not, exactly how to connect it (run it locally, or prepare the .env and
// config), plus a copy-paste prompt for your AI assistant. Used in the first-run
// wizard and in the Connectors panel.
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

type CardState = 'connected' | 'available' | 'adapter'

// ── brand icon tiles ──────────────────────────────────────────────────────────

function Tile({ accent, children }: { accent: string; children: React.ReactNode }) {
  return (
    <span className="cx-tile" style={{ ['--cx-accent' as string]: accent }}>
      {children}
    </span>
  )
}

const S = { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none' as const }
const stroke = {
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

const DatabaseGlyph = () => (
  <svg {...S} {...stroke} aria-hidden>
    <ellipse cx="12" cy="5" rx="7" ry="3" />
    <path d="M5 5v14c0 1.66 3.13 3 7 3s7-1.34 7-3V5" />
    <path d="M5 12c0 1.66 3.13 3 7 3s7-1.34 7-3" />
  </svg>
)
const LeafGlyph = () => (
  <svg {...S} {...stroke} aria-hidden>
    <path d="M12 2c5 5 6 9 6 12a6 6 0 0 1-12 0c0-3 1-7 6-12z" />
    <path d="M12 8v12" />
  </svg>
)
const BucketGlyph = () => (
  <svg {...S} {...stroke} aria-hidden>
    <path d="M5 7l1.2 12.1a2 2 0 0 0 2 1.9h7.6a2 2 0 0 0 2-1.9L19 7" />
    <path d="M3 7h18" />
    <path d="M9 7V5.5a3 3 0 0 1 6 0V7" />
  </svg>
)
const MailGlyph = () => (
  <svg {...S} {...stroke} aria-hidden>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="m3.5 7 8.5 6 8.5-6" />
  </svg>
)
const GoogleGlyph = () => (
  <svg {...S} {...stroke} strokeWidth={2} aria-hidden>
    <path d="M21 12a9 9 0 1 1-3.2-6.9" />
    <path d="M21 12h-8" />
  </svg>
)
const GithubGlyph = () => (
  <svg {...S} {...stroke} aria-hidden>
    <circle cx="6.5" cy="6" r="2.4" />
    <circle cx="6.5" cy="18" r="2.4" />
    <circle cx="17.5" cy="8" r="2.4" />
    <path d="M6.5 8.4v7.2" />
    <path d="M17.5 10.4c0 3.2-3.4 4.1-7 4.6" />
  </svg>
)
const WandGlyph = () => (
  <svg {...S} {...stroke} aria-hidden>
    <path d="M5 19 16 8" />
    <path d="m14.5 3.5 1.4 1.4M19.5 8.5l1.4 1.4M4 8l1 1M9.5 3.5l1 1" />
  </svg>
)

// ── catalog ───────────────────────────────────────────────────────────────────

type Category = 'Database' | 'Storage' | 'Email' | 'Authentication' | 'Migrate'

interface ConnectorDef {
  id: string
  name: string
  category: Category
  accent: string
  Icon: () => JSX.Element
  blurb: string
  state: (s: ConnectorState) => CardState
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
    accent: '#0f80cc',
    Icon: DatabaseGlyph,
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
    accent: '#336791',
    Icon: DatabaseGlyph,
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
    accent: '#00758f',
    Icon: DatabaseGlyph,
    blurb: 'Not built in, but KernelCMS is adapter-based, so build one against the @kernel/db contract.',
    state: () => 'adapter',
    prompt: `I'm using KernelCMS, which is adapter-based: databases implement the DatabaseAdapter contract from @kernel/db (init, migrate, find, findByID, create, update, delete, count, health, plus a query AST). I want a MySQL adapter. Study the existing @kernel/db-postgres adapter as a reference and implement an equivalent MySQL adapter (mysql2 driver), keeping identifier quoting and parameterized values, then wire it into kernel.config.ts as the db.`,
  },
  {
    id: 'mongodb',
    name: 'MongoDB',
    category: 'Database',
    accent: '#00ed64',
    Icon: LeafGlyph,
    blurb: 'Not built in, but adapter-based: a document-store adapter can implement the same contract.',
    state: () => 'adapter',
    prompt: `I'm using KernelCMS, which is adapter-based: databases implement the DatabaseAdapter contract from @kernel/db. I want a MongoDB adapter. Map collections to Mongo collections, translate the query AST (where/sort/limit/page) to Mongo queries, and implement migrate as index/collection setup. Use @kernel/db-postgres as the reference for the contract shape, then wire it into kernel.config.ts.`,
  },
  {
    id: 'object-storage',
    name: 'Object storage (S3 / R2)',
    category: 'Storage',
    accent: '#f38020',
    Icon: BucketGlyph,
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
    accent: '#6366f1',
    Icon: MailGlyph,
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
    accent: '#4285f4',
    Icon: GoogleGlyph,
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
    accent: '#6e7681',
    Icon: GithubGlyph,
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
    accent: '#c8a96a',
    Icon: WandGlyph,
    blurb: 'Turn a static website into editable sections, 1:1, keeping its exact styling.',
    state: () => 'available',
    prompt: MIGRATION_PROMPT,
  },
]

const CATEGORY_ORDER: Category[] = ['Database', 'Storage', 'Email', 'Authentication', 'Migrate']

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

const STATE_LABEL: Record<CardState, string> = {
  connected: 'Connected',
  available: 'Available',
  adapter: 'Adapter needed',
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
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveErr, setSaveErr] = useState<string | null>(null)
  const state = c.state(status)
  const envBlock = c.env?.map((e) => `${e.key}=${e.example}`).join('\n')
  // During first-run, connectors with env vars can be configured right here:
  // the values are written to the project .env and applied on the next start.
  const canApply = Boolean(setupMode && onApply && c.env && c.env.length > 0)

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

  return (
    <motion.div className={`cx-card cx-${state}${open ? ' open' : ''}`} variants={itemVariants}>
      <button type="button" className="cx-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Tile accent={c.accent}>
          <c.Icon />
        </Tile>
        <span className="cx-text">
          <span className="cx-name">{c.name}</span>
          <span className="cx-blurb">{c.blurb}</span>
        </span>
        <span className={`cx-pill cx-pill-${state}`}>{STATE_LABEL[state]}</span>
        <span className="cx-chev" aria-hidden>
          ›
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            className="cx-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.24, ease: EASE_OUT }}
          >
            <div className="cx-body-inner">
              {canApply && c.env && (
                <div className="cx-section cx-apply">
                  <p className="cx-section-title">Connect it now</p>
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
                    <p className="cx-saved">
                      Saved to .env. Restart `npx kernel dev` to apply, then finish setup here.
                    </p>
                  ) : (
                    <button type="button" className="btn primary cx-save" onClick={apply} disabled={saving}>
                      {saving ? 'Saving…' : 'Save to .env'}
                    </button>
                  )}
                </div>
              )}
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
              {cat === 'Migrate' ? 'Migrate' : cat}
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
