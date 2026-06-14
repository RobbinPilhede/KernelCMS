/* Live signed-asset-URL verification: HMAC-signed, expiring capability links for private
 * uploads. Proves: an authed principal can mint a signed URL for an upload doc it can READ;
 * the embedded sig is a real HMAC over the storage key + expiry (recomputed and matched); the
 * URL carries `?exp=&sig=`; a caller who cannot read the doc is DENIED minting; verifyAssetUrl
 * rejects a tampered sig and an expired link (past `nowSeconds`); and minting for a non-upload
 * collection is a BadRequest. No HTTP server needed — exercises the core op + helpers directly.
 * Run: pnpm tsx verify/asset-urls.ts */
import { createHmac } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig, initKernel, signAssetUrl, verifyAssetUrl } from '@kernel/core'
import { localStorage } from '@kernel/storage'
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

const SECRET = 'verify-secret-32-characters-long!!'
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

// An authed principal (can read secure_media) and an anonymous caller (cannot).
const authed = { req: { user: { id: 'editor', roles: ['editor'] } } } as any
const anon = { req: {} } as any

function parse(url: string): { path: string; exp: string | null; sig: string | null } {
  const q = url.indexOf('?')
  const path = q === -1 ? url : url.slice(0, q)
  const params = new URLSearchParams(q === -1 ? '' : url.slice(q + 1))
  return { path, exp: params.get('exp'), sig: params.get('sig') }
}

async function main() {
  const rootDir = mkdtempSync(join(tmpdir(), 'kverify-asset-urls-'))
  const dbFile = join(mkdtempSync(join(tmpdir(), 'kverify-asset-urls-db-')), 'a.db')
  const config = defineConfig({
    secret: SECRET,
    db: sqliteAdapter({ url: `file:${dbFile}` }),
    storage: localStorage({ rootDir, servePath: '/files' }),
    collections: [
      {
        slug: 'secure_media',
        // Readable only by an authenticated principal.
        access: { read: ({ req }: any) => Boolean(req.user) },
        upload: true,
        fields: [{ name: 'alt', type: 'text' }],
      },
      {
        slug: 'articles',
        access: { read: () => true, create: () => true },
        fields: [{ name: 'title', type: 'text' }],
      },
    ],
  })
  const kernel = await initKernel(config, { autoMigrate: true } as any)

  console.log('\n\x1b[1mAsset URLs — upload + mint a signed capability link\x1b[0m')
  const doc = await kernel.upload({
    collection: 'secure_media',
    file: { data: PNG, name: 'private.png', mimeType: 'image/png' },
    ...authed,
  })
  check('uploaded a secure_media file', Boolean(doc.id), `id=${doc.id}`)
  // The storage_key the HMAC actually covers (read from the raw row).
  const raw = await (kernel as any).config.db.findByID({ collection: 'secure_media', id: doc.id })
  const key = raw.storage_key as string
  check('the doc has a storage_key', typeof key === 'string' && key.length > 0, `key=${key}`)

  const url = await kernel.signedAssetUrl({ collection: 'secure_media', id: doc.id, ttl: 120, ...authed })
  const { path, exp, sig } = parse(url)
  check('the URL serves under /files/', path.startsWith('/files/'), `path=${path}`)
  check('the URL embeds exp=', Boolean(exp) && /^\d+$/.test(exp!), `exp=${exp}`)
  check('the URL embeds sig=', Boolean(sig), `sig=${sig?.slice(0, 12)}…`)
  check(
    'the path is the percent-encoded storage key',
    path === '/files/' + key.split('/').map(encodeURIComponent).join('/'),
    '',
  )

  console.log('\n\x1b[1mAsset URLs — the embedded sig is a real HMAC over key + exp\x1b[0m')
  const recomputed = createHmac('sha256', SECRET).update(`${key}\n${exp}`).digest('base64url')
  check('recomputed HMAC matches the embedded sig', sig === recomputed, 'sig verified')
  const helperSig = signAssetUrl(SECRET, key, Number(exp))
  check('signAssetUrl helper produces the same sig', sig === helperSig, '')
  const now = Math.floor(Date.now() / 1000)
  check(
    'verifyAssetUrl accepts the minted link (valid, not expired)',
    JSON.stringify(verifyAssetUrl(SECRET, key, exp, sig, now)) === JSON.stringify({ valid: true, expired: false }),
    '',
  )
  check(
    'minted exp reflects ttl=120 (~now+120)',
    Number(exp) >= now + 118 && Number(exp) <= now + 122,
    `exp-now=${Number(exp) - now}`,
  )

  console.log('\n\x1b[1mAsset URLs — verifyAssetUrl rejects tampering + expiry\x1b[0m')
  const tampered = (sig![0] === 'A' ? 'B' : 'A') + sig!.slice(1)
  check(
    'a tampered sig (same length) does NOT verify',
    verifyAssetUrl(SECRET, key, exp, tampered, now).valid === false,
    '',
  )
  check('a swapped key does NOT verify', verifyAssetUrl(SECRET, key + '.x', exp, sig, now).valid === false, '')
  check(
    'a bumped exp (no re-sign) does NOT verify',
    verifyAssetUrl(SECRET, key, String(Number(exp) + 1), sig, now).valid === false,
    '',
  )
  // Treat the link as expired by passing a `nowSeconds` past the expiry.
  const past = verifyAssetUrl(SECRET, key, exp, sig, Number(exp) + 1)
  check('an expired link is flagged expired (valid sig, past now)', past.valid === true && past.expired === true, '')

  console.log('\n\x1b[1mAsset URLs — access gate + bad inputs\x1b[0m')
  await denied('an anonymous caller (no req.user) CANNOT mint for an unreadable doc', () =>
    kernel.signedAssetUrl({ collection: 'secure_media', id: doc.id, ...anon }),
  )
  await denied('minting for a missing id throws NotFound', () =>
    kernel.signedAssetUrl({ collection: 'secure_media', id: 'no-such-id', ...authed }),
  )
  const article = await kernel.create({ collection: 'articles', data: { title: 'hi' }, ...authed })
  await denied('minting for a NON-upload collection throws BadRequest', () =>
    kernel.signedAssetUrl({ collection: 'articles', id: article.id, ...authed }),
  )

  await kernel.destroy()
  console.log(`\n\x1b[1mAsset URLs Result: ${pass} passed, ${fails.length} failed\x1b[0m`)
  if (fails.length) {
    console.log('Failures:\n  ' + fails.join('\n  '))
    process.exit(1)
  }
  process.exit(0)
}
main().catch((e) => {
  console.error('ASSET URLS HARNESS ERROR:', e)
  process.exit(2)
})
