/* Live editorial-comments verification: threaded comments on documents, gated by the
 * target document's READ access. Proves: comment + thread + field anchor; the access gate
 * (no leak for a doc you can't read); author-from-principal (a forged authorId is ignored);
 * resolve/delete authz; validation; and that `_comments` is not reachable via generic CRUD.
 * Run: pnpm tsx verify/comments.ts */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig, initKernel } from '@kernel/core'
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
async function denied(n: string, fn: () => Promise<unknown>) {
  try {
    await fn()
    check(n, false, 'expected an error, succeeded')
  } catch (e: any) {
    check(
      n,
      /forbidden|not.?found|unauthorized|validation|bad.?request|invalid/i.test(`${e?.code}${e?.name}${e?.message}`),
      `threw ${e?.code ?? e?.name}`,
    )
  }
}

// Two human users, an agent, and anonymous (no user).
const alice = { user: { id: 'alice', roles: ['viewer'] } } as any
const bob = { user: { id: 'bob', roles: ['viewer'] } } as any
const editor = { user: { id: 'ed', roles: ['editor'] } } as any
const admin = { user: { id: 'adm', roles: ['admin'] } } as any
const agent = { user: { id: 'bot', principalType: 'agent', roles: [], fieldScope: { allow: ['title'] } } } as any

// Owner-scoped read: a row is only readable by its owner (or an admin).
const ownerRead = ({ req }: any) => {
  if (req.user?.roles?.includes('admin')) return true
  return { owner: { equals: req.user?.id ?? '__none__' } }
}

async function main() {
  const dbFile = join(mkdtempSync(join(tmpdir(), 'kverify-comments-')), 'c.db')
  const config = defineConfig({
    secret: 'verify-secret-32-characters-long!!',
    db: sqliteAdapter({ url: `file:${dbFile}` }),
    audit: true,
    comments: true,
    agents: [{ id: 'bot', token: 'bot-token-comments-verify', roles: [], fieldScope: { allow: ['title'] } }],
    collections: [
      {
        slug: 'posts',
        access: { read: () => true, create: () => true, update: () => true },
        fields: [
          { name: 'title', type: 'text', required: true },
          { name: 'body', type: 'text' },
        ],
      },
      {
        slug: 'secrets',
        access: { read: ownerRead, create: () => true, update: () => true },
        fields: [
          { name: 'owner', type: 'text' },
          { name: 'note', type: 'text' },
        ],
      },
    ],
  })
  const kernel = await initKernel(config, { autoMigrate: true } as any)

  console.log('\n\x1b[1mComments — add / thread / field anchor on a readable doc\x1b[0m')
  const post = await kernel.create({ collection: 'posts', data: { title: 'Hello' }, ...alice })
  const root = await kernel.addComment({ collection: 'posts', id: post.id, body: '  needs a hook  ', req: alice })
  check('user can comment on a readable post', Boolean(root.id), `id=${root.id}`)
  check('body is trimmed + stored', root.body === 'needs a hook', `body="${root.body}"`)
  check('author is the principal', root.authorId === 'alice' && root.authorType === 'user', `author=${root.authorId}`)
  const reply = await kernel.addComment({
    collection: 'posts',
    id: post.id,
    body: 'agree',
    parentId: root.id,
    req: bob,
  })
  check('threaded reply (parentId) works', reply.parentId === root.id, `parentId=${reply.parentId}`)
  const anchored = await kernel.addComment({
    collection: 'posts',
    id: post.id,
    body: 'fix this',
    field: 'title',
    req: alice,
  })
  check('field anchor validated + stored', anchored.field === 'title', `field=${anchored.field}`)
  const list = await kernel.listComments({ collection: 'posts', id: post.id, req: alice })
  check(
    'listComments returns oldest -> newest',
    list.map((c: any) => c.id).join(',') === [root.id, reply.id, anchored.id].join(','),
    `order=${list.map((c: any) => c.id).length} items`,
  )
  const byField = await kernel.listComments({ collection: 'posts', id: post.id, field: 'title', req: alice })
  check('listComments filters by field', byField.length === 1 && byField[0]!.id === anchored.id, `n=${byField.length}`)

  console.log('\n\x1b[1mComments — gated by DOCUMENT read access (no leak)\x1b[0m')
  const secret = await kernel.create({ collection: 'secrets', data: { owner: 'alice', note: 'top secret' }, ...alice })
  await kernel.addComment({ collection: 'secrets', id: secret.id, body: 'mine', req: alice })
  await denied('a user who cannot read the doc CANNOT addComment', () =>
    kernel.addComment({ collection: 'secrets', id: secret.id, body: 'peek', req: bob }),
  )
  await denied('a user who cannot read the doc CANNOT listComments (no leak)', () =>
    kernel.listComments({ collection: 'secrets', id: secret.id, req: bob }),
  )
  const ownerList = await kernel.listComments({ collection: 'secrets', id: secret.id, req: alice })
  check('the owner CAN list its own doc comments', ownerList.length === 1, `n=${ownerList.length}`)
  // Anonymous Local-API/embedder calls (no req.user, no override) are held to the SAME
  // document read rule — they must not bypass the gate and leak comments/counts.
  await denied('an anonymous caller (no req.user) CANNOT listComments on a doc it cannot read', () =>
    kernel.listComments({ collection: 'secrets', id: secret.id }),
  )
  await denied('an anonymous caller (no req.user) CANNOT commentCount on a doc it cannot read', () =>
    kernel.commentCount({ collection: 'secrets', id: secret.id }),
  )

  console.log('\n\x1b[1mComments — author comes from the principal, not client input\x1b[0m')
  const forged = await kernel.addComment({
    collection: 'posts',
    id: post.id,
    body: 'who am i',
    // Forged author fields — must be ignored.
    authorId: 'admin',
    authorType: 'system',
    req: bob,
  } as any)
  check(
    'a forged authorId is ignored (real principal wins)',
    forged.authorId === 'bob' && forged.authorType === 'user',
    `author=${forged.authorId}`,
  )

  console.log('\n\x1b[1mComments — resolve / delete authz\x1b[0m')
  const c = await kernel.addComment({ collection: 'posts', id: post.id, body: 'review me', req: alice })
  await denied('a non-author, non-reviewer CANNOT resolve', () => kernel.resolveComment({ commentId: c.id, req: bob }))
  const resolved = await kernel.resolveComment({ commentId: c.id, req: alice })
  check('the author CAN resolve', resolved.resolved === true, '')
  const reopened = await kernel.resolveComment({ commentId: c.id, resolved: false, req: editor })
  check('a reviewer (editor) CAN resolve/unresolve', reopened.resolved === false, '')
  await denied("a non-author, non-admin CANNOT delete (editor isn't enough)", () =>
    kernel.deleteComment({ commentId: c.id, req: editor }),
  )
  await denied('a random user CANNOT delete', () => kernel.deleteComment({ commentId: c.id, req: bob }))
  const delByAuthor = await kernel.deleteComment({ commentId: c.id, req: alice })
  check('the author CAN delete', delByAuthor.id === c.id, '')
  const c2 = await kernel.addComment({ collection: 'posts', id: post.id, body: 'admin will nuke', req: bob })
  const delByAdmin = await kernel.deleteComment({ commentId: c2.id, req: admin })
  check('an admin CAN delete any comment', delByAdmin.id === c2.id, '')
  // Anonymous callers (no req.user) are held to the doc read gate on resolve/delete too —
  // they cannot mutate a comment on a document they cannot read.
  const onSecret = await kernel.addComment({ collection: 'secrets', id: secret.id, body: 'private note', req: alice })
  await denied('an anonymous caller (no req.user) CANNOT resolve a comment on an unreadable doc', () =>
    kernel.resolveComment({ commentId: onSecret.id }),
  )
  await denied('an anonymous caller (no req.user) CANNOT delete a comment on an unreadable doc', () =>
    kernel.deleteComment({ commentId: onSecret.id }),
  )

  console.log('\n\x1b[1mComments — validation + anonymous + agent\x1b[0m')
  await denied('empty body rejected', () =>
    kernel.addComment({ collection: 'posts', id: post.id, body: '   ', req: alice }),
  )
  await denied('oversized body rejected', () =>
    kernel.addComment({ collection: 'posts', id: post.id, body: 'a'.repeat(10_001), req: alice }),
  )
  await denied('invalid field rejected', () =>
    kernel.addComment({ collection: 'posts', id: post.id, body: 'x', field: 'not_a_field', req: alice }),
  )
  await denied('__proto__ field rejected (no pollution)', () =>
    kernel.addComment({ collection: 'posts', id: post.id, body: 'x', field: '__proto__', req: alice }),
  )
  // A __proto__ in the BODY is just text (stored raw, rendered by the consumer); it is
  // never executed and cannot pollute the prototype.
  const protoBody = await kernel.addComment({ collection: 'posts', id: post.id, body: '__proto__', req: alice })
  check('a __proto__ body is stored as plain text', protoBody.body === '__proto__', `body="${protoBody.body}"`)
  check('a __proto__ body did not pollute Object.prototype', ({} as any).polluted === undefined, '')
  const otherDoc = await kernel.create({ collection: 'posts', data: { title: 'other' }, ...alice })
  const onOther = await kernel.addComment({ collection: 'posts', id: otherDoc.id, body: 'on other', req: alice })
  await denied('a parentId from a DIFFERENT document is rejected', () =>
    kernel.addComment({ collection: 'posts', id: post.id, body: 'cross', parentId: onOther.id, req: alice }),
  )
  await denied('anonymous CANNOT comment', () =>
    kernel.addComment({ collection: 'posts', id: post.id, body: 'ghost', req: { user: null } as any }),
  )
  const agentComment = await kernel.addComment({ collection: 'posts', id: post.id, body: 'agent note', req: agent })
  check(
    'an agent principal CAN comment (attributed as agent)',
    agentComment.authorType === 'agent',
    `type=${agentComment.authorType}`,
  )

  console.log('\n\x1b[1mComments — _comments is NOT reachable via generic CRUD\x1b[0m')
  await denied('find(_comments) is rejected (system table)', () => kernel.find({ collection: '_comments', ...alice }))
  await denied('create(_comments) is rejected (system table)', () =>
    kernel.create({ collection: '_comments', data: { body: 'x' }, overrideAccess: true }),
  )

  console.log('\n\x1b[1mComments — audit trail\x1b[0m')
  const audit = await (kernel as any).findAuditLog({ where: { action: { equals: 'comment.create' } } })
  check('comment.create recorded in audit log', (audit?.docs ?? []).length > 0, `entries=${audit?.docs?.length ?? 0}`)
  const resolveAudit = await (kernel as any).findAuditLog({ where: { action: { equals: 'comment.resolve' } } })
  check(
    'comment.resolve recorded in audit log',
    (resolveAudit?.docs ?? []).length > 0,
    `entries=${resolveAudit?.docs?.length ?? 0}`,
  )

  console.log(`\n\x1b[1mComments Result: ${pass} passed, ${fails.length} failed\x1b[0m`)
  if (fails.length) {
    console.log('Failures:\n  ' + fails.join('\n  '))
    process.exit(1)
  }
  process.exit(0)
}
main().catch((e) => {
  console.error('COMMENTS HARNESS ERROR:', e)
  process.exit(2)
})
