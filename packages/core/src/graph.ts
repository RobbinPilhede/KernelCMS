/**
 * Content knowledge graph — bounded, access-checked BFS traversal over typed
 * relationships, and the plumbing for GraphRAG retrieval.
 *
 * A node is a document (`${collection}:${id}`); an edge is a typed relationship.
 * Two edge kinds:
 *   - `'relationship'` — an OUTBOUND relationship/upload field on the source doc
 *     (a single id, an id array, or a polymorphic `{ relationTo, value }`).
 *   - `'reverse'`      — a virtual `join` field: the INBOUND edge resolved by
 *     querying the related collection where its `on` field points back at this doc.
 *
 * The pure helpers here (ref parse/guard, label/text extraction, edge extraction)
 * are unit-tested directly; the BFS engine takes loader callbacks so it can be
 * driven both by the access-checked ops (production) and by stubs (tests). The
 * SECURITY contract lives at the loader boundary: `loadNode` returns null for a
 * document the caller may not read, and a null node is never added — nor is the
 * edge that pointed at it. The graph therefore never reveals a node, a label, a
 * field value, or even a relationship to a document the caller cannot read.
 */
import { toPlainText } from '@kernel/richtext'
import type { KernelRichText } from '@kernel/richtext'
import type { CollectionConfig, Doc, GraphEdge, GraphNode } from './types'
import { effectiveFields, joinFields, relationshipFields } from './fields'

/** Default BFS hop budget when the caller omits `depth`. */
export const DEFAULT_GRAPH_DEPTH = 1
/** Default total-node cap when the caller omits `maxNodes`. */
export const DEFAULT_GRAPH_MAX_NODES = 100
/** Hard ceiling on total nodes a single traversal may return — clamps a hostile or
 *  fat-fingered `maxNodes` so a hub node can't explode the BFS (DoS guard). */
export const GRAPH_MAX_NODES_HARD_CAP = 500
/** Per-node fan-out cap: at most this many neighbour ids are explored from any one
 *  node, so a single hub with thousands of relations can't blow up one BFS level. */
export const GRAPH_MAX_FANOUT_PER_NODE = 200
/** Default + hard caps on GraphRAG seed count. */
export const DEFAULT_GRAPH_SEARCH_LIMIT = 5
export const GRAPH_SEARCH_MAX_LIMIT = 25
/** Max characters of body text kept in a context snippet (bounds prompt size). */
export const GRAPH_CONTEXT_TEXT_MAX = 500

/** Keys that must never be treated as a collection slug or used as an object key —
 *  a defence-in-depth guard against prototype pollution via a crafted ref. */
const FORBIDDEN_REF_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** Build a node ref. Parsing splits on the FIRST colon only, so an id that itself
 *  contains a colon round-trips. */
export function makeRef(collection: string, id: string): string {
  return `${collection}:${id}`
}

/** Parse a `${collection}:${id}` ref. Returns null for a malformed ref, an empty
 *  collection/id, or a prototype-pollution collection segment — so a hostile ref can
 *  never inject a key or address a non-collection. Splits on the FIRST colon, so the
 *  id may itself contain colons. */
export function parseRef(ref: string): { collection: string; id: string } | null {
  if (typeof ref !== 'string') return null
  const idx = ref.indexOf(':')
  if (idx <= 0 || idx >= ref.length - 1) return null
  const collection = ref.slice(0, idx)
  const id = ref.slice(idx + 1)
  if (FORBIDDEN_REF_KEYS.has(collection)) return null
  if (collection.length === 0 || id.length === 0) return null
  return { collection, id }
}

function isRichText(value: unknown): value is KernelRichText {
  return Boolean(value) && typeof value === 'object' && (value as { type?: unknown }).type === 'doc'
}

/** Pick the collection's title field: `admin.useAsTitle`, then a `title`/`name`/
 *  `heading`/`label` field if present. Returns null when none exists. */
export function resolveTitleField(collection: CollectionConfig): string | null {
  const fields = effectiveFields(collection.fields)
  const has = (name: string | undefined): name is string => !!name && fields.some((f) => f.name === name)
  const useAsTitle = collection.admin?.useAsTitle
  if (has(useAsTitle)) return useAsTitle
  for (const candidate of ['title', 'name', 'heading', 'label']) {
    if (has(candidate)) return candidate
  }
  return null
}

/** A document's display label — the resolved title field's string value, falling back
 *  to `${collection} ${id}`. Because it reads from the ALREADY-access-stripped doc, a
 *  read-denied title field is simply absent and the fallback is used (never a leak). */
export function resolveLabel(collection: CollectionConfig, doc: Doc): string {
  const field = resolveTitleField(collection)
  if (field) {
    const raw = doc[field]
    if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim()
    if (isRichText(raw)) {
      const text = toPlainText(raw).trim()
      if (text.length > 0) return text
    }
  }
  return `${collection.slug} ${doc.id}`
}

/** A plain-text grounding snippet for a node: the first richText field rendered to
 *  text, else the first textarea/text field, truncated. Operates on the access-
 *  stripped doc, so a read-denied field never contributes. Empty string when nothing
 *  textual is readable. */
export function extractText(collection: CollectionConfig, doc: Doc): string {
  const fields = effectiveFields(collection.fields)
  const rich = fields.find((f) => f.type === 'richText' && isRichText(doc[f.name]))
  if (rich) return truncate(toPlainText(doc[rich.name] as KernelRichText), GRAPH_CONTEXT_TEXT_MAX)
  const text = fields.find(
    (f) => (f.type === 'textarea' || f.type === 'text') && typeof doc[f.name] === 'string' && doc[f.name] !== '',
  )
  if (text) return truncate(String(doc[text.name]).trim(), GRAPH_CONTEXT_TEXT_MAX)
  return ''
}

function truncate(s: string, max: number): string {
  const collapsed = s.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= max) return collapsed
  return `${collapsed.slice(0, max - 1).trimEnd()}…`
}

/** A neighbour reachable from a node: where to load it and what edge connects them. */
export interface GraphNeighbor {
  collection: string
  id: string
  field: string
  relationTo: string
  kind: 'relationship' | 'reverse'
}

/** A reverse-relationship query descriptor: query `collection` where `on` equals the
 *  source doc's id; each match is a `reverse` neighbour. */
export interface JoinNeighborQuery {
  field: string
  collection: string
  on: string
}

/**
 * Extract OUTBOUND relationship neighbours from a (populated-or-raw) document. Reads
 * each relationship/upload field's stored value, which is one of: a single id/number,
 * an id array (hasMany), or a polymorphic `{ relationTo, value }` (or an array of
 * them). A value may already be POPULATED to a `{ id, ... }` doc — handled by reading
 * `.id` off objects. Skips refs whose target collection isn't configured. Bounded per
 * field by `GRAPH_MAX_FANOUT_PER_NODE` so a hub field can't explode one node's edges.
 */
export function outboundNeighbors(
  collection: CollectionConfig,
  doc: Doc,
  isCollection: (slug: string) => boolean,
): GraphNeighbor[] {
  const out: GraphNeighbor[] = []
  for (const rel of relationshipFields(collection.fields)) {
    const value = doc[rel.name]
    if (value == null) continue
    if (rel.polymorphic) {
      const refs = rel.hasMany ? (Array.isArray(value) ? value : []) : [value]
      for (const ref of refs) {
        if (out.length >= GRAPH_MAX_FANOUT_PER_NODE) break
        if (!ref || typeof ref !== 'object') continue
        const { relationTo, value: target } = ref as { relationTo?: unknown; value?: unknown }
        if (typeof relationTo !== 'string' || FORBIDDEN_REF_KEYS.has(relationTo) || !isCollection(relationTo)) continue
        const id = idOf(target)
        if (id == null) continue
        out.push({ collection: relationTo, id, field: rel.name, relationTo, kind: 'relationship' })
      }
    } else {
      const relTo = rel.relationTo as string
      if (typeof relTo !== 'string' || !isCollection(relTo)) continue
      const ids = rel.hasMany ? (Array.isArray(value) ? value : []) : [value]
      for (const raw of ids) {
        if (out.length >= GRAPH_MAX_FANOUT_PER_NODE) break
        const id = idOf(raw)
        if (id == null) continue
        out.push({ collection: relTo, id, field: rel.name, relationTo: relTo, kind: 'relationship' })
      }
    }
  }
  return out
}

/** The reverse-relationship (`join`) queries to run for a node: each yields inbound
 *  `reverse` neighbours from the related collection where `on` references this doc. */
export function joinNeighborQueries(
  collection: CollectionConfig,
  isCollection: (slug: string) => boolean,
): JoinNeighborQuery[] {
  const out: JoinNeighborQuery[] = []
  for (const join of joinFields(collection.fields)) {
    if (!isCollection(join.collection)) continue
    out.push({ field: join.name, collection: join.collection, on: join.on })
  }
  return out
}

/** Coerce a stored relationship target into an id string. Accepts a scalar id (string
 *  or number) or an already-populated `{ id }` object; anything else yields null. */
function idOf(value: unknown): string | null {
  if (typeof value === 'string') return value.length > 0 ? value : null
  if (typeof value === 'number') return String(value)
  if (value && typeof value === 'object') {
    const id = (value as { id?: unknown }).id
    if (typeof id === 'string' && id.length > 0) return id
    if (typeof id === 'number') return String(id)
  }
  return null
}

/** Clamp a `maxNodes` request to `[1, GRAPH_MAX_NODES_HARD_CAP]` (default when absent). */
export function clampMaxNodes(maxNodes: number | undefined): number {
  const n = Math.floor(Number(maxNodes ?? DEFAULT_GRAPH_MAX_NODES))
  if (!Number.isFinite(n)) return DEFAULT_GRAPH_MAX_NODES
  return Math.min(Math.max(1, n), GRAPH_MAX_NODES_HARD_CAP)
}

/** Clamp a depth request to `[0, hardDepthCap]` (default when absent). */
export function clampDepth(depth: number | undefined, hardDepthCap: number): number {
  const n = Math.floor(Number(depth ?? DEFAULT_GRAPH_DEPTH))
  if (!Number.isFinite(n)) return DEFAULT_GRAPH_DEPTH
  return Math.min(Math.max(0, n), hardDepthCap)
}

/** Clamp a GraphRAG seed `limit` to `[1, GRAPH_SEARCH_MAX_LIMIT]` (default when absent). */
export function clampSeedLimit(limit: number | undefined): number {
  const n = Math.floor(Number(limit ?? DEFAULT_GRAPH_SEARCH_LIMIT))
  if (!Number.isFinite(n)) return DEFAULT_GRAPH_SEARCH_LIMIT
  return Math.min(Math.max(1, n), GRAPH_SEARCH_MAX_LIMIT)
}

/** A node that survived the access-checked load, paired with its source collection so
 *  the BFS can resolve its own neighbours. `node` carries the public-facing fields;
 *  `doc` is the full (access-stripped) document for neighbour extraction + context. */
export interface LoadedNode {
  node: GraphNode
  collection: CollectionConfig
  doc: Doc
}

/** The loader surface the BFS engine needs. Both calls MUST enforce the caller's read
 *  access — returning null / an empty list for anything the caller may not read. */
export interface GraphLoaders {
  /** Load one node by collection + id through the access-checked read path. Returns
   *  null when the doc is missing, a hidden draft, or read-denied. */
  loadNode(collection: string, id: string): Promise<LoadedNode | null>
  /** Run a reverse-relationship query (access-checked), returning the matching docs of
   *  `query.collection` whose `on` field references `fromId`. Each becomes a node. */
  loadReverse(query: JoinNeighborQuery, fromId: string): Promise<LoadedNode[]>
  /** Whether a slug is a configured, non-system collection (gates which edges expand). */
  isCollection(slug: string): boolean
}

export interface TraverseOptions {
  depth: number
  maxNodes: number
}

/**
 * Bounded, access-checked BFS over the content graph from a seed `{collection, id}`.
 *
 * - Loads every candidate node through `loaders.loadNode`; a null result (missing /
 *   draft / read-denied) is DROPPED and no edge to it is recorded — the core security
 *   property (no leak of a non-readable node or the relationship to it).
 * - Follows outbound relationship/upload edges AND inbound `join` reverse edges.
 * - De-dupes nodes by ref and edges by `(from,to,field,kind)` so a cycle (A->B->A)
 *   terminates and a repeated relation isn't double-counted.
 * - Stops once `maxNodes` nodes are admitted (sets `truncated`); per-node fan-out is
 *   already bounded by `outboundNeighbors`, so a hub can't explode a single level.
 */
export async function traverseGraph(
  loaders: GraphLoaders,
  seed: { collection: string; id: string },
  opts: TraverseOptions,
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean }> {
  const nodes = new Map<string, GraphNode>()
  const edgeKeys = new Set<string>()
  const edges: GraphEdge[] = []
  // Refs whose neighbours have already been expanded — guarantees each node is walked
  // at most once (cycle termination, e.g. A->B->A; de-dupes diamond paths). Per call.
  const expanded = new Set<string>()
  let truncated = false

  const addEdge = (e: GraphEdge): void => {
    const key = `${e.from} ${e.to} ${e.field} ${e.kind}`
    if (edgeKeys.has(key)) return
    edgeKeys.add(key)
    edges.push(e)
  }

  // Admit a loaded node, returning false (and marking truncated) when the cap is hit.
  // An already-present node is a no-op success (its edge still records).
  const admit = (loaded: LoadedNode): boolean => {
    if (nodes.has(loaded.node.ref)) return true
    if (nodes.size >= opts.maxNodes) {
      truncated = true
      return false
    }
    nodes.set(loaded.node.ref, loaded.node)
    return true
  }

  if (!loaders.isCollection(seed.collection)) return { nodes: [], edges: [], truncated: false }
  const seedLoaded = await loaders.loadNode(seed.collection, seed.id)
  if (!seedLoaded) return { nodes: [], edges: [], truncated: false }
  admit(seedLoaded)

  // BFS frontier: admitted nodes whose neighbours are still to be expanded, with hop.
  let frontier: Array<{ loaded: LoadedNode; hop: number }> = [{ loaded: seedLoaded, hop: 0 }]

  while (frontier.length > 0) {
    const next: Array<{ loaded: LoadedNode; hop: number }> = []
    for (const { loaded, hop } of frontier) {
      if (hop >= opts.depth) continue
      // Expand each node at most once (its first, shortest-hop appearance) — cycle +
      // diamond-path termination. A node reached again later is already in `nodes`, so
      // its edges still record, but it is not re-walked.
      if (expanded.has(loaded.node.ref)) continue
      expanded.add(loaded.node.ref)
      const fromRef = loaded.node.ref

      // Outbound relationship/upload edges — read from the doc's stored values.
      for (const nb of outboundNeighbors(loaded.collection, loaded.doc, loaders.isCollection)) {
        const target = await loaders.loadNode(nb.collection, nb.id)
        // Non-readable / missing -> DROP the node AND its edge (the no-leak property).
        if (!target) continue
        const admitted = admit(target)
        addEdge({
          from: fromRef,
          to: target.node.ref,
          field: nb.field,
          relationTo: nb.relationTo,
          kind: 'relationship',
        })
        if (admitted) next.push({ loaded: target, hop: hop + 1 })
      }

      // Inbound reverse (`join`) edges — each reverse query is itself access-checked.
      for (const q of joinNeighborQueries(loaded.collection, loaders.isCollection)) {
        const matches = await loaders.loadReverse(q, loaded.node.id)
        for (const target of matches) {
          const admitted = admit(target)
          addEdge({ from: fromRef, to: target.node.ref, field: q.field, relationTo: q.collection, kind: 'reverse' })
          if (admitted) next.push({ loaded: target, hop: hop + 1 })
        }
      }
    }
    frontier = next
  }

  return { nodes: [...nodes.values()], edges, truncated }
}
