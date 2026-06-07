import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { adminStatus, login as apiLogin, logout as apiLogout, me, setupAdmin } from './api'
import type { AdminSchema, Doc, SetupRuntime } from './api'

interface AuthContextValue {
  user: Doc | null
  loading: boolean
  authSlug: string | null
  needsSetup: boolean
  /** Non-sensitive runtime facts, available during first-run setup. */
  runtime: SetupRuntime | null
  signIn: (email: string, password: string) => Promise<void>
  /** Create the first admin account (stores the session) but keep the welcome
   *  wizard in control so it can show the post-setup steps. */
  signUp: (email: string, password: string) => Promise<void>
  /** Finish the welcome wizard and enter the dashboard. */
  completeSetup: () => Promise<void>
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
  const [runtime, setRuntime] = useState<SetupRuntime | null>(null)

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const status = await adminStatus()
        if (active) {
          setNeedsSetup(status.needsSetup)
          setRuntime(status.runtime ?? null)
        }
        // Resume an existing session from the HttpOnly cookie: ask /me and accept
        // the user if the cookie authenticates. A 401 just means "not signed in".
        if (!status.needsSetup && authSlug) {
          try {
            const result = await me(authSlug)
            if (active) setUser(result.user)
          } catch {
            if (active) setUser(null)
          }
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
    // Creates the admin and stores the session token. We deliberately do NOT set
    // `user` yet — the welcome wizard stays mounted to show its final step until
    // the operator chooses to enter the dashboard via `completeSetup`.
    await setupAdmin(email, password)
  }

  const completeSetup = async (): Promise<void> => {
    if (authSlug) {
      try {
        const result = await me(authSlug)
        setUser(result.user)
      } catch {
        // Fall back to a reload if the session lookup hiccups.
        window.location.reload()
        return
      }
    }
    setNeedsSetup(false)
  }

  const signOut = (): void => {
    void apiLogout(authSlug)
    setUser(null)
  }

  return (
    <AuthContext.Provider
      value={{ user, loading, authSlug, needsSetup, runtime, signIn, signUp, completeSetup, signOut }}
    >
      {children}
    </AuthContext.Provider>
  )
}
