import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { AdminSchema } from './api'

// A ⌘K / Ctrl-K quick switcher: jump to any collection, global, or "create new"
// without leaving the keyboard. Opens from anywhere, filters fuzzily, navigates
// on Enter. The kind of affordance that makes the panel feel fast, not generic.

interface Command {
  id: string
  label: string
  group: string
  hint?: string
  run: () => void
}

export function CommandPalette({ schema }: { schema: AdminSchema }) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [closing, setClosing] = useState(false)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const openPalette = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    setClosing(false)
    setOpen(true)
  }
  // Animate out, then unmount — so closing is smooth, not a blink.
  const requestClose = () => {
    setClosing(true)
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => {
      setOpen(false)
      setClosing(false)
    }, 180)
  }

  const commands = useMemo<Command[]>(() => {
    const cmds: Command[] = [{ id: 'home', label: 'Dashboard', group: 'Go to', run: () => navigate({ to: '/' }) }]
    for (const c of schema.collections.filter((c) => !c.hidden)) {
      cmds.push({
        id: `go:${c.slug}`,
        label: c.labels.plural,
        group: 'Go to',
        run: () => navigate({ to: '/collections/$slug', params: { slug: c.slug } }),
      })
      if (!c.auth) {
        cmds.push({
          id: `new:${c.slug}`,
          label: `New ${c.labels.singular}`,
          group: 'Create',
          hint: '+',
          run: () => navigate({ to: '/collections/$slug/new', params: { slug: c.slug } }),
        })
      }
    }
    for (const g of schema.globals) {
      cmds.push({ id: `glob:${g.slug}`, label: g.label, group: 'Globals', run: () => navigate({ to: '/globals/$slug', params: { slug: g.slug } }) })
    }
    return cmds
  }, [schema, navigate])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return commands
    return commands.filter((c) => `${c.group} ${c.label}`.toLowerCase().includes(q))
  }, [commands, query])

  // Global open shortcut: ⌘K / Ctrl-K.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        if (open) requestClose()
        else openPalette()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (open) {
      setQuery('')
      setIndex(0)
      // Focus after the element mounts.
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  useEffect(() => {
    setIndex(0)
  }, [query])

  const choose = (cmd: Command | undefined) => {
    if (!cmd) return
    requestClose()
    cmd.run()
  }

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIndex((i) => (results.length ? (i + 1) % results.length : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIndex((i) => (results.length ? (i - 1 + results.length) % results.length : 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(results[Math.min(index, results.length - 1)])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      requestClose()
    }
  }

  return (
    <>
      <button type="button" className="cmdk-trigger" aria-label="Open command palette" onClick={openPalette}>
        <span>Search…</span>
        <kbd>⌘K</kbd>
      </button>
      {open && (
        <div className={closing ? 'cmdk-backdrop closing' : 'cmdk-backdrop'} onClick={requestClose}>
          <div
            className={closing ? 'cmdk closing' : 'cmdk'}
            role="dialog"
            aria-label="Command palette"
            onClick={(e) => e.stopPropagation()}
          >
            <input
              ref={inputRef}
              className="cmdk-input"
              placeholder="Jump to a collection, global, or create new…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              role="combobox"
              aria-expanded
              aria-controls="cmdk-list"
            />
            <ul className="cmdk-list" id="cmdk-list" role="listbox" aria-label="Commands">
              {results.length === 0 && <li className="cmdk-empty">No matches</li>}
              {results.map((cmd, i) => (
                <li
                  key={cmd.id}
                  role="option"
                  aria-selected={i === index}
                  className={i === index ? 'cmdk-item active' : 'cmdk-item'}
                  onMouseEnter={() => setIndex(i)}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    choose(cmd)
                  }}
                >
                  <span className="cmdk-group">{cmd.group}</span>
                  <span className="cmdk-label">{cmd.label}</span>
                  {cmd.hint && <span className="cmdk-hint">{cmd.hint}</span>}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </>
  )
}
