# Field-level encryption at rest

**Field-level encryption** keeps a field's plaintext out of your database. Mark any storage
field `encrypted: true` and KernelCMS encrypts it **transparently** — encrypted on write,
decrypted on read — so the value lives as plaintext only inside the app layer, while the
storage column holds an opaque, authenticated `enc:1:<iv>:<tag>:<ciphertext>` envelope.
It is for the fields you don't want sitting in cleartext in a backup, a replica, or a leaked
dump: a Social Security number, an API token, a private note, an access key.

Encryption is **AES-256-GCM** with a **fresh 96-bit IV per value**, so the same plaintext
encrypts to a different envelope every time — two rows holding the same secret look nothing
alike at rest. The cipher is **authenticated**: a tampered envelope or the wrong key is a
hard, detectable failure (`DecryptionError`), never silently-decrypted garbage. The key is
**server-only** — derived from your config, never logged, never returned in a response.

## Opt in

Encryption is off until you give the engine a key and mark a field. Set `encryption.key` on
the config (read it from the environment — **never** hardcode it) and add `encrypted: true`
to any storage field:

```ts
export default defineConfig({
  encryption: { key: process.env.FIELD_ENCRYPTION_KEY }, // server-only secret, ≥16 chars
  collections: [
    {
      slug: 'people',
      fields: [
        { name: 'name', type: 'text' },
        { name: 'ssn', type: 'text', encrypted: true },   // stored encrypted
        { name: 'notes', type: 'json', encrypted: true }, // any storage field type works
      ],
    },
  ],
})
```

The `key` is **any sufficiently-random secret of at least 16 characters**; a 256-bit AES
key is derived from it with SHA-256, so you don't have to supply exactly 32 bytes. Marking a
field `encrypted: true` without configuring `encryption.key` is **rejected at config load** —
there's no quiet fallback to storing plaintext.

Encryption works for **any storage field type** — `text`, `json`, `richText`, and the rest:
the plaintext is JSON-serialized before it's encrypted, so structured values round-trip
exactly. Reading a document gives you the decrypted value as if nothing happened; the
ciphertext never surfaces in the app layer.

## What you give up

An encrypted column holds **opaque, non-deterministic ciphertext** — the storage layer can't
see the value, and the same plaintext encrypts differently every time. That makes a handful
of features impossible *by construction*, and each is **rejected at config load** rather than
failing silently later. An `encrypted` field **cannot** be:

- **`unique`** — uniqueness is a property of the stored bytes, and a fresh IV per value means
  two identical secrets store as different ciphertext. The database could never see the
  collision.
- **`index`ed** — an index orders rows by their stored value; encrypted bytes have no
  meaningful order, so an index would buy nothing.
- **filtered or sorted on** — a `where` clause or a `sort` runs against the stored column. The
  engine only ever sees ciphertext there, so it can't compare, match, or order encrypted
  values.
- **full-text searched** — search indexes the stored text; ciphertext is noise. (If you need
  to search a value, it can't also be encrypted at rest.)
- **`localized`** — per-locale variants and the encryption envelope can't share one column.
- **`personalized`** — per-audience variants, same constraint.

This is the deliberate trade-off of encryption at rest: you protect the value from anyone with
the database, at the cost of the database being able to do anything *with* the value. Keep the
columns you query, sort, or index in plaintext, and reserve `encrypted: true` for the fields
that are pure payload — secrets you store and hand back, never query by.

**Field read-access still applies on top.** Encryption protects the value at rest; it is not a
substitute for authorization. A caller who fails a field's `access.read` rule gets `null`,
**never the ciphertext** — the envelope is never handed to a reader who couldn't have read the
plaintext.

## Key management

The key is the whole security boundary — **treat it exactly like a database credential.**

- **Read it from the environment.** `encryption: { key: process.env.FIELD_ENCRYPTION_KEY }`.
  Never commit it, never inline it in the config, never log it. It is server-only and never
  appears in an API response or an error message.
- **Rotating the key makes existing ciphertext unreadable.** The key that encrypted a value is
  the only key that can decrypt it. Swap in a new key and every pre-existing envelope stops
  decrypting (reads raise `DecryptionError`). There is **no built-in re-encryption** — KernelCMS
  will not walk your tables and re-wrap old values for you. If you must rotate, plan a migration
  that reads each document under the old key and re-writes it under the new one, with both keys
  available during the cutover.
- **Lose the key and the data is gone.** This is real encryption: without the key the
  ciphertext is unrecoverable — there is no recovery path, no backdoor, no reset. Back the key
  up the way you back up a root credential, and store it somewhere you won't lose it
  independently of the database.

## How it works

On write, KernelCMS JSON-serializes the plaintext, generates a **random 96-bit IV**, and
encrypts with **AES-256-GCM** under the key derived from `encryption.key`. What lands in the
column is a self-describing envelope:

```text
enc:1:<iv>:<tag>:<ciphertext>
```

`enc:1` is the scheme/version tag, `<iv>` is the per-value nonce, `<tag>` is the GCM
authentication tag, and `<ciphertext>` is the encrypted payload — all base64. On read, the
engine parses the envelope, **verifies the authentication tag**, decrypts, and JSON-parses
the result back into the original value. Because the IV is regenerated for every single write,
encrypting the same plaintext twice yields two different envelopes — there's no equality or
frequency to leak across rows.

If verification fails — a tampered envelope, a flipped byte, or the **wrong key** — decryption
raises a `DecryptionError` instead of returning corrupted data. Authenticated encryption means
a bad decrypt is always a loud, detectable error, never silent garbage that propagates into
your app.

For advanced use, `createFieldCipher(key)` and `DecryptionError` are exported from
`@kernel/core` if you need to encrypt or decrypt a value outside the field pipeline.

## The guarantees

Field-level encryption protects a value at rest with authenticated encryption and a
server-only key — and is honest about exactly what that costs.

- **Authenticated, never silent garbage.** AES-256-GCM verifies an authentication tag on every
  read. A tampered envelope or the wrong key is a hard, detectable `DecryptionError` — never a
  quietly-corrupted value.
- **Per-value random IV.** A fresh 96-bit IV per write means identical plaintext stores as
  different ciphertext every time — no equality, frequency, or value leak across rows.
- **The key stays on the server.** The 256-bit AES key is SHA-256-derived from `encryption.key`,
  which is read from the environment and **never** logged, returned, or placed in an error
  message.
- **Read-access is still enforced.** Encryption is not authorization: a reader who fails a
  field's `access.read` rule gets `null`, never the ciphertext.
- **Incompatible features are rejected at load.** An `encrypted` field can't be `unique`,
  `index`ed, filtered/sorted on, full-text searched, `localized`, or `personalized` — each is
  caught at config load, not at runtime.
- **Rotation is a migration, and key-loss is final.** Rotating the key makes existing ciphertext
  unreadable (there's no built-in re-encryption), and losing the key makes the data
  unrecoverable — manage it like a database credential.

Red-teamed to **Risk LOW.** Field encryption sits alongside the rest of the
[field reference](https://kernelcms.com/docs/fields) and the access model in
[conventions.md](conventions.md).
