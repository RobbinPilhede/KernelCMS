/**
 * `kernel doctor` — a config + environment health check. It walks the resolved
 * config and reports misconfigurations a developer should fix before shipping:
 * insecure secrets, upload collections with no storage, relationships to unknown
 * collections, collections with no read access, and more. Pure over the config
 * (apart from reading NODE_ENV), so it is deterministic and fully testable.
 */
import type { AnyField, ConfigField, SanitizedConfig } from './types'
import { DEV_SECRET } from './config'
import { effectiveFields } from './fields'

export type DiagnosticLevel = 'error' | 'warn' | 'info'

export interface Diagnostic {
  level: DiagnosticLevel
  code: string
  message: string
  collection?: string
}

export interface DoctorReport {
  diagnostics: Diagnostic[]
  errors: number
  warnings: number
  ok: boolean
}

/** Recursively collect relationship/upload targets so nested fields are checked too. */
function walkRelations(fields: ConfigField[], visit: (field: AnyField & { relationTo: string }) => void): void {
  for (const field of effectiveFields(fields)) {
    if ((field.type === 'relationship' || field.type === 'upload') && typeof field.relationTo === 'string') {
      visit(field as AnyField & { relationTo: string })
    }
    if (field.type === 'array' || field.type === 'group') walkRelations(field.fields, visit)
    if (field.type === 'blocks') for (const block of field.blocks) walkRelations(block.fields, visit)
  }
}

export interface DoctorOptions {
  /** Defaults to process.env.NODE_ENV. Production escalates some warnings to errors. */
  env?: string
}

export function runDoctor(config: SanitizedConfig, options: DoctorOptions = {}): DoctorReport {
  const env = options.env ?? process.env.NODE_ENV ?? 'development'
  const isProd = env === 'production'
  const out: Diagnostic[] = []
  const add = (level: DiagnosticLevel, code: string, message: string, collection?: string) =>
    out.push(collection ? { level, code, message, collection } : { level, code, message })

  const slugs = new Set(config.collections.map((c) => c.slug))

  // Secret hygiene.
  if (config.secret === DEV_SECRET) {
    add(
      isProd ? 'error' : 'warn',
      'insecure-secret',
      'No `secret`/KERNEL_SECRET set — using the insecure development secret.',
    )
  } else if (config.secret.length < 16) {
    add('warn', 'weak-secret', 'Configured `secret` is short (<16 chars); use a long random value.')
  }

  // Storage presence for upload collections.
  const hasStorage = Boolean(config.storage)
  const uploadCollections = config.collections.filter((c) => c.upload)
  if (uploadCollections.length > 0 && !hasStorage) {
    for (const c of uploadCollections) {
      add(
        'error',
        'upload-no-storage',
        `Upload collection "${c.slug}" has no storage adapter (config.storage).`,
        c.slug,
      )
    }
  }

  // Relationship/upload targets must exist.
  for (const c of config.collections) {
    walkRelations(c.fields, (field) => {
      if (!slugs.has(field.relationTo)) {
        add(
          'error',
          'unknown-relation',
          `Field "${field.name}" references unknown collection "${field.relationTo}".`,
          c.slug,
        )
      }
    })

    // No declared access ⇒ default-deny: usually a mistake for content meant to be public.
    if (!c.access || Object.keys(c.access).length === 0) {
      add('info', 'no-access', `Collection "${c.slug}" declares no access rules (defaults to deny).`, c.slug)
    }

    // useAsTitle must point at a real field.
    const useAsTitle = c.admin?.useAsTitle
    if (useAsTitle && useAsTitle !== 'id' && !effectiveFields(c.fields).some((f) => f.name === useAsTitle)) {
      add('warn', 'bad-use-as-title', `admin.useAsTitle "${useAsTitle}" is not a field on "${c.slug}".`, c.slug)
    }
  }

  // Admin needs an auth collection to log in.
  if (!config.collections.some((c) => c.auth)) {
    add('warn', 'no-auth-collection', 'No auth collection configured — the admin panel has no way to sign in.')
  }

  // Cache wiring.
  if (config.cache && config.cacheableSlugs.length === 0) {
    add('warn', 'cache-unused', 'A cache adapter is configured but no collection sets `cache` — it has no effect.')
  }
  for (const c of config.collections) {
    if (c.cache && !config.cache) {
      add(
        'warn',
        'cache-no-adapter',
        `Collection "${c.slug}" sets \`cache\` but no \`config.cache\` adapter is set.`,
        c.slug,
      )
    }
    if (c.cache && c.auth) {
      add('info', 'cache-auth-skipped', `Auth collection "${c.slug}" is never cached (fresh reads required).`, c.slug)
    }
  }

  // Search wiring.
  if (config.search && Object.keys(config.searchableFields).length === 0) {
    add('warn', 'search-unused', 'A search adapter is configured but no collection sets `search.fields`.')
  }
  for (const c of config.collections) {
    if (c.search && !config.search) {
      add(
        'warn',
        'search-no-adapter',
        `Collection "${c.slug}" sets \`search\` but no \`config.search\` adapter is set.`,
        c.slug,
      )
    }
  }

  // Webhook hygiene: plaintext delivery and unsigned payloads are risky.
  for (const w of config.webhooks ?? []) {
    if (w.url.startsWith('http://')) {
      add('warn', 'webhook-insecure', `Webhook to "${w.url}" uses plaintext HTTP; prefer HTTPS.`)
    }
    if (!w.secret) {
      add('info', 'webhook-unsigned', `Webhook to "${w.url}" has no secret; the receiver cannot verify the payload.`)
    }
  }

  const errors = out.filter((d) => d.level === 'error').length
  const warnings = out.filter((d) => d.level === 'warn').length
  return { diagnostics: out, errors, warnings, ok: errors === 0 }
}

/** Human-readable report for the CLI. */
export function formatDoctorReport(report: DoctorReport): string {
  if (report.diagnostics.length === 0) return '✓ No issues found.'
  const icon = { error: '✖', warn: '⚠', info: 'ℹ' } as const
  const lines = report.diagnostics.map(
    (d) => `${icon[d.level]} [${d.code}]${d.collection ? ` (${d.collection})` : ''} ${d.message}`,
  )
  lines.push('', `${report.errors} error(s), ${report.warnings} warning(s).`)
  return lines.join('\n')
}
