import { describe, expect, it } from 'vitest'
import { resolvePathPrefixes } from './views'

describe('resolvePathPrefixes', () => {
  it('expands a nested field path to longest-first prefixes', () => {
    expect(resolvePathPrefixes('layout.0.heading')).toEqual(['layout.0.heading', 'layout.0', 'layout'])
  })

  it('expands a block-row path to the row then the field', () => {
    expect(resolvePathPrefixes('layout.0')).toEqual(['layout.0', 'layout'])
  })

  it('returns a single-segment path unchanged', () => {
    expect(resolvePathPrefixes('title')).toEqual(['title'])
  })
})
