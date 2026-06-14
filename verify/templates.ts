/* Live content-templates verification: named document skeletons instantiated through the
 * NORMAL create pipeline (access + field scope + agent draft-only brake all hold) with a
 * prototype-pollution-guarded override merge. Run: pnpm tsx verify/templates.ts */
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
async function errors(n: string, fn: () => Promise<unknown>, codeLike: string) {
  try {
    await fn()
    check(n, false, 'expected an error, none thrown')
  } catch (e: any) {
    check(n, `${e?.code ?? ''}${e?.name ?? ''}${e?.message ?? ''}`.toLowerCase().includes(codeLike), `threw ${e?.name}`)
  }
}

// An editor can create + publish posts; a viewer can neither create nor publish.
const editor = { req: { user: { id: 'u-editor', roles: ['editor'] } } } as any
const viewer = { req: { user: { id: 'u-viewer', roles: ['viewer'] } } } as any
const agent = (allow: string[]) =>
  ({ req: { user: { id: 'content-bot', principalType: 'agent', roles: ['editor'], fieldScope: { allow } } } }) as any

async function main() {
  const dbFile = join(mkdtempSync(join(tmpdir(), 'kverify-templates-')), 't.db')
  const config = defineConfig({
    secret: 'verify-secret-32-characters-long!!',
    db: sqliteAdapter({ url: `file:${dbFile}` }),
    audit: true,
    agents: [{ id: 'content-bot', token: 'verify-agent-token', fieldScope: { allow: ['title', 'layout'] } }],
    templates: [
      {
        slug: 'landing',
        collection: 'posts',
        name: 'Landing page',
        data: { title: 'Untitled landing', layout: [{ blockType: 'hero', heading: 'Hero' }] },
      },
      { slug: 'note', collection: 'posts', data: { title: 'Quick note' } },
      // A template that tries to publish — the agent brake must still hold.
      {
        slug: 'go_live',
        collection: 'posts',
        data: { title: 'Born published', _status: 'published' },
      },
    ],
    collections: [
      {
        slug: 'posts',
        versions: { drafts: true },
        access: {
          read: () => true,
          create: ({ req }: any) => req.user?.roles?.includes('editor') || req.user?.principalType === 'agent',
          update: ({ req }: any) => req.user?.roles?.includes('editor'),
        },
        fields: [
          { name: 'title', type: 'text', required: true },
          { name: 'featured', type: 'boolean' },
          {
            name: 'layout',
            type: 'blocks',
            blocks: [
              {
                slug: 'hero',
                fields: [
                  { name: 'heading', type: 'text' },
                  { name: 'sub', type: 'text' },
                ],
              },
            ],
          },
        ],
      },
    ],
  })
  const kernel = await initKernel(config, { autoMigrate: true } as any)

  console.log('\n\x1b[1mTemplates — list (metadata)\x1b[0m')
  const all = await kernel.listTemplates()
  check('listTemplates returns all configured', all.length === 3, `slugs=${all.map((t) => t.slug).join(',')}`)
  check(
    'list is metadata-only (no raw data)',
    all.every((t: any) => t.data === undefined),
    '',
  )
  const filtered = await kernel.listTemplates({ collection: 'posts' })
  check('listTemplates filters by collection', filtered.length === 3, `count=${filtered.length}`)
  const none = await kernel.listTemplates({ collection: 'authors' })
  check('listTemplates filters out other collections', none.length === 0, `count=${none.length}`)

  console.log('\n\x1b[1mTemplates — createFromTemplate (normal create pipeline)\x1b[0m')
  const landing = await kernel.createFromTemplate({ template: 'landing', ...editor })
  check('pre-fills template title', landing.title === 'Untitled landing', `title=${landing.title}`)
  check(
    'pre-fills template layout',
    Array.isArray(landing.layout) && landing.layout[0]?.heading === 'Hero',
    `layout=${JSON.stringify(landing.layout)?.slice(0, 40)}`,
  )
  check('created doc is a DRAFT (through normal create)', landing._status === 'draft', `_status=${landing._status}`)

  console.log('\n\x1b[1mTemplates — caller data OVERRIDES template defaults\x1b[0m')
  const custom = await kernel.createFromTemplate({ template: 'landing', data: { title: 'Custom' }, ...editor })
  check('caller title wins', custom.title === 'Custom', `title=${custom.title}`)
  check(
    'template layout still applied when not overridden',
    Array.isArray(custom.layout) && custom.layout[0]?.heading === 'Hero',
    `layout=${JSON.stringify(custom.layout)?.slice(0, 40)}`,
  )

  console.log('\n\x1b[1mTemplates — access control (normal create gate)\x1b[0m')
  await denied('viewer (no create access) CANNOT createFromTemplate', () =>
    kernel.createFromTemplate({ template: 'landing', ...viewer }),
  )

  console.log('\n\x1b[1mTemplates — agent draft-only brake holds\x1b[0m')
  // The agent uses a template whose data sets _status:'published'. The brake must keep it a
  // draft (born-published is either rejected or coerced — never actually published).
  const agentResult = await kernel
    .createFromTemplate({ template: 'go_live', ...agent(['title', 'layout']) })
    .then((doc: any) => ({ doc }))
    .catch((e: any) => ({ err: e }))
  if ((agentResult as any).err) {
    check('agent born-published template rejected (brake)', /forbidden/i.test(`${(agentResult as any).err?.name}`), '')
  } else {
    check(
      'agent template never published (brake → draft)',
      (agentResult as any).doc._status === 'draft',
      `_status=${(agentResult as any).doc._status}`,
    )
  }

  console.log('\n\x1b[1mTemplates — field scope strips out-of-scope fields\x1b[0m')
  // A field-scoped agent (title/layout only) instantiating a template that ALSO carries an
  // out-of-scope `featured` field → that field is stripped by the normal create field scope.
  const scoped = await kernel.createFromTemplate({
    template: 'note',
    data: { featured: true },
    ...agent(['title', 'layout']),
  })
  check('out-of-scope field stripped for agent', scoped.featured == null, `featured=${scoped.featured}`)
  check('in-scope template field survives', scoped.title === 'Quick note', `title=${scoped.title}`)

  console.log('\n\x1b[1mTemplates — unknown slug + proto-pollution guard\x1b[0m')
  await errors(
    'unknown template slug → clean NotFound',
    () => kernel.createFromTemplate({ template: 'does_not_exist', ...editor }),
    'not',
  )
  await errors(
    'inherited prototype key as slug → NotFound (no injection)',
    () => kernel.createFromTemplate({ template: 'constructor', ...editor }),
    'not',
  )
  const hostile = JSON.parse('{"__proto__":{"polluted":true}}')
  await errors(
    'prototype-pollution override → rejected (BadRequest)',
    () => kernel.createFromTemplate({ template: 'note', data: hostile, ...editor }),
    'illegal',
  )
  check('Object.prototype not polluted', ({} as any).polluted === undefined, '')

  console.log('\n\x1b[1mTemplates — audited with the template slug\x1b[0m')
  const audit = await (kernel as any).findAuditLog({ limit: 500 })
  const entries = audit.docs ?? audit
  const tmplEntry = entries.find((e: any) => e.meta?.template === 'landing')
  check(
    'createFromTemplate records the template slug in audit meta',
    Boolean(tmplEntry),
    `meta=${JSON.stringify(tmplEntry?.meta)}`,
  )

  console.log(`\n\x1b[1mTemplates Result: ${pass} passed, ${fails.length} failed\x1b[0m`)
  if (fails.length) {
    console.log('Failures:\n  ' + fails.join('\n  '))
    process.exit(1)
  }
  process.exit(0)
}
main().catch((e) => {
  console.error('TEMPLATES HARNESS ERROR:', e)
  process.exit(2)
})
