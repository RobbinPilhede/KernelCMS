// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useKernelPreview } from './react'

// Stub a distinct parent so connectVisualEditing engages (see connect.test.ts).
const fakeParent = { postMessage: () => {} }

beforeEach(() => {
  Object.defineProperty(window, 'parent', { configurable: true, value: fakeParent })
  // React 18 act() environment flag.
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  Object.defineProperty(window, 'parent', { configurable: true, value: window })
})

function Probe({ initial }: { initial: { title: string } }) {
  const data = useKernelPreview(initial)
  return createElement('h1', null, data.title)
}

describe('useKernelPreview', () => {
  it('returns the initial value, then updates when the editor posts data', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    act(() => {
      root.render(createElement(Probe, { initial: { title: 'fallback' } }))
    })
    expect(container.querySelector('h1')!.textContent).toBe('fallback')

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'kernel-preview', data: { title: 'live' } },
          source: fakeParent as unknown as Window,
          origin: 'https://admin.test',
        }),
      )
    })
    expect(container.querySelector('h1')!.textContent).toBe('live')

    act(() => root.unmount())
    document.body.removeChild(container)
  })
})
