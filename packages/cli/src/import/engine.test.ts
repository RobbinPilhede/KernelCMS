import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig, initKernel } from '@kernel/core'
import type { Kernel } from '@kernel/core'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { formatImportReport, runImport } from './engine'
import type { NormalizedDataset } from './types'

// The engine writes through the real Local API against a real sqlite kernel — same as the
// verify harness, but asserted at unit granularity. Real dependencies over mocks (house rule).
let kernel: Kernel

beforeEach(async () => {
  const dbFile = join(mkdtempSync(join(tmpdir(), 'keng-')), 'e.db')
  const config = defineConfig({
    secret: 'verify-secret-32-characters-long!!',
    db: sqliteAdapter({ url: `file:${dbFile}` }),
    collections: [
      { slug: 'authors', fields: [{ name: 'name', type: 'text' }] },
      {
        slug: 'posts',
        fields: [
          { name: 'title', type: 'text' },
          { name: 'author', type: 'relationship', relationTo: 'authors' },
          { name: 'related', type: 'relationship', relationTo: 'posts', hasMany: true },
        ],
      },
    ],
  })
  kernel = await initKernel(config, { logLevel: 'error', autoMigrate: true })
})

afterEach(async () => {
  await kernel.destroy()
})

const count = (slug: string) => kernel.count({ collection: slug, overrideAccess: true })

describe('runImport — two-pass id mapping', () => {
  it('creates records then resolves a relationship to the new kernel id', async () => {
    const dataset: NormalizedDataset = {
      records: [
        { sourceType: 'authors', sourceId: 'a1', targetSlug: 'authors', data: { name: 'Ada' } },
        {
          sourceType: 'posts',
          sourceId: 'p1',
          targetSlug: 'posts',
          data: { title: 'Hello' },
          refs: [{ field: 'author', toSourceId: 'a1' }],
        },
      ],
    }
    const report = await runImport(kernel, dataset, { dryRun: false })
    expect(report.created).toEqual({ authors: 1, posts: 1 })
    expect(report.updated).toBe(1)

    const author = (await kernel.find({ collection: 'authors', overrideAccess: true })).docs[0]!
    const post = (await kernel.find({ collection: 'posts', overrideAccess: true })).docs[0]!
    expect(post.author).toBe(author.id) // resolved to the NEW id, not the source id
  })

  it('resolves a hasMany self-relation across imported records', async () => {
    const dataset: NormalizedDataset = {
      records: [
        { sourceType: 'posts', sourceId: 'p1', targetSlug: 'posts', data: { title: 'One' } },
        {
          sourceType: 'posts',
          sourceId: 'p2',
          targetSlug: 'posts',
          data: { title: 'Two' },
          refs: [{ field: 'related', toSourceId: ['p1'] }],
        },
      ],
    }
    await runImport(kernel, dataset, { dryRun: false })
    const p1 = (await kernel.find({ collection: 'posts', where: { title: { equals: 'One' } }, overrideAccess: true }))
      .docs[0]!
    const p2 = (await kernel.find({ collection: 'posts', where: { title: { equals: 'Two' } }, overrideAccess: true }))
      .docs[0]!
    expect(p2.related).toEqual([p1.id])
  })
})

describe('runImport — robustness', () => {
  it('skips unknown target types without failing the import', async () => {
    const dataset: NormalizedDataset = {
      records: [
        { sourceType: 'widgets', sourceId: 'w1', targetSlug: 'widgets', data: { title: 'x' } },
        { sourceType: 'authors', sourceId: 'a1', targetSlug: 'authors', data: { name: 'Ada' } },
      ],
    }
    const report = await runImport(kernel, dataset, { dryRun: false })
    expect(report.created).toEqual({ authors: 1 })
    expect(report.skipped).toHaveLength(1)
    expect(report.skipped[0]!.sourceType).toBe('widgets')
    expect(await count('authors')).toBe(1)
  })

  it('drops unknown source fields and reports them per slug', async () => {
    const dataset: NormalizedDataset = {
      records: [
        { sourceType: 'authors', sourceId: 'a1', targetSlug: 'authors', data: { name: 'Ada', bogus: 1, junk: 2 } },
      ],
    }
    const report = await runImport(kernel, dataset, { dryRun: false })
    expect(report.droppedFields.authors).toEqual(['bogus', 'junk'])
    const author = (await kernel.find({ collection: 'authors', overrideAccess: true })).docs[0]!
    expect(author.bogus).toBeUndefined()
    expect(author.name).toBe('Ada')
  })

  it('reports dangling refs (no matching imported record) without throwing', async () => {
    const dataset: NormalizedDataset = {
      records: [
        {
          sourceType: 'posts',
          sourceId: 'p1',
          targetSlug: 'posts',
          data: { title: 'Orphan' },
          refs: [{ field: 'author', toSourceId: 'missing-author' }],
        },
      ],
    }
    const report = await runImport(kernel, dataset, { dryRun: false })
    expect(report.danglingRefs).toBe(1)
    expect(report.updated).toBe(0) // nothing resolved -> no update issued
  })
})

describe('runImport — dry-run writes nothing', () => {
  it('produces a full report but issues zero writes', async () => {
    const dataset: NormalizedDataset = {
      records: [
        { sourceType: 'authors', sourceId: 'a1', targetSlug: 'authors', data: { name: 'Ada' } },
        {
          sourceType: 'posts',
          sourceId: 'p1',
          targetSlug: 'posts',
          data: { title: 'Hello', bogus: 1 },
          refs: [{ field: 'author', toSourceId: 'a1' }],
        },
      ],
    }
    const report = await runImport(kernel, dataset, { dryRun: true })
    expect(report.dryRun).toBe(true)
    expect(report.created).toEqual({ authors: 1, posts: 1 }) // would-create counts populated
    expect(report.updated).toBe(1) // would-resolve the ref
    expect(report.droppedFields.posts).toEqual(['bogus'])
    expect(await count('authors')).toBe(0) // NOTHING written
    expect(await count('posts')).toBe(0)
  })
})

describe('runImport — prototype pollution guard', () => {
  it('never lets a __proto__ source key reach Object.prototype', async () => {
    // A real own __proto__ key as a JSON payload would carry it (not the JS literal).
    const malicious = JSON.parse('{"name":"Ada","__proto__":{"polluted":true},"constructor":"x"}')
    const dataset: NormalizedDataset = {
      records: [{ sourceType: 'authors', sourceId: 'a1', targetSlug: 'authors', data: malicious }],
    }
    await runImport(kernel, dataset, { dryRun: false })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    const author = (await kernel.find({ collection: 'authors', overrideAccess: true })).docs[0]!
    expect(author.name).toBe('Ada')
  })
})

describe('formatImportReport', () => {
  it('leads with a prominent DRY RUN banner on a preview', () => {
    const out = formatImportReport({
      source: 'sanity',
      dryRun: true,
      created: { posts: 3 },
      updated: 1,
      skipped: [],
      droppedFields: {},
      danglingRefs: 0,
      errors: [],
    })
    expect(out).toContain('DRY RUN')
    expect(out).toContain('--apply')
    expect(out).toContain('posts: 3')
  })

  it('surfaces dangling refs and dropped fields on an applied import', () => {
    const out = formatImportReport({
      source: 'payload',
      dryRun: false,
      created: { posts: 1 },
      updated: 0,
      skipped: [{ sourceType: 'menu', reason: 'No collection "menu".' }],
      droppedFields: { posts: ['extra'] },
      danglingRefs: 2,
      errors: [],
    })
    expect(out).toContain('Imported 1 document')
    expect(out).toContain('dangling')
    expect(out).toContain('extra')
    expect(out).toContain('menu')
  })
})
