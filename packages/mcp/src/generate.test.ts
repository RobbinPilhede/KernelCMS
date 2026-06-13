import { describe, expect, it } from 'vitest'
import { defineConfig, describeConfig, sanitizeConfig } from '@kernel/core'
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
  it('emits list/get/create/update/delete for each visible collection and get/update for globals', () => {
    const names = generateTools(sampleSchema()).map((t) => t.name)
    expect(names).toEqual([
      'posts_list',
      'posts_get',
      'posts_create',
      'posts_update',
      'posts_delete',
      'settings_get_global',
      'settings_update_global',
    ])
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
