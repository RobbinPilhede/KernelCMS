import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readWordPress } from './adapters/wordpress'
import { readContentful } from './adapters/contentful'
import { readSanity } from './adapters/sanity'
import { readStrapi } from './adapters/strapi'
import { readPayload } from './adapters/payload'
import type { NormalizedRecord } from './types'

/** Write `content` to a throwaway temp file and return its path. */
function tmpFile(name: string, content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'kimport-')), name)
  writeFileSync(path, content, 'utf8')
  return path
}

const byType = (records: NormalizedRecord[], type: string) => records.filter((r) => r.sourceType === type)

describe('wordpress adapter (WXR)', () => {
  const wxr = `<?xml version="1.0"?>
<rss xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <wp:author><wp:author_login><![CDATA[jane]]></wp:author_login><wp:author_display_name><![CDATA[Jane]]></wp:author_display_name></wp:author>
    <item>
      <title><![CDATA[Post One]]></title>
      <dc:creator><![CDATA[jane]]></dc:creator>
      <content:encoded><![CDATA[<p>Body &amp; more</p>]]></content:encoded>
      <wp:post_id>1</wp:post_id>
      <wp:post_name><![CDATA[post-one]]></wp:post_name>
      <wp:post_type><![CDATA[post]]></wp:post_type>
      <category domain="category" nicename="news"><![CDATA[News]]></category>
      <category domain="post_tag" nicename="hot"><![CDATA[Hot]]></category>
    </item>
    <item>
      <title><![CDATA[A Page]]></title>
      <wp:post_id>2</wp:post_id>
      <wp:post_name><![CDATA[a-page]]></wp:post_name>
      <wp:post_type><![CDATA[page]]></wp:post_type>
    </item>
  </channel>
</rss>`

  it('maps post/page and extracts taxonomy + author records', async () => {
    const { records } = await readWordPress({ file: tmpFile('wp.xml', wxr) })
    expect(byType(records, 'post')).toHaveLength(1)
    expect(byType(records, 'page')).toHaveLength(1)
    expect(byType(records, 'author')).toHaveLength(1)
    expect(byType(records, 'category')).toHaveLength(1)
    expect(byType(records, 'tag')).toHaveLength(1)
  })

  it('carries author + category + tag relations on the post (by source id)', async () => {
    const { records } = await readWordPress({ file: tmpFile('wp.xml', wxr) })
    const post = byType(records, 'post')[0]!
    expect(post.targetSlug).toBe('posts')
    const fields = (post.refs ?? []).map((r) => r.field).sort()
    expect(fields).toEqual(['author', 'categories', 'tags'])
    const author = post.refs!.find((r) => r.field === 'author')!
    expect(author.toSourceId).toBe('wp:author:jane')
  })

  it('preserves CDATA HTML verbatim (real WXR double-encodes entities inside CDATA)', async () => {
    const { records } = await readWordPress({ file: tmpFile('wp.xml', wxr) })
    expect(byType(records, 'post')[0]!.data.content).toBe('<p>Body &amp; more</p>')
  })

  it('rejects a non-WXR document with a clear error', async () => {
    await expect(readWordPress({ file: tmpFile('x.xml', '<html><body>no</body></html>') })).rejects.toThrow(/WXR/)
  })
})

describe('contentful adapter', () => {
  const exp = JSON.stringify({
    locales: [{ code: 'en-US', default: true }, { code: 'de-DE' }],
    entries: [
      {
        sys: { id: 'a1', contentType: { sys: { id: 'authors' } } },
        fields: { name: { 'en-US': 'Ada', 'de-DE': 'Ada-de' } },
      },
      {
        sys: { id: 'p1', contentType: { sys: { id: 'posts' } } },
        fields: {
          title: { 'en-US': 'T' },
          author: { 'en-US': { sys: { type: 'Link', linkType: 'Entry', id: 'a1' } } },
          tags: { 'en-US': [{ sys: { type: 'Link', linkType: 'Entry', id: 'a1' } }] },
        },
      },
    ],
  })

  it('maps contentType id to slug and unwraps the default locale', async () => {
    const { records } = await readContentful({ file: tmpFile('cf.json', exp) })
    const author = records.find((r) => r.sourceId === 'a1')!
    expect(author.targetSlug).toBe('authors')
    expect(author.data.name).toBe('Ada') // en-US, not de-DE
  })

  it('turns single + array Link fields into refs', async () => {
    const { records } = await readContentful({ file: tmpFile('cf.json', exp) })
    const post = records.find((r) => r.sourceId === 'p1')!
    const author = post.refs!.find((r) => r.field === 'author')!
    expect(author.toSourceId).toBe('a1')
    const tags = post.refs!.find((r) => r.field === 'tags')!
    expect(tags.toSourceId).toEqual(['a1'])
  })
})

describe('sanity adapter (NDJSON)', () => {
  const ndjson = [
    JSON.stringify({ _type: 'authors', _id: 'a1', name: 'Grace' }),
    JSON.stringify({ _type: 'posts', _id: 'drafts.p1', title: 'T', author: { _type: 'reference', _ref: 'a1' } }),
    JSON.stringify({ _type: 'sanity.imageAsset', _id: 'img1', url: 'x' }),
    '',
  ].join('\n')

  it('maps _type to slug, strips drafts. prefix, resolves _ref, skips sanity.* docs', async () => {
    const { records } = await readSanity({ file: tmpFile('s.ndjson', ndjson) })
    expect(records).toHaveLength(2) // system doc skipped
    const post = records.find((r) => r.targetSlug === 'posts')!
    expect(post.sourceId).toBe('p1') // drafts. stripped
    expect(post.refs![0]!.toSourceId).toBe('a1')
  })

  it('reports the line number on malformed NDJSON', async () => {
    await expect(readSanity({ file: tmpFile('bad.ndjson', '{"_type":"x","_id":"1"}\n{not json}') })).rejects.toThrow(
      /line 2/,
    )
  })
})

describe('strapi adapter', () => {
  it('maps uid to its last segment and resolves {data:{id}} relations (object shape)', async () => {
    const exp = JSON.stringify({
      'api::author.author': [{ id: 1, name: 'Linus' }],
      'api::article.article': [{ id: 10, title: 'T', author: { data: { id: 1 } } }],
    })
    const { records } = await readStrapi({ file: tmpFile('st.json', exp) })
    const article = records.find((r) => r.targetSlug === 'article')!
    expect(article.refs![0]!.toSourceId).toBe('1')
    expect(records.find((r) => r.targetSlug === 'author')).toBeTruthy()
  })

  it('handles the flat __contentType array shape', async () => {
    const exp = JSON.stringify([{ __contentType: 'api::tag.tag', id: 5, name: 'go' }])
    const { records } = await readStrapi({ file: tmpFile('st2.json', exp) })
    expect(records[0]!.targetSlug).toBe('tag')
    expect(records[0]!.data.name).toBe('go')
  })

  it('errors clearly when neither --file nor --url is given', async () => {
    await expect(readStrapi({})).rejects.toThrow(/--file/)
  })
})

describe('payload adapter', () => {
  it('handles the array-of-{slug,docs} shape and resolves populated relations', async () => {
    const exp = JSON.stringify([
      { slug: 'authors', docs: [{ id: 'a1', name: 'Meg' }] },
      { slug: 'posts', docs: [{ id: 'p1', title: 'T', author: { id: 'a1' } }] },
    ])
    const { records } = await readPayload({ file: tmpFile('pl.json', exp) })
    const post = records.find((r) => r.targetSlug === 'posts')!
    expect(post.refs![0]!.toSourceId).toBe('a1')
  })

  it('resolves a polymorphic {relationTo,value} relation and a hasMany array', async () => {
    const exp = JSON.stringify({
      posts: [{ id: 'p1', owner: { relationTo: 'authors', value: 'a1' }, tags: [{ id: 't1' }, { id: 't2' }] }],
    })
    const { records } = await readPayload({ file: tmpFile('pl2.json', exp) })
    const post = records[0]!
    const owner = post.refs!.find((r) => r.field === 'owner')!
    expect(owner.relationTo).toBe('authors')
    expect(owner.toSourceId).toBe('a1')
    const tags = post.refs!.find((r) => r.field === 'tags')!
    expect(tags.toSourceId).toEqual(['t1', 't2'])
  })
})
