/**
 * System overview — a runtime embodiment of the foundation/product-overview
 * (track 00): a single, honest summary of what this KernelCMS instance is, derived
 * purely from the resolved config. Powers `kernel info` and the `/` API descriptor.
 */
import type { Kernel } from './types'

/** Published engine version. Bump in lockstep with the `kernelcms` package. */
export const KERNEL_VERSION = '0.2.1'

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
