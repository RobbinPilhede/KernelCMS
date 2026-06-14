/**
 * schema.org JSON-LD generation from the typed content model.
 *
 * A sibling of the discoverability / GEO layer (`discoverability.ts`): it emits a single
 * document as a schema.org JSON-LD object (and an embeddable `<script type="application/
 * ld+json">`) so search engines AND AI answer engines parse the content with explicit
 * semantics. It mirrors that layer's security model exactly.
 *
 * SECURITY — the properties that matter:
 *
 *  1. ACCESS. Every build reads the document through the real, access-checked `find` path
 *     with the CALLER's principal (typically anonymous for public SEO embedding; never
 *     `overrideAccess` from an untrusted boundary). A draft (drafts-enabled collections are
 *     published-only through `find`), a private/owner-scoped doc the caller can't read, and
 *     a read-denied FIELD are all filtered by that pipeline before we ever see the document
 *     — so they can never appear in the JSON-LD. We only ever read VALUES off the
 *     access-stripped document `find` returns.
 *
 *  2. SCRIPT EMBEDDING. `jsonLdScript` serializes the object to JSON and HTML-escapes
 *     `<`/`>`/`&` (so `</script>` and any `<…>` in document content become entity refs),
 *     meaning untrusted content can never break out of the `<script>` tag — closing the
 *     classic JSON-LD XSS vector.
 *
 *  3. URL SAFETY. The canonical `@id` is built from the trusted `baseUrl` + (trusted)
 *     `urlPattern`, substituting only SAFELY-ENCODED doc field values (mirrors
 *     discoverability's `safeSegment`) — no `javascript:` scheme injection, no `../`
 *     traversal.
 *
 *  4. NO PROTOTYPE POLLUTION. The output object is null-prototype and `__proto__`/
 *     `constructor`/`prototype` property keys are skipped (defence in depth; sanitize
 *     already rejects them in an explicit `mapping`).
 */
import type { KernelRichText } from '@kernel/richtext'
import { toPlainText } from '@kernel/richtext'
import type {
  AnyField,
  CollectionConfig,
  Doc,
  FindOptions,
  JsonLdOptions,
  JsonLdScriptOptions,
  SanitizedConfig,
  StructuredDataCollectionConfig,
} from './types'
import type { PaginatedResult } from '@kernel/db'
import { effectiveFields } from './fields'
import { ForbiddenError } from './errors'

/** The single op this layer needs — the access-checked read path. Called with the
 *  CALLER's principal (typically anonymous), never with `overrideAccess` from an
 *  untrusted boundary. */
export interface StructuredDataDeps {
  find<T extends Doc = Doc>(opts: FindOptions): Promise<PaginatedResult<T>>
}

/** Property names that must never become output object keys (prototype pollution). */
const FORBIDDEN_PROPERTY_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** Truncate the auto-derived `description` so a huge body can't bloat the JSON-LD. */
const DESCRIPTION_MAX = 300

/** Collection slugs an author-ish relationship resolves a `Person` from — matched by the
 *  related collection's slug to keep the heuristic conservative. */
const AUTHOR_SLUGS = new Set(['authors', 'author', 'users', 'people', 'person'])

interface ResolvedTarget {
  collection: CollectionConfig
  entry: StructuredDataCollectionConfig
}

function isRichText(value: unknown): value is KernelRichText {
  return Boolean(value) && typeof value === 'object' && (value as { type?: unknown }).type === 'doc'
}

/** Resolve a configured collection slug to its target (collection + entry), or null. */
function resolveTarget(config: SanitizedConfig, slug: string): ResolvedTarget | null {
  const entry = config.structuredData.collections.find((c) => c.slug === slug)
  if (!entry) return null
  const collection = config.collectionsBySlug[entry.slug]
  if (!collection) return null
  return { collection, entry }
}

// ── URL building (injection-safe — mirrors discoverability.ts) ──────────────────

/** Encode a doc-derived segment so it can never inject a scheme or traverse. Slashes pass
 *  (a slug may be a nested path); `.`/`..` dot-segments are dropped. */
function safeSegment(value: unknown): string {
  return encodeURIComponent(String(value ?? ''))
    .replace(/%2F/gi, '/')
    .split('/')
    .filter(
      (seg) => seg !== '.' && seg !== '..' && seg.replace(/%2E/gi, '.') !== '.' && seg.replace(/%2E/gi, '.') !== '..',
    )
    .join('/')
}

/** Build a document's canonical URL from the trusted `baseUrl` + (trusted) `urlPattern`,
 *  substituting `:token` placeholders with SAFELY-ENCODED field values. `:id` → the doc id. */
function buildUrl(doc: Doc, target: ResolvedTarget, baseUrl: string): string {
  const pattern = target.entry.urlPattern ?? `/${target.collection.slug}/:id`
  const path = pattern.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, token: string) => {
    if (token === 'id') return safeSegment(doc.id)
    return safeSegment(doc[token])
  })
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${baseUrl}${normalizedPath}`
}

// ── value coercion ──────────────────────────────────────────────────────────────

/** Coerce a field value to a JSON-LD-safe scalar/object, or null when there's nothing to
 *  emit. richText → plain text; dates → ISO strings; everything else is preserved as-is for
 *  primitives. Returns null for empty strings so empty props are omitted. */
function coerceValue(value: unknown, field: AnyField | undefined): unknown {
  if (value == null) return null
  if (isRichText(value)) {
    const text = toPlainText(value).trim()
    return text.length > 0 ? text : null
  }
  if (field?.type === 'date') {
    const iso = toIso(value)
    return iso ?? null
  }
  if (typeof value === 'string') {
    const s = value.trim()
    return s.length > 0 ? s : null
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value
  // Anything structural (objects/arrays) is not safe to blindly inline as a schema.org
  // property — skip it rather than guess a shape.
  return null
}

/** Coerce a date-ish value to an ISO-8601 string, or null when it isn't a valid date. */
function toIso(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  if (typeof value === 'number') {
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  if (typeof value === 'string') {
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  return null
}

/** Pull an image URL out of an upload/relationship value (a populated doc carries `url`),
 *  safely. Returns null when there's no usable, safe URL. */
function imageUrlOf(value: unknown): string | null {
  const candidate =
    typeof value === 'string'
      ? value
      : value && typeof value === 'object'
        ? (value as { url?: unknown }).url
        : undefined
  if (typeof candidate !== 'string' || candidate.trim().length === 0) return null
  return safeUrl(candidate.trim())
}

/** Allow only http(s) (absolute) or root/relative URLs; reject scheme-injection vectors
 *  (`javascript:`, `data:`, etc.). Returns null when unsafe. */
function safeUrl(url: string): string | null {
  if (/^https?:\/\//i.test(url)) return url
  if (url.startsWith('/')) return url
  // A bare value with a scheme-like prefix (e.g. `javascript:…`) is rejected.
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return null
  return url
}

/** Resolve an author-ish relationship value into a schema.org `Person` (or `Organization`
 *  fallback shape via `name`), or null. The related doc was populated through the access
 *  pipeline, so a hidden author simply isn't there. */
function authorOf(value: unknown, field: AnyField | undefined): unknown {
  if (!field || (field.type !== 'relationship' && field.type !== 'upload')) return null
  const relTo = field.relationTo
  const slugs = Array.isArray(relTo) ? relTo : [relTo]
  const isAuthorish = slugs.some((s) => AUTHOR_SLUGS.has(String(s)))
  if (!isAuthorish) return null
  const first = Array.isArray(value) ? value[0] : value
  if (!first || typeof first !== 'object') return null
  const name = nameFromDoc(first as Doc)
  if (!name) return null
  return { '@type': 'Person', name }
}

/** A human-readable name from a (related author) doc: its `name`/`title`/`fullName`/etc. */
function nameFromDoc(doc: Doc): string | null {
  for (const key of ['name', 'title', 'fullName', 'displayName']) {
    const v = doc[key]
    if (typeof v === 'string' && v.trim().length > 0) return v.trim()
  }
  return null
}

// ── smart-default mapping ─────────────────────────────────────────────────────

/**
 * The schema.org property → field-name plan for a collection, derived by field name/type
 * when no explicit `mapping` is configured. Explicit `mapping` always overrides these.
 *
 *  - the `useAsTitle` / a `title`/`name`/`heading` field → `name` AND `headline`
 *  - the first richText / textarea / text body → `articleBody` (+ a truncated `description`)
 *  - a `date` named like published/created → `datePublished`; updated/modified → `dateModified`
 *  - an `email` field → `email`
 *  - an upload/image field → `image` (URL)
 *  - an author-ish relationship → `author` ({ '@type':'Person', name })
 */
function defaultPlan(collection: CollectionConfig): Map<string, string> {
  const plan = new Map<string, string>()
  // Encrypted fields are never auto-mapped into JSON-LD: their plaintext (decrypted on read)
  // must not be published to an anonymous SEO/AI surface.
  const fields = effectiveFields(collection.fields).filter((f) => !f.encrypted)

  // Title → name + headline.
  const titleField = resolveTitleField(collection)
  if (titleField) {
    plan.set('name', titleField)
    plan.set('headline', titleField)
  }

  // Body → articleBody (+ description). Prefer richText, then textarea, then a non-title text.
  const body =
    fields.find((f) => f.type === 'richText') ??
    fields.find((f) => f.type === 'textarea') ??
    fields.find((f) => f.type === 'text' && f.name !== titleField)
  if (body) {
    plan.set('articleBody', body.name)
    plan.set('description', body.name)
  }

  // Dates: name-driven, with a fallback to the system timestamps.
  let publishedField: string | null = null
  let modifiedField: string | null = null
  for (const f of fields) {
    if (f.type !== 'date') continue
    const n = f.name.toLowerCase()
    if (!publishedField && /(publish|posted|created|date$|^date)/.test(n)) publishedField = f.name
    if (!modifiedField && /(updat|modif|edited|changed)/.test(n)) modifiedField = f.name
  }
  if (publishedField) plan.set('datePublished', publishedField)
  else if (collection.timestamps !== false) plan.set('datePublished', 'createdAt')
  if (modifiedField) plan.set('dateModified', modifiedField)
  else if (collection.timestamps !== false) plan.set('dateModified', 'updatedAt')

  // Email.
  const email = fields.find((f) => f.type === 'email')
  if (email) plan.set('email', email.name)

  // Image (upload / image-ish relationship).
  const image = fields.find(
    (f) => f.type === 'upload' || (f.type === 'relationship' && /image|photo|thumbnail|cover|media/i.test(f.name)),
  )
  if (image) plan.set('image', image.name)

  // Author (relationship to an author-ish collection).
  const author = fields.find(
    (f) =>
      (f.type === 'relationship' || f.type === 'upload') &&
      (/(author|writer|creator|byline)/i.test(f.name) ||
        (Array.isArray(f.relationTo) ? f.relationTo : [f.relationTo]).some((s) => AUTHOR_SLUGS.has(String(s)))),
  )
  if (author) plan.set('author', author.name)

  return plan
}

/** Pick the title field: `admin.useAsTitle`, then a `title`/`name`/`heading`/`label` field. */
function resolveTitleField(collection: CollectionConfig): string | null {
  const fields = effectiveFields(collection.fields).filter((f) => !f.encrypted)
  const has = (name: string | undefined): name is string => Boolean(name) && fields.some((f) => f.name === name)
  if (has(collection.admin?.useAsTitle)) return collection.admin!.useAsTitle!
  for (const candidate of ['title', 'name', 'heading', 'label']) {
    if (has(candidate)) return candidate
  }
  return null
}

// ── object building ─────────────────────────────────────────────────────────────

/** Build the JSON-LD object for an already-read, access-stripped document. Only fields
 *  PRESENT on `doc` (i.e. readable — `find` stripped denied fields) contribute. */
function buildObject(doc: Doc, target: ResolvedTarget, baseUrl: string): Record<string, unknown> {
  const { collection, entry } = target
  const out: Record<string, unknown> = Object.create(null)
  out['@context'] = 'https://schema.org'
  out['@type'] = entry.type
  out['@id'] = buildUrl(doc, target, baseUrl)

  // The property plan: explicit mapping overrides smart defaults.
  const plan = entry.mapping ? new Map(Object.entries(entry.mapping)) : defaultPlan(collection)
  const fields = effectiveFields(collection.fields)
  const fieldByName = (name: string): AnyField | undefined => fields.find((f) => f.name === name)

  for (const [property, fieldName] of plan) {
    if (FORBIDDEN_PROPERTY_KEYS.has(property)) continue
    if (property === '@context' || property === '@type' || property === '@id') continue
    // A field stripped by read-access (or simply absent) yields no property — the security
    // property: a read-denied field never surfaces here because it isn't on `doc`.
    if (!Object.prototype.hasOwnProperty.call(doc, fieldName)) continue
    const raw = doc[fieldName]
    const field = fieldByName(fieldName)

    const value = buildProperty(property, raw, field)
    if (value == null) continue
    if (typeof value === 'string' && value.length === 0) continue
    out[property] = value
  }

  return out
}

/** Resolve one schema.org property's value from a field value, applying property-specific
 *  shaping (description truncation, image URL extraction, author Person). */
function buildProperty(property: string, raw: unknown, field: AnyField | undefined): unknown {
  if (property === 'image') return imageUrlOf(raw)
  if (property === 'author') {
    const person = authorOf(raw, field)
    if (person) return person
    // A plain string author name is acceptable too.
    return coerceValue(raw, field)
  }
  if (property === 'description') {
    const text = isRichText(raw) || typeof raw === 'string' ? (coerceValue(raw, field) as string | null) : null
    if (typeof text !== 'string') return null
    return text.length > DESCRIPTION_MAX ? text.slice(0, DESCRIPTION_MAX - 1).trimEnd() + '…' : text
  }
  return coerceValue(raw, field)
}

// ── HTML escaping for the <script> embedding ────────────────────────────────────

/** Escape the JSON payload for safe inclusion inside a `<script>` element. Escaping `<`,
 *  `>`, and `&` is sufficient and standard: it neutralizes `</script>` and any `<…>` in
 *  document content so the value can never break out of the script context. The JSON itself
 *  is still valid (these become `<` etc.), so parsers read it unchanged. */
function escapeForScript(json: string): string {
  return json.replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
}

// ── public factory ───────────────────────────────────────────────────────────────

export function createStructuredData(config: SanitizedConfig, deps: StructuredDataDeps) {
  const sd = config.structuredData

  /** Read the document through the access-checked path with the caller's principal. A
   *  draft/private/read-denied doc isn't returned (null); a collection that denies the
   *  caller's read throws Forbidden → treated as not-found. */
  async function readDoc(opts: JsonLdOptions, target: ResolvedTarget): Promise<Doc | null> {
    try {
      const result = await deps.find({
        collection: target.collection.slug,
        where: { id: { equals: opts.id } },
        limit: 1,
        depth: 1,
        ...(opts.req ? { req: opts.req } : {}),
        ...(opts.overrideAccess ? { overrideAccess: true } : {}),
      })
      return result.docs[0] ?? null
    } catch (err) {
      if (err instanceof ForbiddenError) return null
      throw err
    }
  }

  async function jsonLd(opts: JsonLdOptions): Promise<Record<string, unknown> | null> {
    if (!sd.enabled) return null
    const target = resolveTarget(config, opts.collection)
    if (!target) return null
    const doc = await readDoc(opts, target)
    if (!doc) return null
    return buildObject(doc, target, sd.baseUrl)
  }

  async function jsonLdScript(opts: JsonLdScriptOptions): Promise<string> {
    const obj = await jsonLd(opts)
    if (!obj) return ''
    const json = escapeForScript(JSON.stringify(obj))
    return `<script type="application/ld+json">${json}</script>`
  }

  return { jsonLd, jsonLdScript }
}
