# Signed asset URLs

A **signed asset URL** is a *capability link* to one uploaded file. By default KernelCMS serves
an upload's `url` with a **per-request access check** against the caller's session — private media
stays private, and every fetch re-checks who's asking. A signed URL is the other model: a **bearer
capability** that anyone holding it can fetch, **without a session**, until it expires.

`kernel.signedAssetUrl({ collection, id, ttl?, req })` mints one. It returns a plain string —
`"<servePath>/<key>?exp=<unix>&sig=<hmac>"` — that grants read of **exactly one file** until `exp`.
Use it to email a private download, embed a time-limited image on a page that can't carry the
caller's session, or hand a file to a service that has no way to authenticate.

Minting is **access-checked**: the caller must be able to **read** the document, so you can never
sign a link to a file you can't already see. The signature is an **HMAC keyed by `config.secret`**
(server-only) over **both** the storage key **and** the expiry, so a link can't be forged, its file
can't be swapped, and its expiry can't be extended. The secret never appears in the URL.

## Mint a signed URL

On the Local API (`kernel`):

```ts
const url = await kernel.signedAssetUrl({
  collection: 'media',
  id: file.id,
  ttl: 600,   // seconds; optional, default 3600 (1h), clamped to 1s..7days
  req,        // the caller — must be able to READ this document
})
// → "/files/2026/06/invoice.pdf?exp=1750000000&sig=9f86d0818..."
```

`ttl` is the link's lifetime in **seconds**. It defaults to **1 hour** and is **clamped to
`1s..7days`** — a larger value is capped, not honored. The returned `exp` is an absolute Unix
timestamp; the `sig` is the HMAC over the storage key **and** `exp`, so neither can be tampered
with after the fact.

### REST

```http
GET /api/:collection/:id/signed-url?ttl=600    # → { "url": "<servePath>/<key>?exp=&sig=" }
```

The route is **access-checked as the caller** — exactly like reading the document. A caller who
can't read the document gets the same denial they'd get from a plain read; they never receive a
link. The `ttl` query parameter is optional and clamped identically.

```bash
# mint a 10-minute link as the authenticated caller
curl "http://localhost:3000/api/media/$FILE_ID/signed-url?ttl=600" \
  -H "Authorization: Bearer $TOKEN"
# → {"url":"/files/2026/06/invoice.pdf?exp=1750000000&sig=9f86d0818..."}
```

## How a receiver fetches it

There's nothing to verify and no session to carry — the receiver just **GETs the URL**:

```bash
curl "http://localhost:3000/files/2026/06/invoice.pdf?exp=1750000000&sig=9f86d0818..."
```

The file route sees the `?exp=&sig=` pair, recomputes the HMAC over the key + `exp`, compares it
**constant-time**, and checks that `exp` is still in the future. If both hold, it serves the bytes
**without a session check**. A request whose signature doesn't recompute — a tampered key, a bumped
`exp`, a truncated `sig` — or one that has expired is rejected with **`403`**. A request to the same
path with **no** `?sig=` falls back to the **normal session access check**, exactly as before — so
adding signed URLs never loosens the default private-media path.

## Choosing a TTL

A signed link is a **capability**: within its TTL, **anyone who holds it can fetch the file**. That's
the whole point — it's what lets you email a download or embed an image on a page that can't
authenticate — but it means the TTL *is* your security boundary. Pick the shortest window that still
works:

- A link emailed for an immediate download: **minutes**.
- A time-limited embed on a public page: as long as the embed needs to stay live, no longer.
- A sensitive file (an invoice, a contract, a private export): **short**, and re-mint on demand
  rather than minting one long-lived link.

There is **no per-link revocation**. A signed link is valid until its `exp`, full stop — you can't
invalidate one link early. The only way to invalidate **every** outstanding link at once is to
**rotate `config.secret`**, which breaks all signatures (existing and future) keyed by the old
secret. So lean on a **short TTL** instead of expecting to call a link back.

## S3 and other adapters

When the storage adapter mints its **own** signed URLs — an S3/R2 presign, for example —
`signedAssetUrl` **delegates to the adapter** instead of building a KernelCMS-signed path. You get
the adapter's native presigned URL (served directly by the object store), with the same
access-checked minting in front of it: the caller still has to be able to read the document, and the
adapter's own expiry applies. For local disk storage, the `?exp=&sig=` capability above is what's
served by the KernelCMS file route.

## The guarantees

A signed asset URL is a tightly-scoped capability — one file, one expiry, signed server-side.

- **Can't be forged.** The `sig` is an HMAC keyed by `config.secret` (server-only) over the storage
  key **and** `exp`. Without the secret you can't produce a valid signature for any key or any
  expiry; the comparison is **constant-time**.
- **Can't be extended or retargeted.** Because `exp` and the key are **both** inside the signed
  payload, bumping the expiry or swapping in a different file invalidates the signature — the route
  answers `403`.
- **It expires.** `exp` is an absolute timestamp; past it, the route refuses to serve. `ttl` is
  clamped to `1s..7days`, so no link outlives a week.
- **Minting requires read access.** `signedAssetUrl` and `GET …/signed-url` run the same read check
  as a plain read — you can never link a file you can't see, and the REST route never hands an
  unauthorized caller a URL.
- **The secret stays on the server.** `config.secret` keys the HMAC and **never appears in the
  URL**, in logs, or in any response.
- **Capability by design.** Within its TTL a link is **shareable** and **not individually
  revocable** — set a short TTL for sensitive files, and rotate `config.secret` to invalidate all
  outstanding links at once.
- **Adapter presign is honored.** When the storage adapter signs its own URLs (S3/R2), minting
  delegates to it behind the same access check.

Red-teamed to **Risk LOW**. Signed asset URLs build on the upload field and storage adapters and
sit alongside the access model in [conventions.md](conventions.md).
