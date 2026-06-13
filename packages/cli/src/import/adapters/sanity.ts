// Sanity adapter: parse an NDJSON export (one JSON document per line — the `data.ndjson`
// inside a `sanity dataset export` tarball, or `sanity documents query` output). Each doc
// has `_type` and `_id`; references are `{ _type:'reference', _ref:'<id>' }` and can appear
// as a single value or inside an array (e.g. a `references` array of reference objects).
//   `_type` -> kernel slug (system docs whose type starts with `sanity.` are skipped).
//   reference value(s) -> normalized ref by `_ref`.
// Sanity ids often carry a `drafts.` prefix; we strip it so a draft and its published twin
// map to the same source id (last one wins — noted on the dataset).

import { readFile } from 'node:fs/promises'
import type { ImportInput, NormalizedDataset, NormalizedRecord, NormalizedRef } from '../types'

interface SanityRef {
  _type?: string
  _ref?: string
}

function asRef(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const r = value as SanityRef
  return r._type === 'reference' && typeof r._ref === 'string' ? stripDraft(r._ref) : null
}

/** Strip Sanity's `drafts.` id prefix so draft/published twins share one source id. */
function stripDraft(id: string): string {
  return id.startsWith('drafts.') ? id.slice('drafts.'.length) : id
}

export async function readSanity(input: ImportInput): Promise<NormalizedDataset> {
  if (!input.file) throw new Error('Sanity import needs --file <export.ndjson> (one JSON document per line).')
  const raw = await readFile(input.file, 'utf8')
  const notes: string[] = ['Sanity: `drafts.` id prefixes are normalized to the published id (last write wins).']
  const records: NormalizedRecord[] = []

  const lines = raw.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (!line) continue
    let doc: Record<string, unknown>
    try {
      doc = JSON.parse(line) as Record<string, unknown>
    } catch (err) {
      throw new Error(`Sanity NDJSON: line ${i + 1} is not valid JSON: ${err instanceof Error ? err.message : err}`)
    }

    const type = typeof doc._type === 'string' ? doc._type : undefined
    const id = typeof doc._id === 'string' ? stripDraft(doc._id) : undefined
    if (!type || !id) continue
    if (type.startsWith('sanity.')) continue // system docs (imageAssets metadata, etc.)

    const data: Record<string, unknown> = {}
    const refs: NormalizedRef[] = []
    for (const [key, value] of Object.entries(doc)) {
      if (key.startsWith('_')) continue // _type/_id/_rev/_createdAt/_updatedAt are system keys

      const single = asRef(value)
      if (single) {
        refs.push({ field: key, toSourceId: single })
        continue
      }
      if (Array.isArray(value) && value.length > 0 && value.every((v) => asRef(v))) {
        refs.push({ field: key, toSourceId: value.map((v) => asRef(v)!) })
        continue
      }
      data[key] = value
    }

    records.push({
      sourceType: type,
      sourceId: id,
      targetSlug: type,
      data,
      ...(refs.length ? { refs } : {}),
    })
  }

  return { records, notes }
}
