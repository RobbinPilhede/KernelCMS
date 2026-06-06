/**
 * Feature/allow-list system for a `richText` field. Features are the unit of
 * capability, validation, and security — anything not enabled is stripped on
 * input and rejected on save. `resolveRichTextSchema` flattens features (or a
 * preset) into a single concrete object that drives the sanitizer, the editor,
 * and validation. See docs/specs/01-rich-text.md §5.
 */
import type { MarkType, RichBlockNode } from './types'

export type HeadingLevel = 2 | 3 | 4

export type RichTextFeature =
  | { kind: 'marks'; allow: MarkType[] }
  | { kind: 'headings'; levels: HeadingLevel[] }
  | { kind: 'lists'; ordered?: boolean; unordered?: boolean }
  | { kind: 'quote' }
  | { kind: 'codeBlock'; languages?: string[] }
  | { kind: 'hr' }
  | { kind: 'link'; internal?: { collections: string[] }; allowNewTab?: boolean }
  | { kind: 'relationship'; collections: string[] }
  | { kind: 'upload'; collections: string[] }
  | { kind: 'blocks'; blocks: string[] }

export type RichTextPreset = 'minimal' | 'standard' | 'full'

/** The flattened, concrete capability set. One source of truth. */
export interface ResolvedRichTextSchema {
  marks: ReadonlySet<MarkType>
  /** Allowed block node `type`s (paragraph is always allowed). */
  nodes: ReadonlySet<RichBlockNode['type']>
  headingLevels: ReadonlySet<HeadingLevel>
  lists: { ordered: boolean; unordered: boolean }
  codeLanguages: ReadonlySet<string> | null // null = any language allowed
  link: { enabled: boolean; allowNewTab: boolean; internalCollections: ReadonlySet<string> }
  relationshipCollections: ReadonlySet<string>
  uploadCollections: ReadonlySet<string>
  blockSlugs: ReadonlySet<string>
  /** Max nesting depth for block containers (quote/list). Bounds payload size. */
  maxDepth: number
}

const PRESETS: Record<RichTextPreset, RichTextFeature[]> = {
  minimal: [{ kind: 'marks', allow: ['bold', 'italic'] }],
  standard: [
    { kind: 'marks', allow: ['bold', 'italic', 'underline', 'strike', 'code'] },
    { kind: 'headings', levels: [2, 3] },
    { kind: 'lists', ordered: true, unordered: true },
    { kind: 'quote' },
    { kind: 'hr' },
    { kind: 'link', allowNewTab: true },
  ],
  full: [
    { kind: 'marks', allow: ['bold', 'italic', 'underline', 'strike', 'code', 'sub', 'sup'] },
    { kind: 'headings', levels: [2, 3, 4] },
    { kind: 'lists', ordered: true, unordered: true },
    { kind: 'quote' },
    { kind: 'codeBlock' },
    { kind: 'hr' },
    { kind: 'link', allowNewTab: true },
  ],
}

/** Resolve a preset name into its explicit feature list. */
export function presetFeatures(preset: RichTextPreset): RichTextFeature[] {
  return PRESETS[preset].map((f) => ({ ...f }))
}

export interface ResolveOptions {
  features?: RichTextFeature[]
  preset?: RichTextPreset
  maxDepth?: number
}

/** Flatten features/preset into the concrete schema. Defaults to the 'standard' preset. */
export function resolveRichTextSchema(opts: ResolveOptions = {}): ResolvedRichTextSchema {
  const features = opts.features ?? presetFeatures(opts.preset ?? 'standard')

  const marks = new Set<MarkType>()
  const nodes = new Set<RichBlockNode['type']>(['paragraph'])
  const headingLevels = new Set<HeadingLevel>()
  const lists = { ordered: false, unordered: false }
  let codeLanguages: Set<string> | null = null
  const link = { enabled: false, allowNewTab: false, internalCollections: new Set<string>() }
  const relationshipCollections = new Set<string>()
  const uploadCollections = new Set<string>()
  const blockSlugs = new Set<string>()

  for (const f of features) {
    switch (f.kind) {
      case 'marks':
        for (const m of f.allow) marks.add(m)
        break
      case 'headings':
        nodes.add('heading')
        for (const l of f.levels) headingLevels.add(l)
        break
      case 'lists':
        nodes.add('list')
        nodes.add('listItem')
        if (f.ordered !== false) lists.ordered = true
        if (f.unordered !== false) lists.unordered = true
        break
      case 'quote':
        nodes.add('quote')
        break
      case 'codeBlock':
        nodes.add('codeBlock')
        if (f.languages) codeLanguages = new Set(f.languages)
        break
      case 'hr':
        nodes.add('hr')
        break
      case 'link':
        link.enabled = true
        link.allowNewTab = Boolean(f.allowNewTab)
        for (const c of f.internal?.collections ?? []) link.internalCollections.add(c)
        break
      case 'relationship':
        // Relationships are inline-only; gated by relationshipCollections, not the block node set.
        for (const c of f.collections) relationshipCollections.add(c)
        break
      case 'upload':
        nodes.add('upload')
        for (const c of f.collections) uploadCollections.add(c)
        break
      case 'blocks':
        nodes.add('block')
        for (const b of f.blocks) blockSlugs.add(b)
        break
    }
  }

  return {
    marks,
    nodes,
    headingLevels,
    lists,
    codeLanguages,
    link,
    relationshipCollections,
    uploadCollections,
    blockSlugs,
    maxDepth: opts.maxDepth ?? 6,
  }
}
