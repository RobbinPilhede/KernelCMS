import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sqliteAdapter } from '@kernel/db-sqlite'
import { defineConfig, initKernel } from './index'
import type { AuditDoc, Kernel, KernelConfig } from './index'

function buildConfig(audit: KernelConfig['audit']): KernelConfig {
  return defineConfig({
    secret: 'audit-test-secret',
    db: sqliteAdapter({ url: ':memory:' }),
    audit,
    collections: [
      {
        slug: 'posts',
        versions: { drafts: true },
        access: { read: () => true, create: () => true, update: () => true, delete: () => true },
        fields: [
          { name: 'title', type: 'text' },
          { name: 'body', type: 'text' },
        ],
      },
    ],
  })
}

const actor = { user: { id: 'editor-1', collection: 'users' } } as const

describe('audit log (enabled)', () => {
  let kernel: Kernel

  beforeEach(async () => {
    kernel = await initKernel(buildConfig(true), { logLevel: 'error' })
    await kernel.migrate()
  })
  afterEach(async () => {
    await kernel.destroy()
  })

  it('records a create with action, collection, documentId, principal and fields', async () => {
    const post = await kernel.create({
      collection: 'posts',
      data: { title: 'Hello', body: 'World' },
      req: actor,
    })
    const { docs, count } = await kernel.findAuditLog({ where: { action: { equals: 'create' } } })
    expect(count).toBe(1)
    const row = docs[0] as AuditDoc
    expect(row.action).toBe('create')
    expect(row.collection).toBe('posts')
    expect(row.documentId).toBe(post.id)
    expect(row.principalId).toBe('editor-1')
    expect(row.principalType).toBe('user')
    expect(row.fields).toEqual(['title', 'body'])
  })

  it('records an update with the changed field names', async () => {
    const post = await kernel.create({ collection: 'posts', data: { title: 'A' }, req: actor })
    await kernel.update({ collection: 'posts', id: post.id, data: { body: 'changed' }, req: actor })
    const { docs } = await kernel.findAuditLog({ where: { action: { equals: 'update' } } })
    expect(docs).toHaveLength(1)
    expect(docs[0]!.documentId).toBe(post.id)
    expect(docs[0]!.fields).toEqual(['body'])
  })

  it('records a delete', async () => {
    const post = await kernel.create({ collection: 'posts', data: { title: 'gone' }, req: actor })
    await kernel.delete({ collection: 'posts', id: post.id, req: actor })
    const { docs } = await kernel.findAuditLog({ where: { action: { equals: 'delete' } } })
    expect(docs).toHaveLength(1)
    expect(docs[0]!.documentId).toBe(post.id)
    expect(docs[0]!.fields).toBeNull()
  })

  it('records publish as its own action (not update)', async () => {
    const post = await kernel.create({ collection: 'posts', data: { title: 'draft' }, req: actor })
    await kernel.publish({ collection: 'posts', id: post.id, req: actor })
    const { docs } = await kernel.findAuditLog({ where: { action: { equals: 'publish' } } })
    expect(docs).toHaveLength(1)
    expect(docs[0]!.documentId).toBe(post.id)
  })

  it('records system writes with principalType "system" under overrideAccess', async () => {
    const post = await kernel.create({ collection: 'posts', data: { title: 'sys' }, overrideAccess: true })
    const { docs } = await kernel.findAuditLog({ where: { documentId: { equals: post.id } } })
    expect(docs[0]!.principalType).toBe('system')
    expect(docs[0]!.principalId).toBeNull()
  })

  it('filters by collection, action, principal and date range', async () => {
    const a = await kernel.create({ collection: 'posts', data: { title: 'one' }, req: actor })
    await kernel.delete({ collection: 'posts', id: a.id, req: actor })

    const byCollection = await kernel.findAuditLog({ where: { collection: { equals: 'posts' } } })
    expect(byCollection.count).toBe(2)

    const byPrincipal = await kernel.findAuditLog({ where: { principalId: { equals: 'editor-1' } } })
    expect(byPrincipal.count).toBe(2)

    const future = new Date(Date.now() + 60_000).toISOString()
    const afterFuture = await kernel.findAuditLog({ where: { at: { greater_than_equal: future } } })
    expect(afterFuture.count).toBe(0)
  })

  it('returns entries newest-first by default', async () => {
    const a = await kernel.create({ collection: 'posts', data: { title: 'first' }, req: actor })
    const b = await kernel.create({ collection: 'posts', data: { title: 'second' }, req: actor })
    const { docs } = await kernel.findAuditLog({})
    expect(docs[0]!.documentId).toBe(b.id)
    expect(docs[1]!.documentId).toBe(a.id)
  })
})

describe('audit log (disabled by default)', () => {
  it('records nothing and findAuditLog returns empty', async () => {
    const kernel = await initKernel(buildConfig(undefined), { logLevel: 'error' })
    await kernel.migrate()
    await kernel.create({ collection: 'posts', data: { title: 'x' }, overrideAccess: true })
    const result = await kernel.findAuditLog({})
    expect(result).toEqual({ docs: [], count: 0 })
    await kernel.destroy()
  })

  it('does not provision the _audit table when disabled', async () => {
    const kernel = await initKernel(buildConfig({ enabled: false }), { logLevel: 'error' })
    expect(kernel.schema.tables.some((t) => t.table === '_audit')).toBe(false)
    await kernel.destroy()
  })

  it('provisions the _audit table when enabled', async () => {
    const kernel = await initKernel(buildConfig({ enabled: true }), { logLevel: 'error' })
    expect(kernel.schema.tables.some((t) => t.table === '_audit')).toBe(true)
    await kernel.destroy()
  })
})
