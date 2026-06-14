import type { Row } from '@kernel/db'
import type { CollectionConfig, ContentTemplateConfig, KernelConfig, SanitizedTemplate } from './types'

/** A safe snake_case identifier (matches the rest of the config's slug rule). */
const TEMPLATE_SLUG_RE = /^[a-z][a-z0-9_]*$/

/** Keys that must never appear in template/override data — copying one onto an object
 *  literal (or merging it) would poison `Object.prototype` (prototype pollution). */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Deep-clone + deep-FREEZE a trusted template `data` blob, rejecting any prototype-
 * pollution key at every level it copies. The result is structurally identical to the
 * input but immutable, so a runtime caller can never mutate the shared config (each
 * `createFromTemplate` clones AGAIN before merging untrusted overrides). Arrays are
 * cloned + frozen element-wise; plain objects key-by-key; primitives pass through.
 */
export function freezeTemplateData(
  value: unknown,
  assert: (condition: unknown, message: string) => asserts condition,
  path = 'data',
): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item, i) => freezeTemplateData(item, assert, `${path}[${i}]`)))
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value)) {
      assert(!FORBIDDEN_KEYS.has(key), `template ${path} uses an illegal key "${key}"`)
      out[key] = freezeTemplateData((value as Record<string, unknown>)[key], assert, `${path}.${key}`)
    }
    return Object.freeze(out)
  }
  return value
}

/**
 * Validate + resolve the opt-in content templates. OFF (empty) unless configured — so when
 * absent NOTHING changes. Each template needs a unique snake_case `slug`, a `collection`
 * that is a real, non-system collection, and a plain-object `data` blob (no prototype-
 * pollution keys at any level). The `data` is deep-cloned + frozen so the stored skeleton
 * can never be mutated by a runtime caller. Returns the resolved templates AND a slug index.
 */
export function sanitizeTemplates(
  templates: KernelConfig['templates'],
  collectionsBySlug: Record<string, CollectionConfig>,
  systemSlugs: ReadonlySet<string>,
  assert: (condition: unknown, message: string) => asserts condition,
): { templates: SanitizedTemplate[]; templatesBySlug: Record<string, SanitizedTemplate> } {
  const resolved: SanitizedTemplate[] = []
  const templatesBySlug: Record<string, SanitizedTemplate> = {}
  if (!templates || templates.length === 0) return { templates: resolved, templatesBySlug }

  const seen = new Set<string>()
  for (const entry of templates as ContentTemplateConfig[]) {
    assert(
      typeof entry.slug === 'string' && TEMPLATE_SLUG_RE.test(entry.slug),
      `template slug "${entry.slug}" must be snake_case (lowercase letter, then letters/digits/underscores)`,
    )
    // A slug becomes a lookup key; reject pollution keys explicitly (belt-and-braces over
    // the regex, which already excludes them, so the index can never be poisoned).
    assert(!FORBIDDEN_KEYS.has(entry.slug), `template slug "${entry.slug}" is a reserved key`)
    assert(!seen.has(entry.slug), `duplicate template slug "${entry.slug}"`)
    seen.add(entry.slug)
    assert(
      typeof entry.collection === 'string' &&
        Boolean(collectionsBySlug[entry.collection]) &&
        !systemSlugs.has(entry.collection),
      `template "${entry.slug}" references unknown collection "${entry.collection}"`,
    )
    assert(
      Boolean(entry.data) && typeof entry.data === 'object' && !Array.isArray(entry.data),
      `template "${entry.slug}" \`data\` must be a plain object`,
    )
    const data = freezeTemplateData(entry.data, assert) as Record<string, unknown>
    const template: SanitizedTemplate = {
      slug: entry.slug,
      collection: entry.collection,
      ...(entry.name !== undefined ? { name: entry.name } : {}),
      ...(entry.description !== undefined ? { description: entry.description } : {}),
      data,
    }
    resolved.push(template)
    templatesBySlug[template.slug] = template
  }
  return { templates: resolved, templatesBySlug }
}

/**
 * Deep-merge a TRUSTED template `data` (frozen config) with an UNTRUSTED caller override,
 * caller-wins. Nested plain objects are merged recursively; arrays + primitives are
 * REPLACED wholesale by the caller's value (so an override `layout` swaps the whole list,
 * never a positional splice). Every key copied from the override is guarded against
 * prototype pollution — a `__proto__`/`constructor`/`prototype` key throws. The template
 * side is already pollution-free (validated at sanitize) and is deep-cloned here so the
 * frozen config is never returned or mutated. Returns a fresh, null-proto-safe object.
 */
export function mergeTemplateData(base: Record<string, unknown>, override: Record<string, unknown> | undefined): Row {
  const guard = (key: string): void => {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new TemplateMergeError(`Illegal data key "${key}".`)
    }
  }
  const cloneTrusted = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(cloneTrusted)
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(value)) out[key] = cloneTrusted((value as Record<string, unknown>)[key])
      return out
    }
    return value
  }
  const merge = (a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(a)) out[key] = cloneTrusted(a[key])
    for (const key of Object.keys(b)) {
      guard(key)
      const bv = b[key]
      const av = out[key]
      if (av && typeof av === 'object' && !Array.isArray(av) && bv && typeof bv === 'object' && !Array.isArray(bv)) {
        out[key] = merge(av as Record<string, unknown>, bv as Record<string, unknown>)
      } else {
        out[key] = cloneTrusted(bv)
      }
    }
    return out
  }
  return merge(base, override ?? {}) as Row
}

/** Thrown when a template-data merge encounters a prototype-pollution key. Carried as a
 *  distinct class so the ops layer can surface it as a clean 400 (BadRequest). */
export class TemplateMergeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TemplateMergeError'
  }
}
