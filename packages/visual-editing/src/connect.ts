// Framework-agnostic glue that turns a frontend into a click-to-edit surface
// inside the KernelCMS admin's live-preview iframe. Call once on the client.
import { KERNEL_EDITABLE_ATTR, KERNEL_PATH_ATTR, type KernelEditableType } from './editable'
import {
  KERNEL_PREVIEW_EDIT_END,
  KERNEL_PREVIEW_EDIT_START,
  KERNEL_PREVIEW_HOVER,
  KERNEL_PREVIEW_PATCH,
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
  /**
   * Master switch for TRUE inline editing: double-click an element carrying both
   * `data-kernel-path` and `data-kernel-editable` to edit its text in place; the
   * value is patched back into the document. Default true. Set false to keep the
   * surface read-only (select/hover still work).
   */
  editable?: boolean
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
[${KERNEL_EDITABLE_ATTR}]{cursor:text}
[${KERNEL_EDITABLE_ATTR}][contenteditable]:focus{outline:2px solid #2563eb;outline-offset:2px}
`

const PATCH_DEBOUNCE_MS = 120

/** Walk a dot-path into already-parsed data. Returns undefined if any hop is
 *  missing — used to reject edits whose stamped markup drifted from the schema. */
function getAtPath(data: unknown, path: string): unknown {
  let node: unknown = data
  for (const seg of path.split('.')) {
    if (node === null || typeof node !== 'object') return undefined
    node = (node as Record<string, unknown>)[seg]
  }
  return node
}

/** Coerce edited text per the declared editable type. Rejects NaN for numbers. */
function coerce(text: string, type: KernelEditableType): string | number | null {
  if (type !== 'number') return text
  const n = Number(text.trim())
  return Number.isNaN(n) ? null : n
}

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

  const { allowedOrigins, parentOrigin = '*', injectStyles = true, editable = true } = opts
  const subscribers = new Set<(data: T) => void>()
  let current: T | undefined
  let hovered: HTMLElement | null = null

  // Inline-edit state: the element currently in edit mode, its path/type, the
  // text it held when editing began (for Escape), and the trailing patch timer.
  let editEl: HTMLElement | null = null
  let editPath: string | null = null
  let editType: KernelEditableType = 'text'
  let editOriginal = ''
  let patchTimer: ReturnType<typeof setTimeout> | null = null

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

  // Find the nearest ancestor that is inline-editable AND whose path still
  // resolves in the latest data. Drifted markup (path missing from data) is left
  // read-only so we never patch a key the schema no longer has.
  const editableHit = (
    node: EventTarget | null,
  ): { el: HTMLElement; path: string; type: KernelEditableType } | null => {
    const hit = closestPath(node)
    if (!hit) return null
    const type = hit.el.getAttribute(KERNEL_EDITABLE_ATTR)
    if (type !== 'text' && type !== 'number') return null
    if (getAtPath(current, hit.path) === undefined) return null
    return { el: hit.el, path: hit.path, type }
  }

  const clearPatchTimer = () => {
    if (patchTimer === null) return
    clearTimeout(patchTimer)
    patchTimer = null
  }

  // Read the live text, coerce it, and post a patch up to the editor.
  const flushPatch = () => {
    clearPatchTimer()
    if (!editEl || editPath === null) return
    const value = coerce(editEl.textContent ?? '', editType)
    if (value === null) return // invalid (e.g. NaN for a number) — drop, keep editing
    postUp({ type: KERNEL_PREVIEW_PATCH, path: editPath, value })
  }

  const onInput = () => {
    if (!editEl) return
    clearPatchTimer()
    patchTimer = setTimeout(flushPatch, PATCH_DEBOUNCE_MS)
  }

  // Leave edit mode: flush any pending patch (unless cancelling), strip
  // contentEditable, and tell the editor to resume echoing canonical data.
  const endEdit = (cancel: boolean) => {
    if (!editEl || editPath === null) return
    const el = editEl
    const path = editPath
    if (cancel) {
      clearPatchTimer()
      el.textContent = editOriginal
    } else {
      flushPatch()
    }
    el.removeAttribute('contenteditable')
    el.removeEventListener('input', onInput)
    el.removeEventListener('keydown', onEditKeydown)
    el.removeEventListener('blur', onEditBlur)
    editEl = null
    editPath = null
    postUp({ type: KERNEL_PREVIEW_EDIT_END, path })
  }

  function onEditBlur() {
    endEdit(false)
  }

  function onEditKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      // Single-line plain text — commit instead of inserting a newline.
      event.preventDefault()
      endEdit(false)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      endEdit(true)
    }
  }

  // Double-click to enter edit mode so a single click still only selects.
  const onDblClick = (event: MouseEvent) => {
    if (!editable) return
    const hit = editableHit(event.target)
    if (!hit) return
    if (editEl === hit.el) return
    if (editEl) endEdit(false) // commit any element already being edited
    editEl = hit.el
    editPath = hit.path
    editType = hit.type
    editOriginal = hit.el.textContent ?? ''
    hit.el.setAttribute('contenteditable', 'true')
    hit.el.addEventListener('input', onInput)
    hit.el.addEventListener('keydown', onEditKeydown)
    hit.el.addEventListener('blur', onEditBlur)
    hit.el.focus()
    // Select the element's contents so typing replaces the whole value.
    const sel = window.getSelection?.()
    if (sel) {
      const range = document.createRange()
      range.selectNodeContents(hit.el)
      sel.removeAllRanges()
      sel.addRange(range)
    }
    postUp({ type: KERNEL_PREVIEW_EDIT_START, path: hit.path })
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
  document.addEventListener('dblclick', onDblClick, true)
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
      // Tear down any in-progress edit first (removes its element-level listeners).
      if (editEl) endEdit(true)
      clearPatchTimer()
      window.removeEventListener('message', onMessage)
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('dblclick', onDblClick, true)
      document.removeEventListener('pointerover', onPointerOver, true)
      document.removeEventListener('pointerout', onPointerOut, true)
      hovered?.removeAttribute('data-kernel-hover')
      hovered = null
      styleEl?.remove()
      subscribers.clear()
    },
  }
}
