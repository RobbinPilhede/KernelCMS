// The portable shape every adapter normalizes a competitor export into, plus the
// engine's report. Adapters are pure parsers (source format -> NormalizedDataset);
// the engine does all writing, id-mapping, and relationship resolution. Keeping the
// model this small is the point: one record shape covers WordPress, Contentful,
// Sanity, Strapi, and Payload, so adding a sixth source is just one more parser.

/** One unresolved reference carried on a record. The engine resolves `toSourceId`
 *  through its `sourceId -> newId` map in a second pass and writes the kernel
 *  relationship field. `relationTo` is advisory (some sources name the target type);
 *  the engine maps by id regardless, so a missing/foreign `relationTo` is tolerated. */
export interface NormalizedRef {
  /** The target kernel field name (a `relationship`/`upload` field on `targetSlug`). */
  field: string
  /** The SOURCE id(s) this points at — resolved to new kernel id(s) in pass 2. */
  toSourceId: string | string[]
  /** Advisory target collection slug, when the source format names it. */
  relationTo?: string
}

/** One source document, mapped to a target collection but NOT yet written. `data`
 *  holds only scalar/embedded fields; relationships live in `refs` so the engine can
 *  create every record first (pass 1) and wire references afterwards (pass 2). */
export interface NormalizedRecord {
  /** The source content-type/post-type this came from (for reporting + skip notes). */
  sourceType: string
  /** The source's own id — the join key the engine maps to a new kernel id. */
  sourceId: string
  /** The kernel collection slug this record should land in. */
  targetSlug: string
  /** Scalar + embedded field values (no relationships — those go in `refs`). */
  data: Record<string, unknown>
  /** Deferred relationship writes, resolved by source id in the engine's second pass. */
  refs?: NormalizedRef[]
}

/** The full parse result from an adapter: every record plus any human-readable notes
 *  the adapter wants surfaced (ambiguous format choices, dropped locales, etc.). */
export interface NormalizedDataset {
  records: NormalizedRecord[]
  notes?: string[]
}

/** Where an adapter reads from. A file path is the fixture-verified path for every
 *  adapter; `url`/`token` drive the REST fallbacks (Strapi, Payload). `space`/`dataset`
 *  are Contentful/Sanity coordinates carried through for completeness. A `token` is a
 *  SECRET — it must never appear in the report, errors, or any log line. */
export interface ImportInput {
  file?: string
  url?: string
  token?: string
  space?: string
  dataset?: string
}

/** A source adapter: a name plus a pure read. Adapters are loaded lazily (one import
 *  never pulls in the other four) and never touch the kernel — the engine owns writes. */
export interface SourceAdapter {
  name: string
  read(input: ImportInput): Promise<NormalizedDataset>
}

/** The honest report the importer prints. Counts what landed, what was dropped, and
 *  what could not be resolved — the dry-run produces the SAME shape with zero writes,
 *  so a user can preview exactly what an apply would do. */
export interface ImportReport {
  /** The source name (e.g. 'wordpress'). */
  source: string
  /** True when nothing was written (preview). */
  dryRun: boolean
  /** Documents created (or would-create, dry-run), per target slug. */
  created: Record<string, number>
  /** Relationship writes applied (or would-apply, dry-run) in pass 2. */
  updated: number
  /** Records whose target type isn't in the config — skipped, never fatal. */
  skipped: Array<{ sourceType: string; reason: string }>
  /** Source fields with no matching target field, dropped per slug (deduped). */
  droppedFields: Record<string, string[]>
  /** References that could not be resolved to an imported document. */
  danglingRefs: number
  /** Per-record hard errors (a create/update threw). Never carries a token. */
  errors: Array<{ sourceId: string; message: string }>
}
