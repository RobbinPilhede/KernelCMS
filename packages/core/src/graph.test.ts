import { describe, expect, it } from 'vitest'
import type { CollectionConfig, Doc } from './types'
import {
  clampDepth,
  clampMaxNodes,
  clampSeedLimit,
  joinNeighborQueries,
  makeRef,
  outboundNeighbors,
  parseRef,
  resolveLabel,
  traverseGraph,
  type GraphLoaders,
  type JoinNeighborQuery,
  type LoadedNode,
} from './graph'

// ── fixtures ────────────────────────────────────────────────────────────────────

const authors: CollectionConfig = {
  slug: 'authors',
  admin: { useAsTitle: 'name' },
  fields: [
    { name: 'name', type: 'text' },
    { name: 'posts', type: 'join', collection: 'posts', on: 'author' },
  ],
}

const posts: CollectionConfig = {
  slug: 'posts',
  admin: { useAsTitle: 'title' },
  fields: [
    { name: 'title', type: 'text' },
    { name: 'author', type: 'relationship', relationTo: 'authors' },
    { name: 'categories', type: 'relationship', relationTo: 'categories', hasMany: true },
    { name: 'related', type: 'relationship', relationTo: ['posts', 'authors'] }, // polymorphic
  ],
}

const known = new Set(['authors', 'posts', 'categories'])
const isCollection = (slug: string): boolean => known.has(slug)

/** Build a stubbed loader surface from in-memory docs keyed by `${collection}:${id}`. */
function stubLoaders(
  docs: Record<string, { collection: CollectionConfig; doc: Doc }>,
  collections: Record<string, CollectionConfig>,
): GraphLoaders {
  const toLoaded = (slug: string, doc: Doc): LoadedNode => ({
    collection: collections[slug]!,
    doc,
    node: { ref: makeRef(slug, doc.id), collection: slug, id: doc.id, label: resolveLabel(collections[slug]!, doc) },
  })
  return {
    isCollection: (slug) => slug in collections,
    async loadNode(slug, id) {
      const found = docs[makeRef(slug, id)]
      return found ? toLoaded(slug, found.doc) : null
    },
    async loadReverse(query: JoinNeighborQuery, fromId: string) {
      const out: LoadedNode[] = []
      for (const key of Object.keys(docs)) {
        const { collection, doc } = docs[key]!
        if (collection.slug !== query.collection) continue
        if (doc[query.on] === fromId) out.push(toLoaded(collection.slug, doc))
      }
      return out
    },
  }
}

// ── ref parsing / guards ──────────────────────────────────────────────────────────

describe('parseRef', () => {
  it('round-trips a normal ref', () => {
    expect(parseRef(makeRef('posts', 'p1'))).toEqual({ collection: 'posts', id: 'p1' })
  })

  it('splits on the FIRST colon so ids may contain colons', () => {
    expect(parseRef('posts:a:b:c')).toEqual({ collection: 'posts', id: 'a:b:c' })
  })

  it('rejects a malformed ref (no colon, empty side)', () => {
    expect(parseRef('posts')).toBeNull()
    expect(parseRef(':p1')).toBeNull()
    expect(parseRef('posts:')).toBeNull()
    expect(parseRef('')).toBeNull()
  })

  it('rejects a prototype-pollution collection segment', () => {
    expect(parseRef('__proto__:x')).toBeNull()
    expect(parseRef('constructor:x')).toBeNull()
    expect(parseRef('prototype:x')).toBeNull()
  })
})

// ── label resolution ──────────────────────────────────────────────────────────────

describe('resolveLabel', () => {
  it('uses the useAsTitle field value', () => {
    expect(resolveLabel(posts, { id: 'p1', title: 'Hello' } as Doc)).toBe('Hello')
  })

  it('falls back to `${slug} ${id}` when the title field is absent (e.g. read-stripped)', () => {
    expect(resolveLabel(posts, { id: 'p1' } as Doc)).toBe('posts p1')
  })
})

// ── edge extraction ────────────────────────────────────────────────────────────────

describe('outboundNeighbors', () => {
  it('extracts a single relationship id', () => {
    const nbs = outboundNeighbors(posts, { id: 'p1', author: 'a1' } as Doc, isCollection)
    expect(nbs).toContainEqual({
      collection: 'authors',
      id: 'a1',
      field: 'author',
      relationTo: 'authors',
      kind: 'relationship',
    })
  })

  it('extracts a hasMany relationship id array', () => {
    const nbs = outboundNeighbors(posts, { id: 'p1', categories: ['c1', 'c2'] } as Doc, isCollection)
    const cats = nbs.filter((n) => n.field === 'categories').map((n) => n.id)
    expect(cats).toEqual(['c1', 'c2'])
  })

  it('extracts a polymorphic { relationTo, value } ref', () => {
    const doc = { id: 'p1', related: { relationTo: 'authors', value: 'a9' } } as unknown as Doc
    const nbs = outboundNeighbors(posts, doc, isCollection)
    expect(nbs).toContainEqual({
      collection: 'authors',
      id: 'a9',
      field: 'related',
      relationTo: 'authors',
      kind: 'relationship',
    })
  })

  it('reads the id off an already-populated relation object', () => {
    const nbs = outboundNeighbors(posts, { id: 'p1', author: { id: 'a1', name: 'X' } } as unknown as Doc, isCollection)
    expect(nbs.find((n) => n.field === 'author')?.id).toBe('a1')
  })

  it('skips refs to an unconfigured target collection', () => {
    const doc = { id: 'p1', related: { relationTo: 'ghosts', value: 'g1' } } as unknown as Doc
    expect(outboundNeighbors(posts, doc, isCollection)).toHaveLength(0)
  })

  it('skips a prototype-pollution polymorphic relationTo', () => {
    const doc = { id: 'p1', related: { relationTo: '__proto__', value: 'x' } } as unknown as Doc
    expect(outboundNeighbors(posts, doc, isCollection)).toHaveLength(0)
  })
})

describe('joinNeighborQueries', () => {
  it('emits a reverse query for each join field', () => {
    expect(joinNeighborQueries(authors, isCollection)).toEqual([{ field: 'posts', collection: 'posts', on: 'author' }])
  })
})

// ── clamps ──────────────────────────────────────────────────────────────────────

describe('clamps', () => {
  it('clampDepth bounds to [0, cap] and defaults to 1', () => {
    expect(clampDepth(undefined, 10)).toBe(1)
    expect(clampDepth(-5, 10)).toBe(0)
    expect(clampDepth(999, 10)).toBe(10)
    expect(clampDepth(NaN, 10)).toBe(1)
  })

  it('clampMaxNodes bounds to [1, 500] and defaults to 100', () => {
    expect(clampMaxNodes(undefined)).toBe(100)
    expect(clampMaxNodes(0)).toBe(1)
    expect(clampMaxNodes(99999)).toBe(500)
  })

  it('clampSeedLimit bounds to [1, 25] and defaults to 5', () => {
    expect(clampSeedLimit(undefined)).toBe(5)
    expect(clampSeedLimit(0)).toBe(1)
    expect(clampSeedLimit(1000)).toBe(25)
  })
})

// ── BFS engine ────────────────────────────────────────────────────────────────────

const collections = {
  authors,
  posts,
  categories: {
    slug: 'categories',
    admin: { useAsTitle: 'name' },
    fields: [{ name: 'name', type: 'text' }],
  } as CollectionConfig,
}

describe('traverseGraph', () => {
  it('walks the seed + outbound + reverse edges with correct kinds and labels', async () => {
    const docs = {
      'authors:a1': { collection: authors, doc: { id: 'a1', name: 'Ada' } as Doc },
      'posts:p1': { collection: posts, doc: { id: 'p1', title: 'First', author: 'a1', categories: ['c1'] } as Doc },
      'categories:c1': { collection: collections.categories, doc: { id: 'c1', name: 'Tech' } as Doc },
    }
    const loaders = stubLoaders(docs, collections)
    const res = await traverseGraph(loaders, { collection: 'authors', id: 'a1' }, { depth: 2, maxNodes: 100 })

    const refs = res.nodes.map((n) => n.ref).sort()
    expect(refs).toEqual(['authors:a1', 'categories:c1', 'posts:p1'])
    // reverse edge author -> post (the join), relationship edge post -> category at depth 2.
    expect(res.edges).toContainEqual({
      from: 'authors:a1',
      to: 'posts:p1',
      field: 'posts',
      relationTo: 'posts',
      kind: 'reverse',
    })
    expect(res.edges).toContainEqual({
      from: 'posts:p1',
      to: 'categories:c1',
      field: 'categories',
      relationTo: 'categories',
      kind: 'relationship',
    })
    // label comes from the title field.
    expect(res.nodes.find((n) => n.ref === 'categories:c1')?.label).toBe('Tech')
    expect(res.truncated).toBe(false)
  })

  it('depth:1 stops at posts and does not reach categories', async () => {
    const docs = {
      'authors:a1': { collection: authors, doc: { id: 'a1', name: 'Ada' } as Doc },
      'posts:p1': { collection: posts, doc: { id: 'p1', title: 'First', author: 'a1', categories: ['c1'] } as Doc },
      'categories:c1': { collection: collections.categories, doc: { id: 'c1', name: 'Tech' } as Doc },
    }
    const loaders = stubLoaders(docs, collections)
    const res = await traverseGraph(loaders, { collection: 'authors', id: 'a1' }, { depth: 1, maxNodes: 100 })
    const refs = res.nodes.map((n) => n.ref).sort()
    expect(refs).toEqual(['authors:a1', 'posts:p1'])
  })

  it('drops a non-readable node AND the edge to it (no leak)', async () => {
    // posts:p1 references author a1, but a1 is NOT loadable (forbidden) -> absent from docs.
    const docs = {
      'posts:p1': { collection: posts, doc: { id: 'p1', title: 'First', author: 'a1' } as Doc },
    }
    const loaders = stubLoaders(docs, collections)
    const res = await traverseGraph(loaders, { collection: 'posts', id: 'p1' }, { depth: 2, maxNodes: 100 })
    expect(res.nodes.map((n) => n.ref)).toEqual(['posts:p1'])
    // No edge points at the forbidden author.
    expect(res.edges.some((e) => e.to === 'authors:a1')).toBe(false)
  })

  it('terminates on a cycle A->B->A (de-dupe)', async () => {
    const a: CollectionConfig = {
      slug: 'a',
      admin: { useAsTitle: 'name' },
      fields: [
        { name: 'name', type: 'text' },
        { name: 'b', type: 'relationship', relationTo: 'b' },
      ],
    }
    const b: CollectionConfig = {
      slug: 'b',
      admin: { useAsTitle: 'name' },
      fields: [
        { name: 'name', type: 'text' },
        { name: 'a', type: 'relationship', relationTo: 'a' },
      ],
    }
    const cyc = { a, b }
    const docs = {
      'a:1': { collection: a, doc: { id: '1', name: 'A', b: '1' } as Doc },
      'b:1': { collection: b, doc: { id: '1', name: 'B', a: '1' } as Doc },
    }
    const loaders = stubLoaders(docs, cyc)
    const res = await traverseGraph(loaders, { collection: 'a', id: '1' }, { depth: 10, maxNodes: 100 })
    expect(res.nodes.map((n) => n.ref).sort()).toEqual(['a:1', 'b:1'])
  })

  it('truncates and never exceeds maxNodes on a hub', async () => {
    // One hub author with many reverse posts.
    const docs: Record<string, { collection: CollectionConfig; doc: Doc }> = {
      'authors:a1': { collection: authors, doc: { id: 'a1', name: 'Hub' } as Doc },
    }
    for (let i = 0; i < 50; i++) {
      docs[`posts:p${i}`] = { collection: posts, doc: { id: `p${i}`, title: `Post ${i}`, author: 'a1' } as Doc }
    }
    const loaders = stubLoaders(docs, collections)
    const res = await traverseGraph(loaders, { collection: 'authors', id: 'a1' }, { depth: 1, maxNodes: 10 })
    expect(res.nodes.length).toBeLessThanOrEqual(10)
    expect(res.truncated).toBe(true)
  })

  it('returns empty for an unknown seed collection', async () => {
    const loaders = stubLoaders({}, collections)
    const res = await traverseGraph(loaders, { collection: 'ghosts', id: 'x' }, { depth: 1, maxNodes: 100 })
    expect(res).toEqual({ nodes: [], edges: [], truncated: false })
  })

  it('returns empty when the seed itself is not readable', async () => {
    const loaders = stubLoaders({}, collections)
    const res = await traverseGraph(loaders, { collection: 'posts', id: 'missing' }, { depth: 1, maxNodes: 100 })
    expect(res.nodes).toHaveLength(0)
  })

  it('de-dupes a repeated edge', async () => {
    // p1 lists c1 twice in categories — only one edge should result.
    const docs = {
      'posts:p1': { collection: posts, doc: { id: 'p1', title: 'First', categories: ['c1', 'c1'] } as Doc },
      'categories:c1': { collection: collections.categories, doc: { id: 'c1', name: 'Tech' } as Doc },
    }
    const loaders = stubLoaders(docs, collections)
    const res = await traverseGraph(loaders, { collection: 'posts', id: 'p1' }, { depth: 1, maxNodes: 100 })
    const catEdges = res.edges.filter((e) => e.to === 'categories:c1')
    expect(catEdges).toHaveLength(1)
  })
})
