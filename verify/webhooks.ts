/* Live durable-webhooks verification: a REAL signed HTTP POST delivered to a loopback sink.
 * Proves: a durable webhook enqueues to the outbox and is delivered by `processWebhooks`
 * (not inline); the sink receives exactly one POST whose `x-kernel-signature` HMAC matches
 * the body; the payload carries the right event/collection/id; the delivery row lands
 * `delivered`. Then a failing sink (500) drives the retry/backoff state machine through to
 * `exhausted`. Finally the SSRF egress guard rejects a loopback target at config load unless
 * the endpoint opts in. Run: pnpm tsx verify/webhooks.ts */
import { createHmac } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
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
      /forbidden|not.?found|unauthorized|validation|bad.?request|invalid|private|loopback|ssrf/i.test(
        `${e?.code}${e?.name}${e?.message}`,
      ),
      `threw ${e?.code ?? e?.name}`,
    )
  }
}

const PORT = 3198
const HOOK_SECRET = 'verify-webhook-hmac-secret'

interface Received {
  method: string
  url: string
  headers: Record<string, string | undefined>
  body: string
}

/** A loopback HTTP sink. Records every request; `status` controls the response code so a
 *  test can simulate a healthy (200) or failing (500) receiver. */
function makeSink() {
  const received: Received[] = []
  let status = 200
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c as Buffer))
    req.on('end', () => {
      received.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers as Record<string, string | undefined>,
        body: Buffer.concat(chunks).toString('utf8'),
      })
      res.statusCode = status
      res.end(status === 200 ? 'ok' : 'boom')
    })
  })
  return {
    received,
    listen: () => new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', resolve)),
    setStatus: (s: number) => {
      status = s
    },
    close: () =>
      new Promise<void>((resolve) => {
        // Drop any lingering keep-alive sockets first, then stop the server. Leaving a socket
        // handle half-open while the process exits aborts libuv (UV_HANDLE_CLOSING) on Windows.
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

async function main() {
  const sink = makeSink()
  await sink.listen()
  try {
    const dbFile = join(mkdtempSync(join(tmpdir(), 'kverify-webhooks-')), 'w.db')
    const config = defineConfig({
      secret: 'verify-secret-32-characters-long!!',
      db: sqliteAdapter({ url: `file:${dbFile}` }),
      audit: true,
      webhooks: [
        {
          slug: 'sink_hook',
          url: `http://127.0.0.1:${PORT}/hook`,
          secret: HOOK_SECRET,
          durable: true,
          maxAttempts: 2,
          allowPrivateNetwork: true,
          collections: ['posts'],
        },
      ],
      collections: [
        {
          slug: 'posts',
          access: { read: () => true, create: () => true, update: () => true, delete: () => true },
          fields: [{ name: 'title', type: 'text', required: true }],
        },
      ],
    })
    const kernel = await initKernel(config, { autoMigrate: true } as any)

    console.log('\n\x1b[1mWebhooks — durable enqueue (no inline delivery)\x1b[0m')
    sink.setStatus(200)
    const post = await kernel.create({ collection: 'posts', data: { title: 'Ship it' }, overrideAccess: true })
    check('content write succeeded', Boolean(post.id), `id=${post.id}`)
    check(
      'nothing delivered inline (sink untouched before drain)',
      sink.received.length === 0,
      `n=${sink.received.length}`,
    )
    const queued = await kernel.webhookDeliveries({ status: 'pending' })
    check('exactly one pending delivery enqueued', queued.count === 1, `count=${queued.count}`)
    check(
      'the pending row targets the configured webhook',
      queued.docs[0]?.webhook === 'sink_hook',
      `wh=${queued.docs[0]?.webhook}`,
    )

    console.log('\n\x1b[1mWebhooks — REAL signed delivery via processWebhooks\x1b[0m')
    const result = await kernel.processWebhooks()
    check(
      'processWebhooks reports one delivered',
      result.delivered.length === 1,
      `delivered=${result.delivered.length}`,
    )
    check('the sink received exactly one POST', sink.received.length === 1, `n=${sink.received.length}`)
    const req = sink.received[0]!
    check(
      'request is a POST to the hook path',
      req.method === 'POST' && req.url === '/hook',
      `${req.method} ${req.url}`,
    )
    check(
      'content-type is application/json',
      (req.headers['content-type'] ?? '').includes('application/json'),
      req.headers['content-type'] ?? '',
    )
    check(
      'x-kernel-event header is create',
      req.headers['x-kernel-event'] === 'create',
      `event=${req.headers['x-kernel-event']}`,
    )
    // Recompute the HMAC over the exact received body — it must match the sent signature.
    const expectedSig = `sha256=${createHmac('sha256', HOOK_SECRET).update(req.body).digest('hex')}`
    check('x-kernel-signature HMAC matches the body', req.headers['x-kernel-signature'] === expectedSig, 'sig verified')
    const payload = JSON.parse(req.body)
    check('payload event is create', payload.event === 'create', `event=${payload.event}`)
    check('payload collection is posts', payload.collection === 'posts', `collection=${payload.collection}`)
    check('payload id matches the document', payload.id === post.id, `id=${payload.id}`)
    check('payload carries the document body', payload.doc?.title === 'Ship it', `title=${payload.doc?.title}`)
    const deliveredRows = await kernel.webhookDeliveries({ status: 'delivered' })
    check('the delivery row is marked delivered', deliveredRows.count === 1, `count=${deliveredRows.count}`)
    check(
      'deliveredAt is set, nextAttemptAt cleared',
      Boolean(deliveredRows.docs[0]?.deliveredAt) && deliveredRows.docs[0]?.nextAttemptAt === null,
      '',
    )

    console.log('\n\x1b[1mWebhooks — failing sink drives retry -> exhausted\x1b[0m')
    sink.setStatus(500)
    sink.received.length = 0
    const post2 = await kernel.create({ collection: 'posts', data: { title: 'Will fail' }, overrideAccess: true })
    const queued2 = await kernel.webhookDeliveries({ webhook: 'sink_hook', status: 'pending' })
    check('the failing event enqueued one pending delivery', queued2.count === 1, `count=${queued2.count}`)

    const t0 = new Date('2031-01-01T00:00:00.000Z')
    const r1 = await kernel.processWebhooks({ now: t0 })
    check('first attempt fails and is retried', r1.retried.length === 1, `retried=${r1.retried.length}`)
    check('the sink was actually hit on the failing attempt', sink.received.length === 1, `n=${sink.received.length}`)
    const afterFail = await kernel.webhookDeliveries({ webhook: 'sink_hook', status: 'failed' })
    const failedRow = afterFail.docs.find((d) => d.documentId === post2.id)
    check(
      'the delivery is failed with attempts=1',
      failedRow?.status === 'failed' && failedRow?.attempts === 1,
      `attempts=${failedRow?.attempts}`,
    )
    check(
      'nextAttemptAt is now + 2s backoff',
      new Date(failedRow!.nextAttemptAt!).getTime() === t0.getTime() + 2000,
      `next=${failedRow?.nextAttemptAt}`,
    )

    // Same instant: not due yet, no further attempt.
    const rSame = await kernel.processWebhooks({ now: t0 })
    check(
      'a re-drain at the same instant does nothing (not due)',
      rSame.retried.length === 0 && rSame.exhausted.length === 0,
      '',
    )

    // Advance past the backoff: the final attempt exhausts the delivery (maxAttempts=2).
    const t1 = new Date(t0.getTime() + 3000)
    const r2 = await kernel.processWebhooks({ now: t1 })
    check('the second attempt exhausts the delivery', r2.exhausted.length === 1, `exhausted=${r2.exhausted.length}`)
    const exhaustedRow = (await kernel.webhookDeliveries({ webhook: 'sink_hook', status: 'exhausted' })).docs.find(
      (d) => d.documentId === post2.id,
    )
    check(
      'the delivery is exhausted with attempts=2',
      exhaustedRow?.status === 'exhausted' && exhaustedRow?.attempts === 2,
      `attempts=${exhaustedRow?.attempts}`,
    )
    check(
      'an exhausted delivery has no next attempt',
      exhaustedRow?.nextAttemptAt === null,
      `next=${exhaustedRow?.nextAttemptAt}`,
    )

    console.log('\n\x1b[1mWebhooks — redaction + outbox not reachable via CRUD\x1b[0m')
    const summaries = kernel.listWebhooks()
    check('listWebhooks redacts the secret', !JSON.stringify(summaries).includes(HOOK_SECRET), '')
    check('listWebhooks reflects signed=true', summaries[0]?.signed === true, '')
    await denied('the _webhook_deliveries outbox is NOT reachable via find', () =>
      kernel.find({ collection: '_webhook_deliveries', overrideAccess: true } as any),
    )

    console.log('\n\x1b[1mWebhooks — SSRF egress guard at config load\x1b[0m')
    await denied('a loopback webhook WITHOUT allowPrivateNetwork is rejected at initKernel', () =>
      initKernel(
        defineConfig({
          secret: 'verify-secret-32-characters-long!!',
          db: sqliteAdapter({ url: ':memory:' }),
          webhooks: [{ url: 'http://127.0.0.1/leak' }],
          collections: [{ slug: 'posts', access: { read: () => true }, fields: [{ name: 'title', type: 'text' }] }],
        }),
        { autoMigrate: false } as any,
      ),
    )
    await denied('a cloud-metadata webhook (169.254.169.254) is rejected at initKernel', () =>
      initKernel(
        defineConfig({
          secret: 'verify-secret-32-characters-long!!',
          db: sqliteAdapter({ url: ':memory:' }),
          webhooks: [{ url: 'http://169.254.169.254/latest/meta-data/' }],
          collections: [{ slug: 'posts', access: { read: () => true }, fields: [{ name: 'title', type: 'text' }] }],
        }),
        { autoMigrate: false } as any,
      ),
    )

    // Regression: the IPv4-mapped IPv6 SSRF bypass both red-teams found — Node normalizes the
    // host to the hex-compressed form, so a dotted-decimal-only guard let `169.254.169.254`
    // (cloud metadata) and every private range through in `[::ffff:hex:hex]` form.
    for (const url of [
      'http://[::ffff:a9fe:a9fe]/latest/meta-data/', // 169.254.169.254 metadata
      'http://[::ffff:7f00:1]/', // 127.0.0.1
      'http://[::ffff:10.0.0.1]/', // 10.0.0.1
      'http://[fe9a::1]/', // fe80::/10 link-local (not just fe8)
      'http://[64:ff9b::a9fe:a9fe]/', // NAT64 well-known prefix embedding 169.254.169.254
    ]) {
      await denied(`a mapped/encoded private webhook (${url}) is rejected at initKernel`, () =>
        initKernel(
          defineConfig({
            secret: 'verify-secret-32-characters-long!!',
            db: sqliteAdapter({ url: ':memory:' }),
            webhooks: [{ url }],
            collections: [{ slug: 'posts', access: { read: () => true }, fields: [{ name: 'title', type: 'text' }] }],
          }),
          { autoMigrate: false } as any,
        ),
      )
    }
    // …but a genuinely PUBLIC mapped address is NOT over-blocked.
    const publicMapped = await initKernel(
      defineConfig({
        secret: 'verify-secret-32-characters-long!!',
        db: sqliteAdapter({ url: ':memory:' }),
        webhooks: [{ url: 'http://[::ffff:8.8.8.8]/hook' }],
        collections: [{ slug: 'posts', access: { read: () => true }, fields: [{ name: 'title', type: 'text' }] }],
      }),
      { autoMigrate: false } as any,
    )
    check('a public mapped IPv6 address (8.8.8.8) is allowed (no over-block)', true, 'accepted')
    await publicMapped.destroy()

    await kernel.destroy()
    console.log(`\n\x1b[1mWebhooks Result: ${pass} passed, ${fails.length} failed\x1b[0m`)
    if (fails.length) console.log('Failures:\n  ' + fails.join('\n  '))
    // Set the code; exit only AFTER the sink is fully closed (finally) so we don't race the
    // server's handle teardown — on Windows that race aborts libuv with UV_HANDLE_CLOSING.
    process.exitCode = fails.length ? 1 : 0
  } finally {
    await sink.close()
  }
}
main().catch((e) => {
  console.error('WEBHOOKS HARNESS ERROR:', e)
  process.exit(2)
})
