/* Live field-level-encryption verification: transparent AES-256-GCM for fields marked
 * `encrypted: true`. Proves: a create/read round-trips the decrypted value (plaintext field
 * untouched); the storage column holds the `enc:1:…` envelope and NOT the plaintext (ciphertext
 * at rest); the same value encrypts non-deterministically (fresh IV); a `where` on an encrypted
 * field is rejected (no equality leak); the config-load guards each throw at initKernel
 * (unique/index/localized/personalized/relationship/search-field/missing-key/short-key); and a
 * wrong-key decrypt is a loud DecryptionError, never silent garbage. No HTTP server needed —
 * exercises the core op + cipher directly. Run: pnpm tsx verify/encryption.ts */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFieldCipher, DecryptionError, defineConfig, initKernel } from '@kernel/core'
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
// Config-load guards throw a plain `KernelCMS config error: …` Error at initKernel (not a
// coded runtime KernelError), so they're asserted against the config-error message + the
// specific guard reason rather than the runtime-error regex above.
async function configRejects(n: string, reason: RegExp, fn: () => Promise<unknown>) {
  try {
    await fn()
    check(n, false, 'expected a config error, succeeded')
  } catch (e: any) {
    const msg = String(e?.message ?? '')
    check(n, /config error/i.test(msg) && reason.test(msg), `threw "${msg.slice(0, 60)}…"`)
  }
}

const SECRET = 'verify-secret-32-characters-long!!'
const KEY = 'encryption-verify-master-key-32-chars+!!'
const override = { overrideAccess: true } as const

function baseConfig(dbUrl: string) {
  return defineConfig({
    secret: SECRET,
    db: sqliteAdapter({ url: dbUrl }),
    encryption: { key: KEY },
    collections: [
      {
        slug: 'people',
        access: { read: () => true, create: () => true, update: () => true },
        fields: [
          { name: 'name', type: 'text' },
          { name: 'ssn', type: 'text', encrypted: true },
          { name: 'notes', type: 'json', encrypted: true },
        ],
      },
    ],
  })
}

// A config-guard collection with one encrypted field plus any extra flag/field under test.
function guardConfig(fields: unknown[], extra: Record<string, unknown> = {}) {
  return defineConfig({
    secret: SECRET,
    db: sqliteAdapter({ url: ':memory:' }),
    encryption: { key: KEY },
    collections: [{ slug: 'guard', access: { read: () => true }, fields }],
    ...extra,
  } as any)
}

async function main() {
  const dbFile = join(mkdtempSync(join(tmpdir(), 'kverify-encryption-')), 'e.db')
  const kernel = await initKernel(baseConfig(`file:${dbFile}`), { logLevel: 'error' } as any)
  await kernel.migrate()

  console.log('\n\x1b[1mEncryption — create/read round-trips the decrypted value\x1b[0m')
  const doc = await kernel.create({
    collection: 'people',
    data: { name: 'Ada', ssn: '123-45-6789', notes: { risk: 'low', tags: ['vip'] } },
    ...override,
  })
  check('create returns the decrypted ssn', doc.ssn === '123-45-6789', `ssn=${doc.ssn}`)
  check('create returns the plaintext name untouched', doc.name === 'Ada', `name=${doc.name}`)
  const byId = await kernel.findByID({ collection: 'people', id: doc.id, ...override })
  check('findByID returns the decrypted ssn', byId?.ssn === '123-45-6789', `ssn=${byId?.ssn}`)
  check(
    'findByID returns the decrypted json notes',
    JSON.stringify(byId?.notes) === JSON.stringify({ risk: 'low', tags: ['vip'] }),
    '',
  )
  const list = await kernel.find({ collection: 'people', ...override })
  check('find returns the decrypted ssn in the page', list.docs[0]?.ssn === '123-45-6789', `n=${list.docs.length}`)

  console.log('\n\x1b[1mEncryption — ciphertext at rest (the adapter never sees plaintext)\x1b[0m')
  const raw = await (kernel as any).config.db.findByID({ collection: 'people', id: doc.id })
  const storedSsn = String(raw.ssn)
  const storedNotes = String(raw.notes)
  check('the raw ssn column is an enc:1: envelope', storedSsn.startsWith('enc:1:'), `ssn=${storedSsn.slice(0, 16)}…`)
  check(
    'the raw notes column is an enc:1: envelope',
    storedNotes.startsWith('enc:1:'),
    `notes=${storedNotes.slice(0, 16)}…`,
  )
  check('the raw ssn does NOT contain the plaintext', !storedSsn.includes('123-45-6789'), '')
  check('the raw notes does NOT contain the plaintext', !storedNotes.includes('low'), '')
  check('the raw name column stays plaintext', raw.name === 'Ada', `name=${raw.name}`)

  console.log('\n\x1b[1mEncryption — non-determinism (fresh IV per value)\x1b[0m')
  const a = await kernel.create({ collection: 'people', data: { name: 'dup', ssn: 'SAME-VALUE' }, ...override })
  const b = await kernel.create({ collection: 'people', data: { name: 'dup', ssn: 'SAME-VALUE' }, ...override })
  const rawA = String((await (kernel as any).config.db.findByID({ collection: 'people', id: a.id })).ssn)
  const rawB = String((await (kernel as any).config.db.findByID({ collection: 'people', id: b.id })).ssn)
  check('the same plaintext stores as different ciphertexts', rawA !== rawB, '')
  check('both ciphertexts decrypt back to the same value', a.ssn === 'SAME-VALUE' && b.ssn === 'SAME-VALUE', '')

  console.log('\n\x1b[1mEncryption — a filter on an encrypted field is rejected (no equality leak)\x1b[0m')
  await denied('a where on the encrypted ssn is a BadRequest', () =>
    kernel.find({ collection: 'people', where: { ssn: { equals: '123-45-6789' } }, ...override }),
  )

  console.log('\n\x1b[1mEncryption — config-load guards (each throws at initKernel)\x1b[0m')
  await configRejects('encrypted + unique is rejected', /unique/i, () =>
    initKernel(guardConfig([{ name: 's', type: 'text', encrypted: true, unique: true }]), { logLevel: 'error' } as any),
  )
  await configRejects('encrypted + index is rejected', /index/i, () =>
    initKernel(guardConfig([{ name: 's', type: 'text', encrypted: true, index: true }]), { logLevel: 'error' } as any),
  )
  await configRejects('encrypted + localized is rejected', /localized/i, () =>
    initKernel(
      guardConfig([{ name: 's', type: 'text', encrypted: true, localized: true }], {
        localization: { locales: ['en', 'fr'], defaultLocale: 'en' },
      }),
      { logLevel: 'error' } as any,
    ),
  )
  await configRejects('encrypted + personalized is rejected', /personalized/i, () =>
    initKernel(
      guardConfig([{ name: 's', type: 'text', encrypted: true, personalized: true }], {
        audiences: { segments: ['eu', 'us'], default: 'us' },
      }),
      { logLevel: 'error' } as any,
    ),
  )
  await configRejects('an encrypted relationship field is rejected', /relationship|encrypted/i, () =>
    initKernel(
      guardConfig([
        { name: 'name', type: 'text' },
        { name: 'r', type: 'relationship', relationTo: 'guard', encrypted: true },
      ]),
      { logLevel: 'error' } as any,
    ),
  )
  await configRejects('an encrypted field listed in search.fields is rejected', /search/i, () =>
    initKernel(
      defineConfig({
        secret: SECRET,
        db: sqliteAdapter({ url: ':memory:' }),
        encryption: { key: KEY },
        collections: [
          {
            slug: 'guard',
            access: { read: () => true },
            search: { fields: ['s'] },
            fields: [{ name: 's', type: 'text', encrypted: true }],
          },
        ],
      } as any),
      { logLevel: 'error' } as any,
    ),
  )
  await configRejects('an encrypted field with NO encryption.key is rejected', /encryption\.key|key/i, () =>
    initKernel(
      defineConfig({
        secret: SECRET,
        db: sqliteAdapter({ url: ':memory:' }),
        collections: [
          { slug: 'guard', access: { read: () => true }, fields: [{ name: 's', type: 'text', encrypted: true }] },
        ],
      } as any),
      { logLevel: 'error' } as any,
    ),
  )
  await configRejects('a too-short encryption.key is rejected', /encryption\.key|key|chars/i, () =>
    initKernel(guardConfig([{ name: 's', type: 'text', encrypted: true }], { encryption: { key: 'too-short' } }), {
      logLevel: 'error',
    } as any),
  )

  console.log('\n\x1b[1mEncryption — wrong key is a loud DecryptionError, never garbage\x1b[0m')
  let threw: unknown = null
  try {
    createFieldCipher('a-totally-different-wrong-key-32-chars!!').decrypt(storedSsn)
  } catch (e) {
    threw = e
  }
  check('decrypting key-A ciphertext with key B throws', threw !== null, '')
  check('the thrown error is a DecryptionError', threw instanceof DecryptionError, `name=${(threw as any)?.name}`)
  // Tampering with the ciphertext is also a hard failure (authenticated GCM).
  let tamperThrew = false
  try {
    const flipped = storedSsn.slice(0, -2) + (storedSsn.endsWith('A=') ? 'B=' : 'A=')
    createFieldCipher(KEY).decrypt(flipped)
  } catch {
    tamperThrew = true
  }
  check('a tampered ciphertext (right key) also throws', tamperThrew, '')

  // ── Version snapshots store ciphertext at rest (the at-rest guarantee extends to history)
  console.log('\n\x1b[1mEncryption — version snapshots hold ciphertext, not plaintext\x1b[0m')
  const vKernel = await initKernel(
    defineConfig({
      secret: 'verify-secret-32-characters-long!!',
      encryption: { key: 'verify-encryption-master-key-32-chars!!' },
      db: sqliteAdapter({ url: ':memory:' }),
      collections: [
        {
          slug: 'people',
          versions: { drafts: true },
          access: { read: () => true, create: () => true, update: () => true },
          fields: [
            { name: 'name', type: 'text' },
            { name: 'ssn', type: 'text', encrypted: true },
          ],
        },
      ],
    }),
    { autoMigrate: true } as any,
  )
  const vdoc = await vKernel.create({
    collection: 'people',
    data: { name: 'Ada', ssn: '123-45-6789', _status: 'published' },
    overrideAccess: true,
  })
  const vrows = await (vKernel as any).config.db.find({
    collection: '_versions_people',
    where: { parent: { equals: vdoc.id } },
    limit: 10,
    page: 1,
  })
  const allCipher = vrows.docs.length > 0 && vrows.docs.every((v: any) => String(v.version.ssn).startsWith('enc:1:'))
  const noPlain = vrows.docs.every((v: any) => !JSON.stringify(v.version).includes('123-45-6789'))
  check('version snapshot ssn is ciphertext at rest', allCipher, `rows=${vrows.docs.length}`)
  check('version snapshot contains no plaintext ssn', noPlain, '')
  const vhist = await vKernel.findVersions({ collection: 'people', id: vdoc.id, overrideAccess: true })
  check('findVersions decrypts the snapshot ssn', (vhist.docs[0] as any)?.version?.ssn === '123-45-6789', '')
  await vKernel.destroy()

  await kernel.destroy()
  rmSync(dbFile, { force: true })
  console.log(`\n\x1b[1mEncryption Result: ${pass} passed, ${fails.length} failed\x1b[0m`)
  if (fails.length) {
    console.log('Failures:\n  ' + fails.join('\n  '))
    process.exit(1)
  }
  process.exit(0)
}
main().catch((e) => {
  console.error('ENCRYPTION HARNESS ERROR:', e)
  process.exit(2)
})
