// Public surface for the importer + the lazy adapter registry. Each adapter is loaded
// with a dynamic import only when its source is selected, so `kernel import --from sanity`
// never parses (or even loads) the WordPress XML reader, and vice versa.

import type { ImportInput, NormalizedDataset, SourceAdapter } from './types'

export type {
  ImportInput,
  NormalizedDataset,
  NormalizedRecord,
  NormalizedRef,
  SourceAdapter,
  ImportReport,
} from './types'
export { runImport, formatImportReport } from './engine'
export type { RunImportOptions } from './engine'

/** The five supported sources. Used to validate `--from` and drive lazy loading. */
export const IMPORT_SOURCES = ['wordpress', 'contentful', 'sanity', 'strapi', 'payload'] as const
export type ImportSource = (typeof IMPORT_SOURCES)[number]

export function isImportSource(value: string): value is ImportSource {
  return (IMPORT_SOURCES as readonly string[]).includes(value)
}

/** Resolve an adapter by name, importing only that adapter's module. */
export async function loadAdapter(source: ImportSource): Promise<SourceAdapter> {
  switch (source) {
    case 'wordpress': {
      const { readWordPress } = await import('./adapters/wordpress')
      return { name: 'wordpress', read: (i: ImportInput): Promise<NormalizedDataset> => readWordPress(i) }
    }
    case 'contentful': {
      const { readContentful } = await import('./adapters/contentful')
      return { name: 'contentful', read: (i: ImportInput): Promise<NormalizedDataset> => readContentful(i) }
    }
    case 'sanity': {
      const { readSanity } = await import('./adapters/sanity')
      return { name: 'sanity', read: (i: ImportInput): Promise<NormalizedDataset> => readSanity(i) }
    }
    case 'strapi': {
      const { readStrapi } = await import('./adapters/strapi')
      return { name: 'strapi', read: (i: ImportInput): Promise<NormalizedDataset> => readStrapi(i) }
    }
    case 'payload': {
      const { readPayload } = await import('./adapters/payload')
      return { name: 'payload', read: (i: ImportInput): Promise<NormalizedDataset> => readPayload(i) }
    }
  }
}
