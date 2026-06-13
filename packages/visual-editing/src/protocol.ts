// Single source of truth for the postMessage contract between the KernelCMS
// admin editor and a frontend rendered inside its live-preview iframe.
//
//   Editor  → Preview:  { type: 'kernel-preview', data }
//   Preview → Editor:   { type: 'kernel-preview-ready' }
//   Preview → Editor:   { type: 'kernel-preview-select', path }
//   Preview → Editor:   { type: 'kernel-preview-hover', path }
//   Preview → Editor:   { type: 'kernel-preview-edit-start', path }
//   Preview → Editor:   { type: 'kernel-preview-patch', path, value }
//   Preview → Editor:   { type: 'kernel-preview-edit-end', path }
//
// `path` is a dot-path string into the live form data, e.g. "layout.0.heading".

export const KERNEL_PREVIEW = 'kernel-preview' as const
export const KERNEL_PREVIEW_READY = 'kernel-preview-ready' as const
export const KERNEL_PREVIEW_SELECT = 'kernel-preview-select' as const
export const KERNEL_PREVIEW_HOVER = 'kernel-preview-hover' as const
export const KERNEL_PREVIEW_PATCH = 'kernel-preview-patch' as const
export const KERNEL_PREVIEW_EDIT_START = 'kernel-preview-edit-start' as const
export const KERNEL_PREVIEW_EDIT_END = 'kernel-preview-edit-end' as const

/** Editor → Preview: the current form data, posted on every edit. */
export interface PreviewDataMessage<T = unknown> {
  type: typeof KERNEL_PREVIEW
  data: T
}

/** Preview → Editor: the preview's listener is attached and ready for data. */
export interface PreviewReadyMessage {
  type: typeof KERNEL_PREVIEW_READY
}

/** Preview → Editor: the user clicked an editable element. */
export interface PreviewSelectMessage {
  type: typeof KERNEL_PREVIEW_SELECT
  path: string
}

/** Preview → Editor: the pointer entered (path) or left (null) an editable element. */
export interface PreviewHoverMessage {
  type: typeof KERNEL_PREVIEW_HOVER
  path: string | null
}

/** Preview → Editor: the user began inline-editing an element. The editor should
 *  PAUSE echoing data back to this path until the matching edit-end arrives —
 *  otherwise an inbound render clobbers the caret mid-keystroke. */
export interface PreviewEditStartMessage {
  type: typeof KERNEL_PREVIEW_EDIT_START
  path: string
}

/** Preview → Editor: the live value as the user types, debounced. */
export interface PreviewPatchMessage {
  type: typeof KERNEL_PREVIEW_PATCH
  path: string
  value: string | number
}

/** Preview → Editor: inline-editing of `path` ended (blur/Enter/Escape). */
export interface PreviewEditEndMessage {
  type: typeof KERNEL_PREVIEW_EDIT_END
  path: string
}

/** Messages the editor sends down into the preview iframe. */
export type EditorToPreviewMessage<T = unknown> = PreviewDataMessage<T>

/** Messages the preview sends up to the hosting editor. */
export type PreviewToEditorMessage =
  | PreviewReadyMessage
  | PreviewSelectMessage
  | PreviewHoverMessage
  | PreviewEditStartMessage
  | PreviewPatchMessage
  | PreviewEditEndMessage

export type KernelPreviewMessage = EditorToPreviewMessage | PreviewToEditorMessage

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

export function isPreviewDataMessage<T = unknown>(v: unknown): v is PreviewDataMessage<T> {
  // `data` is intentionally not narrowed — the consumer owns its shape. We only
  // assert the envelope so untrusted senders can't masquerade as data messages.
  return isRecord(v) && v.type === KERNEL_PREVIEW && 'data' in v
}

export function isPreviewReadyMessage(v: unknown): v is PreviewReadyMessage {
  return isRecord(v) && v.type === KERNEL_PREVIEW_READY
}

export function isPreviewSelectMessage(v: unknown): v is PreviewSelectMessage {
  return isRecord(v) && v.type === KERNEL_PREVIEW_SELECT && typeof v.path === 'string'
}

export function isPreviewHoverMessage(v: unknown): v is PreviewHoverMessage {
  return isRecord(v) && v.type === KERNEL_PREVIEW_HOVER && (typeof v.path === 'string' || v.path === null)
}

export function isPreviewEditStartMessage(v: unknown): v is PreviewEditStartMessage {
  return isRecord(v) && v.type === KERNEL_PREVIEW_EDIT_START && typeof v.path === 'string'
}

export function isPreviewPatchMessage(v: unknown): v is PreviewPatchMessage {
  return (
    isRecord(v) &&
    v.type === KERNEL_PREVIEW_PATCH &&
    typeof v.path === 'string' &&
    (typeof v.value === 'string' || typeof v.value === 'number')
  )
}

export function isPreviewEditEndMessage(v: unknown): v is PreviewEditEndMessage {
  return isRecord(v) && v.type === KERNEL_PREVIEW_EDIT_END && typeof v.path === 'string'
}
