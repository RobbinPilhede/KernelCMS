import { useState } from 'react'

// Light/dark theme via a `.dark` class on <html>, persisted in localStorage.
// Defaults to dark. Most of the admin reads CSS variables, so flipping the class
// re-themes the whole panel without per-component dark styles.

export type Theme = 'light' | 'dark'
const KEY = 'kernel-theme'

export function getTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'light' || v === 'dark') return v
  } catch {
    /* storage unavailable */
  }
  return 'dark'
}

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark')
  try {
    localStorage.setItem(KEY, theme)
  } catch {
    /* ignore */
  }
}

/** Call once before first paint to avoid a flash of the wrong theme. */
export function initTheme(): void {
  applyTheme(getTheme())
}

const MoonIcon = () => (
  <svg
    width="11"
    height="11"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>
)
const SunIcon = () => (
  <svg
    width="11"
    height="11"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="4.5" />
    <path d="M12 1.5v2M12 20.5v2M3.5 12h-2M22.5 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M18.4 5.6l1.4-1.4M4.2 19.8l1.4-1.4" />
  </svg>
)

let transitionTimer: ReturnType<typeof setTimeout> | undefined

/** Enable the staggered, block-by-block theme transition for one switch. */
function runThemeTransition(next: Theme): void {
  const root = document.documentElement
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  if (!reduce) {
    root.classList.add('theme-transition')
    if (transitionTimer) clearTimeout(transitionTimer)
    transitionTimer = setTimeout(() => root.classList.remove('theme-transition'), 1000)
  }
  applyTheme(next)
}

/** Norrsken-style sliding-pill light/dark switch. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(getTheme)
  const isDark = theme === 'dark'
  return (
    <button
      type="button"
      className="theme-toggle"
      role="switch"
      aria-checked={isDark}
      aria-label={`Switch to ${isDark ? 'light' : 'dark'} mode`}
      data-dark={isDark}
      onClick={() => {
        const next: Theme = isDark ? 'light' : 'dark'
        runThemeTransition(next)
        setTheme(next)
      }}
    >
      <span className="theme-knob">{isDark ? <MoonIcon /> : <SunIcon />}</span>
    </button>
  )
}
