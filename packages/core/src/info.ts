/**
 * System overview — a runtime embodiment of the foundation/product-overview
 * (track 00): a single, honest summary of what this KernelCMS instance is, derived
 * purely from the resolved config. Powers `kernel info` and the `/` API descriptor.
 */
import type { Kernel } from './types'
import { DEV_SECRET, JOBS_SLUG } from './config'

/** Published engine version. Bump in lockstep with the `kernelcms` package. */
export const KERNEL_VERSION = '0.2.4'

/**
 * Non-sensitive runtime facts for the first-run welcome screen. Deliberately only
 * booleans / enums / counts — never paths, connection strings, or secret values —
 * so it is safe to surface to the local operator during first-run setup.
 */
export interface SetupRuntime {
  /** Database adapter in use, e.g. 'sqlite' or 'postgres'. */
  db: string
  /** A real signing secret is configured (not the public development default). */
  secretSet: boolean
  /** A storage adapter is configured (uploads persist somewhere durable). */
  storage: boolean
  /** An email adapter is configured (password reset / verification can send mail). */
  email: boolean
  /** Number of content collections the user defined (excludes system collections). */
  collections: number
  /** A cache adapter is configured (read-through caching is available). */
  cache: boolean
  /** Node.js version the server is running on. */
  node: string
  /** KernelCMS engine version. */
  version: string
}

/**
 * Connector inventory for the admin "Connectors" panel: which database, storage,
 * email, OAuth, and image adapters are wired up. Non-sensitive (kinds + booleans
 * + provider names only). Surfaced to authenticated admins.
 */
export interface ConnectorStatus {
  db: string
  storage: { configured: boolean; kind: string | null }
  email: { configured: boolean; kind: string | null }
  oauth: string[]
  image: boolean
  /** Configured cache adapter kind ('memory' | 'database' | 'redis'), or null. */
  cache: { configured: boolean; kind: string | null }
  /** Configured search adapter kind, or null. */
  search: { configured: boolean; kind: string | null }
}

export function connectorStatus(kernel: Kernel): ConnectorStatus {
  const cfg = kernel.config
  const nameOf = (a: unknown): string | null =>
    a && typeof a === 'object' && typeof (a as { name?: unknown }).name === 'string'
      ? (a as { name: string }).name
      : null
  let storageKind: string | null = null
  if (cfg.storage) {
    storageKind =
      typeof (cfg.storage as { put?: unknown }).put === 'function' ? (nameOf(cfg.storage) ?? 'storage') : 'multiple'
  }
  return {
    db: nameOf(cfg.db) ?? 'unknown',
    storage: { configured: Boolean(cfg.storage), kind: storageKind },
    email: { configured: Boolean(cfg.email), kind: cfg.email ? (nameOf(cfg.email) ?? 'email') : null },
    oauth: (cfg.oauth ?? []).map((p) => p.name),
    image: Boolean(cfg.image),
    cache: { configured: Boolean(cfg.cache), kind: cfg.cache ? (nameOf(cfg.cache) ?? 'cache') : null },
    search: { configured: Boolean(cfg.search), kind: cfg.search ? (nameOf(cfg.search) ?? 'search') : null },
  }
}

export function setupRuntime(kernel: Kernel): SetupRuntime {
  const cfg = kernel.config
  const dbName = (cfg.db as { name?: string }).name ?? 'unknown'
  return {
    db: dbName,
    secretSet: cfg.secret !== DEV_SECRET,
    storage: Boolean(cfg.storage),
    email: Boolean(cfg.email),
    collections: cfg.collections.filter((c) => c.slug !== JOBS_SLUG).length,
    cache: Boolean(cfg.cache),
    node: typeof process !== 'undefined' && process.version ? process.version : '',
    version: KERNEL_VERSION,
  }
}

export interface CollectionInfo {
  slug: string
  auth: boolean
  upload: boolean
  versions: boolean
  drafts: boolean
  fields: number
}

export interface SystemInfo {
  name: 'KernelCMS'
  version: string
  collections: CollectionInfo[]
  globals: string[]
  capabilities: {
    auth: boolean
    apiKeys: boolean
    uploads: boolean
    versions: boolean
    drafts: boolean
    storage: boolean
    localization: boolean
    cache: boolean
    search: boolean
  }
}

export function systemInfo(kernel: Kernel): SystemInfo {
  const cfg = kernel.config
  const isAuth = (c: (typeof cfg.collections)[number]) => Boolean(c.auth)
  const versionsOf = (c: (typeof cfg.collections)[number]) =>
    c.versions === true
      ? { enabled: true, drafts: false }
      : c.versions
        ? { enabled: true, drafts: Boolean(c.versions.drafts) }
        : { enabled: false, drafts: false }

  const collections: CollectionInfo[] = cfg.collections.map((c) => {
    const v = versionsOf(c)
    return {
      slug: c.slug,
      auth: isAuth(c),
      upload: Boolean(c.upload),
      versions: v.enabled,
      drafts: v.drafts,
      fields: c.fields.length,
    }
  })

  return {
    name: 'KernelCMS',
    version: KERNEL_VERSION,
    collections,
    globals: cfg.globals.map((g) => g.slug),
    capabilities: {
      auth: cfg.collections.some(isAuth),
      apiKeys: cfg.collections.some((c) => typeof c.auth === 'object' && Boolean(c.auth.useAPIKey)),
      uploads: cfg.collections.some((c) => Boolean(c.upload)),
      versions: cfg.collections.some((c) => versionsOf(c).enabled),
      drafts: cfg.collections.some((c) => versionsOf(c).drafts),
      storage: Boolean(cfg.storage),
      localization: Boolean(cfg.localization),
      cache: Boolean(cfg.cache),
      search: Boolean(cfg.search),
    },
  }
}

/** Human-readable overview for the CLI. */
export function formatSystemInfo(info: SystemInfo): string {
  const caps = Object.entries(info.capabilities)
    .filter(([, on]) => on)
    .map(([k]) => k)
  const lines = [
    `${info.name} v${info.version}`,
    `Collections (${info.collections.length}):`,
    ...info.collections.map(
      (c) =>
        `  • ${c.slug} — ${c.fields} field(s)${[
          c.auth && 'auth',
          c.upload && 'upload',
          c.drafts ? 'drafts' : c.versions && 'versions',
        ]
          .filter(Boolean)
          .map((t) => ` · ${t}`)
          .join('')}`,
    ),
    `Globals (${info.globals.length}): ${info.globals.join(', ') || '(none)'}`,
    `Capabilities: ${caps.join(', ') || '(none)'}`,
  ]
  return lines.join('\n')
}
