import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { adminStatus, getToken, login as apiLogin, logout as apiLogout, me, setupAdmin } from './api'
import type { AdminSchema, Doc } from './api'

interface AuthContextValue {
  user: Doc | null
  loading: boolean
  authSlug: string | null
  needsSetup: boolean
  signIn: (email: string, password: string) => Promise<void>
  signUp: (email: string, password: string) => Promise<void>
  signOut: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider')
  return ctx
}

export function AuthProvider({ schema, children }: { schema: AdminSchema; children: ReactNode }) {
  const authSlug = schema.collections.find((c) => c.auth)?.slug ?? null
  const [user, setUser] = useState<Doc | null>(null)
  const [loading, setLoading] = useState(true)
  const [needsSetup, setNeedsSetup] = useState(false)

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const status = await adminStatus()
        if (active) setNeedsSetup(status.needsSetup)
        if (!status.needsSetup && authSlug && getToken()) {
          const result = await me(authSlug)
          if (active) setUser(result.user)
        }
      } catch {
        if (active) setUser(null)
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [authSlug])

  const signIn = async (email: string, password: string): Promise<void> => {
    if (!authSlug) throw new Error('No auth collection is configured.')
    const result = await apiLogin(authSlug, email, password)
    setUser(result.user)
    setNeedsSetup(false)
  }

  const signUp = async (email: string, password: string): Promise<void> => {
    const result = await setupAdmin(email, password)
    setUser(result.user)
    setNeedsSetup(false)
  }

  const signOut = (): void => {
    apiLogout()
    setUser(null)
  }

  return (
    <AuthContext.Provider value={{ user, loading, authSlug, needsSetup, signIn, signUp, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}
