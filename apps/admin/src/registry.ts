// Admin extension registries. Projects register custom UI on `window.KernelCMS`
// (loaded via the server's `admin.scripts` option before the app boots), the same
// mechanism custom field components already use. This generalizes it to list
// cells and dashboard widgets so people can shape the admin "Payload-style"
// without forking it.
import type { ReactNode } from 'react'
import type { AdminFieldMeta, Doc } from './api'

/** Renders a single list-table cell for a column. Keyed by the field's
 *  `admin.component`. Falls back to the built-in renderer when absent. */
export interface CellProps {
  value: unknown
  row: Doc
  field: AdminFieldMeta
}

/** A dashboard widget rendered above the collection grid. */
export interface WidgetProps {
  user: Record<string, unknown> | null
}

export interface KernelRegistry {
  fields?: Record<string, unknown>
  cells?: Record<string, (props: CellProps) => ReactNode>
  widgets?: Record<string, (props: WidgetProps) => ReactNode>
}

function registry(): KernelRegistry {
  return (globalThis as { KernelCMS?: KernelRegistry }).KernelCMS ?? {}
}

/** A registered cell renderer for a column key, if any. */
export function getCell(key: string | undefined): ((props: CellProps) => ReactNode) | undefined {
  return key ? registry().cells?.[key] : undefined
}

/** Registered dashboard widgets, in stable (sorted-by-key) order. */
export function getWidgets(): { key: string; render: (props: WidgetProps) => ReactNode }[] {
  const widgets = registry().widgets ?? {}
  return Object.keys(widgets)
    .sort()
    .map((key) => ({ key, render: widgets[key]! }))
}
