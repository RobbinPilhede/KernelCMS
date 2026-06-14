/* Live edge content-delivery verification: surrogate cache tags on reads + the
 * change-feed-derived purge feed, and — the SECURITY make-or-break — that a public
 * (anonymous) read gets aggressive `s-maxage` caching while an authenticated/scoped
 * read gets `private, no-store`. Boots a real sqlite kernel + the request handler.
 * Run: pnpm tsx verify/edge.ts */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig, initKernel } from '@kernel/core'
import { createRequestHandler } from '@kernel/server'
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
const sys = { overrideAccess: true } as any

// `posts` is public-read with a relationship to `authors`. `secrets` is owner-scoped:
// a row is readable only by the user whose `owner` field matches.
function makeConfig(dbUrl: string) {
  return defineConfig({
    secret: 'verify-edge-secret-32-characters!!',
    db: sqliteAdapter({ url: dbUrl }),
    realtime: { enabled: true },
    edge: { enabled: true, cacheControl: 'public, s-maxage=600', includeRelationships: true },
    collections: [
      {
        slug: 'authors',
        access: { read: () => true, create: () => true, update: () => true, delete: () => true },
        fields: [{ name: 'name', type: 'text', required: true }],
      },
      {
        slug: 'posts',
        access: { read: () => true, create: () => true, update: () => true, delete: () => true },
        fields: [
          { name: 'title', type: 'text', required: true },
          { name: 'author', type: 'relationship', relationTo: 'authors' },
        ],
      },
      {
        slug: 'secrets',
        access: {
          // Owner-scoped: a signed-in user may read only their own rows.
          read: ({ req }: any) => (req.user ? { owner: { equals: req.user.id } } : false),
          create: () => true,
          update: () => true,
          delete: () => true,
        },
        fields: [
          { name: 'body', type: 'text' },
          { name: 'owner', type: 'text' },
        ],
      },
    ],
  })
}

async function main() {
  const dbFile = join(mkdtempSync(join(tmpdir(), 'kverify-edge-')), 'e.db')
  const kernel = await initKernel(makeConfig(`file:${dbFile}`), { autoMigrate: true, logLevel: 'error' } as any)

  // A request handler that trusts an `x-user-id` header for the authenticated test path
  // (stands in for a real session — the cache-control decision keys on `!user`, so the
  // value only needs to be present/absent for this proof).
  const handler = createRequestHandler(kernel, {
    getUser: (req: Request) => {
      const id = req.headers.get('x-user-id')
      return id ? ({ id, roles: ['editor'] } as any) : null
    },
  })
  const call = (path: string, init?: RequestInit) => handler(new Request('http://localhost' + path, init))

  // Seed: an author + a public post referencing it, and an owner-scoped secret.
  const author = await kernel.create({ collection: 'authors', data: { name: 'Ada' }, ...sys })
  const post = await kernel.create({
    collection: 'posts',
    data: { title: 'Hello', author: author.id, _status: 'published' },
    ...sys,
  })
  await kernel.create({ collection: 'secrets', data: { body: 'top secret', owner: 'u-owner' }, ...sys })

  // ---- 1. cacheTags: own + collection + relationship targets ----------------
  section('1. cacheTags — own + collection + relationship-target tags')
  const detailTags = kernel.cacheTags({
    collection: 'posts',
    id: post.id,
    doc: { id: post.id, author: author.id } as any,
  })
  check(
    'detail tags = [posts, posts:<id>, authors:<authorId>]',
    JSON.stringify(detailTags) === JSON.stringify(['posts', `posts:${post.id}`, `authors:${author.id}`]),
    `tags=${detailTags.join(' ')}`,
  )
  const listTags = kernel.cacheTags({ collection: 'posts', docs: [{ id: post.id } as any] })
  check(
    'list tags = collection tag + per-doc tags',
    listTags[0] === 'posts' && listTags.includes(`posts:${post.id}`),
    `tags=${listTags.join(' ')}`,
  )
  // Tags are CDN-safe tokens (no spaces/newlines/control chars within a token).
  const allSafe = [...detailTags, ...listTags].every((t) => /^[A-Za-z0-9\-._:~/]+$/.test(t))
  check('all tags are sanitized CDN-safe tokens', allSafe, `sample=${detailTags[1]}`)

  // ---- 2. purgeFeed: change -> tags, cursor advance, de-dupe ----------------
  section('2. purgeFeed — derived from the change feed')
  const purge0 = await kernel.purgeFeed({ since: 0 })
  check(
    "a post's change appears in the purge feed (+ collection tag)",
    purge0.tags.includes('posts') && purge0.tags.includes(`posts:${post.id}`),
    `tags=${purge0.tags.join(' ')}`,
  )
  check('cursor advanced past 0', purge0.cursor > 0, `cursor=${purge0.cursor}`)
  // A second change advances the cursor.
  await kernel.update({ collection: 'posts', id: post.id, data: { title: 'Hello 2' }, ...sys })
  const purge1 = await kernel.purgeFeed({ since: purge0.cursor })
  check('a second change advances the cursor', purge1.cursor > purge0.cursor, `cursor=${purge1.cursor}`)
  // De-dupe: tags are a set.
  check(
    'tags are de-duped (no repeats)',
    purge0.tags.length === new Set(purge0.tags).size,
    `len=${purge0.tags.length} unique=${new Set(purge0.tags).size}`,
  )
  // Reverse-ref: changing the AUTHOR purges the referencing POST.
  await kernel.update({ collection: 'authors', id: author.id, data: { name: 'Ada L.' }, ...sys })
  const purge2 = await kernel.purgeFeed({ since: purge1.cursor })
  check(
    'changing a referenced author purges the referencing post (reverse-ref)',
    purge2.tags.includes(`authors:${author.id}`) && purge2.tags.includes(`posts:${post.id}`),
    `tags=${purge2.tags.join(' ')}`,
  )

  // ---- 3. cache-control correctness (THE security test) --------------------
  section('3. cache-control correctness — public cacheable vs private no-store')
  // Anonymous read over a public collection -> cacheable: s-maxage + Surrogate-Key.
  const anon = await call(`/api/posts/${post.id}`)
  const anonCC = anon.headers.get('cache-control') ?? ''
  const anonSK = anon.headers.get('surrogate-key') ?? ''
  check('anonymous public read has s-maxage Cache-Control', /s-maxage/.test(anonCC), `cache-control=${anonCC}`)
  check('anonymous public read carries Surrogate-Key', anonSK.includes(`posts:${post.id}`), `surrogate-key=${anonSK}`)

  // Authenticated/scoped read (secrets as its owner) -> private, no-store, NO public cache.
  const owned = await kernel.create({ collection: 'secrets', data: { body: 'mine', owner: 'u-me' }, ...sys })
  const authed = await call(`/api/secrets/${owned.id}`, { headers: { 'x-user-id': 'u-me' } })
  const authedCC = authed.headers.get('cache-control') ?? ''
  const authedSK = authed.headers.get('surrogate-key')
  check('authenticated read succeeded (owner sees own row)', authed.status === 200, `status=${authed.status}`)
  check(
    'authenticated/scoped read is private, no-store',
    /private/.test(authedCC) && /no-store/.test(authedCC),
    `cache-control=${authedCC}`,
  )
  check(
    'private content is NEVER given s-maxage / public caching',
    !/s-maxage/.test(authedCC) && !/public/.test(authedCC),
    `cache-control=${authedCC}`,
  )
  check('private response carries NO Surrogate-Key header', authedSK == null, `surrogate-key=${authedSK}`)
  // A draft (unpublished) read is likewise not cacheable.
  const draftPost = await kernel.create({ collection: 'posts', data: { title: 'Draft' }, ...sys })
  const draftRes = await call(`/api/posts/${draftPost.id}?draft=true`)
  const draftCC = draftRes.headers.get('cache-control') ?? ''
  check('draft (unpublished) read is not publicly cached', !/s-maxage/.test(draftCC), `cache-control=${draftCC}`)

  // ---- 4. purge feed admin-gated -------------------------------------------
  section('4. purge feed route — admin/operator-gated')
  const purgeAnon = await call('/api/_edge/purge?since=0')
  check(
    'non-admin (anonymous) purge feed rejected',
    purgeAnon.status === 401 || purgeAnon.status === 403,
    `status=${purgeAnon.status}`,
  )
  const purgeEditor = await call('/api/_edge/purge?since=0', { headers: { 'x-user-id': 'u-me' } })
  check('non-admin (editor) purge feed rejected', purgeEditor.status === 403, `status=${purgeEditor.status}`)
  const handlerAdmin = createRequestHandler(kernel, {
    getUser: () => ({ id: 'u-admin', roles: ['admin'] }) as any,
  })
  const purgeAdmin = await handlerAdmin(new Request('http://localhost/api/_edge/purge?since=0'))
  const purgeAdminJson: any = await purgeAdmin.json().catch(() => ({}))
  check(
    'admin CAN read the purge feed',
    purgeAdmin.status === 200 && Array.isArray(purgeAdminJson.tags),
    `status=${purgeAdmin.status} tags=${(purgeAdminJson.tags ?? []).length}`,
  )

  // ---- 5. tags never leak an id the caller couldn't read -------------------
  section('5. tags derive only from access-checked, returned docs')
  // A NON-owner reading another user's secret gets no document back — and therefore the
  // response NEVER carries that secret's id in a Surrogate-Key. (`owned` belongs to
  // `u-me`; `u-other` may not read it.)
  const otherRead = await call(`/api/secrets/${owned.id}`, { headers: { 'x-user-id': 'u-other' } })
  const otherSK = otherRead.headers.get('surrogate-key')
  check(
    'a non-owner cannot read the secret (no doc returned)',
    otherRead.status === 404 || otherRead.status === 403,
    `status=${otherRead.status}`,
  )
  check(
    "the forbidden secret's id never appears in a Surrogate-Key",
    otherSK == null || !otherSK.includes(`secrets:${owned.id}`),
    `surrogate-key=${otherSK}`,
  )
  // And the cacheTags helper itself only ever names ids from the docs handed to it —
  // a list response with one returned doc tags exactly that doc, nothing hidden.
  const scopedTags = kernel.cacheTags({ collection: 'secrets', docs: [{ id: owned.id } as any] })
  check(
    'cacheTags(list) tags only the docs supplied (no extra ids)',
    JSON.stringify(scopedTags) === JSON.stringify(['secrets', `secrets:${owned.id}`]),
    `tags=${scopedTags.join(' ')}`,
  )

  await kernel.destroy()
  console.log(`\n\x1b[1mEdge Result: ${pass} passed, ${fails.length} failed\x1b[0m`)
  if (fails.length) {
    console.log('Failures:\n  ' + fails.join('\n  '))
    process.exit(1)
  }
  process.exit(0)
}
main().catch((e) => {
  console.error('EDGE HARNESS ERROR:', e)
  process.exit(2)
})
