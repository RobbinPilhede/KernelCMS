import { describe, expect, it } from 'vitest'
import { KERNEL_EDITABLE_ATTR, KERNEL_PATH_ATTR, kernelEditable } from './editable'

describe('kernelEditable', () => {
  it('returns the data-kernel-path attribute for the given path', () => {
    expect(kernelEditable('hero.0.heading')).toEqual({ 'data-kernel-path': 'hero.0.heading' })
  })

  it('uses the exported attribute name', () => {
    expect(kernelEditable('x')[KERNEL_PATH_ATTR]).toBe('x')
  })

  it('stays path-only when called with no opts (back-compat)', () => {
    expect(kernelEditable('x')[KERNEL_EDITABLE_ATTR]).toBeUndefined()
  })

  it('marks the element editable as text by default when opting in', () => {
    expect(kernelEditable('x', {})).toEqual({ 'data-kernel-path': 'x', 'data-kernel-editable': 'text' })
  })

  it('honors an explicit type', () => {
    expect(kernelEditable('x', { type: 'number' })[KERNEL_EDITABLE_ATTR]).toBe('number')
  })

  it('omits the editable attribute when editable is false', () => {
    expect(kernelEditable('x', { editable: false })).toEqual({ 'data-kernel-path': 'x' })
  })
})
