import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { createFieldCipher, DecryptionError, defineConfig, initKernel } from './index'
import type { Kernel, KernelConfig } from './index'

// End-to-end field-level encryption through the op layer. A field marked `encrypted: true`
// is ciphertext at rest (the adapter only ever sees `enc:1:…`) and transparently decrypted
// on read. The config-load guards reject every combination that would leak or break the
// non-deterministic ciphertext (unique/index/localized/personalized/relationship/search).

const KEY = 'encrypted-fields-master-key-32-chars-plus!!'
const SECRET = 'verify-secret-32-characters-long!!'

const overrideReq = { overrideAccess: true } as const

function buildConfig(): KernelConfig {
  return defineConfig({
    secret: SECRET,
    db: sqliteAdapter({ url: ':memory:' }),
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

describe('encrypted fields — round-trip through the op layer', () => {
  let kernel: Kernel

  beforeEach(async () => {
    kernel = await initKernel(buildConfig(), { logLevel: 'error' })
    await kernel.migrate()
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('create then findByID/find returns the decrypted values, name untouched', async () => {
    const created = await kernel.create({
      collection: 'people',
      data: { name: 'Ada', ssn: '123-45-6789', notes: { risk: 'low', tags: ['vip', 'eu'] } },
      ...overrideReq,
    })
    expect(created.name).toBe('Ada')
    expect(created.ssn).toBe('123-45-6789')
    expect(created.notes).toEqual({ risk: 'low', tags: ['vip', 'eu'] })

    const byId = await kernel.findByID({ collection: 'people', id: created.id, ...overrideReq })
    expect(byId?.name).toBe('Ada')
    expect(byId?.ssn).toBe('123-45-6789')
    expect(byId?.notes).toEqual({ risk: 'low', tags: ['vip', 'eu'] })

    const list = await kernel.find({ collection: 'people', ...overrideReq })
    const found = list.docs.find((d) => d.id === created.id)
    expect(found?.ssn).toBe('123-45-6789')
    expect(found?.notes).toEqual({ risk: 'low', tags: ['vip', 'eu'] })
  })

  it('stores ciphertext at rest — raw row holds enc:1: and not the plaintext', async () => {
    const created = await kernel.create({
      collection: 'people',
      data: { name: 'Grace', ssn: '987-65-4321', notes: { secret: 'classified' } },
      ...overrideReq,
    })
    const raw = await (kernel as any).config.db.findByID({
      collection: 'people',
      id: created.id,
    })
    expect(String(raw.ssn)).toMatch(/^enc:1:/)
    expect(String(raw.notes)).toMatch(/^enc:1:/)
    expect(String(raw.ssn)).not.toContain('987-65-4321')
    expect(String(raw.notes)).not.toContain('classified')
    // The plaintext field is stored as-is.
    expect(raw.name).toBe('Grace')
  })

  it('update re-encrypts ssn with fresh ciphertext, still decrypts to the new value', async () => {
    const created = await kernel.create({
      collection: 'people',
      data: { name: 'Lin', ssn: '111-11-1111' },
      ...overrideReq,
    })
    const rawDb = (kernel as any).config.db
    const before = String((await rawDb.findByID({ collection: 'people', id: created.id })).ssn)

    const updated = await kernel.update({
      collection: 'people',
      id: created.id,
      data: { ssn: '222-22-2222' },
      ...overrideReq,
    })
    expect(updated!.ssn).toBe('222-22-2222')

    const after = String((await rawDb.findByID({ collection: 'people', id: created.id })).ssn)
    expect(after).toMatch(/^enc:1:/)
    expect(after).not.toBe(before)
  })

  it('updating only name keeps ssn at rest as valid ciphertext that still decrypts', async () => {
    const created = await kernel.create({
      collection: 'people',
      data: { name: 'Edsger', ssn: '333-33-3333' },
      ...overrideReq,
    })
    const rawDb = (kernel as any).config.db

    await kernel.update({ collection: 'people', id: created.id, data: { name: 'Edsger D.' }, ...overrideReq })

    // The update path re-serializes the whole (decrypted) merged doc, so every encrypted
    // column is re-encrypted with a fresh IV on each write. The load-bearing guarantee is
    // that ssn stays valid ciphertext at rest and still decrypts to the unchanged value.
    const after = String((await rawDb.findByID({ collection: 'people', id: created.id })).ssn)
    expect(after).toMatch(/^enc:1:/)
    expect(after).not.toContain('333-33-3333')
    const read = await kernel.findByID({ collection: 'people', id: created.id, ...overrideReq })
    expect(read?.name).toBe('Edsger D.')
    expect(read?.ssn).toBe('333-33-3333')
  })
})

describe('encrypted fields — filter / sort rejection', () => {
  let kernel: Kernel
  beforeEach(async () => {
    kernel = await initKernel(buildConfig(), { logLevel: 'error' })
    await kernel.migrate()
    await kernel.create({ collection: 'people', data: { name: 'A', ssn: '000-00-0000' }, ...overrideReq })
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('a where on an encrypted field is rejected (cannot filter on unknown field)', async () => {
    await expect(
      kernel.find({ collection: 'people', where: { ssn: { equals: '000-00-0000' } }, ...overrideReq }),
    ).rejects.toThrow(/unknown field|bad.?request|filter/i)
  })

  it('a sort on an encrypted field does not throw and still returns decrypted docs', async () => {
    // Sort isn't validated against the filterable allow-list, so a sort on an encrypted
    // column is silently harmless: it orders by opaque ciphertext (meaningless) but never
    // throws and never leaks ciphertext — the rows still come back decrypted. (The hard
    // boundary is the WHERE rejection above, which is what protects against equality leaks.)
    const res = await kernel.find({ collection: 'people', sort: 'ssn', ...overrideReq })
    expect(res.docs).toHaveLength(1)
    expect(res.docs[0]!.ssn).toBe('000-00-0000')
  })
})

describe('encrypted fields — config-load guards (each throws at initKernel)', () => {
  const base = (extraFields: unknown[], extra: Partial<KernelConfig> = {}): KernelConfig =>
    ({
      secret: SECRET,
      db: sqliteAdapter({ url: ':memory:' }),
      encryption: { key: KEY },
      collections: [
        {
          slug: 'guard',
          access: { read: () => true },
          fields: extraFields,
        },
      ],
      ...extra,
    }) as KernelConfig

  it('rejects an encrypted + unique field', async () => {
    await expect(
      initKernel(base([{ name: 's', type: 'text', encrypted: true, unique: true }]), { logLevel: 'error' }),
    ).rejects.toThrow(/unique/i)
  })

  it('rejects an encrypted + indexed field', async () => {
    await expect(
      initKernel(base([{ name: 's', type: 'text', encrypted: true, index: true }]), { logLevel: 'error' }),
    ).rejects.toThrow(/index/i)
  })

  it('rejects an encrypted + localized field', async () => {
    await expect(
      initKernel(
        base([{ name: 's', type: 'text', encrypted: true, localized: true }], {
          localization: { locales: ['en', 'fr'], defaultLocale: 'en' },
        }),
        { logLevel: 'error' },
      ),
    ).rejects.toThrow(/localized/i)
  })

  it('rejects an encrypted relationship field', async () => {
    await expect(
      initKernel(
        base([
          { name: 'name', type: 'text' },
          { name: 'r', type: 'relationship', relationTo: 'guard', encrypted: true },
        ]),
        { logLevel: 'error' },
      ),
    ).rejects.toThrow(/relationship|encrypted/i)
  })

  it('rejects an encrypted field listed in search.fields', async () => {
    await expect(
      initKernel(
        {
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
        } as KernelConfig,
        { logLevel: 'error' },
      ),
    ).rejects.toThrow(/search/i)
  })

  it('rejects an encrypted field with no encryption.key', async () => {
    await expect(
      initKernel(
        {
          secret: SECRET,
          db: sqliteAdapter({ url: ':memory:' }),
          collections: [
            { slug: 'guard', access: { read: () => true }, fields: [{ name: 's', type: 'text', encrypted: true }] },
          ],
        } as KernelConfig,
        { logLevel: 'error' },
      ),
    ).rejects.toThrow(/encryption\.key|key/i)
  })

  it('rejects a too-short encryption.key', async () => {
    await expect(
      initKernel(base([{ name: 's', type: 'text', encrypted: true }], { encryption: { key: 'too-short' } }), {
        logLevel: 'error',
      }),
    ).rejects.toThrow(/encryption\.key|key|chars/i)
  })
})

describe('encrypted fields — wrong key surfaces a DecryptionError', () => {
  let dir: string
  let dbFile: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kenc-wrongkey-'))
    dbFile = join(dir, 'enc.db')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function fileConfig(key: string): KernelConfig {
    return defineConfig({
      secret: SECRET,
      db: sqliteAdapter({ url: `file:${dbFile}` }),
      encryption: { key },
      collections: [
        {
          slug: 'people',
          access: { read: () => true, create: () => true },
          fields: [
            { name: 'name', type: 'text' },
            { name: 'ssn', type: 'text', encrypted: true },
          ],
        },
      ],
    })
  }

  it('reading a doc written with key A through a kernel on key B throws DecryptionError', async () => {
    const keyA = 'wrong-key-test-AAAAAAAAAAAAAAAAAAAA'
    const keyB = 'wrong-key-test-BBBBBBBBBBBBBBBBBBBB'

    const kA = await initKernel(fileConfig(keyA), { logLevel: 'error' })
    await kA.migrate()
    const created = await kA.create({ collection: 'people', data: { name: 'X', ssn: '555-55-5555' }, ...overrideReq })
    // Grab the raw ciphertext while we still have the open handle.
    const raw = await (kA as any).config.db.findByID({
      collection: 'people',
      id: created.id,
    })
    const cipherText = String(raw.ssn)
    await kA.destroy()

    // The raw ciphertext from key A cannot be decrypted with a key-B cipher.
    expect(() => createFieldCipher(keyB).decrypt(cipherText)).toThrow(DecryptionError)

    // And reading it back through a kernel opened on key B surfaces the failure.
    const kB = await initKernel(fileConfig(keyB), { logLevel: 'error' })
    await expect(kB.findByID({ collection: 'people', id: created.id, ...overrideReq })).rejects.toThrow(DecryptionError)
    await kB.destroy()
  })
})

describe('encrypted fields — field read-access still applies on top of decryption', () => {
  let kernel: Kernel

  beforeEach(async () => {
    kernel = await initKernel(
      defineConfig({
        secret: SECRET,
        db: sqliteAdapter({ url: ':memory:' }),
        encryption: { key: KEY },
        collections: [
          {
            slug: 'records',
            access: { read: () => true, create: () => true },
            fields: [
              { name: 'name', type: 'text' },
              // Encrypted AND read-gated: only an admin may see the decrypted value.
              {
                name: 'ssn',
                type: 'text',
                encrypted: true,
                access: { read: ({ req }: any) => Boolean(req.user?.roles?.includes('admin')) },
              },
            ],
          },
        ],
      }),
      { logLevel: 'error' },
    )
    await kernel.migrate()
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('a denied reader gets the field stripped (not ciphertext); an allowed reader gets plaintext', async () => {
    const admin = { req: { user: { id: 'a', roles: ['admin'] } } }
    const viewer = { req: { user: { id: 'v', roles: ['viewer'] } } }

    const created = await kernel.create({
      collection: 'records',
      data: { name: 'Doc', ssn: '777-77-7777' },
      ...admin,
    })

    const asAdmin = await kernel.findByID({ collection: 'records', id: created.id, ...admin })
    expect(asAdmin?.ssn).toBe('777-77-7777')

    const asViewer = await kernel.findByID({ collection: 'records', id: created.id, ...viewer })
    // Stripped → absent, never ciphertext, never the plaintext.
    expect(asViewer?.ssn).toBeUndefined()
    expect(String(asViewer?.ssn ?? '')).not.toMatch(/^enc:1:/)
    expect(asViewer?.name).toBe('Doc')
  })
})

// Regression: the security gate found three plaintext-leak sinks that bypassed the at-rest
// guarantee. These pin them shut.
describe('encrypted fields — no plaintext leak into versions / webhooks / nested fields', () => {
  it('stores ciphertext (not plaintext) in version snapshots, and decrypts on version read', async () => {
    const kernel = await initKernel(
      defineConfig({
        secret: SECRET,
        encryption: { key: KEY },
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
      { logLevel: 'error', autoMigrate: true },
    )
    const created = await kernel.create({
      collection: 'people',
      data: { name: 'Ada', ssn: '123-45-6789', _status: 'published' },
      ...overrideReq,
    })
    await kernel.update({ collection: 'people', id: created.id, data: { ssn: '999-99-9999' }, ...overrideReq })

    // The `_versions_people` table holds ciphertext at rest — never the plaintext SSN.
    const vrows = await (kernel as any).config.db.find({
      collection: '_versions_people',
      where: { parent: { equals: created.id } },
      sort: [{ field: 'createdAt', direction: 'asc' }],
      limit: 10,
      page: 1,
    })
    expect(vrows.docs.length).toBeGreaterThanOrEqual(2)
    for (const v of vrows.docs) {
      expect(String(v.version.ssn)).toMatch(/^enc:1:/)
      expect(JSON.stringify(v.version)).not.toContain('123-45-6789')
      expect(JSON.stringify(v.version)).not.toContain('999-99-9999')
    }
    // …but the version-read API decrypts it back to plaintext.
    const history = await kernel.findVersions({ collection: 'people', id: created.id, ...overrideReq })
    const ssns = history.docs.map((d: any) => d.version.ssn)
    expect(ssns).toContain('123-45-6789')
    expect(ssns).toContain('999-99-9999')
    await kernel.destroy()
  })

  it('omits encrypted fields from webhook payloads (no plaintext to external receivers)', async () => {
    const calls: { body: string }[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      calls.push({ body: init.body })
      return new Response('ok', { status: 200 })
    }) as unknown as typeof fetch
    try {
      const kernel = await initKernel(
        defineConfig({
          secret: SECRET,
          encryption: { key: KEY },
          db: sqliteAdapter({ url: ':memory:' }),
          webhooks: [{ url: 'https://hook.example/all' }],
          collections: [
            {
              slug: 'people',
              access: { read: () => true, create: () => true },
              fields: [
                { name: 'name', type: 'text' },
                { name: 'ssn', type: 'text', encrypted: true },
              ],
            },
          ],
        }),
        { logLevel: 'error', autoMigrate: true },
      )
      await kernel.create({ collection: 'people', data: { name: 'Ada', ssn: '123-45-6789' }, ...overrideReq })
      expect(calls.length).toBe(1)
      const payload = JSON.parse(calls[0]!.body)
      // The doc is delivered, but the encrypted field is REDACTED — no plaintext, no ciphertext.
      expect(payload.doc.name).toBe('Ada')
      expect('ssn' in payload.doc).toBe(false)
      expect(calls[0]!.body).not.toContain('123-45-6789')
      expect(calls[0]!.body).not.toContain('enc:1:')
      await kernel.destroy()
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('rejects `encrypted` on a field nested in a group (would silently store plaintext)', async () => {
    await expect(
      initKernel(
        defineConfig({
          secret: SECRET,
          encryption: { key: KEY },
          db: sqliteAdapter({ url: ':memory:' }),
          collections: [
            {
              slug: 'people',
              access: { read: () => true },
              fields: [{ name: 'profile', type: 'group', fields: [{ name: 'ssn', type: 'text', encrypted: true }] }],
            },
          ],
        }),
        { logLevel: 'error' },
      ),
    ).rejects.toThrow(/nested/i)
  })

  it('rejects `encrypted` on a group nested inside a tabs container', async () => {
    await expect(
      initKernel(
        defineConfig({
          secret: SECRET,
          encryption: { key: KEY },
          db: sqliteAdapter({ url: ':memory:' }),
          collections: [
            {
              slug: 'people',
              access: { read: () => true },
              fields: [
                {
                  type: 'tabs',
                  tabs: [
                    {
                      label: 'Private',
                      fields: [
                        { name: 'profile', type: 'group', fields: [{ name: 'ssn', type: 'text', encrypted: true }] },
                      ],
                    },
                  ],
                } as any,
              ],
            },
          ],
        }),
        { logLevel: 'error' },
      ),
    ).rejects.toThrow(/nested/i)
  })

  it('never publishes an encrypted field into JSON-LD or llms.txt (anonymous SEO surfaces)', async () => {
    const kernel = await initKernel(
      defineConfig({
        secret: SECRET,
        encryption: { key: KEY },
        db: sqliteAdapter({ url: ':memory:' }),
        structuredData: { baseUrl: 'https://x.test', collections: [{ slug: 'notes', type: 'Article' }] },
        discoverability: { title: 'X', baseUrl: 'https://x.test', collections: [{ slug: 'notes' }] },
        collections: [
          {
            slug: 'notes',
            access: { read: () => true, create: () => true },
            fields: [
              { name: 'title', type: 'text' },
              // The only "body-ish" field is encrypted — it must NOT be auto-selected for output.
              { name: 'body', type: 'textarea', encrypted: true },
            ],
          },
        ],
      }),
      { logLevel: 'error', autoMigrate: true },
    )
    await kernel.create({
      collection: 'notes',
      data: { title: 'Public title', body: 'TOP-SECRET-BODY-TEXT', _status: 'published' },
      ...overrideReq,
    })
    const jsonld = JSON.stringify(
      await kernel.jsonLd({
        collection: 'notes',
        id: (await kernel.find({ collection: 'notes', ...overrideReq })).docs[0]!.id,
        ...overrideReq,
      }),
    )
    expect(jsonld).not.toContain('TOP-SECRET-BODY-TEXT')
    const llms = await kernel.llmsFullTxt()
    expect(llms).not.toContain('TOP-SECRET-BODY-TEXT')
    await kernel.destroy()
  })

  it('redacts a row/tabs-nested encrypted field from webhook payloads too', async () => {
    const calls: { body: string }[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      calls.push({ body: init.body })
      return new Response('ok', { status: 200 })
    }) as unknown as typeof fetch
    try {
      const kernel = await initKernel(
        defineConfig({
          secret: SECRET,
          encryption: { key: KEY },
          db: sqliteAdapter({ url: ':memory:' }),
          webhooks: [{ url: 'https://hook.example/all' }],
          collections: [
            {
              slug: 'people',
              access: { read: () => true, create: () => true },
              // `ssn` is encrypted but nested under a presentational `row` (a top-level column).
              fields: [
                { name: 'name', type: 'text' },
                { type: 'row', fields: [{ name: 'ssn', type: 'text', encrypted: true }] } as any,
              ],
            },
          ],
        }),
        { logLevel: 'error', autoMigrate: true },
      )
      await kernel.create({ collection: 'people', data: { name: 'Ada', ssn: '123-45-6789' }, ...overrideReq })
      expect(calls.length).toBe(1)
      expect(calls[0]!.body).not.toContain('123-45-6789')
      expect('ssn' in JSON.parse(calls[0]!.body).doc).toBe(false)
      await kernel.destroy()
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('rejects an explicit structuredData mapping to an encrypted field', async () => {
    await expect(
      initKernel(
        defineConfig({
          secret: SECRET,
          encryption: { key: KEY },
          db: sqliteAdapter({ url: ':memory:' }),
          structuredData: {
            baseUrl: 'https://x.test',
            collections: [{ slug: 'notes', type: 'Article', mapping: { articleBody: 'body' } }],
          },
          collections: [
            {
              slug: 'notes',
              access: { read: () => true },
              fields: [
                { name: 'title', type: 'text' },
                { name: 'body', type: 'textarea', encrypted: true },
              ],
            },
          ],
        }),
        { logLevel: 'error' },
      ),
    ).rejects.toThrow(/encrypted/i)
  })
})
