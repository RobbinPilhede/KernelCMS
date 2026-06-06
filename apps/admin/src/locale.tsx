import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { setActiveLocale } from './api'
import { useSchema } from './schema'

interface LocaleContextValue {
  /** Active locale, or null when the project isn't localized. */
  locale: string | null
  locales: string[]
  setLocale: (locale: string) => void
}

const LocaleContext = createContext<LocaleContextValue | null>(null)

export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext)
  if (!ctx) throw new Error('useLocale must be used within a LocaleProvider')
  return ctx
}

const STORAGE_KEY = 'kernel:locale'

export function LocaleProvider({ children }: { children: ReactNode }) {
  const schema = useSchema()
  const qc = useQueryClient()
  const locales = schema.localization?.locales ?? []
  const defaultLocale = schema.localization?.defaultLocale ?? null

  const [locale, setLocaleState] = useState<string | null>(() => {
    if (!defaultLocale) return null
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved && locales.includes(saved)) return saved
    } catch {
      /* ignore */
    }
    return defaultLocale
  })

  // Keep the API module's active locale in sync so requests carry `?locale=`.
  useEffect(() => {
    setActiveLocale(locale)
  }, [locale])

  const setLocale = (next: string): void => {
    setActiveLocale(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      /* ignore */
    }
    setLocaleState(next)
    // Re-fetch every active query against the newly selected locale.
    void qc.invalidateQueries()
  }

  return <LocaleContext.Provider value={{ locale, locales, setLocale }}>{children}</LocaleContext.Provider>
}
