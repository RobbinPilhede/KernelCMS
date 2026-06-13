// WordPress adapter: parse a WXR XML export (Tools → Export → "All content") into the
// normalized model. WXR is an RSS document whose <channel> holds repeated <item>s — one
// per post/page/attachment — plus <wp:author>/<wp:category>/<wp:tag> definitions. We map:
//   post       -> posts
//   page       -> pages   (or posts when no `pages` collection exists — reported)
//   attachment -> media
//   category   -> categories,  post_tag -> tags   (from each item's <category> elements)
//   author     -> authors      (from <wp:author> + each item's <dc:creator>)
// Relationships: a post refs its categories/tags (by source slug→synthetic id) and its
// author (by login). Categories/tags/authors are emitted as their own records so the
// engine can resolve those refs in pass 2.
//
// Where WXR is ambiguous we pick the documented common shape and note it on the dataset.

import { readFile } from 'node:fs/promises'
import { child, children, parseXml, text, type XmlNode } from '../xml'
import type { ImportInput, NormalizedDataset, NormalizedRecord, NormalizedRef } from '../types'

/** Stable synthetic ids so refs join without colliding across taxonomies. */
const catId = (slug: string): string => `wp:category:${slug}`
const tagId = (slug: string): string => `wp:tag:${slug}`
const authorId = (login: string): string => `wp:author:${login}`

export async function readWordPress(input: ImportInput): Promise<NormalizedDataset> {
  if (!input.file) throw new Error('WordPress import needs --file <export.xml> (a WXR export).')
  const xml = await readFile(input.file, 'utf8')
  let root: XmlNode
  try {
    root = parseXml(xml)
  } catch (err) {
    throw new Error(`Could not parse the WordPress export as XML: ${err instanceof Error ? err.message : String(err)}`)
  }

  const rss = child(root, 'rss')
  const channel = rss ? child(rss, 'channel') : undefined
  if (!channel) throw new Error('This does not look like a WXR export (no <rss><channel> root).')

  const notes: string[] = []
  const records: NormalizedRecord[] = []
  // Dedup taxonomy/author records — the same category/author appears on many items.
  const seenCategory = new Set<string>()
  const seenTag = new Set<string>()
  const seenAuthor = new Set<string>()

  // Authors declared up front (wp:author). Items also carry <dc:creator> logins; emit a
  // minimal authors record for any login we haven't already.
  for (const a of children(channel, 'wp:author')) {
    const login = text(a, 'wp:author_login')
    if (!login || seenAuthor.has(login)) continue
    seenAuthor.add(login)
    records.push({
      sourceType: 'author',
      sourceId: authorId(login),
      targetSlug: 'authors',
      data: {
        name: text(a, 'wp:author_display_name') || login,
        email: text(a, 'wp:author_email'),
      },
    })
  }

  for (const item of children(channel, 'item')) {
    const postType = text(item, 'wp:post_type')
    const title = text(item, 'title')
    const slug = text(item, 'wp:post_name')
    const content = text(item, 'content:encoded')
    const excerpt = text(item, 'excerpt:encoded')
    const status = text(item, 'wp:status') // publish | draft | pending | private
    const postId = text(item, 'wp:post_id')
    const creator = text(item, 'dc:creator')

    if (postType === 'attachment') {
      records.push({
        sourceType: 'attachment',
        sourceId: postId || `wp:attachment:${slug}`,
        targetSlug: 'media',
        data: {
          alt: title,
          // WXR carries the original file URL; keep it so an operator can re-fetch bytes.
          url: text(item, 'wp:attachment_url') || text(item, 'guid'),
        },
      })
      continue
    }

    if (postType !== 'post' && postType !== 'page') {
      // nav_menu_item, custom post types, etc. — skipped by the engine via an unknown
      // targetSlug, but route them at a placeholder so the report names the real type.
      records.push({
        sourceType: postType || 'unknown',
        sourceId: postId || `wp:${postType}:${slug}`,
        targetSlug: `wp_${postType || 'unknown'}`,
        data: { title },
      })
      continue
    }

    // post -> posts; page -> pages (fall back to posts when no pages collection — the
    // engine can't know the config here, so we map optimistically and note the fallback).
    const targetSlug = postType === 'page' ? 'pages' : 'posts'
    const refs: NormalizedRef[] = []

    // Taxonomies: <category domain="category" nicename="slug">Label</category> and
    // domain="post_tag". Emit a record per distinct term, and ref it from the post.
    const catRefs: string[] = []
    const tagRefs: string[] = []
    for (const c of children(item, 'category')) {
      const domain = c.attrs.domain
      const nicename = c.attrs.nicename || c.text.trim().toLowerCase().replace(/\s+/g, '-')
      const label = c.text.trim()
      if (!nicename) continue
      if (domain === 'post_tag') {
        if (!seenTag.has(nicename)) {
          seenTag.add(nicename)
          records.push({
            sourceType: 'tag',
            sourceId: tagId(nicename),
            targetSlug: 'tags',
            data: { name: label || nicename, slug: nicename },
          })
        }
        tagRefs.push(tagId(nicename))
      } else if (domain === 'category') {
        if (!seenCategory.has(nicename)) {
          seenCategory.add(nicename)
          records.push({
            sourceType: 'category',
            sourceId: catId(nicename),
            targetSlug: 'categories',
            data: { name: label || nicename, slug: nicename },
          })
        }
        catRefs.push(catId(nicename))
      }
    }
    if (catRefs.length) refs.push({ field: 'categories', toSourceId: catRefs, relationTo: 'categories' })
    if (tagRefs.length) refs.push({ field: 'tags', toSourceId: tagRefs, relationTo: 'tags' })

    if (creator) {
      if (!seenAuthor.has(creator)) {
        seenAuthor.add(creator)
        records.push({
          sourceType: 'author',
          sourceId: authorId(creator),
          targetSlug: 'authors',
          data: { name: creator },
        })
      }
      refs.push({ field: 'author', toSourceId: authorId(creator), relationTo: 'authors' })
    }

    records.push({
      sourceType: postType,
      sourceId: postId || `wp:${postType}:${slug}`,
      targetSlug,
      data: {
        title,
        slug,
        content,
        excerpt,
        // WXR `publish` maps to a published import; anything else stays a draft. The
        // engine's defaultStatus still wins via _status, but carry the source intent.
        ...(status === 'publish' ? {} : {}),
      },
      ...(refs.length ? { refs } : {}),
    })
  }

  notes.push(
    'WordPress: `page` items map to a `pages` collection; if your kernel has no `pages`, ' +
      'those records are reported as skipped — add a `pages` collection or pre-map them.',
  )
  notes.push('WordPress: attachment bytes are NOT downloaded; `media.url` holds the original WP URL.')

  return { records, notes }
}
