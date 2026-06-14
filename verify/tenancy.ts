/* Live multi-tenancy verification: a config with config.tenancy auto-scoping a `posts`
 * collection by the principal's tenant claim, plus a non-scoped public `pages` collection.
 * Proves cross-tenant isolation, create auto-stamp + anti-spoof, fail-closed for a
 * tenant-less principal, the overrideAccess escape hatch, and no cross-tenant populate leak.
 * Run: pnpm tsx verify/tenancy.ts */
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
    check(n, false, 'expected Forbidden, succeeded')
  } catch (e: any) {
    check(n, /forbidden/i.test(`${e?.code}${e?.name}${e?.message}`), `threw ${e?.code ?? e?.name}`)
  }
}

// Principals: two tenants, a tenant-less user, and the trusted system (overrideAccess).
const acme = { req: { user: { id: 'a', tenant: 'acme' } } } as any
const globex = { req: { user: { id: 'b', tenant: 'globex' } } } as any
const tenantless = { req: { user: { id: 'c' } } } as any
const sys = { overrideAccess: true } as any

async function main() {
  const dbFile = join(mkdtempSync(join(tmpdir(), 'kverify-tenancy-')), 't.db')
  const config = defineConfig({
    secret: 'verify-secret-32-characters-long!!',
    db: sqliteAdapter({ url: `file:${dbFile}` }),
    tenancy: { field: 'tenant', collections: ['posts'] },
    collections: [
      // Tenant-scoped. `related` is a self-relation used to prove populate is access-filtered.
      {
        slug: 'posts',
        access: { read: () => true, create: () => true, update: () => true, delete: () => true },
        fields: [
          { name: 'title', type: 'text', required: true },
          { name: 'related', type: 'relationship', relationTo: 'posts' },
        ],
      },
      // Non-scoped, public: tenancy must leave it alone.
      {
        slug: 'pages',
        access: { read: () => true, create: () => true },
        fields: [{ name: 'title', type: 'text', required: true }],
      },
    ],
  })
  const kernel = await initKernel(config, { autoMigrate: true } as any)

  console.log('\n\x1b[1mTenancy — create auto-stamp from the trusted principal\x1b[0m')
  const acmePost = await kernel.create({ collection: 'posts', data: { title: 'acme post' }, ...acme })
  check(
    'tenant A create is auto-stamped tenant:acme',
    (acmePost as any).tenant === 'acme',
    `tenant=${(acmePost as any).tenant}`,
  )
  const globexPost = await kernel.create({ collection: 'posts', data: { title: 'globex post' }, ...globex })
  check(
    'tenant B create is auto-stamped tenant:globex',
    (globexPost as any).tenant === 'globex',
    `tenant=${(globexPost as any).tenant}`,
  )

  console.log('\n\x1b[1mTenancy — anti-spoof (client cannot set/move the tenant)\x1b[0m')
  const spoof = await kernel.create({ collection: 'posts', data: { title: 'spoof', tenant: 'globex' }, ...acme })
  check(
    'tenant A create with data.tenant=globex is OVERRIDDEN to acme',
    (spoof as any).tenant === 'acme',
    `tenant=${(spoof as any).tenant}`,
  )
  const moved = await kernel.update({ collection: 'posts', id: acmePost.id, data: { tenant: 'globex' }, ...acme })
  check(
    'tenant A update with data.tenant=globex leaves tenant unchanged',
    (moved as any).tenant === 'acme',
    `tenant=${(moved as any).tenant}`,
  )

  console.log('\n\x1b[1mTenancy — read/count isolation (only your own rows)\x1b[0m')
  const acmeList = await kernel.find({ collection: 'posts', ...acme })
  const acmeTitles = (acmeList.docs ?? acmeList).map((d: any) => d.title).sort()
  check(
    'tenant A sees ONLY acme posts',
    JSON.stringify(acmeTitles) === JSON.stringify(['acme post', 'spoof']),
    `titles=${acmeTitles.join(',')}`,
  )
  const globexList = await kernel.find({ collection: 'posts', ...globex })
  const globexTitles = (globexList.docs ?? globexList).map((d: any) => d.title).sort()
  check(
    'tenant B sees ONLY globex posts (NOT acme)',
    JSON.stringify(globexTitles) === JSON.stringify(['globex post']),
    `titles=${globexTitles.join(',')}`,
  )
  check('tenant A count is its own (2)', (await kernel.count({ collection: 'posts', ...acme })) === 2, '')
  check('tenant B count is its own (1)', (await kernel.count({ collection: 'posts', ...globex })) === 1, '')

  console.log('\n\x1b[1mTenancy — cross-tenant findByID/update/delete denied (IDOR-safe)\x1b[0m')
  await denied('tenant B findByID of an acme post is Forbidden', () =>
    kernel.findByID({ collection: 'posts', id: acmePost.id, ...globex }),
  )
  await denied('tenant B update of an acme post is Forbidden', () =>
    kernel.update({ collection: 'posts', id: acmePost.id, data: { title: 'hax' }, ...globex }),
  )
  await denied('tenant B delete of an acme post is Forbidden', () =>
    kernel.delete({ collection: 'posts', id: acmePost.id, ...globex }),
  )
  check(
    'tenant B count via findByID-style cross access stays 0 for acme rows',
    (await kernel.count({ collection: 'posts', where: { title: { equals: 'acme post' } }, ...globex })) === 0,
    '',
  )

  console.log('\n\x1b[1mTenancy — fail-closed for a tenant-less principal (requireTenant)\x1b[0m')
  const tlList = await kernel.find({ collection: 'posts', ...tenantless })
  check(
    'tenant-less principal sees NO scoped posts',
    (tlList.docs ?? tlList).length === 0,
    `count=${(tlList.docs ?? tlList).length}`,
  )
  await denied('tenant-less principal CANNOT create a scoped post', () =>
    kernel.create({ collection: 'posts', data: { title: 'nope' }, ...tenantless }),
  )

  console.log('\n\x1b[1mTenancy — overrideAccess bypasses tenancy (system escape hatch)\x1b[0m')
  const all = await kernel.find({ collection: 'posts', ...sys })
  check(
    'overrideAccess sees ALL tenants posts',
    (all.docs ?? all).length === 3,
    `count=${(all.docs ?? all).length} (acme:2 + globex:1)`,
  )

  console.log('\n\x1b[1mTenancy — non-scoped `pages` is unaffected\x1b[0m')
  await kernel.create({ collection: 'pages', data: { title: 'public page' }, ...acme })
  const pagesAsGlobex = await kernel.find({ collection: 'pages', ...globex })
  check(
    'a different tenant still sees the public page',
    (pagesAsGlobex.docs ?? pagesAsGlobex).length === 1,
    `count=${(pagesAsGlobex.docs ?? pagesAsGlobex).length}`,
  )
  const pagesTenantless = await kernel.find({ collection: 'pages', ...tenantless })
  check(
    'a tenant-less principal still sees the public page',
    (pagesTenantless.docs ?? pagesTenantless).length === 1,
    '',
  )
  const onePage = (pagesAsGlobex.docs ?? pagesAsGlobex)[0]
  check(
    'pages rows carry NO tenant column (non-scoped)',
    (onePage as any).tenant === undefined,
    `tenant=${(onePage as any).tenant}`,
  )

  console.log('\n\x1b[1mTenancy — populate is access-filtered (no cross-tenant leak)\x1b[0m')
  // Force a cross-tenant relationship via overrideAccess: an acme post points at a globex post.
  const linker = await kernel.create({
    collection: 'posts',
    data: { title: 'linker', tenant: 'acme', related: globexPost.id },
    ...sys,
  })
  const populated = await kernel.findByID({ collection: 'posts', id: linker.id, depth: 1, ...acme })
  // The acme reader resolves its own doc, but the populated `related` (a globex doc) must
  // NOT expand into the foreign document — it falls back to the bare id (access-filtered).
  const related = (populated as any)?.related
  check(
    'cross-tenant related doc is NOT expanded for the acme reader (no leak)',
    typeof related !== 'object' || related === null,
    `related=${typeof related === 'object' ? JSON.stringify(related).slice(0, 40) : related}`,
  )

  console.log(`\n\x1b[1mTenancy Result: ${pass} passed, ${fails.length} failed\x1b[0m`)
  if (fails.length) {
    console.log('Failures:\n  ' + fails.join('\n  '))
    process.exit(1)
  }
  process.exit(0)
}
main().catch((e) => {
  console.error('TENANCY HARNESS ERROR:', e)
  process.exit(2)
})
