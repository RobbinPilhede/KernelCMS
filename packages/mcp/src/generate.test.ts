import { describe, expect, it } from 'vitest'
import { defineConfig, defineEndpoint, describeConfig, sanitizeConfig } from '@kernel/core'
import type { EndpointConfig } from '@kernel/core'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { generateTools } from './generate'

// A config with one visible collection, one hidden collection, one auth collection,
// and one global — to pin down exactly which tools appear on the agent surface.
function sampleSchema() {
  const config = sanitizeConfig(
    defineConfig({
      secret: 'test-secret',
      db: sqliteAdapter({ url: ':memory:' }),
      collections: [
        {
          slug: 'posts',
          versions: { drafts: true },
          fields: [
            { name: 'title', type: 'text', required: true },
            { name: 'body', type: 'text' },
          ],
        },
        // Hidden: must never produce tools.
        { slug: 'secrets', admin: { hidden: true }, fields: [{ name: 'value', type: 'text' }] },
        // Auth: must never produce tools (no user/credential CRUD for agents).
        { slug: 'users', auth: true, fields: [{ name: 'name', type: 'text' }] },
      ],
      globals: [{ slug: 'settings', fields: [{ name: 'site_name', type: 'text' }] }],
    }),
  )
  return describeConfig(config)
}

describe('generateTools', () => {
  it('emits list/get/count/versions/create/update/delete for each visible collection and get/update for globals', () => {
    const names = generateTools(sampleSchema()).map((t) => t.name)
    expect(names).toEqual([
      'posts_list',
      'posts_get',
      'posts_count',
      // posts has versions enabled → a versions tool appears.
      'posts_versions',
      'posts_create',
      'posts_update',
      'posts_delete',
      'settings_get_global',
      'settings_update_global',
    ])
  })

  it('omits the versions tool for collections without a version history', () => {
    const config = sanitizeConfig(
      defineConfig({
        secret: 'test-secret',
        db: sqliteAdapter({ url: ':memory:' }),
        collections: [{ slug: 'tags', fields: [{ name: 'name', type: 'text' }] }],
      }),
    )
    const names = generateTools(describeConfig(config)).map((t) => t.name)
    expect(names).toContain('tags_count')
    expect(names).not.toContain('tags_versions')
  })

  it('annotates read tools read-only, delete destructive, and create non-idempotent', () => {
    const tools = generateTools(sampleSchema())
    const byName = (n: string) => tools.find((t) => t.name === n)
    expect(byName('posts_list')?.annotations.readOnlyHint).toBe(true)
    expect(byName('posts_count')?.annotations.readOnlyHint).toBe(true)
    expect(byName('posts_versions')?.annotations.readOnlyHint).toBe(true)
    expect(byName('settings_get_global')?.annotations.readOnlyHint).toBe(true)
    expect(byName('posts_delete')?.annotations.destructiveHint).toBe(true)
    expect(byName('posts_delete')?.annotations.idempotentHint).toBe(true)
    expect(byName('posts_update')?.annotations.idempotentHint).toBe(true)
    // Create yields a new doc per call — not idempotent.
    expect(byName('posts_create')?.annotations.idempotentHint ?? false).toBe(false)
    // Every tool carries a friendly title.
    expect(tools.every((t) => typeof t.annotations.title === 'string' && t.annotations.title.length > 0)).toBe(true)
  })

  it('exposes ONLY endpoints flagged mcp:true, named from the summary, with params + free-form body', () => {
    const endpoints: EndpointConfig[] = [
      defineEndpoint({
        method: 'POST',
        path: '/posts/:id/publish',
        summary: 'Publish post',
        mcp: true,
        input: { body: { parse: (v) => v } },
        access: () => true,
        handler: () => ({ ok: true }),
      }),
      // No mcp flag → must NOT be exposed.
      defineEndpoint({
        method: 'POST',
        path: '/internal/reindex',
        access: () => true,
        handler: () => ({ ok: true }),
      }),
    ]
    const tools = generateTools(sampleSchema(), endpoints)
    const ep = tools.find((t) => t.op === 'invokeEndpoint')
    expect(ep?.name).toBe('publish_post')
    expect(tools.some((t) => t.name.includes('reindex'))).toBe(false)
    const schema = ep?.inputSchema as { properties: Record<string, unknown>; required?: string[] }
    expect(Object.keys(schema.properties)).toEqual(['id', 'body'])
    expect(schema.required).toEqual(['id'])
    expect(schema.properties.body).toEqual({ type: 'object', description: expect.any(String) })
  })

  it('falls back to a method_path name when an endpoint has no summary', () => {
    const endpoints: EndpointConfig[] = [
      defineEndpoint({ method: 'GET', path: '/health', mcp: true, access: () => true, handler: () => 'ok' }),
    ]
    const tools = generateTools(sampleSchema(), endpoints)
    expect(tools.find((t) => t.op === 'invokeEndpoint')?.name).toBe('get_health')
  })

  it('skips hidden and auth collections entirely', () => {
    const names = generateTools(sampleSchema()).map((t) => t.name)
    expect(names.some((n) => n.startsWith('secrets_'))).toBe(false)
    expect(names.some((n) => n.startsWith('users_'))).toBe(false)
  })

  it('maps create input from collection fields with required carried through', () => {
    const create = generateTools(sampleSchema()).find((t) => t.name === 'posts_create')
    expect(create?.op).toBe('create')
    const schema = create?.inputSchema as { properties: Record<string, unknown>; required?: string[] }
    expect(Object.keys(schema.properties)).toEqual(['title', 'body'])
    expect(schema.required).toEqual(['title'])
  })

  it('makes id required on get/update/delete and all data optional on update', () => {
    const tools = generateTools(sampleSchema())
    const get = tools.find((t) => t.name === 'posts_get')?.inputSchema as { required?: string[] }
    const update = tools.find((t) => t.name === 'posts_update')?.inputSchema as {
      required?: string[]
      properties: Record<string, unknown>
    }
    expect(get.required).toEqual(['id'])
    expect(update.required).toEqual(['id'])
    expect(Object.keys(update.properties)).toContain('title')
  })
})
