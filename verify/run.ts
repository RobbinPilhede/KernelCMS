/* Real end-to-end verification harness. Boots an actual kernel and exercises
 * every feature shipped today, asserting real outcomes with evidence.
 * Run: pnpm tsx verify/run.ts */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { initKernel } from '@kernel/core'
import { makeConfig } from './config'

const require_ = createRequire(import.meta.url)
const { DatabaseSync } = require_('node:sqlite') as { DatabaseSync: new (p: string) => any }

let pass = 0
const fails: string[] = []
function check(name: string, cond: boolean, evidence = '') {
  if (cond) {
    pass++
    console.log(`  \x1b[32mPASS\x1b[0m ${name}${evidence ? ` — ${evidence}` : ''}`)
  } else {
    fails.push(name)
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}${evidence ? ` — ${evidence}` : ''}`)
  }
}
async function expectThrow(name: string, fn: () => Promise<unknown>, codeLike?: string) {
  try {
    await fn()
    check(name, false, 'expected an error, none thrown')
  } catch (e: any) {
    check(
      name,
      !codeLike || `${e?.code ?? ''}${e?.name ?? ''}${e?.message ?? ''}`.toLowerCase().includes(codeLike.toLowerCase()),
      `threw ${e?.code ?? e?.name ?? e?.message}`,
    )
  }
}
const section = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`)

const RT = { v: 1, type: 'doc', children: [{ type: 'paragraph', children: [{ type: 'text', text: 'Hello world' }] }] }
const admin = { req: { user: { id: 'u-admin', roles: ['admin'] } } } as any
const editor = { req: { user: { id: 'u-editor', roles: ['editor'] } } } as any
const viewer = { req: { user: { id: 'u-viewer', roles: ['viewer'] } } } as any
const agent = (allow: string[]) =>
  ({ req: { user: { id: 'content-bot', principalType: 'agent', roles: ['editor'], fieldScope: { allow } } } }) as any
const sys = { overrideAccess: true } as any

async function main() {
  const dbFile = join(mkdtempSync(join(tmpdir(), 'kverify-')), 'verify.db')
  console.log(`db: ${dbFile}`)
  const kernel = await initKernel(makeConfig(`file:${dbFile}`), { autoMigrate: true } as any)
  const raw = new DatabaseSync(dbFile)
  const indexes = () => raw.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type='index'").all() as any[]
  const indexCols = (idx: string) =>
    raw
      .prepare(`PRAGMA index_info(${JSON.stringify(idx).replace(/"/g, "'")})`)
      .all()
      .map((r: any) => r.name)

  // ---- 1. Boot + schema ----------------------------------------------------
  section('1. Boot + migrate')
  const tables = raw
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r: any) => r.name)
  check(
    'tables created',
    ['posts', 'authors', 'categories', 'comments'].every((t) => tables.includes(t)),
    tables.join(','),
  )

  // ---- 2. FK / relationship auto-index (today) -----------------------------
  section('2. Relationship/upload columns auto-indexed')
  const postIdx = indexes().filter((i) => i.tbl_name === 'posts')
  const idxColsAll = postIdx.flatMap((i) => indexCols(i.name))
  check('posts.author indexed', idxColsAll.includes('author'), `index cols: ${idxColsAll.join(',')}`)
  check('posts.cover indexed', idxColsAll.includes('cover'), '')
  check('posts.categories indexed', idxColsAll.includes('categories'), '')

  // ---- 3. CRUD via Local API ----------------------------------------------
  section('3. CRUD (Local API)')
  const author = await kernel.create({ collection: 'authors', data: { name: 'Ada', email: 'ada@x.test' }, ...sys })
  const cat = await kernel.create({ collection: 'categories', data: { name: 'Eng', slug: 'eng' }, ...sys })
  const media = await kernel.create({
    collection: 'media',
    data: { alt: 'cover', filename: 'c.png', mimeType: 'image/png', filesize: 1, url: '/c.png' },
    ...sys,
  })
  check('created author/category/media', Boolean(author.id && cat.id && media.id), `author=${author.id}`)
  const post = await kernel.create({
    collection: 'posts',
    data: {
      title: 'First',
      body: RT,
      author: author.id,
      categories: [cat.id],
      cover: media.id,
      layout: [{ blockType: 'hero', heading: 'Hi', sub: 'there' }],
    },
    ...editor,
  })
  check('created post (draft by default)', post._status === 'draft', `_status=${post._status}`)
  const got = await kernel.findByID({ collection: 'posts', id: post.id, draft: true, ...editor })
  check('read back post (draft)', got?.title === 'First', `title=${got?.title}`)
  check(
    'richText body stored + read',
    got?.body?.type === 'doc' && JSON.stringify(got.body).includes('Hello world'),
    `body.type=${got?.body?.type}`,
  )
  // draft hidden without draft flag (correct behavior)
  const hidden = await kernel.findByID({ collection: 'posts', id: post.id, ...editor })
  check('draft hidden without draft:true', hidden == null, `got=${hidden == null ? 'null' : 'doc'}`)

  // ---- 4. Drafts + publish-access gate (today) -----------------------------
  section('4. Drafts + access.publish gate')
  const pubList = await kernel.find({ collection: 'posts', ...viewer })
  check(
    'public find excludes drafts',
    (pubList.docs ?? pubList).length === 0,
    `count=${(pubList.docs ?? pubList).length}`,
  )
  await expectThrow(
    'viewer CANNOT publish (no publish role)',
    () => kernel.update({ collection: 'posts', id: post.id, data: { _status: 'published' }, ...viewer }),
    'forbidden',
  )
  const published = await kernel.update({ collection: 'posts', id: post.id, data: { _status: 'published' }, ...editor })
  check('editor CAN publish', published._status === 'published', `_status=${published._status}`)
  const pubList2 = await kernel.find({ collection: 'posts', ...viewer })
  check(
    'published post now public',
    (pubList2.docs ?? pubList2).length === 1,
    `count=${(pubList2.docs ?? pubList2).length}`,
  )

  // ---- 5. Agent principal (today) -----------------------------------------
  section('5. Agent principal — scoped + draft-only + attribution')
  // agent allowed only title/body/layout: an attempt to write featured/author/_status is stripped/blocked
  const agcreated = await kernel
    .create({
      collection: 'posts',
      data: { title: 'Agent draft', body: RT, featured: true, author: author.id, _status: 'published' },
      ...agent(['title', 'body', 'layout']),
    })
    .catch((e: any) => ({ __err: e }))
  if ((agcreated as any).__err) {
    // born-published attempt rejected outright is also acceptable; retry without _status
    const a2 = await kernel.create({
      collection: 'posts',
      data: { title: 'Agent draft', body: RT, featured: true, author: author.id },
      ...agent(['title', 'body', 'layout']),
    })
    check('agent create rejected born-published', true, `(then drafted ${a2.id})`)
    check(
      'agent write stripped unscoped fields',
      a2.featured === false && a2.author == null,
      `featured=${a2.featured} author=${a2.author}`,
    )
    check('agent doc is draft', a2._status === 'draft', `_status=${a2._status}`)
    ;(agcreated as any).id = a2.id
    Object.assign(agcreated, a2)
  } else {
    check(
      'agent doc is draft (born-published blocked or coerced)',
      (agcreated as any)._status === 'draft',
      `_status=${(agcreated as any)._status}`,
    )
    check(
      'agent write stripped unscoped fields',
      (agcreated as any).featured === false && (agcreated as any).author == null,
      `featured=${(agcreated as any).featured} author=${(agcreated as any).author}`,
    )
  }
  await expectThrow(
    'agent CANNOT publish via update',
    () =>
      kernel.update({
        collection: 'posts',
        id: (agcreated as any).id,
        data: { _status: 'published' },
        ...agent(['title', 'body']),
      }),
    'forbidden',
  )
  await expectThrow(
    'agent CANNOT schedule a publish (_scheduled_at)',
    () =>
      kernel.update({
        collection: 'posts',
        id: (agcreated as any).id,
        data: { _scheduled_at: new Date(Date.now() - 1000).toISOString() },
        ...agent(['title', 'body']),
      }),
    'forbidden',
  )
  // attribution: version snapshot records createdByType agent
  const versions = await kernel
    .findVersions({ collection: 'posts', id: (agcreated as any).id, ...sys })
    .catch(() => null)
  const vlist = versions ? (versions.docs ?? versions) : []
  check(
    'agent change attributed in version history',
    Array.isArray(vlist) && vlist.some((v: any) => v.createdByType === 'agent'),
    `versions=${vlist.length} types=${vlist.map((v: any) => v.createdByType).join(',')}`,
  )

  // ---- 5b. Scheduled publish: human can schedule, cron publishes -----------
  section('5b. Scheduled publish (human path still works)')
  const sched = await kernel.create({ collection: 'posts', data: { title: 'Scheduled' }, ...editor })
  await kernel.update({
    collection: 'posts',
    id: sched.id,
    data: { _scheduled_at: new Date(Date.now() - 1000).toISOString() },
    ...editor,
  })
  const stillDraft = await kernel.findByID({ collection: 'posts', id: sched.id, draft: true, ...editor })
  check(
    'human CAN schedule a publish (still draft until due)',
    stillDraft?._status === 'draft',
    `_status=${stillDraft?._status}`,
  )
  if (typeof (kernel as any).processScheduledPublishes === 'function') {
    await (kernel as any).processScheduledPublishes()
    const afterCron = await kernel.findByID({ collection: 'posts', id: sched.id, ...editor })
    check('cron publishes the due scheduled draft', afterCron?._status === 'published', `_status=${afterCron?._status}`)
  } else {
    check('processScheduledPublishes exposed', false, 'not found on kernel')
  }

  // ---- 6. onDelete (today): setNull / restrict / cascade -------------------
  section('6. onDelete — setNull / restrict / cascade')
  const author2 = await kernel.create({ collection: 'authors', data: { name: 'Grace', email: 'grace@x.test' }, ...sys })
  const post2 = await kernel.create({
    collection: 'posts',
    data: { title: 'Has author', author: author2.id, _status: 'published' },
    ...sys,
  })
  await kernel.delete({ collection: 'authors', id: author2.id, ...sys })
  const post2after = await kernel.findByID({ collection: 'posts', id: post2.id, draft: true, ...sys })
  check('setNull: deleting author nulls post.author', post2after?.author == null, `author=${post2after?.author}`)

  await expectThrow(
    'restrict: cannot delete an in-use category',
    () => kernel.delete({ collection: 'categories', id: cat.id, ...sys }),
    'conflict',
  )

  const post3 = await kernel.create({
    collection: 'posts',
    data: { title: 'Has comments', _status: 'published' },
    ...sys,
  })
  const comment = await kernel.create({ collection: 'comments', data: { body: 'nice', post: post3.id }, ...sys })
  await kernel.delete({ collection: 'posts', id: post3.id, ...sys })
  const commentAfter = await kernel.findByID({ collection: 'comments', id: comment.id, ...sys })
  check(
    'cascade: deleting post deletes its comments',
    commentAfter == null,
    `comment=${commentAfter == null ? 'gone' : 'still here'}`,
  )

  // ---- 7. N+1 populate batching (today): query count -----------------------
  section('7. Relationship population is batched (no N+1)')
  const cat2 = await kernel.create({ collection: 'categories', data: { name: 'News', slug: 'news' }, ...sys })
  for (let i = 0; i < 10; i++) {
    const a = await kernel.create({ collection: 'authors', data: { name: `A${i}`, email: `a${i}@x.test` }, ...sys })
    await kernel.create({
      collection: 'posts',
      data: { title: `Bulk ${i}`, author: a.id, categories: [cat2.id], _status: 'published' },
      ...sys,
    })
  }
  const origFind = (kernel as any).db.find.bind((kernel as any).db)
  let findCount = 0
  ;(kernel as any).db.find = (...args: any[]) => {
    findCount++
    return origFind(...args)
  }
  const page = await kernel.find({
    collection: 'posts',
    where: { title: { like: 'Bulk' } },
    depth: 1,
    limit: 20,
    ...sys,
  })
  ;(kernel as any).db.find = origFind
  const rows = page.docs ?? page
  check('all 10 bulk posts returned', rows.length === 10, `count=${rows.length}`)
  check(
    'relations populated (author is an object)',
    typeof rows[0]?.author === 'object' && rows[0]?.author?.name != null,
    `author=${JSON.stringify(rows[0]?.author)?.slice(0, 40)}`,
  )
  // Batched: O(collections×depth) finds, not O(docs×relations). 10 posts × 2 rels would be ~20+ if N+1.
  check(
    'populate is batched (low query count)',
    findCount <= 6,
    `db.find calls for the whole page = ${findCount} (N+1 would be ~20+)`,
  )

  // ---- 8. Globals ----------------------------------------------------------
  section('8. Globals')
  await kernel.updateGlobal({ slug: 'settings', data: { site_name: 'Verify Co' }, ...admin })
  const settings = await kernel.findGlobal({ slug: 'settings', ...viewer })
  check('global update + read', settings?.site_name === 'Verify Co', `site_name=${settings?.site_name}`)

  // ---- 9. Audit log (NEW — governance #1) ---------------------------------
  section('9. Audit log — who / what / when (free in core)')
  const auditTables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_audit'").all() as any[]
  check('_audit table provisioned when enabled', auditTables.length === 1, '')
  const audit = await (kernel as any).findAuditLog({ limit: 500 })
  const entries = audit.docs ?? audit
  check('audit captured operations', Array.isArray(entries) && entries.length > 0, `entries=${entries.length}`)
  const actions = new Set(entries.map((e: any) => e.action))
  check(
    'records create/update/delete/publish actions',
    ['create', 'update', 'delete', 'publish'].every((a) => actions.has(a)),
    `actions=${[...actions].join(',')}`,
  )
  const agentEntry = entries.find((e: any) => e.principalType === 'agent')
  check(
    'attributes agent operations (who)',
    Boolean(agentEntry),
    `agent action=${agentEntry?.action} coll=${agentEntry?.collection}`,
  )
  const systemEntry = entries.find((e: any) => e.principalType === 'system')
  check('attributes system (overrideAccess) operations', Boolean(systemEntry), `system action=${systemEntry?.action}`)
  const withWhen = entries.every((e: any) => e.at != null)
  check('every entry has a timestamp (when)', withWhen, `sample at=${entries[0]?.at}`)
  const createEntry = entries.find((e: any) => e.action === 'create' && e.collection === 'posts')
  check(
    'create entry records changed field names (what)',
    Array.isArray(createEntry?.fields) && createEntry.fields.length > 0,
    `fields=${JSON.stringify(createEntry?.fields)?.slice(0, 50)}`,
  )
  const filtered = await (kernel as any).findAuditLog({ where: { action: { equals: 'publish' } } })
  const fdocs = filtered.docs ?? filtered
  check(
    'audit log is queryable (filter by action)',
    fdocs.length > 0 && fdocs.every((e: any) => e.action === 'publish'),
    `publish entries=${fdocs.length}`,
  )

  raw.close()
  console.log(`\n\x1b[1mResult: ${pass} passed, ${fails.length} failed\x1b[0m`)
  if (fails.length) {
    console.log('Failures:\n  ' + fails.join('\n  '))
    process.exit(1)
  }
}
main().catch((e) => {
  console.error('HARNESS ERROR:', e)
  process.exit(2)
})
