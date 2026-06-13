// Contentful adapter: parse a `contentful-export` JSON file (the output of the official
// `contentful space export` CLI). Shape:
//   { contentTypes: [{ sys:{id}, name, fields:[...] }],
//     entries:      [{ sys:{ id, contentType:{ sys:{ id } } }, fields:{ <name>:{ <locale>:value } } }],
//     assets:       [{ sys:{ id }, fields:{ title:{<loc>}, file:{<loc>:{url,...}} } }] }
// Every field value is wrapped per-locale; we take the default locale (the export names
// it under `locales`, else we fall back to the first locale key present on the value).
// A `Link` value (`{ sys:{ type:'Link', linkType, id } }`) becomes a normalized ref by the
// linked entry/asset id. Content-type id maps directly to the kernel slug.

import { readFile } from 'node:fs/promises'
import type { ImportInput, NormalizedDataset, NormalizedRecord, NormalizedRef } from '../types'

interface CfSys {
  id?: string
  type?: string
  linkType?: string
  contentType?: { sys?: { id?: string } }
}
interface CfEntry {
  sys?: CfSys
  fields?: Record<string, Record<string, unknown>>
}
interface CfExport {
  locales?: Array<{ code?: string; default?: boolean }>
  contentTypes?: Array<{ sys?: CfSys; name?: string }>
  entries?: CfEntry[]
  assets?: CfEntry[]
}

/** A Contentful Link object — the on-the-wire shape of a reference field value. */
function asLink(value: unknown): { id: string; linkType: string } | null {
  if (!value || typeof value !== 'object') return null
  const sys = (value as { sys?: CfSys }).sys
  if (sys?.type === 'Link' && sys.id) return { id: sys.id, linkType: sys.linkType ?? 'Entry' }
  return null
}

/** Pick the default-locale value from a per-locale field wrapper. Contentful always wraps
 *  ({ 'en-US': 'x' }); we resolve the default locale once, then fall back to the first key. */
function localized(wrapper: Record<string, unknown> | undefined, defaultLocale: string): unknown {
  if (!wrapper || typeof wrapper !== 'object') return undefined
  if (defaultLocale in wrapper) return wrapper[defaultLocale]
  const keys = Object.keys(wrapper)
  return keys.length ? wrapper[keys[0]!] : undefined
}

export async function readContentful(input: ImportInput): Promise<NormalizedDataset> {
  if (!input.file) throw new Error('Contentful import needs --file <export.json> (a contentful-export file).')
  let parsed: CfExport
  try {
    parsed = JSON.parse(await readFile(input.file, 'utf8')) as CfExport
  } catch (err) {
    throw new Error(
      `Could not parse the Contentful export as JSON: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const defaultLocale = parsed.locales?.find((l) => l.default)?.code ?? parsed.locales?.[0]?.code ?? 'en-US'
  const notes: string[] = [`Contentful: using default locale "${defaultLocale}" (other locales dropped).`]
  const records: NormalizedRecord[] = []

  for (const entry of parsed.entries ?? []) {
    const sourceId = entry.sys?.id
    const typeId = entry.sys?.contentType?.sys?.id
    if (!sourceId || !typeId) continue

    const data: Record<string, unknown> = {}
    const refs: NormalizedRef[] = []
    for (const [name, wrapper] of Object.entries(entry.fields ?? {})) {
      const value = localized(wrapper, defaultLocale)
      if (value === undefined) continue

      // Single link -> ref. Array of links -> hasMany ref by the linked ids.
      const single = asLink(value)
      if (single) {
        refs.push({ field: name, toSourceId: single.id })
        continue
      }
      if (Array.isArray(value) && value.length > 0 && value.every((v) => asLink(v))) {
        refs.push({ field: name, toSourceId: value.map((v) => asLink(v)!.id) })
        continue
      }
      data[name] = value
    }

    records.push({
      sourceType: typeId,
      sourceId,
      targetSlug: typeId,
      data,
      ...(refs.length ? { refs } : {}),
    })
  }

  // Assets -> media. Keep the resolved file URL + title/description so an operator can
  // re-host the bytes; we do not download them here.
  for (const asset of parsed.assets ?? []) {
    const sourceId = asset.sys?.id
    if (!sourceId) continue
    const file = localized(asset.fields?.file, defaultLocale) as { url?: string; fileName?: string } | undefined
    records.push({
      sourceType: 'asset',
      sourceId,
      targetSlug: 'media',
      data: {
        alt: localized(asset.fields?.title, defaultLocale) ?? '',
        url: file?.url ? (file.url.startsWith('//') ? `https:${file.url}` : file.url) : '',
        filename: file?.fileName ?? '',
      },
    })
  }

  return { records, notes }
}
