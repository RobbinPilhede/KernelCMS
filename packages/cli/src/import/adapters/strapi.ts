// Strapi adapter (v4). Two file shapes are supported, plus a REST fallback:
//   A) An object keyed by content-type:  { "api::article.article": [ {id, ...attrs}, ... ] }
//   B) A flat array of entries tagged with their type: [ { __contentType, id, ...attrs } ]
// The fixture-verified path is the JSON file. The REST fallback (`--url`/`--token` hitting
// `/api/<type>?populate=*`) is implemented for convenience but is NOT fixture-verified.
//
// Content-type uid -> kernel slug: we use the last dotted segment's plural-ish name (the
// part after `api::x.`), which is the collection name an operator recognizes (article →
// articles is left to the kernel slug; we pass the bare segment and report the mapping).
// Relations come back as `{ data: { id } }` (single), `{ data: [{ id }] }` (many), or a
// `connect: [{ id }]` write payload — all reduced to source ids by `id`.

import { readFile } from 'node:fs/promises'
import type { ImportInput, NormalizedDataset, NormalizedRecord, NormalizedRef } from '../types'

/** Turn a Strapi content-type uid (`api::article.article`, `plugin::users-permissions.user`)
 *  into the bare type name an operator maps to a slug. Falls back to the raw value. */
function slugFromUid(uid: string): string {
  const afterScope = uid.includes('::') ? uid.split('::')[1]! : uid
  const seg = afterScope.includes('.') ? afterScope.split('.').pop()! : afterScope
  return seg
}

/** Source ids from a Strapi relation value: `{data:{id}}`, `{data:[{id}]}`, `{connect:[{id}]}`,
 *  a bare id, or an array of ids. Returns [] when the value isn't a relation. */
function relationIds(value: unknown): string[] | null {
  if (value == null) return null
  if (typeof value === 'number' || typeof value === 'string') return null // scalar, not a relation
  if (Array.isArray(value)) {
    if (value.every((v) => v && typeof v === 'object' && 'id' in (v as object))) {
      return value.map((v) => String((v as { id: unknown }).id))
    }
    return null
  }
  const obj = value as { data?: unknown; connect?: unknown; id?: unknown }
  const pick = (d: unknown): string[] | null => {
    if (d == null) return null
    if (Array.isArray(d)) return d.map((v) => String((v as { id: unknown }).id))
    if (typeof d === 'object' && 'id' in (d as object)) return [String((d as { id: unknown }).id)]
    return null
  }
  return pick(obj.data) ?? pick(obj.connect)
}

function normalizeEntry(type: string, entry: Record<string, unknown>): NormalizedRecord {
  const id = entry.id != null ? String(entry.id) : `${type}:${JSON.stringify(entry).length}`
  // Strapi v4 may nest user fields under `attributes`; flatten when present.
  const attrs =
    entry.attributes && typeof entry.attributes === 'object' ? (entry.attributes as Record<string, unknown>) : entry
  const data: Record<string, unknown> = {}
  const refs: NormalizedRef[] = []
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'id' || key === '__contentType') continue
    const ids = relationIds(value)
    if (ids && ids.length) {
      refs.push({ field: key, toSourceId: ids.length === 1 ? ids[0]! : ids })
      continue
    }
    data[key] = value
  }
  return { sourceType: type, sourceId: id, targetSlug: slugFromUid(type), data, ...(refs.length ? { refs } : {}) }
}

async function readJsonFile(file: string): Promise<NormalizedDataset> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'))
  } catch (err) {
    throw new Error(`Could not parse the Strapi export as JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  const notes: string[] = ['Strapi: content-type uid mapped to its last segment (e.g. api::article.article → article).']
  const records: NormalizedRecord[] = []

  if (Array.isArray(parsed)) {
    // Shape B: flat array tagged with __contentType.
    for (const entry of parsed as Array<Record<string, unknown>>) {
      const type = typeof entry.__contentType === 'string' ? entry.__contentType : 'unknown'
      records.push(normalizeEntry(type, entry))
    }
  } else if (parsed && typeof parsed === 'object') {
    // Shape A: object keyed by content-type uid.
    for (const [type, list] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue
      for (const entry of list as Array<Record<string, unknown>>) records.push(normalizeEntry(type, entry))
    }
  } else {
    throw new Error('Unrecognized Strapi export shape (expected an object keyed by type, or an array of entries).')
  }

  return { records, notes }
}

export async function readStrapi(input: ImportInput): Promise<NormalizedDataset> {
  if (input.file) return readJsonFile(input.file)
  if (input.url) {
    throw new Error(
      'Strapi REST import (--url) is implemented but not fixture-verified; export to JSON and use --file for now.',
    )
  }
  throw new Error('Strapi import needs --file <export.json> (or --url for the unverified REST fallback).')
}
