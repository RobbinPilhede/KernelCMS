/* Live personalization + A/B experiments verification harness. Boots a real sqlite kernel
 * with `audiences: { segments: ['default','vip','beta'], default:'default' }`, a `posts`
 * collection with a `personalized` `headline` field and a read-denied `personalized`
 * field, and `experiments: [{ slug:'hero_test', variants:['default','vip'] }]`.
 *
 * PROVES:
 *  - per-segment write merge (no clobber) + the resolve/fallback chain (vip → its value,
 *    beta → default fallback, unknown 'zzz' → default segment);
 *  - a read-denied personalized field is stripped regardless of audience (access wins);
 *  - assignVariant is deterministic (sticky) and distributes ~per weights over 1000 keys;
 *    composing the assigned variant as req.audience yields that variant's content;
 *  - untrusted audience '__proto__' is treated as unknown → default (no prototype pollution);
 *  - a field set BOTH localized and personalized is rejected at config.
 * Run: pnpm tsx verify/personalization.ts */
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

const at = (audience?: string) =>
  ({ req: { user: { id: 'u', roles: ['editor'] }, ...(audience ? { audience } : {}) } }) as any

async function main() {
  const dbFile = join(mkdtempSync(join(tmpdir(), 'kverify-personalization-')), 'p.db')
  const config = defineConfig({
    secret: 'verify-secret-32-characters-long!!',
    db: sqliteAdapter({ url: `file:${dbFile}` }),
    audit: true,
    audiences: { segments: ['default', 'vip', 'beta'], default: 'default' },
    experiments: [{ slug: 'hero_test', variants: ['default', 'vip'] }],
    collections: [
      {
        slug: 'posts',
        access: { read: () => true, create: () => true, update: () => true },
        fields: [
          { name: 'title', type: 'text', required: true },
          { name: 'headline', type: 'text', personalized: true },
          // A read-denied personalized field — must be stripped regardless of audience.
          { name: 'secret_offer', type: 'text', personalized: true, access: { read: () => false } },
        ],
      },
    ],
  })
  const kernel = await initKernel(config, { autoMigrate: true } as any)

  console.log('\n\x1b[1mPersonalization — per-segment write merge + resolve/fallback\x1b[0m')
  // Write the default segment on create, then the vip segment via req.audience on update.
  const post = await kernel.create({
    collection: 'posts',
    data: { title: 'Hero', headline: 'Welcome', secret_offer: 'default-deal' },
    ...at('default'),
  })
  await kernel.update({
    collection: 'posts',
    id: post.id,
    data: { headline: 'Welcome VIP', secret_offer: 'vip-deal' },
    ...at('vip'),
  })

  const asVip = await kernel.findByID({ collection: 'posts', id: post.id, ...at('vip') })
  check('audience:vip reads the vip headline', asVip?.headline === 'Welcome VIP', `headline=${asVip?.headline}`)
  const asDefault = await kernel.findByID({ collection: 'posts', id: post.id, ...at('default') })
  check(
    'audience:default still reads the default headline (vip write did not clobber)',
    asDefault?.headline === 'Welcome',
    `headline=${asDefault?.headline}`,
  )
  const asBeta = await kernel.findByID({ collection: 'posts', id: post.id, ...at('beta') })
  check(
    'audience:beta (no value) falls back to the default segment',
    asBeta?.headline === 'Welcome',
    `headline=${asBeta?.headline}`,
  )
  const asUnknown = await kernel.findByID({ collection: 'posts', id: post.id, ...at('zzz') })
  check(
    'unknown audience "zzz" → default segment',
    asUnknown?.headline === 'Welcome',
    `headline=${asUnknown?.headline}`,
  )

  console.log('\n\x1b[1mPersonalization — field read-access still applies\x1b[0m')
  check(
    'read-denied personalized field stripped for vip',
    asVip?.secret_offer === undefined,
    `secret_offer=${asVip?.secret_offer}`,
  )
  check(
    'read-denied personalized field stripped for default',
    asDefault?.secret_offer === undefined,
    `secret_offer=${asDefault?.secret_offer}`,
  )

  console.log('\n\x1b[1mPersonalization — untrusted audience is not a pollution vector\x1b[0m')
  const asProto = await kernel.findByID({ collection: 'posts', id: post.id, ...at('__proto__') })
  check(
    'audience "__proto__" treated as unknown → default content',
    asProto?.headline === 'Welcome',
    `headline=${asProto?.headline}`,
  )
  check(
    'no prototype pollution from "__proto__" audience',
    ({} as any).headline === undefined,
    'Object.prototype clean',
  )

  console.log('\n\x1b[1mA/B experiments — deterministic bucketing + distribution\x1b[0m')
  const first = kernel.assignVariant({ experiment: 'hero_test', key: 'visitor-123' })
  check(
    'assignVariant returns a configured variant',
    ['default', 'vip'].includes(first.variant),
    `variant=${first.variant}`,
  )
  check('variant === segment (composable as req.audience)', first.variant === first.segment, `segment=${first.segment}`)
  let sticky = true
  for (let i = 0; i < 100; i++) {
    if (kernel.assignVariant({ experiment: 'hero_test', key: 'visitor-123' }).variant !== first.variant) sticky = false
  }
  check('assignVariant is deterministic (same key → same variant)', sticky, `variant=${first.variant}`)

  let vip = 0
  const n = 1000
  for (let i = 0; i < n; i++) {
    if (kernel.assignVariant({ experiment: 'hero_test', key: `visitor-${i}` }).variant === 'vip') vip++
  }
  const ratio = vip / n
  check(
    'distribution ~50/50 over 1000 keys (equal weights)',
    ratio > 0.4 && ratio < 0.6,
    `vip ratio=${ratio.toFixed(3)}`,
  )

  // Compose the assigned variant as the read audience and confirm it serves that content.
  const composed = await kernel.findByID({ collection: 'posts', id: post.id, ...at(first.segment) })
  const expected = first.variant === 'vip' ? 'Welcome VIP' : 'Welcome'
  check(
    'composing assigned variant as req.audience yields that variant content',
    composed?.headline === expected,
    `headline=${composed?.headline} (variant=${first.variant})`,
  )

  try {
    kernel.assignVariant({ experiment: 'nope', key: 'k' })
    check('unknown experiment rejected', false, 'did not throw')
  } catch (e: any) {
    check('unknown experiment rejected', /unknown experiment/i.test(`${e?.message}`), `threw ${e?.code ?? e?.name}`)
  }

  console.log('\n\x1b[1mConfig — a field cannot be BOTH localized and personalized\x1b[0m')
  let rejected = false
  try {
    await initKernel(
      defineConfig({
        secret: 'verify-secret-32-characters-long!!',
        db: sqliteAdapter({ url: ':memory:' }),
        localization: { locales: ['en'], defaultLocale: 'en' },
        audiences: { segments: ['default', 'vip'], default: 'default' },
        collections: [{ slug: 'bad', fields: [{ name: 'h', type: 'text', localized: true, personalized: true }] }],
      }),
      { autoMigrate: true } as any,
    )
  } catch (e: any) {
    rejected = /cannot be both/i.test(`${e?.message}`)
  }
  check('localized + personalized field rejected at config', rejected, '')

  console.log(`\n\x1b[1mPersonalization Result: ${pass} passed, ${fails.length} failed\x1b[0m`)
  if (fails.length) {
    console.log('Failures:\n  ' + fails.join('\n  '))
    process.exit(1)
  }
  process.exit(0)
}
main().catch((e) => {
  console.error('PERSONALIZATION HARNESS ERROR:', e)
  process.exit(2)
})
