import { describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { defineConfig, describeConfig, sanitizeConfig } from './index'

function base() {
  return {
    secret: 'test-secret',
    db: sqliteAdapter({ url: ':memory:' }),
    collections: [{ slug: 'posts', access: { read: () => true }, fields: [{ name: 'title', type: 'text' as const }] }],
  }
}

describe('attribution', () => {
  it('defaults the "Powered by" credit on', () => {
    const schema = describeConfig(sanitizeConfig(defineConfig(base())))
    expect(schema.attribution).toBe(true)
  })

  it('can be opted out', () => {
    const schema = describeConfig(sanitizeConfig(defineConfig({ ...base(), attribution: false })))
    expect(schema.attribution).toBe(false)
  })
})
