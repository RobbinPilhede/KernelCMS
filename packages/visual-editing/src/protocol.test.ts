import { describe, expect, it } from 'vitest'
import { isPreviewDataMessage, isPreviewHoverMessage, isPreviewReadyMessage, isPreviewSelectMessage } from './protocol'

describe('protocol type guards', () => {
  it('accepts a valid data message', () => {
    expect(isPreviewDataMessage({ type: 'kernel-preview', data: { a: 1 } })).toBe(true)
  })

  it('rejects a data message missing the data field', () => {
    expect(isPreviewDataMessage({ type: 'kernel-preview' })).toBe(false)
  })

  it('rejects foreign and malformed envelopes', () => {
    expect(isPreviewDataMessage({ type: 'other', data: 1 })).toBe(false)
    expect(isPreviewDataMessage(null)).toBe(false)
    expect(isPreviewDataMessage('kernel-preview')).toBe(false)
  })

  it('accepts ready and select messages', () => {
    expect(isPreviewReadyMessage({ type: 'kernel-preview-ready' })).toBe(true)
    expect(isPreviewSelectMessage({ type: 'kernel-preview-select', path: 'layout.0' })).toBe(true)
  })

  it('rejects a select message without a string path', () => {
    expect(isPreviewSelectMessage({ type: 'kernel-preview-select', path: 3 })).toBe(false)
    expect(isPreviewSelectMessage({ type: 'kernel-preview-select' })).toBe(false)
  })

  it('accepts hover messages with a string or null path', () => {
    expect(isPreviewHoverMessage({ type: 'kernel-preview-hover', path: 'a.0' })).toBe(true)
    expect(isPreviewHoverMessage({ type: 'kernel-preview-hover', path: null })).toBe(true)
    expect(isPreviewHoverMessage({ type: 'kernel-preview-hover', path: 5 })).toBe(false)
  })
})
