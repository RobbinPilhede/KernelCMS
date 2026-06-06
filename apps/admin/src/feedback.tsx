import { useEffect, useState } from 'react'

// Lightweight, dependency-free feedback primitives shared across the panel:
// animated toasts and a promise-based confirm dialog. Both use a tiny pub/sub
// store so any view can call `toast(...)` / `confirmDialog(...)` without threading
// context. Animations respect prefers-reduced-motion via CSS.

// ── Toasts ───────────────────────────────────────────────────────────────────

export type ToastVariant = 'success' | 'error' | 'info'
interface Toast {
  id: number
  message: string
  variant: ToastVariant
  leaving?: boolean
}

let toastSeq = 0
let toasts: Toast[] = []
const toastListeners = new Set<(t: Toast[]) => void>()
const emitToasts = () => toastListeners.forEach((l) => l(toasts))

export function toast(message: string, variant: ToastVariant = 'info', ms = 3200): void {
  const id = ++toastSeq
  toasts = [...toasts, { id, message, variant }]
  emitToasts()
  // Flag as leaving so it animates out, then remove.
  setTimeout(() => {
    toasts = toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t))
    emitToasts()
  }, Math.max(0, ms - 220))
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id)
    emitToasts()
  }, ms)
}

export function Toaster() {
  const [items, setItems] = useState<Toast[]>(toasts)
  useEffect(() => {
    toastListeners.add(setItems)
    return () => {
      toastListeners.delete(setItems)
    }
  }, [])
  if (items.length === 0) return null
  return (
    <div className="toaster" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast toast-${t.variant}${t.leaving ? ' leaving' : ''}`}>
          <span className="toast-dot" aria-hidden />
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  )
}

// ── Confirm dialog ─────────────────────────────────────────────────────────

interface ConfirmOptions {
  title: string
  message?: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
}
interface ConfirmState extends ConfirmOptions {
  id: number
  resolve: (ok: boolean) => void
}

let confirmState: ConfirmState | null = null
const confirmListeners = new Set<(s: ConfirmState | null) => void>()
const emitConfirm = () => confirmListeners.forEach((l) => l(confirmState))

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    confirmState = { ...options, id: Date.now(), resolve }
    emitConfirm()
  })
}

export function ConfirmHost() {
  const [state, setState] = useState<ConfirmState | null>(confirmState)
  useEffect(() => {
    confirmListeners.add(setState)
    return () => {
      confirmListeners.delete(setState)
    }
  }, [])

  useEffect(() => {
    if (!state) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') settle(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state])

  if (!state) return null

  const settle = (ok: boolean) => {
    state.resolve(ok)
    confirmState = null
    emitConfirm()
  }

  return (
    <div className="confirm-backdrop" onClick={() => settle(false)}>
      <div className="confirm" role="alertdialog" aria-label={state.title} onClick={(e) => e.stopPropagation()}>
        <h2 className="confirm-title">{state.title}</h2>
        {state.message && <p className="confirm-message">{state.message}</p>}
        <div className="confirm-actions">
          <button type="button" className="btn ghost" onClick={() => settle(false)}>
            {state.cancelLabel ?? 'Cancel'}
          </button>
          <button
            type="button"
            className={state.danger ? 'btn danger' : 'btn primary'}
            autoFocus
            onClick={() => settle(true)}
          >
            {state.confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  )
}
