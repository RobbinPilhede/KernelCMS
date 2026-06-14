import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { defineConfig, initKernel, readabilityEval, requiredFieldsEval, linkEval } from './index'
import type { Kernel, RichTextField } from './index'

// `kernel.lintDocument` is a read-only preview of the publish gate: it loads the doc's draft and
// runs `config.evals`, reporting every finding plus the blocking subset (a blocking rule with an
// `error`). It's an EDITORIAL tool, so it's gated on UPDATE access — read alone must not expose a
// draft through lint findings. The SAME rules gate `publish()`, so a blocking finding here means a
// real publish would throw. These tests pin that equivalence, the warn-doesn't-block semantics,
// the update-access gate, appliesTo scoping, and the pure factory behaviour.

// A richText field VALUE in storage is the KernelRichText doc; a top-level paragraph wraps the
// inline nodes. `link` nodes key their target as `url` (the canonical shape linkEval reads).
const richDoc = (children: unknown[]) => ({ v: 1, type: 'doc', children })
const paragraph = (children: unknown[]) => ({ type: 'paragraph', children })
const text = (t: string) => ({ type: 'text', text: t })
const link = (url: string, label = 'x') => ({ type: 'link', url, children: [text(label)] })

// A sentence-heavy body whose average sentence length exceeds the readability threshold (8).
const LONG_SENTENCE_BODY =
  'This single sentence deliberately runs on and on without any punctuation so that the readability eval measures a very high average number of words per sentence and emits a warning for us.'

const writer = { user: { id: 'writer', roles: ['writer'] } } as any
const admin = { user: { id: 'admin', roles: ['admin'] } } as any
const stranger = { user: { id: 'stranger', roles: ['writer'] } } as any

// The richText field def we hand the pure linkEval factory so it can locate `body`.
const bodyField: RichTextField = { name: 'body', type: 'richText' }

describe('lintDocument — kernel integration (preview of the publish gate)', () => {
  let kernel: Kernel

  beforeEach(async () => {
    const config = defineConfig({
      secret: 'lint-test-secret-32-characters!!',
      db: sqliteAdapter({ url: ':memory:' }),
      evals: [
        requiredFieldsEval({ fields: ['summary'] }),
        readabilityEval({ fields: ['body'], maxAvgSentenceWords: 8 }),
        linkEval(),
      ],
      collections: [
        {
          slug: 'posts',
          versions: { drafts: true },
          access: { read: () => true, create: () => true, update: () => true },
          fields: [
            { name: 'title', type: 'text' },
            { name: 'summary', type: 'text' },
            { name: 'body', type: 'richText' },
          ],
        },
      ],
    })
    kernel = await initKernel(config, { logLevel: 'error' })
    await kernel.migrate()
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('surfaces a blocking finding when a required field is empty', async () => {
    const post = await kernel.create({ collection: 'posts', data: { title: 'No summary' }, req: writer })
    const result = await kernel.lintDocument({ collection: 'posts', id: post.id, req: writer })

    expect(result.ok).toBe(false)
    expect(result.blocking).toHaveLength(1)
    const block = result.blocking[0]!
    expect(block.rule).toBe('required-fields')
    expect(block.severity).toBe('error')
    expect(block.field).toBe('summary')
    expect(block.blocking).toBe(true)
  })

  it('is ok when the required field is present (required-fields yields a non-blocking pass)', async () => {
    const post = await kernel.create({
      collection: 'posts',
      data: { title: 'Has summary', summary: 'A crisp summary.' },
      req: writer,
    })
    const result = await kernel.lintDocument({ collection: 'posts', id: post.id, req: writer })

    expect(result.ok).toBe(true)
    expect(result.blocking).toHaveLength(0)
    const required = result.findings.find((f) => f.rule === 'required-fields')!
    expect(required.ok).toBe(true)
    expect(required.severity).toBe('info')
  })

  it('emits a non-blocking readability WARN that does not flip ok', async () => {
    const post = await kernel.create({
      collection: 'posts',
      data: { title: 'Wordy', summary: 'present', body: richDoc([paragraph([text(LONG_SENTENCE_BODY)])]) },
      req: writer,
    })
    const result = await kernel.lintDocument({ collection: 'posts', id: post.id, req: writer })

    const warn = result.findings.find((f) => f.rule === 'readability' && !f.ok)!
    expect(warn).toBeDefined()
    expect(warn.severity).toBe('warn')
    expect(warn.ok).toBe(false)
    expect(warn.blocking).toBe(false)
    // Warnings never block.
    expect(result.ok).toBe(true)
    expect(result.blocking).toHaveLength(0)
  })

  it('gates publish with the same rules: no summary throws, with summary succeeds', async () => {
    const post = await kernel.create({ collection: 'posts', data: { title: 'Gate me' }, req: writer })

    // lintDocument previews the gate as blocking...
    const before = await kernel.lintDocument({ collection: 'posts', id: post.id, req: writer })
    expect(before.ok).toBe(false)
    // ...and publish actually throws.
    await expect(kernel.publish({ collection: 'posts', id: post.id, req: writer })).rejects.toThrow()

    await kernel.update({ collection: 'posts', id: post.id, data: { summary: 'now present' }, req: writer })
    const after = await kernel.lintDocument({ collection: 'posts', id: post.id, req: writer })
    expect(after.ok).toBe(true)
    const published = await kernel.publish({ collection: 'posts', id: post.id, req: writer })
    expect(published?._status).toBe('published')
  })

  it('returns an empty ok result when no evals are configured', async () => {
    const config = defineConfig({
      secret: 'lint-test-secret-32-characters!!',
      db: sqliteAdapter({ url: ':memory:' }),
      collections: [
        {
          slug: 'posts',
          versions: { drafts: true },
          access: { read: () => true, create: () => true, update: () => true },
          fields: [{ name: 'title', type: 'text' }],
        },
      ],
    })
    const k = await initKernel(config, { logLevel: 'error' })
    await k.migrate()
    try {
      const post = await k.create({ collection: 'posts', data: { title: 'No evals' }, req: writer })
      const result = await k.lintDocument({ collection: 'posts', id: post.id, req: writer })
      expect(result).toEqual({ ok: true, findings: [], blocking: [] })
    } finally {
      await k.destroy()
    }
  })

  it('does not run an eval scoped to a different collection (appliesTo)', async () => {
    const config = defineConfig({
      secret: 'lint-test-secret-32-characters!!',
      db: sqliteAdapter({ url: ':memory:' }),
      evals: [{ ...requiredFieldsEval({ fields: ['summary'] }), appliesTo: ['other'] }],
      collections: [
        {
          slug: 'posts',
          versions: { drafts: true },
          access: { read: () => true, create: () => true, update: () => true },
          fields: [
            { name: 'title', type: 'text' },
            { name: 'summary', type: 'text' },
          ],
        },
      ],
    })
    const k = await initKernel(config, { logLevel: 'error' })
    await k.migrate()
    try {
      // A post with NO summary would normally block, but the rule is scoped to 'other'.
      const post = await k.create({ collection: 'posts', data: { title: 'Scoped away' }, req: writer })
      const result = await k.lintDocument({ collection: 'posts', id: post.id, req: writer })
      expect(result.ok).toBe(true)
      expect(result.findings).toHaveLength(0)
    } finally {
      await k.destroy()
    }
  })
})

describe('lintDocument — gated on UPDATE access (editorial pre-publish tool)', () => {
  let kernel: Kernel

  // Owner-scoped UPDATE: only the owner (or an admin) may edit a row. Reads are PUBLIC — the
  // common Payload-style config where drafts are normally hidden by the published-only filter.
  const ownerUpdate = ({ req }: any) => {
    if (req.user?.roles?.includes('admin')) return true
    return { owner: { equals: req.user?.id ?? '__none__' } }
  }

  beforeEach(async () => {
    const config = defineConfig({
      secret: 'lint-test-secret-32-characters!!',
      db: sqliteAdapter({ url: ':memory:' }),
      evals: [requiredFieldsEval({ fields: ['summary'] })],
      collections: [
        {
          slug: 'posts',
          versions: { drafts: true },
          access: { read: () => true, create: () => true, update: ownerUpdate },
          fields: [
            { name: 'owner', type: 'text' },
            { name: 'title', type: 'text' },
            { name: 'summary', type: 'text' },
          ],
        },
      ],
    })
    kernel = await initKernel(config, { logLevel: 'error' })
    await kernel.migrate()
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('lets an editor (owner) and an admin lint, but denies a public reader who cannot edit', async () => {
    const post = await kernel.create({
      collection: 'posts',
      data: { owner: 'writer', title: 'Mine', summary: 'ok' },
      req: writer,
    })

    const owned = await kernel.lintDocument({ collection: 'posts', id: post.id, req: writer })
    expect(owned.ok).toBe(true)
    const adminView = await kernel.lintDocument({ collection: 'posts', id: post.id, req: admin })
    expect(adminView.ok).toBe(true)

    // A stranger CAN read the (public) collection, but cannot UPDATE this row → lint refuses.
    // This is the draft-leak guard: read access alone must not expose a draft via lint findings.
    await expect(kernel.lintDocument({ collection: 'posts', id: post.id, req: stranger })).rejects.toThrow(
      /forbidden|not allowed/i,
    )
  })

  it('refuses to lint a missing document with a not-found (no existence oracle)', async () => {
    await expect(kernel.lintDocument({ collection: 'posts', id: 'no-such-id', req: admin })).rejects.toThrow(
      /not.?found/i,
    )
  })
})

// ---------------------------------------------------------------------------
// Pure-factory unit checks (no kernel): exercise each built-in's run() directly.
// ---------------------------------------------------------------------------

describe('readabilityEval (pure)', () => {
  const rule = readabilityEval({ fields: ['body'], maxAvgSentenceWords: 8 })

  it('warns on a long-winded sentence', async () => {
    const findings = await rule.run({
      doc: { body: richDoc([paragraph([text(LONG_SENTENCE_BODY)])]) },
      collection: 'posts',
      req: {} as any,
      fields: [bodyField],
    })
    expect(findings.some((f) => !f.ok && f.severity === 'warn' && /words\/sentence/.test(f.message))).toBe(true)
  })

  it('warns on a high long-word ratio', async () => {
    const longWords = 'extraordinarily incomprehensibly uncharacteristically internationalization '.repeat(4).trim()
    const findings = await rule.run({
      doc: { body: richDoc([paragraph([text(longWords)])]) },
      collection: 'posts',
      req: {} as any,
      fields: [bodyField],
    })
    expect(findings.some((f) => !f.ok && f.severity === 'warn' && /long words/.test(f.message))).toBe(true)
  })

  it('passes clean, short-sentence prose', async () => {
    const clean = 'The cat sat. The dog ran. Birds sing. We walk home. It was a good day for all.'
    const findings = await rule.run({
      doc: { body: richDoc([paragraph([text(clean)])]) },
      collection: 'posts',
      req: {} as any,
      fields: [bodyField],
    })
    expect(findings.every((f) => f.ok)).toBe(true)
  })
})

describe('requiredFieldsEval (pure)', () => {
  const rule = requiredFieldsEval({ fields: ['summary'] })

  const errorsFor = async (value: unknown) => {
    const findings = await rule.run({ doc: { summary: value }, collection: 'posts', req: {} as any })
    return findings.filter((f) => !f.ok && f.severity === 'error')
  }

  it('errors on empty string, blank string, empty array, and null', async () => {
    expect(await errorsFor('')).toHaveLength(1)
    expect(await errorsFor('   ')).toHaveLength(1)
    expect(await errorsFor([])).toHaveLength(1)
    expect(await errorsFor(null)).toHaveLength(1)
  })

  it('passes when the field is present', async () => {
    const findings = await rule.run({ doc: { summary: 'present' }, collection: 'posts', req: {} as any })
    expect(findings.every((f) => f.ok)).toBe(true)
  })
})

describe('linkEval (pure) — reads the canonical link node `url`', () => {
  const rule = linkEval()

  const warnsFor = async (children: unknown[]) => {
    const findings = await rule.run({
      doc: { body: richDoc(children) },
      collection: 'posts',
      req: {} as any,
      fields: [bodyField],
    })
    return findings.filter((f) => !f.ok && f.severity === 'warn')
  }

  it('warns on an empty url', async () => {
    expect(await warnsFor([paragraph([link('')])])).toHaveLength(1)
  })

  it('warns on a placeholder "#" url', async () => {
    expect(await warnsFor([paragraph([link('#')])])).toHaveLength(1)
  })

  it('warns on a malformed http URL', async () => {
    expect(await warnsFor([paragraph([link('http://')])])).toHaveLength(1)
  })

  it('does not warn on a valid https URL', async () => {
    expect(await warnsFor([paragraph([link('https://example.com/post')])])).toHaveLength(0)
  })

  it('ignores a non-link node', async () => {
    expect(await warnsFor([paragraph([text('just some text, no links here at all')])])).toHaveLength(0)
  })
})
