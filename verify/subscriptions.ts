/* Live saved-search-alerts verification: an editor subscribes to a standing query
 * (collection + optional `where`); a cron drain reads the change feed since the
 * subscription's cursor, re-loads each changed doc AS THE OWNER (the access-checked read),
 * matches it against the stored `where`, and enqueues a webhook delivery per match. Proves:
 * owner-from-principal; the access-scoped drain (an alert fires only for content the owner
 * can read — the bob/alice secrets case); where-matching (urgent vs calm); cursor advance
 * (no re-deliver); webhook-must-be-configured; owner-only delete; `_subscriptions` CRUD
 * isolation; and config requires realtime + webhooks (denied at initKernel). The `alerts`
 * webhook has `collections: []` so it never fires inline — the drain is the only thing that
 * can enqueue a delivery, and we inspect the raw `_webhook_deliveries` outbox directly.
 * Run: pnpm tsx verify/subscriptions.ts */
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
    check(n, false, 'expected an error, succeeded')
  } catch (e: any) {
    check(
      n,
      /forbidden|not.?found|unauthorized|validation|bad.?request|invalid|require|realtime|webhook/i.test(
        `${e?.code}${e?.name}${e?.message}`,
      ),
      `threw ${e?.code ?? e?.name}`,
    )
  }
}

// Two human users + an admin.
const alice = { user: { id: 'alice', roles: ['viewer'] } } as any
const bob = { user: { id: 'bob', roles: ['viewer'] } } as any
const admin = { user: { id: 'adm', roles: ['admin'] } } as any

// Owner-scoped read: a row is only readable by its owner (or an admin).
const ownerRead = ({ req }: any) => {
  if (req.user?.roles?.includes('admin')) return true
  return { owner: { equals: req.user?.id ?? '__none__' } }
}

/** Read the raw `_webhook_deliveries` rows (the delivery-log doc does NOT expose `payload`). */
async function rawDeliveries(kernel: any): Promise<any[]> {
  const res = await kernel.config.db.find({ collection: '_webhook_deliveries', limit: 1000, page: 1 })
  return res.docs as any[]
}

async function main() {
  const dbFile = join(mkdtempSync(join(tmpdir(), 'kverify-subscriptions-')), 's.db')
  const config = defineConfig({
    secret: 'verify-secret-32-characters-long!!',
    db: sqliteAdapter({ url: `file:${dbFile}` }),
    audit: true,
    realtime: { enabled: true },
    subscriptions: true,
    // `collections: []` ⇒ subscription-only; the webhook never fires inline on a content
    // write, so the outbox is populated solely by processSubscriptions.
    webhooks: [{ slug: 'alerts', url: 'https://hook.example/alerts', collections: [] }],
    collections: [
      {
        slug: 'posts',
        access: { read: () => true, create: () => true, update: () => true, delete: () => true },
        fields: [
          { name: 'title', type: 'text' },
          { name: 'status', type: 'text' },
        ],
      },
      {
        slug: 'secrets',
        access: { read: ownerRead, create: () => true, update: () => true, delete: () => true },
        fields: [
          { name: 'owner', type: 'text' },
          { name: 'tag', type: 'text' },
        ],
      },
      {
        // Statically unreadable for non-admins — proves the collection read-gate on subscribe.
        slug: 'locked',
        access: { read: ({ req }: any) => req.user?.roles?.includes('admin') === true, create: () => true },
        fields: [{ name: 'title', type: 'text' }],
      },
    ],
  })
  const kernel = await initKernel(config, { autoMigrate: true } as any)

  console.log('\n\x1b[1mSubscriptions — create records owner from principal + cursor at now\x1b[0m')
  // Seed a change so the starting cursor is non-zero (the sub must not back-fill history).
  await kernel.create({ collection: 'posts', data: { title: 'seed', status: 'calm' }, overrideAccess: true })
  const sub = await kernel.createSubscription({
    collection: 'posts',
    where: { status: { equals: 'urgent' } },
    webhook: 'alerts',
    req: alice,
  })
  check(
    'owner recorded from the principal',
    sub.ownerId === 'alice' && sub.ownerType === 'user',
    `owner=${sub.ownerId}`,
  )
  check('where + webhook stored, active=true', sub.webhook === 'alerts' && sub.active === true, `wh=${sub.webhook}`)
  check('lastSeq starts at the current max seq (no back-fill)', sub.lastSeq > 0, `lastSeq=${sub.lastSeq}`)
  await denied('an anonymous caller cannot subscribe', () =>
    kernel.createSubscription({ collection: 'posts', webhook: 'alerts', req: {} }),
  )
  await denied('a user who cannot read the collection cannot subscribe', () =>
    kernel.createSubscription({ collection: 'locked', webhook: 'alerts', req: alice }),
  )

  console.log('\n\x1b[1mSubscriptions — validation: webhook-must-be-configured + where field\x1b[0m')
  await denied('an unknown webhook slug is rejected (BadRequest)', () =>
    kernel.createSubscription({ collection: 'posts', webhook: 'nope', req: alice }),
  )
  await denied('an invalid where field is rejected (BadRequest)', () =>
    kernel.createSubscription({
      collection: 'posts',
      where: { not_a_field: { equals: 'x' } },
      webhook: 'alerts',
      req: alice,
    }),
  )

  console.log('\n\x1b[1mSubscriptions — drain matches urgent, not calm (where-matching)\x1b[0m')
  const urgent = await kernel.create({
    collection: 'posts',
    data: { title: 'fire', status: 'urgent' },
    overrideAccess: true,
  })
  await kernel.create({ collection: 'posts', data: { title: 'chill', status: 'calm' }, overrideAccess: true })
  const r1 = await kernel.processSubscriptions()
  check('exactly one delivery enqueued (urgent only)', r1.delivered === 1, `delivered=${r1.delivered}`)
  const log1 = await kernel.webhookDeliveries({ webhook: 'alerts' })
  check('webhookDeliveries reflects one alerts delivery', log1.count === 1, `count=${log1.count}`)
  const rows1 = await rawDeliveries(kernel)
  check(
    'the delivered payload is the urgent post',
    rows1.length === 1 && rows1[0].documentId === urgent.id && rows1[0].payload?.doc?.title === 'fire',
    `title=${rows1[0]?.payload?.doc?.title}`,
  )

  console.log('\n\x1b[1mSubscriptions — cursor advances (a re-drain does not re-deliver)\x1b[0m')
  const r1b = await kernel.processSubscriptions()
  check('a second drain with no new changes enqueues 0', r1b.delivered === 0, `delivered=${r1b.delivered}`)
  check('the outbox still has exactly one row', (await rawDeliveries(kernel)).length === 1, '')

  console.log('\n\x1b[1mSubscriptions — alert scoped to the OWNER read access (the security property)\x1b[0m')
  const aliceSecretSub = await kernel.createSubscription({
    collection: 'secrets',
    where: { tag: { equals: 'x' } },
    webhook: 'alerts',
    req: alice,
  })
  // Bob creates a matching secret alice CANNOT read → no alert (the owner reload returns null).
  await kernel.create({ collection: 'secrets', data: { owner: 'bob', tag: 'x' }, req: bob })
  const rBob = await kernel.processSubscriptions()
  const afterBob = (await rawDeliveries(kernel)).filter((d) => d.collection === 'secrets')
  check(
    'bob secret (unreadable by alice) produces NO delivery',
    rBob.delivered === 0 && afterBob.length === 0,
    `delivered=${rBob.delivered}`,
  )
  // Alice creates a matching secret she CAN read → exactly one alert.
  const mine = await kernel.create({ collection: 'secrets', data: { owner: 'alice', tag: 'x' }, req: alice })
  const rAlice = await kernel.processSubscriptions()
  const afterAlice = (await rawDeliveries(kernel)).filter((d) => d.collection === 'secrets')
  check(
    'alice own matching secret produces exactly one delivery',
    rAlice.delivered === 1 && afterAlice.length === 1 && afterAlice[0].documentId === mine.id,
    `delivered=${rAlice.delivered}`,
  )
  void aliceSecretSub

  console.log('\n\x1b[1mSubscriptions — list scoping + owner-only delete\x1b[0m')
  const aliceList = await kernel.listSubscriptions({ req: alice })
  check('alice sees her own subscriptions', aliceList.length === 2, `n=${aliceList.length}`)
  const bobList = await kernel.listSubscriptions({ req: bob })
  check('bob does NOT see alice subscriptions', bobList.length === 0, `n=${bobList.length}`)
  await denied('a non-owner, non-admin cannot delete alice subscription', () =>
    kernel.deleteSubscription({ subscriptionId: sub.id, req: bob }),
  )
  const delByOwner = await kernel.deleteSubscription({ subscriptionId: sub.id, req: alice })
  check('the owner can delete', delByOwner.id === sub.id, '')
  const sub2 = await kernel.createSubscription({ collection: 'posts', webhook: 'alerts', req: alice })
  const delByAdmin = await kernel.deleteSubscription({ subscriptionId: sub2.id, req: admin })
  check('an admin can delete any subscription', delByAdmin.id === sub2.id, '')
  await denied('a prototype-pollution subscriptionId is rejected', () =>
    kernel.deleteSubscription({ subscriptionId: '__proto__', req: alice }),
  )

  console.log('\n\x1b[1mSubscriptions — _subscriptions is NOT reachable via generic CRUD\x1b[0m')
  await denied('find(_subscriptions) is rejected (system table)', () =>
    kernel.find({ collection: '_subscriptions', ...alice }),
  )
  await denied('create(_subscriptions) is rejected (system table)', () =>
    kernel.create({ collection: '_subscriptions', data: { collection: 'posts' }, overrideAccess: true }),
  )

  console.log('\n\x1b[1mSubscriptions — config requires realtime + a webhook (denied at initKernel)\x1b[0m')
  await denied('subscriptions:true without realtime.enabled is rejected at initKernel', () =>
    initKernel(
      defineConfig({
        secret: 'verify-secret-32-characters-long!!',
        db: sqliteAdapter({ url: ':memory:' }),
        subscriptions: true,
        webhooks: [{ slug: 'alerts', url: 'https://hook.example/alerts', collections: [] }],
        collections: [{ slug: 'posts', access: { read: () => true }, fields: [{ name: 'title', type: 'text' }] }],
      }),
      { autoMigrate: false } as any,
    ),
  )
  await denied('subscriptions:true without any webhooks is rejected at initKernel', () =>
    initKernel(
      defineConfig({
        secret: 'verify-secret-32-characters-long!!',
        db: sqliteAdapter({ url: ':memory:' }),
        realtime: { enabled: true },
        subscriptions: true,
        collections: [{ slug: 'posts', access: { read: () => true }, fields: [{ name: 'title', type: 'text' }] }],
      }),
      { autoMigrate: false } as any,
    ),
  )

  await kernel.destroy()
  console.log(`\n\x1b[1mSubscriptions Result: ${pass} passed, ${fails.length} failed\x1b[0m`)
  if (fails.length) {
    console.log('Failures:\n  ' + fails.join('\n  '))
    process.exit(1)
  }
  process.exit(0)
}
main().catch((e) => {
  console.error('SUBSCRIPTIONS HARNESS ERROR:', e)
  process.exit(2)
})
