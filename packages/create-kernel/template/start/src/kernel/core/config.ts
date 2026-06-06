import type {
  AnyField,
  CollectionConfig,
  GlobalConfig,
  KernelConfig,
  SanitizedConfig,
  SanitizedLocalization,
} from './types'

/** Inject email + password-hash fields into auth-enabled collections. */
function withAuthFields(collection: CollectionConfig): CollectionConfig {
  const fields: AnyField[] = [...collection.fields]
  if (!fields.some((f) => f.name === 'email')) {
    fields.unshift({ name: 'email', type: 'email', required: true, unique: true, index: true })
  }
  if (!fields.some((f) => f.name === 'hash')) {
    fields.push({ name: 'hash', type: 'text', admin: { hidden: true } })
  }
  return { ...collection, fields }
}

const IDENT_RE = /^[a-z][a-z0-9_]*$/

/** Identity helper that gives `kernel.config.ts` full type-checking and inference. */
export function defineConfig(config: KernelConfig): KernelConfig {
  return config
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`KernelCMS config error: ${message}`)
}

function validateCollection(collection: CollectionConfig): void {
  assert(IDENT_RE.test(collection.slug), `collection slug "${collection.slug}" must be snake_case starting with a letter`)
  const seen = new Set<string>()
  for (const field of collection.fields) {
    assert(IDENT_RE.test(field.name), `field "${field.name}" in "${collection.slug}" must be snake_case`)
    assert(!seen.has(field.name), `duplicate field "${field.name}" in collection "${collection.slug}"`)
    seen.add(field.name)
  }
}

function validateGlobal(global: GlobalConfig): void {
  assert(IDENT_RE.test(global.slug), `global slug "${global.slug}" must be snake_case starting with a letter`)
}

export function sanitizeConfig(config: KernelConfig): SanitizedConfig {
  assert(config.db, 'a database adapter is required (config.db)')
  assert(Array.isArray(config.collections), 'config.collections must be an array')

  const collections = config.collections.map((c) => (c.auth ? withAuthFields(c) : c))
  const globals = config.globals ?? []

  const collectionsBySlug: Record<string, CollectionConfig> = {}
  for (const collection of collections) {
    validateCollection(collection)
    assert(!collectionsBySlug[collection.slug], `duplicate collection slug "${collection.slug}"`)
    collectionsBySlug[collection.slug] = collection
  }

  const globalsBySlug: Record<string, GlobalConfig> = {}
  for (const global of globals) {
    validateGlobal(global)
    assert(!globalsBySlug[global.slug], `duplicate global slug "${global.slug}"`)
    assert(!collectionsBySlug[global.slug], `global "${global.slug}" collides with a collection slug`)
    globalsBySlug[global.slug] = global
  }

  let localization: SanitizedLocalization | false = false
  if (config.localization) {
    const { locales, defaultLocale, fallback } = config.localization
    assert(locales.length > 0, 'localization.locales must not be empty')
    assert(locales.includes(defaultLocale), `localization.defaultLocale "${defaultLocale}" must be in locales`)
    localization = { locales, defaultLocale, fallback: fallback ?? true }
  }

  const secret =
    config.secret ?? process.env.KERNEL_SECRET ?? devSecret()

  const adminUser =
    config.admin?.user ??
    collections.find((c) => c.auth)?.slug ??
    'users'

  return {
    serverURL: config.serverURL ?? 'http://localhost:3000',
    db: config.db,
    collections,
    globals,
    localization,
    routes: { api: config.routes?.api ?? '/api' },
    admin: { user: adminUser },
    secret,
    collectionsBySlug,
    globalsBySlug,
  }
}

let warned = false
function devSecret(): string {
  if (!warned) {
    warned = true
    // eslint-disable-next-line no-console
    console.warn(
      '[KernelCMS] No `secret` or KERNEL_SECRET set — using an insecure development secret. Set KERNEL_SECRET in production.',
    )
  }
  return 'kernel-dev-insecure-secret-do-not-use-in-production'
}

export function defaultLocaleOf(config: SanitizedConfig): string {
  return config.localization ? config.localization.defaultLocale : 'en'
}
