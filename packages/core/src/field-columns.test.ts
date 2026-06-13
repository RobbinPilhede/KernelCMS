import { describe, expect, it } from 'vitest'
import { columnForField } from './fields'
import type { AnyField } from './types'

describe('columnForField indexing', () => {
  it('auto-indexes a single-target relationship column', () => {
    const field: AnyField = { name: 'author', type: 'relationship', relationTo: 'authors' }
    const col = columnForField(field)
    expect(col.indexed).toBe(true)
    expect(col.unique).toBe(false)
    expect(col.relationTo).toBe('authors')
  })

  it('auto-indexes an upload column', () => {
    const field: AnyField = { name: 'avatar', type: 'upload', relationTo: 'media' }
    expect(columnForField(field).indexed).toBe(true)
  })

  it('auto-indexes a hasMany/polymorphic relationship column', () => {
    const field: AnyField = { name: 'tags', type: 'relationship', relationTo: ['tags', 'topics'], hasMany: true }
    expect(columnForField(field).indexed).toBe(true)
  })

  it('respects an explicit index:false opt-out on a relationship', () => {
    const field: AnyField = { name: 'author', type: 'relationship', relationTo: 'authors', index: false }
    expect(columnForField(field).indexed).toBe(false)
  })

  it('does not auto-index a plain text column', () => {
    const field: AnyField = { name: 'title', type: 'text' }
    expect(columnForField(field).indexed).toBe(false)
  })

  it('keeps indexing a unique non-relationship column', () => {
    const field: AnyField = { name: 'slug', type: 'slug', unique: true }
    const col = columnForField(field)
    expect(col.indexed).toBe(true)
    expect(col.unique).toBe(true)
  })

  it('honors an explicit index:true on a non-relationship column', () => {
    const field: AnyField = { name: 'status', type: 'text', index: true }
    expect(columnForField(field).indexed).toBe(true)
  })
})
