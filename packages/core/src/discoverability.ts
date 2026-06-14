/**
 * AI-discoverability / GEO (Generative Engine Optimization) layer.
 *
 * Emits a KernelCMS site's PUBLISHED, publicly-readable content as the emerging
 * llms.txt / llms-full.txt standard and as retrieval-ready markdown chunks, so AI
 * answer engines (ChatGPT, Claude, Perplexity, Google AI) can ingest and CITE it.
 *
 * SECURITY — the one property that matters: every generator reads content through
 * the real, access-checked `find` path as an ANONYMOUS principal (`req.user = null`,
 * `overrideAccess` NEVER set). The access pipeline therefore returns only documents a
 * member of the public could read, and (for drafts-enabled collections) `find` already
 * filters to `_status === 'published'`. Read-denied fields are stripped by the same
 * pipeline before we ever see a document. Drafts, scheduled-but-unpublished, and
 * access-restricted documents (and fields) can never appear in any output here.
 *
 * Output size is bounded by `config.discoverability.maxDocsPerCollection` /
 * `maxDocsTotal` so `llms-full.txt` / chunks can never become an unbounded dump (DoS).
 */
import type { KernelRichText } from '@kernel/richtext'
import { toMarkdown, toPlainText } from '@kernel/richtext'
import type {
  CollectionConfig,
  ContentChunk,
  ContentChunksOptions,
  DiscoverabilityCollectionConfig,
  Doc,
  FindOptions,
  GeoDocumentOptions,
  GetCredentialOptions,
  LlmsTxtOptions,
  Provenance,
  ProvenanceOptions,
  SanitizedConfig,
  VerifyCredentialOptions,
  VerifyCredentialResult,
} from './types'
import type { PaginatedResult } from '@kernel/db'
import { effectiveFields } from './fields'
import { BadRequestError, ForbiddenError } from './errors'

/** The operations the discoverability layer needs — the access-checked read path plus
 *  the #8 provenance/credential ops. Each is called with an ANONYMOUS, non-override req. */
export interface DiscoverabilityDeps {
  find<T extends Doc = Doc>(opts: FindOptions): Promise<PaginatedResult<T>>
  provenance(opts: ProvenanceOptions): Promise<Provenance>
  getContentCredential(opts: GetCredentialOptions): Promise<unknown | null>
  verifyContentCredential(opts: VerifyCredentialOptions): Promise<VerifyCredentialResult>
}

/** A resolved discoverable collection: its config + the fields used for title/body/etc. */
interface ResolvedTarget {
  collection: CollectionConfig
  entry: DiscoverabilityCollectionConfig
  titleField: string | null
  descriptionField: string | null
  bodyField: string | null
  pluralLabel: string
}

const SUMMARY_MAX = 200
const CHARS_PER_TOKEN = 4

/** An anonymous, override-free request — the core of the public-only guarantee. */
function anonReq(): FindOptions['req'] {
  return { user: null }
}

function hasField(collection: CollectionConfig, name: string | undefined): name is string {
  if (!name) return false
  // An `encrypted` field must NEVER be published to an anonymous discoverability surface
  // (llms.txt / GEO) — its plaintext is decrypted on read, so treat it as not-a-field here.
  return effectiveFields(collection.fields).some((f) => f.name === name && !f.encrypted)
}

/** Pick the title field: explicit override, then `admin.useAsTitle`, then a `title`/`name` field. */
function resolveTitleField(collection: CollectionConfig, entry: DiscoverabilityCollectionConfig): string | null {
  if (hasField(collection, entry.titleField)) return entry.titleField
  const useAsTitle = collection.admin?.useAsTitle
  if (hasField(collection, useAsTitle)) return useAsTitle!
  for (const candidate of ['title', 'name', 'heading', 'label']) {
    if (hasField(collection, candidate)) return candidate
  }
  return null
}

/** Pick the body field: explicit override, then the first richText, then a textarea/text. */
function resolveBodyField(collection: CollectionConfig, entry: DiscoverabilityCollectionConfig): string | null {
  if (hasField(collection, entry.bodyField)) return entry.bodyField
  const fields = effectiveFields(collection.fields).filter((f) => !f.encrypted)
  const rich = fields.find((f) => f.type === 'richText')
  if (rich) return rich.name
  const textarea = fields.find((f) => f.type === 'textarea')
  if (textarea) return textarea.name
  return null
}

function pluralLabelOf(collection: CollectionConfig): string {
  const explicit = collection.labels?.plural
  if (explicit) return explicit
  // Title-case the slug as a readable fallback: "blog_posts" -> "Blog posts".
  const words = collection.slug.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Resolve every configured target into the concrete fields used for output. */
function resolveTargets(config: SanitizedConfig): ResolvedTarget[] {
  const targets: ResolvedTarget[] = []
  for (const entry of config.discoverability.collections) {
    const collection = config.collectionsBySlug[entry.slug]
    if (!collection) continue
    targets.push({
      collection,
      entry,
      titleField: resolveTitleField(collection, entry),
      descriptionField: hasField(collection, entry.descriptionField) ? entry.descriptionField! : null,
      bodyField: resolveBodyField(collection, entry),
      pluralLabel: pluralLabelOf(collection),
    })
  }
  return targets
}

// ── value extraction ──────────────────────────────────────────────────────────

function isRichText(value: unknown): value is KernelRichText {
  return Boolean(value) && typeof value === 'object' && (value as { type?: unknown }).type === 'doc'
}

/** A document's title string — never empty (falls back to the id) and always a string. */
function titleOf(doc: Doc, target: ResolvedTarget): string {
  const raw = target.titleField ? doc[target.titleField] : undefined
  const str = typeof raw === 'string' ? raw.trim() : ''
  return str.length > 0 ? str : `${target.collection.slug} ${doc.id}`
}

/** Render a document's body to clean markdown (richText → markdown; strings as-is). */
function bodyMarkdown(doc: Doc, target: ResolvedTarget): string {
  if (!target.bodyField) return ''
  const value = doc[target.bodyField]
  if (isRichText(value)) return toMarkdown(value)
  if (typeof value === 'string') return value.trim()
  return ''
}

/** A one-line summary for llms.txt: the description field, else a truncated body. */
function summaryOf(doc: Doc, target: ResolvedTarget): string {
  let text = ''
  if (target.descriptionField) {
    const raw = doc[target.descriptionField]
    if (typeof raw === 'string') text = raw
    else if (isRichText(raw)) text = toPlainText(raw)
  }
  if (!text && target.bodyField) {
    const value = doc[target.bodyField]
    if (isRichText(value)) text = toPlainText(value)
    else if (typeof value === 'string') text = value
  }
  return truncate(collapseWhitespace(text), SUMMARY_MAX)
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1).trimEnd() + '…'
}

// ── URL building (injection-safe) ──────────────────────────────────────────────

/** Encode a doc-derived slug/segment so it can never inject markdown or break the URL.
 *  Slashes are allowed through (a slug may be a nested path), but `.`/`..` dot-segments
 *  are dropped so a free-form field value can't emit a traversal-style canonical URL. */
function safeSegment(value: unknown): string {
  return encodeURIComponent(String(value ?? ''))
    .replace(/%2F/gi, '/')
    .split('/')
    .filter(
      (seg) => seg !== '.' && seg !== '..' && seg.replace(/%2E/gi, '.') !== '.' && seg.replace(/%2E/gi, '.') !== '..',
    )
    .join('/')
}

/**
 * Build a document's canonical URL from the trusted `baseUrl` + the (trusted) urlPattern,
 * substituting `:token` placeholders with the document's SAFELY-ENCODED field values.
 * `:id` resolves to the doc id. An unknown/empty token resolves to empty. The pattern
 * comes from config (trusted); only the substituted VALUES are doc-derived, and those are
 * percent-encoded — so a hostile slug can never inject into the URL or the markdown link.
 */
function buildUrl(doc: Doc, target: ResolvedTarget, baseUrl: string): string {
  const pattern = target.entry.urlPattern ?? `/${target.collection.slug}/:id`
  const path = pattern.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, token: string) => {
    if (token === 'id') return safeSegment(doc.id)
    return safeSegment(doc[token])
  })
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${baseUrl}${normalizedPath}`
}

// ── markdown-link escaping for titles/summaries in the index ────────────────────

/** Escape a link label so `]` / closing brackets in a title can't break the `[label]`. */
function escapeLinkLabel(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]')
}

/** Escape parentheses in a summary that follows the link (kept on one line). */
function escapeSummary(s: string): string {
  return collapseWhitespace(s)
}

// ── citation / provenance footer ────────────────────────────────────────────────

function principalLabel(p: { id: string | null; type: string } | null | undefined): string | null {
  if (!p) return null
  const who = p.id ?? 'unknown'
  return `${who} (${p.type})`
}

/**
 * A compact provenance + verification footer for one published document. Reads
 * provenance + the signing credential through the SAME anonymous, access-checked path,
 * so it can only describe a document the public can already read.
 */
async function citationFooter(deps: DiscoverabilityDeps, collection: string, doc: Doc, url: string): Promise<string> {
  const lines: string[] = ['---', `Source: ${collection}`, `Canonical URL: ${url}`]
  if (doc.updatedAt != null) lines.push(`Last updated: ${String(doc.updatedAt)}`)

  // Provenance (who created / last edited). Best-effort: a collection without version
  // history simply yields no chain, so we omit the line rather than fabricate one.
  try {
    const prov = await deps.provenance({ collection, id: doc.id, req: anonReq() })
    const author = principalLabel(prov.createdBy)
    const editor = principalLabel(prov.lastEditedBy)
    if (author) lines.push(`Author: ${author}`)
    if (editor && editor !== author) lines.push(`Last edited by: ${editor}`)
  } catch {
    // Provenance is informational; never block output on it.
  }

  // Signature-verified status (#8). Only ever claims "verified" when the live content
  // still matches the signed manifest — a tampered or unsigned doc reads as such.
  try {
    const verification = await deps.verifyContentCredential({ collection, id: doc.id, req: anonReq() })
    if (verification.manifest) {
      lines.push(verification.valid ? 'Verified: content credential valid (signed, untampered)' : 'Verified: no')
    }
  } catch {
    // Verification is informational; never block output on it.
  }
  return lines.join('\n')
}

// ── public generators ───────────────────────────────────────────────────────────

function assertEnabled(config: SanitizedConfig): void {
  if (!config.discoverability.enabled) {
    throw new BadRequestError('Discoverability is not enabled (set `config.discoverability`).')
  }
}

function headerOf(config: SanitizedConfig): string {
  const title = config.discoverability.title ?? 'KernelCMS'
  const description = config.discoverability.description
  const lines = [`# ${title}`]
  if (description) lines.push('', `> ${collapseWhitespace(description)}`)
  return lines.join('\n')
}

/** Page through PUBLISHED, publicly-readable docs of one collection as an anonymous
 *  principal, capped at `cap`. The published+access filtering is done entirely by
 *  `find` — this never sets `draft` or `overrideAccess`. */
async function publicDocs(deps: DiscoverabilityDeps, collection: CollectionConfig, cap: number): Promise<Doc[]> {
  const out: Doc[] = []
  let page = 1
  const pageSize = Math.min(cap, 100)
  while (out.length < cap) {
    let result
    try {
      result = await deps.find({
        collection: collection.slug,
        sort: collection.timestamps === false ? 'id' : '-updatedAt',
        limit: Math.min(pageSize, cap - out.length),
        page,
        req: anonReq(),
      })
    } catch (err) {
      // A collection whose `read` rule denies the anonymous principal throws Forbidden.
      // That is the security boundary working as intended — such a collection simply
      // contributes NO public documents, so skip it rather than leak or crash.
      if (err instanceof ForbiddenError) return []
      throw err
    }
    out.push(...result.docs)
    if (!result.hasNextPage || result.docs.length === 0) break
    page += 1
  }
  return out.slice(0, cap)
}

export function createDiscoverability(config: SanitizedConfig, deps: DiscoverabilityDeps) {
  const disco = config.discoverability

  async function llmsTxt(opts: LlmsTxtOptions = {}): Promise<string> {
    assertEnabled(config)
    const targets = resolveTargets(config)
    const perCollection = clampCap(opts.limit, disco.maxDocsPerCollection)
    const sections: string[] = [headerOf(config)]

    let total = 0
    for (const target of targets) {
      if (total >= disco.maxDocsTotal) break
      const remaining = Math.min(perCollection, disco.maxDocsTotal - total)
      const docs = await publicDocs(deps, target.collection, remaining)
      if (docs.length === 0) continue
      total += docs.length
      const lines = [`## ${target.pluralLabel}`]
      for (const doc of docs) {
        const url = buildUrl(doc, target, disco.baseUrl ?? '')
        const title = escapeLinkLabel(titleOf(doc, target))
        const summary = escapeSummary(summaryOf(doc, target))
        lines.push(summary ? `- [${title}](${url}): ${summary}` : `- [${title}](${url})`)
      }
      sections.push(lines.join('\n'))
    }
    return sections.join('\n\n') + '\n'
  }

  async function llmsFullTxt(opts: LlmsTxtOptions = {}): Promise<string> {
    assertEnabled(config)
    const targets = resolveTargets(config)
    const perCollection = clampCap(opts.limit, disco.maxDocsPerCollection)
    const sections: string[] = [headerOf(config)]

    let total = 0
    for (const target of targets) {
      if (total >= disco.maxDocsTotal) break
      const remaining = Math.min(perCollection, disco.maxDocsTotal - total)
      const docs = await publicDocs(deps, target.collection, remaining)
      total += docs.length
      for (const doc of docs) {
        const url = buildUrl(doc, target, disco.baseUrl ?? '')
        const title = titleOf(doc, target)
        const body = bodyMarkdown(doc, target)
        const footer = await citationFooter(deps, target.collection.slug, doc, url)
        const parts = [`## ${title}`]
        if (body) parts.push(body)
        parts.push(footer)
        sections.push(parts.join('\n\n'))
      }
    }
    return sections.join('\n\n') + '\n'
  }

  async function contentChunks(opts: ContentChunksOptions = {}): Promise<ContentChunk[]> {
    assertEnabled(config)
    let targets = resolveTargets(config)
    if (opts.collection) {
      targets = targets.filter((t) => t.collection.slug === opts.collection)
      if (targets.length === 0) {
        throw new BadRequestError(`Collection "${opts.collection}" is not discoverable.`)
      }
    }
    const cap = clampCap(opts.limit, disco.maxDocsTotal)
    const chunks: ContentChunk[] = []

    for (const target of targets) {
      if (chunks.length >= cap) break
      const remaining = Math.min(disco.maxDocsPerCollection, cap - chunks.length)
      const docs = await publicDocs(deps, target.collection, remaining)
      for (const doc of docs) {
        const url = buildUrl(doc, target, disco.baseUrl ?? '')
        const title = titleOf(doc, target)
        const body = bodyMarkdown(doc, target)
        const text = body ? `# ${title}\n\n${body}` : `# ${title}`
        const chunk: ContentChunk = {
          id: doc.id,
          collection: target.collection.slug,
          title,
          url,
          text,
          tokensEstimate: Math.ceil(text.length / CHARS_PER_TOKEN),
          updatedAt: doc.updatedAt != null ? String(doc.updatedAt) : null,
        }
        try {
          const prov = await deps.provenance({ collection: target.collection.slug, id: doc.id, req: anonReq() })
          chunk.provenance = { createdBy: prov.createdBy, lastEditedBy: prov.lastEditedBy }
        } catch {
          // Provenance is optional metadata.
        }
        chunks.push(chunk)
      }
    }
    return chunks
  }

  async function geoDocument(opts: GeoDocumentOptions): Promise<string | null> {
    assertEnabled(config)
    const target = resolveTargets(config).find((t) => t.collection.slug === opts.collection)
    if (!target) return null
    // Read via the access-checked, anonymous, published-only path. A draft/private doc
    // simply isn't returned by this `find`, so the result is null — never leaked. A
    // collection that denies anonymous read throws Forbidden → treated as not-found.
    let doc: Doc | undefined
    try {
      const result = await deps.find({
        collection: target.collection.slug,
        where: { id: { equals: opts.id } },
        limit: 1,
        req: anonReq(),
      })
      doc = result.docs[0]
    } catch (err) {
      if (err instanceof ForbiddenError) return null
      throw err
    }
    if (!doc) return null

    const url = buildUrl(doc, target, disco.baseUrl ?? '')
    const title = titleOf(doc, target)
    const body = bodyMarkdown(doc, target)
    const footer = await citationFooter(deps, target.collection.slug, doc, url)
    const parts = [`# ${title}`]
    if (body) parts.push(body)
    parts.push(footer)
    return parts.join('\n\n') + '\n'
  }

  return { llmsTxt, llmsFullTxt, contentChunks, geoDocument }
}

/** Clamp a caller-supplied limit into `[1, cap]`, defaulting to `cap`. */
function clampCap(limit: number | undefined, cap: number): number {
  if (limit == null) return cap
  const n = Math.floor(Number(limit))
  if (!Number.isFinite(n) || n < 1) return cap
  return Math.min(n, cap)
}
