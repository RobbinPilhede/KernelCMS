// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectVisualEditing } from './connect'

// jsdom sets window.parent === window (top frame). Stub a distinct parent so the
// SDK believes it is embedded, and capture what it posts upward.
const posted: unknown[] = []
const fakeParent = { postMessage: (msg: unknown) => posted.push(msg) }

beforeEach(() => {
  posted.length = 0
  Object.defineProperty(window, 'parent', { configurable: true, value: fakeParent })
})

afterEach(() => {
  Object.defineProperty(window, 'parent', { configurable: true, value: window })
  document.body.innerHTML = ''
  document.head.querySelector('#kernel-visual-editing-style')?.remove()
})

// Deliver a message as if it came from the trusted parent (or a forged source).
function deliver(data: unknown, source: unknown = fakeParent, origin = 'https://admin.test') {
  window.dispatchEvent(new MessageEvent('message', { data, source: source as Window, origin }))
}

describe('connectVisualEditing', () => {
  it('posts kernel-preview-ready to the parent on connect', () => {
    const handle = connectVisualEditing()
    expect(posted).toContainEqual({ type: 'kernel-preview-ready' })
    handle.destroy()
  })

  it('applies data from the trusted parent and notifies subscribers', () => {
    const handle = connectVisualEditing<{ title: string }>()
    const cb = vi.fn()
    handle.subscribe(cb)

    deliver({ type: 'kernel-preview', data: { title: 'Hello' } })

    expect(handle.data).toEqual({ title: 'Hello' })
    expect(cb).toHaveBeenCalledWith({ title: 'Hello' })
    handle.destroy()
  })

  it('ignores data from an untrusted source', () => {
    const handle = connectVisualEditing()
    const cb = vi.fn()
    handle.subscribe(cb)

    deliver({ type: 'kernel-preview', data: { evil: true } }, { other: 'window' })

    expect(handle.data).toBeUndefined()
    expect(cb).not.toHaveBeenCalled()
    handle.destroy()
  })

  it('ignores data from a disallowed origin when allowedOrigins is set', () => {
    const handle = connectVisualEditing({ allowedOrigins: ['https://admin.test'] })
    const cb = vi.fn()
    handle.subscribe(cb)

    deliver({ type: 'kernel-preview', data: { ok: false } }, fakeParent, 'https://evil.test')
    expect(cb).not.toHaveBeenCalled()

    deliver({ type: 'kernel-preview', data: { ok: true } }, fakeParent, 'https://admin.test')
    expect(handle.data).toEqual({ ok: true })
    handle.destroy()
  })

  it('emits kernel-preview-select with the path on click of an editable element', () => {
    document.body.innerHTML = '<section data-kernel-path="layout.0"><span id="t">x</span></section>'
    const handle = connectVisualEditing()

    document.getElementById('t')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(posted).toContainEqual({ type: 'kernel-preview-select', path: 'layout.0' })
    handle.destroy()
  })

  it('removes its listeners on destroy', () => {
    const handle = connectVisualEditing()
    const cb = vi.fn()
    handle.subscribe(cb)
    handle.destroy()

    deliver({ type: 'kernel-preview', data: { title: 'after' } })
    expect(cb).not.toHaveBeenCalled()
  })

  it('is a no-op when not embedded in an iframe', () => {
    Object.defineProperty(window, 'parent', { configurable: true, value: window })
    const handle = connectVisualEditing()
    expect(posted).toHaveLength(0)
    expect(handle.data).toBeUndefined()
    handle.destroy()
  })
})
