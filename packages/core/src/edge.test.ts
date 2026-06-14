import { describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { initKernel, type Kernel } from './index'
import {
  cacheTags,
  cacheTagsHeader,
  clampPurgeLimit,
  computePurge,
  purgeTagsForEvent,
  sanitizeTag,
  DEFAULT_PURGE_LIMIT,
  MAX_PURGE_LIMIT,
} from './edge'
import { sanitizeConfig } from './config'
import type { ChangeEvent, KernelConfig, SanitizedConfig } from './types'

// ---------------------------------------------------------------------------
// Pure helpers — tag sanitization, header building, clamps
// ---------------------------------------------------------------------------

describe('sanitizeTag — CDN-safe tokens (no header injection)', () => {
  it('keeps safe token chars and strips spaces / newlines / control chars', () => {
    expect(sanitizeTag('posts')).toBe('posts')
    expect(sanitizeTag('posts:abc-123')).toBe('posts:abc-123')
    // A space-or-newline injection attempt is stripped to a single token.
    expect(sanitizeTag('posts evil')).toBe('postsevil')
    expect(sanitizeTag('posts\nSet-Cookie: x')).toBe('postsSet-Cookie:x'.replace(' ', ''))
    expect(sanitizeTag('a\r\nb')).toBe('ab')
    expect(sanitizeTag('tab\there')).toBe('tabhere')
  })

  it('returns empty string for null/undefined/empty', () => {
    expect(sanitizeTag(null)).toBe('')
    expect(sanitizeTag(undefined)).toBe('')
    expect(sanitizeTag('')).toBe('')
  })
})

describe('cacheTagsHeader — sanitized, space-joined, de-duped', () => {
  it('joins sanitized tags with a single space and drops dupes/empties', () => {
    expect(cacheTagsHeader(['posts', 'posts:1', 'posts'])).toBe('posts posts:1')
    expect(cacheTagsHeader(['posts', '', 'authors:9'])).toBe('posts authors:9')
  })

  it('strips header-injection attempts inside a tag', () => {
    expect(cacheTagsHeader(['posts evil', 'a\nb'])).toBe('postsevil ab')
  })
})

describe('clampPurgeLimit', () => {
  it('defaults, clamps, and floors a hostile limit', () => {
    expect(clampPurgeLimit(undefined)).toBe(DEFAULT_PURGE_LIMIT)
    expect(clampPurgeLimit(0)).toBe(1)
    expect(clampPurgeLimit(-5)).toBe(1)
    expect(clampPurgeLimit(10_000_000)).toBe(MAX_PURGE_LIMIT)
    expect(clampPurgeLimit(50)).toBe(50)
    expect(clampPurgeLimit(Number.NaN)).toBe(DEFAULT_PURGE_LIMIT)
  })
})

// ---------------------------------------------------------------------------
// cacheTags — against a sanitized config (relationships + sanitization)
// ---------------------------------------------------------------------------

function makeSanitized(includeRelationships = true): SanitizedConfig {
  const config: KernelConfig = {
    secret: 'edge-test-secret-aaaaaaaaaaaaaaaa',
    db: sqliteAdapter({ url: ':memory:' }),
    edge: { enabled: true, cacheControl: 'public, s-maxage=600', includeRelationships },
    realtime: { enabled: true },
    collections: [
      {
        slug: 'authors',
        access: { read: () => true },
        fields: [{ name: 'name', type: 'text' }],
      },
      {
        slug: 'posts',
        access: { read: () => true },
        fields: [
          { name: 'title', type: 'text' },
          { name: 'author', type: 'relationship', relationTo: 'authors' },
          { name: 'tags', type: 'relationship', relationTo: 'authors', hasMany: true },
        ],
      },
    ],
  }
  return sanitizeConfig(config)
}

describe('cacheTags — collection + doc + relationship target tags', () => {
  it('returns own + collection + relationship-target tags for a single doc', () => {
    const config = makeSanitized(true)
    const tags = cacheTags(config, {
      collection: 'posts',
      id: 'p1',
      doc: { id: 'p1', title: 'Hi', author: 'a1' },
    })
    expect(tags).toEqual(['posts', 'posts:p1', 'authors:a1'])
  })

  it('includes EACH hasMany relationship target', () => {
    const config = makeSanitized(true)
    const tags = cacheTags(config, {
      collection: 'posts',
      id: 'p1',
      doc: { id: 'p1', author: 'a1', tags: ['a2', 'a3'] },
    })
    expect(tags).toEqual(['posts', 'posts:p1', 'authors:a1', 'authors:a2', 'authors:a3'])
  })

  it('reduces a POPULATED relationship (resolved doc object) to its id', () => {
    const config = makeSanitized(true)
    const tags = cacheTags(config, {
      collection: 'posts',
      id: 'p1',
      doc: { id: 'p1', author: { id: 'a1', name: 'Ada' } },
    })
    expect(tags).toEqual(['posts', 'posts:p1', 'authors:a1'])
  })

  it('omits relationship tags when includeRelationships is false', () => {
    const config = makeSanitized(false)
    const tags = cacheTags(config, {
      collection: 'posts',
      id: 'p1',
      doc: { id: 'p1', author: 'a1' },
    })
    expect(tags).toEqual(['posts', 'posts:p1'])
  })

  it('a list response yields the collection tag + each doc tag (no relation expansion)', () => {
    const config = makeSanitized(true)
    const tags = cacheTags(config, {
      collection: 'posts',
      docs: [
        { id: 'p1', author: 'a1' },
        { id: 'p2', author: 'a2' },
      ],
    })
    expect(tags).toEqual(['posts', 'posts:p1', 'posts:p2'])
  })

  it('sanitizes a hostile document id into a safe token (no injection)', () => {
    const config = makeSanitized(false)
    const tags = cacheTags(config, { collection: 'posts', id: 'p1 evil\nX' })
    expect(tags).toEqual(['posts', 'posts:p1evilX'])
  })

  it('returns [] for an unknown collection', () => {
    const config = makeSanitized(true)
    expect(cacheTags(config, { collection: 'nope', id: 'x' })).toEqual([])
  })
})

describe('purgeTagsForEvent — doc + collection tags for one change', () => {
  it('maps a change event to its doc + collection tags', () => {
    const event: ChangeEvent = {
      seq: 1,
      at: '2026-01-01T00:00:00.000Z',
      collection: 'posts',
      documentId: 'p1',
      event: 'update',
      principalType: 'user',
    }
    expect(purgeTagsForEvent(event)).toEqual(['posts', 'posts:p1'])
  })
})

// ---------------------------------------------------------------------------
// purgeFeed — mapping, de-dupe, cursor advance, reverse-refs (real kernel)
// ---------------------------------------------------------------------------

const open = { read: () => true, create: () => true, update: () => true, delete: () => true }

function makeKernel(opts?: { edge?: boolean; realtime?: boolean; includeRelationships?: boolean }): Promise<Kernel> {
  return initKernel(
    {
      secret: 'edge-kernel-secret-aaaaaaaaaaaaaa',
      db: sqliteAdapter({ url: ':memory:' }),
      ...(opts?.realtime === false ? {} : { realtime: { enabled: true } }),
      ...(opts?.edge === false
        ? {}
        : {
            edge: {
              enabled: true,
              cacheControl: 'public, s-maxage=600',
              includeRelationships: opts?.includeRelationships ?? true,
            },
          }),
      collections: [
        { slug: 'authors', access: open, fields: [{ name: 'name', type: 'text' }] },
        {
          slug: 'posts',
          access: open,
          fields: [
            { name: 'title', type: 'text' },
            { name: 'author', type: 'relationship', relationTo: 'authors' },
          ],
        },
      ],
    },
    { autoMigrate: true, logLevel: 'error' },
  )
}

describe('purgeFeed — derived from the change feed', () => {
  it("returns the changed doc's tags (+ collection) and advances the cursor", async () => {
    const kernel = await makeKernel()
    const post = await kernel.create({ collection: 'posts', data: { title: 'A' }, overrideAccess: true })

    const first = await kernel.purgeFeed({ since: 0 })
    expect(first.tags).toContain('posts')
    expect(first.tags).toContain(`posts:${post.id}`)
    expect(first.cursor).toBeGreaterThan(0)

    // A second change advances the cursor past the first.
    await kernel.update({ collection: 'posts', id: post.id, data: { title: 'B' }, overrideAccess: true })
    const second = await kernel.purgeFeed({ since: first.cursor })
    expect(second.cursor).toBeGreaterThan(first.cursor)
    expect(second.tags).toContain(`posts:${post.id}`)
    await kernel.destroy()
  })

  it('de-dupes tags across repeated changes to the same doc', async () => {
    const kernel = await makeKernel({ includeRelationships: false })
    const post = await kernel.create({ collection: 'posts', data: { title: 'A' }, overrideAccess: true })
    await kernel.update({ collection: 'posts', id: post.id, data: { title: 'B' }, overrideAccess: true })
    await kernel.update({ collection: 'posts', id: post.id, data: { title: 'C' }, overrideAccess: true })
    const result = await kernel.purgeFeed({ since: 0 })
    // Exactly one collection tag + one doc tag despite three changes.
    expect(result.tags.filter((t) => t === 'posts')).toHaveLength(1)
    expect(result.tags.filter((t) => t === `posts:${post.id}`)).toHaveLength(1)
    await kernel.destroy()
  })

  it('includes the tags of docs that REFERENCE a changed doc (reverse-ref purge)', async () => {
    const kernel = await makeKernel({ includeRelationships: true })
    const author = await kernel.create({ collection: 'authors', data: { name: 'Ada' }, overrideAccess: true })
    const post = await kernel.create({
      collection: 'posts',
      data: { title: 'Has author', author: author.id },
      overrideAccess: true,
    })
    const before = await kernel.purgeFeed({ since: 0 })
    // Changing the AUTHOR should purge the referencing POST's tag too.
    await kernel.update({ collection: 'authors', id: author.id, data: { name: 'Ada L.' }, overrideAccess: true })
    const after = await kernel.purgeFeed({ since: before.cursor })
    expect(after.tags).toContain(`authors:${author.id}`)
    expect(after.tags).toContain(`posts:${post.id}`)
    await kernel.destroy()
  })

  it('is empty when edge delivery is disabled', async () => {
    const kernel = await makeKernel({ edge: false })
    await kernel.create({ collection: 'posts', data: { title: 'A' }, overrideAccess: true })
    const result = await kernel.purgeFeed({ since: 0 })
    expect(result.tags).toEqual([])
    await kernel.destroy()
  })

  it('is empty when realtime is disabled (no change feed to derive from)', async () => {
    const kernel = await makeKernel({ realtime: false })
    await kernel.create({ collection: 'posts', data: { title: 'A' }, overrideAccess: true })
    const result = await kernel.purgeFeed({ since: 0 })
    expect(result.tags).toEqual([])
    await kernel.destroy()
  })
})

describe('cacheTags via kernel — gated on edge.enabled', () => {
  it('returns tags when edge is on', async () => {
    const kernel = await makeKernel()
    const tags = kernel.cacheTags({ collection: 'posts', id: 'p1' })
    expect(tags).toEqual(['posts', 'posts:p1'])
    await kernel.destroy()
  })

  it('returns [] when edge is off', async () => {
    const kernel = await makeKernel({ edge: false })
    expect(kernel.cacheTags({ collection: 'posts', id: 'p1' })).toEqual([])
    await kernel.destroy()
  })
})

describe('computePurge — direct (without realtime) no-ops', () => {
  it('returns the since cursor unchanged when realtime is off', async () => {
    const config = sanitizeConfig({
      secret: 'edge-test-secret-bbbbbbbbbbbbbbbb',
      db: sqliteAdapter({ url: ':memory:' }),
      edge: { enabled: true },
      collections: [{ slug: 'posts', access: open, fields: [{ name: 'title', type: 'text' }] }],
    })
    const result = await computePurge(config, config.db, { since: 7 })
    expect(result).toEqual({ tags: [], cursor: 7 })
  })
})
