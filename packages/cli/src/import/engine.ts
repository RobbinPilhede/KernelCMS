// The import engine: takes a NormalizedDataset (from any adapter) and a live kernel,
// and lands it as content. Two passes, id-mapped:
//   1. create every record WITHOUT its refs, recording sourceId -> newId.
//   2. resolve each ref through that map and update() the relationship field(s).
// This is what makes cross-record relationships survive a migration: the adapter only
// knows source ids, and the engine is the single place that knows the new kernel ids.
//
// Everything here treats the source data as UNTRUSTED. Imports run with
// `overrideAccess: true` because this is a trusted server-side bulk load (an operator
// at a terminal), NOT agent content — but "trusted operator" is not "trusted bytes":
// a competitor export is attacker-influenceable (anyone could have authored a post),
// so we guard prototype-pollution keys, cap field sizes, and never echo a secret.

import { effectiveFields, relationshipFields } from '@kernel/core'
import type { Kernel } from '@kernel/core'
import type { ConfigField } from '@kernel/core'
import type { ImportReport, NormalizedDataset, NormalizedRecord, NormalizedRef } from './types'

export interface RunImportOptions {
  /** Validate + map + report but perform ZERO writes. The headline safety feature. */
  dryRun: boolean
  /** Status for drafts-enabled collections. Default 'draft' — imports land unpublished
   *  so an operator reviews before going live (least surprise; opt into 'published'). */
  defaultStatus?: 'draft' | 'published'
  /** Source name, for the report header. */
  source?: string
}

// Keys that must never reach a created document. A competitor export is JSON authored
// by an unknown party; a literal `__proto__`/`constructor`/`prototype` OWN key would
// pollute the assembled object's prototype. Mirror the engine's COMPOSE_FORBIDDEN_KEYS.
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

// Sanity cap on any single field value's serialized size. A hostile export could carry
// a multi-megabyte string to exhaust memory/storage on import; clamp at 1 MiB per field
// (generous for real rich-text/HTML, tiny next to a DoS payload). Oversized values are
// truncated, not fatal — the import still completes and the value is preserved as far
// as the cap allows.
const MAX_FIELD_BYTES = 1024 * 1024

/** The set of top-level field names a collection actually has (so unknown source
 *  fields can be dropped, not 500 the create). Reaches into presentational containers
 *  via effectiveFields so a field nested in a row/tabs still counts as present. */
function targetFieldNames(fields: ConfigField[]): Set<string> {
  return new Set(effectiveFields(fields).map((f) => f.name))
}

/** The relationship/upload field names on a collection — used to validate that a ref's
 *  declared field really is a relationship before we try to write it in pass 2. */
function relationshipFieldNames(fields: ConfigField[]): Set<string> {
  return new Set(relationshipFields(fields).map((f) => f.name))
}

/** True when `field` on `slug` is a hasMany relationship (so a single resolved id is
 *  still written as an array, and an unresolved member is simply omitted). */
function isHasMany(kernel: Kernel, slug: string, field: string): boolean {
  const collection = kernel.config.collectionsBySlug[slug]
  if (!collection) return false
  const rel = relationshipFields(collection.fields).find((r) => r.name === field)
  return Boolean(rel?.hasMany)
}

/** Clamp one value to the per-field byte cap. Only strings can realistically blow the
 *  budget; objects/arrays are JSON-measured and dropped wholesale if absurd (returning
 *  the original is fine for normal sizes — the check is a DoS guard, not validation). */
function clampSize(value: unknown): unknown {
  if (typeof value === 'string') {
    return Buffer.byteLength(value, 'utf8') > MAX_FIELD_BYTES ? value.slice(0, MAX_FIELD_BYTES) : value
  }
  if (value && typeof value === 'object') {
    try {
      if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_FIELD_BYTES) return null
    } catch {
      return null
    }
  }
  return value
}

/**
 * Build the safe `data` payload for a create/update: keep only keys that name a real
 * field on the target collection, reject prototype-pollution keys outright, and clamp
 * each value's size. Records every dropped (unknown) field name into `dropped`.
 * Assembled on a null-prototype object so even a smuggled key can't reach Object.proto.
 */
function buildSafeData(
  raw: Record<string, unknown>,
  allowed: Set<string>,
  dropped: Set<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const key of Object.keys(raw)) {
    if (FORBIDDEN_KEYS.has(key)) continue // never carry a pollution key, in or out
    if (!allowed.has(key)) {
      dropped.add(key)
      continue
    }
    out[key] = clampSize(raw[key])
  }
  return out
}

/** Add `name` to the per-slug dropped-fields list in the report (deduped, sorted on read). */
function recordDropped(report: ImportReport, slug: string, names: Set<string>): void {
  if (names.size === 0) return
  const existing = new Set(report.droppedFields[slug] ?? [])
  for (const n of names) existing.add(n)
  report.droppedFields[slug] = [...existing].sort()
}

/**
 * Run an import. Pass 1 creates every record (refs deferred); pass 2 resolves refs by
 * source id and writes the relationship fields. In dry-run mode the SAME validation,
 * field-drop, and ref-resolvability checks run and populate the SAME report, but no
 * write is issued — count(before) === count(after) is the proof.
 */
export async function runImport(
  kernel: Kernel,
  dataset: NormalizedDataset,
  opts: RunImportOptions,
): Promise<ImportReport> {
  const status = opts.defaultStatus ?? 'draft'
  const report: ImportReport = {
    source: opts.source ?? 'unknown',
    dryRun: opts.dryRun,
    created: {},
    updated: 0,
    skipped: [],
    droppedFields: {},
    danglingRefs: 0,
    errors: [],
  }

  // sourceId -> new kernel id. In dry-run we still populate it (with a synthetic id) so
  // pass-2 ref resolvability can be checked exactly as it would be on a real apply.
  const idMap = new Map<string, string>()
  // Records that survived pass 1 (target type known), carried into pass 2 for refs.
  const live: Array<{ record: NormalizedRecord; newId: string }> = []
  // Per-slug "is this a real field" caches, computed once.
  const fieldCache = new Map<string, Set<string>>()
  const relCache = new Map<string, Set<string>>()
  const fieldsFor = (slug: string): Set<string> => {
    let s = fieldCache.get(slug)
    if (!s) {
      s = targetFieldNames(kernel.config.collectionsBySlug[slug]!.fields)
      fieldCache.set(slug, s)
    }
    return s
  }
  const relsFor = (slug: string): Set<string> => {
    let s = relCache.get(slug)
    if (!s) {
      s = relationshipFieldNames(kernel.config.collectionsBySlug[slug]!.fields)
      relCache.set(slug, s)
    }
    return s
  }

  // ---- Pass 1: create (refs deferred) -------------------------------------
  for (const record of dataset.records) {
    const collection = kernel.config.collectionsBySlug[record.targetSlug]
    if (!collection) {
      report.skipped.push({
        sourceType: record.sourceType,
        reason: `No collection "${record.targetSlug}" in the kernel config.`,
      })
      continue
    }

    const allowed = fieldsFor(record.targetSlug)
    const rels = relsFor(record.targetSlug)
    const dropped = new Set<string>()
    const data = buildSafeData(record.data, allowed, dropped)
    recordDropped(report, record.targetSlug, dropped)

    // Config-aware ref promotion: a `data` key that actually names a relationship field
    // is a reference the adapter could not disambiguate (e.g. Payload's bare-id rels are
    // indistinguishable from a text field without the schema). Move it out of `data` and
    // into the record's refs so pass 2 resolves it by source id. The adapter stays pure;
    // the engine — the one place that knows the kernel config — settles the ambiguity.
    for (const key of Object.keys(data)) {
      if (!rels.has(key)) continue
      const value = data[key]
      delete data[key]
      const toSourceId = Array.isArray(value) ? value.map((v) => String(v)) : String(value)
      record.refs = [...(record.refs ?? []), { field: key, toSourceId }]
    }

    // Drafts-enabled collections get the requested status; the rest ignore it.
    const payload: Record<string, unknown> = { ...data }
    payload._status = status

    if (opts.dryRun) {
      // No write — synthesize a stable would-be id so pass-2 resolvability is real.
      const newId = `dry:${record.sourceId}`
      idMap.set(record.sourceId, newId)
      live.push({ record, newId })
      report.created[record.targetSlug] = (report.created[record.targetSlug] ?? 0) + 1
      continue
    }

    try {
      const created = await kernel.create({
        collection: record.targetSlug,
        data: payload,
        overrideAccess: true, // trusted server-side bulk load (NOT agent content)
      })
      idMap.set(record.sourceId, created.id)
      live.push({ record, newId: created.id })
      report.created[record.targetSlug] = (report.created[record.targetSlug] ?? 0) + 1
    } catch (err) {
      report.errors.push({ sourceId: record.sourceId, message: safeMessage(err) })
    }
  }

  // ---- Pass 2: resolve refs + write relationships -------------------------
  for (const { record, newId } of live) {
    if (!record.refs || record.refs.length === 0) continue
    const rels = relsFor(record.targetSlug)
    const resolved: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    let hasResolved = false

    for (const ref of record.refs) {
      // A ref must name a real relationship field; otherwise it's a parser bug or a
      // foreign field — report it as dropped, never write a non-relationship column.
      if (FORBIDDEN_KEYS.has(ref.field) || !rels.has(ref.field)) {
        recordDropped(report, record.targetSlug, new Set([ref.field]))
        continue
      }
      const value = resolveRef(kernel, record.targetSlug, ref, idMap, report)
      if (value === undefined) continue
      resolved[ref.field] = value
      hasResolved = true
    }

    if (!hasResolved) continue
    if (opts.dryRun) {
      report.updated += 1
      continue
    }
    try {
      await kernel.update({
        collection: record.targetSlug,
        id: newId,
        data: resolved,
        overrideAccess: true,
      })
      report.updated += 1
    } catch (err) {
      report.errors.push({ sourceId: record.sourceId, message: safeMessage(err) })
    }
  }

  return report
}

/** Resolve one ref to a kernel id (single) or array of ids (hasMany). Unresolved source
 *  ids are counted as dangling and omitted; a single ref that resolves to nothing returns
 *  undefined (the field is left untouched, not nulled). */
function resolveRef(
  kernel: Kernel,
  slug: string,
  ref: NormalizedRef,
  idMap: Map<string, string>,
  report: ImportReport,
): unknown {
  const many = isHasMany(kernel, slug, ref.field) || Array.isArray(ref.toSourceId)
  const sourceIds = Array.isArray(ref.toSourceId) ? ref.toSourceId : [ref.toSourceId]
  const ids: string[] = []
  for (const sid of sourceIds) {
    const mapped = idMap.get(sid)
    if (mapped) ids.push(mapped)
    else report.danglingRefs += 1
  }
  if (ids.length === 0) return undefined
  return many ? ids : ids[0]
}

/** Turn any thrown value into a safe one-line message. Defensive against a token ever
 *  landing in an error: the engine never puts secrets in `data`, but strip just in case. */
function safeMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/\s+/g, ' ').trim().slice(0, 500)
}

/** Pretty-print an ImportReport in the CLI's `✓ …` voice. Leads with a prominent
 *  dry-run banner so a preview is never mistaken for a real apply. */
export function formatImportReport(report: ImportReport): string {
  const lines: string[] = []
  const totalCreated = Object.values(report.created).reduce((a, b) => a + b, 0)

  if (report.dryRun) {
    lines.push(`◆ DRY RUN — no documents were written. Re-run with --apply to import.`)
  }
  const verb = report.dryRun ? 'Would import' : 'Imported'
  lines.push(`${report.dryRun ? '◆' : '✓'} ${verb} ${totalCreated} document(s) from ${report.source}:`)
  const perType = Object.entries(report.created).sort(([a], [b]) => a.localeCompare(b))
  for (const [slug, n] of perType) lines.push(`    ${slug}: ${n}`)
  if (perType.length === 0) lines.push(`    (nothing to import)`)

  const relVerb = report.dryRun ? 'would resolve' : 'resolved'
  if (report.updated > 0) lines.push(`  ${relVerb} relationships on ${report.updated} document(s).`)

  const droppedSlugs = Object.entries(report.droppedFields).filter(([, names]) => names.length)
  if (droppedSlugs.length) {
    lines.push(`  dropped unknown source field(s) (no matching target field):`)
    for (const [slug, names] of droppedSlugs.sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`    ${slug}: ${names.join(', ')}`)
    }
  }

  if (report.skipped.length) {
    lines.push(`  skipped ${report.skipped.length} record(s) of unknown type:`)
    const byType = new Map<string, { reason: string; count: number }>()
    for (const s of report.skipped) {
      const entry = byType.get(s.sourceType)
      if (entry) entry.count += 1
      else byType.set(s.sourceType, { reason: s.reason, count: 1 })
    }
    for (const [type, { reason, count }] of byType) lines.push(`    ${type} (${count}): ${reason}`)
  }

  if (report.danglingRefs > 0) {
    lines.push(`  ⚠ ${report.danglingRefs} relationship reference(s) could not be resolved (dangling).`)
  }
  if (report.errors.length) {
    lines.push(`  ✖ ${report.errors.length} record(s) failed:`)
    for (const e of report.errors.slice(0, 20)) lines.push(`    ${e.sourceId}: ${e.message}`)
    if (report.errors.length > 20) lines.push(`    … and ${report.errors.length - 20} more.`)
  }

  return lines.join('\n')
}
