import { test, expect } from '@playwright/test'

// In-practice test of signed, expiring asset URLs against the LIVE server. `secure_media` is
// an auth-only upload collection: its file is NOT served to an anonymous request via the
// normal session path (404), but a signed capability URL fetches it without a session until it
// expires. Seeding uses the service key (a Bearer API key sets NO session cookie), so the
// no-auth GETs below are genuinely anonymous.

const SVC = { Authorization: 'Bearer e2e-key' }

test('a signed URL fetches a private file without a session; tamper + expiry are rejected', async ({ request }) => {
  // Upload a private file (multipart) as the service key.
  const upload = await request.post('/api/secure_media', {
    headers: SVC,
    multipart: {
      file: { name: 'secret.txt', mimeType: 'text/plain', buffer: Buffer.from('top secret bytes') },
      alt: 'secret',
    },
  })
  expect(upload.ok()).toBeTruthy()
  const doc = await upload.json()
  expect(doc.url).toBeTruthy()

  // The plain (unsigned) file URL is private: an anonymous GET is refused.
  const anonPlain = await request.get(doc.url)
  expect(anonPlain.status()).toBe(404)

  // Mint a signed capability URL (access-checked as the service key).
  const minted = await request.get(`/api/secure_media/${doc.id}/signed-url?ttl=3600`, { headers: SVC })
  expect(minted.ok()).toBeTruthy()
  const { url: signedUrl } = await minted.json()
  expect(signedUrl).toContain('exp=')
  expect(signedUrl).toContain('sig=')

  // The signed URL fetches the file with NO auth — the signature is the capability.
  const viaSigned = await request.get(signedUrl)
  expect(viaSigned.ok()).toBeTruthy()
  expect(await viaSigned.text()).toBe('top secret bytes')

  // A tampered signature is rejected.
  const tampered = signedUrl.replace(/sig=([^&]+)/, (m: string, s: string) => `sig=${s.slice(0, -2)}xy`)
  const viaTampered = await request.get(tampered)
  expect(viaTampered.status()).toBe(403)

  // A stripped signature falls back to the (anonymous → denied) session path.
  const noSig = signedUrl.replace(/[?&]sig=[^&]+/, '')
  expect((await request.get(noSig)).status()).toBeGreaterThanOrEqual(403)
})

test('a signed URL stops working after it expires', async ({ request }) => {
  const upload = await request.post('/api/secure_media', {
    headers: SVC,
    multipart: {
      file: { name: 'short.txt', mimeType: 'text/plain', buffer: Buffer.from('ephemeral') },
      alt: 'short',
    },
  })
  const doc = await upload.json()

  // Mint a 1-second link, fetch it immediately (works), then after it expires (403).
  const minted = await request.get(`/api/secure_media/${doc.id}/signed-url?ttl=1`, { headers: SVC })
  const { url: signedUrl } = await minted.json()
  expect((await request.get(signedUrl)).ok()).toBeTruthy()

  await new Promise((r) => setTimeout(r, 1600))
  expect((await request.get(signedUrl)).status()).toBe(403)
})

test('minting a signed URL requires read access to the document', async ({ request }) => {
  // Seed a private file with the service key.
  const doc = await (
    await request.post('/api/secure_media', {
      headers: SVC,
      multipart: { file: { name: 'x.txt', mimeType: 'text/plain', buffer: Buffer.from('x') }, alt: 'x' },
    })
  ).json()

  // An anonymous caller cannot read secure_media, so cannot mint a link for it.
  const anonMint = await request.get(`/api/secure_media/${doc.id}/signed-url`)
  expect(anonMint.status()).toBeGreaterThanOrEqual(401)
  expect(anonMint.status()).toBeLessThan(500)
})
