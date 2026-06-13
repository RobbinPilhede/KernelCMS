// Marks a DOM element as a click-to-edit target. Spread the result onto any
// element; the SDK's delegated listeners walk up to the nearest one and report
// its path to the editor. Framework-agnostic — the returned object is a plain
// set of HTML attributes valid in JSX, template literals, or imperative DOM.

export const KERNEL_PATH_ATTR = 'data-kernel-path' as const

export interface KernelEditableAttrs {
  'data-kernel-path': string
}

export function kernelEditable(path: string): KernelEditableAttrs {
  return { [KERNEL_PATH_ATTR]: path }
}
