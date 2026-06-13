/* Live real-time verification: a durable change feed (CDC pull) + an in-process
 * subscribe bus + a live SSE stream, all metadata-only and access-filtered per
 * subscriber. Boots a real sqlite kernel with realtime enabled, a PUBLIC `posts`
 * collection and an OWNER-SCOPED `secrets` collection, and proves:
 *   - ordered create/update/delete events + monotonic cursor + since/collection filters
 *   - the access filter: a non-owner never learns a forbidden doc changed; the owner does
 *   - events are metadata-only (no doc body)
 *   - subscribe delivers live + unsubscribe stops delivery
 *   - retention trims the outbox (oldest dropped) and cursors still work
 *   - SSE: an authed GET /api/changes/stream emits a `data:` frame for a change
 * Run: pnpm tsx verify/realtime.ts
 */
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
const as = (id: string) => ({ req: { user: { id, roles: ['user'] } } }) as any

function makeConfig(url: string, retain?: number) {
  return defineConfig({
    secret: 'verify-realtime-secret-32-chars!!',
    db: sqliteAdapter({ url }),
    realtime: { enabled: true, ...(retain !== undefined ? { retain } : {}) },
    collections: [
      {
        slug: 'posts',
        access: { read: () => true, create: () => true, update: () => true, delete: () => true },
        fields: [{ name: 'title', type: 'text' }],
      },
      {
        slug: 'secrets',
        access: {
          read: ({ req }: any) => (req.user ? { owner: { equals: req.user.id } } : false),
          create: () => true,
          update: () => true,
          delete: () => true,
        },
        fields: [
          { name: 'title', type: 'text' },
          { name: 'owner', type: 'text' },
        ],
      },
    ],
  })
}

async function main() {
  const dbFile = join(mkdtempSync(join(tmpdir(), 'kverify-rt-')), 'rt.db')
  const kernel = await initKernel(makeConfig(`file:${dbFile}`), { autoMigrate: true } as any)

  // ---- 1. Ordered CDC feed + cursor ---------------------------------------
  section('1. Durable change feed — ordered create/update/delete + monotonic cursor')
  const post = await kernel.create({ collection: 'posts', data: { title: 'a' }, ...sys })
  await kernel.update({ collection: 'posts', id: post.id, data: { title: 'b' }, ...sys })
  const feed1 = await kernel.changes({ since: 0, ...sys })
  // (delete tested separately so it doesn't unread the create/update for a scoped check)
  await kernel.delete({ collection: 'posts', id: post.id, ...sys })
  const feedAll = await kernel.changes({ since: 0, ...sys })
  const events = feedAll.changes.filter((c) => c.documentId === post.id).map((c) => c.event)
  check(
    'records create then update',
    feed1.changes.map((c) => c.event).join(',') === 'create,update',
    `=${feed1.changes.map((c) => c.event)}`,
  )
  check('records create/update/delete in order', events.join(',') === 'create,update,delete', `=${events.join(',')}`)
  check(
    'correct collection + documentId',
    feedAll.changes.every((c) => c.collection === 'posts' && c.documentId === post.id),
    '',
  )
  const seqs = feedAll.changes.map((c) => c.seq)
  check(
    'seqs are strictly monotonic',
    seqs.every((s, i) => i === 0 || s > seqs[i - 1]!),
    `seqs=${seqs.join(',')}`,
  )
  check('cursor = highest seq returned', feedAll.cursor === Math.max(...seqs), `cursor=${feedAll.cursor}`)

  section('2. since=cursor returns only newer events; collection filter')
  const newPost = await kernel.create({ collection: 'posts', data: { title: 'c' }, ...sys })
  const afterCursor = await kernel.changes({ since: feedAll.cursor, ...sys })
  check(
    'since=cursor yields only the newer event',
    afterCursor.changes.length === 1 && afterCursor.changes[0]!.documentId === newPost.id,
    `count=${afterCursor.changes.length}`,
  )
  await kernel.create({ collection: 'secrets', data: { title: 's', owner: 'alice' }, ...sys })
  const onlyPosts = await kernel.changes({ since: 0, collection: 'posts', ...sys })
  check(
    'collection filter excludes other collections',
    onlyPosts.changes.length > 0 && onlyPosts.changes.every((c) => c.collection === 'posts'),
    `colls=${[...new Set(onlyPosts.changes.map((c) => c.collection))].join(',')}`,
  )
  const badColl = await kernel.changes({ since: 0, collection: 'does_not_exist', ...sys })
  check('unknown collection → clean empty result', badColl.changes.length === 0, `count=${badColl.changes.length}`)

  // ---- 3. Access filter ----------------------------------------------------
  section('3. Access filter — a subscriber never learns a forbidden doc changed')
  const aliceSecret = await kernel.create({
    collection: 'secrets',
    data: { title: 'a-secret', owner: 'alice' },
    ...sys,
  })
  const bobSecret = await kernel.create({ collection: 'secrets', data: { title: 'b-secret', owner: 'bob' }, ...sys })

  const aliceFeed = await kernel.changes({ since: 0, collection: 'secrets', ...as('alice') })
  const aliceSecretIds = new Set(aliceFeed.changes.map((c) => c.documentId))
  check('owner SEES her own secret change', aliceSecretIds.has(aliceSecret.id), `ids=${aliceSecretIds.size}`)
  // Alice's secrets feed must NEVER contain bob's secret id (forbidden change dropped).
  check(
    'owner sees ONLY her own secret changes (bob’s never appears)',
    !aliceSecretIds.has(bobSecret.id),
    `aliceSawBob=${aliceSecretIds.has(bobSecret.id)}`,
  )

  // Bob: a non-owner of aliceSecret must NOT learn it changed at all (dropped, not bodyless).
  const bobFeed = await kernel.changes({ since: 0, collection: 'secrets', ...as('bob') })
  check(
    'non-owner: forbidden change is DROPPED (no leak it changed)',
    !bobFeed.changes.some((c) => c.documentId === aliceSecret.id),
    `bobSawAlice=${bobFeed.changes.some((c) => c.documentId === aliceSecret.id)}`,
  )

  // ---- 4. Metadata-only ----------------------------------------------------
  section('4. Events are metadata-only (no document body / field values)')
  const metaPost = await kernel.create({ collection: 'posts', data: { title: 'NEEDLE-IN-A-HAYSTACK' }, ...sys })
  const metaFeed = await kernel.changes({ since: 0, ...sys })
  const metaEvent = metaFeed.changes.find((c) => c.documentId === metaPost.id)!
  check(
    'event carries only metadata keys',
    JSON.stringify(Object.keys(metaEvent).sort()) ===
      JSON.stringify(['at', 'collection', 'documentId', 'event', 'principalType', 'seq']),
    `keys=${Object.keys(metaEvent).join(',')}`,
  )
  check('no field VALUE present in the event', !JSON.stringify(metaEvent).includes('NEEDLE-IN-A-HAYSTACK'), '')
  check(
    'principalType present (actor kind, not a token)',
    metaEvent.principalType === 'system',
    `type=${metaEvent.principalType}`,
  )

  // ---- 5. In-process subscribe --------------------------------------------
  section('5. subscribe — live delivery + unsubscribe stops it')
  const live: string[] = []
  const unsubscribe = kernel.subscribe((e) => live.push(`${e.event}:${e.documentId}`))
  const subPost = await kernel.create({ collection: 'posts', data: { title: 'live' }, ...sys })
  check('subscriber receives live event', live.includes(`create:${subPost.id}`), `received=${live.length}`)
  unsubscribe()
  const beforeCount = live.length
  await kernel.update({ collection: 'posts', id: subPost.id, data: { title: 'after' }, ...sys })
  check('unsubscribe stops delivery', live.length === beforeCount, `before=${beforeCount} after=${live.length}`)

  // ---- 6. SSE stream (over the real request handler) -----------------------
  section('6. SSE stream — authed GET /api/changes/stream emits a data: frame for a change')
  const handler = createRequestHandler(kernel, {
    // Map a bearer token to a user so the SSE connection is authed.
    getUser: (req) =>
      req.headers.get('authorization') === 'Bearer alice-token' ? { id: 'alice', roles: ['user'] } : null,
  })
  // Unauthed stream is rejected.
  const unauthed = await handler(new Request('http://localhost/api/changes/stream'))
  check('SSE requires auth (401 without a user)', unauthed.status === 401, `status=${unauthed.status}`)

  const res = await handler(
    new Request('http://localhost/api/changes/stream', { headers: { authorization: 'Bearer alice-token' } }),
  )
  check(
    'SSE returns text/event-stream',
    (res.headers.get('content-type') ?? '').includes('text/event-stream'),
    `ct=${res.headers.get('content-type')}`,
  )
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  // Trigger a public change AFTER the stream is open; read frames for a moment.
  const ssePost = await kernel.create({ collection: 'posts', data: { title: 'sse-live' }, ...sys })
  let buffer = ''
  let sawData = false
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<{ value?: Uint8Array; done: boolean }>((r) => setTimeout(() => r({ done: false }), 200)),
    ])
    if (chunk.value) buffer += decoder.decode(chunk.value, { stream: true })
    const frame = buffer.split('\n\n').find((f) => f.includes('data:') && f.includes(ssePost.id))
    if (frame) {
      sawData = true
      const dataLine = frame.split('\n').find((l) => l.startsWith('data:'))!
      const payload = JSON.parse(dataLine.slice('data:'.length).trim())
      check(
        'SSE data frame carries the change metadata',
        payload.documentId === ssePost.id && payload.event === 'create',
        `payload=${JSON.stringify(payload)}`,
      )
      check('SSE data frame is metadata-only', !JSON.stringify(payload).includes('sse-live'), '')
      check('SSE frame carries id: <seq> for resume', frame.includes(`id: ${payload.seq}`), '')
      break
    }
  }
  check(
    'SSE delivered at least one data frame for the change',
    sawData,
    `buffer=${buffer.slice(0, 80).replace(/\n/g, '\\n')}`,
  )
  await reader.cancel()

  // ---- 7. Retention (ring-buffer trim) -------------------------------------
  section('7. Retention — small retain trims the outbox (oldest dropped); cursors still work')
  const dbFile2 = join(mkdtempSync(join(tmpdir(), 'kverify-rt2-')), 'rt2.db')
  const kernel2 = await initKernel(makeConfig(`file:${dbFile2}`, 3), { autoMigrate: true } as any)
  const created: string[] = []
  for (let i = 0; i < 6; i++) {
    const d = await kernel2.create({ collection: 'posts', data: { title: `t${i}` }, ...sys })
    created.push(d.id)
  }
  const trimmed = await kernel2.changes({ since: 0, ...sys })
  check('outbox trimmed to retain (3 rows)', trimmed.changes.length === 3, `count=${trimmed.changes.length}`)
  check(
    'oldest dropped, newest kept',
    !trimmed.changes.some((c) => c.documentId === created[0]) &&
      trimmed.changes.some((c) => c.documentId === created[5]),
    '',
  )
  check(
    'cursors still monotonic after trim',
    trimmed.cursor === Math.max(...trimmed.changes.map((c) => c.seq)),
    `cursor=${trimmed.cursor}`,
  )

  await kernel.destroy()
  await kernel2.destroy()

  console.log(`\n\x1b[1mRealtime Result: ${pass} passed, ${fails.length} failed\x1b[0m`)
  if (fails.length) {
    console.log('Failures:\n  ' + fails.join('\n  '))
    process.exit(1)
  }
  process.exit(0)
}
main().catch((e) => {
  console.error('REALTIME HARNESS ERROR:', e)
  process.exit(2)
})
