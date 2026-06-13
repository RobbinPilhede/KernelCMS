import { describe, expect, it } from 'vitest'
import {
  isPreviewDataMessage,
  isPreviewEditEndMessage,
  isPreviewEditStartMessage,
  isPreviewHoverMessage,
  isPreviewPatchMessage,
  isPreviewReadyMessage,
  isPreviewSelectMessage,
} from './protocol'

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

  it('accepts edit-start/edit-end with a string path', () => {
    expect(isPreviewEditStartMessage({ type: 'kernel-preview-edit-start', path: 'layout.0.heading' })).toBe(true)
    expect(isPreviewEditEndMessage({ type: 'kernel-preview-edit-end', path: 'layout.0.heading' })).toBe(true)
  })

  it('rejects edit-start/edit-end without a string path', () => {
    expect(isPreviewEditStartMessage({ type: 'kernel-preview-edit-start' })).toBe(false)
    expect(isPreviewEditStartMessage({ type: 'kernel-preview-edit-start', path: 7 })).toBe(false)
    expect(isPreviewEditEndMessage({ type: 'kernel-preview-edit-end', path: null })).toBe(false)
  })

  it('accepts a patch message with a string or number value', () => {
    expect(isPreviewPatchMessage({ type: 'kernel-preview-patch', path: 'a.0', value: 'hi' })).toBe(true)
    expect(isPreviewPatchMessage({ type: 'kernel-preview-patch', path: 'a.0', value: 42 })).toBe(true)
  })

  it('rejects malformed patch messages', () => {
    expect(isPreviewPatchMessage({ type: 'kernel-preview-patch', value: 'hi' })).toBe(false) // missing path
    expect(isPreviewPatchMessage({ type: 'kernel-preview-patch', path: 'a.0', value: { a: 1 } })).toBe(false) // object value
    expect(isPreviewPatchMessage({ type: 'kernel-preview-patch', path: 'a.0', value: true })).toBe(false) // wrong type
    expect(isPreviewPatchMessage({ type: 'kernel-preview-patch', path: 5, value: 'hi' })).toBe(false) // wrong path type
    expect(isPreviewPatchMessage(null)).toBe(false)
  })
})
