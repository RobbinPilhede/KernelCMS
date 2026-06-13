// Marks a DOM element as a click-to-edit target. Spread the result onto any
// element; the SDK's delegated listeners walk up to the nearest one and report
// its path to the editor. Framework-agnostic — the returned object is a plain
// set of HTML attributes valid in JSX, template literals, or imperative DOM.

export const KERNEL_PATH_ATTR = 'data-kernel-path' as const
export const KERNEL_EDITABLE_ATTR = 'data-kernel-editable' as const

/** Plain-text field kinds that support true inline editing on the page. */
export type KernelEditableType = 'text' | 'number'

export interface KernelEditableAttrs {
  'data-kernel-path': string
  'data-kernel-editable'?: KernelEditableType
}

export interface KernelEditableOptions {
  /** Allow editing the value inline on the rendered page. Default true. */
  editable?: boolean
  /** Coercion for the patched value the editor receives. Default 'text'. */
  type?: KernelEditableType
}

export function kernelEditable(path: string, opts?: KernelEditableOptions): KernelEditableAttrs {
  // No opts → path attr only, identical to the original signature. Inline editing
  // is strictly opt-in so existing select/hover-only callers are unchanged.
  if (!opts) return { [KERNEL_PATH_ATTR]: path }
  const { editable = true, type = 'text' } = opts
  if (!editable) return { [KERNEL_PATH_ATTR]: path }
  return { [KERNEL_PATH_ATTR]: path, [KERNEL_EDITABLE_ATTR]: type }
}
