/* Live saved-views verification: a named (where + sort + columns) query preset for one
 * collection, stored in the private `_views` system table. Proves: owner-from-principal (a
 * forged owner is impossible — the principal always wins); saveView denied for a collection
 * the caller cannot read at all; the access-checked applyView narrowing (an admin's SHARED
 * view on a row-scoped collection, applied by a restricted user, returns ONLY their rows —
 * never widening access); shared-vs-private listViews visibility; owner-only update/delete
 * (a non-owner who can SEE a shared view still cannot edit/delete it); where/sort field
 * validation; and that `_views` is not reachable via generic CRUD.
 * Run: pnpm tsx verify/views.ts */
import { mkdtempSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
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

// Two human users and an admin.
const alice = { user: { id: 'alice', roles: ['viewer'] } } as any
const bob = { user: { id: 'bob', roles: ['viewer'] } } as any
const admin = { user: { id: 'adm', roles: ['admin'] } } as any

// Owner-scoped read: a row is only readable by its owner (or an admin). Resolves to a Where
// (row-scope) for a non-admin — allowed-at-the-collection-gate, narrowed by row.
const ownerRead = ({ req }: any) => {
  if (req.user?.roles?.includes('admin')) return true
  return { owner: { equals: req.user?.id ?? '__none__' } }
}

async function main() {
  const dbDir = mkdtempSync(join(tmpdir(), 'kverify-views-'))
  const dbFile = join(dbDir, 'v.db')
  const config = defineConfig({
    secret: 'verify-secret-32-characters-long!!',
    db: sqliteAdapter({ url: `file:${dbFile}` }),
    audit: true,
    views: true,
    collections: [
      {
        slug: 'posts',
        access: { read: () => true, create: () => true, update: () => true },
        fields: [
          { name: 'title', type: 'text', required: true },
          { name: 'status', type: 'text' },
          { name: 'body', type: 'text' },
        ],
      },
      {
        // Owner-scoped: a row is only readable by its owner (or an admin).
        slug: 'secrets',
        access: { read: ownerRead, create: () => true, update: () => true },
        fields: [
          { name: 'owner', type: 'text' },
          { name: 'note', type: 'text' },
        ],
      },
      {
        // Admin-only: a hard boolean deny for non-admins (no row scope) — a non-admin cannot
        // read ANY of it, so the collection-level gate rejects.
        slug: 'vault',
        access: {
          read: ({ req }: any) => Boolean(req.user?.roles?.includes('admin')),
          create: () => true,
          update: () => true,
        },
        fields: [
          { name: 'owner', type: 'text' },
          { name: 'secret', type: 'text' },
        ],
      },
    ],
  })
  const kernel = await initKernel(config, { autoMigrate: true } as any)

  try {
    console.log('\n\x1b[1mViews — owner from the principal, not client input\x1b[0m')
    const view = await kernel.saveView({
      collection: 'posts',
      name: '  Published posts  ',
      where: { status: { equals: 'published' } },
      sort: '-title',
      columns: ['title', 'status'],
      // A forged owner — must be ignored; the real principal wins.
      ownerId: 'adm',
      req: alice,
    } as any)
    check('owner comes from the principal (forged ownerId ignored)', view.ownerId === 'alice', `owner=${view.ownerId}`)
    check('name is trimmed + stored', view.name === 'Published posts', `name="${view.name}"`)
    check('where/sort/columns stored', view.sort === '-title' && view.shared === false, '')
    await denied('an anonymous caller (no req.user) CANNOT save a view', () =>
      kernel.saveView({ collection: 'posts', name: 'anon', req: {} as any }),
    )

    console.log('\n\x1b[1mViews — saveView gated by COLLECTION read access\x1b[0m')
    // `vault` is a hard deny for non-admins → bob cannot read ANY of it → save rejected.
    await denied('a user who cannot read the collection AT ALL CANNOT save a view', () =>
      kernel.saveView({ collection: 'vault', name: 'peek', req: bob }),
    )
    const adminVault = await kernel.saveView({ collection: 'vault', name: 'all vault', req: admin })
    check('an admin (who CAN read vault) can build a view over it', adminVault.ownerId === 'adm', '')
    // `secrets` resolves to a Where (row-scope) → allowed-with-scope → a non-admin CAN save.
    const aliceSecrets = await kernel.saveView({ collection: 'secrets', name: 'my secrets', req: alice })
    check('a row-scoped (allowed-with-scope) collection still permits saving', aliceSecrets.ownerId === 'alice', '')

    console.log('\n\x1b[1mViews — applyView NEVER widens access (the headline guarantee)\x1b[0m')
    await kernel.create({ collection: 'secrets', data: { owner: 'alice', note: 'a1' }, ...alice })
    await kernel.create({ collection: 'secrets', data: { owner: 'bob', note: 'b1' }, ...bob })
    await kernel.create({ collection: 'secrets', data: { owner: 'bob', note: 'b2' }, ...bob })
    // Admin (who CAN read every secret) saves a SHARED view with NO where (broad as possible).
    const sharedSecrets = await kernel.saveView({
      collection: 'secrets',
      name: 'all secrets',
      shared: true,
      req: admin,
    })
    // Bob applies it — the read rule is AND-combined inside the normal find, so he gets ONLY
    // his own rows. The shared view cannot widen his access.
    const bobApplied = await kernel.applyView({ viewId: sharedSecrets.id, req: bob })
    check(
      "a restricted user applying an admin's shared view sees ONLY their rows",
      bobApplied.docs.length === 2 && bobApplied.docs.every((d: any) => d.owner === 'bob'),
      `n=${bobApplied.docs.length}`,
    )
    check("...and never another owner's rows", bobApplied.docs.some((d: any) => d.owner === 'alice') === false, '')
    // The admin, applying the same view, still sees everything (their own access is broad).
    const adminApplied = await kernel.applyView({ viewId: sharedSecrets.id, req: admin })
    check(
      'the admin applying the same view still sees everything',
      adminApplied.docs.length === 3,
      `n=${adminApplied.docs.length}`,
    )
    // An extra caller `where` AND-combines to further narrow the stored filter.
    const narrowed = await kernel.applyView({ viewId: sharedSecrets.id, where: { note: { equals: 'b1' } }, req: bob })
    check('an extra caller where further narrows', narrowed.docs.length === 1, `n=${narrowed.docs.length}`)

    console.log('\n\x1b[1mViews — shared vs private listViews visibility\x1b[0m')
    const alicePriv = await kernel.saveView({ collection: 'posts', name: 'alice private', req: alice })
    const aliceShared = await kernel.saveView({ collection: 'posts', name: 'alice shared', shared: true, req: alice })
    await kernel.saveView({ collection: 'posts', name: 'bob private', req: bob })
    const bobPostsList = await kernel.listViews({ collection: 'posts', req: bob })
    const bobPostsIds = bobPostsList.map((v: any) => v.id)
    check('a shared view on a readable collection IS visible to another user', bobPostsIds.includes(aliceShared.id), '')
    check("another user's PRIVATE view is NOT visible", bobPostsIds.includes(alicePriv.id) === false, '')
    check(
      "getView returns null for another user's private view",
      (await kernel.getView({ viewId: alicePriv.id, req: bob })) === null,
      '',
    )
    // A shared view on a collection bob cannot read AT ALL is hidden from him.
    const sharedVault = await kernel.saveView({ collection: 'vault', name: 'shared vault', shared: true, req: admin })
    const bobVaultList = await kernel.listViews({ collection: 'vault', req: bob })
    check(
      'a shared view on an unreadable collection is hidden from list',
      bobVaultList.length === 0,
      `n=${bobVaultList.length}`,
    )
    check(
      '...and getView returns null for it',
      (await kernel.getView({ viewId: sharedVault.id, req: bob })) === null,
      '',
    )

    console.log('\n\x1b[1mViews — owner-only update / delete\x1b[0m')
    // Bob can SEE alice's shared view but is neither owner nor admin → cannot mutate it.
    await denied('a non-owner who can SEE a shared view CANNOT update it', () =>
      kernel.updateView({ viewId: aliceShared.id, name: 'hijacked', req: bob }),
    )
    await denied('a non-owner who can SEE a shared view CANNOT delete it', () =>
      kernel.deleteView({ viewId: aliceShared.id, req: bob }),
    )
    const renamed = await kernel.updateView({ viewId: aliceShared.id, name: 'renamed', req: alice })
    check('the owner CAN update their view', renamed.name === 'renamed', `name="${renamed.name}"`)
    const del = await kernel.deleteView({ viewId: aliceShared.id, req: admin })
    check('an admin CAN delete any view', del.id === aliceShared.id, '')
    check(
      '...and the deleted view is gone',
      (await kernel.getView({ viewId: aliceShared.id, req: alice })) === null,
      '',
    )

    console.log('\n\x1b[1mViews — where / sort / columns + name validation\x1b[0m')
    await denied('unknown where field rejected', () =>
      kernel.saveView({ collection: 'posts', name: 'bad', where: { nope: { equals: 1 } } as any, req: alice }),
    )
    await denied('unknown where operator rejected', () =>
      kernel.saveView({ collection: 'posts', name: 'bad', where: { title: { regex: 'x' } } as any, req: alice }),
    )
    await denied('unknown sort field rejected', () =>
      kernel.saveView({ collection: 'posts', name: 'bad', sort: 'not_a_field', req: alice }),
    )
    await denied('unknown column rejected', () =>
      kernel.saveView({ collection: 'posts', name: 'bad', columns: ['title', 'ghost'], req: alice }),
    )
    await denied('empty name rejected', () => kernel.saveView({ collection: 'posts', name: '   ', req: alice }))
    await denied('a prototype-pollution viewId is rejected', () => kernel.getView({ viewId: '__proto__', req: alice }))
    await denied('a constructor viewId is rejected', () => kernel.getView({ viewId: 'constructor', req: alice }))
    // An OWN `__proto__` key via JSON is walked as an unknown filter field and rejected.
    const evilWhere = JSON.parse('{"__proto__": {"equals": "x"}}')
    await denied('a JSON __proto__ where key is rejected (no pollution)', () =>
      kernel.saveView({ collection: 'posts', name: 'evil', where: evilWhere, req: alice }),
    )
    check(
      'Object.prototype was not polluted',
      ({} as any).polluted === undefined && (Object.prototype as any).equals === undefined,
      '',
    )

    console.log('\n\x1b[1mViews — _views is NOT reachable via generic CRUD\x1b[0m')
    await denied('find(_views) is rejected (system table)', () => kernel.find({ collection: '_views', ...alice }))
    await denied('create(_views) is rejected (system table)', () =>
      kernel.create({ collection: '_views', data: { name: 'x', collection: 'posts' }, overrideAccess: true }),
    )

    console.log('\n\x1b[1mViews — audit trail\x1b[0m')
    const audit = await (kernel as any).findAuditLog({ where: { action: { equals: 'view.create' } } })
    check('view.create recorded in audit log', (audit?.docs ?? []).length > 0, `entries=${audit?.docs?.length ?? 0}`)
    const delAudit = await (kernel as any).findAuditLog({ where: { action: { equals: 'view.delete' } } })
    check(
      'view.delete recorded in audit log',
      (delAudit?.docs ?? []).length > 0,
      `entries=${delAudit?.docs?.length ?? 0}`,
    )
  } finally {
    await kernel.destroy()
    try {
      rmSync(dirname(dbFile), { recursive: true, force: true })
    } catch {
      // best-effort temp cleanup
    }
  }

  console.log(`\n\x1b[1mViews Result: ${pass} passed, ${fails.length} failed\x1b[0m`)
  if (fails.length) {
    console.log('Failures:\n  ' + fails.join('\n  '))
    process.exit(1)
  }
  process.exit(0)
}
main().catch((e) => {
  console.error('VIEWS HARNESS ERROR:', e)
  process.exit(2)
})
