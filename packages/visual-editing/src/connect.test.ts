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

// Drive a real dblclick on an element (jsdom dispatches a MouseEvent).
function dblclick(el: Element) {
  el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
}

function typeText(el: HTMLElement, text: string) {
  el.textContent = text
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

function lastOfType(type: string): any {
  for (let i = posted.length - 1; i >= 0; i--) {
    const m = posted[i] as { type?: string }
    if (m?.type === type) return m
  }
  return undefined
}

describe('connectVisualEditing — inline editing', () => {
  // A page with a heading (text) and a count (number), both stamped editable.
  function seedPage() {
    document.body.innerHTML =
      '<h1 id="h" data-kernel-path="layout.0.heading" data-kernel-editable="text">Hello</h1>' +
      '<span id="c" data-kernel-path="layout.0.count" data-kernel-editable="number">3</span>' +
      '<p id="plain" data-kernel-path="layout.0.note">read only</p>'
  }

  it('double-click enters edit mode and posts edit-start (path present in data)', () => {
    seedPage()
    const handle = connectVisualEditing()
    deliver({ type: 'kernel-preview', data: { layout: [{ heading: 'Hello', count: 3, note: 'x' }] } })

    const h = document.getElementById('h')!
    dblclick(h)

    expect(h.getAttribute('contenteditable')).toBe('true')
    expect(posted).toContainEqual({ type: 'kernel-preview-edit-start', path: 'layout.0.heading' })
    handle.destroy()
  })

  it('debounces input and posts a coerced patch with the right path', () => {
    vi.useFakeTimers()
    seedPage()
    const handle = connectVisualEditing()
    deliver({ type: 'kernel-preview', data: { layout: [{ heading: 'Hello', count: 3, note: 'x' }] } })

    const h = document.getElementById('h')!
    dblclick(h)
    typeText(h, 'Hi')
    typeText(h, 'Hi there')
    // Nothing posted before the debounce elapses.
    expect(lastOfType('kernel-preview-patch')).toBeUndefined()

    vi.advanceTimersByTime(120)
    expect(lastOfType('kernel-preview-patch')).toEqual({
      type: 'kernel-preview-patch',
      path: 'layout.0.heading',
      value: 'Hi there',
    })
    handle.destroy()
    vi.useRealTimers()
  })

  it('Enter flushes the patch, posts edit-end, and removes contentEditable', () => {
    vi.useFakeTimers()
    seedPage()
    const handle = connectVisualEditing()
    deliver({ type: 'kernel-preview', data: { layout: [{ heading: 'Hello', count: 3, note: 'x' }] } })

    const h = document.getElementById('h')!
    dblclick(h)
    typeText(h, 'Committed')
    h.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    expect(lastOfType('kernel-preview-patch')).toEqual({
      type: 'kernel-preview-patch',
      path: 'layout.0.heading',
      value: 'Committed',
    })
    expect(posted).toContainEqual({ type: 'kernel-preview-edit-end', path: 'layout.0.heading' })
    expect(h.hasAttribute('contenteditable')).toBe(false)
    handle.destroy()
    vi.useRealTimers()
  })

  it('blur posts edit-end and removes contentEditable', () => {
    seedPage()
    const handle = connectVisualEditing()
    deliver({ type: 'kernel-preview', data: { layout: [{ heading: 'Hello', count: 3, note: 'x' }] } })

    const h = document.getElementById('h')!
    dblclick(h)
    h.dispatchEvent(new FocusEvent('blur'))

    expect(posted).toContainEqual({ type: 'kernel-preview-edit-end', path: 'layout.0.heading' })
    expect(h.hasAttribute('contenteditable')).toBe(false)
    handle.destroy()
  })

  it('Escape restores the original text and posts no patch', () => {
    vi.useFakeTimers()
    seedPage()
    const handle = connectVisualEditing()
    deliver({ type: 'kernel-preview', data: { layout: [{ heading: 'Hello', count: 3, note: 'x' }] } })

    const h = document.getElementById('h')!
    dblclick(h)
    typeText(h, 'discard me')
    h.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    vi.advanceTimersByTime(200)

    expect(h.textContent).toBe('Hello')
    expect(lastOfType('kernel-preview-patch')).toBeUndefined()
    expect(posted).toContainEqual({ type: 'kernel-preview-edit-end', path: 'layout.0.heading' })
    handle.destroy()
    vi.useRealTimers()
  })

  it('number type coerces valid input and rejects NaN', () => {
    vi.useFakeTimers()
    seedPage()
    const handle = connectVisualEditing()
    deliver({ type: 'kernel-preview', data: { layout: [{ heading: 'Hello', count: 3, note: 'x' }] } })

    const c = document.getElementById('c')!
    dblclick(c)
    typeText(c, '42')
    vi.advanceTimersByTime(120)
    expect(lastOfType('kernel-preview-patch')).toEqual({
      type: 'kernel-preview-patch',
      path: 'layout.0.count',
      value: 42,
    })

    typeText(c, 'not a number')
    vi.advanceTimersByTime(120)
    // Still the last valid patch — NaN was dropped, no new patch posted.
    expect(lastOfType('kernel-preview-patch').value).toBe(42)
    handle.destroy()
    vi.useRealTimers()
  })

  it('does not enter edit mode for a path missing from current data (drift)', () => {
    document.body.innerHTML = '<h1 id="d" data-kernel-path="layout.9.heading" data-kernel-editable="text">Stale</h1>'
    const handle = connectVisualEditing()
    deliver({ type: 'kernel-preview', data: { layout: [{ heading: 'Hello' }] } })

    const d = document.getElementById('d')!
    dblclick(d)

    expect(d.hasAttribute('contenteditable')).toBe(false)
    expect(lastOfType('kernel-preview-edit-start')).toBeUndefined()
    handle.destroy()
  })

  it('does not enter edit mode when editable:false', () => {
    seedPage()
    const handle = connectVisualEditing({ editable: false })
    deliver({ type: 'kernel-preview', data: { layout: [{ heading: 'Hello', count: 3, note: 'x' }] } })

    const h = document.getElementById('h')!
    dblclick(h)

    expect(h.hasAttribute('contenteditable')).toBe(false)
    expect(lastOfType('kernel-preview-edit-start')).toBeUndefined()
    handle.destroy()
  })

  it('back-compat: a plain data-kernel-path element only selects, never edits', () => {
    seedPage()
    const handle = connectVisualEditing()
    deliver({ type: 'kernel-preview', data: { layout: [{ heading: 'Hello', count: 3, note: 'x' }] } })

    const plain = document.getElementById('plain')!
    dblclick(plain)
    expect(plain.hasAttribute('contenteditable')).toBe(false)
    expect(lastOfType('kernel-preview-edit-start')).toBeUndefined()

    plain.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(posted).toContainEqual({ type: 'kernel-preview-select', path: 'layout.0.note' })
    handle.destroy()
  })

  it('cleans up edit state and listeners on destroy', () => {
    seedPage()
    const handle = connectVisualEditing()
    deliver({ type: 'kernel-preview', data: { layout: [{ heading: 'Hello', count: 3, note: 'x' }] } })

    const h = document.getElementById('h')!
    dblclick(h)
    handle.destroy()

    expect(h.hasAttribute('contenteditable')).toBe(false)
    posted.length = 0
    dblclick(h)
    expect(posted).toHaveLength(0)
  })
})
