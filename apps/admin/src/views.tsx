import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, Outlet, useNavigate, useParams, useRouterState } from '@tanstack/react-router'
import { AnimatePresence, motion } from 'framer-motion'
import { EASE, EASE_OUT, itemVariants, listContainer, navSpring, pageVariants } from './motion'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { flexRender, getCoreRowModel, useReactTable } from '@tanstack/react-table'
import type { ColumnDef } from '@tanstack/react-table'
import {
  ApiError,
  createDoc,
  deleteDoc,
  deleteManyDocs,
  forgotPassword,
  getDoc,
  getGlobal,
  listDocs,
  listVersions,
  resetPassword,
  restoreVersion,
  updateDoc,
  updateGlobal,
  uploadFile,
  verifyEmail,
  writeSetupEnv,
} from './api'
import type {
  AdminCollection,
  AdminFieldMeta,
  AdminGlobal,
  Doc,
  FieldErrorDetail,
  SetupRuntime,
  VersionEntry,
  WhereClause,
} from './api'
import { useAuth } from './auth'
import { useCollection, useGlobal, useSchema } from './schema'
import { FieldInput, stripRowKeys, withRowKeys } from './fields'
import { getCell, getWidgets } from './registry'
import { ConnectorGrid } from './connectors'
import type { ConnectorState } from './connectors'
import { Logo } from './Logo'
import { CommandPalette } from './CommandPalette'
import { ConfirmHost, Toaster, confirmDialog, toast } from './feedback'
import { ThemeToggle } from './theme'

const SYSTEM = new Set(['id', 'createdAt', 'updatedAt', 'hash'])
const UPLOAD_SYSTEM = new Set([
  'filename',
  'mime_type',
  'filesize',
  'checksum',
  'storage_key',
  'url',
  'width',
  'height',
])

function editableFields(collection: AdminCollection): AdminFieldMeta[] {
  return collection.fields.filter((f) => !f.admin?.hidden && !SYSTEM.has(f.name))
}

function prettify(key: string): string {
  return key.replace(/[_-]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase())
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'boolean') return value ? '✓' : '—'
  if (Array.isArray(value)) {
    return value.map((v) => (v && typeof v === 'object' ? String((v as Doc).id) : String(v))).join(', ') || '—'
  }
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>
    return String(o.title ?? o.name ?? o.email ?? o.id ?? '[object]')
  }
  const str = String(value)
  return str.length > 80 ? `${str.slice(0, 80)}…` : str
}

function relValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === 'object' ? (x as Doc).id : x))
  if (v && typeof v === 'object') return (v as Doc).id
  return v
}

function initialForm(collection: AdminCollection, doc: Doc): Record<string, unknown> {
  const form: Record<string, unknown> = {}
  for (const f of editableFields(collection)) {
    if (f.type === 'password') continue
    let val = doc[f.name]
    if (f.type === 'relationship' || f.type === 'upload') val = relValue(val)
    form[f.name] = val ?? f.defaultValue ?? (f.hasMany ? [] : null)
  }
  return withRowKeys(editableFields(collection), form)
}

/** Seed a new document's form with each field's default value. */
function defaultForm(collection: AdminCollection): Record<string, unknown> {
  const form: Record<string, unknown> = {}
  for (const f of editableFields(collection)) {
    if (f.type === 'password') continue
    form[f.name] = f.defaultValue ?? (f.hasMany ? [] : null)
  }
  return withRowKeys(editableFields(collection), form)
}

function buildPayload(fields: AdminFieldMeta[], form: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of fields) {
    const v = form[f.name]
    if (f.type === 'password') {
      if (typeof v === 'string' && v.length > 0) out[f.name] = v
      continue
    }
    if (v !== undefined) out[f.name] = v
  }
  return stripRowKeys(out) as Record<string, unknown>
}

function FieldRow({
  field,
  value,
  onChange,
  error,
}: {
  field: AdminFieldMeta
  value: unknown
  onChange: (value: unknown) => void
  error?: string
}) {
  return (
    <div className="field">
      <label className="field-label">
        {field.label}
        {field.required && <span className="req">*</span>}
      </label>
      {field.admin?.description && <div className="field-help">{field.admin.description}</div>}
      <FieldInput field={field} value={value} onChange={onChange} />
      {error && <div className="field-error">{error}</div>}
    </div>
  )
}

/** Group main-column fields into ordered tabs by `admin.tab`. Returns a single
 *  unnamed tab when no field declares one (so no tab bar is shown). */
function groupTabs(fields: AdminFieldMeta[]): Array<{ name: string; fields: AdminFieldMeta[] }> {
  if (!fields.some((f) => f.admin?.tab)) return [{ name: '', fields }]
  const fallback = fields.find((f) => f.admin?.tab)?.admin?.tab ?? 'Content'
  const order: string[] = []
  const map = new Map<string, AdminFieldMeta[]>()
  for (const f of fields) {
    const name = f.admin?.tab ?? fallback
    if (!map.has(name)) {
      map.set(name, [])
      order.push(name)
    }
    map.get(name)!.push(f)
  }
  return order.map((name) => ({ name, fields: map.get(name)! }))
}

const DEVICES = [
  { id: 'desktop', label: 'Desktop', width: '100%' },
  { id: 'tablet', label: 'Tablet', width: '820px' },
  { id: 'mobile', label: 'Mobile', width: '390px' },
] as const

/** Live preview iframe. Loads the same admin app in preview mode (same origin)
 *  and posts the current form data to it on every change. */
function LivePreview({ slug, form, url }: { slug: string; form: Record<string, unknown>; url?: string }) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [device, setDevice] = useState<(typeof DEVICES)[number]['id']>('desktop')

  // Always post the latest data; a ref avoids stale closures in the message handler.
  const formRef = useRef(form)
  formRef.current = form
  const readyRef = useRef(false)

  // When a frontend URL is configured, iframe the real site and post cross-origin
  // to its origin. Otherwise use the built-in same-origin preview renderer.
  const base = window.location.pathname.split('#')[0]
  const src = url ?? `${window.location.origin}${base}?kernel_preview=1&collection=${encodeURIComponent(slug)}`
  const targetOrigin = url ? new URL(url, window.location.origin).origin : window.location.origin

  const post = () => {
    iframeRef.current?.contentWindow?.postMessage(
      { type: 'kernel-preview', data: stripRowKeys(formRef.current) },
      targetOrigin,
    )
  }

  // The preview announces readiness once its listener is attached → reply with
  // data. This avoids the race where data is sent before the iframe is listening.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      // Only react to the iframe we host, on the origin we post to.
      if (e.source !== iframeRef.current?.contentWindow || e.origin !== targetOrigin) return
      if (e.data && e.data.type === 'kernel-preview-ready') {
        readyRef.current = true
        post()
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  // Push updates on every edit once the preview is live.
  useEffect(() => {
    if (readyRef.current) post()
  }, [form])

  const width = DEVICES.find((d) => d.id === device)?.width ?? '100%'

  return (
    <aside className="preview-pane">
      <div className="preview-bar">
        <span className="preview-label">Live preview</span>
        <span className="spacer" />
        <div className="device-toggle">
          {DEVICES.map((d) => (
            <button
              key={d.id}
              type="button"
              className={d.id === device ? 'dev active' : 'dev'}
              onClick={() => setDevice(d.id)}
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>
      <div className={device === 'desktop' ? 'preview-stage' : 'preview-stage framed'}>
        <iframe
          ref={iframeRef}
          className="preview-frame"
          src={src}
          style={{ width }}
          title="Live preview"
          onLoad={() => {
            readyRef.current = true
            post()
          }}
        />
      </div>
    </aside>
  )
}

/** Turn a validation path like "layout.0.heading" into "layout › #1 › heading". */
function friendlyPath(path: string): string {
  return path
    .split('.')
    .map((seg) => (/^\d+$/.test(seg) ? `#${Number(seg) + 1}` : seg.replace(/_/g, ' ')))
    .join(' › ')
}

// ---------------------------------------------------------------------------

/** Animated startup background: a band of light sweeping across a fine pixel
 *  matrix, over a soft drifting aurora. Pure CSS — see `.login-pixels`. */
function LoginBackdrop() {
  return (
    <div className="login-bg" aria-hidden>
      <span className="aurora aurora-1" />
      <span className="aurora aurora-2" />
      <span className="aurora aurora-3" />
      <div className="login-pixels" />
    </div>
  )
}

export function Login() {
  const { signIn, authSlug } = useAuth()
  const [mode, setMode] = useState<'login' | 'forgot'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await signIn(email, password)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed.')
    } finally {
      setBusy(false)
    }
  }

  const submitForgot = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!authSlug) return
    setBusy(true)
    setError(null)
    try {
      await forgotPassword(authSlug, email)
      // Generic success — never reveals whether the address has an account.
      setSent(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the reset email.')
    } finally {
      setBusy(false)
    }
  }

  if (mode === 'forgot') {
    return (
      <div className="login">
        <LoginBackdrop />
        <form className="login-card" onSubmit={submitForgot}>
          <div className="login-head">
            <Logo />
          </div>
          {sent ? (
            <>
              <p className="muted">
                If an account exists for <strong>{email}</strong>, a password reset link is on its way.
              </p>
              <button
                type="button"
                className="btn primary"
                onClick={() => {
                  setMode('login')
                  setSent(false)
                }}
              >
                Back to sign in
              </button>
            </>
          ) : (
            <>
              {error && <div className="alert">{error}</div>}
              <label>
                Email
                <input
                  className="input"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </label>
              <button className="btn primary" type="submit" disabled={busy}>
                {busy ? 'Sending…' : 'Send reset link'}
              </button>
              <button type="button" className="link-btn" onClick={() => setMode('login')}>
                Back to sign in
              </button>
            </>
          )}
        </form>
      </div>
    )
  }

  return (
    <div className="login">
      <LoginBackdrop />
      <form className="login-card" onSubmit={submit}>
        <div className="login-head">
          <Logo />
        </div>
        {error && <div className="alert">{error}</div>}
        <label>
          Email
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          Password
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        {authSlug && (
          <button type="button" className="link-btn" onClick={() => setMode('forgot')}>
            Forgot password?
          </button>
        )}
        <div className="login-foot">
          <ThemeToggle />
        </div>
      </form>
    </div>
  )
}

// ---------------------------------------------------------------------------
// First-run welcome wizard
// ---------------------------------------------------------------------------

interface RuntimeCard {
  tone: 'ok' | 'info' | 'warn'
  title: string
  body: string
}

function runtimeCards(rt: SetupRuntime | null): RuntimeCard[] {
  if (!rt) return []
  const cards: RuntimeCard[] = []
  if (rt.db === 'sqlite') {
    cards.push({
      tone: 'info',
      title: 'Running on SQLite',
      body: 'A built-in, zero-setup database saved to a local file. Perfect while you build, and ready to swap for Postgres when you go live.',
    })
  } else if (rt.db === 'postgres') {
    cards.push({
      tone: 'ok',
      title: 'Connected to PostgreSQL',
      body: 'Your content lives in a production-grade database.',
    })
  } else {
    cards.push({ tone: 'ok', title: `Database: ${rt.db}`, body: 'Your database adapter is connected.' })
  }
  cards.push(
    rt.secretSet
      ? { tone: 'ok', title: 'Signing secret set', body: 'Login sessions are signed with your own secret.' }
      : {
          tone: 'warn',
          title: 'Using a development secret',
          body: 'Fine for local work. Set a real KERNEL_SECRET before you deploy. There is a copy-paste prompt for that in a moment.',
        },
  )
  cards.push(
    rt.storage
      ? { tone: 'ok', title: 'File storage ready', body: 'Uploads are saved to your configured storage.' }
      : {
          tone: 'info',
          title: 'Local file storage',
          body: 'Uploads save to disk for now. Add S3 or Cloudflare R2 when you deploy.',
        },
  )
  return cards
}

const TONE_MARK: Record<RuntimeCard['tone'], string> = { ok: '✓', info: '•', warn: '!' }

const stepVariants = {
  initial: { opacity: 0, y: 16 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.34, ease: EASE } },
  exit: { opacity: 0, y: -12, transition: { duration: 0.2, ease: EASE_OUT } },
}

/** Derive connector status from the first-run runtime (no OAuth info there yet). */
function connectorStateFromRuntime(rt: SetupRuntime | null): ConnectorState {
  return {
    db: rt?.db ?? 'unknown',
    storage: Boolean(rt?.storage),
    email: Boolean(rt?.email),
    oauth: [],
    image: false,
  }
}

export function Setup() {
  const { signUp, completeSetup, runtime } = useAuth()
  const [step, setStep] = useState<0 | 1 | 2 | 3 | 4>(0)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const cards = runtimeCards(runtime)

  const createAccount = async (e: React.FormEvent) => {
    e.preventDefault()
    if (password !== confirm) {
      setError('Passwords do not match.')
      return
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await signUp(email, password)
      setStep(4)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup failed.')
    } finally {
      setBusy(false)
    }
  }

  const enterDashboard = async () => {
    setBusy(true)
    try {
      await completeSetup()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login wz">
      <LoginBackdrop />
      <div className="wz-card">
        <div className="wz-rail" aria-hidden>
          {[0, 1, 2, 3, 4].map((i) => (
            <span key={i} className={`wz-dot${i === step ? ' active' : ''}${i < step ? ' done' : ''}`} />
          ))}
        </div>

        <AnimatePresence mode="wait">
          {step === 0 && (
            <motion.div
              key="welcome"
              className="wz-step"
              variants={stepVariants}
              initial="initial"
              animate="animate"
              exit="exit"
            >
              <div className="wz-head">
                <Logo />
                <h1>Welcome to KernelCMS</h1>
                <p className="muted">It's already running. Here's how it's set up right now.</p>
              </div>
              <motion.div className="wz-cards" variants={listContainer} initial="initial" animate="animate">
                {cards.map((c, i) => (
                  <motion.div key={i} className={`wz-status wz-${c.tone}`} variants={itemVariants}>
                    <span className="wz-status-mark" aria-hidden>
                      {TONE_MARK[c.tone]}
                    </span>
                    <span className="wz-status-text">
                      <span className="wz-status-title">{c.title}</span>
                      <span className="wz-status-body">{c.body}</span>
                    </span>
                  </motion.div>
                ))}
              </motion.div>
              <button className="btn primary wz-next" type="button" onClick={() => setStep(1)}>
                Connect your stack →
              </button>
              <button type="button" className="link-btn wz-skip" onClick={() => setStep(3)}>
                Skip for now, just create my account
              </button>
              <div className="wz-foot">
                <ThemeToggle />
              </div>
            </motion.div>
          )}

          {step === 1 && (
            <motion.div
              key="database"
              className="wz-step"
              variants={stepVariants}
              initial="initial"
              animate="animate"
              exit="exit"
            >
              <div className="wz-head">
                <Logo />
                <h1>Choose your database</h1>
                <p className="muted">
                  SQLite runs with zero setup while you build. Pick PostgreSQL for production, or another engine. You
                  can change this anytime.
                </p>
              </div>
              <ConnectorGrid
                status={connectorStateFromRuntime(runtime)}
                setupMode
                categories={['Database']}
                onApply={async (values) => {
                  await writeSetupEnv(values)
                }}
              />
              <button className="btn primary wz-next" type="button" onClick={() => setStep(2)}>
                Continue →
              </button>
              <button type="button" className="link-btn" onClick={() => setStep(0)}>
                ← Back
              </button>
            </motion.div>
          )}

          {step === 2 && (
            <motion.div
              key="services"
              className="wz-step"
              variants={stepVariants}
              initial="initial"
              animate="animate"
              exit="exit"
            >
              <div className="wz-head">
                <Logo />
                <h1>Connect services</h1>
                <p className="muted">
                  Cache, file storage, email, and sign-in providers. All optional, and addable anytime from Connectors
                  in the sidebar.
                </p>
              </div>
              <ConnectorGrid
                status={connectorStateFromRuntime(runtime)}
                setupMode
                categories={['Cache', 'Storage', 'Email', 'Authentication']}
                onApply={async (values) => {
                  await writeSetupEnv(values)
                }}
              />
              <button className="btn primary wz-next" type="button" onClick={() => setStep(3)}>
                Create your account →
              </button>
              <button type="button" className="link-btn" onClick={() => setStep(1)}>
                ← Back
              </button>
            </motion.div>
          )}

          {step === 3 && (
            <motion.div
              key="account"
              className="wz-step"
              variants={stepVariants}
              initial="initial"
              animate="animate"
              exit="exit"
            >
              <div className="wz-head">
                <Logo />
                <h1>Create your account</h1>
                <p className="muted">This first account is the owner. You can add teammates later.</p>
              </div>
              <form className="wz-form" onSubmit={createAccount}>
                {error && <div className="alert">{error}</div>}
                <label>
                  Email
                  <input
                    className="input"
                    type="email"
                    autoComplete="username"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </label>
                <label>
                  Password
                  <input
                    className="input"
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                </label>
                <label>
                  Confirm password
                  <input
                    className="input"
                    type="password"
                    autoComplete="new-password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    required
                  />
                </label>
                <button className="btn primary" type="submit" disabled={busy}>
                  {busy ? 'Creating…' : 'Create account'}
                </button>
                <button type="button" className="link-btn" onClick={() => setStep(2)} disabled={busy}>
                  ← Back
                </button>
              </form>
            </motion.div>
          )}

          {step === 4 && (
            <motion.div
              key="next"
              className="wz-step"
              variants={stepVariants}
              initial="initial"
              animate="animate"
              exit="exit"
            >
              <div className="wz-head">
                <Logo />
                <h1>You're all set</h1>
                <p className="muted">
                  Your workspace is ready. Every connector lives under Connectors in the sidebar whenever you need it.
                </p>
              </div>
              <button className="btn primary wz-next" type="button" onClick={enterDashboard} disabled={busy}>
                {busy ? 'Opening…' : 'Enter your dashboard →'}
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

/** Read query params from the hash route (e.g. `#/reset-password?token=…`). */
function hashParams(): URLSearchParams {
  const hash = window.location.hash
  const q = hash.indexOf('?')
  return new URLSearchParams(q >= 0 ? hash.slice(q + 1) : '')
}

function goToAdminRoot(): void {
  window.location.hash = '#/'
  window.location.reload()
}

/** Public page reached from the password-reset email link. */
export function ResetPasswordPage() {
  const params = hashParams()
  const collection = params.get('collection') ?? ''
  const token = params.get('token') ?? ''
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (password !== confirm) {
      setError('Passwords do not match.')
      return
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await resetPassword(collection, token, password)
      setDone(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reset your password.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login">
      <LoginBackdrop />
      <form className="login-card" onSubmit={submit}>
        <div className="login-head">
          <Logo />
          <h1>Choose a new password</h1>
        </div>
        {!collection || !token ? (
          <div className="alert">
            This reset link is missing information. Request a new one from the sign-in screen.
          </div>
        ) : done ? (
          <>
            <p className="muted">Your password has been updated and you're signed in.</p>
            <button type="button" className="btn primary" onClick={goToAdminRoot}>
              Continue to the admin
            </button>
          </>
        ) : (
          <>
            {error && <div className="alert">{error}</div>}
            <label>
              New password
              <input
                className="input"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </label>
            <label>
              Confirm password
              <input
                className="input"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
              />
            </label>
            <button className="btn primary" type="submit" disabled={busy}>
              {busy ? 'Updating…' : 'Update password'}
            </button>
          </>
        )}
      </form>
    </div>
  )
}

/** Public page reached from the email-verification link. */
export function VerifyEmailPage() {
  const params = hashParams()
  const collection = params.get('collection') ?? ''
  const token = params.get('token') ?? ''
  const [state, setState] = useState<'working' | 'done' | 'error'>('working')
  const [message, setMessage] = useState('')

  useEffect(() => {
    let active = true
    void (async () => {
      if (!collection || !token) {
        if (active) {
          setState('error')
          setMessage('This verification link is missing information.')
        }
        return
      }
      try {
        await verifyEmail(collection, token)
        if (active) setState('done')
      } catch (err) {
        if (active) {
          setState('error')
          setMessage(err instanceof Error ? err.message : 'Verification failed.')
        }
      }
    })()
    return () => {
      active = false
    }
  }, [collection, token])

  return (
    <div className="login">
      <LoginBackdrop />
      <div className="login-card">
        <div className="login-head">
          <Logo />
          <h1>Email verification</h1>
        </div>
        {state === 'working' && <p className="muted">Verifying your email address…</p>}
        {state === 'done' && (
          <>
            <p className="muted">Your email is verified. You can now sign in.</p>
            <button type="button" className="btn primary" onClick={goToAdminRoot}>
              Go to sign in
            </button>
          </>
        )}
        {state === 'error' && (
          <>
            <div className="alert">{message}</div>
            <button type="button" className="btn" onClick={goToAdminRoot}>
              Go to sign in
            </button>
          </>
        )}
      </div>
    </div>
  )
}

export function AppFrame() {
  const { user, loading, needsSetup } = useAuth()
  if (loading) return <div className="center">Loading…</div>
  if (!user) return needsSetup ? <Setup /> : <Login />
  return <Shell />
}

const ICON_SVG = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const

/** A leading nav icon chosen from a collection's slug/traits (or the globals cog). */
function DashboardIcon() {
  return (
    <svg {...ICON_SVG}>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </svg>
  )
}

function NavIcon({ collection, global }: { collection?: AdminCollection; global?: boolean }) {
  if (global) {
    return (
      <svg {...ICON_SVG}>
        <line x1="4" y1="8" x2="20" y2="8" />
        <circle cx="9" cy="8" r="2.2" />
        <line x1="4" y1="16" x2="20" y2="16" />
        <circle cx="15" cy="16" r="2.2" />
      </svg>
    )
  }
  const slug = collection?.slug ?? ''
  if (slug === 'users' || collection?.auth) {
    return (
      <svg {...ICON_SVG}>
        <path d="M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1" />
        <circle cx="9.5" cy="7" r="3.2" />
        <path d="M21 19v-1a4 4 0 0 0-3-3.87" />
      </svg>
    )
  }
  if (slug === 'media' || collection?.upload) {
    return (
      <svg {...ICON_SVG}>
        <rect x="3" y="4" width="18" height="16" rx="2.5" />
        <circle cx="8.5" cy="9.5" r="1.7" />
        <path d="M21 15.5 16 11l-9 8.5" />
      </svg>
    )
  }
  if (slug === 'articles') {
    return (
      <svg {...ICON_SVG}>
        <rect x="3" y="4" width="18" height="16" rx="2.5" />
        <line x1="7" y1="8.5" x2="17" y2="8.5" />
        <line x1="7" y1="12" x2="17" y2="12" />
        <line x1="7" y1="15.5" x2="13" y2="15.5" />
      </svg>
    )
  }
  if (slug === 'pages') {
    return (
      <svg {...ICON_SVG}>
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
        <path d="M14 3v5h5" />
      </svg>
    )
  }
  // Default: a stacked-layers / collection mark.
  return (
    <svg {...ICON_SVG}>
      <path d="M12 3 3 8l9 5 9-5-9-5z" />
      <path d="M3 13l9 5 9-5" />
    </svg>
  )
}

/** The profile chip + an animated dropdown (Edit profile / Sign out). */
function UserMenu() {
  const { user, authSlug, signOut } = useAuth()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [closing, setClosing] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const close = useCallback(() => {
    setClosing(true)
    setTimeout(() => {
      setOpen(false)
      setClosing(false)
    }, 150)
  }, [])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, close])

  const email = String(user?.email ?? 'User')
  return (
    <div className="user-menu" ref={ref}>
      <button
        type="button"
        className="user-card"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span className="user-avatar" aria-hidden>
          <svg {...ICON_SVG}>
            <path d="M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1" />
            <circle cx="9.5" cy="7" r="3.2" />
            <path d="M21 19v-1a4 4 0 0 0-3-3.87" />
          </svg>
        </span>
        <span className="user-name" title={email}>
          {email}
        </span>
        <svg className="user-caret" {...ICON_SVG} width={14} height={14}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className={closing ? 'user-dropdown closing' : 'user-dropdown'} role="menu">
          {authSlug && user?.id != null && (
            <button
              type="button"
              role="menuitem"
              className="user-item"
              onClick={() => {
                close()
                navigate({ to: '/collections/$slug/$id', params: { slug: authSlug, id: String(user.id) } })
              }}
            >
              <svg {...ICON_SVG}>
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
              </svg>
              Edit profile
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className="user-item danger"
            onClick={() => {
              close()
              signOut()
            }}
          >
            <svg {...ICON_SVG}>
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <path d="M16 17l5-5-5-5" />
              <path d="M21 12H9" />
            </svg>
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}

/** A nav link with the shared sliding-highlight (layoutId) behind the active one. */
function NavItem({
  to,
  params,
  icon,
  label,
  active,
}: {
  to: string
  params: Record<string, string>
  icon: React.ReactNode
  label: string
  active: boolean
}) {
  return (
    <Link to={to} params={params} className={active ? 'nav-link active' : 'nav-link'}>
      {active && <motion.span layoutId="nav-active" className="nav-active" transition={navSpring} aria-hidden />}
      <span className="nav-icon">{icon}</span>
      <span className="nav-label">{label}</span>
    </Link>
  )
}

/** Group globals by their `admin.group`; ungrouped ones fall under "Globals".
 *  Preserves config order: each group heading appears where it first occurs. */
function groupGlobals(globals: AdminGlobal[]): Array<{ heading: string; globals: AdminGlobal[] }> {
  const order: string[] = []
  const byHeading = new Map<string, AdminGlobal[]>()
  for (const g of globals) {
    const heading = g.group ?? 'Globals'
    if (!byHeading.has(heading)) {
      byHeading.set(heading, [])
      order.push(heading)
    }
    byHeading.get(heading)!.push(g)
  }
  return order.map((heading) => ({ heading, globals: byHeading.get(heading)! }))
}

function Shell() {
  const schema = useSchema()
  const collections = schema.collections.filter((c) => !c.hidden)
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const isActive = (base: string) => pathname === base || pathname.startsWith(`${base}/`)
  return (
    <div className="layout">
      <aside className="sidebar">
        <Link to="/" className="brand">
          <Logo />
        </Link>
        <UserMenu />
        <CommandPalette schema={schema} />
        <nav>
          <NavItem to="/" params={{}} icon={<DashboardIcon />} label="Dashboard" active={pathname === '/'} />
          <div className="nav-section">Collections</div>
          {collections.map((c) => (
            <NavItem
              key={c.slug}
              to="/collections/$slug"
              params={{ slug: c.slug }}
              icon={<NavIcon collection={c} />}
              label={c.labels.plural}
              active={isActive(`/collections/${c.slug}`)}
            />
          ))}
          {groupGlobals(schema.globals).map(({ heading, globals }) => (
            <Fragment key={heading}>
              <div className="nav-section">{heading}</div>
              {globals.map((g) => (
                <NavItem
                  key={g.slug}
                  to="/globals/$slug"
                  params={{ slug: g.slug }}
                  icon={<NavIcon global />}
                  label={g.label}
                  active={isActive(`/globals/${g.slug}`)}
                />
              ))}
            </Fragment>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="sidebar-theme">
            <span>Theme</span>
            <ThemeToggle />
          </div>
          {schema.attribution && (
            <a className="powered-by" href="https://kernelcms.com" target="_blank" rel="noopener noreferrer">
              Powered by <strong>KernelCMS</strong>
            </a>
          )}
        </div>
      </aside>
      <main className="main">
        {/* Page transition: re-keying on pathname remounts this wrapper on every
            navigation, replaying the slide-up + top-to-bottom content stagger.
            We deliberately avoid AnimatePresence/exit here: wrapping the live
            <Outlet/> in a "wait"-mode exit makes the exiting copy re-render the
            already-current route, double-mounting it and wiping unsaved edits. */}
        <motion.div key={pathname} variants={pageVariants} initial="initial" animate="animate">
          <Outlet />
        </motion.div>
      </main>
      <Toaster />
      <ConfirmHost />
    </div>
  )
}

function timeGreeting(): string {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

/** A friendly first name from an email's local part: "ada.lovelace@x" → "Ada". */
function displayName(email: string | undefined): string {
  if (!email) return ''
  const local = email.split('@')[0] ?? ''
  const first = local.split(/[.\-_+]/)[0] ?? local
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : ''
}

/** One collection tile: icon chip, blurb, and a live document count. */
function CollectionCard({ collection }: { collection: AdminCollection }) {
  const slug = collection.slug
  const { data } = useQuery({
    queryKey: ['count', slug],
    queryFn: () => listDocs(slug, { limit: 1, depth: 0 }),
    staleTime: 30_000,
  })
  const count = data?.totalDocs
  return (
    <Link to="/collections/$slug" params={{ slug }} className="dash-card">
      <span className="dash-card-icon" aria-hidden>
        <NavIcon collection={collection} />
      </span>
      <div className="dash-card-text">
        <h3>{collection.labels.plural}</h3>
        <p>{collection.description ?? `Manage ${collection.labels.plural.toLowerCase()}`}</p>
      </div>
      <div className="dash-card-meta">
        <span className="dash-card-count">
          {count === undefined ? '–' : count}
          <span className="dash-card-count-label">{count === 1 ? 'item' : 'items'}</span>
        </span>
        <svg className="dash-card-arrow" {...ICON_SVG} width={16} height={16}>
          <path d="M5 12h14" />
          <path d="M13 6l6 6-6 6" />
        </svg>
      </div>
    </Link>
  )
}

export function Dashboard() {
  const schema = useSchema()
  const { user } = useAuth()
  const collections = schema.collections.filter((c) => !c.hidden)
  const name = displayName(user?.email as string | undefined)
  const widgets = getWidgets()

  return (
    <div className="page dashboard">
      <motion.header className="dash-hero" variants={itemVariants} initial="initial" animate="animate">
        <p className="dash-eyebrow">{timeGreeting()}</p>
        <h1 className="dash-title">Welcome back{name && <>, {name}</>}</h1>
        <p className="dash-sub">Here's everything in your workspace. Pick a collection to start editing.</p>
      </motion.header>

      {widgets.length > 0 && (
        <motion.div
          className="dash-widgets"
          data-testid="dash-widgets"
          variants={listContainer}
          initial="initial"
          animate="animate"
        >
          {widgets.map(({ key, render }) => (
            <motion.div key={key} className="dash-widget" variants={itemVariants}>
              {render({ user: (user as Record<string, unknown> | null) ?? null })}
            </motion.div>
          ))}
        </motion.div>
      )}

      <motion.div className="dash-grid" variants={listContainer} initial="initial" animate="animate">
        {collections.map((c) => (
          <motion.div key={c.slug} variants={itemVariants}>
            <CollectionCard collection={c} />
          </motion.div>
        ))}
      </motion.div>
    </div>
  )
}

const UPLOADABLE_TEXT = new Set(['text', 'textarea', 'email', 'slug', 'code'])

function fileExt(name: unknown): string {
  const s = String(name ?? '')
  const dot = s.lastIndexOf('.')
  return dot > 0
    ? s
        .slice(dot + 1)
        .toUpperCase()
        .slice(0, 4)
    : 'FILE'
}

/** WordPress-style media library: a thumbnail grid with drag-and-drop upload. */
function MediaLibrary({ slug, collection }: { slug: string; collection: AdminCollection }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [uploading, setUploading] = useState(0)

  const { data, isLoading } = useQuery({
    queryKey: ['list', slug],
    queryFn: () => listDocs(slug, { limit: 100, depth: 0 }),
  })
  const docs = data?.docs ?? []

  // Pre-fill required text fields (e.g. `alt`) with the filename so a drag-drop
  // upload passes validation; the editor can refine it later (WordPress-style).
  const requiredText = collection.fields.filter(
    (f) => f.required && UPLOADABLE_TEXT.has(f.type) && !f.admin?.hidden && !UPLOAD_SYSTEM.has(f.name),
  )

  const uploadFiles = async (files: FileList | File[]) => {
    const list = Array.from(files)
    if (list.length === 0) return
    setUploading((n) => n + list.length)
    let ok = 0
    for (const file of list) {
      const base = file.name.replace(/\.[^.]+$/, '')
      const data: Record<string, unknown> = {}
      for (const f of requiredText) data[f.name] = base
      try {
        await uploadFile(slug, file, data)
        ok++
      } catch (err) {
        toast(err instanceof ApiError ? `${file.name}: ${err.message}` : `Failed to upload ${file.name}`, 'error')
      } finally {
        setUploading((n) => n - 1)
      }
    }
    qc.invalidateQueries({ queryKey: ['list', slug] })
    if (ok > 0) toast(`Uploaded ${ok} file${ok > 1 ? 's' : ''}`, 'success')
  }

  return (
    <div className="page">
      <header className="page-head">
        <h1>{collection.labels.plural}</h1>
        <button type="button" className="btn primary" onClick={() => inputRef.current?.click()}>
          Upload
        </button>
      </header>

      <div
        className={dragging ? 'media-dropzone dragover' : 'media-dropzone'}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          if (e.dataTransfer?.files) void uploadFiles(e.dataTransfer.files)
        }}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          className="upload-input"
          // The input lives inside the clickable dropzone; without this, the
          // programmatic `.click()` re-bubbles to the dropzone and recurses forever.
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => {
            if (e.target.files) void uploadFiles(e.target.files)
            e.target.value = ''
          }}
        />
        <span className="media-dropzone-arrow" aria-hidden>
          ⬆
        </span>
        <span>
          <strong>Drag files here</strong> or click to upload
        </span>
        {uploading > 0 && <span className="muted">Uploading {uploading}…</span>}
      </div>

      {isLoading ? (
        <div className="muted">Loading…</div>
      ) : docs.length === 0 ? (
        <div className="muted">No media yet. Drop a file above to get started.</div>
      ) : (
        <motion.div className="media-grid" variants={listContainer} initial="initial" animate="animate">
          {docs.map((d) => {
            const isImage = String(d.mime_type ?? '').startsWith('image/')
            return (
              <motion.button
                key={d.id}
                type="button"
                className="media-card"
                variants={itemVariants}
                onClick={() => navigate({ to: '/collections/$slug/$id', params: { slug, id: d.id } })}
              >
                <span className="media-thumb">
                  {isImage && d.url ? (
                    <img src={String(d.url)} alt={String(d.alt ?? d.filename ?? '')} loading="lazy" />
                  ) : (
                    <span className="media-file">{fileExt(d.filename)}</span>
                  )}
                </span>
                <span className="media-name" title={String(d.filename ?? '')}>
                  {String(d.filename ?? 'file')}
                </span>
              </motion.button>
            )
          })}
        </motion.div>
      )}
    </div>
  )
}

interface FilterClause {
  field: string
  op: string
  value: string
}

const TEXT_OPS: ReadonlyArray<[string, string]> = [
  ['like', 'contains'],
  ['equals', 'is'],
  ['not_equals', 'is not'],
]
const NUM_OPS: ReadonlyArray<[string, string]> = [
  ['equals', '='],
  ['greater_than', '>'],
  ['less_than', '<'],
]

/** Scalar fields a user can sensibly filter/sort on (skip rich/structural types). */
function isFilterable(type: string): boolean {
  return ['text', 'textarea', 'email', 'slug', 'number', 'select', 'checkbox', 'boolean', 'date'].includes(type)
}
function opsFor(type: string): ReadonlyArray<[string, string]> {
  if (type === 'number' || type === 'date') return NUM_OPS
  if (type === 'checkbox' || type === 'boolean' || type === 'select') return [['equals', 'is']]
  return TEXT_OPS
}
function coerceFilterValue(type: string, value: string): unknown {
  if (type === 'number') return Number(value)
  if (type === 'checkbox' || type === 'boolean') return value === 'true'
  return value
}

export function ListView() {
  const { slug } = useParams({ strict: false }) as { slug: string }
  const collection = useCollection(slug)
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState<FilterClause[]>([])
  const [filterOpen, setFilterOpen] = useState(false)
  const [colsOpen, setColsOpen] = useState(false)
  // Seed the sort indicator from the collection's configured default so the column
  // arrow matches the order the backend returns; null means "backend default".
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(() => {
    const token = collection?.defaultSort?.split(',')[0]?.trim()
    if (!token) return null
    return token.startsWith('-') ? { key: token.slice(1), dir: 'desc' } : { key: token, dir: 'asc' }
  })
  const [selected, setSelected] = useState<Set<string>>(new Set())

  // Admins manage drafts too, so include them in the list for drafts collections.
  const drafts = Boolean(collection?.versions?.drafts)
  const titleField = collection?.useAsTitle ?? 'id'

  const candidateCols = useMemo(() => {
    if (!collection) return ['id']
    const base = collection.defaultColumns?.length ? collection.defaultColumns : [collection.useAsTitle]
    return [...base.filter(Boolean), ...(drafts ? ['_status'] : []), 'updatedAt']
  }, [collection, drafts])

  // Column visibility, remembered per collection.
  const hiddenKey = `kernel:hiddencols:${slug}`
  const [hidden, setHidden] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(hiddenKey)
      return raw ? new Set(JSON.parse(raw) as string[]) : new Set()
    } catch {
      return new Set()
    }
  })
  const toggleHidden = (key: string) => {
    setHidden((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      try {
        localStorage.setItem(hiddenKey, JSON.stringify([...next]))
      } catch {
        /* ignore quota/availability errors */
      }
      return next
    })
  }
  // Stable reference: react-table re-renders infinitely if `columns` (derived from
  // this) gets a new array identity on every render.
  const visibleCols = useMemo(() => candidateCols.filter((c) => !hidden.has(c)), [candidateCols, hidden])

  const filterableFields = useMemo(
    () => (collection?.fields ?? []).filter((f) => !f.admin?.hidden && isFilterable(f.type)),
    [collection],
  )

  const where = useMemo<WhereClause>(() => {
    const w: WhereClause = {}
    if (search.trim()) w[titleField] = { like: search.trim() }
    for (const f of filters) {
      if (f.value === '') continue
      const type = collection?.fields.find((x) => x.name === f.field)?.type ?? 'text'
      w[f.field] = { [f.op]: coerceFilterValue(type, f.value) }
    }
    return w
  }, [search, filters, titleField, collection])

  const sortStr = sort ? `${sort.dir === 'desc' ? '-' : ''}${sort.key}` : undefined

  const { data, isLoading, error } = useQuery({
    queryKey: ['list', slug, page, drafts, where, sortStr],
    queryFn: () => listDocs(slug, { page, limit: 20, depth: 1, draft: drafts, where, sort: sortStr }),
  })

  const columns = useMemo<ColumnDef<Doc>[]>(
    () =>
      visibleCols.map((key) => {
        const field = collection?.fields.find((f) => f.name === key)
        const CustomCell = getCell(field?.admin?.component)
        return {
          accessorKey: key,
          header: key === '_status' ? 'Status' : prettify(key),
          cell: (info) => {
            if (key === '_status') {
              return <StatusPill status={(info.getValue() as 'draft' | 'published') ?? 'draft'} />
            }
            // A registered cell (window.KernelCMS.cells[component]) wins.
            if (CustomCell && field) {
              return <CustomCell value={info.getValue()} row={info.row.original} field={field} />
            }
            return formatCell(info.getValue())
          },
        }
      }),
    [visibleCols, collection],
  )

  const tableData = useMemo(() => data?.docs ?? [], [data])
  const table = useReactTable({ data: tableData, columns, getCoreRowModel: getCoreRowModel() })
  const rows = table.getRowModel().rows
  const pageIds = rows.map((r) => r.original.id)
  const allSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id))

  const toggleRow = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const toggleAll = () =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (allSelected) pageIds.forEach((id) => next.delete(id))
      else pageIds.forEach((id) => next.add(id))
      return next
    })

  const resetPaging = () => {
    setPage(1)
    setSelected(new Set())
  }

  const bulkDelete = async () => {
    const ids = [...selected]
    if (ids.length === 0) return
    const ok = await confirmDialog({
      title: `Delete ${ids.length} ${ids.length === 1 ? 'item' : 'items'}?`,
      message: 'This action cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
    })
    if (!ok) return
    try {
      const result = await deleteManyDocs(slug, { id: { in: ids } })
      toast(`Deleted ${result.count} ${result.count === 1 ? 'item' : 'items'}`, 'success')
      setSelected(new Set())
      qc.invalidateQueries({ queryKey: ['list', slug] })
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Delete failed', 'error')
    }
  }

  const setSortKey = (key: string) =>
    setSort((prev) => {
      if (prev?.key !== key) return { key, dir: 'asc' }
      if (prev.dir === 'asc') return { key, dir: 'desc' }
      return null
    })

  if (!collection) return <div className="page">Unknown collection “{slug}”.</div>
  if (collection.upload) return <MediaLibrary slug={slug} collection={collection} />

  return (
    <div className="page">
      <header className="page-head">
        <h1>{collection.labels.plural}</h1>
        <Link to="/collections/$slug/new" params={{ slug }} className="btn primary">
          Create new
        </Link>
      </header>

      <div className="list-toolbar">
        <input
          className="input list-search"
          type="search"
          placeholder={`Search ${collection.labels.plural.toLowerCase()}…`}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value)
            resetPaging()
          }}
        />
        {filterableFields.length > 0 && (
          <div className="menu-anchor">
            <button
              type="button"
              className={filters.length ? 'btn ghost active' : 'btn ghost'}
              onClick={() => setFilterOpen((v) => !v)}
              aria-expanded={filterOpen}
            >
              Filter{filters.length ? ` · ${filters.length}` : ''}
            </button>
            {filterOpen && (
              <FilterMenu
                fields={filterableFields}
                onAdd={(clause) => {
                  setFilters((prev) => [...prev, clause])
                  setFilterOpen(false)
                  resetPaging()
                }}
                onClose={() => setFilterOpen(false)}
              />
            )}
          </div>
        )}
        <div className="menu-anchor">
          <button type="button" className="btn ghost" onClick={() => setColsOpen((v) => !v)} aria-expanded={colsOpen}>
            Columns
          </button>
          {colsOpen && (
            <div className="pop-menu" role="menu">
              {candidateCols.map((c) => (
                <label key={c} className="pop-check">
                  <input type="checkbox" checked={!hidden.has(c)} onChange={() => toggleHidden(c)} />
                  {c === '_status' ? 'Status' : prettify(c)}
                </label>
              ))}
            </div>
          )}
        </div>
      </div>

      {filters.length > 0 && (
        <div className="filter-chips">
          {filters.map((f, i) => (
            <span key={`${f.field}-${i}`} className="filter-chip">
              {prettify(f.field)} {opLabel(f.field, f.op, collection)} <strong>{f.value}</strong>
              <button
                type="button"
                aria-label="Remove filter"
                onClick={() => {
                  setFilters((prev) => prev.filter((_, idx) => idx !== i))
                  resetPaging()
                }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {error && <div className="alert">{(error as Error).message}</div>}
      {isLoading ? (
        <div className="muted">Loading…</div>
      ) : (
        <>
          {selected.size > 0 && (
            <div className="bulk-bar">
              <span>{selected.size} selected</span>
              <button type="button" className="btn danger sm" onClick={bulkDelete}>
                Delete
              </button>
              <button type="button" className="link-btn" onClick={() => setSelected(new Set())}>
                Clear
              </button>
            </div>
          )}
          <table className="table">
            <thead>
              <tr>
                <th className="check-cell">
                  <input
                    type="checkbox"
                    aria-label="Select all on this page"
                    checked={allSelected}
                    onChange={toggleAll}
                  />
                </th>
                {table.getHeaderGroups()[0]?.headers.map((h) => {
                  const key = h.column.id
                  const active = sort?.key === key
                  return (
                    <th key={h.id} className="th-sort" onClick={() => setSortKey(key)}>
                      {flexRender(h.column.columnDef.header, h.getContext())}
                      <span className="sort-arrow">{active ? (sort!.dir === 'asc' ? '↑' : '↓') : ''}</span>
                    </th>
                  )
                })}
              </tr>
            </thead>
            <motion.tbody variants={listContainer} initial="initial" animate="animate">
              {rows.map((row) => {
                const id = row.original.id
                return (
                  <motion.tr
                    key={row.id}
                    className="row-link"
                    variants={itemVariants}
                    onClick={() => navigate({ to: '/collections/$slug/$id', params: { slug, id } })}
                  >
                    <td className="check-cell" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label="Select row"
                        checked={selected.has(id)}
                        onChange={() => toggleRow(id)}
                      />
                    </td>
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                    ))}
                  </motion.tr>
                )
              })}
              {data && data.docs.length === 0 && (
                <tr>
                  <td colSpan={columns.length + 1} className="muted">
                    {search || filters.length ? 'No matches.' : 'No documents yet.'}
                  </td>
                </tr>
              )}
            </motion.tbody>
          </table>
          <div className="pager">
            <button className="btn ghost" disabled={!data?.hasPrevPage} onClick={() => setPage((p) => p - 1)}>
              Previous
            </button>
            <span className="muted">
              Page {data?.page ?? 1} of {data?.totalPages ?? 1} · {data?.totalDocs ?? 0} total
            </span>
            <button className="btn ghost" disabled={!data?.hasNextPage} onClick={() => setPage((p) => p + 1)}>
              Next
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function opLabel(field: string, op: string, collection: AdminCollection): string {
  const type = collection.fields.find((f) => f.name === field)?.type ?? 'text'
  return opsFor(type).find(([value]) => value === op)?.[1] ?? op
}

/** The small "add a filter" popover: field → operator → value. */
function FilterMenu({
  fields,
  onAdd,
  onClose,
}: {
  fields: AdminFieldMeta[]
  onAdd: (clause: FilterClause) => void
  onClose: () => void
}) {
  const [field, setField] = useState(fields[0]?.name ?? '')
  const type = fields.find((f) => f.name === field)?.type ?? 'text'
  const ops = opsFor(type)
  const [op, setOp] = useState(ops[0]![0])
  const [value, setValue] = useState('')
  const fieldMeta = fields.find((f) => f.name === field)

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (value === '') return
    onAdd({ field, op, value })
  }

  return (
    <form className="pop-menu filter-menu" onSubmit={submit}>
      <select
        className="input"
        value={field}
        onChange={(e) => {
          setField(e.target.value)
          const t = fields.find((f) => f.name === e.target.value)?.type ?? 'text'
          setOp(opsFor(t)[0]![0])
          setValue('')
        }}
      >
        {fields.map((f) => (
          <option key={f.name} value={f.name}>
            {f.label}
          </option>
        ))}
      </select>
      <select className="input" value={op} onChange={(e) => setOp(e.target.value)}>
        {ops.map(([v, label]) => (
          <option key={v} value={v}>
            {label}
          </option>
        ))}
      </select>
      {fieldMeta?.options?.length ? (
        <select className="input" value={value} onChange={(e) => setValue(e.target.value)}>
          <option value="">Choose…</option>
          {fieldMeta.options.map((o) => (
            <option key={String(o.value)} value={String(o.value)}>
              {o.label}
            </option>
          ))}
        </select>
      ) : type === 'checkbox' || type === 'boolean' ? (
        <select className="input" value={value} onChange={(e) => setValue(e.target.value)}>
          <option value="">Choose…</option>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      ) : (
        <input
          className="input"
          type={type === 'number' ? 'number' : type === 'date' ? 'date' : 'text'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Value"
          autoFocus
        />
      )}
      <div className="filter-menu-actions">
        <button type="button" className="link-btn" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="btn primary sm">
          Add filter
        </button>
      </div>
    </form>
  )
}

export function EditView() {
  const { slug, id } = useParams({ strict: false }) as { slug: string; id?: string }
  const collection = useCollection(slug)
  const isNew = !id
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { user: currentUser } = useAuth()
  const [form, setForm] = useState<Record<string, unknown>>({})
  const [errors, setErrors] = useState<FieldErrorDetail[]>([])
  const [saveError, setSaveError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState(0)
  const [previewOpen, setPreviewOpen] = useState(true)
  const [versionsOpen, setVersionsOpen] = useState(false)
  const [file, setFile] = useState<File | null>(null)

  const drafts = Boolean(collection?.versions?.drafts)
  const hasVersions = Boolean(collection?.versions?.enabled)
  const isUpload = Boolean(collection?.upload)

  // For drafts collections, edit against the latest content (draft included),
  // not the published projection — otherwise unpublished edits vanish on reload.
  const { data: doc } = useQuery({
    queryKey: ['doc', slug, id, drafts],
    queryFn: () => getDoc(slug, id!, 1, drafts),
    enabled: !!id,
  })

  const status = (doc?._status as 'draft' | 'published' | undefined) ?? (isNew ? 'draft' : undefined)

  // Seed the form once per record, and only re-seed when the record's own data
  // changes — never merely because `collection` got a fresh reference (e.g. a
  // background schema refetch), which would otherwise wipe the user's unsaved input.
  const seededDoc = useRef<Doc | null>(null)
  useEffect(() => {
    if (doc && collection && seededDoc.current !== doc) {
      seededDoc.current = doc
      setForm(initialForm(collection, doc))
    }
  }, [doc, collection])

  const seededNew = useRef<string | null>(null)
  useEffect(() => {
    if (!isNew) {
      seededNew.current = null
      return
    }
    if (collection && seededNew.current !== slug) {
      seededNew.current = slug
      setForm(defaultForm(collection))
    }
  }, [isNew, slug, collection])

  const allFields = collection ? editableFields(collection) : []
  // Upload collections derive these from the file itself — don't render or send them.
  const fields = isUpload ? allFields.filter((f) => !UPLOAD_SYSTEM.has(f.name)) : allFields

  // One write path; `_status` flips draft/published for drafts collections.
  const save = useMutation({
    mutationFn: (next?: 'draft' | 'published') => {
      const payload = buildPayload(fields, form)
      if (drafts && next) payload._status = next
      // New upload docs go through the multipart upload pipeline.
      if (isUpload && isNew) {
        if (!file) return Promise.reject(new ApiError(400, 'NO_FILE', 'Choose a file to upload.'))
        return uploadFile(slug, file, payload)
      }
      return isNew ? createDoc(slug, payload) : updateDoc(slug, id!, payload)
    },
    onSuccess: (saved) => {
      setErrors([])
      setSaveError(null)
      setFile(null)
      toast(drafts && (saved._status as string) === 'published' ? 'Published' : 'Saved', 'success')
      qc.invalidateQueries({ queryKey: ['list', slug] })
      if (isNew) {
        navigate({ to: '/collections/$slug/$id', params: { slug, id: saved.id } })
      } else {
        qc.invalidateQueries({ queryKey: ['doc', slug, id] })
        qc.invalidateQueries({ queryKey: ['versions', slug, id] })
      }
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError) {
        setErrors(err.details ?? [])
        setSaveError(err.details?.length ? null : err.message)
        toast(err.details?.length ? 'Please fix the errors below' : err.message, 'error')
      } else {
        setSaveError('Failed to save.')
        toast('Failed to save', 'error')
      }
    },
  })

  const remove = useMutation({
    mutationFn: () => deleteDoc(slug, id!),
    onSuccess: () => {
      toast('Deleted', 'success')
      qc.invalidateQueries({ queryKey: ['list', slug] })
      navigate({ to: '/collections/$slug', params: { slug } })
    },
  })

  if (!collection) return <div className="page">Unknown collection “{slug}”.</div>

  const title = isNew
    ? `New ${collection.labels.singular}`
    : String((doc?.[collection.useAsTitle] as string) ?? collection.labels.singular)

  const errorFor = (name: string) => errors.find((e) => e.path === name || e.path.startsWith(`${name}.`))?.message
  const setField = (name: string) => (value: unknown) => setForm((prev) => ({ ...prev, [name]: value }))

  const sidebarFields = fields.filter((f) => f.admin?.position === 'sidebar')
  const tabs = groupTabs(fields.filter((f) => f.admin?.position !== 'sidebar'))
  const tab = tabs[Math.min(activeTab, tabs.length - 1)] ?? tabs[0]

  const busy = save.isPending
  // Live preview is for content — account records and media files skip it, and a
  // collection can opt out entirely with `admin.livePreview: false`.
  const canPreview = !collection.auth && !collection.upload && collection.livePreview !== false
  const showPreview = canPreview && previewOpen
  // You can't delete the account you're currently signed in as.
  const isOwnProfile = Boolean(collection.auth && id && currentUser && String(currentUser.id) === String(id))

  return (
    <div className={`page page-wide${showPreview ? ' page-full' : ''}`}>
      <header className="page-head">
        <div>
          <Link
            to="/collections/$slug"
            params={{ slug }}
            className="back"
            aria-label={`Back to ${collection.labels.plural}`}
          >
            <svg className="back-icon" {...ICON_SVG} width={15} height={15}>
              <path d="M19 12H5" />
              <path d="M11 18l-6-6 6-6" />
            </svg>
            <span>{collection.labels.plural}</span>
          </Link>
          <h1>
            {title}
            {drafts && status && <StatusPill status={status} />}
          </h1>
        </div>
        <div className="actions">
          {sidebarFields.map((field) => (
            <label key={field.name} className="hdr-field">
              <span className="hdr-field-label">{field.label}</span>
              <FieldInput field={field} value={form[field.name]} onChange={setField(field.name)} />
            </label>
          ))}
          {hasVersions && !isNew && (
            <button type="button" className="btn ghost" onClick={() => setVersionsOpen(true)}>
              Versions
            </button>
          )}
          {canPreview && (
            <button
              type="button"
              className={previewOpen ? 'btn ghost active' : 'btn ghost'}
              onClick={() => setPreviewOpen((v) => !v)}
              aria-pressed={previewOpen}
            >
              {previewOpen ? 'Hide preview' : 'Preview'}
            </button>
          )}
          {!isNew && !isOwnProfile && (
            <button
              className="btn danger"
              onClick={async () => {
                const ok = await confirmDialog({
                  title: `Delete this ${collection.labels.singular.toLowerCase()}?`,
                  message: 'This action cannot be undone.',
                  confirmLabel: 'Delete',
                  danger: true,
                })
                if (ok) remove.mutate()
              }}
            >
              Delete
            </button>
          )}
          {drafts ? (
            <>
              {status === 'published' && !isNew && (
                <button className="btn ghost" disabled={busy} onClick={() => save.mutate('draft')}>
                  Unpublish
                </button>
              )}
              <button className="btn" disabled={busy} onClick={() => save.mutate('draft')}>
                {busy ? 'Saving…' : 'Save draft'}
              </button>
              <button className="btn primary" disabled={busy} onClick={() => save.mutate('published')}>
                {busy ? 'Saving…' : status === 'published' ? 'Publish changes' : 'Publish'}
              </button>
            </>
          ) : (
            <button
              className="btn primary"
              disabled={busy || (isUpload && isNew && !file)}
              onClick={() => save.mutate(undefined)}
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
          )}
        </div>
      </header>

      {versionsOpen && id && (
        <VersionsPanel
          slug={slug}
          id={id}
          drafts={drafts}
          onClose={() => setVersionsOpen(false)}
          onRestored={() => {
            qc.invalidateQueries({ queryKey: ['doc', slug, id] })
            qc.invalidateQueries({ queryKey: ['list', slug] })
          }}
        />
      )}

      {saveError && <div className="alert">{saveError}</div>}
      {errors.length > 0 && (
        <div className="alert">
          <strong>Couldn’t save. Please fix:</strong>
          <ul className="err-list">
            {errors.map((e, i) => (
              <li key={i}>
                <span className="err-path">{friendlyPath(e.path)}</span>: {e.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className={`editor-shell${showPreview ? ' with-preview' : ''}`}>
        <div className="editor-fields">
          {isUpload && (
            <UploadZone
              file={file}
              existingUrl={(doc?.url as string) ?? null}
              filename={(doc?.filename as string) ?? null}
              onPick={setFile}
            />
          )}
          {tabs.length > 1 && (
            <div className="tabs">
              {tabs.map((t, i) => (
                <button
                  key={t.name}
                  type="button"
                  className={i === activeTab ? 'tab active' : 'tab'}
                  onClick={() => setActiveTab(i)}
                >
                  {t.name}
                </button>
              ))}
            </div>
          )}
          <motion.div className="form" key={tab?.name} variants={listContainer} initial="initial" animate="animate">
            {(tab?.fields ?? []).map((field) => (
              <motion.div key={field.name} variants={itemVariants}>
                <FieldRow
                  field={field}
                  value={form[field.name]}
                  onChange={setField(field.name)}
                  error={errorFor(field.name)}
                />
              </motion.div>
            ))}
          </motion.div>
        </div>
        {showPreview && (
          <LivePreview slug={slug} form={form} url={collection.livePreview ? collection.livePreview.url : undefined} />
        )}
      </div>
    </div>
  )
}

function StatusPill({ status }: { status: 'draft' | 'published' }) {
  return <span className={`pill pill-${status}`}>{status === 'published' ? 'Published' : 'Draft'}</span>
}

function isImageName(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(name)
}

function UploadZone({
  file,
  existingUrl,
  filename,
  onPick,
}: {
  file: File | null
  existingUrl: string | null
  filename: string | null
  onPick: (f: File | null) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const stagedUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file])
  useEffect(
    () => () => {
      if (stagedUrl) URL.revokeObjectURL(stagedUrl)
    },
    [stagedUrl],
  )

  const previewUrl = stagedUrl ?? existingUrl
  const showImage = file ? file.type.startsWith('image/') : existingUrl && filename ? isImageName(filename) : false
  const label = file?.name ?? filename ?? null

  return (
    <div className="upload-zone">
      {previewUrl && showImage ? (
        <img className="upload-preview" src={previewUrl} alt={label ?? 'Upload preview'} />
      ) : (
        <div className="upload-icon" aria-hidden>
          {label ? '📄' : '⬆'}
        </div>
      )}
      <div className="upload-meta">
        <div className="upload-name">{label ?? 'No file selected'}</div>
        <button type="button" className="btn ghost" onClick={() => inputRef.current?.click()}>
          {label ? 'Replace file' : 'Choose file'}
        </button>
      </div>
      <input
        ref={inputRef}
        type="file"
        className="upload-input"
        onChange={(e) => onPick(e.target.files?.[0] ?? null)}
      />
    </div>
  )
}

function formatStamp(value: unknown): string {
  if (typeof value !== 'string') return ''
  const ms = Date.parse(value)
  if (Number.isNaN(ms)) return value
  const d = new Date(ms)
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

function VersionsPanel({
  slug,
  id,
  drafts,
  onClose,
  onRestored,
}: {
  slug: string
  id: string
  drafts: boolean
  onClose: () => void
  onRestored: () => void
}) {
  const qc = useQueryClient()
  const [closing, setClosing] = useState(false)
  const requestClose = useCallback(() => {
    setClosing(true)
    setTimeout(onClose, 180)
  }, [onClose])

  const { data, isLoading } = useQuery({
    queryKey: ['versions', slug, id],
    queryFn: () => listVersions(slug, id, { limit: 50 }),
  })

  const restore = useMutation({
    mutationFn: (versionId: string) => restoreVersion(slug, id, versionId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['versions', slug, id] })
      onRestored()
      requestClose()
    },
  })

  const versions = data?.docs ?? []

  return (
    <div className={closing ? 'modal-backdrop closing' : 'modal-backdrop'} onClick={requestClose}>
      <div
        className="modal versions-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Version history"
      >
        <header className="modal-head">
          <h2>Version history</h2>
          <button type="button" className="btn ghost" onClick={requestClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="versions-body">
          {isLoading && <p className="muted">Loading…</p>}
          {!isLoading && versions.length === 0 && <p className="muted">No versions yet.</p>}
          {versions.length > 0 && (
            <ul className="versions-list">
              {versions.map((v: VersionEntry, i: number) => (
                <li key={v.id} className="version-row">
                  <div className="version-meta">
                    <span className="version-when">{formatStamp(v.updatedAt ?? v.createdAt)}</span>
                    {drafts && <StatusPill status={v.status} />}
                    {i === 0 && <span className="version-tag">latest</span>}
                  </div>
                  <button
                    type="button"
                    className="btn ghost"
                    disabled={restore.isPending}
                    onClick={() => restore.mutate(v.id)}
                  >
                    Restore
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

export function GlobalView() {
  const { slug } = useParams({ strict: false }) as { slug: string }
  const global = useGlobal(slug)
  const qc = useQueryClient()
  const [form, setForm] = useState<Record<string, unknown>>({})
  const [errors, setErrors] = useState<FieldErrorDetail[]>([])
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const { data: doc } = useQuery({ queryKey: ['global', slug], queryFn: () => getGlobal(slug) })

  useEffect(() => {
    if (doc) {
      const next: Record<string, unknown> = {}
      for (const f of global?.fields ?? []) next[f.name] = doc[f.name] ?? (f.hasMany ? [] : null)
      setForm(withRowKeys(global?.fields ?? [], next))
    }
  }, [doc, global])

  const save = useMutation({
    mutationFn: () => updateGlobal(slug, buildPayload(global?.fields ?? [], form)),
    onSuccess: () => {
      setErrors([])
      setSaveError(null)
      setSaved(true)
      qc.invalidateQueries({ queryKey: ['global', slug] })
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError) {
        setErrors(err.details ?? [])
        setSaveError(err.details?.length ? null : err.message)
      } else {
        setSaveError('Failed to save.')
      }
    },
  })

  if (!global) return <div className="page">Unknown global “{slug}”.</div>
  const errorFor = (name: string) => errors.find((e) => e.path === name)?.message

  return (
    <div className="page">
      <header className="page-head">
        <h1>{global.label}</h1>
        <button className="btn primary" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
      </header>
      {saveError && <div className="alert">{saveError}</div>}
      {saved && !saveError && <div className="ok">Saved.</div>}
      <motion.div className="form" variants={listContainer} initial="initial" animate="animate">
        {global.fields.map((field) => (
          <motion.div className="field" key={field.name} variants={itemVariants}>
            <label className="field-label">
              {field.label}
              {field.required && <span className="req">*</span>}
            </label>
            <FieldInput
              field={field}
              value={form[field.name]}
              onChange={(value) => setForm((prev) => ({ ...prev, [field.name]: value }))}
            />
            {errorFor(field.name) && <div className="field-error">{errorFor(field.name)}</div>}
          </motion.div>
        ))}
      </motion.div>
    </div>
  )
}
