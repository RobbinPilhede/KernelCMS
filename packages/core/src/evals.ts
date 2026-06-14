/**
 * Pre-publish evals — "content CI". A small, composable set of checks that run on the
 * to-be-published document at the publish chokepoint. A `blocking` rule that yields an
 * `ok:false` `error` finding REJECTS the publish; everything else is collected and
 * recorded (audit meta) but never blocks.
 *
 * The built-in factories below are deliberately PURE and tiny — they're both ready-to-
 * use and worked examples a project copies. They read only the fields they declare and
 * never touch the network or mutate the doc.
 */
import type { ConfigField, EvalFinding, EvalRule, RichTextField, RelationshipField } from './types'
import { effectiveFields } from './fields'

/** A finding paired with the rule that produced it (so the audit trail / error names
 *  the offending rule). */
export interface EvalResult extends EvalFinding {
  rule: string
  blocking: boolean
}

/** True when a finding should BLOCK the publish: it came from a blocking rule, failed,
 *  and is an `error` (warn/info never block, even from a blocking rule). */
function isBlockingFailure(r: EvalResult): boolean {
  return r.blocking && !r.ok && r.severity === 'error'
}

/**
 * Run every rule that applies to `collection` against `doc`. Returns the flat list of
 * results plus the blocking failures (if any). Rules with an `appliesTo` are scoped to
 * those collection slugs; an absent `appliesTo` means "every collection". A thrown
 * rule is converted to a blocking error result (a rule that crashes must not silently
 * pass content through the gate, nor 500 the publish).
 */
export async function runEvals(
  rules: ReadonlyArray<EvalRule> | undefined,
  args: { doc: Record<string, unknown>; collection: string; req: unknown; fields?: ConfigField[] },
): Promise<{ results: EvalResult[]; blocking: EvalResult[] }> {
  const results: EvalResult[] = []
  if (rules && rules.length > 0) {
    for (const rule of rules) {
      if (rule.appliesTo && !rule.appliesTo.includes(args.collection)) continue
      const blocking = rule.blocking !== false // default to blocking
      let findings: EvalFinding[]
      try {
        findings = await rule.run({
          doc: args.doc,
          collection: args.collection,
          req: args.req as never,
          fields: args.fields,
        })
      } catch (err) {
        results.push({
          rule: rule.name,
          blocking,
          ok: false,
          severity: 'error',
          message: `eval "${rule.name}" threw: ${err instanceof Error ? err.message : String(err)}`,
        })
        continue
      }
      for (const f of findings) results.push({ ...f, rule: rule.name, blocking })
    }
  }
  return { results, blocking: results.filter(isBlockingFailure) }
}

// ---------------------------------------------------------------------------
// Field-walking helpers (shared by the built-ins).
// ---------------------------------------------------------------------------

/** The richText field names declared on a collection's schema. */
function richTextFieldNames(fields: ConfigField[]): string[] {
  return effectiveFields(fields)
    .filter((f): f is RichTextField => f.type === 'richText')
    .map((f) => f.name)
}

/** The upload-relationship field names declared on a collection's schema. */
function uploadFieldNames(fields: ConfigField[]): string[] {
  return effectiveFields(fields)
    .filter((f): f is RelationshipField => f.type === 'upload')
    .map((f) => f.name)
}

/** Depth-first walk over a richText node tree, visiting every node. Bounded to MAX_WALK_DEPTH
 *  levels so a hostile/over-nested tree can't blow the call stack (the richText sanitizer caps
 *  nesting on write, but evals must stay robust even if handed unsanitized input). */
const MAX_WALK_DEPTH = 100
function walkRichText(node: unknown, visit: (n: Record<string, unknown>) => void, depth = 0): void {
  if (!node || typeof node !== 'object' || depth > MAX_WALK_DEPTH) return
  const n = node as Record<string, unknown>
  visit(n)
  const children = n.children
  if (Array.isArray(children)) for (const c of children) walkRichText(c, visit, depth + 1)
}

/** Collapse a richText doc to plain text (used by length/term checks). */
function richTextToText(doc: unknown): string {
  let out = ''
  walkRichText(doc, (n) => {
    if (n.type === 'text' && typeof n.text === 'string') out += n.text
    if (n.type === 'codeBlock' && typeof n.code === 'string') out += ` ${n.code}`
  })
  return out
}

/** Read a top-level string field (text/textarea), trimmed. Null when absent/non-string. */
function readString(doc: Record<string, unknown>, field: string): string | null {
  const v = doc[field]
  return typeof v === 'string' ? v : null
}

// ---------------------------------------------------------------------------
// a11y — accessibility checks.
// ---------------------------------------------------------------------------

/**
 * Accessibility eval. On every richText field of the collection:
 *  - every `upload` node embedded inline must carry a non-empty `alt` (decorative
 *    images should still set `alt:''`, which is allowed — we only flag a MISSING alt);
 *  - heading levels must not skip (a jump from h2 to h4 breaks screen-reader outline).
 * Plus: a top-level `upload` field with no sibling `alt`/`caption` text value is flagged.
 *
 * `fields` is wired automatically from the collection schema at publish time, so a
 * caller just drops `a11yEval()` into `config.evals`.
 */
export function a11yEval(): EvalRule {
  return {
    name: 'a11y',
    blocking: true,
    run({ doc, fields }) {
      const findings: EvalFinding[] = []
      const schema = fields ?? []
      for (const field of richTextFieldNames(schema)) {
        const value = doc[field]
        // Inline upload nodes need alt text.
        let lastLevel = 1
        walkRichText(value, (n) => {
          if (n.type === 'upload') {
            const alt = n.alt
            if (typeof alt !== 'string') {
              findings.push({
                ok: false,
                severity: 'error',
                message: `Embedded image in "${field}" is missing alt text.`,
                field,
              })
            }
          } else if (n.type === 'heading' && typeof n.level === 'number') {
            if (n.level > lastLevel + 1) {
              findings.push({
                ok: false,
                severity: 'error',
                message: `Heading level jumps from h${lastLevel} to h${n.level} in "${field}" (don't skip levels).`,
                field,
              })
            }
            lastLevel = n.level
          }
        })
      }
      // Top-level upload fields: only flagged when the schema declares them; a populated
      // upload value with no alt sibling is an info-level nudge (not every upload field
      // models alt text, so this is non-blocking by severity).
      for (const field of uploadFieldNames(schema)) {
        if (doc[field] != null && doc[`${field}_alt`] == null && doc.alt == null) {
          findings.push({
            ok: true,
            severity: 'info',
            message: `Upload field "${field}" has no associated alt text field.`,
            field,
          })
        }
      }
      if (findings.length === 0) findings.push({ ok: true, severity: 'info', message: 'No a11y issues found.' })
      return findings
    },
  }
}

// ---------------------------------------------------------------------------
// seo — title/description bounds.
// ---------------------------------------------------------------------------

export interface SeoEvalOptions {
  /** The title field to bound. Required. */
  titleField: string
  /** Minimum/maximum title length (inclusive). Defaults 10/60. */
  minTitle?: number
  maxTitle?: number
  /** Optional meta-description field; when set, it must be present and within bounds. */
  descriptionField?: string
  minDescription?: number
  maxDescription?: number
}

/** SEO eval: enforces title-length bounds and (optionally) a present, bounded
 *  meta description. Title-too-long is the classic publish blocker. */
export function seoEval(opts: SeoEvalOptions): EvalRule {
  const minTitle = opts.minTitle ?? 10
  const maxTitle = opts.maxTitle ?? 60
  const minDesc = opts.minDescription ?? 50
  const maxDesc = opts.maxDescription ?? 160
  return {
    name: 'seo',
    blocking: true,
    run({ doc }) {
      const findings: EvalFinding[] = []
      const title = readString(doc, opts.titleField)
      if (title === null || title.trim().length === 0) {
        findings.push({
          ok: false,
          severity: 'error',
          message: `SEO: "${opts.titleField}" is required for publishing.`,
          field: opts.titleField,
        })
      } else {
        const len = title.trim().length
        if (len < minTitle) {
          findings.push({
            ok: false,
            severity: 'error',
            message: `SEO: title is too short (${len} chars; min ${minTitle}).`,
            field: opts.titleField,
          })
        } else if (len > maxTitle) {
          findings.push({
            ok: false,
            severity: 'error',
            message: `SEO: title is too long (${len} chars; max ${maxTitle}).`,
            field: opts.titleField,
          })
        }
      }
      if (opts.descriptionField) {
        const desc = readString(doc, opts.descriptionField)
        const len = desc ? desc.trim().length : 0
        if (len === 0) {
          findings.push({
            ok: false,
            severity: 'warn',
            message: `SEO: meta description "${opts.descriptionField}" is empty.`,
            field: opts.descriptionField,
          })
        } else if (len < minDesc || len > maxDesc) {
          findings.push({
            ok: false,
            severity: 'warn',
            message: `SEO: meta description length ${len} is outside the recommended ${minDesc}–${maxDesc}.`,
            field: opts.descriptionField,
          })
        }
      }
      if (findings.length === 0) findings.push({ ok: true, severity: 'info', message: 'SEO checks passed.' })
      return findings
    },
  }
}

// ---------------------------------------------------------------------------
// policy — banned terms.
// ---------------------------------------------------------------------------

export interface PolicyEvalOptions {
  /** Terms that may not appear (case-insensitive substring match). */
  bannedTerms: string[]
  /** Limit the scan to these field names. Omit to scan every string + richText field. */
  fields?: string[]
}

/** Policy eval: rejects a publish whose content contains any banned term. Scans the
 *  named fields (or all string/richText content) case-insensitively. Blocking. */
export function policyEval(opts: PolicyEvalOptions): EvalRule {
  const banned = opts.bannedTerms.map((t) => t.toLowerCase()).filter((t) => t.length > 0)
  return {
    name: 'policy',
    blocking: true,
    run({ doc, fields }) {
      const findings: EvalFinding[] = []
      const schema = fields ?? []
      const richNames = new Set(richTextFieldNames(schema))
      const targets = opts.fields ?? Object.keys(doc)
      for (const field of targets) {
        const value = doc[field]
        let text: string
        if (richNames.has(field)) text = richTextToText(value)
        else if (typeof value === 'string') text = value
        else continue
        const haystack = text.toLowerCase()
        for (const term of banned) {
          if (haystack.includes(term)) {
            findings.push({
              ok: false,
              severity: 'error',
              message: `Policy: banned term "${term}" found in "${field}".`,
              field,
            })
          }
        }
      }
      if (findings.length === 0) findings.push({ ok: true, severity: 'info', message: 'No banned terms found.' })
      return findings
    },
  }
}

// ---------------------------------------------------------------------------
// brand — required disclaimers.
// ---------------------------------------------------------------------------

export interface BrandEvalOptions {
  /** Phrases that MUST appear somewhere in the document's text (case-insensitive). */
  requiredDisclaimers?: string[]
  /** Limit the scan to these field names. Omit to scan every string + richText field. */
  fields?: string[]
}

/** Brand eval: enforces that required disclaimers/phrases are present in the content.
 *  A missing disclaimer is a blocking error (legal/brand text must ship). */
export function brandEval(opts: BrandEvalOptions = {}): EvalRule {
  const required = (opts.requiredDisclaimers ?? []).filter((d) => d.length > 0)
  return {
    name: 'brand',
    blocking: true,
    run({ doc, fields }) {
      const findings: EvalFinding[] = []
      if (required.length === 0) {
        return [{ ok: true, severity: 'info', message: 'No brand disclaimers configured.' }]
      }
      const schema = fields ?? []
      const richNames = new Set(richTextFieldNames(schema))
      const targets = opts.fields ?? Object.keys(doc)
      let corpus = ''
      for (const field of targets) {
        const value = doc[field]
        if (richNames.has(field)) corpus += ` ${richTextToText(value)}`
        else if (typeof value === 'string') corpus += ` ${value}`
      }
      const haystack = corpus.toLowerCase()
      for (const phrase of required) {
        if (!haystack.includes(phrase.toLowerCase())) {
          findings.push({
            ok: false,
            severity: 'error',
            message: `Brand: required disclaimer "${phrase}" is missing.`,
          })
        }
      }
      if (findings.length === 0)
        findings.push({ ok: true, severity: 'info', message: 'All brand disclaimers present.' })
      return findings
    },
  }
}

// ---------------------------------------------------------------------------
// readability — flag prose that's hard to read (long sentences / long words).
// ---------------------------------------------------------------------------

export interface ReadabilityEvalOptions {
  /** The text/richText fields to score. */
  fields: string[]
  /** Warn when the average sentence length exceeds this many words. Default 25. */
  maxAvgSentenceWords?: number
  /** Warn when more than this fraction of words are "long" (>= 13 chars). Default 0.20. */
  maxLongWordRatio?: number
}

/** Readability eval: a non-blocking nudge when a field's prose runs long-winded (high average
 *  sentence length or a high share of long words). Pure — reads only the declared fields. */
export function readabilityEval(opts: ReadabilityEvalOptions): EvalRule {
  const maxAvg = opts.maxAvgSentenceWords ?? 25
  const maxLong = opts.maxLongWordRatio ?? 0.2
  return {
    name: 'readability',
    blocking: false,
    run({ doc, fields }) {
      const findings: EvalFinding[] = []
      const richNames = new Set(richTextFieldNames(fields ?? []))
      for (const field of opts.fields) {
        const value = doc[field]
        const text = (richNames.has(field) ? richTextToText(value) : typeof value === 'string' ? value : '').trim()
        if (text.length === 0) continue
        const words = text.split(/\s+/).filter(Boolean)
        if (words.length < 10) continue
        const sentences = text
          .split(/[.!?]+/)
          .map((s) => s.trim())
          .filter(Boolean)
        const avg = sentences.length > 0 ? words.length / sentences.length : words.length
        if (avg > maxAvg) {
          findings.push({
            ok: false,
            severity: 'warn',
            message: `"${field}" averages ${avg.toFixed(0)} words/sentence (aim for ≤ ${maxAvg}). Shorter sentences read easier.`,
            field,
          })
        }
        const longWords = words.filter((w) => w.replace(/[^a-z]/gi, '').length >= 13).length
        const ratio = longWords / words.length
        if (ratio > maxLong) {
          findings.push({
            ok: false,
            severity: 'warn',
            message: `"${field}" is ${(ratio * 100).toFixed(0)}% long words (aim for ≤ ${(maxLong * 100).toFixed(0)}%).`,
            field,
          })
        }
      }
      if (findings.length === 0) findings.push({ ok: true, severity: 'info', message: 'Readability looks good.' })
      return findings
    },
  }
}

// ---------------------------------------------------------------------------
// required-before-publish — certain fields must be present to publish.
// ---------------------------------------------------------------------------

/** Required-fields eval: BLOCKS the publish when any listed field is empty (a blank string,
 *  an empty list, or null). For "you can't publish without a hero image / summary / category". */
export function requiredFieldsEval(opts: { fields: string[] }): EvalRule {
  return {
    name: 'required-fields',
    blocking: true,
    run({ doc }) {
      const findings: EvalFinding[] = []
      const isEmpty = (v: unknown): boolean =>
        v == null || (typeof v === 'string' && v.trim().length === 0) || (Array.isArray(v) && v.length === 0)
      for (const field of opts.fields) {
        if (isEmpty(doc[field])) {
          findings.push({ ok: false, severity: 'error', message: `"${field}" is required before publishing.`, field })
        }
      }
      if (findings.length === 0) findings.push({ ok: true, severity: 'info', message: 'All required fields present.' })
      return findings
    },
  }
}

// ---------------------------------------------------------------------------
// links — flag empty or malformed link targets in rich text.
// ---------------------------------------------------------------------------

/** Link eval: a non-blocking warning for rich-text links with an empty/placeholder href
 *  (`#`, blank) or a malformed external URL. Pure — inspects the richText link nodes only. */
export function linkEval(opts: { fields?: string[] } = {}): EvalRule {
  return {
    name: 'links',
    blocking: false,
    run({ doc, fields }) {
      const findings: EvalFinding[] = []
      const names = opts.fields ?? richTextFieldNames(fields ?? [])
      for (const field of names) {
        walkRichText(doc[field], (n) => {
          if (n.type !== 'link') return
          // The canonical rich-text link node keys its target as `url` (the sanitizer emits
          // `{ type: 'link', url }`); tolerate a legacy `href` just in case.
          const raw = typeof n.url === 'string' ? n.url : typeof n.href === 'string' ? n.href : ''
          const href = raw.trim()
          if (href === '' || href === '#') {
            findings.push({ ok: false, severity: 'warn', message: `A link in "${field}" has an empty target.`, field })
          } else if (/^https?:\/\//i.test(href)) {
            try {
              new URL(href)
            } catch {
              findings.push({
                ok: false,
                severity: 'warn',
                message: `A link in "${field}" has a malformed URL "${href}".`,
                field,
              })
            }
          }
        })
      }
      if (findings.length === 0) findings.push({ ok: true, severity: 'info', message: 'No broken links found.' })
      return findings
    },
  }
}
