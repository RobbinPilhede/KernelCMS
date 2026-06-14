/* Live content-lint verification: `kernel.lintDocument` runs the configured pre-publish evals
 * against a document ON DEMAND (read-only) and reports every finding plus the blocking subset —
 * the SAME rules that gate `publish()`. Proves: a blocking required-field finding flips ok:false
 * and would reject a publish; a non-blocking readability WARN never blocks; ok flips true once the
 * required field is satisfied AND publish then succeeds; lint is gated on UPDATE access (a public
 * reader who cannot edit is refused, so drafts can't leak through findings); no evals → an empty ok
 * result; and the three built-in factories' pure behaviour, including linkEval reading the canonical
 * link node `url`.
 * Run: pnpm tsx verify/lint.ts */
import { mkdtempSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig, initKernel, readabilityEval, requiredFieldsEval, linkEval } from '@kernel/core'
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
      /forbidden|not.?found|unauthorized|validation|bad.?request|invalid|not allowed/i.test(
        `${e?.code}${e?.name}${e?.message}`,
      ),
      `threw ${e?.code ?? e?.name}`,
    )
  }
}

// Two human users and an admin.
const writer = { user: { id: 'writer', roles: ['writer'] } } as any
const admin = { user: { id: 'adm', roles: ['admin'] } } as any
const stranger = { user: { id: 'stranger', roles: ['writer'] } } as any

// A richText field VALUE in storage is the KernelRichText doc. `link` nodes key their target as
// `url` (the canonical shape linkEval reads).
const richDoc = (children: unknown[]) => ({ v: 1, type: 'doc', children })
const paragraph = (children: unknown[]) => ({ type: 'paragraph', children })
const text = (t: string) => ({ type: 'text', text: t })
const link = (url: string) => ({ type: 'link', url, children: [text('x')] })
const bodyField = { name: 'body', type: 'richText' } as any

// A long-winded body that trips readability (maxAvgSentenceWords: 8).
const LONG_BODY =
  'This single sentence deliberately runs on and on without any punctuation so that the readability eval measures a very high average number of words per sentence and emits a warning for us.'

// Owner-scoped UPDATE: only the owner (or an admin) may edit a row. Reads are PUBLIC — lint must
// still refuse a public reader who cannot edit, so a draft can't leak through lint findings.
const ownerUpdate = ({ req }: any) => {
  if (req.user?.roles?.includes('admin')) return true
  return { owner: { equals: req.user?.id ?? '__none__' } }
}

async function main() {
  const dbDir = mkdtempSync(join(tmpdir(), 'kverify-lint-'))
  const dbFile = join(dbDir, 'l.db')
  const config = defineConfig({
    secret: 'verify-secret-32-characters-long!!',
    db: sqliteAdapter({ url: `file:${dbFile}` }),
    evals: [
      requiredFieldsEval({ fields: ['summary'] }),
      readabilityEval({ fields: ['body'], maxAvgSentenceWords: 8 }),
      linkEval(),
    ],
    collections: [
      {
        slug: 'posts',
        versions: { drafts: true },
        access: { read: () => true, create: () => true, update: ownerUpdate },
        fields: [
          { name: 'owner', type: 'text' },
          { name: 'title', type: 'text' },
          { name: 'summary', type: 'text' },
          { name: 'body', type: 'richText' },
        ],
      },
    ],
  })
  const kernel = await initKernel(config, { autoMigrate: true } as any)

  try {
    console.log('\n\x1b[1mLint — blocking required-field surfaces + readability warns (no block)\x1b[0m')
    const post = await kernel.create({
      collection: 'posts',
      data: { owner: 'writer', title: 'Wordy, no summary', body: richDoc([paragraph([text(LONG_BODY)])]) },
      req: writer,
    })
    const r1 = await kernel.lintDocument({ collection: 'posts', id: post.id, req: writer })
    check('a missing required field flips ok:false', r1.ok === false, `ok=${r1.ok}`)
    const block = r1.blocking[0]
    check(
      'the blocking finding is the required-fields error on summary',
      Boolean(block) &&
        block!.rule === 'required-fields' &&
        block!.severity === 'error' &&
        block!.field === 'summary' &&
        block!.blocking === true,
      `rule=${block?.rule}`,
    )
    const warn = r1.findings.find((f: any) => f.rule === 'readability' && !f.ok)
    check(
      'readability emits a non-blocking WARN',
      Boolean(warn) && warn!.severity === 'warn' && warn!.blocking === false,
      `severity=${warn?.severity}`,
    )
    check(
      'the readability warn does NOT appear in the blocking subset',
      r1.blocking.every((f: any) => f.rule !== 'readability'),
      `blocking=${r1.blocking.length}`,
    )

    console.log('\n\x1b[1mLint — the SAME rules gate publish\x1b[0m')
    await denied('publishing the unsatisfied doc throws (same gate)', () =>
      kernel.publish({ collection: 'posts', id: post.id, req: writer }),
    )
    const stillDraft = await kernel.findByID({ collection: 'posts', id: post.id, draft: true, overrideAccess: true })
    check('...and the doc is still a draft', stillDraft?._status === 'draft', `status=${stillDraft?._status}`)

    console.log('\n\x1b[1mLint — ok flips true once satisfied, and publish then succeeds\x1b[0m')
    await kernel.update({ collection: 'posts', id: post.id, data: { summary: 'now present' }, req: writer })
    const r2 = await kernel.lintDocument({ collection: 'posts', id: post.id, req: writer })
    check('ok flips true once the required field is present', r2.ok === true, `ok=${r2.ok}`)
    check(
      'the required-fields finding now passes (ok/info)',
      Boolean(r2.findings.find((f: any) => f.rule === 'required-fields' && f.ok && f.severity === 'info')),
      '',
    )
    check(
      'the readability warn still surfaces but never blocks',
      r2.ok === true && r2.findings.some((f: any) => f.rule === 'readability' && !f.ok),
      '',
    )
    const published = await kernel.publish({ collection: 'posts', id: post.id, req: writer })
    check('publish now succeeds', published?._status === 'published', `status=${published?._status}`)

    console.log('\n\x1b[1mLint — access-checked (no leak)\x1b[0m')
    const owned = await kernel.lintDocument({ collection: 'posts', id: post.id, req: writer })
    check('the owner CAN lint their own doc', owned.ok === true, '')
    const byAdmin = await kernel.lintDocument({ collection: 'posts', id: post.id, req: admin })
    check('an admin CAN lint any doc', byAdmin.ok === true, '')
    await denied('a public reader who cannot EDIT is refused (drafts cannot leak via lint)', () =>
      kernel.lintDocument({ collection: 'posts', id: post.id, req: stranger }),
    )
    await denied('linting a missing id is rejected', () =>
      kernel.lintDocument({ collection: 'posts', id: 'does-not-exist', req: admin }),
    )

    console.log('\n\x1b[1mLint — no evals configured → empty ok result\x1b[0m')
    const noEvalDir = mkdtempSync(join(tmpdir(), 'kverify-lint-noeval-'))
    const noEvalKernel = await initKernel(
      defineConfig({
        secret: 'verify-secret-32-characters-long!!',
        db: sqliteAdapter({ url: `file:${join(noEvalDir, 'n.db')}` }),
        collections: [
          {
            slug: 'posts',
            versions: { drafts: true },
            access: { read: () => true, create: () => true, update: () => true },
            fields: [{ name: 'title', type: 'text' }],
          },
        ],
      }),
      { autoMigrate: true } as any,
    )
    try {
      const np = await noEvalKernel.create({ collection: 'posts', data: { title: 'No evals' }, req: writer })
      const nr = await noEvalKernel.lintDocument({ collection: 'posts', id: np.id, req: writer })
      check(
        'no evals → { ok:true, findings:[], blocking:[] }',
        nr.ok === true && nr.findings.length === 0 && nr.blocking.length === 0,
        `findings=${nr.findings.length}`,
      )
    } finally {
      await noEvalKernel.destroy()
      try {
        rmSync(noEvalDir, { recursive: true, force: true })
      } catch {
        // best-effort temp cleanup
      }
    }

    console.log('\n\x1b[1mLint — built-in factories (pure behaviour)\x1b[0m')
    // requiredFieldsEval: errors on empty/blank/[]/null, passes when present.
    const reqRule = requiredFieldsEval({ fields: ['summary'] })
    const reqErrs = async (v: unknown) =>
      (await reqRule.run({ doc: { summary: v }, collection: 'posts', req: {} as any })).filter(
        (f) => !f.ok && f.severity === 'error',
      )
    check('requiredFieldsEval errors on empty string', (await reqErrs('')).length === 1, '')
    check('requiredFieldsEval errors on blank string', (await reqErrs('   ')).length === 1, '')
    check('requiredFieldsEval errors on empty array', (await reqErrs([])).length === 1, '')
    check('requiredFieldsEval errors on null', (await reqErrs(null)).length === 1, '')
    const reqPass = await reqRule.run({ doc: { summary: 'present' }, collection: 'posts', req: {} as any })
    check(
      'requiredFieldsEval passes when present',
      reqPass.every((f) => f.ok),
      '',
    )

    // readabilityEval: flags long sentences + high long-word ratio, passes clean prose.
    const readRule = readabilityEval({ fields: ['body'], maxAvgSentenceWords: 8 })
    const longSentence = await readRule.run({
      doc: { body: richDoc([paragraph([text(LONG_BODY)])]) },
      collection: 'posts',
      req: {} as any,
      fields: [bodyField],
    })
    check(
      'readabilityEval flags a long sentence (warn)',
      longSentence.some((f) => !f.ok && f.severity === 'warn' && /words\/sentence/.test(f.message)),
      '',
    )
    const longWords = 'extraordinarily incomprehensibly uncharacteristically internationalization '.repeat(4).trim()
    const highRatio = await readRule.run({
      doc: { body: richDoc([paragraph([text(longWords)])]) },
      collection: 'posts',
      req: {} as any,
      fields: [bodyField],
    })
    check(
      'readabilityEval flags a high long-word ratio (warn)',
      highRatio.some((f) => !f.ok && f.severity === 'warn' && /long words/.test(f.message)),
      '',
    )
    const cleanProse = 'The cat sat. The dog ran. Birds sing. We walk home. It was a good day for all.'
    const clean = await readRule.run({
      doc: { body: richDoc([paragraph([text(cleanProse)])]) },
      collection: 'posts',
      req: {} as any,
      fields: [bodyField],
    })
    check(
      'readabilityEval passes clean, short-sentence prose',
      clean.every((f) => f.ok),
      '',
    )

    // linkEval: flags empty/'#'/malformed, passes valid, skips non-links — reading `url`.
    const linkRule = linkEval()
    const linkWarns = async (children: unknown[]) =>
      (
        await linkRule.run({
          doc: { body: richDoc(children) },
          collection: 'posts',
          req: {} as any,
          fields: [bodyField],
        })
      ).filter((f) => !f.ok && f.severity === 'warn')
    check('linkEval flags an empty url', (await linkWarns([paragraph([link('')])])).length === 1, '')
    check('linkEval flags a "#" placeholder url', (await linkWarns([paragraph([link('#')])])).length === 1, '')
    check('linkEval flags a malformed http URL', (await linkWarns([paragraph([link('http://')])])).length === 1, '')
    check(
      'linkEval passes a valid https URL (reads `url`)',
      (await linkWarns([paragraph([link('https://example.com/post')])])).length === 0,
      '',
    )
    check(
      'linkEval ignores a non-link node',
      (await linkWarns([paragraph([text('just text, no links')])])).length === 0,
      '',
    )
  } finally {
    await kernel.destroy()
    try {
      rmSync(dirname(dbFile), { recursive: true, force: true })
    } catch {
      // best-effort temp cleanup
    }
  }

  console.log(`\n\x1b[1mLint Result: ${pass} passed, ${fails.length} failed\x1b[0m`)
  if (fails.length) {
    console.log('Failures:\n  ' + fails.join('\n  '))
    process.exit(1)
  }
  process.exit(0)
}
main().catch((e) => {
  console.error('LINT HARNESS ERROR:', e)
  process.exit(2)
})
