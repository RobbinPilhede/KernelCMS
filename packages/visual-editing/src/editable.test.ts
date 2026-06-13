import { describe, expect, it } from 'vitest'
import { KERNEL_PATH_ATTR, kernelEditable } from './editable'

describe('kernelEditable', () => {
  it('returns the data-kernel-path attribute for the given path', () => {
    expect(kernelEditable('hero.0.heading')).toEqual({ 'data-kernel-path': 'hero.0.heading' })
  })

  it('uses the exported attribute name', () => {
    expect(kernelEditable('x')[KERNEL_PATH_ATTR]).toBe('x')
  })
})
