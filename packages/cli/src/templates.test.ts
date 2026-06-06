import { describe, expect, it } from 'vitest'
import { moduleTemplate, toSlug } from './templates'

describe('toSlug', () => {
  it('normalizes names to snake_case', () => {
    expect(toSlug('Comments')).toBe('comments')
    expect(toSlug('blogPosts')).toBe('blog_posts')
    expect(toSlug('Blog Posts')).toBe('blog_posts')
    expect(toSlug('blog-posts')).toBe('blog_posts')
  })
})

describe('moduleTemplate', () => {
  it('scaffolds a valid defineModule slice', () => {
    const out = moduleTemplate('blogPosts')
    expect(out).toContain("import { defineModule, defineEndpoint } from 'kernelcms'")
    expect(out).toContain('export const blogPostsModule = defineModule({')
    expect(out).toContain("name: 'blog_posts'")
    expect(out).toContain("slug: 'blog_posts'")
    expect(out).toContain("path: '/blog_posts/ping'")
    expect(out).toContain('defineEndpoint({')
  })
})
