import { describe, expect, it } from 'vitest'
import { configTemplate, moduleTemplate, toSlug } from './templates'

describe('configTemplate', () => {
  it('scaffolds a runnable starter config', () => {
    const out = configTemplate()
    expect(out).toContain("import { defineConfig } from 'kernelcms'")
    expect(out).toContain("import { sqliteAdapter } from 'kernelcms/sqlite'")
    expect(out).toContain('export default defineConfig({')
    expect(out).toContain("slug: 'users'")
    expect(out).toContain('auth: true')
    expect(out).toContain("slug: 'posts'")
  })
})

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
