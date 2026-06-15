"use client"

/**
 * kernelcms/visual-editing/react - React bindings for visual editing.
 *
 *   import { useKernelPreview, kernelEditable } from 'kernelcms/visual-editing/react'
 *
 *   const data = useKernelPreview(initialData)
 *   <h1 {...kernelEditable('hero.0.heading')}>{data.hero[0].heading}</h1>
 *
 * Keep this wrapper local instead of re-exporting @kernel/visual-editing/react:
 * the npm package must resolve React from the consuming app's peer dependency,
 * never from the monorepo workspace package used while building KernelCMS.
 */
import { useEffect, useState } from 'react'
import { connectVisualEditing, kernelEditable } from './visual-editing'
import type { ConnectOptions } from '@kernel/visual-editing'
import type { KernelEditableAttrs } from '@kernel/visual-editing'

export { kernelEditable }
export type { KernelEditableAttrs }

/**
 * Returns the live data posted by the KernelCMS editor, falling back to
 * `initial` until the first message arrives (and when rendered outside the
 * preview iframe, e.g. in production). Connects on mount, tears down on unmount.
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
