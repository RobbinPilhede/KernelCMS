/* Live RBAC verification: a config with config.rbac governing a collection that
 * has NO explicit access fns. Run: pnpm tsx verify/rbac.ts */
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
const as = (roles: string[]) => ({ req: { user: { id: 'u-' + roles.join('-'), roles } } }) as any

async function main() {
  const dbFile = join(mkdtempSync(join(tmpdir(), 'kverify-rbac-')), 'r.db')
  const config = defineConfig({
    secret: 'verify-secret-32-characters-long!!',
    db: sqliteAdapter({ url: `file:${dbFile}` }),
    rbac: {
      roles: {
        admin: { admin: true },
        writer: { collections: { notes: ['read', 'create', 'update'] } }, // no delete
        reader: { collections: { notes: ['read'] } },
      },
    },
    collections: [
      // NO explicit access fns -> governed entirely by RBAC
      { slug: 'notes', fields: [{ name: 'title', type: 'text', required: true }] },
    ],
  })
  const kernel = await initKernel(config, { autoMigrate: true } as any)

  console.log('\n\x1b[1mRBAC — declarative role grants enforced\x1b[0m')
  const note = await kernel.create({ collection: 'notes', data: { title: 'by writer' }, ...as(['writer']) })
  check('writer (granted create) CAN create', Boolean(note.id), `id=${note.id}`)
  const read = await kernel.findByID({ collection: 'notes', id: note.id, ...as(['reader']) })
  check('reader (granted read) CAN read', read?.title === 'by writer', `title=${read?.title}`)
  await denied('reader (no create grant) CANNOT create', () =>
    kernel.create({ collection: 'notes', data: { title: 'x' }, ...as(['reader']) }),
  )
  await denied('writer (no delete grant) CANNOT delete', () =>
    kernel.delete({ collection: 'notes', id: note.id, ...as(['writer']) }),
  )
  const del = await kernel.delete({ collection: 'notes', id: note.id, ...as(['admin']) })
  check('admin role bypasses (CAN delete)', Boolean(del), '')
  await denied('unknown role is denied (deny-by-default)', () =>
    kernel.create({ collection: 'notes', data: { title: 'x' }, ...as(['nobody']) }),
  )

  console.log('\n\x1b[1mRBAC — runtime editable (the builder UI surface)\x1b[0m')
  const roles = await (kernel as any).findRoles()
  check(
    'roles seeded into _roles store',
    Array.isArray(roles) && roles.some((r: any) => r.name === 'writer'),
    `roles=${roles.map((r: any) => r.name).join(',')}`,
  )
  await denied('reader cannot create (before grant)', () =>
    kernel.create({ collection: 'notes', data: { title: 'y' }, ...as(['reader']) }),
  )
  await (kernel as any).updateRole('reader', { collections: { notes: ['read', 'create'] } })
  const afterGrant = await kernel.create({ collection: 'notes', data: { title: 'now allowed' }, ...as(['reader']) })
  check(
    'runtime updateRole takes effect immediately (reader CAN now create)',
    Boolean(afterGrant.id),
    `id=${afterGrant.id}`,
  )

  console.log(`\n\x1b[1mRBAC Result: ${pass} passed, ${fails.length} failed\x1b[0m`)
  if (fails.length) {
    console.log('Failures:\n  ' + fails.join('\n  '))
    process.exit(1)
  }
  process.exit(0)
}
main().catch((e) => {
  console.error('RBAC HARNESS ERROR:', e)
  process.exit(2)
})
