// React bindings, exposed at the `@kernel/visual-editing/react` subpath so that
// non-React consumers never pull React types. React is a peer dependency.
import { useEffect, useState } from 'react'
import { connectVisualEditing } from './connect'
import type { ConnectOptions } from './connect'

export { kernelEditable } from './editable'
export type { KernelEditableAttrs } from './editable'

/**
 * Returns the live data posted by the KernelCMS editor, falling back to
 * `initial` until the first message arrives (and when rendered outside the
 * preview iframe — e.g. in production). Connects on mount, tears down on unmount.
 */
export function useKernelPreview<T>(initial: T, opts?: ConnectOptions): T {
  const [data, setData] = useState<T>(initial)

  useEffect(() => {
    const handle = connectVisualEditing<T>(opts)
    if (handle.data !== undefined) setData(handle.data)
    const unsubscribe = handle.subscribe(setData)
    return () => {
      unsubscribe()
      handle.destroy()
    }
    // opts is treated as stable; callers should memoize if they pass one.
  }, [])

  return data
}
