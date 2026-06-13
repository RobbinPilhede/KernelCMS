// Framework-agnostic glue that turns a frontend into a click-to-edit surface
// inside the KernelCMS admin's live-preview iframe. Call once on the client.
import { KERNEL_PATH_ATTR } from './editable'
import {
  KERNEL_PREVIEW_HOVER,
  KERNEL_PREVIEW_READY,
  KERNEL_PREVIEW_SELECT,
  isPreviewDataMessage,
  type PreviewToEditorMessage,
} from './protocol'

export interface ConnectOptions {
  /**
   * Origins allowed to send `kernel-preview` data into this frame. When set, an
   * inbound data message must match both `event.source === window.parent` AND
   * `event.origin ∈ allowedOrigins`. Leave unset only if the frame is never
   * embedded by an untrusted origin. SECURITY: data drives your render — never
   * apply it from a source you don't trust.
   */
  allowedOrigins?: string[]
  /**
   * `targetOrigin` for messages posted UP to the editor. Default `'*'` is
   * acceptable here because outbound payloads carry only a dot-path string
   * (select/hover/ready) — no document content. Set it to the admin's origin to
   * stop other windows from observing which element is hovered/selected.
   */
  parentOrigin?: string
  /** Inject the hover/selected outline stylesheet. Default true. */
  injectStyles?: boolean
}

export interface VisualEditingHandle<T = unknown> {
  /** Latest data received from the editor, or undefined before the first message. */
  readonly data: T | undefined
  /** Subscribe to data updates. Returns an unsubscribe function. */
  subscribe(cb: (data: T) => void): () => void
  /** Remove every listener and injected node. Idempotent. */
  destroy(): void
}

const STYLE_ID = 'kernel-visual-editing-style'
const STYLE = `
[${KERNEL_PATH_ATTR}]{cursor:pointer}
[${KERNEL_PATH_ATTR}][data-kernel-hover]{outline:2px solid #4f8cff;outline-offset:2px}
[${KERNEL_PATH_ATTR}][data-kernel-selected]{outline:2px solid #2563eb;outline-offset:2px}
`

/** Walk from an event target up to the nearest element carrying a kernel path. */
function closestPath(node: EventTarget | null): { el: HTMLElement; path: string } | null {
  let el = node instanceof Element ? node : null
  for (; el; el = el.parentElement) {
    if (el instanceof HTMLElement) {
      const path = el.getAttribute(KERNEL_PATH_ATTR)
      if (path !== null) return { el, path }
    }
  }
  return null
}

const noopHandle = <T>(): VisualEditingHandle<T> => ({
  data: undefined,
  subscribe: () => () => {},
  destroy: () => {},
})

export function connectVisualEditing<T = unknown>(opts: ConnectOptions = {}): VisualEditingHandle<T> {
  // Only meaningful inside an iframe hosted by the editor. Outside one (SSR,
  // standalone production), this is a no-op so consumers can call it freely.
  if (typeof window === 'undefined' || window.parent === window) return noopHandle<T>()

  const { allowedOrigins, parentOrigin = '*', injectStyles = true } = opts
  const subscribers = new Set<(data: T) => void>()
  let current: T | undefined
  let hovered: HTMLElement | null = null

  const postUp = (message: PreviewToEditorMessage) => window.parent.postMessage(message, parentOrigin)

  const onMessage = (event: MessageEvent) => {
    // SECURITY: only the hosting editor may drive our render. Reject any other
    // window, and — when configured — any origin not on the allowlist.
    if (event.source !== window.parent) return
    if (allowedOrigins && !allowedOrigins.includes(event.origin)) return
    if (!isPreviewDataMessage<T>(event.data)) return
    current = event.data.data
    for (const cb of subscribers) cb(current)
  }

  const onClick = (event: MouseEvent) => {
    const hit = closestPath(event.target)
    if (hit) postUp({ type: KERNEL_PREVIEW_SELECT, path: hit.path })
  }

  const setHover = (el: HTMLElement | null, path: string | null) => {
    if (hovered === el) return
    hovered?.removeAttribute('data-kernel-hover')
    hovered = el
    hovered?.setAttribute('data-kernel-hover', '')
    postUp({ type: KERNEL_PREVIEW_HOVER, path })
  }

  const onPointerOver = (event: PointerEvent) => {
    const hit = closestPath(event.target)
    setHover(hit?.el ?? null, hit?.path ?? null)
  }

  const onPointerOut = (event: PointerEvent) => {
    // Ignore moves that stay within the same editable subtree.
    const to = event.relatedTarget
    if (to instanceof Node && hovered?.contains(to)) return
    if (closestPath(event.target)) setHover(null, null)
  }

  let styleEl: HTMLStyleElement | null = null
  if (injectStyles && typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
    styleEl = document.createElement('style')
    styleEl.id = STYLE_ID
    styleEl.textContent = STYLE
    document.head.appendChild(styleEl)
  }

  window.addEventListener('message', onMessage)
  document.addEventListener('click', onClick, true)
  document.addEventListener('pointerover', onPointerOver, true)
  document.addEventListener('pointerout', onPointerOut, true)

  // Announce readiness so the editor replies with the first data payload.
  postUp({ type: KERNEL_PREVIEW_READY })

  let destroyed = false
  return {
    get data() {
      return current
    },
    subscribe(cb) {
      subscribers.add(cb)
      return () => subscribers.delete(cb)
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      window.removeEventListener('message', onMessage)
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('pointerover', onPointerOver, true)
      document.removeEventListener('pointerout', onPointerOut, true)
      hovered?.removeAttribute('data-kernel-hover')
      hovered = null
      styleEl?.remove()
      subscribers.clear()
    },
  }
}
