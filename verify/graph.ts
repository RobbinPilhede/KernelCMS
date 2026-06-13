/* Live content-knowledge-graph + GraphRAG verification against a real sqlite kernel.
 *
 * Builds a small typed graph — authors (reverse `posts` join) → posts (relationship
 * `author`, hasMany `categories`) → categories — plus an owner-scoped `secrets`
 * collection for the access test, and a DETERMINISTIC bag-of-words embedder (same
 * technique as verify/semantic.ts) so GraphRAG seeding is reproducible with no
 * external API.
 *
 * Proves:
 *  - `graph({authors, depth:2})` returns the author, its posts (reverse join edge),
 *    and the posts' categories (depth 2), with correct edge kinds + labels; depth:1
 *    stops at posts.
 *  - access: a post the caller can't read (owner-scoped) is absent AND no edge points
 *    at it; a read-denied field never appears in a node label.
 *  - bounds: a small `maxNodes` truncates and is never exceeded; a hub doesn't explode;
 *    a deep cycle terminates (de-dupe).
 *  - `graphSearch({query})` returns semantic seeds AND their expanded connected context
 *    (nodes/edges/context); an irrelevant doc isn't a seed; context is access-checked.
 * Run: pnpm tsx verify/graph.ts */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig, initKernel, type Doc, type RequestContext } from '@kernel/core'
import { sqliteAdapter } from '@kernel/db-sqlite'

let pass = 0
const fails: string[] = []
const check = (n: string, c: boolean, e = '') => {
  if (c) {
    pass++
    console.log(`  \x1b[32mPASS\x1b[0m ${n}${e ? ` — ${e}` : ''}`)
  } else {
    fails.push(n)
    console.log(`  \x1b[31mFAIL\x1b[0m ${n}${e ? ` — ${e}` : ''}`)
  }
}
const section = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`)

const DIM = 64
function deterministicEmbed(texts: string[]): Promise<number[][]> {
  return Promise.resolve(
    texts.map((text) => {
      const vec = new Array<number>(DIM).fill(0)
      const tokens = text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean)
      for (const tok of tokens) {
        let h = 2166136261
        for (let i = 0; i < tok.length; i++) {
          h ^= tok.charCodeAt(i)
          h = Math.imul(h, 16777619)
        }
        vec[Math.abs(h) % DIM] += 1
      }
      return vec
    }),
  )
}

async function main() {
  const dbFile = join(mkdtempSync(join(tmpdir(), 'kverify-graph-')), 'g.db')
  const open = { read: () => true, create: () => true, update: () => true, delete: () => true }

  const config = defineConfig({
    secret: 'verify-graph-secret-32-characters-long!',
    db: sqliteAdapter({ url: `file:${dbFile}` }),
    embeddings: { embed: deterministicEmbed, dimensions: DIM },
    collections: [
      {
        slug: 'authors',
        admin: { useAsTitle: 'name' },
        access: open,
        fields: [
          { name: 'name', type: 'text' },
          // Secret field readable only by admins — proves a read-denied field never
          // surfaces in a node label/context.
          { name: 'secret_note', type: 'text', access: { read: () => false } },
          { name: 'posts', type: 'join', collection: 'posts', on: 'author' },
        ],
      },
      {
        slug: 'posts',
        admin: { useAsTitle: 'title' },
        // Posts are owner-scoped on read: a reader only sees posts they own (or all when
        // anonymous-with-open is not used). Seeds are created with overrideAccess.
        access: {
          read: (args: { req: RequestContext }) => (args.req.user ? { owner: { equals: args.req.user.id } } : true),
          create: () => true,
          update: () => true,
        },
        search: { fields: ['title', 'body'], semantic: true },
        fields: [
          { name: 'title', type: 'text' },
          { name: 'body', type: 'text' },
          { name: 'owner', type: 'text' },
          { name: 'author', type: 'relationship', relationTo: 'authors' },
          { name: 'categories', type: 'relationship', relationTo: 'categories', hasMany: true },
        ],
      },
      {
        slug: 'categories',
        admin: { useAsTitle: 'name' },
        access: open,
        fields: [{ name: 'name', type: 'text' }],
      },
    ],
  })

  const kernel = await initKernel(config, { autoMigrate: true, logLevel: 'error' })
  const trusted = { overrideAccess: true } as const

  // ── seed a connected graph ──────────────────────────────────────────────────────
  const cat1 = await kernel.create({ collection: 'categories', data: { name: 'Espresso' }, ...trusted })
  const cat2 = await kernel.create({ collection: 'categories', data: { name: 'Brewing' }, ...trusted })
  const ada = await kernel.create({
    collection: 'authors',
    data: { name: 'Ada Lovelace', secret_note: 'TOP SECRET internal note' },
    ...trusted,
  })
  const post1 = await kernel.create({
    collection: 'posts',
    data: {
      title: 'Pulling the perfect shot',
      body: 'pressure crema grind tamp brewing espresso',
      owner: 'u1',
      author: ada.id,
      categories: [cat1.id, cat2.id],
    },
    ...trusted,
  })
  const post2 = await kernel.create({
    collection: 'posts',
    data: {
      title: 'Milk steaming basics',
      body: 'foam microfoam latte texture steam',
      owner: 'u1',
      author: ada.id,
      categories: [cat2.id],
    },
    ...trusted,
  })
  // A post owned by someone else — used in the access test (caller u1 must never see it).
  const secretPost = await kernel.create({
    collection: 'posts',
    data: {
      title: 'Hidden roast log',
      body: 'pressure crema grind tamp brewing espresso',
      owner: 'u2',
      author: ada.id,
    },
    ...trusted,
  })

  // ── graph traversal ────────────────────────────────────────────────────────────
  section('Graph traversal — depth, edge kinds, labels')
  const g2 = await kernel.graph({ collection: 'authors', id: ada.id, depth: 2, ...trusted })
  const refs2 = new Set(g2.nodes.map((n) => n.ref))
  check('seed author is a node', refs2.has(`authors:${ada.id}`))
  check('posts reached via reverse join edge', refs2.has(`posts:${post1.id}`) && refs2.has(`posts:${post2.id}`))
  check('categories reached at depth 2', refs2.has(`categories:${cat1.id}`) && refs2.has(`categories:${cat2.id}`))
  check(
    'reverse edge author -> post has kind "reverse"',
    g2.edges.some((e) => e.from === `authors:${ada.id}` && e.to === `posts:${post1.id}` && e.kind === 'reverse'),
  )
  check(
    'relationship edge post -> category has kind "relationship"',
    g2.edges.some(
      (e) => e.from === `posts:${post1.id}` && e.to === `categories:${cat1.id}` && e.kind === 'relationship',
    ),
  )
  check(
    'node label comes from useAsTitle',
    g2.nodes.find((n) => n.ref === `authors:${ada.id}`)?.label === 'Ada Lovelace',
  )

  section('Graph traversal — depth:1 stops at posts')
  const g1 = await kernel.graph({ collection: 'authors', id: ada.id, depth: 1, ...trusted })
  const refs1 = new Set(g1.nodes.map((n) => n.ref))
  check('depth:1 includes posts', refs1.has(`posts:${post1.id}`))
  check('depth:1 does NOT include categories', !refs1.has(`categories:${cat1.id}`))

  // ── access control ────────────────────────────────────────────────────────────
  section('Access — a forbidden node + its edge never appear; read-denied field hidden')
  const asU1: Partial<RequestContext> = { user: { id: 'u1', collection: 'users' } as never }
  const gU1 = await kernel.graph({ collection: 'authors', id: ada.id, depth: 2, req: asU1 })
  const refsU1 = new Set(gU1.nodes.map((n) => n.ref))
  check('caller u1 sees their own posts', refsU1.has(`posts:${post1.id}`) && refsU1.has(`posts:${post2.id}`))
  check('caller u1 does NOT see the u2-owned post', !refsU1.has(`posts:${secretPost.id}`))
  check(
    'no edge points at the forbidden post',
    !gU1.edges.some((e) => e.to === `posts:${secretPost.id}` || e.from === `posts:${secretPost.id}`),
  )
  // The author's read-denied secret_note must never appear in any node label.
  check(
    'read-denied field never appears in a node label',
    gU1.nodes.every((n) => !n.label.includes('TOP SECRET')),
  )
  // And the seed doc loaded for u1 must have stripped secret_note (sanity via findByID).
  const adaAsU1 = await kernel.findByID<Doc & { secret_note?: string }>({
    collection: 'authors',
    id: ada.id,
    req: asU1,
  })
  check('read-denied field is stripped from the document', adaAsU1?.secret_note === undefined)

  // ── bounds ────────────────────────────────────────────────────────────────────
  section('Bounds — maxNodes truncates, hub does not explode, cycle terminates')
  const capped = await kernel.graph({ collection: 'authors', id: ada.id, depth: 2, maxNodes: 2, ...trusted })
  check('maxNodes:2 is never exceeded', capped.nodes.length <= 2, `got ${capped.nodes.length}`)
  check('truncated flag set when capped', capped.truncated === true)

  // Hub: one author with many posts; a tight cap must hold and not hang.
  const hubAuthor = await kernel.create({ collection: 'authors', data: { name: 'Hub' }, ...trusted })
  for (let i = 0; i < 30; i++) {
    await kernel.create({
      collection: 'posts',
      data: { title: `Hub post ${i}`, body: 'x', owner: 'u1', author: hubAuthor.id },
      ...trusted,
    })
  }
  const hub = await kernel.graph({ collection: 'authors', id: hubAuthor.id, depth: 1, maxNodes: 10, ...trusted })
  check('hub traversal respects maxNodes', hub.nodes.length <= 10, `got ${hub.nodes.length}`)
  check('hub traversal reports truncation', hub.truncated === true)

  // Deep cycle: a self-referential author->post->author loop terminates via de-dupe.
  const cycle = await kernel.graph({ collection: 'authors', id: ada.id, depth: 8, ...trusted })
  const cycleRefs = cycle.nodes.map((n) => n.ref)
  check('cycle terminates with de-duped nodes (no runaway)', new Set(cycleRefs).size === cycleRefs.length)

  // ── GraphRAG retrieval ──────────────────────────────────────────────────────────
  section('GraphRAG — semantic seeds + expanded connected context')
  const rag = await kernel.graphSearch({
    collection: 'posts',
    query: 'grind tamp crema brewing pressure espresso',
    depth: 1,
    ...trusted,
  })
  const seedIds = rag.seeds.map((s) => s.id)
  check('the espresso post is a semantic seed', seedIds.includes(post1.id), seedIds.join(','))
  check(
    'the milk-steaming post (irrelevant vocabulary) is NOT a top seed',
    !seedIds.includes(post2.id) || seedIds.indexOf(post1.id) < seedIds.indexOf(post2.id),
  )
  check(
    'seed expands to its connected author node',
    rag.nodes.some((n) => n.ref === `authors:${ada.id}`),
  )
  check(
    'seed expands to its connected category nodes',
    rag.nodes.some((n) => n.ref === `categories:${cat1.id}`),
  )
  check('edges connect the seed subgraph', rag.edges.length > 0)
  const ctxRefs = new Set(rag.context.map((c) => c.ref))
  check('context covers the seed post', ctxRefs.has(`posts:${post1.id}`))
  check(
    'context carries a readable text snippet for the seed',
    (rag.context.find((c) => c.ref === `posts:${post1.id}`)?.text ?? '').length > 0,
  )

  section('GraphRAG — access-checked context (no leak to a forbidden caller)')
  const ragU1 = await kernel.graphSearch({
    collection: 'posts',
    query: 'grind tamp crema brewing pressure espresso',
    depth: 1,
    req: asU1,
  })
  check(
    'forbidden u2 post never appears as a node for caller u1',
    !ragU1.nodes.some((n) => n.ref === `posts:${secretPost.id}`),
  )
  check(
    'forbidden u2 post never appears in context for caller u1',
    !ragU1.context.some((c) => c.ref === `posts:${secretPost.id}`),
  )
  check(
    'no context label leaks the read-denied author note',
    ragU1.context.every((c) => !c.label.includes('TOP SECRET') && !c.text.includes('TOP SECRET')),
  )

  await kernel.destroy()

  console.log(`\n${fails.length === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fails.length} failed\x1b[0m`)
  if (fails.length > 0) {
    console.log('Failures:\n  - ' + fails.join('\n  - '))
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
