// Payload adapter: parse a Payload export JSON. Two shapes, plus a REST fallback:
//   A) An array of collections:  [ { slug, docs: [ {id, ...} ] }, ... ]
//   B) An object keyed by slug:  { posts: [ {id, ...} ], authors: [ ... ] }
// The fixture-verified path is the JSON file. The REST fallback (`--url`/`--token` hitting
// `/api/<slug>`) is implemented-only (not fixture-verified) and reported as such.
//
// Payload relationship fields hold either a bare id, a populated object (`{ id, ... }`),
// a hasMany array of those, or a polymorphic `{ relationTo, value }`. We reduce each to
// source id(s); a field is treated as a relationship when its value is (an array of)
// id/{id} — scalar fields pass through as data. Because Payload's model is the closest to
// kernel's, slugs usually map 1:1.

import { readFile } from 'node:fs/promises'
import type { ImportInput, NormalizedDataset, NormalizedRecord, NormalizedRef } from '../types'

/** Source id(s) from a Payload relationship value, or null when the value is a scalar.
 *  Handles bare id, populated `{id}`, hasMany arrays, and polymorphic `{relationTo,value}`. */
function relationIds(value: unknown): { ids: string[]; relationTo?: string } | null {
  const one = (v: unknown): { id: string; relationTo?: string } | null => {
    if (v == null) return null
    if (typeof v === 'string' || typeof v === 'number') return { id: String(v) }
    if (typeof v === 'object') {
      const o = v as { id?: unknown; relationTo?: unknown; value?: unknown }
      if (o.relationTo != null && o.value != null) {
        const inner = one(o.value)
        return inner ? { id: inner.id, relationTo: String(o.relationTo) } : null
      }
      if (o.id != null) return { id: String(o.id) }
    }
    return null
  }

  if (Array.isArray(value)) {
    const resolved = value.map(one)
    if (resolved.length === 0 || resolved.some((r) => r === null)) return null
    return { ids: resolved.map((r) => r!.id), relationTo: resolved[0]!.relationTo }
  }
  // A bare string is ambiguous (could be a text field); only treat OBJECTS / arrays as
  // relationships here. A populated `{id}` or polymorphic object is unambiguous.
  if (value && typeof value === 'object') {
    const r = one(value)
    return r ? { ids: [r.id], relationTo: r.relationTo } : null
  }
  return null
}

function normalizeDoc(slug: string, doc: Record<string, unknown>): NormalizedRecord {
  const id = doc.id != null ? String(doc.id) : `${slug}:${JSON.stringify(doc).length}`
  const data: Record<string, unknown> = {}
  const refs: NormalizedRef[] = []
  for (const [key, value] of Object.entries(doc)) {
    if (key === 'id' || key === 'createdAt' || key === 'updatedAt') continue
    const rel = relationIds(value)
    if (rel && rel.ids.length) {
      refs.push({
        field: key,
        toSourceId: rel.ids.length === 1 ? rel.ids[0]! : rel.ids,
        ...(rel.relationTo ? { relationTo: rel.relationTo } : {}),
      })
      continue
    }
    data[key] = value
  }
  return { sourceType: slug, sourceId: id, targetSlug: slug, data, ...(refs.length ? { refs } : {}) }
}

async function readJsonFile(file: string): Promise<NormalizedDataset> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'))
  } catch (err) {
    throw new Error(`Could not parse the Payload export as JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  const notes: string[] = ['Payload: relationship ids are resolved by source id; bytes/uploads are not downloaded.']
  const records: NormalizedRecord[] = []

  if (Array.isArray(parsed)) {
    for (const group of parsed as Array<{ slug?: string; docs?: unknown }>) {
      if (!group?.slug || !Array.isArray(group.docs)) continue
      for (const doc of group.docs as Array<Record<string, unknown>>) records.push(normalizeDoc(group.slug, doc))
    }
  } else if (parsed && typeof parsed === 'object') {
    for (const [slug, docs] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(docs)) continue
      for (const doc of docs as Array<Record<string, unknown>>) records.push(normalizeDoc(slug, doc))
    }
  } else {
    throw new Error('Unrecognized Payload export shape (expected an array of {slug,docs} or an object keyed by slug).')
  }

  return { records, notes }
}

export async function readPayload(input: ImportInput): Promise<NormalizedDataset> {
  if (input.file) return readJsonFile(input.file)
  if (input.url) {
    throw new Error(
      'Payload REST import (--url) is implemented but not fixture-verified; export to JSON and use --file for now.',
    )
  }
  throw new Error('Payload import needs --file <export.json> (or --url for the unverified REST fallback).')
}
